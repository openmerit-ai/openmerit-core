// Scout's workflow as a resumable state machine shared by the CLI and the MCP server.
// `advance(ctx, runId, answers)` works until it needs a person (questions), finishes, pauses on the
// budget or fails. Every step is saved in SQLite, so a run continues after a restart and history
// keeps failed, interrupted and budget-paused runs.
//
// scan → map → model → tasks (with corrections) → pool → discover → approve → evaluate
// → compare → configure → done
//
// Evaluate is Scout Model Binary Search (search.ts) on the task's own eval: the current model runs
// every item; candidates are screened on sampled items the current model passes; five finalists
// (plus cheaper, stronger challengers) run every item. Each eval run is a unit in SQLite, so a
// resumed run replays the search from recorded results and never pays twice for a finished unit.
// Per-item results come from the eval's own report in $OPENMERIT_RESULT.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { catalogueIndex, type Catalogue, type CatalogueModel } from "../engine/catalogue.ts";
import { blendedPrice, eligible, ladder } from "../engine/pool.ts";
import { redact } from "../engine/redact.ts";
import { EVAL_FLOOR, evaluateTask as runPolicy, floorNote, meetsCriteria, rankTop, shortfall, stableSample, type Criteria } from "../engine/evaluate.ts";
import { APPROVAL_PROMPT, approvalQuestion as configureQuestion } from "../engine/connector.ts";
import { chosenTask, repoScan } from "../connectors/repo-scan.ts";
import { evalCommand, evalEvidence } from "../connectors/eval-command.ts";
import { basedOn, basedOnAll, mergeEvidence, strongest, type EvidencePart, type TaskEvidence } from "../engine/evidence.ts";
import { caseEvidence } from "../connectors/agent-bundle.ts";
import { criteriaSummary, qualificationNote } from "../engine/result.ts";
import { CandidateUnavailable, CHALLENGERS, FINALISTS, order, SAMPLE_SIZE, type Stage } from "../engine/search.ts";
import { EvalProxy, retryable, type UnitTally } from "../eval/proxy.ts";
import { runEval, type EvalOutcome } from "../eval/runner.ts";
import type { Harness, HarnessUsage } from "../harness/harness.ts";
import { DEFAULT_BUDGET_USD, DEFAULT_REPEATS, readRepoConfig, resolveCredential, updateRepoConfig, type Endpoint, type EvalSpec, type RepoConfig } from "../state/config.ts";
import type { RunStatus, Spend, State, UnitRow } from "../state/db.ts";
import type { Repo } from "../state/paths.ts";
import { allowedOn, baselineEndpoint, pool, type PoolModel } from "./pool.ts";
import { context, isSupportFile, listFiles, scanRepo, type ScanResult, type Usage } from "./scan.ts";
import { applicationUsages, mapTasks, reviewTask, type MappedTask } from "../review/index.ts";
import { advanceLoop, criteriaOf, feedbackOf, gradeQuestions, MAX_ROUNDS, pickSamples, readGrade, reviseEval, startLoop, type CaseAnswer, type LoopState, type SampleGrade } from "../eval/loop.ts";
export { GRADE_HINT, MAX_ROUNDS, readGrade } from "../eval/loop.ts";
import { generateEval, generatedDir, isManaged, loadEvalVersion, loadGeneratedEval, REPO_ITEM, runGeneratedEval, saveGeneratedEval, type GeneratedEval, type GeneratedOutcome } from "../eval/generated.ts";
import { caseKind } from "../ranking/types.ts";

export type Answer = string | string[] | boolean | number;
export type Answers = Record<string, Answer>;

export interface Question {
  id: string;
  kind: "choice" | "multi" | "confirm" | "text";
  prompt: string;
  detail?: string;
  options?: { value: string; label: string; detail?: string }[];
  default?: Answer;
  /** What to type, for answers beyond the options, such as a mapping correction. */
  hint?: string;
}

export type Task = MappedTask;

/** A candidate in a task's pool: ECI-ranked, allowed, cheaper than the current model. */
export interface PoolEntry { key: string; model: string; endpoint: string; endpointModel: string; eci: number; eciSource: string | null; price: number | null }

interface ModelRef { model: string; endpoint: string; endpointModel: string }

interface PlannedEval extends EvalSpec { source: "saved" | "harness" | "user" | "generated"; helperFiles?: { path: string; content: string; purpose: string }[]; explanation?: string; /** Labelled items the harness counted in the repository's eval, when it could tell. */ items?: number | null }

/** One eval run's result as recorded in SQLite: pass/fail per item, nothing else from the item. */
export interface UnitResult {
  items: Record<string, boolean>; passes: number; total: number; source: "eval"; requests: number; durationMs: number;
  /** Answers cut off by their token limit before any text (absent in runs saved before it was counted). */
  cutOff?: number;
  /** For a generated eval: why each failed item failed, in one redacted sentence. */
  reasons?: Record<string, string>;
  /** For a generated eval: the spec's checks each failed item failed, and each answer, redacted, for a person to grade. */
  checks?: Record<string, string[]>;
  answers?: CaseAnswer[];
}

export interface SearchSummary {
  /** `below_floor`: the current model passed under 80% of the generated eval, so nothing was screened, and a person grades its answers. */
  status: "running" | "selected" | "no_passing_model" | "stopped" | "below_floor";
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
  floorNote?: string;
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
  /** Where per-item results came from: the eval's own report. */
  source: "eval" | null;
  /** Measured eval cost per item run, from the metering proxy. */
  costPerItemUsd: number | null;
  costIsEstimate: boolean;
  meanLatencyMs: number | null;
  requests: number;
  qualified: boolean;
  note: string;
  /** Eval units in SQLite this result rests on. */
  evidence: string[];
}

export interface TaskComparison {
  task: string;
  eval: { command: string; source: string; threshold: number | null };
  baseline: ModelResult | null;
  candidates: ModelResult[];
  /** Up to three qualified candidates, cheapest measured cost first. */
  top: ModelResult[];
  status: "ranked" | "no_qualified" | "no_passing_model" | "stopped" | "baseline_failed" | "no_eval" | "non_discriminating" | "incomplete";
  note: string;
  search?: SearchSummary;
  /** The evidence each decision used, strongest first by openmerit/engine's quality rule. */
  basedOn?: string[];
  /** Set once a person marked the current model's answer wrong: models were measured against the Eval's checks, and these are the checks the current model misses. */
  bar?: "criteria";
  failedChecks?: string[];
}

interface ConfigureState { decision?: "yes" | "no"; edits?: { file: string; line: number; before: string; after: string; hash: string; from: string; to: string }[]; manual?: string[]; applied?: boolean }

export interface RunState {
  scan?: ScanResult;
  tasks?: Task[];
  model?: string;
  corrected?: boolean;
  selected?: string[];
  pool?: Record<string, PoolEntry[]>;
  unranked?: Record<string, number>;
  evals?: Record<string, PlannedEval | { skipped: string }>;
  /** Evals OpenMerit wrote for this run, by task, until a person accepts one and it is saved in `.openmerit/evals/<task>/`. */
  generated?: Record<string, GeneratedEval>;
  /** The grading loop of each task with a generated eval, and the Eval version saved for each so far. */
  loop?: Record<string, LoopState>;
  savedEvals?: Record<string, number>;
  evalApproved?: boolean;
  repeats?: number;
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

const PHASES = ["scan", "disclose", "map", "model", "corrections", "tasks", "pool", "discover", "approve", "evaluate", "grade", "compare", "configure", "done"] as const;
type Phase = typeof PHASES[number];
export const TOP = 3;
/** The model that judges a generated eval's text answers and guardrails, when an endpoint may run it. */
export const JUDGE_MODEL = "anthropic/claude-sonnet-5.5";
const NO_EVAL_NEXT = "Run `openmerit scout` again to have OpenMerit write its eval, or add an eval that follows the eval contract in OpenMerit's README (it runs once per model and reports pass or fail per item), which Scout finds and runs.";
export const TASK_QUESTION = "Select which Agents/Tasks do you want OpenMerit to review?";
export const CONFIGURE_QUESTION = APPROVAL_PROMPT;
/** Provider answers that mean the model cannot run at all: skipped as untested, not failed. */
const UNAVAILABLE_STATUSES = [400, 402, 404, 413, 422];


const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "task";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const yes = (value: Answer | undefined) => value === true || (typeof value === "string" && /^(y|yes|true|approve|ok)$/i.test(value.trim()));
const no = (value: Answer | undefined) => value === false || (typeof value === "string" && /^(n|no|false|decline|cancel)$/i.test(value.trim()));
const list = (value: Answer | undefined): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : []);
/** An object schema; `optional` properties may be left out of a reply. */
const strict = (properties: Record<string, unknown>, optional: Record<string, unknown> = {}) => ({ type: "object", properties: { ...properties, ...optional }, required: Object.keys(properties), additionalProperties: false });
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
    if (!harness) {
      harness = await ctx.harness(); harnessStart = { ...harness.usage };
      // `openmerit connect` between steps switches the harness for the rest of the run: history lists each one in order.
      const used = state.getRun(runId)!.harness.split(" → ");
      if (used.at(-1) !== harness.label) {
        state.updateRun(runId, { harness: [...used, harness.label].join(" → ") });
        state.event(runId, "harness", `Harness switched from ${used.at(-1)} to ${harness.label}.`);
      }
    }
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
/** A usage Scout reviews for the chosen model: that model, or a model the application's code reads at run time without naming a catalogue model. */
const reviewed = (data: RunState) => (usage: Usage | undefined): usage is Usage => !!usage && usage.kind === "model"
  && (modelKey(usage) === data.model || (usage.dynamic && !usage.catalogueId && !isSupportFile(usage.file)));
