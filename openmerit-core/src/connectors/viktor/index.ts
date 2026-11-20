// Viktor (viktor.com) as a connection: its scheduled tasks are the tasks, and its model presets are
// the ladder. Connecting takes an API key; the Source port lists the workspace's tasks with the
// credits each used in the last 30 days, and leaves those it cannot evaluate in the list with why.
//
// Measuring a task makes personal, paused copies of it, one per model and each titled
// "[OpenMerit]: <task title>", runs each copy `repeats` times in Viktor's test mode, which captures the
// task's Slack posts and other outside actions instead of sending them, then deletes the copies. One
// API thread runs all of it, since each thread costs credits of its own. A judge writes a checklist
// from the task's instructions and the current model's first test run, and grades every run on it;
// those checks are the items `evaluateTask` ranks the presets on, so every decision is the engine's.
//
// The Change port proposes "Set <task> to <preset>" with a link to Viktor. It writes nothing: the
// connection reads only, and applying a change through it is a later opt-in.
import { evaluateTask, type EvaluateResult, type Measurement } from "../../engine/evaluate.ts";
import { taskResult, type TaskResult } from "../../engine/result.ts";
import type { EditTarget, ProposedChange } from "../../engine/change.ts";
import type { ChangePort, Connector, ListedTask } from "../../engine/connector.ts";
import type { EvidencePart } from "../../engine/evidence.ts";
import { CandidateUnavailable, SAMPLE_SIZE, type Rung } from "../../engine/search.ts";
import { readJson } from "../../ranking/graders.ts";
import type { Complete } from "../../ranking/cases.ts";
import { COPY_PATH, COPY_TITLE, COPY_TITLES, WORK_DIR } from "./scripts.ts";

export { BATCH, CLEANUP, CREDITS, DESCRIBE, LIST, PAGE, PUT, READ, COPY_PATH, COPY_TITLE, COPY_TITLES, WORK_DIR } from "./scripts.ts";
export { keyProblem, REQUIRED_SCOPES, VIKTOR_API, ViktorError, viktorClient, withArgs, toFile, STDOUT_LIMIT, PAGE_BYTES, draftedTools, viktorErrorSentence, PENDING, type ViktorClient, type ViktorKey } from "./api.ts";

/** Viktor's presets, weakest first: the strength `evaluateTask` ranks them by. Pinned models are not compared. */
export const PRESETS = ["cheap", "balanced", "balanced-writing", "smart", "smart-writing", "ultra"] as const;
export type Preset = (typeof PRESETS)[number];
export const isPreset = (value: string | null | undefined): value is Preset => typeof value === "string" && (PRESETS as readonly string[]).includes(value);
/** The presets for writing that people outside the organization read. */
export const WRITING_PRESETS: ReadonlySet<Preset> = new Set(["balanced-writing", "smart-writing"]);

/**
 * The presets each preset is compared against, weakest first. A writing task is compared against the
 * plain presets too, and the judge decides whether they write well enough. Only the presets cheaper
 * per test run than the current one are tried (`cheaperPresets`).
 */
export const LADDERS: Readonly<Record<Preset, readonly Preset[]>> = {
  cheap: [], balanced: ["cheap"], "balanced-writing": ["cheap", "balanced"], smart: ["cheap", "balanced"], "smart-writing": ["cheap", "balanced", "balanced-writing"], ultra: ["cheap", "balanced", "smart"],
};

/** Viktor's own tasks, which a workspace cannot edit: listed, never evaluated. */
export const SYSTEM_TASKS: ReadonlySet<string> = new Set(["/heartbeat", "/memory_dreaming", "/skill_refining", "/workflow_discovery"]);

