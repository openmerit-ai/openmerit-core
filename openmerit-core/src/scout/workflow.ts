// Scout's workflow as a resumable state machine shared by the CLI and the MCP server.
// `advance(ctx, runId, answers)` works until it needs a person (questions), finishes, pauses on the
// budget or fails. Every step is saved in SQLite, so a run continues after a restart and history
// keeps failed, interrupted and budget-paused runs.
//
// scan → disclose → map → model → corrections → tasks → pool → discover → approve → evaluate
// → compare → configure → done
//
// Evaluate is Scout Model Binary Search (search.ts) on the task's own eval: the current model runs
// every item; candidates are screened on sampled items the current model passes; five finalists
// (plus cheaper, stronger challengers) run every item. Each eval run is a unit in SQLite, so a
// resumed run replays the search from recorded results and never pays twice for a finished unit.
// Per-item results come from the Langfuse experiment the eval records, read with a Viewer key.
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { catalogueIndex, type Catalogue, type CatalogueModel } from "../catalogue/catalogue.ts";
import { createLangfuseConnector, type LangfuseConnector, type TaskEvidence } from "../connectors/langfuse/index.ts";
import { EvalProxy } from "../eval/proxy.ts";
import { runEval } from "../eval/runner.ts";
import type { Harness, HarnessUsage } from "../harness/harness.ts";
import { DEFAULT_BUDGET_USD, DEFAULT_REPEATS, readRepoConfig, resolveCredential, updateRepoConfig, type Endpoint, type EvalSpec, type RepoConfig } from "../state/config.ts";
import type { RunStatus, Spend, State, UnitRow } from "../state/db.ts";
import type { Repo } from "../state/paths.ts";
import { allowedOn, baselineEndpoint, blendedPrice, pool, type PoolModel } from "./pool.ts";
import { context, listFiles, redact, scanRepo, type ScanResult, type Usage } from "./scan.ts";
import { binarySearch, CandidateUnavailable, CHALLENGERS, challengers, FINALISTS, order, SAMPLE_SIZE, type Stage } from "./search.ts";

export type Answer = string | string[] | boolean | number;
export type Answers = Record<string, Answer>;

export interface Question {
  id: string;
  kind: "choice" | "multi" | "confirm" | "text";
  prompt: string;
  detail?: string;
  options?: { value: string; label: string; detail?: string }[];
  default?: Answer;
}

export interface Task { name: string; description: string; usageIds: string[]; usesTools: boolean; needsVision: boolean; structuredOutput: boolean }

/** A candidate in a task's pool: ECI-ranked, allowed, cheaper than the current model. */
export interface PoolEntry { key: string; model: string; endpoint: string; endpointModel: string; eci: number; eciSource: string | null; price: number | null }

interface ModelRef { model: string; endpoint: string; endpointModel: string }

interface PlannedEval extends EvalSpec { source: "saved" | "harness" | "user"; helperFiles?: { path: string; content: string; purpose: string }[]; explanation?: string }

/** One eval run's result as recorded in SQLite: pass/fail per item, nothing else from the item. */
export interface UnitResult { items: Record<string, boolean>; passes: number; total: number; source: "langfuse" | "eval"; experiment: string; requests: number; durationMs: number }

export interface SearchSummary {
  status: "running" | "selected" | "no_passing_model" | "stopped";
  /** ECI-ranked candidates searched, and eligible ones left out for lack of an ECI. */
  pool: number;
  unranked: number;
  sampleIds: string[];
  pick: string | null;
  trials: { stage: Stage; model: string; eci: number; passes: number; total: number; accepted: boolean }[];
  skipped: { model: string; stage: string; reason: string }[];
  finalists: string[];
  challengers: string[];
  shortfall?: string;
}

export interface ModelResult {
  model: string;
  endpoint: string;
  endpointModel: string;
  role: "baseline" | "candidate";
  eci: number | null;
  status: "measured" | "failed" | "unavailable" | "incomplete" | "budget_paused" | "not_run";
  /** Passes over every item run (items × repeats). */
  passes: number;
  total: number;
  runs: number;
  /** Pass rate, passes / total. */
  score: number | null;
  /** Where per-item results came from: the Langfuse experiment the eval recorded, or the eval's own report. */
  source: "langfuse" | "eval" | null;
  /** Measured eval cost per item run, from the metering proxy. */
  costPerItemUsd: number | null;
  costIsEstimate: boolean;
  meanLatencyMs: number | null;
  requests: number;
  qualified: boolean;
  note: string;
  /** Eval units in SQLite this result rests on, and the Langfuse experiments they read. */
  evidence: string[];
  experiments: string[];
}

export interface TaskComparison {
  task: string;
  eval: { command: string; source: string; threshold: number | null; langfuse: string | null };
  baseline: ModelResult | null;
  candidates: ModelResult[];
  /** Up to three qualified candidates, cheapest measured cost first. */
  top: ModelResult[];
  status: "ranked" | "no_qualified" | "no_passing_model" | "stopped" | "baseline_failed" | "no_eval" | "non_discriminating" | "incomplete";
  note: string;
  search?: SearchSummary;
  langfuse?: TaskEvidence | { error: string };
}

interface ConfigureState { decision?: "yes" | "no"; edits?: { file: string; line: number; before: string; after: string; hash: string; from: string; to: string }[]; manual?: string[]; applied?: boolean }

export interface RunState {
  scan?: ScanResult;
  harnessApproved?: boolean;
  tasks?: Task[];
  model?: string;
  corrected?: boolean;
  selected?: string[];
  pool?: Record<string, PoolEntry[]>;
  unranked?: Record<string, number>;
  evals?: Record<string, PlannedEval | { skipped: string }>;
  evalApproved?: boolean;
  repeats?: number;
  datasetItems?: Record<string, string[]>;
  samples?: Record<string, string[]>;
  search?: Record<string, SearchSummary>;
  stopped?: Record<string, string>;
  retryDeclined?: string[];
  compare?: Record<string, TaskComparison>;
  accepted?: Record<string, "accept" | "stop">;
  configure?: Record<string, ConfigureState>;
  harnessUsage?: HarnessUsage;
  [key: string]: unknown;
}

export interface Context {
  state: State;
  repo: Repo;
  catalogue: Catalogue;
  env: Record<string, string | undefined>;
  harness: () => Promise<Harness>;
  log: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** How long to wait for Langfuse to ingest an eval run's experiment. */
  langfusePoll?: { intervalMs: number; timeoutMs: number };
}

export interface Step {
  runId: string;
  status: RunStatus;
  phase: string;
  questions: Question[];
  notices: string[];
  spend: Spend;
  budgetUsd: number;
  harnessUsage: HarnessUsage | null;
  result?: ScoutResult;
  error?: string;
}

export interface ScoutResult {
  model: string | null;
  tasks: TaskComparison[];
  configuration: Record<string, ConfigureState>;
}

const PHASES = ["scan", "disclose", "map", "model", "corrections", "tasks", "pool", "discover", "approve", "evaluate", "compare", "configure", "done"] as const;
type Phase = typeof PHASES[number];
export const TOP = 3;
export const TASK_QUESTION = "Select which Agents/Tasks do you want OpenMerit to review?";
export const CONFIGURE_QUESTION = "Should OpenMerit configure this? Yes / No.";
/** Provider answers that mean the model cannot run at all: skipped as untested, not failed. */
const UNAVAILABLE_STATUSES = [400, 402, 404, 413, 422];

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "task";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const yes = (value: Answer | undefined) => value === true || (typeof value === "string" && /^(y|yes|true|approve|ok)$/i.test(value.trim()));
const no = (value: Answer | undefined) => value === false || (typeof value === "string" && /^(n|no|false|decline|cancel)$/i.test(value.trim()));
const list = (value: Answer | undefined): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : []);
const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const usd = (value: number | null) => (value === null ? "unknown" : `$${value.toFixed(value < 0.01 ? 5 : 4)}`);

class NeedsInput {
  readonly questions: Question[]; readonly status: RunStatus; readonly notices: string[];
  constructor(questions: Question[], status: RunStatus = "needs_input", notices: string[] = []) { this.questions = questions; this.status = status; this.notices = notices; }
}
/** Ends one task's search without a recommendation; the run goes on with the other tasks. */
class StopTask extends Error {}

export function newRunId() { return `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${hash(String(Math.random())).slice(0, 4)}`; }