/** Tasks that use the chosen model, then tasks whose model is only known at run time (the user named it), then unmapped usages. */
function tasksForModel(data: RunState): Task[] {
  const usages = usageById(data);
  const uses = (task: Task, test: (usage: Usage | undefined) => boolean) => task.usageIds.some(id => test(usages.get(id)));
  const direct = (data.tasks ?? []).filter(task => uses(task, usage => !!usage && usage.kind === "model" && modelKey(usage) === data.model));
  const offered = [...direct, ...(data.tasks ?? []).filter(task => !direct.includes(task) && uses(task, reviewed(data)))];
  // Usages the harness did not map come last.
  const rank = (task: Task) => (task.name.startsWith("unmapped: ") ? 1 : 0);
  return offered.map((task, index) => ({ task, index })).sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index).map(item => item.task);
}
function repoConfig(ctx: Context): RepoConfig { return readRepoConfig(ctx.repo.root); }
function endpoints(ctx: Context): Endpoint[] {
  const configured = repoConfig(ctx).endpoints ?? [];
  if (!configured.length) throw new Error("No candidate endpoints are configured for this repository. Run `openmerit setup`.");
  return configured;
}
/** The fixed judge of a generated eval: JUDGE_MODEL on the first endpoint allowed to run it, else the current model on its endpoint. */
function judgeRef(ctx: Context, data: RunState): ModelRef {
  const found = pool(endpoints(ctx), ctx.catalogue).find(item => item.model.id === JUDGE_MODEL);
  return found ? { model: found.model.id, endpoint: found.endpoint.id, endpointModel: found.endpointModel } : baselineRef(ctx, data);
}

function baselineRef(ctx: Context, data: RunState): ModelRef {
  const base = baselineEndpoint(endpoints(ctx), ctx.catalogue, data.model!)!;
  return { model: base.model.id, endpoint: base.endpoint.id, endpointModel: base.endpointModel };
}
const plannedEvals = (data: RunState) => Object.entries(data.evals ?? {}).filter((entry): entry is [string, PlannedEval] => !("skipped" in entry[1]));