/** What a credit costs: $2.50 per 1,000. */
export const CREDIT_USD = 0.0025;
export const DEFAULT_CREDIT_CAP = 2000;
export const SCHEDULED_TASKS_URL = "https://app.viktor.com/scheduled-tasks";
/**
 * Credits for one test run on each preset, to estimate a job before it starts and to choose which
 * presets are cheaper: cheap and smart as measured on 19 Nov 2026 (about 4 and 70); balanced (25 and
 * 12), balanced-writing (29 and 20) and smart-writing (89 and 72) as measured on a writing task on
 * 20 Nov 2026; ultra is a rough guess until measured. The job charges what each run reports, not these.
 */
export const RUN_CREDITS: Readonly<Record<Preset, number>> = { cheap: 4, balanced: 19, "balanced-writing": 25, smart: 70, "smart-writing": 81, ultra: 250 };
/** The API thread that starts the test runs. */
export const THREAD_CREDITS = 90;
/** Test runs at once in one batch. */
export const PARALLEL = 3;
export const TEST_TIMEOUT_MINUTES = 15;

export interface ViktorTask {
  /** Viktor's cron ID. */
  id: string;
  path: string;
  title: string;
  /** null: the workspace's default model. */
  model: string | null;
  /** The workspace's default model when the task was listed, which a task without a model runs; null when unknown. */
  defaultModel: string | null;
  /** Whether a condition script decides if a scheduled run happens. Test mode ignores it. */
  conditionScript: boolean;
  executionType: string;
  cron: string;
  timezone: string | null;
  paused: boolean;
  lastRunOutcome: string | null;
  /**
   * The task's instructions. A listing has the first 240 characters (list_crons' preview); an
   * evaluation reads the full text with DESCRIBE before the judge uses it. Empty for a script task.
   */
  description: string;
  credits30d: number;
  runs30d: number;
  /** Why it is listed but not evaluated; null when it can be. */
  skipped: string | null;
}

/** Whether a task is one of OpenMerit's temporary copies: under COPY_PATH, titled with the copy prefix or the one before it. */
export const isCopy = (task: Pick<ViktorTask, "path" | "title">) => task.path.startsWith(COPY_PATH) && COPY_TITLES.some(prefix => task.title.startsWith(prefix));

/** The model a task runs on: its own, or the workspace's default when it has none. */
export const runsOn = (task: Pick<ViktorTask, "model"> & { defaultModel?: string | null }): string | null => task.model ?? task.defaultModel ?? null;
/** The model as the table shows it, such as "smart" or "Team default (smart)". */
export const modelLabel = (task: Pick<ViktorTask, "model"> & { defaultModel?: string | null }): string => task.model ?? (task.defaultModel ? `Team default (${task.defaultModel})` : "Team default");

/** Why a task is listed but not evaluated, or null. */
export function skipReason(task: Pick<ViktorTask, "path" | "title" | "model" | "executionType"> & { defaultModel?: string | null; scriptPath?: string | null; preRunScriptPath?: string | null }): string | null {
  if (SYSTEM_TASKS.has(task.path)) return "Viktor's own task: it cannot be edited";
  if (isCopy(task)) return "OpenMerit's temporary copy";
  if (task.executionType !== "agent") return "script task, no model";
  // A condition script only decides whether a run happens; a pre-run script's output becomes the agent's context.
  if (task.preRunScriptPath) return "runs a pre-run script whose output the agent reads, which test mode does not capture";
  const model = runsOn(task);
  if (model === null) return "uses the workspace's default model, which OpenMerit could not read";
  if (!isPreset(model)) return task.model === null ? `uses the workspace's default model, ${model}, which is not one of Viktor's presets` : `uses ${model}; only Viktor's presets (${PRESETS.join(", ")}) are compared for now`;
  if (!cheaperPresets(model).length) return `already on ${model}, the cheapest preset`;
  return null;
}