/** Advances a run as far as it can go. Answers are keyed by question ID. */
export async function advance(ctx: Context, runId: string, answers: Answers = {}): Promise<Step> {
  const { state } = ctx;
  state.reapInterrupted(ctx.repo.id);
  const run = state.getRun(runId);
  if (!run) throw new Error(`No run ${runId} in this repository's history.`);
  if (run.repoId !== ctx.repo.id) throw new Error(`Run ${runId} belongs to ${run.repoRoot}, not ${ctx.repo.root}.`);
  if (run.status === "done" || run.status === "cancelled") return step(ctx, runId, [], []);
  if (!state.lock(runId)) return { ...step(ctx, runId, [], ["Another OpenMerit process (CLI or MCP) is working on this run. Wait for it, or check `openmerit history`."]) };
  const data = run.state as RunState;
  const notices: string[] = [];
  let harnessStart: HarnessUsage | null = null;
  let harness: Harness | null = null;
  const getHarness = async () => {
    if (!harness) { harness = await ctx.harness(); harnessStart = { ...harness.usage }; }
    return harness;
  };
  const save = (phase?: Phase, status: RunStatus = "running") => {
    if (harness && harnessStart) {
      const used = harness.usage, total = data.harnessUsage ?? { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 };
      data.harnessUsage = { calls: total.calls + used.calls - harnessStart.calls, costUsd: total.costUsd + used.costUsd - harnessStart.costUsd, unknownCost: total.unknownCost + used.unknownCost - harnessStart.unknownCost,
        inputTokens: total.inputTokens + used.inputTokens - harnessStart.inputTokens, outputTokens: total.outputTokens + used.outputTokens - harnessStart.outputTokens };
      harnessStart = { ...used };
    }
    state.updateRun(runId, { state: data, status, ...(phase ? { phase } : {}) });
  };
  let phase = run.phase as Phase;
  state.updateRun(runId, { status: "running", error: null });
  try {
    for (;;) {
      if (ctx.signal?.aborted) throw new Error("Interrupted");
      const next = await PHASE_HANDLERS[phase]({ ctx, runId, data, answers, notices, getHarness, save });
      if (next === "done") {
        save("done", "done");
        state.event(runId, "done", "Run finished.");
        return step(ctx, runId, [], notices);
      }
      if (next === "cancelled") {
        save(phase, "cancelled");
        state.event(runId, "cancelled", "Run cancelled; nothing further was executed.");
        return step(ctx, runId, [], notices);
      }
      phase = next;
      save(phase);
    }
  } catch (error) {
    if (error instanceof NeedsInput) {
      save(phase, error.status);
      return step(ctx, runId, error.questions, [...notices, ...error.notices]);
    }
    const message = error instanceof Error ? error.message : String(error);
    data.failedPhase = phase;
    if (ctx.signal?.aborted) { save(phase, "interrupted"); state.markInterrupted(runId); return step(ctx, runId, [], notices); }
    save(phase, "failed");
    state.updateRun(runId, { error: redact(message) });
    state.event(runId, "failed", redact(message));
    return { ...step(ctx, runId, [], notices), error: redact(message) };
  } finally {
    state.unlock(runId);
  }
}

export function step(ctx: Context, runId: string, questions: Question[], notices: string[]): Step {
  const run = ctx.state.getRun(runId)!;
  const data = run.state as RunState;
  return {
    runId, status: run.status, phase: run.phase, questions, notices, spend: ctx.state.spend(runId), budgetUsd: run.budgetUsd, harnessUsage: data.harnessUsage ?? null,
    ...(run.error ? { error: run.error } : {}),
    ...(run.status === "done" || data.compare ? { result: { model: data.model ?? null, tasks: Object.values(data.compare ?? {}), configuration: data.configure ?? {} } } : {}),
  };
}

interface PhaseInput {
  ctx: Context; runId: string; data: RunState; answers: Answers; notices: string[];
  getHarness: () => Promise<Harness>; save: (phase?: Phase, status?: RunStatus) => void;
}
type Handler = (input: PhaseInput) => Promise<Phase | "done" | "cancelled">;

const usageById = (data: RunState) => new Map((data.scan?.usages ?? []).map(usage => [usage.id, usage]));
const ref = (usage: Usage) => `${usage.file}:${usage.line}`;
const modelKey = (usage: Usage) => usage.catalogueId ?? `?${usage.value}`;
function tasksForModel(data: RunState): Task[] {
  const usages = usageById(data);
  return (data.tasks ?? []).filter(task => task.usageIds.some(id => { const usage = usages.get(id); return usage && usage.kind === "model" && modelKey(usage) === data.model; }));
}
function repoConfig(ctx: Context): RepoConfig { return readRepoConfig(ctx.repo.root); }
function endpoints(ctx: Context): Endpoint[] {
  const configured = repoConfig(ctx).endpoints ?? [];
  if (!configured.length) throw new Error("No candidate endpoints are configured for this repository. Run `openmerit setup`.");
  return configured;
}
function baselineRef(ctx: Context, data: RunState): ModelRef {
  const base = baselineEndpoint(endpoints(ctx), ctx.catalogue, data.model!)!;
  return { model: base.model.id, endpoint: base.endpoint.id, endpointModel: base.endpointModel };
}
const plannedEvals = (data: RunState) => Object.entries(data.evals ?? {}).filter((entry): entry is [string, PlannedEval] => !("skipped" in entry[1]));