const PHASE_HANDLERS: Record<Phase, Handler> = {
  async scan({ ctx, runId, data }) {
    ctx.log("Scanning codebase for models and endpoints…");
    const scan = scanRepo(ctx.repo.root, ctx.catalogue, { exclude: repoConfig(ctx).scan?.exclude ?? [] });
    data.scan = scan;
    if (scan.skipped.length) {
      ctx.log(`Skipped ${scan.skipped.length} data file${scan.skipped.length === 1 ? "" : "s"}: ${scan.skipped.slice(0, 2).join(", ")}${scan.skipped.length > 2 ? ` and ${scan.skipped.length - 2} more` : ""}`);
      ctx.state.event(runId, "scan", `Skipped data files that list many models: ${scan.skipped.join(", ")}.`);
    }
    const models = scan.usages.filter(usage => usage.kind === "model");
    ctx.state.event(runId, "scan", `Scanned ${scan.files} files: ${models.length} model usages (${models.filter(usage => usage.dynamic).length} dynamic), ${scan.usages.length - models.length} endpoint usages.`);
    if (!models.length) throw new Error("No model usages found in this repository. Scout looks for model IDs in code and configuration that Git does not ignore.");
    if (models.every(usage => isSupportFile(usage.file))) throw new Error(`Every model usage in this repository (${models.length}) is in tests, fixtures, docs or saved results, and Scout reviews only the application's code. Scout looks for model IDs in code and configuration that Git does not ignore.`);
    return "map";
  },

  // Scout used to ask here before sending code context to the harness; runs saved at that question continue to the mapping.
  async disclose() { return "map"; },

  async map({ ctx, runId, data, getHarness }) {
    const scan = data.scan!;
    ctx.log(`Mapping ${scan.usages.length} usages to tasks…`);
    const harness = await getHarness();
    // Saved evals are keyed by task name: ask for the same names again so an approved eval is reused, not found and paid for again.
    const tasks: Task[] = await mapTasks({ root: ctx.repo.root, scan, harness, names: Object.keys(repoConfig(ctx).evals ?? {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    // What the harness left out of the application's code stays selectable, per file; tests, fixtures, docs and saved results make no task.
    for (const usage of applicationUsages(scan).filter(item => item.kind === "model" && !tasks.some(task => task.usageIds.includes(item.id)))) {
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
      if (!tasksForModel(data).length) throw new NeedsInput([modelQuestion(data)], "needs_input", [`No task of the application uses ${data.model}: it is only in tests, fixtures, docs or saved results, which Scout does not review. Choose another model.`]);
      return "tasks";
    }
    if (!data.scan!.models.some(item => item.catalogueId)) throw new Error(`None of the models found in this repository is in the bundled catalogue (version ${ctx.catalogue.version}), so Scout cannot price or place them. Update openmerit.`);
    throw new NeedsInput([modelQuestion(data)]);
  },

  // Scout used to ask for mapping corrections here; the task question takes them now.
  async corrections() { return "tasks"; },

  async tasks({ data, answers }) {
    const chosen = list(answers.tasks);
    // <usage id>=<task name> moves a usage to that task, or to a new one, before the selection.
    for (const item of chosen.filter(entry => entry.includes("="))) {
      const [id = "", ...rest] = item.split("=");
      const name = rest.join("=").trim();
      const usage = usageById(data).get(id.trim());
      if (!usage || !name) throw new NeedsInput([tasksQuestion(data)], "needs_input", [`Write a correction as <usage id>=<task name>, not "${item}".`]);
      if (isSupportFile(usage.file)) throw new NeedsInput([tasksQuestion(data)], "needs_input", [`${usage.id} is in ${usage.file}, a test, fixture, doc or saved result, and Scout reviews only the application's code.`]);
      for (const task of data.tasks!) task.usageIds = task.usageIds.filter(other => other !== usage.id);
      const target = data.tasks!.find(task => task.name === name);
      if (target) target.usageIds.push(usage.id);
      else data.tasks!.push({ name, description: "Added by the user", usageIds: [usage.id], usesTools: false, needsVision: false, structuredOutput: false });
      data.tasks = data.tasks!.filter(task => task.usageIds.length);
    }
    const names = chosen.filter(entry => !entry.includes("="));
    if (!names.length) throw new NeedsInput([tasksQuestion(data)]);
    const available = tasksForModel(data);
    const unknown = names.filter(name => !available.some(task => task.name === name));
    if (unknown.length) throw new NeedsInput([tasksQuestion(data)], "needs_input", [`Not a task of ${data.model}: ${unknown.join(", ")}.`]);
    data.selected = names;
    return "pool";
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
      const { ranked, unplaced } = ladder(eligible.map(toEntry));
      data.pool[name] = ranked;
      data.unranked[name] = unplaced.length;
      ctx.state.event(runId, "pool", `${name}: ${ranked.length} ECI-ranked candidates cheaper than ${baseline.id} in the allowed pool${data.unranked[name] ? ` (${data.unranked[name]} without an ECI left out)` : ""}.`);
    }
    return "discover";
  },

  async discover({ ctx, runId, data, getHarness, save }) {
    data.evals ??= {};
    data.generated ??= {};
    const saved = repoConfig(ctx).evals ?? {};
    for (const name of data.selected!) {
      if (data.evals[name]) continue;
      const savedName = Object.keys(saved).find(other => other.toLowerCase() === name.toLowerCase());
      const savedSpec = savedName ? saved[savedName]! : null;
      // An Eval OpenMerit generated and the user approved is reused as it is, with the repository's own eval beside it.
      // An eval app.openmerit.ai owns is edited there: Scout runs the copy the coding agent wrote, at the cloud's version, without grading it.
      const managed = savedSpec?.generated ?? generatedDir(name);
      if (isManaged(ctx.repo.root, managed)) {
        data.evals[name] = { ...savedSpec, source: "saved", command: `openmerit eval ${managed}`, generated: managed };
        const copy = loadEvalVersion(ctx.repo.root, managed);
        (data.loop ??= {})[name] = { ...startLoop(copy.version, copy.bar), status: "accepted", savedVersion: copy.version };
        ctx.state.event(runId, "discover", `${name}: runs version ${copy.version} of the eval app.openmerit.ai manages, from ${managed}; edit it in the app.`);
        save();
        continue;
      }
      if (savedSpec?.generated) {
        data.evals[name] = { ...savedSpec, source: "saved" };
        // A person already accepted it: no grading, and the bar they left it at.
        const saved = loadEvalVersion(ctx.repo.root, savedSpec.generated);
        (data.loop ??= {})[name] = { ...startLoop(saved.version, saved.bar), status: "accepted", savedVersion: saved.version };
        continue;
      }
      const harness = await getHarness();
      const task = data.tasks!.find(item => item.name === name)!;
      // The repository's own eval, when it has one, runs beside the generated eval as extra evidence.
      let own: PlannedEval | null = savedSpec ? { ...savedSpec, source: "saved" } : null;
      if (!own) { ctx.log(`Finding the eval for ${name}…`); own = await findRepoEval(ctx, runId, data, name, harness); }
      ctx.log(`Reviewing ${name} and writing its eval…`);
      let generated: GeneratedEval | null = null, why = "the harness wrote no usable case from the task's spec";
      try {
        const bundle = await reviewTask({ root: ctx.repo.root, scan: data.scan!, harness, task, ...(data.model ? { currentModel: data.model } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        generated = await generateEval(bundle, harness, ctx.signal);
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        why = `the review failed: ${redact((error as Error).message).split("\n")[0]}`;
      }
      if (!generated?.cases.length) {
        // Without a generated eval, the repository's own eval measures alone, if it has enough items to screen on.
        const small = own && typeof own.items === "number" && own.items < SAMPLE_SIZE ? own : null, tooSmall = !!small;
        data.evals[name] = own && !tooSmall ? own
          : { skipped: `OpenMerit wrote no eval for it (${why})${small ? `, and the repository's eval (\`${redact(small.command)}\`) has ${small.items} labelled item${small.items === 1 ? "" : "s"}, fewer than the ${SAMPLE_SIZE} Scout screens candidates on` : own ? "" : ", and the repository has none"}` };
        ctx.state.event(runId, "discover", `${name}: ${why}${own && !tooSmall ? "; the repository's eval measures it alone" : "; skipped"}.`);
        save();
        continue;
      }
      const bundle = generated.bundle;
      const dir = generatedDir(name);
      data.generated[name] = generated;
      (data.loop ??= {})[name] = startLoop();
      const plan: PlannedEval = { source: "generated", command: `openmerit eval ${dir}`, generated: dir };
      if (own) {
        const { source: _source, helperFiles, explanation, generated: _generated, repoEval: _repoEval, items: _items, ...repoEval } = own;
        Object.assign(plan, { repoEval, ...(helperFiles ? { helperFiles } : {}), ...(explanation ? { explanation } : {}) });
      }
      data.evals[name] = plan;
      const kinds = Object.entries(generated.cases.reduce<Record<string, number>>((counts, item) => ({ ...counts, [caseKind(item)]: (counts[caseKind(item)] ?? 0) + 1 }), {})).map(([kind, count]) => `${count} ${kind}`).join(", ");
      ctx.state.event(runId, "discover", `${name}: OpenMerit wrote an eval from the task's spec (${generated.cases.length} cases: ${kinds}; ${bundle.criteria?.length ?? 0} criteria, ${bundle.guardrails?.length ?? 0} guardrails)${own ? `, with the repository's eval \`${redact(own.command)}\` beside it` : ""}.`);
      save();
    }
    // Nothing to measure is an answer, not a failure: the comparison lists each task as not reviewed, and why.
    if (!plannedEvals(data).length) return "compare";
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
      const { source: _source, helperFiles, explanation: _explanation, items: _items, ...spec } = plan;
      const helpers = helperFiles?.length ? { helpers: helperFiles.map(helper => helper.path) } : {};
      // A generated eval is saved once a person accepts it in the grading loop; until then only the repository's eval is.
      if (plan.generated && plan.source === "generated") { if (plan.repoEval) evals[name] = { ...plan.repoEval, ...helpers }; }
      else evals[name] = { ...spec, ...helpers };
    }
    updateRepoConfig(ctx.repo.root, { evals });
    data.evalApproved = true;
    data.repeats = Math.max(1, config.repeats ?? DEFAULT_REPEATS);
    ctx.state.decision(runId, "eval_execution", "approved", { tasks: plannedEvals(data).map(([name]) => name), repeats: data.repeats, helpers: plannedEvals(data).flatMap(([, plan]) => (plan.helperFiles ?? []).map(helper => helper.path)) });
    return "evaluate";
  },

  evaluate: evaluatePhase,
  grade: gradePhase,

  async compare({ ctx, runId, data, answers, save }) {
    data.compare ??= {};
    data.accepted ??= {};
    const config = repoConfig(ctx);
    const pending: Question[] = [];
    for (const name of data.selected!) {
      const plan = data.evals![name]!;
      if ("skipped" in plan) {
        data.compare[name] = { task: name, eval: { command: "", source: "none", threshold: null }, baseline: null, candidates: [], top: [], status: "no_eval", note: `${plan.skipped.replace(/\.$/, "")}. ${NO_EVAL_NEXT}` };
        continue;
      }
      const comparison = compareTask(ctx, runId, data, name, plan);
      const key = `accept_${slug(name)}`;
      if (comparison.status === "non_discriminating") {
        const answer = answers[key] ?? data.accepted[name];
        if (answer === "accept") { data.accepted[name] = "accept"; Object.assign(comparison, rank(comparison, true)); }
        else if (answer === "stop") data.accepted[name] = "stop";
        else pending.push({ id: key, kind: "choice", prompt: `Every model scored the same on the ${name} eval. Rank by cost anyway?`, detail: comparison.note, options: [{ value: "accept", label: "Accept: rank the qualifying models by cost" }, { value: "stop", label: "Stop: no recommendation for this task until the eval is improved" }] });
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
        if (!yes(answer)) throw new NeedsInput([configureQuestion(comparison.task, data.model!, winner)]);
        current.decision = "yes";
        // The repository connector's Change port: openmerit/engine's proposeEdit, with the checks only the repository can answer.
        const { edits, manual } = repoScan({
          root: ctx.repo.root, exclude: repoConfig(ctx).scan?.exclude ?? [], catalogue: ctx.catalogue, usages: data.scan!.usages, tasks: data.tasks!, reviewed: reviewed(data),
          currentModel: data.model!, endpoint: id => endpoints(ctx).find(item => item.id === id)!,
        }).change.propose(comparison.task, { model: winner.model, endpoint: winner.endpoint, endpointModel: winner.endpointModel, onOpenRouter: false });
        Object.assign(current, { edits, manual });
        if (!current.edits?.length) { ctx.state.decision(runId, "configure", "manual", { task: comparison.task, model: winner.model, manual: current.manual }); continue; }
      }
      const answer = answers[`apply_${key}`];
      if (no(answer)) { current.applied = false; current.edits = []; ctx.state.decision(runId, "configure", "preview_declined", { task: comparison.task }); continue; }
      if (!yes(answer)) throw new NeedsInput([{ id: `apply_${key}`, kind: "confirm", default: false, prompt: `Apply this change to ${comparison.task}?`, detail: `${diff(current.edits!)}${current.manual?.length ? `\n\nAlso, by hand:\n${current.manual.map(item => `- ${item}`).join("\n")}` : ""}` }]);
      applyEdits(ctx.repo.root, current.edits!);
      current.applied = true;
      ctx.state.decision(runId, "configure", "applied", { task: comparison.task, model: winner.model, diff: diff(current.edits!) });
      ctx.state.event(runId, "configure", `Configured "${comparison.task}": ${current.edits!.map(edit => `${edit.file}:${edit.line}`).join(", ")}.`);
    }
    return "done";
  },

  async done() { return "done"; },
};

/** Each generated case's kind, for the current model's pass rate per kind. */
const itemKinds = (value: GeneratedEval): Record<string, string> => Object.fromEntries(value.cases.map(item => [item.id, caseKind(item)]));

/** The eval the repository already has for a task, as the harness finds it; null when it has none. */
async function findRepoEval(ctx: Context, runId: string, data: RunState, name: string, harness: Harness): Promise<PlannedEval | null> {
  const task = data.tasks!.find(item => item.name === name)!;
  const usages = usageById(data);
  const files = listFiles(ctx.repo.root).filter(file => /(eval|bench|test|spec|dataset|fixture|golden|score|grade)/i.test(file)).slice(0, 200);
  const pkg = existsSync(join(ctx.repo.root, "package.json")) ? JSON.stringify((JSON.parse(readFileSync(join(ctx.repo.root, "package.json"), "utf8")) as { scripts?: unknown }).scripts ?? {}, null, 1) : "(no package.json)";
  const reply = await harness.json<{ found: boolean; command: string; cwd: string; env: { name: string; value: string }[]; threshold: number | null; helpers: { path: string; content: string; purpose: string }[]; explanation: string; missing: string; items?: number | null }>({
    cwd: ctx.repo.root,
    system: "You are OpenMerit Harness running OpenMerit Scout's evaluation step. You find the eval a task already has and say exactly how to run it for another model. Never invent an eval, dataset or labels: if the repository has none for this task, say so.",
    prompt: `Task: ${task.name}: ${task.description}\nUsages:\n${task.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage).map(usage => `- ${usage.value} at ${ref(usage)}\n${context(ctx.repo.root, usage, 4)}`).join("\n")}\n\npackage.json scripts: ${pkg}\nFiles that look like evals, tests or datasets:\n${files.join("\n")}\n\n${EVAL_CONTRACT}\n\nThe model under test is the one this task's usages call: the eval must send those calls to {{model}}, such as the judge's calls for a judge task, and leave its other model calls as they are. Every model call of the task must go to OPENAI_BASE_URL (or OPENMERIT_BASE_URL) with OPENAI_API_KEY: OpenMerit meters and caps eval spend there, and a call that goes elsewhere, such as through a provider SDK with its own key or a deployed service, is neither metered nor made with {{model}}. If the existing eval cannot be pointed there, add a helper that is. The repository's dependencies are installed, so the command runs the eval only, with no install or build step.\n\nThe eval must run only the OPENMERIT_ITEMS items when given, and report each item's pass or fail itself. Only if the existing eval cannot take the model or the items, or cannot report per-item results this way, may you add helper files, and only under .openmerit/evals/; they must call the existing eval code with the same inputs, prompts, tools and scoring. threshold is the minimum pass rate (0 to 1) the eval itself requires, or null. items is how many labelled items the eval runs in all, or null when you cannot tell from the repository. Set found false and explain in missing when there is no eval for this task.`,
    schema: strict({ found: { type: "boolean" }, command: { type: "string" }, cwd: { type: "string" }, env: { type: "array", items: strict({ name: { type: "string" }, value: { type: "string" } }) }, threshold: { type: ["number", "null"] }, helpers: { type: "array", items: strict({ path: { type: "string" }, content: { type: "string" }, purpose: { type: "string" } }) }, explanation: { type: "string" }, missing: { type: "string" } }, { items: { type: ["number", "null"] } }),
  });
  if (!reply.found || !reply.command?.trim()) return null;
  const helpers = (reply.helpers ?? []).map(helper => ({ ...helper, path: normalize(helper.path).replace(/^\.\//, "") }));
  const outside = helpers.find(helper => !helper.path.startsWith(".openmerit/evals/") || helper.path.includes(".."));
  if (outside) throw new Error(`The harness proposed a helper outside .openmerit/evals/ (${outside.path}); refusing it. Retry with \`openmerit scout --resume ${runId}\`.`);
  const cwd = evalCwd(ctx.repo.root, reply.cwd);
  const plan: PlannedEval = {
    source: "harness", command: reply.command.trim(), ...(cwd ? { cwd } : {}),
    env: Object.fromEntries((reply.env ?? []).filter(item => item.name && !/(KEY|TOKEN|SECRET)/.test(item.name)).map(item => [item.name, item.value])),
    ...(typeof reply.threshold === "number" ? { threshold: reply.threshold } : {}),
    helperFiles: helpers, explanation: reply.explanation, items: reply.items ?? null,
  };
  ctx.state.event(runId, "discover", `${name}: the repository's eval \`${redact(plan.command)}\`, per-item results reported by the eval${plan.helperFiles?.length ? `, ${plan.helperFiles.length} helper file(s)` : ""}.`);
  return plan;
}

const EVAL_CONTRACT = `OpenMerit runs the eval once per model and item set with these environment variables: OPENMERIT_MODEL (the model ID, as the endpoint names it), OPENAI_BASE_URL and OPENAI_API_KEY (an OpenAI-compatible endpoint, also as OPENMERIT_BASE_URL and OPENMERIT_API_KEY), OPENMERIT_ITEMS (comma-separated item IDs to run; empty means every item) and OPENMERIT_RESULT (a file path). \`{{model}}\` and \`{{items}}\` in the command or env values are replaced by the same values; map them onto the eval's own variables in env when it reads others (for example CLASSIFIER_MODEL={{model}}). The eval writes {"items":[{"id": string, "pass": boolean}]} to $OPENMERIT_RESULT or prints it as its last JSON line.`;

/** The binary search for every planned task. Replays finished units from SQLite; runs the rest. */
async function evaluatePhase({ ctx, runId, data, answers, save }: PhaseInput): Promise<Phase> {
  const { state } = ctx;
  const configured = endpoints(ctx);
  const repeats = data.repeats ??= Math.max(1, repoConfig(ctx).repeats ?? DEFAULT_REPEATS);
  const base = baselineRef(ctx, data);
  data.samples ??= {}; data.search ??= {}; data.stopped ??= {}; data.retryDeclined ??= [];
  // An earlier round's units are done with: only the current round's are retried.
  const current = (unit: UnitRow) => unit.id.startsWith(`${runId}|${taskKey(data, unit.task)}|`);
  const stale = () => state.units(runId).filter(unit => current(unit) && ["failed", "interrupted", "running"].includes(unit.status) && !data.retryDeclined!.includes(unit.id));

  // Budget: a raise answers a pause; a decline leaves the run paused.
  const paused = state.units(runId).filter(unit => unit.status === "budget_paused");
  if (paused.length) {
    const run = state.getRun(runId)!;
    const action = answers.budget_action, amount = Number(answers.budget_amount), spent = state.spend(runId).totalUsd;
    if (action === "decline") {
      state.budgetEvent(runId, { kind: "decline", fromUsd: run.budgetUsd, spentUsd: spent });
      throw new NeedsInput([], "budget_paused", [`Budget not raised. The run stays paused at $${spent.toFixed(4)} of $${run.budgetUsd.toFixed(2)}; continue later with \`openmerit scout --resume ${runId}\`.`]);
    }
    if (action === "continue") {
      // After the eval asks for fewer output tokens, its requests may fit the same budget; one that does not pauses again.
      for (const unit of paused) state.setUnit(unit.id, { status: "pending" });
      state.event(runId, "budget", `Continued at the same budget of $${run.budgetUsd.toFixed(2)}; ${paused.length} paused eval run(s) try again.`);
    } else if ((action === "run" || action === "default") && Number.isFinite(amount) && amount > run.budgetUsd) {
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

  /** One eval run: replayed from SQLite when finished, otherwise run through the proxy and read back. */
  const runUnit = async (task: string, plan: PlannedEval, kind: UnitRow["role"], entry: ModelRef, repeat: number, items: readonly string[] | null): Promise<UnitResult> => {
    const id = unitId(runId, taskKey(data, task), kind, entry, repeat);
    const unit = state.ensureUnit({ id, runId, task, model: entry.model, endpoint: entry.endpoint, role: kind, repeat });
    const label = `${kind === "baseline" ? "current" : kind} ${entry.model}${kind === "screen" ? "" : ` ${repeat}/${repeats}`}`;
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
    // The expected items: the sample for a screen; the current model's first run's items otherwise.
    const expected = items ?? (kind === "baseline" && repeat === 1 ? null : Object.keys(firstBaseline(task)?.items ?? {}));
    ctx.log(`${label}${items ? ` (${items.length} items)` : ""}…`);
    state.setUnit(id, { status: "running", attempt: true });
    const pooled = allowedOn(endpoint, ctx.catalogue);
    // The baseline is the model already in production: it runs even when the candidate pool leaves it out.
    const allowed = kind === "baseline" ? (model: string) => (model.toLowerCase() === entry.endpointModel.toLowerCase() ? ctx.catalogue.models.find(item => item.id === entry.model) ?? null : pooled(model)) : pooled;
    const { token, tally } = proxy.open({ runId, unitId: id, endpointId: endpoint.id, baseUrl: endpoint.baseUrl, apiKey, model: entry.endpointModel, allowed });
    let outcome: EvalOutcome & Partial<GeneratedOutcome>;
    let judged: UnitTally | null = null;
    try {
      const run = (spec: EvalSpec, only: readonly string[] | null) => runEval(spec, { root: ctx.repo.root, model: entry.endpointModel, baseUrl: proxyUrl, token, items: only, env: ctx.env, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (!plan.generated) outcome = await run(plan, items);
      else {
        // A generated eval runs in-process. Its judge calls go through the proxy under a unit of their own, so they count in the budget but not in this model's cost.
        const judge = judgeRef(ctx, data), judgeEndpoint = configured.find(item => item.id === judge.endpoint);
        const judgeKey = judgeEndpoint ? resolveCredential(judgeEndpoint.apiKey, ctx.env) : null;
        if (!judgeEndpoint || !judgeKey) return fail(`Endpoint ${judge.endpoint} has no usable credential for the judge ${judge.model}; run \`openmerit setup\`.`);
        const judging = proxy.open({ runId, unitId: `${id}/judge`, endpointId: judgeEndpoint.id, baseUrl: judgeEndpoint.baseUrl, apiKey: judgeKey, model: judge.endpointModel, allowed: model => (model.toLowerCase() === judge.endpointModel.toLowerCase() ? ctx.catalogue.models.find(item => item.id === judge.model) ?? null : null) });
        judged = judging.tally;
        try {
          const ownIds = items?.filter(item => item.startsWith(REPO_ITEM)).map(item => item.slice(REPO_ITEM.length)) ?? null;
          const generatedIds = items?.filter(item => !item.startsWith(REPO_ITEM)) ?? null;
          const value = data.generated?.[task] ?? loadGeneratedEval(ctx.repo.root, plan.generated);
          outcome = generatedIds && !generatedIds.length ? { ok: true, exitCode: 0, durationMs: 0, items: [] }
            : await runGeneratedEval(value, { model: entry.endpointModel, baseUrl: proxyUrl, apiKey: token, items: generatedIds, judge: { model: judge.endpointModel, baseUrl: proxyUrl, apiKey: judging.token }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          // The repository's own eval, beside it: its items are prefixed so the two never collide.
          if (outcome.ok && plan.repoEval && (!ownIds || ownIds.length)) {
            const own = await run(plan.repoEval, ownIds);
            outcome = !own.ok ? own : !own.items ? { ...own, ok: false, error: "The repository's eval reported no per-item results." }
              : { ...outcome, durationMs: outcome.durationMs + own.durationMs, items: [...outcome.items ?? [], ...own.items.map(item => ({ id: `${REPO_ITEM}${item.id}`, pass: item.pass }))] };
          }
        } finally { proxy.close(judging.token); }
      }
    } finally { proxy.close(token); }
    if (tally.budgetHit || judged?.budgetHit) {
      const need = tally.refusedLargest ?? judged?.refusedLargest;
      state.setUnit(id, { status: "budget_paused", error: `Paused: the eval budget was reached${need ? `; a request needed about $${need.usd.toFixed(4)} for up to ${need.outputTokens} output tokens` : ""}.` });
      const run = state.getRun(runId)!, spend = state.spend(runId);
      state.budgetEvent(runId, { kind: "alert", fromUsd: run.budgetUsd, spentUsd: spend.totalUsd });
      state.event(runId, "budget", `Eval budget reached: $${spend.totalUsd.toFixed(4)} of $${run.budgetUsd.toFixed(2)}. Further paid eval requests are paused.`);
      throw new NeedsInput(budgetQuestions(ctx, runId), "budget_paused");
    }
    const refused = tally.poolViolations.length ? `; refused models outside the allowed pool: ${[...new Set(tally.poolViolations)].join(", ")}` : "";
    if (!outcome.ok) {
      // A candidate the endpoint rejects, or whose calls still fail after the proxy's retries, is skipped as untested.
      const rejected = tally.upstreamErrors.find(status => UNAVAILABLE_STATUSES.includes(status) || retryable(status));
      if (kind !== "baseline" && rejected) {
        const reason = rejected === 429 ? `${entry.endpoint} rate-limited ${entry.endpointModel} (HTTP 429)`
          : retryable(rejected) ? `${entry.endpoint} kept failing for ${entry.endpointModel} (HTTP ${rejected})` : `${entry.endpoint} rejected ${entry.endpointModel} (HTTP ${rejected})`;
        state.setUnit(id, { status: "unavailable", error: `${reason}${outcome.log ? `\n${outcome.log}` : ""}` });
        ctx.log(`  skipped: ${entry.endpoint} HTTP ${rejected}`);
        save();
        throw new CandidateUnavailable(reason);
      }
      const statuses = [...new Set(tally.upstreamErrors)];
      return fail(`${outcome.error ?? "eval failed"}${statuses.length ? ` (${entry.endpoint} answered HTTP ${statuses.join(", ")})` : ""}${refused}${outcome.log ? `\n${outcome.log}` : ""}`);
    }
    if (!outcome.items) return fail("The eval reported no per-item results: it must write {\"items\":[{\"id\",\"pass\"}]} to $OPENMERIT_RESULT.");
    const reported = new Map(outcome.items.map(item => [item.id, item.pass]));
    const ids = expected ?? [...reported.keys()];
    const absent = ids.filter(item => !reported.has(item));
    if (absent.length) return fail(`The eval reported no result for ${absent.length} requested item(s): ${absent.slice(0, 10).join(", ")}.`);
    const results: Record<string, boolean> = Object.fromEntries(ids.map(item => [item, reported.get(item)!]));
    const passes = Object.values(results).filter(Boolean).length, total = Object.keys(results).length;
    const result: UnitResult = { items: results, passes, total, source: "eval", requests: tally.requests, durationMs: outcome.durationMs, cutOff: tally.cutOff, ...(outcome.reasons && Object.keys(outcome.reasons).length ? { reasons: outcome.reasons } : {}), ...(outcome.checks && Object.keys(outcome.checks).length ? { checks: outcome.checks } : {}), ...(outcome.answers?.length ? { answers: outcome.answers } : {}) };
    // An eval that sends no request through the proxy did not use the model under test, and its spend was neither metered nor capped.
    if (!tally.requests) {
      const violations = [...new Set(tally.poolViolations)];
      const unmetered = violations.length
        ? `OpenMerit's proxy refused every model request the eval sent (${tally.poolViolations.length}, HTTP 403), because it asked for ${violations.join(", ")}, which ${violations.length === 1 ? "is" : "are"} not ${entry.endpointModel} or another model this repository allows on ${entry.endpoint}. Make the eval send the model in $OPENMERIT_MODEL as it is, so ${entry.endpointModel} is what it runs`
        : `the eval made no model requests through OpenMerit's proxy (OPENAI_BASE_URL), so ${entry.endpointModel} was not what it ran, and any spend was not metered or capped by the budget`;
      state.setUnit(id, kind === "baseline" ? { status: "done", result: result as unknown as Record<string, unknown> } : { status: "unavailable", error: unmetered });
      save();
      if (kind !== "baseline") throw new CandidateUnavailable(unmetered);
      throw new StopTask(`After one run of the current model: ${unmetered}. Make the eval send this task's model calls to OPENAI_BASE_URL with OPENAI_API_KEY, then run \`openmerit scout\` again.`);
    }
    state.setUnit(id, { status: "done", result: result as unknown as Record<string, unknown> });
    ctx.log(`  ${passes}/${total} · ${usd(state.spend(runId).totalUsd)} of $${state.getRun(runId)!.budgetUsd.toFixed(2)}`);
    save();
    return result;
  };
  const firstBaseline = (task: string) => taskUnits(ctx, runId, data, task).find(unit => unit.role === "baseline" && unit.repeat === 1 && unit.status === "done")?.result as unknown as UnitResult | undefined;

  const evaluateTask = async (task: string, plan: PlannedEval) => {
    // Once a person marked the current model's answer wrong, the accepted Eval is the bar: every model that can run the task is a candidate, whatever it costs.
    const criteria = data.loop?.[task]?.bar === "criteria" && plan.generated ? criteriaOf((data.generated?.[task] ?? loadGeneratedEval(ctx.repo.root, plan.generated)).bundle, plan.criteriaPassRate) : null;
    const candidates = criteria ? widePool(ctx, data, task) : data.pool![task] ?? [];
    const summary: SearchSummary = { status: "running", pool: candidates.length, unranked: data.unranked?.[task] ?? 0, sampleIds: [], pick: null, trials: [], skipped: [], finalists: [], challengers: [] };
    data.search![task] = summary;
    // openmerit/engine's evaluateTask runs the policy; each of its measure calls is one eval run, replayed from SQLite once done.
    const baselineRuns: UnitResult[] = [];
    const currentModel = ctx.catalogue.models.find(model => model.id === base.model);
    // The repository's eval is the connection that measures: each of its runs is one eval run, replayed from SQLite once done.
    const evals = evalCommand<PoolEntry>({
      command: plan.command,
      run: async (option, items, call) => {
        const entry: ModelRef = option ?? base;
        let result: UnitResult;
        try {
          // Screens run on the samples; the current model and finals on every item the eval runs.
          result = await runUnit(task, plan, call.role, entry, call.repeat, call.role === "screen" ? items : null);
        } catch (error) {
          if (call.role === "final" && error instanceof StopTask) return null; // A declined failed final is listed as unmeasured.
          throw error;
        }
        if (call.role === "baseline") baselineRuns.push(result);
        const id = unitId(runId, taskKey(data, task), call.role, entry, call.repeat);
        return { items: result.items, costUsd: unitCost(ctx, runId, state.units(runId).filter(unit => unit.id === id))?.cost ?? null, ...(result.checks ? { checks: result.checks } : {}) };
      },
      sample: (reliable, count) => {
        // Screens draw from items the current model passes in every run, so a 5/5 screen asks whether a candidate keeps up with it;
        // the next five retry a screen that missed one. The same items for the same eval (stableSample), so its runs search the same way.
        if (!data.samples![task]) {
          data.samples![task] = stableSample(reliable, count, item => `${task}\n${item}`);
          save();
        }
        summary.sampleIds = data.samples![task]!.slice(0, SAMPLE_SIZE);
        return data.samples![task]!;
      },
    });
    const evaluated = await runPolicy({
      // The customer's own eval alone decides with its own threshold; an eval OpenMerit generated has OpenMerit's floor.
      ladder: order(candidates), strength: item => item.eci, items: null, repeats, rules: { threshold: plan.generated ? null : plan.threshold ?? null },
      ...(plan.generated ? { kinds: itemKinds(data.generated?.[task] ?? loadGeneratedEval(ctx.repo.root, plan.generated)), criteria } : { floor: null }),
      baselinePrice: currentModel ? blendedPrice(currentModel) : null, ...evals.measure,
      on: {
        trial: trial => summary.trials.push({ stage: trial.stage, model: trial.option.model, eci: trial.option.eci, passes: Object.values(trial.measurement.items).filter(Boolean).length, total: Object.keys(trial.measurement.items).length, accepted: trial.accepted }),
        skipped: skipped => summary.skipped.push({ model: skipped.option.model, stage: skipped.stage, reason: skipped.reason }),
        searched: searched => {
          summary.pick = searched.selected?.model ?? null;
          if (searched.shortfall) summary.shortfall = searched.shortfall;
          summary.finalists = searched.finalists.map(item => item.model);
        },
        challenger: option => summary.challengers.push(option.model),
      },
    });
    if (evaluated.status === "below_floor") {
      // A person grades the current model's answers next: they say whether the eval or the model is wrong.
      summary.status = "below_floor";
      summary.floorNote = floorNote(evaluated.baseline, base.model);
      save();
      return;
    }
    if (evaluated.status === "too_few_reliable") {
      // A reasoning default on the endpoint can use up a small token limit before any answer: say so, since it is not the model's quality.
      const cutOff = baselineRuns.reduce((sum, run) => sum + (run.cutOff ?? 0), 0), requests = baselineRuns.reduce((sum, run) => sum + run.requests, 0);
      const why = cutOff ? ` ${cutOff} of its ${requests} answers stopped at the request's output token limit before any text, as when ${base.endpoint} has the model reason first; production may call it elsewhere, where it does not. Raise the eval's token limit, or add the endpoint your application calls with \`openmerit setup\`.` : " Add labelled items the current model gets right.";
      throw new StopTask(`The current model passes only ${evaluated.reliable.length} items in ${evaluated.baseline.runs.length === 1 ? "its first run" : `every one of its ${evaluated.baseline.runs.length} runs`}; Scout screens candidates on ${SAMPLE_SIZE} items it passes.${why}`);
    }
    if (evaluated.status === "no_passing_model") { summary.status = "no_passing_model"; save(); return; }
    summary.status = "selected";
    save();
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
  return "grade";
}


/** The grading loop for each generated eval: a person grades sampled answers, and the eval is accepted, written again or measured against its criteria. */
async function gradePhase({ ctx, runId, data, answers, getHarness, save }: PhaseInput): Promise<Phase> {
  const pending: Question[] = [];
  let again = false;
  for (const [task, plan] of plannedEvals(data)) {
    let loop = data.loop?.[task];
    if (!plan.generated || !loop || loop.status === "accepted" || data.stopped?.[task]) continue;
    if (loop.status === "searching") {
      loop = data.loop![task] = advanceLoop(loop, { type: "searched", artifact: { samples: samplesOf(ctx, runId, data, task) } });
      save();
    }
    if (loop.status === "grading") {
      const questions = gradeQuestions(task, loop);
      const grades = questions.map((question, index): SampleGrade | null => {
        const read = readGrade(answers[question.id]);
        return read && { sampleId: loop!.artifact!.samples[index]!.id, ...read };
      });
      if (grades.some(grade => !grade)) { pending.push(...questions.filter((_, index) => !grades[index])); continue; }
      loop = data.loop![task] = advanceLoop(loop, { type: "graded", grades: grades as SampleGrade[] });
      const latest = loop.history.at(-1)!;
      ctx.state.decision(runId, "grade", loop.status, { task, round: latest.round, evalVersion: latest.evalVersion, bar: loop.bar, grades: latest.grades });
      save();
    }
    if (loop.status === "regenerating") {
      if (loop.round >= MAX_ROUNDS) {
        data.stopped![task] = `After ${MAX_ROUNDS} rounds of grading, the eval still disagrees with your grades, so no model is recommended. Run \`openmerit scout\` again to start over.`;
        ctx.state.event(runId, "stopped", `${task}: ${data.stopped![task]}`);
        save();
        continue;
      }
      ctx.log(`Writing the ${task} eval again from your grades…`);
      const value = data.generated![task]!;
      data.generated![task] = await reviseEval(value, feedbackOf(loop.artifact!, loop.history.at(-1)!.grades), await getHarness(), ctx.signal);
      loop = data.loop![task] = advanceLoop(loop, { type: "regenerated" });
      ctx.state.event(runId, "grade", `${task}: OpenMerit wrote eval version ${loop.evalVersion} from the grades of round ${loop.round - 1}.`);
      save();
    }
    if (loop.savedVersion && loop.savedVersion !== data.savedEvals?.[task]) saveAccepted(ctx, runId, data, task, plan, loop);
    if (loop.status === "searching") {
      // The next round measures again from scratch: its units have keys of their own.
      delete data.search![task]; delete data.samples![task];
      again = true;
      save();
    }
  }
  if (pending.length) throw new NeedsInput(pending);
  return again ? "evaluate" : "compare";
}

/** The answers a person grades in a round: the current model's first run, and the pick's (else the best measured finalist's) first full run. */
function samplesOf(ctx: Context, runId: string, data: RunState, task: string) {
  const units = taskUnits(ctx, runId, data, task).filter(unit => unit.status === "done" && unit.repeat === 1);
  const answersOf = (unit: UnitRow | undefined) => ((unit?.result as unknown as UnitResult | undefined)?.answers ?? []);
  const current = units.find(unit => unit.role === "baseline");
  const finals = units.filter(unit => unit.role === "final");
  const score = (unit: UnitRow) => Number((unit.result as unknown as UnitResult).passes) / Math.max(1, Number((unit.result as unknown as UnitResult).total));
  const candidate = finals.find(unit => unit.model === data.search?.[task]?.pick) ?? [...finals].sort((a, b) => score(b) - score(a))[0];
  return pickSamples([
    ...(current ? [{ model: current.model, role: "current" as const, answers: answersOf(current) }] : []),
    ...(candidate ? [{ model: candidate.model, role: "candidate" as const, answers: answersOf(candidate) }] : []),
  ]);
}

/** Saves the Eval a person accepted, versioned, and makes it the task's eval in the repository config. */
function saveAccepted(ctx: Context, runId: string, data: RunState, task: string, plan: PlannedEval, loop: LoopState): void {
  saveGeneratedEval(ctx.repo.root, plan.generated!, data.generated![task]!, { version: loop.savedVersion, bar: loop.bar, acceptedAt: new Date().toISOString() });
  const evals = { ...repoConfig(ctx).evals };
  const { source: _source, helperFiles, explanation: _explanation, items: _items, ...spec } = plan;
  evals[task] = { ...spec, ...(helperFiles?.length ? { helpers: helperFiles.map(helper => helper.path) } : {}) };
  updateRepoConfig(ctx.repo.root, { evals });
  (data.savedEvals ??= {})[task] = loop.savedVersion;
  ctx.state.event(runId, "grade", `${task}: you accepted eval version ${loop.savedVersion}; it is saved in ${plan.generated}.`);
}

function modelQuestion(data: RunState): Question {
  const usages = usageById(data);
  return {
    id: "model", kind: "choice", prompt: "Which model should Scout review?",
    // Scout can only price and place catalogue models, so only those are offered.
    options: data.scan!.models.filter(item => item.catalogueId).map(item => {
      const uses = item.usageIds.map(id => usages.get(id)).filter((usage): usage is Usage => !!usage);
      const app = uses.filter(usage => !isSupportFile(usage.file)), support = uses.length - app.length;
      return {
        value: item.catalogueId!, label: item.value,
        detail: [app.map(usage => `${ref(usage)}${usage.dynamic ? ` (default of ${usage.envVar})` : ""}`).join(", "), support ? `${app.length ? "+" : "only "}${support} in tests, fixtures or docs` : ""].filter(Boolean).join(", "),
      };
    }),
  };
}

function tasksQuestion(data: RunState): Question {
  const usages = usageById(data);
  return {
    id: "tasks", kind: "multi", prompt: TASK_QUESTION, hint: "or <usage>=<task> to fix the mapping",
    options: tasksForModel(data).map(task => {
      const uses = task.usageIds.map(id => usages.get(id)).filter(reviewed(data));
      const refs = [...uses.slice(0, 2).map(usage => `${usage.id} ${basename(usage.file)}:${usage.line}`), ...(uses.length > 2 ? [`+${uses.length - 2} more`] : [])].join(", ");
      const runtime = uses.every(usage => modelKey(usage) !== data.model) ? `; its model is set at run time${uses[0]?.envVar ? ` by ${uses[0].envVar}` : ""}, so choose it if that is ${data.model}` : "";
      return { value: task.name, label: task.name, detail: `${task.description.split(/(?<=\.)\s/)[0]} (${refs}${runtime})` };
    }),
  };
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
    const own = plan.generated ? plan.repoEval : plan;
    const generated = plan.generated ? data.generated?.[name] ?? null : null;
    if (plan.generated) destinations.add(endpointLabel(judgeRef(ctx, data).endpoint));
    const kinds = generated ? Object.entries(generated.cases.reduce<Record<string, number>>((counts, item) => ({ ...counts, [caseKind(item)]: (counts[caseKind(item)] ?? 0) + 1 }), {})).map(([kind, count]) => `${count} ${kind}`).join(", ") : "";
    return [
      `${name}`,
      ...(plan.generated ? [
        `  Eval: written by OpenMerit from its review of the code${generated ? `, ${generated.cases.length} cases (${kinds})` : ""}, saved in ${plan.generated}/ once you accept it: after the run you grade sampled answers, and OpenMerit writes the eval again where you disagree`,
        ...(generated?.bundle.criteria?.length ? [`  Criteria: ${generated.bundle.criteria.join("; ")}`] : []),
        ...(generated?.bundle.guardrails?.length ? [`  Guardrails: ${generated.bundle.guardrails.join("; ")}`] : []),
        `  Judge: ${judgeRef(ctx, data).model}, for text answers and guardrails; its calls count in the budget, not in a model's cost per item`,
        `  Floor: no recommendation if ${data.model} passes under ${Math.round(EVAL_FLOOR * 100)}% of the eval`,
      ] : []),
      ...(own ? [
        `  ${plan.generated ? "Also the repository's eval, as extra evidence (items repo:…)" : "Command"}: ${own.command}${own.cwd ? ` (in ${own.cwd})` : ""}`,
        ...(own.env && Object.keys(own.env).length ? [`  Env: ${Object.entries(own.env).map(([key, value]) => `${key}=${value}`).join(" ")}`] : []),
        `  Results: $OPENMERIT_RESULT${own.threshold !== undefined && !plan.generated ? `; pass rate ≥ ${own.threshold}` : ""}`,
      ] : []),
      `  Candidates: ${candidates.length} cheaper than ${data.model}${candidates.length ? `, ECI ${candidates[0]!.eci.toFixed(1)}–${candidates.at(-1)!.eci.toFixed(1)}` : ""}${data.unranked?.[name] ? ` (${data.unranked[name]} without ECI left out)` : ""}`,
      `  Runs: at most ${runs.fullRuns} full and ${runs.screens} ${SAMPLE_SIZE}-item screens`,
      ...(plan.helperFiles ?? []).map(helper => `  New helper file ${helper.path} (${helper.purpose}):\n${helper.content.split("\n").map(line => `    + ${line}`).join("\n")}`),
    ].join("\n");
  });
  return {
    id: "approve_evals", kind: "confirm", default: false,
    prompt: "Run these evals? They make paid requests.",
    detail: `${sections.join("\n\n")}\n\nSent to: ${[...destinations].join(", ")}. Budget: $${run.budgetUsd.toFixed(2)}; requests past it are refused. Only model requests the eval sends to OPENAI_BASE_URL (OpenMerit's proxy) are metered and capped: a task whose eval sends none there stops after one run of the current model.`,
  };
}

function retryQuestion(ctx: Context, runId: string, stale: UnitRow[]): Question {
  return {
    id: "retry_units", kind: "confirm", default: false,
    // A run cut off by a stopped daemon or process is interrupted, not failed; say which it was.
    prompt: `${stale.length} eval run${stale.length === 1 ? "" : "s"} ${stale.every(unit => unit.status !== "failed") ? (stale.length === 1 ? "was interrupted" : "were interrupted") : stale.some(unit => unit.status !== "failed") ? "failed or were interrupted" : "failed"}. Run ${stale.length === 1 ? "it" : "them"} again?`,
    // The eval's last output lines say why it failed, such as a missing dependency.
    detail: stale.map(unit => `- ${unit.role} ${unit.model} ${unit.repeat}: ${(unit.error ?? unit.status).split("\n")[0]}, ${usd(ctx.state.spend(runId, unit.id).totalUsd)} spent${logTail(unit.error)}`).join("\n"),
  };
}

/** The eval output a failed unit's error keeps after its first line, indented, or "". */
export function logTail(error: string | null | undefined, lines = 8): string {
  const log = (error ?? "").split("\n").slice(1).filter(line => line.trim()).slice(-lines);
  return log.length ? `\n${log.map(line => `    | ${line.slice(0, 200)}`).join("\n")}` : "";
}

function budgetQuestions(ctx: Context, runId: string): Question[] {
  const run = ctx.state.getRun(runId)!;
  const spend = ctx.state.spend(runId);
  const why = ctx.state.units(runId).filter(unit => unit.status === "budget_paused").map(unit => unit.error ?? "").find(error => error.includes("output tokens"));
  return [
    { id: "budget_action", kind: "choice", prompt: `Budget of $${run.budgetUsd.toFixed(2)} reached. Raise it?`,
      // Scout reserves each request's most expensive outcome before sending it, so one request asking for the model's whole output limit can pause a run that has spent little.
      detail: `Used $${(spend.settledUsd + spend.inFlightUsd).toFixed(4)}${spend.estimatedUsd > 0 || spend.inFlight || spend.unknown ? " (partly estimated)" : ""}.${why ? ` ${why.replace(/^Paused: the eval budget was reached; a/, "A")} Scout reserves each request's cost at its max_tokens before sending it; if the eval asks for far more than it needs, as agent frameworks that send the model's limit do, lower it and choose "Keep the budget and continue".` : ""}`,
      options: [{ value: "run", label: "This run only" }, { value: "default", label: "This run and future runs" }, { value: "continue", label: "Keep the budget and continue (after lowering the eval's max tokens)" }, { value: "decline", label: "Keep paused" }] },
    { id: "budget_amount", kind: "text", prompt: "New budget (USD)", default: String(Math.max(run.budgetUsd * 2, run.budgetUsd + 5)) },
  ];
}

/** The eval's directory relative to the repository, so the saved config stays portable; null for the root. */
function evalCwd(root: string, cwd: string | undefined): string | null {
  if (!cwd || cwd === ".") return null;
  const path = relative(root, resolve(root, cwd));
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(`The harness proposed running the eval outside the repository (${cwd}); refusing it.`);
  return path || null;
}

const toEntry = (item: PoolModel): Omit<PoolEntry, "eci"> & { eci: number | null } => ({ key: item.model.id, model: item.model.id, endpoint: item.endpoint.id, endpointModel: item.endpointModel, eci: item.model.eci, eciSource: item.model.eciSource, price: blendedPrice(item.model) });

/**
 * Allowed-pool models a task could switch to: priced, cheaper than the current model, and able to do
 * what the task needs (tools, images, structured output). The binary search ranks them by ECI.
 */
export function eligibleCandidates(catalogue: Catalogue, configured: readonly Endpoint[], baseline: CatalogueModel | null, task: Pick<Task, "usesTools" | "needsVision" | "structuredOutput">): PoolModel[] {
  const needs = { tools: task.usesTools, vision: task.needsVision, structuredOutput: task.structuredOutput };
  return pool(configured, catalogue).filter(({ model }) => eligible(model, baseline, needs));
}

/** Measured eval cost of some units from the proxy ledger, or null when a request had no price. */

/** The candidates against the criteria: every eligible model whatever its price, but the current model, which runs as the baseline. */
function widePool(ctx: Context, data: RunState, task: string): PoolEntry[] {
  const found = data.tasks!.find(item => item.name === task)!;
  return ladder(eligibleCandidates(ctx.catalogue, endpoints(ctx), null, found).filter(item => item.model.id !== data.model).map(toEntry)).ranked;
}

/** A task's unit key: its slug, with the grading loop's round after the first, so each round measures afresh. */
const taskKey = (data: RunState, task: string) => { const round = data.loop?.[task]?.round ?? 1; return round > 1 ? `${slug(task)}~${round}` : slug(task); };
const unitId = (runId: string, key: string, kind: UnitRow["role"], entry: ModelRef, repeat: number) => `${runId}|${key}|${kind}|${entry.endpoint}|${entry.model}|r${repeat}`;
/** A task's units in its current round. */
const taskUnits = (ctx: Context, runId: string, data: RunState, task: string) => ctx.state.units(runId).filter(unit => unit.task === task && unit.id.startsWith(`${runId}|${taskKey(data, task)}|`));

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
    evidence: units.map(unit => unit.id),
  };
}

/** What a task's eval contributes to "Based on": the generated eval's cases and grader, and the repository's eval beside it. */
function evidenceOf(ctx: Context, data: RunState, name: string, plan: PlannedEval, baseline: ModelResult): EvidencePart[] {
  const items = baseline.runs ? baseline.total / baseline.runs : null;
  if (!plan.generated) return [chosenTask, evalEvidence({ command: redact(plan.command), items })];
  const value = data.generated?.[name] ?? loadGeneratedEval(ctx.repo.root, plan.generated);
  const own = items === null ? null : items - value.cases.length;
  return [chosenTask, caseEvidence(value.bundle, value.cases, { connector: "repo-review", detail: plan.generated }), ...(plan.repoEval ? [evalEvidence({ command: redact(plan.repoEval.command), items: own })] : [])];
}

function compareTask(ctx: Context, runId: string, data: RunState, name: string, plan: PlannedEval): TaskComparison {
  const units = taskUnits(ctx, runId, data, name);
  const repeats = data.repeats ?? DEFAULT_REPEATS;
  const base = baselineRef(ctx, data);
  const baseEci = ctx.catalogue.models.find(model => model.id === base.model)?.eci ?? null;
  const baseUnits = units.filter(unit => unit.role === "baseline");
  // A search that stopped on the baseline ran only the baseline runs it needed.
  const baseline = measure(ctx, runId, baseUnits, data.stopped?.[name] && !data.samples?.[name] ? baseUnits.length : repeats, "baseline", base, baseEci);
  const summary = data.search?.[name];
  const byModel = new Map((data.pool?.[name] ?? []).map(entry => [entry.model, entry]));
  const finals = [...(summary?.finalists ?? []), ...(summary?.challengers ?? [])].map(model => byModel.get(model)!).filter(Boolean);
  const candidates = finals.map(entry => measure(ctx, runId, units.filter(unit => unit.role === "final" && unit.model === entry.model), repeats, "candidate", entry, entry.eci));
  const comparison: TaskComparison = {
    task: name, eval: { command: redact(plan.command), source: plan.source, threshold: plan.threshold ?? null },
    baseline, candidates, top: [], status: "incomplete", note: "", ...(summary ? { search: summary } : {}),
    // Every case of a generated eval and of the repository's eval beside it ran, so every grader and case source is named.
    basedOn: (plan.generated ? basedOnAll : (evidence: TaskEvidence) => basedOn(strongest(evidence)))(mergeEvidence(name, base.model, evidenceOf(ctx, data, name, plan, baseline))),
  };
  if (baseline.status !== "measured") return { ...comparison, status: "baseline_failed", note: `The current model's eval did not complete (${baseline.note}), so no candidate can be compared. Fix the eval, then run \`openmerit scout\` again: it reuses the eval you approved.` };
  // A stopped search recommends nothing, but the finalists it measured keep their real comparison with the current model.
  if (data.stopped?.[name]) return { ...comparison, candidates: rank(comparison, false).candidates, status: "stopped", note: /no model is recommended/.test(data.stopped[name]) ? data.stopped[name] : `The search stopped, so no model is recommended: ${data.stopped[name]}` };
  const criteria = data.loop?.[name]?.bar === "criteria" && plan.generated ? criteriaOf((data.generated?.[name] ?? loadGeneratedEval(ctx.repo.root, plan.generated)).bundle, plan.criteriaPassRate) : null;
  if (criteria) return { ...comparison, ...rankCriteria(comparison, units, criteria) };
  if (summary?.status === "no_passing_model") return { ...comparison, status: "no_passing_model", note: `No candidate in the pool passed all ${SAMPLE_SIZE} screening items the current model passes.` };
  const measured = candidates.filter(item => item.status === "measured");
  // Finalists pass the screen by construction; a failed screen already shows the eval separates models.
  const screenFailed = summary?.trials.some(trial => !trial.accepted) ?? false;
  if (!screenFailed && measured.length && [baseline, ...measured].every(item => item.score === baseline.score)) {
    return { ...comparison, status: "non_discriminating", note: `The current model, every screened candidate and ${measured.length} finalist(s) all passed ${Math.round(baseline.score! * 100)}% of their item runs.` };
  }
  return { ...comparison, ...rank(comparison, false) };
}

/** Against the accepted Eval's checks: finalists that meet them qualify whatever they cost, cheapest first, and the note says what the current model misses. */
function rankCriteria(comparison: TaskComparison, units: readonly UnitRow[], criteria: Criteria): Pick<TaskComparison, "candidates" | "top" | "status" | "note" | "bar" | "failedChecks"> {
  const runsOf = (role: UnitRow["role"], model: string) => units.filter(unit => unit.role === role && unit.model === model && unit.status === "done").map(unit => {
    const result = unit.result as unknown as UnitResult;
    return { items: result.items, costUsd: null, ...(result.checks ? { checks: result.checks } : {}) };
  });
  const baseline = comparison.baseline!;
  const failedChecks = meetsCriteria(runsOf("baseline", baseline.model), criteria).failed;
  const candidates = comparison.candidates.map(item => {
    if (item.status !== "measured") return { ...item, qualified: false };
    const verdict = meetsCriteria(runsOf("final", item.model), criteria);
    return { ...item, qualified: verdict.meets, note: verdict.meets ? item.note : `misses your checks: ${verdict.failed.join(", ")}` };
  });
  const top = rankTop(candidates.filter(item => item.qualified), item => item.eci ?? 0);
  return { candidates, top, status: top.length ? "ranked" : "no_qualified", note: criteriaSummary(failedChecks, baseline, top[0] ?? null), bar: "criteria", failedChecks };
}

/** Qualifies finalists at least as good as the current model under the eval's own criteria, then ranks them cheapest first. */
function rank(comparison: TaskComparison, accepted: boolean): Pick<TaskComparison, "candidates" | "top" | "status" | "note"> {
  const baseline = comparison.baseline!;
  const threshold = comparison.eval.threshold;
  const candidates = comparison.candidates.map(item => {
    if (item.status !== "measured" || item.score === null) return { ...item, qualified: false };
    const missed = shortfall({ measured: true, score: item.score, latencyMs: item.meanLatencyMs }, baseline.score!, { threshold });
    return { ...item, qualified: missed === null, note: item.note || qualificationNote({ ...item, shortfall: missed }, baseline, { threshold }) };
  });
  const top = rankTop(candidates.filter(item => item.qualified), item => item.eci ?? 0);
  const failed = candidates.filter(item => item.status !== "measured").length;
  return {
    candidates, top, status: top.length ? "ranked" : "no_qualified",
    note: `${candidates.filter(item => item.qualified).length} of ${candidates.length} finalists performed at least as well as ${baseline.model}${top.length ? `; the ${top.length} cheapest are shown` : ""}${failed ? `; ${failed} could not be measured` : ""}.${accepted ? " Accepted by the user although the eval did not separate the models." : ""}${top.some(item => baseline.costPerItemUsd !== null && item.costPerItemUsd !== null && item.costPerItemUsd >= baseline.costPerItemUsd) ? " Some qualifying finalists cost no less than the current model on this workload." : ""}`,
  };
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