/** LIST's output: every task with its skip reason and spend, highest credits first, and OpenMerit's leftover copies. */
export function readTasks(stdout: string): { tasks: ViktorTask[]; leftovers: string[] } {
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { tasks?: Record<string, unknown>[]; usage?: { credits?: unknown; path?: unknown }[]; defaultModel?: unknown };
  const usage = parsed.usage ?? [];
  const defaultModel = typeof parsed.defaultModel === "string" && parsed.defaultModel ? parsed.defaultModel : null;
  const all = (parsed.tasks ?? []).filter(row => row.deleted !== true).map((row): ViktorTask & { copy: boolean } => {
    const path = String(row.path), title = String(row.title ?? path);
    const runs = usage.filter(item => typeof item.path === "string" && item.path.startsWith(`/agent_runs/crons${path}/`));
    const base = { path, title, model: (row.model as string | null) || null, defaultModel, executionType: String(row.execution_type ?? "agent") };
    return {
      ...base, id: String(row.id), cron: String(row.cron ?? ""), timezone: (row.timezone as string | null) ?? null, paused: row.paused === true, lastRunOutcome: (row.last_run_outcome as string | null) ?? null,
      description: String(row.description ?? ""), credits30d: runs.reduce((sum, item) => sum + (Number(item.credits) || 0), 0), runs30d: runs.length, conditionScript: !!row.condition_script_path,
      skipped: skipReason({ ...base, scriptPath: row.script_path as string | null, preRunScriptPath: row.pre_run_script_path as string | null }),
      copy: isCopy(base),
    };
  });
  return {
    tasks: all.filter(task => !task.copy).map(({ copy: _copy, ...task }) => task).sort((a, b) => b.credits30d - a.credits30d || a.title.localeCompare(b.title)),
    leftovers: all.filter(task => task.copy).map(task => task.path),
  };
}

/** The presets a task on `current` is evaluated on, weakest first: its ladder, cheaper per test run than `current`. */
export const cheaperPresets = (current: Preset): Preset[] => LADDERS[current].filter(preset => RUN_CREDITS[preset] < RUN_CREDITS[current]);

/** The preset a task runs on, or null when it does not run on one. */
export function currentPreset(task: Pick<ViktorTask, "model"> & { defaultModel?: string | null }): Preset | null {
  const model = runsOn(task);
  return isPreset(model) ? model : null;
}

/** What a task's evaluation should cost in credits: every model's runs, at the task's own credits per run for the current model when known. */
export function estimateCredits(task: Pick<ViktorTask, "model" | "credits30d" | "runs30d"> & { defaultModel?: string | null }, repeats: number): number {
  const preset = currentPreset(task);
  if (!preset) return 0;
  const current = task.runs30d ? task.credits30d / task.runs30d : RUN_CREDITS[preset];
  const scale = current / RUN_CREDITS[preset];
  const perRun = [preset, ...cheaperPresets(preset)].reduce((sum, item) => sum + RUN_CREDITS[item] * scale, 0);
  return Math.ceil(THREAD_CREDITS + repeats * perRun);
}

/** A slug for paths: lowercase letters, digits and dashes. */
export const pathSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";

export interface BatchSpec {
  source: string; models: Preset[]; repeats: number; parallel: number; timeoutMinutes: number; copyPath: string; copyTitle: string; out: string;
  /** The current model's copy keeps its model unset, as the task has none, so it runs what the task runs. */
  inherit: boolean;
}

/** The batch a job runs: the current model first, then each cheaper preset, in copies under the job's own path. */
export function batchSpec(jobId: string, task: Pick<ViktorTask, "path" | "title" | "model"> & { defaultModel?: string | null }, repeats: number): { directory: string; spec: BatchSpec } {
  const preset = currentPreset(task);
  if (!preset) throw new Error(`${task.title} does not use a preset`);
  const directory = `${WORK_DIR}/${jobId}`;
  return {
    directory,
    spec: {
      source: task.path, models: [preset, ...cheaperPresets(preset).reverse()], repeats, parallel: PARALLEL, timeoutMinutes: TEST_TIMEOUT_MINUTES,
      copyPath: copyPrefix(jobId, task), copyTitle: `${COPY_TITLE}${task.title}`.slice(0, 200), out: `${directory}/result.json`, inherit: task.model === null,
    },
  };
}
/** Where a job's copies are: one per model, the model's name appended. CLEANUP deletes by this prefix. */
export const copyPrefix = (jobId: string, task: Pick<ViktorTask, "title">) => `${COPY_PATH}${pathSlug(task.title)}-${jobId.slice(-8).toLowerCase()}-`;