const PHASE_HANDLERS: Record<Phase, Handler> = {
  async scan({ ctx, runId, data }) {
    ctx.log("Scanning the repository for model and endpoint usages…");
    const scan = scanRepo(ctx.repo.root, ctx.catalogue);
    data.scan = scan;
    const models = scan.usages.filter(usage => usage.kind === "model");
    ctx.state.event(runId, "scan", `Scanned ${scan.files} files: ${models.length} model usages (${models.filter(usage => usage.dynamic).length} dynamic), ${scan.usages.length - models.length} endpoint usages.`);
    if (!models.length) throw new Error("No model usages found in this repository. Scout looks for model IDs in code and configuration that Git does not ignore.");
    return "disclose";
  },

  async disclose({ ctx, data, answers }) {
    if (data.harnessApproved) return "map";
    const answer = answers.disclose_harness;
    if (yes(answer)) { data.harnessApproved = true; return "map"; }
    if (no(answer)) return "cancelled";
    const harness = await ctxHarnessDestination(ctx);
    throw new NeedsInput([{
      id: "disclose_harness", kind: "confirm", default: true,
      prompt: "Send code context to OpenMerit Harness to map usages to agents and tasks?",
      detail: `Destination: ${harness}.\nIt receives redacted snippets around ${data.scan!.usages.length} usages, file names, package scripts and eval files, and may open repository files read-only. OpenMerit changes no file without a separate approval.`,
    }]);
  },

  async map({ ctx, runId, data, getHarness }) {
    const scan = data.scan!;
    ctx.log(`OpenMerit Harness is mapping ${scan.usages.length} usages to agents and tasks…`);
    const harness = await getHarness();
    const listing = scan.usages.slice(0, 120).map(usage => `### ${usage.id} ${usage.kind}${usage.dynamic ? " (dynamic)" : ""}: ${usage.value}${usage.catalogueId ? ` = catalogue ${usage.catalogueId}` : ""} at ${ref(usage)}\n${context(ctx.repo.root, usage)}`).join("\n\n");
    const reply = await harness.json<{ tasks: Task[] }>({
      cwd: ctx.repo.root,
      system: "You are OpenMerit Harness running OpenMerit Scout. You map model usages in a codebase to the agents or tasks they serve. Read files only to understand them; never change anything.",
      prompt: `Repository: ${ctx.repo.root}\n\nGroup these model usages into the agents or tasks they serve (one task per distinct job a model does in production, such as \"ticket classifier\" or \"claim summary\"). A model used by two jobs belongs to two tasks. Include every model usage, including dynamic ones, in a task. For each task say whether the call uses tool calls, image input, or structured (JSON) output. Use short task names.\n\n${listing}`,
      schema: strict({ tasks: { type: "array", items: strict({ name: { type: "string" }, description: { type: "string" }, usageIds: { type: "array", items: { type: "string" } }, usesTools: { type: "boolean" }, needsVision: { type: "boolean" }, structuredOutput: { type: "boolean" } }) } }),
    });
    const known = usageById(data);
    const tasks = (reply.tasks ?? []).map(task => ({ ...task, name: String(task.name).trim().slice(0, 80), usageIds: [...new Set(task.usageIds.filter(id => known.has(id)))] })).filter(task => task.name && task.usageIds.length);
    for (const usage of scan.usages.filter(item => item.kind === "model" && !tasks.some(task => task.usageIds.includes(item.id)))) {
      const name = `unmapped: ${usage.file}`;
      const existing = tasks.find(task => task.name === name);
      if (existing) existing.usageIds.push(usage.id);
      else tasks.push({ name, description: "Model usage the harness did not map to a task", usageIds: [usage.id], usesTools: false, needsVision: false, structuredOutput: false });
    }
    data.tasks = tasks;
    ctx.state.event(runId, "map", `Harness mapped usages to ${tasks.length} tasks: ${tasks.map(task => task.name).join(", ")}.`);
    return "model";
  },

  async model({ ctx, data, answers }) {
    const scan = data.scan!;
    const index = catalogueIndex(ctx.catalogue);
    const choices = scan.models;
    const answer = answers.model;
    if (typeof answer === "string" && answer.trim()) {
      const value = answer.trim();
      const match = choices.find(item => item.value === value || item.catalogueId === value || `?${item.value}` === value) ?? (index.find(value) ? choices.find(item => item.catalogueId === index.find(value)!.id) : undefined);
      if (!match) throw new NeedsInput([modelQuestion(data)], "needs_input", [`${value} is not one of the models found in this repository.`]);
      data.model = match.catalogueId ?? `?${match.value}`;
      if (!match.catalogueId) throw new Error(`${match.value} is not in the bundled catalogue (version ${ctx.catalogue.version}), so Scout cannot price or place it. Update openmerit, or choose a catalogue model.`);
      return "corrections";
    }
    throw new NeedsInput([modelQuestion(data)]);
  },

  async corrections({ data, answers }) {
    if (data.corrected) return "tasks";
    const answer = answers.corrections;
    if (answer === undefined) throw new NeedsInput([correctionsQuestion(data)]);
    for (const item of list(answer)) {
      const [id = "", ...rest] = item.split("=");
      const name = rest.join("=").trim();
      const usage = usageById(data).get(id.trim());
      if (!usage || !name) throw new NeedsInput([correctionsQuestion(data)], "needs_input", [`Write each correction as <usage id>=<task name>, not "${item}".`]);
      for (const task of data.tasks!) task.usageIds = task.usageIds.filter(other => other !== usage.id);
      const target = data.tasks!.find(task => task.name === name);
      if (target) target.usageIds.push(usage.id);
      else data.tasks!.push({ name, description: "Added by the user", usageIds: [usage.id], usesTools: false, needsVision: false, structuredOutput: false });
    }
    data.tasks = data.tasks!.filter(task => task.usageIds.length);
    data.corrected = true;
    return "tasks";
  },

  async tasks({ data, answers }) {
    const available = tasksForModel(data);
    const chosen = list(answers.tasks);
    if (chosen.length) {
      const unknown = chosen.filter(name => !available.some(task => task.name === name));
      if (unknown.length) throw new NeedsInput([tasksQuestion(data)], "needs_input", [`Not a task of ${data.model}: ${unknown.join(", ")}.`]);
      data.selected = chosen;
      return "pool";
    }
    throw new NeedsInput([tasksQuestion(data)]);
  },

  async pool({ ctx, runId, data }) {
    const configured = endpoints(ctx);
    const baseline = ctx.catalogue.models.find(model => model.id === data.model)!;
    if (!baselineEndpoint(configured, ctx.catalogue, baseline.id)) throw new Error(`No configured endpoint can run the current model ${baseline.id}, so it cannot be measured as the baseline. Add an endpoint that serves it with \`openmerit setup\`.`);
    data.pool = {};
    data.unranked = {};
    for (const name of data.selected!) {
      const task = data.tasks!.find(item => item.name === name)!;
      const eligible = eligibleCandidates(ctx.catalogue, configured, baseline, task);
      const ranked = order(eligible.filter(item => item.model.eci !== null).map(toEntry));
      data.pool[name] = ranked;
      data.unranked[name] = eligible.length - ranked.length;
      ctx.state.event(runId, "pool", `${name}: ${ranked.length} ECI-ranked candidates cheaper than ${baseline.id} in the allowed pool${data.unranked[name] ? ` (${data.unranked[name]} without an ECI left out)` : ""}.`);
    }
    return "discover";
  },

  async discover({ ctx, runId, data, answers, getHarness, save }) {
    data.evals ??= {};
    const saved = repoConfig(ctx).evals ?? {};
    const missing: Question[] = [];
    for (const name of data.selected!) {
      if (data.evals[name]) continue;
      const key = `eval_${slug(name)}`;
      const answer = answers[key];
      if (typeof answer === "string" && answer.trim()) {
        data.evals[name] = /^skip$/i.test(answer.trim()) ? { skipped: "No eval: skipped by the user" } : { source: "user", command: answer.trim() };
        continue;
      }
      if (saved[name]) { data.evals[name] = { ...saved[name], source: "saved" }; continue; }
      if (data[`asked_${key}`]) { missing.push(evalQuestion(name, String(data[`asked_${key}`]))); continue; }
      ctx.log(`OpenMerit Harness is looking for the existing eval of "${name}"…`);
      const harness = await getHarness();
      const task = data.tasks!.find(item => item.name === name)!;
      const usages = usageById(data);
      const files = listFiles(ctx.repo.root).filter(file => /(eval|bench|test|spec|dataset|fixture|golden|score|grade|langfuse)/i.test(file)).slice(0, 200);
      const pkg = existsSync(join(ctx.repo.root, "package.json")) ? JSON.stringify((JSON.parse(readFileSync(join(ctx.repo.root, "package.json"), "utf8")) as { scripts?: unknown }).scripts ?? {}, null, 1) : "(no package.json)";
      const reply = await harness.json<{ found: boolean; command: string; cwd: string; env: { name: string; value: string }[]; threshold: number | null; langfuseDataset: string; passScore: string; passMin: number | null; helpers: { path: string; content: string; purpose: string }[]; explanation: string; missing: string }>({
        cwd: ctx.repo.root,
        system: "You are OpenMerit Harness running OpenMerit Scout's evaluation step. You find the eval a task already has and say exactly how to run it for another model. Never invent an eval, dataset or labels: if the repository has none for this task, say so.",
        prompt: `Task: ${task.name}: ${task.description}\nUsages:\n${task.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage).map(usage => `- ${usage.value} at ${ref(usage)}\n${context(ctx.repo.root, usage, 4)}`).join("\n")}\n\npackage.json scripts: ${pkg}\nFiles that look like evals, tests or datasets:\n${files.join("\n")}\n\n${EVAL_CONTRACT}\n\nIf the eval records its results as a Langfuse experiment (dataset run) with a per-item score, give the Langfuse dataset name and that score's name (and passMin for a numeric score with a pass bound; null when the score is boolean or 1 means pass). OpenMerit reads each item's result back from Langfuse with a read-only key, so the eval must record under the OPENMERIT_EXPERIMENT name and run only the OPENMERIT_ITEMS items when given. Otherwise leave langfuseDataset and passScore empty: the eval must then report its items itself. Only if the existing eval cannot take the model, the items or the experiment name this way may you add helper files, and only under .openmerit/evals/; they must call the existing eval code with the same inputs, prompts, tools and scoring. threshold is the minimum pass rate (0 to 1) the eval itself requires, or null. Set found false and explain in missing when there is no eval for this task.`,
        schema: strict({ found: { type: "boolean" }, command: { type: "string" }, cwd: { type: "string" }, env: { type: "array", items: strict({ name: { type: "string" }, value: { type: "string" } }) }, threshold: { type: ["number", "null"] }, langfuseDataset: { type: "string" }, passScore: { type: "string" }, passMin: { type: ["number", "null"] }, helpers: { type: "array", items: strict({ path: { type: "string" }, content: { type: "string" }, purpose: { type: "string" } }) }, explanation: { type: "string" }, missing: { type: "string" } }),
      });
      if (!reply.found || !reply.command?.trim()) {
        data[`asked_${key}`] = reply.missing || "The harness found no eval for this task.";
        missing.push(evalQuestion(name, String(data[`asked_${key}`])));
        save();
        continue;
      }
      const helpers = (reply.helpers ?? []).map(helper => ({ ...helper, path: normalize(helper.path).replace(/^\.\//, "") }));
      const outside = helpers.find(helper => !helper.path.startsWith(".openmerit/evals/") || helper.path.includes(".."));
      if (outside) throw new Error(`The harness proposed a helper outside .openmerit/evals/ (${outside.path}); refusing it. Retry with \`openmerit scout --resume ${runId}\`.`);
      const cwd = evalCwd(ctx.repo.root, reply.cwd);
      data.evals[name] = {
        source: "harness", command: reply.command.trim(), ...(cwd ? { cwd } : {}),
        env: Object.fromEntries((reply.env ?? []).filter(item => item.name && !/(KEY|TOKEN|SECRET)/.test(item.name)).map(item => [item.name, item.value])),
        ...(typeof reply.threshold === "number" ? { threshold: reply.threshold } : {}),
        ...(reply.langfuseDataset && reply.passScore ? { langfuse: { dataset: reply.langfuseDataset, score: reply.passScore, ...(typeof reply.passMin === "number" ? { min: reply.passMin } : {}) } } : {}),
        helperFiles: helpers, explanation: reply.explanation,
      };
      ctx.state.event(runId, "discover", `${name}: eval \`${redact(reply.command.trim())}\`${reply.passScore ? `, per-item score ${reply.passScore} read back from Langfuse dataset ${reply.langfuseDataset}` : ", per-item results reported by the eval"}${helpers.length ? `, ${helpers.length} helper file(s)` : ""}.`);
      save();
    }
    if (missing.length) throw new NeedsInput(missing, "needs_input", ["Scout does not fabricate quality: each task needs its existing eval, or skip it."]);
    if (!plannedEvals(data).length) throw new Error("Every selected task was skipped for lack of an eval, so nothing can be measured.");
    if (plannedEvals(data).some(([, plan]) => plan.langfuse) && !repoConfig(ctx).langfuse) throw new Error("This eval records its results in Langfuse, but this repository has no read-only Langfuse connection to read them back. Run `openmerit setup` and connect a Viewer key, then resume.");
    return "approve";
  },

  async approve({ ctx, runId, data, answers }) {
    if (data.evalApproved) return "evaluate";
    const answer = answers.approve_evals;
    if (no(answer)) return "cancelled";
    if (!yes(answer)) throw new NeedsInput([approvalQuestion(ctx, runId, data)]);
    const config = repoConfig(ctx);
    const evals = { ...config.evals };
    for (const [name, plan] of plannedEvals(data)) {
      for (const helper of plan.helperFiles ?? []) {
        const path = join(ctx.repo.root, helper.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, helper.content);
      }
      const { source: _source, helperFiles, explanation: _explanation, ...spec } = plan;
      evals[name] = { ...spec, ...(helperFiles?.length ? { helpers: helperFiles.map(helper => helper.path) } : {}) };
    }
    updateRepoConfig(ctx.repo.root, { evals });
    data.evalApproved = true;
    data.repeats = Math.max(1, config.repeats ?? DEFAULT_REPEATS);
    ctx.state.decision(runId, "eval_execution", "approved", { tasks: plannedEvals(data).map(([name]) => name), repeats: data.repeats, helpers: plannedEvals(data).flatMap(([, plan]) => (plan.helperFiles ?? []).map(helper => helper.path)) });
    return "evaluate";
  },

  evaluate: evaluatePhase,

  async compare({ ctx, runId, data, answers, save }) {
    data.compare ??= {};
    data.accepted ??= {};
    const config = repoConfig(ctx);
    const pending: Question[] = [];
    for (const name of data.selected!) {
      const plan = data.evals![name]!;
      if ("skipped" in plan) {
        data.compare[name] = { task: name, eval: { command: "", source: "none", threshold: null, langfuse: null }, baseline: null, candidates: [], top: [], status: "no_eval", note: plan.skipped };
        continue;
      }
      const comparison = compareTask(ctx, runId, data, name, plan);
      const key = `accept_${slug(name)}`;
      if (comparison.status === "non_discriminating") {
        const answer = answers[key] ?? data.accepted[name];
        if (answer === "accept") { data.accepted[name] = "accept"; Object.assign(comparison, rank(comparison, true)); }
        else if (answer === "stop") data.accepted[name] = "stop";
        else pending.push({ id: key, kind: "choice", prompt: `The eval for "${name}" gave every measured model the same pass rate. Use it anyway?`, detail: `${comparison.note}\nWith equal pass rates the ranking rests on cost alone. Harder labelled cases make the result meaningful.`, options: [{ value: "accept", label: "Accept: rank the qualifying models by cost" }, { value: "stop", label: "Stop: no recommendation for this task until the eval is improved" }] });
      }
      const mapping = config.langfuse?.mappings.find(item => item.task === name);
      if (config.langfuse && mapping) {
        try { comparison.langfuse = await viewerConnector(ctx).taskEvidence(mapping); }
        catch (error) { comparison.langfuse = { error: error instanceof Error ? redact(error.message) : String(error) }; }
      }
      data.compare[name] = comparison;
    }
    save();
    if (pending.length) throw new NeedsInput(pending);
    ctx.state.decision(runId, "ranking", "computed", Object.values(data.compare).map(item => ({ task: item.task, status: item.status, top: item.top.map(model => ({ model: model.model, endpoint: model.endpoint, score: model.score, costPerItemUsd: model.costPerItemUsd })) })));
    return "configure";
  },

  async configure({ ctx, runId, data, answers }) {
    data.configure ??= {};
    for (const comparison of Object.values(data.compare ?? {})) {
      const winner = comparison.top[0];
      if (!winner) continue;
      const key = slug(comparison.task);
      const current = data.configure[comparison.task] ??= {};
      if (current.decision === "no" || current.applied || (current.decision === "yes" && !current.edits?.length)) continue;
      if (!current.decision) {
        const answer = answers[`configure_${key}`];
        if (no(answer)) {
          current.decision = "no";
          ctx.state.decision(runId, "configure", "no", { task: comparison.task, model: winner.model });
          continue;
        }
        if (!yes(answer)) throw new NeedsInput([{ id: `configure_${key}`, kind: "confirm", default: false, prompt: CONFIGURE_QUESTION, detail: `Task "${comparison.task}": switch ${data.model} to ${winner.model} on ${winner.endpoint} (${winner.endpointModel}). No leaves your application configuration unchanged.` }]);
        current.decision = "yes";
        Object.assign(current, planEdit(ctx, data, comparison, winner));
        if (!current.edits?.length) { ctx.state.decision(runId, "configure", "manual", { task: comparison.task, model: winner.model, manual: current.manual }); continue; }
      }
      const answer = answers[`apply_${key}`];
      if (no(answer)) { current.applied = false; current.edits = []; ctx.state.decision(runId, "configure", "preview_declined", { task: comparison.task }); continue; }
      if (!yes(answer)) throw new NeedsInput([{ id: `apply_${key}`, kind: "confirm", default: false, prompt: `Apply this change for "${comparison.task}"?`, detail: `${diff(current.edits!)}${current.manual?.length ? `\n\nAlso, by hand:\n${current.manual.map(item => `- ${item}`).join("\n")}` : ""}` }]);
      applyEdits(ctx.repo.root, current.edits!);
      current.applied = true;
      ctx.state.decision(runId, "configure", "applied", { task: comparison.task, model: winner.model, diff: diff(current.edits!) });
      ctx.state.event(runId, "configure", `Configured "${comparison.task}": ${current.edits!.map(edit => `${edit.file}:${edit.line}`).join(", ")}.`);
    }
    return "done";
  },

  async done() { return "done"; },
};

const EVAL_CONTRACT = `OpenMerit runs the eval once per model and item set with these environment variables: OPENMERIT_MODEL (the model ID, as the endpoint names it), OPENAI_BASE_URL and OPENAI_API_KEY (an OpenAI-compatible endpoint, also as OPENMERIT_BASE_URL and OPENMERIT_API_KEY), OPENMERIT_ITEMS (comma-separated dataset item IDs to run; empty means every item), OPENMERIT_EXPERIMENT (a fresh experiment or run name for this run) and OPENMERIT_RESULT (a file path). \`{{model}}\`, \`{{items}}\` and \`{{experiment}}\` in the command or env values are replaced by the same values; map them onto the eval's own variables in env when it reads others (for example CLASSIFIER_MODEL={{model}}). An eval that does not record to Langfuse writes {"items":[{"id": string, "pass": boolean}]} to $OPENMERIT_RESULT or prints it as its last JSON line.`;

function viewerConnector(ctx: Context): LangfuseConnector {
  const settings = repoConfig(ctx).langfuse;
  if (!settings) throw new Error("This repository has no Langfuse connection. Run `openmerit setup`.");
  const publicKey = resolveCredential(settings.publicKey, ctx.env), secretKey = resolveCredential(settings.secretKey, ctx.env);
  if (!publicKey || !secretKey) throw new Error("The Langfuse Viewer key pair is not available. Run `openmerit setup`.");
  return createLangfuseConnector({ baseUrl: settings.baseUrl, publicKey, secretKey }, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), retries: 3 });
}

/** The binary search for every planned task. Replays finished units from SQLite; runs the rest. */
async function evaluatePhase({ ctx, runId, data, answers, save }: PhaseInput): Promise<Phase> {
  const { state } = ctx;
  const configured = endpoints(ctx);
  const repeats = data.repeats ??= Math.max(1, repoConfig(ctx).repeats ?? DEFAULT_REPEATS);
  const base = baselineRef(ctx, data);
  data.samples ??= {}; data.datasetItems ??= {}; data.search ??= {}; data.stopped ??= {}; data.retryDeclined ??= [];
  const stale = () => state.units(runId).filter(unit => ["failed", "interrupted", "running"].includes(unit.status) && !data.retryDeclined!.includes(unit.id));

  // Budget: a raise answers a pause; a decline leaves the run paused.
  const paused = state.units(runId).filter(unit => unit.status === "budget_paused");
  if (paused.length) {
    const run = state.getRun(runId)!;
    const action = answers.budget_action, amount = Number(answers.budget_amount), spent = state.spend(runId).totalUsd;
    if (action === "decline") {
      state.budgetEvent(runId, { kind: "decline", fromUsd: run.budgetUsd, spentUsd: spent });
      throw new NeedsInput([], "budget_paused", [`Budget not raised. The run stays paused at $${spent.toFixed(4)} of $${run.budgetUsd.toFixed(2)}; continue later with \`openmerit scout --resume ${runId}\`.`]);
    }
    if ((action === "run" || action === "default") && Number.isFinite(amount) && amount > run.budgetUsd) {
      state.updateRun(runId, { budgetUsd: amount });
      state.budgetEvent(runId, { kind: "raise", fromUsd: run.budgetUsd, toUsd: amount, scope: action, spentUsd: spent });
      if (action === "default") updateRepoConfig(ctx.repo.root, { budget: { defaultUsd: amount } });
      for (const unit of paused) state.setUnit(unit.id, { status: "pending" });
      state.event(runId, "budget", `Budget raised to $${amount.toFixed(2)} for ${action === "default" ? "this run and as the repository default" : "this run only"}; ${paused.length} paused eval run(s) continue.`);
    } else throw new NeedsInput(budgetQuestions(ctx, runId), "budget_paused");
  }
  if (answers.retry_units !== undefined) {
    if (yes(answers.retry_units)) for (const unit of stale()) state.setUnit(unit.id, { status: "pending" });
    else data.retryDeclined.push(...stale().map(unit => unit.id));
  }
  const declined = new Set(data.retryDeclined);

  const proxy = new EvalProxy(state, ctx.fetch);
  const proxyUrl = await proxy.start();
  let viewer: LangfuseConnector | null = null;

  /** One eval run: replayed from SQLite when finished, otherwise run through the proxy and read back. */
  const runUnit = async (task: string, plan: PlannedEval, kind: UnitRow["role"], entry: ModelRef, repeat: number, items: readonly string[] | null): Promise<UnitResult> => {
    const id = `${runId}|${slug(task)}|${kind}|${entry.endpoint}|${entry.model}|r${repeat}`;
    const unit = state.ensureUnit({ id, runId, task, model: entry.model, endpoint: entry.endpoint, role: kind, repeat });
    const label = `${task} · ${kind === "baseline" ? "current model" : kind} ${entry.model}${kind === "screen" ? "" : ` · run ${repeat}/${repeats}`}`;
    if (unit.status === "done") return unit.result as unknown as UnitResult;
    if (unit.status === "unavailable") throw new CandidateUnavailable(unit.error ?? "could not run");
    if (unit.status === "budget_paused") throw new NeedsInput(budgetQuestions(ctx, runId), "budget_paused");
    if (unit.status !== "pending") {
      if (declined.has(id)) throw new StopTask(`${label} failed and was not retried: ${(unit.error ?? unit.status).split("\n")[0]}`);
      throw new NeedsInput([retryQuestion(ctx, runId, stale())]);
    }
    const fail = (error: string): never => { state.setUnit(id, { status: "failed", error }); save(); throw new NeedsInput([retryQuestion(ctx, runId, stale())]); };
    const endpoint = configured.find(item => item.id === entry.endpoint);
    const apiKey = endpoint ? resolveCredential(endpoint.apiKey, ctx.env) : null;
    if (!endpoint || !apiKey) return fail(`Endpoint ${entry.endpoint} has no usable credential; run \`openmerit setup\`.`);
    // The expected items: the sample for a screen; every dataset item (or the current model's first run's items) otherwise.
    const expected = items ?? (plan.langfuse ? data.datasetItems![task]! : kind === "baseline" && repeat === 1 ? null : Object.keys(firstBaseline(task)?.items ?? {}));
    const experiment = `openmerit-${runId}-${slug(task)}-${kind}-${entry.endpointModel.replace(/[^a-zA-Z0-9.]+/g, "-")}-r${repeat}-a${unit.attempts + 1}`;
    ctx.log(`Evaluating ${label}${items ? ` on ${items.length} sampled items` : ""}…`);
    state.setUnit(id, { status: "running", attempt: true });
    const pooled = allowedOn(endpoint, ctx.catalogue);
    // The baseline is the model already in production: it runs even when the candidate pool leaves it out.
    const allowed = kind === "baseline" ? (model: string) => (model.toLowerCase() === entry.endpointModel.toLowerCase() ? ctx.catalogue.models.find(item => item.id === entry.model) ?? null : pooled(model)) : pooled;
    const { token, tally } = proxy.open({ runId, unitId: id, endpointId: endpoint.id, baseUrl: endpoint.baseUrl, apiKey, model: entry.endpointModel, allowed });
    const started = Date.now();
    let outcome;
    try { outcome = await runEval(plan, { root: ctx.repo.root, model: entry.endpointModel, baseUrl: proxyUrl, token, items, experiment, env: ctx.env, ...(ctx.signal ? { signal: ctx.signal } : {}) }); } finally { proxy.close(token); }
    if (tally.budgetHit) {
      state.setUnit(id, { status: "budget_paused", error: "Paused: the eval budget was reached." });
      const run = state.getRun(runId)!, spend = state.spend(runId);
      state.budgetEvent(runId, { kind: "alert", fromUsd: run.budgetUsd, spentUsd: spend.totalUsd });
      state.event(runId, "budget", `Eval budget reached: $${spend.totalUsd.toFixed(4)} of $${run.budgetUsd.toFixed(2)}. Further paid eval requests are paused.`);
      throw new NeedsInput(budgetQuestions(ctx, runId), "budget_paused");
    }
    const refused = tally.poolViolations.length ? `; refused models outside the allowed pool: ${[...new Set(tally.poolViolations)].join(", ")}` : "";
    if (!outcome.ok) {
      const rejected = tally.upstreamErrors.find(status => UNAVAILABLE_STATUSES.includes(status));
      if (kind !== "baseline" && rejected) {
        state.setUnit(id, { status: "unavailable", error: `${entry.endpoint} rejected ${entry.endpointModel} (HTTP ${rejected})${outcome.log ? `\n${outcome.log}` : ""}` });
        ctx.log(`  skipped: ${entry.endpoint} rejected the model (HTTP ${rejected}); untested, not failed`);
        save();
        throw new CandidateUnavailable(`${entry.endpoint} rejected ${entry.endpointModel} (HTTP ${rejected})`);
      }
      return fail(`${outcome.error ?? "eval failed"}${refused}${outcome.log ? `\n${outcome.log}` : ""}`);
    }
    let results: Record<string, boolean>;
    let source: UnitResult["source"];
    if (plan.langfuse) {
      viewer ??= viewerConnector(ctx);
      try {
        const read = await viewer.waitForExperiment({ experimentName: experiment, pass: { score: plan.langfuse.score, ...(plan.langfuse.min !== undefined ? { min: plan.langfuse.min } : {}) }, itemIds: expected!, since: new Date(started - 300_000).toISOString() },
          { expectItems: expected!.length, ...(ctx.langfusePoll ?? {}) });
        results = Object.fromEntries(read.items.map(item => [item.itemId, item.passed]));
        source = "langfuse";
      } catch (error) { return fail(`Langfuse read-back: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      if (!outcome.items) return fail("The eval reported no per-item results: it must write {\"items\":[{\"id\",\"pass\"}]} to $OPENMERIT_RESULT, or record a Langfuse experiment.");
      const reported = new Map(outcome.items.map(item => [item.id, item.pass]));
      const ids = expected ?? [...reported.keys()];
      const absent = ids.filter(item => !reported.has(item));
      if (absent.length) return fail(`The eval reported no result for ${absent.length} requested item(s): ${absent.slice(0, 10).join(", ")}.`);
      results = Object.fromEntries(ids.map(item => [item, reported.get(item)!]));
      source = "eval";
    }
    const passes = Object.values(results).filter(Boolean).length, total = Object.keys(results).length;
    const result: UnitResult = { items: results, passes, total, source, experiment, requests: tally.requests, durationMs: outcome.durationMs };
    state.setUnit(id, { status: "done", result: result as unknown as Record<string, unknown> });
    ctx.log(`  ${passes}/${total} passed${source === "langfuse" ? " (read back from Langfuse)" : ""} · ${tally.requests} requests · eval spend so far ${usd(state.spend(runId).totalUsd)} of $${state.getRun(runId)!.budgetUsd.toFixed(2)}`);
    save();
    return result;
  };
  const firstBaseline = (task: string) => state.units(runId).find(unit => unit.task === task && unit.role === "baseline" && unit.repeat === 1 && unit.status === "done")?.result as unknown as UnitResult | undefined;

  const evaluateTask = async (task: string, plan: PlannedEval) => {
    const candidates = data.pool![task] ?? [];
    const summary: SearchSummary = { status: "running", pool: candidates.length, unranked: data.unranked?.[task] ?? 0, sampleIds: [], pick: null, trials: [], skipped: [], finalists: [], challengers: [] };
    data.search![task] = summary;
    if (plan.langfuse && !data.datasetItems![task]) {
      viewer ??= viewerConnector(ctx);
      data.datasetItems![task] = await viewer.datasetItemIds(plan.langfuse.dataset);
      save();
    }
    const baseline: UnitResult[] = [];
    for (let repeat = 1; repeat <= repeats; repeat++) baseline.push(await runUnit(task, plan, "baseline", base, repeat, null));
    // Screens draw from items the current model passes in every run, so a 5/5 screen asks whether a candidate keeps up with it.
    if (!data.samples![task]) {
      const reliable = Object.keys(baseline[0]!.items).filter(item => baseline.every(run => run.items[item] === true));
      if (reliable.length < SAMPLE_SIZE) throw new StopTask(`The current model passes only ${reliable.length} items in every run; Scout screens candidates on ${SAMPLE_SIZE} items it passes. Add labelled items the current model gets right.`);
      const pool = [...reliable], picked: string[] = [];
      for (let count = 0; count < SAMPLE_SIZE; count++) picked.push(pool.splice(randomInt(pool.length), 1)[0]!);
      data.samples![task] = picked;
      save();
    }
    const samples = data.samples![task]!;
    summary.sampleIds = samples;
    const screen = async (candidate: PoolEntry, stage: Stage) => {
      const result = await runUnit(task, plan, "screen", candidate, 1, samples);
      const accepted = samples.every(item => result.items[item] === true);
      summary.trials.push({ stage, model: candidate.model, eci: candidate.eci, passes: result.passes, total: result.total, accepted });
      return accepted;
    };
    const runFinal = async (candidate: PoolEntry) => {
      try {
        for (let repeat = 1; repeat <= repeats; repeat++) await runUnit(task, plan, "final", candidate, repeat, null);
      } catch (error) {
        if (error instanceof CandidateUnavailable) { summary.skipped.push({ model: candidate.model, stage: "final", reason: error.message }); return; }
        if (error instanceof StopTask) return; // A declined failed final is listed as unmeasured.
        throw error;
      }
    };
    const searched = await binarySearch(candidates, screen, FINALISTS);
    summary.skipped.push(...searched.unavailable.map(item => ({ model: item.candidate.model, stage: item.stage, reason: item.reason })));
    summary.pick = searched.selected?.model ?? null;
    if (searched.shortfall) summary.shortfall = searched.shortfall;
    if (!searched.selected) { summary.status = "no_passing_model"; save(); return; }
    summary.finalists = searched.finalists.map(item => item.model);
    for (const candidate of searched.finalists) await runFinal(candidate);
    const leader = searched.finalists.map(candidate => ({ candidate, measured: finalMeasure(task, candidate.model) })).filter(item => item.measured)
      .sort((a, b) => b.measured!.score - a.measured!.score || (a.measured!.cost ?? Infinity) - (b.measured!.cost ?? Infinity) || a.candidate.eci - b.candidate.eci)[0]?.candidate;
    if (leader) {
      const tried = new Set([...summary.trials.map(item => item.model), ...summary.skipped.map(item => item.model)]);
      for (const candidate of challengers(candidates, leader, tried, CHALLENGERS)) {
        try {
          if (await screen(candidate, "challenger")) { summary.challengers.push(candidate.model); await runFinal(candidate); }
        } catch (error) {
          if (!(error instanceof CandidateUnavailable)) throw error;
          summary.skipped.push({ model: candidate.model, stage: "challenger", reason: error.message });
        }
      }
    }
    summary.status = "selected";
    save();
  };
  const finalMeasure = (task: string, model: string) => {
    const units = state.units(runId).filter(unit => unit.task === task && unit.role === "final" && unit.model === model);
    if (units.length < repeats || units.some(unit => unit.status !== "done")) return null;
    const results = units.map(unit => unit.result as unknown as UnitResult);
    const total = results.reduce((sum, item) => sum + item.total, 0);
    return { score: results.reduce((sum, item) => sum + item.passes, 0) / total, cost: unitCost(ctx, runId, units)?.perItem(total) ?? null };
  };

  try {
    for (const [task, plan] of plannedEvals(data)) {
      if (data.stopped[task]) continue;
      try { await evaluateTask(task, plan); }
      catch (error) {
        if (!(error instanceof StopTask)) throw error;
        data.stopped[task] = error.message;
        data.search[task]!.status = "stopped";
        state.event(runId, "stopped", `${task}: ${error.message}`);
        save();
      }
    }
  } finally { await proxy.stop(); }
  return "compare";
}

async function ctxHarnessDestination(ctx: Context) {
  try { return (await ctx.harness()).destination; } catch (error) { throw new Error(`OpenMerit Harness is not ready: ${error instanceof Error ? error.message : String(error)} Run \`openmerit setup\`.`); }
}

function modelQuestion(data: RunState): Question {
  const usages = usageById(data);
  const dynamic = data.scan!.usages.filter(usage => usage.kind === "model" && usage.dynamic && !usage.catalogueId);
  const endpointUsages = data.scan!.usages.filter(usage => usage.kind === "endpoint");
  return {
    id: "model", kind: "choice", prompt: "Which current model should Scout review?",
    options: data.scan!.models.map(item => ({
      value: item.catalogueId ?? `?${item.value}`, label: `${item.value}${item.catalogueId ? "" : " (not in the catalogue)"}`,
      detail: item.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage).map(usage => `${ref(usage)}${usage.dynamic ? ` (default of ${usage.envVar})` : ""}`).join(", "),
    })),
    detail: [
      dynamic.length ? `Dynamic, resolved at run time:\n${dynamic.map(usage => `- ${ref(usage)}: ${usage.value}${usage.envVar ? ` (env ${usage.envVar})` : ""}`).join("\n")}` : "",
      endpointUsages.length ? `Endpoints:\n${endpointUsages.map(usage => `- ${ref(usage)}: ${usage.value}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function correctionsQuestion(data: RunState): Question {
  const usages = usageById(data);
  return {
    id: "corrections", kind: "text", default: "",
    prompt: "Correct the inferred task mapping? Enter <usage id>=<task name>, comma-separated, or leave empty to keep it.",
    detail: tasksForModel(data).map(task => `${task.name}: ${task.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage).map(usage => `${usage.id} ${ref(usage)} ${usage.value}`).join("; ")}`).join("\n"),
  };
}

function tasksQuestion(data: RunState): Question {
  const usages = usageById(data);
  return {
    id: "tasks", kind: "multi", prompt: TASK_QUESTION,
    options: tasksForModel(data).map(task => ({ value: task.name, label: task.name, detail: `${task.description} — ${task.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage && usage.kind === "model").map(ref).join(", ")}` })),
  };
}

function evalQuestion(task: string, reason: string): Question {
  return { id: `eval_${slug(task)}`, kind: "text", prompt: `No runnable eval found for "${task}". Enter the command that runs its eval, or "skip".`, detail: `${reason}\n${EVAL_CONTRACT}\nScout never invents an eval or labels.` };
}

/** Upper estimate of eval runs: baseline and finals on every item, screens on the sample. */
export function estimate(poolSize: number, repeats: number) {
  const probes = Math.ceil(Math.log2(poolSize + 1));
  const screens = Math.min(probes + FINALISTS - 1 + 2 + CHALLENGERS, poolSize);
  const finals = Math.min(FINALISTS + CHALLENGERS, poolSize);
  return { probes, screens, fullRuns: (1 + finals) * repeats };
}

function approvalQuestion(ctx: Context, runId: string, data: RunState): Question {
  const configured = endpoints(ctx);
  const repeats = Math.max(1, repoConfig(ctx).repeats ?? DEFAULT_REPEATS);
  const base = baselineRef(ctx, data);
  const run = ctx.state.getRun(runId)!;
  const destinations = new Set<string>();
  const endpointLabel = (id: string) => { const endpoint = configured.find(item => item.id === id); return endpoint ? `${endpoint.id} (${endpoint.baseUrl})` : id; };
  destinations.add(endpointLabel(base.endpoint));
  const sections = Object.entries(data.evals!).map(([name, plan]) => {
    if ("skipped" in plan) return `${name}: skipped (${plan.skipped})`;
    const candidates = data.pool![name] ?? [];
    for (const candidate of candidates) destinations.add(endpointLabel(candidate.endpoint));
    const runs = estimate(candidates.length, repeats);
    return [
      `${name}`,
      `  Command: ${plan.command}${plan.cwd ? ` (in ${plan.cwd})` : ""}`,
      ...(plan.env && Object.keys(plan.env).length ? [`  Env: ${Object.entries(plan.env).map(([key, value]) => `${key}=${value}`).join(" ")}`] : []),
      `  Per-item results: ${plan.langfuse ? `the eval records each run as a Langfuse experiment on dataset ${plan.langfuse.dataset} with its own keys; OpenMerit reads score ${plan.langfuse.score}${plan.langfuse.min !== undefined ? ` ≥ ${plan.langfuse.min}` : ""} back with the Viewer key` : "reported by the eval in $OPENMERIT_RESULT"}${plan.threshold !== undefined ? `; required pass rate ${plan.threshold}` : ""}`,
      ...(plan.explanation ? [`  Why: ${plan.explanation}`] : []),
      `  Search: ${candidates.length} ECI-ranked candidates cheaper than ${data.model}${data.unranked?.[name] ? ` (${data.unranked[name]} without an ECI left out)` : ""}${candidates.length ? `, ECI ${candidates[0]!.eci.toFixed(1)}–${candidates.at(-1)!.eci.toFixed(1)}` : ""}.`,
      `  Runs: the current model on every item ${repeats}×; binary search screens on ${SAMPLE_SIZE} items it passes (about ${runs.probes} probes, up to ${runs.screens} screens with neighbours and challengers); up to ${FINALISTS} finalists and ${CHALLENGERS} challengers on every item ${repeats}×. At most ${runs.fullRuns} full eval runs and ${runs.screens} screens.`,
      ...(plan.helperFiles ?? []).map(helper => `  New helper file ${helper.path} (${helper.purpose}):\n${helper.content.split("\n").map(line => `    + ${line}`).join("\n")}`),
    ].join("\n");
  });
  return {
    id: "approve_evals", kind: "confirm", default: false,
    prompt: "Run these evals? They make paid model requests.",
    detail: `${sections.join("\n\n")}\n\nEval inputs and prompts go to: ${[...destinations].join(", ")}, through OpenMerit's local metering proxy (127.0.0.1).\nEval budget for this run: $${run.budgetUsd.toFixed(2)}. Requests that would pass it are refused before they are sent, and the run pauses to ask. Harness inference is billed separately by the harness provider.\nOpenMerit's Langfuse connection stays read-only; any Langfuse writes are your eval's own.`,
  };
}

function retryQuestion(ctx: Context, runId: string, stale: UnitRow[]): Question {
  const spent = stale.reduce((sum, unit) => sum + ctx.state.spend(runId, unit.id).totalUsd, 0);
  return {
    id: "retry_units", kind: "confirm", default: false,
    prompt: `${stale.length} eval run(s) failed or were interrupted. Run them again?`,
    detail: `${stale.map(unit => `- ${unit.task} · ${unit.role} ${unit.model} (run ${unit.repeat}): ${(unit.error ?? unit.status).split("\n")[0]}`).join("\n")}\nTheir earlier requests already cost ${usd(spent)} and stay counted against this run's budget; running again spends again. Answer no to stop that task's search when the current model's run or a screen failed, or to report a failed final as unmeasured.`,
  };
}

function budgetQuestions(ctx: Context, runId: string): Question[] {
  const run = ctx.state.getRun(runId)!;
  const spend = ctx.state.spend(runId);
  return [
    { id: "budget_action", kind: "choice", prompt: `The eval budget of $${run.budgetUsd.toFixed(2)} is reached. Raise it to continue?`,
      detail: `${ctx.state.units(runId).some(unit => unit.status === "budget_paused") ? "The paused eval run restarts from its beginning when it continues; requests it already made stay counted. " : ""}Used: $${spend.settledUsd.toFixed(4)} settled (${spend.estimatedUsd > 0 ? `$${spend.estimatedUsd.toFixed(4)} of it estimated from list prices` : "provider-reported"})${spend.inFlight ? `, $${spend.inFlightUsd.toFixed(4)} reserved for ${spend.inFlight} request(s) whose cost is unknown` : ""}${spend.unknown ? `, ${spend.unknown} request(s) without a price, counted at their reservation` : ""}. Providers bill independently; this is OpenMerit's ledger, not a provider-enforced cap.`,
      options: [{ value: "run", label: "Raise for this run only" }, { value: "default", label: "Raise for this run and save it as the repository's default" }, { value: "decline", label: "Keep the run paused" }] },
    { id: "budget_amount", kind: "text", prompt: "New budget for this run in USD", default: String(Math.max(run.budgetUsd * 2, run.budgetUsd + 5)) },
  ];
}

/** The eval's directory relative to the repository, so the saved config stays portable; null for the root. */
function evalCwd(root: string, cwd: string | undefined): string | null {
  if (!cwd || cwd === ".") return null;
  const path = relative(root, resolve(root, cwd));
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(`The harness proposed running the eval outside the repository (${cwd}); refusing it.`);
  return path || null;
}

const toEntry = (item: PoolModel): PoolEntry => ({ key: item.model.id, model: item.model.id, endpoint: item.endpoint.id, endpointModel: item.endpointModel, eci: item.model.eci!, eciSource: item.model.eciSource, price: blendedPrice(item.model) });

/**
 * Allowed-pool models a task could switch to: priced, cheaper than the current model, and able to do
 * what the task needs (tools, images, structured output). The binary search ranks them by ECI.
 */
export function eligibleCandidates(catalogue: Catalogue, configured: readonly Endpoint[], baseline: CatalogueModel, task: Pick<Task, "usesTools" | "needsVision" | "structuredOutput">): PoolModel[] {
  const ceiling = blendedPrice(baseline);
  return pool(configured, catalogue).filter(({ model }) => {
    const price = blendedPrice(model);
    if (model.id === baseline.id || price === null || price <= 0) return false;
    if (ceiling !== null && price >= ceiling) return false;
    if (task.usesTools && !model.tools) return false;
    if (task.needsVision && !model.vision) return false;
    if (task.structuredOutput && !model.structuredOutputs) return false;
    return true;
  });
}

/** Measured eval cost of some units from the proxy ledger, or null when a request had no price. */
function unitCost(ctx: Context, runId: string, units: UnitRow[]) {
  const usage = units.map(unit => ctx.state.usage(runId, unit.id));
  const requests = usage.reduce((sum, item) => sum + item.requests, 0);
  if (!requests || usage.some(item => item.unknown)) return null;
  const cost = usage.reduce((sum, item) => sum + item.actualUsd + item.estimatedUsd, 0);
  return { cost, estimate: usage.some(item => item.estimatedUsd > 0), perItem: (total: number) => (total ? cost / total : null) };
}

function measure(ctx: Context, runId: string, units: UnitRow[], repeats: number, role: ModelResult["role"], entry: ModelRef, eci: number | null): ModelResult {
  const done = units.filter(unit => unit.status === "done");
  const results = done.map(unit => unit.result as unknown as UnitResult);
  const passes = results.reduce((sum, item) => sum + item.passes, 0), total = results.reduce((sum, item) => sum + item.total, 0);
  const usage = units.map(unit => ctx.state.usage(runId, unit.id));
  const requests = usage.reduce((sum, item) => sum + item.requests, 0);
  const status: ModelResult["status"] = !units.length ? "not_run" : done.length === repeats && units.length === repeats ? "measured" : units.some(unit => unit.status === "unavailable") ? "unavailable"
    : units.some(unit => unit.status === "budget_paused") ? "budget_paused" : units.some(unit => unit.status === "failed" || unit.status === "interrupted") ? "failed" : "incomplete";
  const cost = status === "measured" ? unitCost(ctx, runId, units) : null;
  const failed = units.find(unit => unit.status === "failed" || unit.status === "unavailable");
  return {
    ...entry, role, eci, status, passes, total, runs: done.length, score: total ? passes / total : null,
    source: results[0]?.source ?? null,
    costPerItemUsd: cost?.perItem(total) ?? null, costIsEstimate: cost?.estimate ?? false,
    meanLatencyMs: requests ? usage.reduce((sum, item) => sum + item.latencyMs, 0) / requests : null,
    requests, qualified: false,
    note: status === "measured" ? (requests === 0 ? "the eval made no model requests through OpenMerit, so its cost is not measured" : "")
      : status === "unavailable" ? `untested: ${(failed?.error ?? "").split("\n")[0]}` : status === "failed" ? `failed: ${(failed?.error ?? "interrupted").split("\n")[0]}`
      : status === "budget_paused" ? "not measured: the run is paused on its budget" : status === "not_run" ? "not run" : "not every run finished",
    evidence: units.map(unit => unit.id), experiments: results.map(item => item.experiment),
  };
}

function compareTask(ctx: Context, runId: string, data: RunState, name: string, plan: PlannedEval): TaskComparison {
  const units = ctx.state.units(runId).filter(unit => unit.task === name);
  const repeats = data.repeats ?? DEFAULT_REPEATS;
  const base = baselineRef(ctx, data);
  const baseEci = ctx.catalogue.models.find(model => model.id === base.model)?.eci ?? null;
  const baseline = measure(ctx, runId, units.filter(unit => unit.role === "baseline"), repeats, "baseline", base, baseEci);
  const summary = data.search?.[name];
  const byModel = new Map((data.pool?.[name] ?? []).map(entry => [entry.model, entry]));
  const finals = [...(summary?.finalists ?? []), ...(summary?.challengers ?? [])].map(model => byModel.get(model)!).filter(Boolean);
  const candidates = finals.map(entry => measure(ctx, runId, units.filter(unit => unit.role === "final" && unit.model === entry.model), repeats, "candidate", entry, entry.eci));
  const comparison: TaskComparison = {
    task: name, eval: { command: redact(plan.command), source: plan.source, threshold: plan.threshold ?? null, langfuse: plan.langfuse ? `score ${plan.langfuse.score} on dataset ${plan.langfuse.dataset}` : null },
    baseline, candidates, top: [], status: "incomplete", note: "", ...(summary ? { search: summary } : {}),
  };
  if (baseline.status !== "measured") return { ...comparison, status: "baseline_failed", note: `The current model's eval did not complete (${baseline.note}), so no candidate can be compared. Fix the eval and resume the run.` };
  if (data.stopped?.[name]) return { ...comparison, status: "stopped", note: `The search stopped, so no model is recommended: ${data.stopped[name]}` };
  if (summary?.status === "no_passing_model") return { ...comparison, status: "no_passing_model", note: `No candidate in the pool passed all ${SAMPLE_SIZE} screening items the current model passes.` };
  const measured = candidates.filter(item => item.status === "measured");
  // Finalists pass the screen by construction; a failed screen already shows the eval separates models.
  const screenFailed = summary?.trials.some(trial => !trial.accepted) ?? false;
  if (!screenFailed && measured.length && [baseline, ...measured].every(item => item.score === baseline.score)) {
    return { ...comparison, status: "non_discriminating", note: `The current model, every screened candidate and ${measured.length} finalist(s) all passed ${Math.round(baseline.score! * 100)}% of their item runs.` };
  }
  return { ...comparison, ...rank(comparison, false) };
}

/** Qualifies finalists at least as good as the current model under the eval's own criteria, then ranks them cheapest first. */
function rank(comparison: TaskComparison, accepted: boolean): Pick<TaskComparison, "candidates" | "top" | "status" | "note"> {
  const baseline = comparison.baseline!;
  const threshold = comparison.eval.threshold;
  const candidates = comparison.candidates.map(item => {
    if (item.status !== "measured" || item.score === null) return { ...item, qualified: false };
    const asGood = item.score >= baseline.score!;
    const meets = threshold === null || item.score >= threshold;
    const why = !asGood ? `passed ${item.passes}/${item.total} vs the current model's ${baseline.passes}/${baseline.total}` : !meets ? `below the eval's required pass rate ${threshold}` : item.costPerItemUsd === null ? "qualifies; cost not measured" : "";
    return { ...item, qualified: asGood && meets, note: item.note || why };
  });
  const top = candidates.filter(item => item.qualified).sort((a, b) => (a.costPerItemUsd ?? Infinity) - (b.costPerItemUsd ?? Infinity) || b.score! - a.score! || (a.eci ?? 0) - (b.eci ?? 0)).slice(0, TOP);
  const failed = candidates.filter(item => item.status !== "measured").length;
  return {
    candidates, top, status: top.length ? "ranked" : "no_qualified",
    note: `${candidates.filter(item => item.qualified).length} of ${candidates.length} finalists performed at least as well as ${baseline.model}${top.length ? `; the ${top.length} cheapest are shown` : ""}${failed ? `; ${failed} could not be measured` : ""}.${accepted ? " Accepted by the user although the eval did not separate the models." : ""}${top.some(item => baseline.costPerItemUsd !== null && item.costPerItemUsd !== null && item.costPerItemUsd >= baseline.costPerItemUsd) ? " Some qualifying finalists cost no less than the current model on this workload." : ""}`,
  };
}

/** The narrow edit for a configure "Yes": the task's literal model IDs, when the app already calls the winner's endpoint. */
function planEdit(ctx: Context, data: RunState, comparison: TaskComparison, winner: ModelResult): Pick<ConfigureState, "edits" | "manual"> {
  const usages = usageById(data);
  const task = data.tasks!.find(item => item.name === comparison.task)!;
  const endpoint = endpoints(ctx).find(item => item.id === winner.endpoint)!;
  const endpointUsages = data.scan!.usages.filter(usage => usage.kind === "endpoint");
  // The application calls the provider, not OpenMerit's eval route: match OpenAI and OpenRouter by their public hosts.
  const host = endpoint.kind === "openai" ? "api.openai.com" : endpoint.kind === "openrouter" ? "openrouter.ai" : new URL(endpoint.baseUrl).host;
  const edits: NonNullable<ConfigureState["edits"]> = [];
  const manual: string[] = [];
  for (const usage of task.usageIds.map(id => usages.get(id)).filter((item): item is Usage => !!item && item.kind === "model" && modelKey(item) === data.model)) {
    const fileEndpoints = endpointUsages.filter(item => item.file === usage.file);
    const sameEndpoint = (fileEndpoints.length ? fileEndpoints : endpointUsages).some(item => item.value.includes(host)) || (!endpointUsages.length && endpoint.kind === "openai");
    const style = usage.value.includes("/") ? "openrouter" : "openai";
    const target = style === "openrouter" ? winner.model : winner.endpointModel;
    if (usage.dynamic && !usage.catalogueId) { manual.push(`${ref(usage)} reads ${usage.envVar ?? usage.value} at run time: set it to ${winner.endpointModel} where that environment is configured (OpenMerit cannot change your shell's environment).`); continue; }
    if (!sameEndpoint || (style === "openrouter") !== (endpoint.kind === "openrouter")) { manual.push(`${ref(usage)} calls a different endpoint than ${endpoint.id}: switching needs an endpoint change too. Point it at ${endpoint.baseUrl} and use model ${winner.endpointModel}.`); continue; }
    const raw = readFileSync(join(ctx.repo.root, usage.file), "utf8").split("\n")[usage.line - 1] ?? "";
    const quoted = new RegExp(`(["'\`])${usage.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`);
    if (!quoted.test(raw)) { manual.push(`${ref(usage)}: change ${usage.value} to ${target} by hand.`); continue; }
    edits.push({ file: usage.file, line: usage.line, before: redact(raw), after: redact(raw.replace(quoted, `$1${target}$1`)), hash: hash(raw), from: usage.value, to: target });
    if (usage.envVar) manual.push(`${ref(usage)}: ${usage.envVar} overrides this default when it is set; update it too if your environment sets it.`);
  }
  return { edits, manual };
}

const diff = (edits: NonNullable<ConfigureState["edits"]>) => edits.map(edit => `--- a/${edit.file}\n+++ b/${edit.file}\n@@ line ${edit.line} @@\n-${edit.before}\n+${edit.after}`).join("\n");

/** Applies only previewed lines, and only when each line is still what the preview showed. */
function applyEdits(root: string, edits: NonNullable<ConfigureState["edits"]>) {
  const byFile = new Map<string, typeof edits>();
  for (const edit of edits) byFile.set(edit.file, [...byFile.get(edit.file) ?? [], edit]);
  const writes: [string, string][] = [];
  for (const [file, fileEdits] of byFile) {
    const path = join(root, file);
    const lines = readFileSync(path, "utf8").split("\n");
    for (const edit of fileEdits) {
      const raw = lines[edit.line - 1] ?? "";
      if (hash(raw) !== edit.hash) throw new Error(`${file}:${edit.line} changed after the preview; nothing was applied. Resume the run to preview again.`);
      lines[edit.line - 1] = raw.replace(new RegExp(`(["'\`])${edit.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`), `$1${edit.to}$1`);
    }
    writes.push([path, lines.join("\n")]);
  }
  for (const [path, text] of writes) writeFileSync(path, text);
}

export const DEFAULT_BUDGET = DEFAULT_BUDGET_USD;