/** What the API thread's agent is asked to do: run the saved batch once, change nothing, post nothing. */
export const batchMessage = (directory: string) =>
  `OpenMerit is measuring a scheduled task's model, as the workspace owner approved when connecting. Run this command once in the sandbox and wait for it to finish: \`uv run python ${directory}/batch.py ${directory}/spec.json\`. Do not change the script, do not run anything else, and do not post anywhere. When it exits, reply with only the word DONE.`;

export interface BatchRun {
  model: string;
  repeat: number;
  /** `success` when the test run finished. */
  status: string;
  error: string | null;
  report: string | null;
  /** The model the test ran on, as Viktor reports it. */
  runModel: string | null;
  /** The test run's thread, whose credits the usage list reports. */
  threadId: string | null;
  actions: { summary?: string; channel_id?: string | null; text?: string | null }[];
  seconds: number;
}
export interface Batch { status: "missing" | "running" | "done" | "failed"; runs: BatchRun[]; copies: string[]; error?: string; cleanupErrors?: string[] }

export function readBatch(stdout: string): Batch {
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Partial<Batch>;
  return { status: parsed.status ?? "missing", runs: parsed.runs ?? [], copies: parsed.copies ?? [], ...(parsed.error ? { error: parsed.error } : {}), ...(parsed.cleanupErrors ? { cleanupErrors: parsed.cleanupErrors } : {}) };
}

/** A test run as the judge reads it: the run's report, then each outside action test mode captured instead of sending. */
export function runText(run: BatchRun): string {
  const actions = run.actions.map(action => `Captured instead of sent: ${action.summary ?? "an action"}${action.channel_id ? ` (channel ${action.channel_id})` : ""}${action.text ? `\n${action.text}` : ""}`);
  return [run.report ?? "", ...actions].filter(Boolean).join("\n\n").slice(0, 20_000);
}

export interface Check { id: string; check: string }

const CHECKS_SYSTEM = [
  "You write the checklist a test run of a scheduled AI task must pass.",
  "Each check is one concrete, observable requirement from the task's instructions, which a grader can decide from the run's report and the outside actions it would have taken, such as a Slack message.",
  "Cover what the task must produce and the format of anything it posts. Where the instructions leave a choice open, do not require the reference run's choice.",
  "Write between 5 and 10 checks. Reply with JSON only: {\"checks\": [\"…\", \"…\"]}.",
].join("\n");
/** Added for a task on a writing preset, so the judge can catch a plain preset that writes worse. */
export const WRITING_CHECKS = [
  "The task runs on a writing preset: what it writes is read by people outside the organization.",
  "Add a check for each thing the instructions say about the audience, the tone, the voice and the format of that writing, one requirement each.",
  "Check only what the instructions state: do not invent a brand voice, a style or a length they do not give.",
].join("\n");

/** The checklist, from the task's instructions and the current model's first test run as a reference; with writing checks for a task on a writing preset. */
export async function writeChecks(complete: Complete, task: Pick<ViktorTask, "title" | "description"> & { model?: string | null; defaultModel?: string | null }, reference: BatchRun): Promise<Check[]> {
  const preset = currentPreset({ model: task.model ?? null, defaultModel: task.defaultModel ?? null });
  const system = preset && WRITING_PRESETS.has(preset) ? `${CHECKS_SYSTEM}\n${WRITING_CHECKS}` : CHECKS_SYSTEM;
  const text = await complete({ system, prompt: `Task: ${task.title}\n\nInstructions:\n${task.description}\n\nA test run of the task on its current model, for reference:\n${runText(reference)}` });
  const parsed = readJson(text);
  const checks = parsed.ok && parsed.value && typeof parsed.value === "object" ? (parsed.value as { checks?: unknown }).checks : null;
  const list = Array.isArray(checks) ? checks.map(item => (typeof item === "string" ? item : item && typeof item === "object" ? String((item as { check?: unknown }).check ?? "") : "")).map(item => item.trim()).filter(Boolean).slice(0, 10) : [];
  if (list.length < 3) throw new Error(`The judge wrote ${list.length} checks for ${task.title}; it needs at least 3.`);
  return list.map((check, index) => ({ id: `check-${index + 1}`, check }));
}

/** Grades one run on every check: pass or fail by check ID. */
export type GradeChecks = (checks: readonly Check[], run: BatchRun) => Promise<Record<string, boolean>>;

const GRADE_SYSTEM = [
  "You grade one test run of a scheduled AI task against a checklist.",
  "The run's report and the outside actions test mode captured instead of sending are all there is: judge each check from them only, strictly.",
  "A reference run on the task's current model shows one acceptable result; where the instructions leave a choice open, a different choice still passes.",
  "Reply with JSON only: {\"<check id>\": true or false, …} with every check ID.",
].join("\n");

/** The judge's grading of a run, in one call: the checks, the instructions, the reference run and the run. Throws when it leaves a check ungraded. */
export function judgeChecks(complete: Complete, task: Pick<ViktorTask, "title" | "description">, reference: BatchRun): GradeChecks {
  return async (checks, run) => {
    const text = await complete({ system: GRADE_SYSTEM, prompt: [
      `Task: ${task.title}`, `Instructions:\n${task.description}`, `Checklist:\n${checks.map(check => `${check.id}: ${check.check}`).join("\n")}`,
      `Reference run, on the current model:\n${runText(reference)}`, `Run to grade:\n${runText(run)}`,
    ].join("\n\n") });
    const parsed = readJson(text);
    const verdicts = parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : {};
    const missing = checks.filter(check => typeof verdicts[check.id] !== "boolean");
    if (missing.length) throw new Error(`The judge left ${missing.map(check => check.id).join(", ")} ungraded for ${run.model} run ${run.repeat}.`);
    return Object.fromEntries(checks.map(check => [check.id, verdicts[check.id] === true]));
  };
}

/** A run's measurement: pass or fail per check. A run that did not finish fails every check, ungraded. */
export async function gradeRun(run: BatchRun, checks: readonly Check[], grade: GradeChecks, credits: number | null): Promise<Measurement> {
  const finished = run.status === "success" && !!run.report;
  const verdicts = finished ? await grade(checks, run) : {};
  return { items: Object.fromEntries(checks.map(check => [check.id, verdicts[check.id] === true])), costUsd: credits === null ? null : credits * CREDIT_USD, latencyMs: Math.round(run.seconds * 1000) };
}

export interface PresetOption extends Rung { key: Preset; model: Preset }
const option = (preset: Preset): PresetOption => ({ key: preset, model: preset, price: RUN_CREDITS[preset] });

/**
 * The Measure port over a finished batch: the current model's run `repeat`, a screen on a candidate's
 * first run, or its run `repeat`. A candidate whose runs all failed is unavailable.
 */
export function batchMeasure(graded: ReadonlyMap<string, readonly Measurement[]>, runs: readonly BatchRun[], current: Preset) {
  return async (candidate: PresetOption | null, items: readonly string[] | null, call: { repeat: number }): Promise<Measurement | null> => {
    const model = candidate?.model ?? current;
    const measured = graded.get(model) ?? [];
    if (candidate && runs.filter(run => run.model === model).every(run => run.status !== "success")) {
      throw new CandidateUnavailable(`every test run on ${model} failed: ${runs.find(run => run.model === model)?.error ?? "no run"}`);
    }
    const run = measured[call.repeat - 1];
    if (!run) return null;
    return items ? { ...run, items: Object.fromEntries(items.map(id => [id, run.items[id] === true])) } : run;
  };
}

/** The current model's describe for results: a Viktor preset on the `viktor` endpoint. */
const describe = (preset: string) => ({ model: preset, endpoint: "viktor", endpointModel: preset, eci: null });

/**
 * The evaluation: `evaluateTask` over the cheaper presets, on the checks, with the batch's runs. The
 * screens reuse each candidate's first run, so the batch's runs are all there is to measure.
 */
export async function evaluateViktor(input: {
  task: Pick<ViktorTask, "model"> & { defaultModel?: string | null }; checks: readonly Check[]; graded: ReadonlyMap<string, readonly Measurement[]>; runs: readonly BatchRun[]; repeats: number;
  sample: (reliable: readonly string[], count: number) => readonly string[] | Promise<readonly string[]>;
}): Promise<{ evaluated: EvaluateResult<PresetOption>; result: TaskResult }> {
  const current = currentPreset(input.task);
  if (!current) throw new Error("The task does not use a preset.");
  const evaluated = await evaluateTask<PresetOption>({
    ladder: cheaperPresets(current).map(option), strength: item => PRESETS.indexOf(item.key), items: input.checks.map(check => check.id), repeats: input.repeats,
    baselinePrice: RUN_CREDITS[current], sampleSize: Math.min(SAMPLE_SIZE, input.checks.length),
    measure: batchMeasure(input.graded, input.runs, current), sample: input.sample,
  });
  return { evaluated, result: taskResult(evaluated, item => describe(item.model), describe(current)) };
}

/** The change that applies a pick: set the task's model in Viktor, by hand for now. A task on the workspace's default says which it is, as "Team default (smart)". */
export function proposeChange(task: Pick<ViktorTask, "title"> & { model?: string | null; defaultModel?: string | null }, target: Pick<EditTarget, "model">): ProposedChange & { change: string; link: string } {
  const change = task.model === null && task.defaultModel ? `Set ${task.title} from ${modelLabel({ model: null, defaultModel: task.defaultModel })} to ${target.model}` : `Set ${task.title} to ${target.model}`;
  return { edits: [], instructions: `${change} in Viktor's scheduled tasks (${SCHEDULED_TASKS_URL}): open the task and change its model to ${target.model}. OpenMerit does not change it.`, change, link: SCHEDULED_TASKS_URL };
}

const SOURCE = (task: Pick<ViktorTask, "path">) => ({ connector: "viktor", detail: task.path });

/** The connection over one listing of the workspace's tasks. */
export function viktor(input: { tasks: readonly ViktorTask[] }): Omit<Connector, "list" | "evidence" | "change"> & { list: () => ListedTask[]; evidence: (taskId: string) => EvidencePart; change: ChangePort } {
  const find = (id: string) => input.tasks.find(task => task.id === id || task.title === id);
  return {
    id: "viktor", capabilities: ["list", "evidence", "measure", "change"], writes: false,
    list: () => input.tasks.map(task => ({ name: task.title, currentModel: runsOn(task), ...(task.skipped ? { skipped: task.skipped } : {}) })),
    evidence: taskId => {
      const task = find(taskId);
      if (!task) return {};
      return {
        graders: [{ value: { kind: "judge", description: "a judge grading each test run on a checklist from the task's instructions, against the current model's runs" }, source: SOURCE(task) }],
        cases: [{ value: { kind: "real", count: 1, description: "the task itself, run in Viktor's test mode" }, source: SOURCE(task) }],
        priority: task.credits30d ? [{ value: { kind: "spend", usdPerMonth: task.credits30d * CREDIT_USD }, source: { connector: "viktor", detail: `${task.credits30d} credits in the last 30 days` } }] : [{ value: { kind: "request" }, source: SOURCE(task) }],
      };
    },
    change: { propose: (taskId, target) => proposeChange(find(taskId) ?? { title: taskId }, target) },
  };
}
