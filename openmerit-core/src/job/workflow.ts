// The task job: one task's measurement as a Rivet workflow, the same in every host.
//
//   Source ▶ Cases (label check: wait for answers) ▶ Eval ▶ Models ▶ Trial ⇄ grading loop ▶ Ranking ▶ Agent eval ▶ Action
//
// Every step is recorded, so a crash or a deploy resumes at the first unfinished step, and a job that
// waits on a question sleeps on its queue until the answers arrive. Each measure call is its own step.
// Rivet runs a step again when its result was not recorded, so model calls are not exactly-once, but
// each one reserves and settles under a key made of the job, the step, the candidate and the case
// (openmerit/ranking's `createMeasure` keys): a replayed step finds its keys in the host's ledger and
// counts no spend twice.
//
// A host runs it with `runTaskJob(ctx, host)` from its workflow actor: the cloud's job actor, with its
// account, task and catalogue actors behind `JobHost`. Endpoint keys reach the job from the host and
// stay in this process's memory; they are never in step results or workflow state, which are on disk.
//
// This module imports nothing from @rivet-dev/workflows but `Loop`, whose results are plain objects: a
// host and openmerit-core may load different copies of the package, so the workflow context is typed
// structurally and step failures are told apart by their names.
import { createHash } from "node:crypto";
import { Loop } from "@rivet-dev/workflows";
import { applyLabelCheck, BudgetRefused, caseKind, checksBasedOn, completeWith, createClient, createMeasure, flow, graderFor, needsJudge, invalidCases, labelCheck, LABEL_CHECK_QUESTION, writeCases, WRITTEN_CASES, type Case, type Complete, type EndpointConfig, type MeasureResult, type TaskBundle } from "../ranking/index.ts";
import { approvalQuestion, basedOn, baselineResult, byKind, CandidateUnavailable, trialOption, catalogueIndex, CHALLENGERS, checkAgent, DEFAULT_REPEATS, EndChallengers, evaluateTask, stableSample, ungradableNotice, FINALISTS, floorNote, mergeEvidence, modelResult, newProgress, redact, SAMPLE_SIZE, score, SMALL_EVAL, strongest, taskResult, type AgentRun, type Catalogue, type CatalogueModel, type Funding, type Ledger, type ModelResult, type ReserveResult, type ResolvedGuardrails, type Settlement, settledUsd } from "../engine/index.ts";
import { agentBundle, caseEvidence } from "../connectors/agent-bundle.ts";
import { evalEvidence } from "../connectors/eval-command.ts";
import { EvalProxy, retryable } from "../eval/proxy.ts";
import { runEval } from "../eval/runner.ts";
import type { Harness } from "../harness/harness.ts";
import { advanceLoop, completeHarness, criteriaOf, disputedCases, feedbackOf, gradeQuestions, MAX_ROUNDS, pickSamples, readGrade, reviseEval, startLoop, type CaseAnswer, type LoopState, type Sample, type SampleGrade } from "../eval/loop.ts";
import { buildPool, OPENROUTER, regionNotice, type EndpointInfo, type Option, type Pool, type Provisional } from "./pool.ts";
import { paybackCalls, proposeEdit, renderMarkdown, type AgentEvalSummary, type Fix, type JobResult, type MeasuredModel } from "./report.ts";

/** The words a refusal for the job's own budget contains, which the fix for it looks for. */
export const JOB_BUDGET = "budget for this job";

/**
 * The part of a task's spec its eval owns, which the app edits: what the judge checks each case on.
 * A job runs the bundle the coding agent sent with these fields replaced by the eval's.
 */
export type EvalSpec = Pick<TaskBundle, "description" | "input" | "steps" | "criteria" | "guardrails">;
/**
 * Who wrote the accepted eval: OpenMerit's case writer, a member's subscription or the coding agent's examples alone (each by a first run),
 * a person in the app, or a person grading a run's answers, after OpenMerit wrote it again from any grades that disagreed.
 */
export type EvalSource = "openmerit" | "chatgpt" | "harness" | "examples" | "app" | "grading";
/** What a model must meet: the current model's score, or the eval's checks once a person marked the current model's own answers wrong. */
export type EvalBar = "current" | "criteria";
/** Answers of the pick a person who just accepted the eval checks before it is recommended. */
const SPOT_CHECK = 4;
/** An answer a person graded when they accepted an eval: its case, the model, what it answered, and their verdict. */
export interface EvalGrade { caseId: string; model: string; output: string; toolCalls: { name: string; arguments: string }[]; verdict: "good" | "bad"; note?: string }
export const specOf = (bundle: TaskBundle): EvalSpec => Object.fromEntries((["description", "input", "steps", "criteria", "guardrails"] as const).filter(key => bundle[key] !== undefined).map(key => [key, bundle[key]])) as EvalSpec;

/** The project of tasks and jobs recorded before projects, and of a coding agent's call that names none. */
export const DEFAULT_PROJECT = "default";
/** A task's ID: one per project, environment and task name, the same whichever job or host sees it. The default project's leave the project out, as before projects. */
export const taskIdFor = (projectId: string, environment: string, task: string) =>
  `t_${createHash("sha256").update(projectId === DEFAULT_PROJECT ? `${environment}\0${task}` : `${projectId}\0${environment}\0${task}`).digest("hex").slice(0, 16)}`;

/** Redacts every string in a bundle (or any JSON value): secrets the coding agent pasted never reach a model or the disk. */
export function redactBundle<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactBundle(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactBundle(item)])) as T;
  return value;
}

/** The `questions` and `answers` shape openmerit_scout uses. */
export type Answer = string | string[] | boolean | number;
export type Answers = Record<string, Answer>;
export interface Question {
  id: string;
  kind: "choice" | "multi" | "confirm" | "text";
  prompt: string;
  detail?: string;
  options?: { value: string; label: string; detail?: string }[];
  default?: Answer;
  hint?: string;
}

/** Where a job was started: app.openmerit.ai, an MCP tool call, or a task's watch. */
export type JobTrigger = "app" | "mcp" | "watch";

export interface JobInput {
  accountId: string;
  /** The task's project; absent on jobs started before projects, which are in the default project. */
  projectId?: string;
  taskId: string;
  environment: string;
  agent: string | null;
  bundle: TaskBundle;
  kind: "run" | "watch";
  /** Absent on jobs started before it was recorded: those are watch jobs or MCP runs, by kind. */
  trigger?: JobTrigger;
  /** The Clerk user who started the job; null for a watch job, and absent on jobs started before it was recorded. */
  userId?: string | null;
  provisional: Provisional;
  createdAt: string;
}

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "stopped";

export interface JobState {
  input: JobInput;
  status: JobStatus;
  /** `grading`: a person grades the round's sampled answers (the grading loop). */
  phase: "source" | "cases" | "label_check" | "models" | "ranking" | "grading" | "agent_eval" | "action" | "done";
  questions: Question[];
  notices: string[];
  /** Fixes for notices recorded in steps; the result adds those of its last stages. Absent from jobs started before them. */
  fixes?: Fix[];
  progress: { measured: number; planned: number | null };
  /** The measure step running now, case by case, for the app's live view; null between steps and once the job ends. Absent from jobs started before it. */
  live?: LiveProgress | null;
  /** When the first measure step started, to estimate the time left. */
  measuringSince?: string | null;
  result: JobResult | null;
  error: string | null;
  updatedAt: string;
}

export interface JobView extends Omit<JobState, "input"> { jobId: string; taskId: string; task: string; provisional: Provisional; createdAt: string }

/** The candidate a measure step runs, its pass rate after each case so far, and the current model's pass rate on the same cases. */
export interface LiveProgress {
  model: string;
  endpoint: string;
  /** The current model and its pass rate, 0 to 100, over its runs so far; null while it is the one measured. */
  baseline: { model: string; rate: number } | null;
  done: number;
  total: number;
  passes: number;
  /** Pass rate so far, 0 to 100, after each case; time is Unix seconds. */
  history: { time: number; rate: number }[];
  minutesLeft: number | null;
}

/** The answers queue's message. `by` is the user who sent the answers, when the sender knows it: a grade's author. */
/**
 * A task's own eval command, which a self-hosted server runs on its machine to measure each model (README
 * "Eval contract"): the customer's eval decides pass or fail per item, with its own threshold. root is the
 * repository's absolute path, and cwd is relative to it.
 */
export interface EvalCommandSpec { command: string; root: string; cwd?: string; env?: Record<string, string>; threshold?: number | null; timeoutMs?: number }

/** The server's own settings and secrets, which an eval command does not get. Its other environment passes through, as in Scout. */
const SERVER_ENV = /^(OPENMERIT_|RIVET|CLERK_|STRIPE_|POSTHOG_|OPENROUTER_|OPENAI_|ANTHROPIC_)/;

export interface AnswersMessage { answers: Answers; by?: string | null }

/** The step context the job uses: a host's @rivet-dev/workflows step context has these and more. */
export interface JobStepContext {
  readonly state: JobState;
  readonly abortSignal: AbortSignal;
  waitUntil(promise: Promise<void>): void;
}
interface StepConfig<S, T> { name: string; timeout?: number; maxRetries?: number; run: (s: S) => Promise<T> }
type LoopResult<T, R> = { continue: true; state: T } | { break: true; value: R };
/** The workflow context the job uses, in a loop's iterations as well. */
export interface JobLoopContext<S> {
  step<T>(name: string, run: (s: S) => Promise<T>): Promise<T>;
  step<T>(config: StepConfig<S, T>): Promise<T>;
  readonly queue: { next(name: string, options: { names: ["answers"] }): Promise<{ body: AnswersMessage }> };
}
export interface JobContext<S> extends JobLoopContext<S> {
  readonly key: readonly string[];
  loop<T, R>(config: { name: string; state: T; run: (loop: JobLoopContext<S>, state: T) => Promise<LoopResult<T, R>> }): Promise<R>;
  getVersion(name: string, latest: number): Promise<number>;
}

/** The account's side of a job: its guardrails, eval, endpoints, ledger and records. */
export interface JobAccount {
  resolveGuardrails(input: { projectId?: string; environment: string; agent?: string | null; taskId?: string }): Promise<ResolvedGuardrails>;
  jobUpdate(input: { jobId: string; status: string; budgetUsd?: number; capOpenmeritUsd?: number | null; capCustomerUsd?: number | null; measured?: boolean }): Promise<void>;
  /** The task's confirmed eval command, which a self-hosted server runs to measure; null when it has none. */
  evalCommandFor(taskId: string): Promise<EvalCommandSpec | null>;
  /** The task's accepted eval, which the job runs on unchanged; null before it has one. */
  evalFor(taskId: string): Promise<{ version: number; spec: EvalSpec; cases: Case[]; bar: EvalBar } | null>;
  /** Accepts a first run's eval as version 1; returns the version the job ran on. */
  acceptFirstEval(input: { taskId: string; bundle: TaskBundle; spec: EvalSpec; cases: Case[]; source: EvalSource; by: string | null; bar?: EvalBar }): Promise<number>;
  /** A changed task's draft, which a run grades before any search; null when the task has none. */
  changedDraftFor(taskId: string): Promise<{ version: number; spec: EvalSpec; cases: Case[]; bar: EvalBar } | null>;
  /** Accepts a changed task's draft, as a run graded it, as the next version; returns the version the job ran on. */
  acceptReopenedEval(input: { taskId: string; spec: EvalSpec; cases: Case[]; by: string | null; bar: EvalBar; source: EvalSource }): Promise<number>;
  saveEvalGrades(input: { taskId: string; version: number; grades: EvalGrade[] }): Promise<void>;
  evalGrades(input: { taskId: string; version: number }): Promise<EvalGrade[] | null>;
  setJobEval(input: { jobId: string; version: number }): Promise<void>;
  /** Endpoints with their keys, which the job keeps in memory only. */
  endpointSecrets(projectId?: string): Promise<EndpointConfig[]>;
  endpointsForJob(projectId?: string): Promise<EndpointInfo[]>;
  reserve(input: { jobId: string; key: string; usd: number; funding: Funding; model?: string; endpoint?: string }): Promise<ReserveResult>;
  settle(input: { key: string; cost: Settlement }): Promise<void>;
  release(key: string): Promise<void>;
  spent(input: { jobId: string }): Promise<{ openmeritUsd: number; customerUsd: number }>;
  saveReport(input: { jobId: string; taskId: string; json: unknown; markdown: string }): Promise<void>;
}

/** The task's side: labels a person gave and written cases they approved in earlier runs, and its results. */
export interface JobTask {
  labels(): Promise<Record<string, { expected: unknown; approved: boolean }>>;
  written(): Promise<Case[] | null>;
  saveLabels(labels: Record<string, { expected: unknown; approved: boolean }>): Promise<void>;
  saveWritten(cases: Case[]): Promise<void>;
  recordResult(input: { jobId: string; status: string; result: JobResult | null }): Promise<void>;
}

/** What a host gives the job: its records, the catalogue, a member's own case writer, its settings and analytics. */
export interface JobHost<S extends JobStepContext> {
  account(s: S, accountId: string): JobAccount;
  task(s: S, accountId: string, taskId: string): JobTask;
  catalogue(s: S): Promise<Catalogue>;
  /**
   * The case writer on the user's own plan instead of OpenMerit's key: hosted, the subscription of the
   * member who started the run; self-hosted, OpenMerit Harness as `openmerit connect` set it up. Its
   * source, a sentence saying who wrote the cases, and a way to open it for a task whose answer is JSON
   * or not; `harness` also rewrites an eval from grades. Null when there is none; rejects when it cannot be used.
   */
  memberWriter(s: S, userId: string | null): Promise<{ source: EvalSource; by: (model: string) => string; open: (signal: AbortSignal, json: boolean) => Promise<{ complete: Complete; model: string; harness?: Harness }> } | null>;
  settings(): {
    config: { mode: "hosted" | "self-hosted"; appUrl: string; openrouter: { apiKey: string | null }; models: { caseWriter: string; judge: string }; limits: { defaultJobBudgetUsd: number } };
    fetch: typeof fetch;
    /** Runs an agent end to end on its agent cases; null when the agent has no eval. */
    agentEval: (input: { accountId: string; environment: string; agent: string }) => ((assignment: ReadonlyMap<string, { model: string; endpoint: string }>) => Promise<AgentRun>) | null;
  };
  /** The job ended: called once, on the transition from a live status to a terminal one. */
  completed(s: S, status: "done" | "stopped" | "failed"): void;
}

/** A measure step's outcome. A full first run of a round also keeps its answers, redacted, for the grading loop's samples. */
type Measured = ({ kind: "ok"; answers?: CaseAnswer[] } & MeasureResult) | { kind: "unavailable" | "refused" | "error"; reason: string };

/**
 * Retries for the steps that call models. @rivet-dev/workflows counts a step that the actor's stop
 * aborts, as on a deploy's drain, as a failed attempt; with no retries that one abort exhausts the
 * step and the workflow stays failed. These steps return their own failures as values, so a thrown
 * error is almost always an interruption, and the step runs again where the actor moves, reusing its
 * `<job>/<step>` ledger keys.
 */
const INTERRUPTIONS = 5;

/** A fix before it is tied to its notice's text. */
type FixFor = Fix extends infer F ? F extends Fix ? Omit<F, "notice"> : never : never;

/** Ends the job early; caught by the workflow, which records why and what fixes it. */
class JobStop extends Error {
  readonly status: "done" | "stopped" | "failed";
  readonly resultStatus: JobResult["status"] | null;
  readonly fix: FixFor | null;
  constructor(status: "done" | "stopped" | "failed", resultStatus: JobResult["status"] | null, message: string, fix: FixFor | null = null) { super(message); this.status = status; this.resultStatus = resultStatus; this.fix = fix; }
}

/** Endpoints with their keys, by job, in this process only. */
const endpointKeys = new Map<string, Promise<EndpointConfig[]>>();
/** Drops a job's endpoint keys from memory, as when its actor is destroyed. */
export const forgetJob = (jobId: string) => { endpointKeys.delete(jobId); };

function keysFor(jobId: string, account: JobAccount, projectId: string): Promise<EndpointConfig[]> {
  let keys = endpointKeys.get(jobId);
  if (!keys) {
    keys = account.endpointSecrets(projectId).catch((error: unknown) => { endpointKeys.delete(jobId); throw error; });
    endpointKeys.set(jobId, keys);
  }
  return keys;
}

/** The account's ledger for one job. Keys come from openmerit/ranking and already start with the job ID. */
const jobLedger = (account: JobAccount, jobId: string): Ledger => ({
  reserve: reservation => account.reserve({ ...reservation, jobId }),
  settle: (key, cost) => account.settle({ key, cost }),
  release: key => account.release(key),
  spent: async () => { const spent = await account.spent({ jobId }); return { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }; },
});

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
/** The key a case's label is saved under in the task, so a later run need not ask again. */
export const caseKey = (input: Record<string, string>) => hash(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));


const labeled = (item: Case) => item.expected !== undefined && item.approved !== false;
const show = (input: Record<string, string>) => Object.entries(input).map(([name, value]) => `${name}: ${value.length > 400 ? `${value.slice(0, 400)}…` : value}`).join("\n");

/** Written cases the user has not yet confirmed in the label check. */
const unchecked = (cases: readonly Case[]) => cases.filter(item => item.origin === "written" && item.approved === undefined);

/**
 * The label check: a question for each case with no answer, such as an example without one, and
 * openmerit/ranking's `label_check` for the written cases the user has not confirmed yet.
 */
export function labelQuestions(bundle: TaskBundle, cases: readonly Case[]): Question[] {
  const questions = cases.flatMap((item): Question[] => {
    if (item.approved === false || item.expected !== undefined) return [];
    const base = { id: `label_${item.id}`, prompt: `What is the correct ${bundle.output.kind === "json" ? "JSON answer" : "answer"} for case ${item.id} of ${bundle.task}?`, detail: show(item.input), hint: "Answer skip to leave this case out." };
    return [bundle.output.kind === "label"
      ? { ...base, kind: "choice", options: [...bundle.output.labels, "skip"].map(value => ({ value, label: value })) }
      : { ...base, kind: "text" }];
  });
  const check = labelCheck(bundle, unchecked(cases));
  return check ? [...questions, check] : questions;
}

/** Applies answers to the label check. Unanswered questions stay; a wrong answer is reported and asked again. */
export function applyAnswers(bundle: TaskBundle, cases: readonly Case[], answers: Answers): { cases: Case[]; problems: string[] } {
  const problems: string[] = [];
  const check = answers[LABEL_CHECK_QUESTION];
  // Ticked written cases are approved; unticked ones stay in the list as not approved, so they are neither measured nor asked about again.
  const ticked = check === undefined ? null : new Set(applyLabelCheck(unchecked(cases), check).map(item => item.id));
  const next = cases.map((item): Case => {
    const label = answers[`label_${item.id}`];
    if (label !== undefined && item.expected === undefined) {
      const text = String(label).trim();
      if (text.toLowerCase() === "skip") return { ...item, approved: false };
      if (bundle.output.kind === "label" && !bundle.output.labels.includes(text)) { problems.push(`label_${item.id}: ${text} is not one of ${bundle.output.labels.join(", ")}`); return item; }
      if (bundle.output.kind === "json") {
        try { return { ...item, expected: JSON.parse(text) as unknown, approved: true }; } catch { problems.push(`label_${item.id}: not valid JSON`); return item; }
      }
      return { ...item, expected: text, approved: true };
    }
    if (ticked && item.origin === "written" && item.approved === undefined) return { ...item, approved: ticked.has(item.id) };
    return item;
  });
  return { cases: next, problems };
}

const now = () => new Date().toISOString();

/**
 * About how many measure steps a job takes, as the CLI estimates its runs: the current model's runs,
 * the search's screens (about log₂ of the ladder, then the finalists' neighbours), the finalists' runs
 * on every case, and the challengers, every unplaced model among them, each screened and then run.
 */
export function plannedSteps(ranked: number, unplaced: number, repeats: number): number {
  const screens = Math.min(Math.ceil(Math.log2(ranked + 1)) + FINALISTS + 1, ranked);
  return repeats + screens + Math.min(FINALISTS, ranked) * repeats + (Math.min(CHALLENGERS, ranked) + unplaced) * (1 + repeats);
}

/** What a job will make, cost and take, roughly, before it spends: case runs, dollars (null when a price is unknown), the budget that caps them, and a range of minutes. */
/**
 * `caseRuns`, `usd` and `minutes` are for one search, with a grading trial's run of a cheaper model when the job grades.
 * `rounds` is the most grading rounds the job may run: in a task's first run, each round that writes the eval again runs
 * the trial again, up to MAX_ROUNDS, before the one search.
 */
export interface JobEstimate { caseRuns: number; usd: number | null; budgetUsd: number; minutes: { low: number; high: number }; rounds: number }

/**
 * A job's estimate from its pool before anything runs, as the search's planned steps: the current model's
 * runs and the finalists' and challengers' on every case, screens on up to SMALL_EVAL cases, and a judge call per case run when the output needs one. A case run costs callCost on its
 * model; candidates are priced at the pool's median. A step takes a quarter of a minute to a minute.
 */
export function estimateJob(pool: Pool, bundle: TaskBundle, input: { repeats: number; budgetUsd: number; costPerCall: (model: string) => number | null; judge: string | null; grading: boolean }): JobEstimate {
  const cases = (bundle.examples ?? []).filter(example => example.expected !== undefined).length + WRITTEN_CASES;
  const ranked = pool.ranked.length, unplaced = pool.unplaced.length;
  const searchScreens = Math.min(Math.ceil(Math.log2(ranked + 1)) + FINALISTS + 1, ranked);
  const challengers = Math.min(CHALLENGERS, ranked) + unplaced;
  const fullRuns = (Math.min(FINALISTS, ranked) + challengers) * input.repeats;
  const screenRuns = (searchScreens + challengers) * Math.min(cases, SMALL_EVAL);
  const baselineRuns = input.repeats * cases, candidateRuns = screenRuns + (fullRuns + (input.grading ? 1 : 0)) * cases;
  const prices = [...pool.ranked, ...pool.unplaced].map(option => input.costPerCall(option.endpointModel)).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)]! : null;
  const baseline = pool.baseline ? input.costPerCall(pool.baseline.endpointModel) : null;
  const judge = input.judge === null ? 0 : input.costPerCall(input.judge);
  const usd = baseline === null || median === null || judge === null ? null : baselineRuns * baseline + candidateRuns * median + (baselineRuns + candidateRuns) * judge;
  const steps = plannedSteps(ranked, unplaced, input.repeats);
  return { caseRuns: baselineRuns + candidateRuns, usd: usd === null ? null : Math.min(usd, input.budgetUsd), budgetUsd: input.budgetUsd, minutes: { low: Math.max(1, Math.round(steps / 4)), high: Math.max(1, steps) }, rounds: input.grading ? MAX_ROUNDS : 1 };
}

/** The estimate in one sentence, for the coding agent and the person it asks. */
export const estimateLine = (estimate: JobEstimate) =>
  `Measuring makes about ${estimate.caseRuns.toLocaleString("en-US")} case runs, ${estimate.usd === null ? "at a cost OpenMerit cannot estimate" : `about $${estimate.usd < 0.1 ? estimate.usd.toFixed(3) : estimate.usd.toFixed(2)}`}, never more than the $${estimate.budgetUsd.toFixed(2)} budget per job, and takes about ${estimate.minutes.low === estimate.minutes.high ? estimate.minutes.low : `${estimate.minutes.low} to ${estimate.minutes.high}`} minutes.${estimate.rounds > 1 ? ` Before it searches, you grade answers of the current model and a cheaper one: when your grades make OpenMerit write the eval again, it runs that trial again, up to ${estimate.rounds} rounds, within the same budget.` : ""}`;

/** The result's pick: its figures, the saving per call against the current model, and the calls that repay `runUsd`. */
function pickOf(chosen: MeasuredModel, baseline: MeasuredModel, runUsd: number): NonNullable<JobResult["pick"]> {
  const saving = baseline.costPerCallUsd !== null && chosen.costPerCallUsd !== null ? baseline.costPerCallUsd - chosen.costPerCallUsd : null;
  return { model: chosen.model, endpoint: chosen.endpoint, endpointModel: chosen.endpointModel, passes: chosen.passes, total: chosen.total, costPerCallUsd: chosen.costPerCallUsd, savingPerCallUsd: saving, paybackCalls: paybackCalls(runUsd, saving) };
}

/** A new job's state. */
export const newJobState = (input: JobInput): JobState => ({
  input, status: "queued", phase: "source", questions: [], notices: [], progress: { measured: 0, planned: null }, result: null, error: null, updatedAt: now(),
});

/** What a job's status action shows: its state without the input. */
export function jobView(state: JobState, jobId: string): JobView {
  const { input, measuringSince: _since, ...rest } = state;
  return { ...rest, live: rest.live ?? null, jobId, taskId: input.taskId, task: input.bundle.task, provisional: input.provisional, createdAt: input.createdAt };
}

/** Runs one job, as the workflow of the host's job actor keyed by the job ID. */
export async function runTaskJob<S extends JobStepContext>(ctx: JobContext<S>, host: JobHost<S>): Promise<void> {
  const jobId = ctx.key[0]!;
  /** The report of what was measured so far, once the pool is known; a stopped or failed job saves it. */
  let partial: ((status: JobResult["status"], notices: string[], fixes: Fix[], spent: { openmeritUsd: number; customerUsd: number }) => JobResult) | null = null;
  try {

    // 1. Source: redact the bundle, resolve the task's guardrails, set the job's spend limits.
    const source = await ctx.step({
      name: "source", timeout: 60_000,
      run: async s => {
        const { input } = s.state;
        const bundle = redactBundle(input.bundle);
        const account = host.account(s, input.accountId);
        const projectId = input.projectId ?? DEFAULT_PROJECT;
        const guardrails = await account.resolveGuardrails({ projectId, environment: input.environment, agent: input.agent, taskId: input.taskId });
        const { effective } = guardrails;
        await account.jobUpdate({ jobId, status: "running", budgetUsd: effective.budgetUsd ?? host.settings().config.limits.defaultJobBudgetUsd, capOpenmeritUsd: effective.spendCapUsd ?? null, capCustomerUsd: effective.customerSpendCapUsd ?? null });
        s.state.status = "running"; s.state.phase = "cases"; s.state.updatedAt = now();
        return { bundle, guardrails, accountId: input.accountId, projectId, environment: input.environment, agent: input.agent, provisional: input.provisional };
      },
    });
    const { guardrails } = source as { guardrails: ResolvedGuardrails };
    const sent = (source as { bundle: TaskBundle }).bundle;
    const input = { accountId: source.accountId, environment: source.environment, agent: source.agent };
    // A job whose source step ran before projects replays without one: it is in the default project.
    const projectId = (source as { projectId?: string }).projectId ?? DEFAULT_PROJECT;
    const taskId = taskIdFor(projectId, input.environment, sent.task);
    const budgetUsd = guardrails.effective.budgetUsd ?? host.settings().config.limits.defaultJobBudgetUsd;
    /** What fixes a refused spend: the job's budget is the task's to raise, a cap for the job is a guardrail, and a monthly cap waits for next month. */
    const refusalFix = (reason: string): FixFor | null => reason.includes(JOB_BUDGET) ? { kind: "raise_budget", budgetUsd: Math.ceil(budgetUsd * 2) }
      : reason.includes("cap for this job") ? { kind: "open", label: "Review guardrails", path: `/guardrails/?level=task&id=${encodeURIComponent(taskId)}` } : null;
    const tie = (fix: FixFor | null, notice: string): Fix[] => (fix ? [{ ...fix, notice } as Fix] : []);
    // A job recorded before this step returned its provisional pick has none here.
    const told = (source as { provisional?: Provisional }).provisional ?? null;

    // 2. Cases. A task with an accepted eval runs on it unchanged: its cases, and its spec in place of the
    // bundle's, with no label check; examples the bundle adds wait for someone to revise the eval. Before
    // the task has one, the bundle's examples come first, with labels the user gave in earlier runs, then
    // cases a model writes on OpenMerit's OpenRouter key or the member's subscription. Then the label check,
    // whose answers make the eval the run accepts.
    // A task with its own eval command, on a self-hosted server, is measured by it: no cases, label check or grading.
    const command = await ctx.step("eval-command", async s => host.settings().config.mode === "self-hosted" ? host.account(s, s.state.input.accountId).evalCommandFor(s.state.input.taskId) : null);
    if (command) await ctx.step("eval-command-notice", async s => { s.state.notices.push(`Measured with your eval command, \`${redact(command.command)}\`: its pass or fail per item decides${command.threshold != null ? `, with its threshold of ${command.threshold}` : ""}.`); });
    const step = command ? { cases: [] as Case[], version: null, spec: null, source: "examples" as EvalSource, bar: "current" as EvalBar } : await ctx.step({
      name: "cases", timeout: 0, maxRetries: INTERRUPTIONS,
      run: async s => {
        const { accountId, taskId } = s.state.input;
          const task = host.task(s, accountId, taskId);
        // A task whose prompt, tools or output changed since its eval was accepted reopened it: a run a person started
        // grades the draft with them, as a first run grades a new eval, and accepting it makes the next version.
        const draft = s.state.input.kind === "run" ? await host.account(s, accountId).changedDraftFor(taskId) : null;
        if (draft) {
          s.state.notices.push(`The task changed since eval version ${draft.version} was accepted, so this run grades its draft with you before it searches. Accepting it makes version ${draft.version + 1}.`);
          return { cases: draft.cases, version: null, spec: draft.spec, source: "app" as EvalSource, bar: draft.bar, reopens: draft.version };
        }
        const current = await host.account(s, accountId).evalFor(taskId);
        if (current) {
          const known = new Set(current.cases.map(item => caseKey(item.input)));
          const added = (await writeCases({ bundle: sent, complete: async () => "", count: 0 })).cases.filter(item => item.origin === "example" && !known.has(caseKey(item.input)));
          if (added.length) s.state.notices.push(`${added.length} example${added.length === 1 ? "" : "s"} the coding agent sent ${added.length === 1 ? "is" : "are"} not in the accepted eval, so the run did not use ${added.length === 1 ? "it" : "them"}: revise the eval in the app to add ${added.length === 1 ? "it" : "them"}.`);
          const differs = JSON.stringify(specOf(sent)) !== JSON.stringify(current.spec);
          if (differs) s.state.notices.push(`The run used the criteria of accepted eval version ${current.version}, not the ones the coding agent sent: the eval in the app is the one to edit.`);
          return { cases: current.cases, version: current.version, spec: current.spec, source: "app" as EvalSource, bar: current.bar };
        }
        const [saved, approved] = await Promise.all([task.labels(), task.written()]);
        const { config, fetch } = host.settings();
        let complete: Complete = async () => "";
        let count = 0;
        // The cases may be written on the user's own plan: a member's subscription, or a self-hosted server's
        // OpenMerit Harness. When it cannot be used, the job says so and writes them on OpenMerit's key.
        const mine = approved === null ? await host.memberWriter(s, s.state.input.userId ?? null).catch((error: unknown) => {
          const selfHosted = config.mode === "self-hosted";
          const notice = `${selfHosted ? "OpenMerit Harness" : "Your subscription"} did not write the cases (${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}): ${config.openrouter.apiKey ? "OpenMerit's key wrote them" : "the job measures on the bundle's examples"}.`;
          s.state.notices.push(notice);
          s.state.fixes = [...(s.state.fixes ?? []), selfHosted
            ? { kind: "ask_agent", notice, prompt: "Ask the user to run `openmerit connect` in a terminal to fix OpenMerit Harness, then call openmerit_recommend again." }
            : { kind: "open", label: "Account settings", path: "/account/", notice }];
          return null;
        }) : null;
        let writtenBy: string | null = null;
        let source: EvalSource = approved === null ? "examples" : "openmerit";
        if (mine) {
          source = mine.source;
          const writer = await mine.open(s.abortSignal, sent.output.kind === "json");
          complete = writer.complete;
          count = WRITTEN_CASES;
          writtenBy = mine.by(writer.model);
        } else if (approved === null && config.openrouter.apiKey) {
          const index = catalogueIndex(await host.catalogue(s));
          const account = host.account(s, accountId);
          // The writer answers with all its cases at once, so it gets longer than a ranking call to answer.
          const models = createClient(await keysFor(jobId, account, projectId), { fetch, model: model => index.find(model), timeoutMs: 600_000 });
          complete = completeWith(models, { endpoint: OPENROUTER, model: config.models.caseWriter }, jobLedger(account, jobId), `${jobId}/cases`, s.abortSignal);
          count = WRITTEN_CASES;
          source = "openmerit";
        }
        let made;
        try {
          made = await writeCases({ bundle: sent, complete, count });
          if (writtenBy && made.cases.some(item => item.origin === "written")) s.state.notices.push(writtenBy);
        } catch (error) {
          if (s.abortSignal.aborted) throw error;
          const notice = `No cases were written (${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}): the job measures on the bundle's examples only.`;
          s.state.notices.push(notice);
          s.state.fixes = [...(s.state.fixes ?? []), { kind: "rerun", notice }];
          made = await writeCases({ bundle: sent, complete, count: 0 });
          source = approved === null ? "examples" : source;
        }
        const examples = made.cases.filter(item => item.origin === "example").map(item => {
          const label = saved[caseKey(item.input)];
          return item.expected === undefined && label ? { ...item, expected: label.expected, approved: label.approved } : item;
        });
        return { cases: [...examples, ...(approved ?? made.cases.filter(item => item.origin === "written"))], version: null, spec: null, source, bar: "current" as EvalBar };
      },
    });
    // A job recorded before evals had versions returned only the cases, and one recorded before the grading loop no bar.
    const written: { cases: Case[]; version: number | null; spec: EvalSpec | null; source: EvalSource; bar?: EvalBar; reopens?: number } = Array.isArray(step) ? { cases: step as Case[], version: null, spec: null, source: "openmerit" as EvalSource, bar: "current" as EvalBar } : step;
    // The bundle and cases change when the grading loop writes the eval again.
    let bundle: TaskBundle = written.spec ? { ...sent, ...written.spec } : sent;
    // Grading first: a task's first run, a person started, on cases OpenMerit wrote, skips the label check of the written
    // cases. A person grades a trial's answers instead, before any search. Jobs past this point before it are as they began.
    const order = await ctx.getVersion("grade-first", 2);
    const gradeFirst = order === 2 && await ctx.step("grade-first-run", async s =>
      s.state.input.kind === "run" && written.version === null && written.cases.some(item => item.origin === "written" && item.expected !== undefined) && !!host.settings().config.openrouter.apiKey);
    let cases = await ctx.loop({
      name: "label-check", state: gradeFirst ? written.cases.map(item => (item.origin === "written" && item.approved === undefined ? { ...item, approved: true } : item)) : written.cases,
      run: async (loop, current) => {
        // An accepted eval was reviewed already: its unanswered cases are left out, not asked about.
        const questions = written.version === null ? labelQuestions(bundle, current) : [];
        if (!questions.length) return Loop.break(current);
        await loop.step("ask", async s => {
          s.state.status = "needs_input"; s.state.phase = "label_check"; s.state.questions = questions; s.state.live = null; s.state.updatedAt = now();
          await host.account(s, s.state.input.accountId).jobUpdate({ jobId, status: "needs_input" });
        });
        const message = await loop.queue.next("answer", { names: ["answers"] });
        const next = await loop.step("apply", async s => {
          const applied = applyAnswers(bundle, current, message.body.answers);
          s.state.questions = []; s.state.status = "running"; s.state.phase = "cases"; s.state.updatedAt = now();
          s.state.notices = [...s.state.notices.filter(notice => !notice.startsWith("Answer not used: ")), ...applied.problems.map(problem => `Answer not used: ${problem}`)];
          const labels = Object.fromEntries(applied.cases.filter(item => item.origin === "example" && (item.expected !== undefined || item.approved === false)).map(item => [caseKey(item.input), { expected: item.expected, approved: item.approved !== false }]));
          const task = host.task(s, s.state.input.accountId, s.state.input.taskId);
          await task.saveLabels(labels);
          const kept = applied.cases.filter(item => item.origin === "written" && item.approved === true);
          if (message.body.answers[LABEL_CHECK_QUESTION] !== undefined && kept.length) await task.saveWritten(kept);
          await host.account(s, s.state.input.accountId).jobUpdate({ jobId, status: "running" });
          return applied.cases;
        });
        return Loop.continue(next);
      },
    });
    // A case with no mocked result for one of the task's tools is the eval's defect, so no model runs it.
    const casesOf = (from: readonly Case[]) => {
      const invalid = invalidCases(bundle, from.filter(labeled));
      const usable = from.filter(item => labeled(item) && !invalid.some(bad => bad.caseId === item.id));
      return {
        invalid, usable, caseIds: usable.map(item => item.id), kinds: Object.fromEntries(usable.map(item => [item.id, caseKind(item)])),
        counts: { total: usable.length, fromExamples: usable.filter(item => item.origin === "example").length, written: usable.filter(item => item.origin !== "example").length },
      };
    };
    let { invalid, usable, caseIds, kinds, counts } = casesOf(cases);

    // The grading loop (openmerit-core's eval/loop.ts), graded first: a trial runs the current model and one cheaper model,
    // a person grades sampled answers, and that is the review that accepts the eval. Where they and the eval disagree,
    // OpenMerit writes the eval again and runs the trial again; once they agree on every answer, the run accepts it as
    // version 1 and only then searches the models on it. Jobs that had passed this point before the loop existed accept it
    // here, as they began; a job that graded after its search (version 2) cannot resume in this order.
    const gradingVersion = await ctx.getVersion("grading-loop", 3);
    // Its recorded step says whether it was grading.
    const gradedAfterSearch = gradingVersion === 2 && await ctx.step("grading", async () => false);
    const grade = gradingVersion === 3 && gradeFirst && usable.some(item => item.origin === "written");
    /** Accepts a first run's eval as version 1, as the job measures it, and records the version the job ran on. */
    const acceptFirst = (name: string, source: EvalSource, bar: EvalBar, by: string | null) => ctx.step({
      name, timeout: 60_000,
      run: async s => {
        const account = host.account(s, s.state.input.accountId);
        const who = by ?? s.state.input.userId ?? null;
        const version = written.version ?? (written.reopens !== undefined
          ? await account.acceptReopenedEval({ taskId, spec: specOf(bundle), cases, source, by: who, bar })
          : await account.acceptFirstEval({ taskId, bundle: sent, spec: specOf(bundle), cases, source, by: who, bar }));
        await account.setJobEval({ jobId, version });
        return version;
      },
    });
    // Without grading, a first run's cases, as the label check left them, are the eval it accepts as version 1. A graded run accepts it once the person agrees.
    let evalVersion: number | null = grade || command || written.reopens !== undefined ? null : await acceptFirst("eval", written.source, written.bar ?? "current", null);
    /** The current model's failed cases and why, from its recorded measure steps, so a replay rebuilds the same. */
    const failedCases = new Map<string, { caseId: string; kind: string; reason: string }>();

    // 3. Models: the ECI-ordered pool over every allowed endpoint. A wide pool, for the criteria bar, takes every eligible model whatever its price.
    // An eval a person accepted against the criteria keeps that bar in later runs, watch jobs among them.
    const acceptedBar: EvalBar = written.bar ?? "current";
    const poolStep = (name: string, wide: boolean) => ctx.step({
      name, timeout: 60_000,
      run: async s => {
          const catalogue = await host.catalogue(s);
        const endpoints = await host.account(s, s.state.input.accountId).endpointsForJob(projectId);
        const built = buildPool({ catalogue, endpoints, bundle, guardrails: guardrails.effective, wide });
        // The catalogue entries the job's calls are priced by, by the name each endpoint calls the model, so every step prices on this version.
        const index = catalogueIndex(catalogue);
        const priced: Record<string, CatalogueModel> = {};
        for (const option of [built.baseline, ...built.ranked, ...built.unplaced]) {
          const model = option?.inCatalogue ? index.find(option.model) : null;
          if (option && model) priced[option.endpointModel] = model;
        }
        const judgeModel = index.find(host.settings().config.models.judge);
        if (judgeModel) priced[host.settings().config.models.judge] = judgeModel;
        s.state.phase = "ranking"; s.state.updatedAt = now();
        // A later round's wider pool repeats the first pool's notices; it adds none.
        if (name !== "models") return { pool: built, priced, catalogueVersion: catalogue.version };
        s.state.notices.push(...built.notices);
        if (invalid.length) {
          const notice = `${invalid.length === 1 ? "Case" : "Cases"} left out for every model, because the eval cannot run ${invalid.length === 1 ? "it" : "them"}: ${invalid.map(item => `${item.caseId} (${item.reason})`).join("; ")}`;
          s.state.notices.push(notice);
          s.state.fixes = [...(s.state.fixes ?? []), { kind: "ask_agent", notice, prompt: `OpenMerit left out cases of the task "${bundle.task}" because the eval has no mocked result for a tool they may call. Give each of the task bundle's tools a mockResult, a realistic answer taken from the code or its tests, then call openmerit_recommend again.` }];
        }
        const region = guardrails.effective.region ? regionNotice(guardrails.effective.region) : null;
        if (region && built.notices.includes(region)) s.state.fixes = [...(s.state.fixes ?? []), { kind: "open", notice: region, label: "Add an endpoint", path: "/connections/#endpoints" }];
        s.state.progress.planned = plannedSteps(built.ranked.length, built.unplaced.length, Math.max(1, guardrails.effective.repeats ?? DEFAULT_REPEATS));
        return { pool: built, priced, catalogueVersion: catalogue.version };
      },
    });
    let models = await poolStep("models", acceptedBar === "criteria");
    let pool = models.pool as Pool;

    // Old jobs that started measuring before the shared policy ran other measure steps: their recorded steps do not replay here.
    const policy = await ctx.getVersion("ranking-policy", 2);
    const repeats = Math.max(1, guardrails.effective.repeats ?? DEFAULT_REPEATS);
    let progress = newProgress<Option>();
    const minPassRate = guardrails.effective.minPassRate ?? 0;
    const maxLatency = Math.min(guardrails.effective.latencyMs ?? Infinity, bundle.constraints?.maxLatencyMs ?? Infinity);
    const bar = Math.max(minPassRate, command?.threshold ?? 0);
    const rules = { threshold: bar ? bar - 1e-9 : null, maxLatencyMs: Number.isFinite(maxLatency) ? maxLatency : null };
    const describe = (option: Option) => ({ model: option.model, endpoint: option.endpoint, endpointModel: option.endpointModel, eci: option.eci });
    const optionOf = (item: { model: string; endpoint: string }) => [...(pool.baseline ? [pool.baseline] : []), ...pool.ranked, ...pool.unplaced].find(option => option.model === item.model && option.endpoint === item.endpoint)!;
    /** openmerit/engine's result for a model, in the report's names: one case is one call, so the cost per item is the cost per call. */
    const measuredModel = (item: ModelResult): MeasuredModel => {
      const option = optionOf(item);
      return {
        model: item.model, endpoint: item.endpoint, endpointModel: item.endpointModel, role: item.role, stage: item.stage, eci: item.eci, inCatalogue: option.inCatalogue, funding: option.funding,
        status: item.status === "unmeasured" ? "screened_out" : item.status, passes: item.passes, total: item.total, costPerCallUsd: item.costPerItemUsd, costIsEstimate: item.costIsEstimate,
        latencyMs: item.latencyMs === null ? null : Math.round(item.latencyMs), qualified: item.qualified, note: item.note,
      };
    };
    // A model that passed its screen but whose full runs did not finish is left out.
    const listed = (items: readonly ModelResult[]) => items.filter(item => item.status !== "unmeasured").map(measuredModel);
    const baselineOf = () => (pool.baseline && progress.baseline.length ? measuredModel(baselineResult(score(progress.baseline), describe(pool.baseline))) : null);
    const failedOf = () => [...failedCases.values()].slice(0, 20);
    partial = (status, notices, fixes, spent) => ({
      failedCases: failedOf(), baselineByKind: byKind(progress.baseline, kinds), invalidCases: invalid,
      status, pick: null, top: [], nearMisses: [], baseline: baselineOf(), candidates: listed([...progress.tried.values()].map(item => modelResult(item, describe(item.option), score(progress.baseline), rules))),
      search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: [], finalists: [], challengers: [], shortfall: null }, agentEval: null, edit: { edits: [], instructions: null },
      spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices, fixes,
      reportUrl: `${host.settings().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts, ...(evalVersion === null ? {} : { evalVersion }),
    });
    /** The job's model client, and the grader the bundle's output calls for. */
    const grading = async (account: JobAccount) => {
      const { config, fetch } = host.settings();
      const client = createClient(await keysFor(jobId, account, projectId), { fetch, model: model => models.priced[model] ?? null });
      // Text answers go to a fixed judge on OpenMerit's key. Its calls count in the job's spend but not in the candidate's cost per call.
      // The rubric is the task's own (rubricFor), with one check per criterion and guardrail of its spec.
      const judge = needsJudge(bundle) && config.openrouter.apiKey ? { client, endpoint: OPENROUTER, model: config.models.judge } : undefined;
      return { client, grader: graderFor(bundle, judge ? { judge } : {}) };
    };
    /**
     * One run of the task's eval command for `option` on `ids` (null: every item the eval runs), through a
     * metering proxy whose calls go to the option's endpoint and are booked in the job's ledger. The eval
     * reports each item's pass or fail; a call that failed, not a wrong answer, marks its failed items errored.
     */
    const measureCommand = async (spec: EvalCommandSpec, option: Option, ids: string[] | null, key: string, account: JobAccount, signal: AbortSignal): Promise<Measured> => {
      const endpoint = (await keysFor(jobId, account, projectId)).find(item => item.id === option.endpoint);
      if (!endpoint) return { kind: "unavailable", reason: `no endpoint ${option.endpoint} with a key` };
      // The run's own cost: what the proxy settled for it, which the engine divides by its items.
      const ledger = jobLedger(account, jobId), reserved = new Map<string, number>();
      let costUsd = 0, costIsEstimate = false;
      const metered: Ledger = {
        ...ledger,
        reserve: async reservation => { const result = await ledger.reserve({ ...reservation, key: `${key}/${reservation.key}` }); if (result.ok) reserved.set(reservation.key, reservation.usd); return result; },
        settle: async (callKey, cost) => { costUsd += settledUsd(reserved.get(callKey) ?? 0, cost); costIsEstimate ||= cost.actualUsd === null; await ledger.settle(`${key}/${callKey}`, cost); },
        release: callKey => ledger.release(`${key}/${callKey}`),
      };
      const proxy = new EvalProxy(() => metered, host.settings().fetch);
      const url = await proxy.start();
      const priced = models.priced[option.endpointModel] ?? null;
      const { token, tally } = proxy.open({
        runId: jobId, unitId: key, endpointId: endpoint.id, baseUrl: endpoint.baseUrl ?? "https://openrouter.ai/api/v1", apiKey: endpoint.apiKey, funding: endpoint.funding, model: option.endpointModel,
        allowed: model => (model.toLowerCase() === option.endpointModel.toLowerCase() ? priced : undefined),
      });
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SERVER_ENV.test(name)));
      let outcome;
      try {
        outcome = await runEval({ command: spec.command, ...(spec.cwd ? { cwd: spec.cwd } : {}), ...(spec.env ? { env: spec.env } : {}), ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) }, { root: spec.root, model: option.endpointModel, baseUrl: url, token, items: ids, env, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        return { kind: "error", reason: `the eval command could not start: ${redact(error instanceof Error ? error.message : String(error))}` };
      } finally { proxy.close(token); await proxy.stop(); }
      if (tally.budgetHit) return { kind: "refused", reason: tally.refusedReason ?? JOB_BUDGET };
      const refused = [...new Set(tally.poolViolations)];
      const refusedNote = refused.length ? ` OpenMerit's proxy refused ${tally.poolViolations.length} request(s) for ${refused.join(", ")}: the eval must send the model in $OPENMERIT_MODEL as it is.` : "";
      if (!outcome.ok) {
        const rejected = tally.upstreamErrors.find(status => [400, 401, 403, 404].includes(status) || retryable(status));
        if (rejected) return { kind: "unavailable", reason: `${option.endpoint} answered HTTP ${rejected} for ${option.endpointModel}` };
        return { kind: "error", reason: `${outcome.error ?? "the eval failed"}.${refusedNote}${outcome.log ? ` Last output: ${outcome.log.split("\n").slice(-3).join(" ")}` : ""}` };
      }
      if (!outcome.items) return { kind: "error", reason: `the eval reported no per-item results: it must write {"items":[{"id","pass"}]} to $OPENMERIT_RESULT.${refusedNote}` };
      if (!tally.requests) return { kind: "unavailable", reason: `the eval sent no model request through OpenMerit's proxy (OPENAI_BASE_URL), so ${option.endpointModel} was not what it ran.${refusedNote}` };
      const reported = new Map(outcome.items.map(item => [item.id, item.pass]));
      const wanted = ids ?? [...reported.keys()];
      const absent = wanted.filter(item => !reported.has(item));
      if (absent.length) return { kind: "error", reason: `the eval reported no result for ${absent.length} requested item(s): ${absent.slice(0, 10).join(", ")}` };
      const callsFailed = tally.upstreamErrors.length > 0 || tally.abandoned > 0;
      return {
        kind: "ok", costUsd, costIsEstimate, graderCostUsd: 0, latencyMs: wanted.length ? outcome.durationMs / wanted.length : null,
        results: wanted.map(item => reported.get(item) ? { caseId: item, pass: true } : { caseId: item, pass: false, ...(callsFailed ? { failure: "error" as const, reason: "a model call failed during this run" } : refused.length ? { reason: `the proxy refused a model outside the pool (${refused.join(", ")})` } : {}) }),
      };
    };
    let counter = 0;
    /** The share of case runs the current model passed in the grading trial, for the live view of the trial's cheaper model. */
    let trialRate: number | null = null;
    /** How many measure steps the job takes in all, once the search knows its size. Set outside steps, from the step count, so a replay sets the same. */
    let plannedTotal: number | null = null;
    /**
     * One measure call as one workflow step: each repeat and each screen is its own step. Its ledger keys
     * start with the job and the step, so a replay reuses them; a retry after an error is a deliberate
     * repeat, with its own keys. `keep` keeps the run's answers for the grading loop: the step's result
     * is recorded, so they are redacted and cut short here, as the samples are.
     */
    const measure = (option: Option, ids: string[] | null, keep = false): Promise<Measured> => {
      const name = `measure-${++counter}`;
      if (command) return ctx.step({ name, timeout: 0, maxRetries: INTERRUPTIONS, run: async s => { const result = await measureCommand(command, option, ids, `${jobId}/${name}`, host.account(s, s.state.input.accountId), s.abortSignal); if (result.kind === "ok" || result.kind === "unavailable") done(s); return result; } }) as Promise<Measured>;
      if (!ids) throw new Error("measuring without an eval command needs the cases");
      // Against the current model's runs so far: the search's, else the grading trial's.
      const against = option === pool.baseline ? null : progress.baseline.length ? score(progress.baseline).score : trialRate;
      return ctx.step({
        name, timeout: 0, maxRetries: INTERRUPTIONS,
        run: async s => {
          if (plannedTotal !== null) s.state.progress.planned = Math.max(plannedTotal, s.state.progress.measured);
          // Live progress: the steps left at the pace of the steps done so far.
          s.state.measuringSince ??= now();
          const elapsed = Date.now() - Date.parse(s.state.measuringSince), stepsDone = s.state.progress.measured;
          const left = stepsDone && s.state.progress.planned ? Math.max(1, Math.ceil(elapsed / stepsDone * (s.state.progress.planned - stepsDone) / 60_000)) : null;
          const live: LiveProgress = {
            model: option.model, endpoint: option.endpoint, baseline: against === null || !pool.baseline ? null : { model: pool.baseline.model, rate: against * 100 },
            done: 0, total: ids!.length, passes: 0, history: [], minutesLeft: left,
          };
          s.state.live = live;
          const account = host.account(s, s.state.input.accountId);
          const { client, grader } = await grading(account);
          const byId = new Map(usable.map(item => [item.id, item]));
          let answers: CaseAnswer[] = [];
          const onCase = (result: { caseId: string; pass: boolean; reason?: string; failedChecks?: string[] }, ran: { output: string | null; toolCalls?: readonly { name: string; arguments: string }[] } | null) => {
            live.done += 1; live.passes += result.pass ? 1 : 0;
            live.history = [...live.history, { time: Date.now() / 1000, rate: live.passes / live.done * 100 }].slice(-60);
            const item = byId.get(result.caseId);
            if (keep && item) answers.push(...pickSamples([{ model: option.model, role: "current", answers: [{
              caseId: item.id, kind: caseKind(item), input: item.input, output: ran?.output ?? "", toolCalls: (ran?.toolCalls ?? []).map(call => ({ name: call.name, arguments: call.arguments })),
              pass: result.pass, failedChecks: result.failedChecks ?? [], ...(result.reason ? { reason: result.reason } : {}),
            }] }], 1).map(({ id: _id, role: _role, model: _model, ...answer }) => answer));
          };
          const run = createMeasure({ bundle, cases: usable, client, grader, ledger: jobLedger(account, jobId), key: `${jobId}/${name}`, signal: s.abortSignal, onCase });
          for (let attempt = 1; ; attempt++) {
            live.done = 0; live.passes = 0; live.history = []; answers = [];
            try {
              const result = await run({ model: option.endpointModel, endpoint: option.endpoint }, ids!, { run: String(attempt - 1) });
              done(s);
              return { kind: "ok" as const, ...result, ...(keep ? { answers: ids!.flatMap(id => answers.filter(answer => answer.caseId === id)) } : {}) };
            } catch (error) {
              // An actor that is stopping aborts its calls: leave the step unrecorded so it runs again.
              if (s.abortSignal.aborted) throw error;
              const reason = redact(error instanceof Error ? error.message : String(error));
              if (error instanceof CandidateUnavailable) { done(s); return { kind: "unavailable" as const, reason }; }
              if (error instanceof BudgetRefused) return { kind: "refused" as const, reason };
              if (attempt >= 3) return { kind: "error" as const, reason };
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
          }
        },
      }) as Promise<Measured>;
    };
    const done = (s: { state: JobState }) => {
      s.state.progress.measured += 1;
      s.state.progress.planned = Math.max(s.state.progress.planned ?? 0, s.state.progress.measured);
      s.state.updatedAt = now();
    };
    const stopFor = (result: Measured, what: string): JobStop => result.kind === "refused"
      // The report keeps what was measured before the budget ran out.
      ? new JobStop("stopped", "stopped", `Stopped while measuring ${what}: ${result.reason}. Raise the budget in the task's guardrails at app.openmerit.ai to continue.`, refusalFix(result.reason))
      : new JobStop("failed", "failed", `Measuring ${what} failed: ${"reason" in result ? result.reason : "unknown error"}`, { kind: "rerun" });
    /** What fixes the end of the challengers, when one ended them. */
    let endedFix: FixFor | null = null;

    try {
      if (gradedAfterSearch) throw new JobStop("failed", "failed", "The run was grading its eval when a deploy changed OpenMerit to grade the eval before searching, so it cannot resume. Nothing is charged for it; run the task again to start over.", { kind: "rerun" });
      if (policy === 1) throw new JobStop("failed", "failed", "The job started measuring before a deploy changed how OpenMerit measures, so it cannot resume. Nothing is charged for it; call openmerit_recommend again to rerun it.", { kind: "rerun" });
      if (!command && !usable.length) throw new JobStop("stopped", "no_cases", "No case has a known correct answer. Add examples with expected answers to the bundle, or answer the label check.",
        { kind: "ask_agent", prompt: `OpenMerit found no test case with a known correct answer for the task "${bundle.task}". Add examples with their expected answers to its task bundle, taken from the code's tests or fixtures, then call openmerit_recommend again.` });
      if (!pool.baseline) throw new JobStop("failed", "baseline_failed", "No endpoint can run the current model: OpenMerit's OpenRouter key is not configured, and no endpoint of yours serves it.", { kind: "open", label: "Add an endpoint", path: "/connections/#endpoints" });
      const current = pool.baseline;
      // A changed task's draft is accepted only by a person grading it.
      if (written.reopens !== undefined && !grade) throw new JobStop("stopped", null, `The task changed since eval version ${written.reopens} was accepted, and this run cannot grade its draft. Review and accept the draft in the app.`,
        { kind: "open", label: "Review eval", path: `/tasks/?task=${encodeURIComponent(taskId)}&tab=eval` });
      // A saved eval's kept grades: the judge grades the answers a person graded again, and a disagreement flags the eval for review.
      if (written.version !== null && !command) {
        const version = written.version;
        await ctx.step({
          name: "regrade", timeout: 0, maxRetries: INTERRUPTIONS,
          run: async s => {
            const account = host.account(s, s.state.input.accountId);
            const kept = await account.evalGrades({ taskId, version });
            if (!kept?.length) return;
            const { grader } = await grading(account);
            const byId = new Map(usable.map(item => [item.id, item]));
            const disagree: string[] = [];
            for (const [index, item] of kept.entries()) {
              const caseItem = byId.get(item.caseId);
              if (!caseItem) continue;
              try {
                const graded = await grader.grade({ bundle, caseItem, output: item.output, toolCalls: item.toolCalls.map((call, at) => ({ id: `call_${at}`, ...call })), ledger: jobLedger(account, jobId), key: `${jobId}/regrade/${index}`, signal: s.abortSignal });
                if (graded.pass !== (item.verdict === "good")) disagree.push(`${item.caseId} (${item.model})`);
              } catch (error) { if (s.abortSignal.aborted) throw error; }
            }
            if (!disagree.length) return;
            const notice = `The eval now grades ${disagree.length} of the ${kept.length} answers you graded when you accepted version ${version} differently from you: ${disagree.join(", ")}. Review the eval: the run measured on it as it is.`;
            s.state.notices.push(notice);
            s.state.fixes = [...(s.state.fixes ?? []), { kind: "open", label: "Review eval", path: `/tasks/?task=${encodeURIComponent(taskId)}&tab=eval`, notice }];
          },
        });
      }

      /**
       * The trial's runs, which the search reads instead of measuring again: the current model's, by repeat, and the
       * trial model's, by option. A screen takes its cases from the trial model's full run, at its share of the cost.
       */
      const trialRuns = new Map<string, Extract<Measured, { kind: "ok" }>>();
      /** Each finalist's answers on its first full run in the search, for the spot-check of the pick. */
      const finalAnswers = new Map<string, CaseAnswer[]>();
      const fromTrial = (key: string, ids: readonly string[] | null): Measured | null => {
        const run = trialRuns.get(key);
        if (!run || !ids || !ids.every(id => run.results.some(item => item.caseId === id))) return null;
        const wanted = new Set(ids), share = ids.length / Math.max(1, run.results.length);
        return { ...run, results: run.results.filter(item => wanted.has(item.caseId)), costUsd: run.costUsd * share, graderCostUsd: run.graderCostUsd * share, costIsEstimate: run.costIsEstimate || share < 1, answers: [] };
      };

      // 4. Ranking: openmerit/engine's evaluateTask, the policy the CLI runs too. Each of its measure calls is one step.
      // The agent was told the provisional pick: when no measured model beats the current one per call, it is measured before keeping the current model.
      let provisional = null as Option | null;
      const rank = (round: number, bar: LoopState["bar"]) => {
        provisional = (told && [...pool.ranked, ...pool.unplaced].find(item => item.model === told.model && item.endpoint === told.endpoint)) || null;
        return evaluateTask<Option>({
          ladder: pool.ranked, unplaced: pool.unplaced, strength: item => item.eci ?? -Infinity, items: command ? null : caseIds, repeats, provisional,
          // The customer's own eval decides with its own threshold: no floor.
          rules, kinds, ...(command ? { floor: null } : {}),
          baselinePrice: current.price, progress,
          // Against the criteria, a model qualifies when it meets the eval's checks, whatever the current model scored.
          criteria: bar === "criteria" ? criteriaOf(bundle, guardrails.effective.criteriaPassRate) : null,
          measure: async (option, items, call) => {
            const target = option ?? current;
            if (call.provisional && call.role === "screen") plannedTotal = counter + 1 + repeats;
            const ids = items ? [...items] : command ? null : [...caseIds];
            const result = (call.attempt ?? 1) === 1 && (call.role === "baseline" || call.role === "screen" && call.repeat === 1) && fromTrial(option ? option.key : `current-${call.repeat}`, ids) || await measure(target, ids, grade && call.role === "final" && call.repeat === 1 && (call.attempt ?? 1) === 1);
            if (option && result.kind === "ok" && result.answers?.length && !finalAnswers.has(option.key)) finalAnswers.set(option.key, result.answers);
            if (result.kind === "unavailable") {
              if (!option) throw new JobStop("stopped", "baseline_failed", `${current.model} could not run: ${result.reason}`, { kind: "rerun" });
              throw new CandidateUnavailable(result.reason);
            }
            // A candidate whose step kept failing, such as on a deadline, is skipped as untested: the next one still runs.
            if (result.kind === "error" && option) throw new CandidateUnavailable(`measuring it failed: ${result.reason}`);
            if (result.kind !== "ok") {
              const stop = stopFor(result, option ? target.model : `the current model ${current.model}`);
              // The finalists are measured, so a challenger the budget refuses ends the challengers only.
              if (call.stage === "challenger") { endedFix = stop.fix; throw new EndChallengers(stop.message); }
              throw stop;
            }
            if (!option) for (const item of result.results) if (!item.pass && item.failure !== "ungradable" && item.reason && !failedCases.has(item.caseId)) failedCases.set(item.caseId, { caseId: item.caseId, kind: kinds[item.caseId] ?? "case", reason: item.reason });
            // The checks a failed case missed, for the criteria bar (meetsCriteria).
            const checks = Object.fromEntries(result.results.flatMap(item => (item.failedChecks?.length ? [[item.caseId, item.failedChecks]] : [])));
            // Cases lost to a failed or timed-out call, not a wrong answer: the engine measures them once more.
            const errored = result.results.flatMap(item => (!item.pass && item.failure === "error" ? [item.caseId] : []));
            // Cases no grader could grade are left out for every model (the engine's Measurement.ungradable).
            const ungradable = result.results.flatMap(item => (item.failure === "ungradable" ? [item.caseId] : []));
            return { items: Object.fromEntries(result.results.filter(item => item.failure !== "ungradable").map(item => [item.caseId, item.pass])), checks, errored, ungradable, costUsd: result.costUsd, costIsEstimate: result.costIsEstimate, latencyMs: result.latencyMs };
          },
          // The same cases for the same eval, placed by their content (stableSample), and recorded in a step, so a replay screens on the same cases.
          sample: (reliable, count) => ctx.step(round === 1 ? "samples" : `samples-r${round}`, async () => {
            const byId = new Map(usable.map(item => [item.id, item]));
            return stableSample(reliable, count, id => JSON.stringify([bundle.task, id, byId.get(id)?.input ?? null, byId.get(id)?.expected ?? null]));
          }),
          on: {
            // The search is done: the finalists' runs and the challengers are left.
            searched: search => { plannedTotal = counter + search.finalists.length * repeats + (Math.min(CHALLENGERS, pool.ranked.length) + pool.unplaced.length) * (1 + repeats); },
            challengers: options => { plannedTotal = counter + options.length * (1 + repeats); },
          },
        });
      };
      /**
       * The trial a person grades before the search: the current model on every case, `repeats` times (the search's
       * baseline, which it reads back), and one cheaper model once: the search's first probe, the middle of the pool,
       * moving down the weaker half while it fails no case the current model passed in every run (trialOption).
       */
      let trialSpec: string | null = null;
      const trial = async () => {
        // A round whose grades changed only some cases, not the criteria, keeps the other cases' runs: they were graded on the same eval.
        const spec = JSON.stringify(specOf(bundle));
        const prior = spec === trialSpec ? new Map(trialRuns) : new Map<string, Extract<Measured, { kind: "ok" }>>();
        trialSpec = spec; trialRuns.clear();
        const wanted = new Set(caseIds);
        const runOf = async (option: Option, keep: boolean, key: string): Promise<Measured> => {
          const before = prior.get(key);
          const kept = before ? before.results.filter(item => wanted.has(item.caseId)) : [];
          const keptAnswers = (before?.answers ?? []).filter(answer => wanted.has(answer.caseId));
          const missing = caseIds.filter(id => !kept.some(item => item.caseId === id));
          if (before && !missing.length) return { ...before, results: kept, answers: keptAnswers };
          const result = await measure(option, before ? missing : [...caseIds], keep);
          if (!before || result.kind !== "ok") return result;
          const share = kept.length / Math.max(1, before.results.length);
          return { ...result, results: [...kept, ...result.results], answers: [...keptAnswers, ...(result.answers ?? [])], costUsd: before.costUsd * share + result.costUsd, graderCostUsd: before.graderCostUsd * share + result.graderCostUsd, costIsEstimate: true };
        };
        const runs: Extract<Measured, { kind: "ok" }>[] = [];
        const reliable = () => caseIds.filter(id => runs.every(run => run.results.some(item => item.caseId === id && item.pass)));
        for (let repeat = 1; repeat <= repeats; repeat++) {
          const result = await runOf(current, repeat === 1, `current-${repeat}`);
          if (result.kind === "unavailable") throw new JobStop("stopped", "baseline_failed", `${current.model} could not run: ${result.reason}`, { kind: "rerun" });
          if (result.kind !== "ok") throw stopFor(result, `the current model ${current.model}`);
          runs.push(result); trialRuns.set(`current-${repeat}`, result);
          // The search stops repeating here too, as too few cases are left to screen on.
          if (reliable().length < SAMPLE_SIZE) break;
        }
        const passed = new Set(reliable());
        trialRate = runs.flatMap(run => run.results).filter(item => item.pass).length / Math.max(1, runs.flatMap(run => run.results).length);
        let answers: CaseAnswer[] = [];
        const picked = await trialOption(pool.ranked, async option => {
          const result = await runOf(option, true, option.key);
          if (result.kind === "unavailable" || result.kind === "error") throw new CandidateUnavailable(result.reason);
          if (result.kind !== "ok") throw stopFor(result, option.model);
          trialRuns.set(option.key, result); answers = result.answers ?? [];
          return result.results.some(item => !item.pass && passed.has(item.caseId));
        });
        return pickSamples([
          { model: current.model, role: "current", answers: runs[0]?.answers ?? [] },
          ...(picked ? [{ model: picked.model, role: "trial" as const, answers }] : []),
        ]);
      };
      let loop: LoopState = startLoop(1, acceptedBar, true);
      let widened = acceptedBar === "criteria";
      /** Asks a person to grade the loop's samples, and returns their grades, in the samples' order, and who sent them. */
      const askGrades = async (suffix: string) => {
        const samples = loop.artifact!.samples;
        const questions = gradeQuestions(bundle.task, loop);
        const graded = await ctx.loop({
          name: `grade${suffix}`, state: { grades: {} as Record<string, Omit<SampleGrade, "sampleId">>, by: null as string | null },
          run: async (step, got) => {
            const open = questions.filter(question => !got.grades[question.id]);
            if (!open.length) return Loop.break(got);
            await step.step("ask", async s => {
              s.state.status = "needs_input"; s.state.phase = "grading"; s.state.questions = open; s.state.live = null; s.state.updatedAt = now();
              await host.account(s, s.state.input.accountId).jobUpdate({ jobId, status: "needs_input" });
            });
            const message = await step.queue.next("answer", { names: ["answers"] });
            const next = await step.step("apply", async s => {
              const grades = { ...got.grades }, problems: string[] = [];
              for (const question of open) {
                const answer = message.body.answers[question.id];
                if (answer === undefined) continue;
                const read = readGrade(answer);
                if (read) grades[question.id] = read;
                else problems.push(`${question.id}: answer good or bad, with an optional note after a colon, such as "bad: <why>"`);
              }
              s.state.questions = []; s.state.status = "running"; s.state.phase = "ranking"; s.state.updatedAt = now();
              s.state.notices = [...s.state.notices.filter(notice => !notice.startsWith("Answer not used: ")), ...problems.map(problem => `Answer not used: ${problem}`)];
              await host.account(s, s.state.input.accountId).jobUpdate({ jobId, status: "running" });
              return { grades, by: message.body.by ?? got.by };
            });
            return Loop.continue(next);
          },
        });
        return { grades: questions.map((question, index): SampleGrade => ({ sampleId: samples[index]!.id, ...graded.grades[question.id]! })), by: graded.by };
      };
      /** Writes the eval again from a round's grades: only the cases they dispute change, then the loop runs the trial again. */
      const revise = async (artifact: NonNullable<LoopState["artifact"]>, grades: SampleGrade[], round: number, suffix: string) => {
        if (round >= MAX_ROUNDS) throw new JobStop("done", "not_accepted", `After ${MAX_ROUNDS} rounds of grading, the eval still disagrees with your grades, so it is not accepted and no model is recommended. Run the task again to start over.`, { kind: "rerun" });
        const disputed = disputedCases(artifact, grades);
        const from = { bundle, cases, usable };
        const revised = await ctx.step({
          name: `revise${suffix}`, timeout: 0, maxRetries: INTERRUPTIONS,
          run: async s => {
            s.state.phase = "cases"; s.state.live = null; s.state.updatedAt = now();
            const account = host.account(s, s.state.input.accountId);
            const { config, fetch } = host.settings();
            let value;
            try {
              // A self-hosted server's OpenMerit Harness rewrites the eval when it is connected. Otherwise the reviser
              // and the case writer run on OpenMerit's key, metered in the job's ledger under this round's keys.
              const own = config.mode === "self-hosted" ? await (await host.memberWriter(s, s.state.input.userId ?? null))?.open(s.abortSignal, from.bundle.output.kind === "json") : undefined;
              let harness = own?.harness;
              if (!harness) {
                const index = catalogueIndex(await host.catalogue(s));
                const writer = createClient(await keysFor(jobId, account, projectId), { fetch, model: model => index.find(model), timeoutMs: 600_000 });
                harness = completeHarness(completeWith(writer, { endpoint: OPENROUTER, model: config.models.caseWriter }, jobLedger(account, jobId), `${jobId}/revise-r${round}`, s.abortSignal));
              }
              value = await reviseEval({ bundle: from.bundle, cases: from.usable }, feedbackOf(artifact, grades), harness, s.abortSignal, disputed);
            } catch (error) {
              if (s.abortSignal.aborted) throw error;
              return { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) };
            }
            // The examples and their labels stay, and so do the written cases the grades did not dispute; the disputed ones are
            // written again, from the person's grades, which stand in for the label check.
            const next = [...from.cases.filter(item => item.origin === "example"), ...value.cases.filter(item => item.origin !== "example").map(item => ({ ...item, approved: true }))];
            const keptIds = new Set(from.usable.filter(item => item.origin !== "example").map(item => item.id));
            const fresh = next.filter(item => item.origin !== "example" && !keptIds.has(item.id)).length;
            const spec = specOf(value.bundle);
            // It is accepted once the person agrees with it, as version 1; until then it lives in this job.
            s.state.notices.push(`OpenMerit wrote the eval again from your grades of round ${round}.`);
            s.state.notices.push(`It wrote ${fresh} new case${fresh === 1 ? "" : "s"} in place of the ones you disputed and kept the other ${next.length - fresh} as they were.`);
            return { spec, cases: next };
          },
        });
        if ("error" in revised) throw new JobStop("failed", "failed", `Writing the eval again from your grades failed: ${revised.error}`, { kind: "rerun" });
        bundle = { ...sent, ...revised.spec }; cases = revised.cases;
        ({ invalid, usable, caseIds, kinds, counts } = casesOf(cases));
        loop = advanceLoop(loop, { type: "regenerated" });
      };
      /** The answers a person agreed with when the eval was accepted, which it keeps; `by` is who graded them. */
      let keptGrades: EvalGrade[] = [], acceptedBy: string | null = null, unsampled = false;
      const toKept = (samples: readonly Sample[], grades: readonly SampleGrade[]): EvalGrade[] => samples.map((sample, index) => ({
        caseId: sample.caseId, model: sample.model, output: sample.output, toolCalls: sample.toolCalls, verdict: grades[index]!.verdict, ...(grades[index]!.note ? { note: grades[index]!.note } : {}),
      }));
      let evaluated: Awaited<ReturnType<typeof rank>>;
      for (;;) {
        while (grade && loop.status !== "accepted") {
          const round = loop.round, suffix = round === 1 ? "" : `-r${round}`;
          const samples = await trial();
          // No answer to grade: the eval is accepted as a first run's is without grading.
          if (!samples.length) { unsampled = true; break; }
          loop = advanceLoop(loop, { type: "tried", artifact: { samples } });
          const { grades, by } = await askGrades(suffix);
          const artifact = loop.artifact!;
          loop = advanceLoop(loop, { type: "graded", grades });
          if (loop.status === "accepted") { keptGrades = toKept(samples, grades); acceptedBy = by; }
          else await revise(artifact, grades, round, suffix);
        }
        // The search, on the eval a person accepted: on the wide pool once the bar is the criteria.
        if (loop.bar === "criteria" && !widened) { models = await poolStep("models-criteria", true); pool = models.pool as Pool; widened = true; }
        evaluated = await rank(loop.round, loop.bar);
        // The spot-check: a person who just accepted this eval sees a few of the pick's answers before it is recommended. One that
        // looks wrong means the eval let a weaker model pass: it is disputed, as a trial's would be, and the eval is fixed and searched again.
        if (!grade || unsampled) break;
        const pick = taskResult(evaluated, describe, describe(current), rules).pick;
        const answers = pick ? finalAnswers.get(optionOf(pick).key) : undefined;
        if (!pick || !answers?.length) break;
        const round = loop.round + 1, suffix = `-r${round}`;
        const samples = pickSamples([{ model: pick.model, role: "candidate", answers }], SPOT_CHECK);
        loop = { ...loop, round, status: "grading", artifact: { round, evalVersion: loop.evalVersion, samples } };
        const { grades, by } = await askGrades(suffix);
        const artifact = loop.artifact!;
        loop = advanceLoop(loop, { type: "graded", grades });
        if (loop.status === "accepted") { keptGrades = [...keptGrades, ...toKept(samples, grades)]; acceptedBy = by ?? acceptedBy; break; }
        await revise(artifact, grades, round, suffix);
        progress = newProgress<Option>(); failedCases.clear(); finalAnswers.clear();
      }
      if (grade) {
        const suffix = loop.round === 1 ? "" : `-r${loop.round}`;
        evalVersion = unsampled ? await acceptFirst(`eval${suffix}`, written.source, loop.bar, null) : await acceptFirst(`accept${suffix}`, "grading", loop.bar, acceptedBy);
        if (!unsampled) {
          const accepted = { version: evalVersion, barSet: loop.barSet ?? null, grades: keptGrades };
          await ctx.step(`accepted${suffix}`, async s => {
            const set = accepted.barSet;
            s.state.notices.push(`You accepted the eval as version ${accepted.version}.${set ? ` In round ${set.round} you graded the current model's answer${set.cases.length === 1 ? "" : "s"} to ${set.cases.join(", ")} as wrong, so models are measured against the eval's checks instead of against the current model's score, and the cheapest that meets them is recommended even when it costs more.` : ""}`);
            // The grades stay with this version: later runs grade the same answers again, and say when the eval disagrees with you.
            await host.account(s, s.state.input.accountId).saveEvalGrades({ taskId, version: accepted.version, grades: accepted.grades });
          });
        }
      }

      // The floor: the current model fails too much of its own eval for it to rank anything. A result, not a failure: it says why, with the failed cases.
      if (evaluated.status === "below_floor") {
        throw new JobStop("done", "below_floor", floorNote(evaluated.baseline, current.model),
          { kind: "ask_agent", prompt: `OpenMerit's eval for the task "${bundle.task}" could not tell models apart: ${current.model}, the model it uses now, failed too many of its cases. Show the user the failed cases and their reasons from openmerit_result, fix the task bundle's criteria, guardrails or examples with them, then call openmerit_recommend again.` });
      }
      if (evaluated.status === "too_few_reliable") {
        const runs = evaluated.baseline.runs.length;
        throw new JobStop("stopped", "baseline_failed", !evaluated.baseline.passes
          ? `${current.model} passed none of the ${caseIds.length} cases, so there is nothing to compare against. Check the labels.`
          : `${current.model} passed only ${evaluated.reliable.length} of the ${caseIds.length} cases in ${runs === 1 ? "its first run" : `every one of its ${runs} runs`}; OpenMerit screens candidates on ${SAMPLE_SIZE} cases it passes. Check the labels, or add examples it gets right.`,
        { kind: "ask_agent", prompt: `${current.model}, the model the task "${bundle.task}" uses now, failed most of OpenMerit's test cases, so their expected answers may be wrong. Show the user the expected answers in the task bundle's examples, correct the wrong ones with them, and add examples the current model gets right; then call openmerit_recommend again.` });
      }
      // The result, the Top 3, the near misses and the pick are openmerit/engine's, as the CLI's are.
      const result = taskResult(evaluated, describe, describe(current), rules);
      const baseline = measuredModel(result.baseline);
      const candidates = listed(result.candidates);
      const top = result.top.map(measuredModel), cheaper = result.cheaper.map(measuredModel), nearMisses = result.nearMisses.map(measuredModel);
      // Against the criteria, a current model that misses them is replaced by a model that meets them, whatever it costs.
      const switches = result.failedChecks?.length ? top : cheaper;
      const notices: string[] = [], fixes: Fix[] = [];
      const { ended } = evaluated;
      if (evaluated.ungradable.length) notices.push(ungradableNotice(evaluated.ungradable));
      if (ended && !ended.provisional) {
        const notice = `${ended.left.length === 1 ? "Challenger" : "Challengers"} not measured: ${ended.left.map(item => item.model).join(", ")}. ${ended.reason}`;
        notices.push(notice); fixes.push(...tie(endedFix, notice));
      }
      const picked = provisional;
      if (picked && evaluated.provisionalTried) {
        const tried = evaluated.candidates.find(item => item.option.key === picked.key);
        if (ended?.provisional) fixes.push(...tie(endedFix, `The provisional pick ${picked.model} was not measured. ${ended.reason}`));
        notices.push(ended?.provisional ? `The provisional pick ${picked.model} was not measured. ${ended.reason}`
          : tried?.status === "screened_out" ? `The provisional pick ${picked.model} was screened too, and missed ${tried.total - tried.passes} of its ${tried.total} screening case runs.`
          : tried?.status === "measured" ? `The provisional pick ${picked.model} was measured on every case too${tried.qualified ? "" : ", and did not qualify"}.`
          : `The provisional pick ${picked.model} could not be measured${tried?.reason ? `: ${tried.reason}` : ""}.`);
      }
      const challenging = [...evaluated.challenged, ...(picked && evaluated.provisionalTried ? [picked] : [])];

      // 5. Agent eval: when the task is an agent (it offers tools, so it can take several model calls) or belongs to one,
      // the engine's rule checks the pick, then the next cheaper models. An agent task's own cases run end to end in
      // Pi, each graded on its whole transcript; a group of tasks runs its agent cases, which no source provides yet.
      let chosen = result.pick ? measuredModel(result.pick) : null;
      let agentEval: AgentEvalSummary | null = null;
      const usesTools = !!bundle.tools?.length;
      // The customer's eval command already runs the whole task, tools and all, so it is the agent eval too.
      if (chosen && !command && (input.agent !== null || usesTools)) {
        await ctx.step("agent-eval-start", async s => { s.state.phase = "agent_eval"; s.state.live = null; s.state.updatedAt = now(); });
        const grouped = input.agent === null ? null : host.settings().agentEval({ accountId: input.accountId, environment: input.environment, agent: input.agent });
        const current = pool.baseline!;
        type AgentMeasure = (assignment: ReadonlyMap<string, { model: string; endpoint: string }>, key: string, account: JobAccount) => Promise<AgentRun>;
        const agentMeasure: AgentMeasure | null = grouped ? assignment => grouped(assignment) : usesTools ? async (assignment, key, account) => {
          const { client, grader } = await grading(account);
          const run = createMeasure({ bundle, cases: usable, client, grader: flow(grader), ledger: jobLedger(account, jobId), key });
          try {
            return await run(assignment.get(bundle.task) ?? { model: current.endpointModel, endpoint: current.endpoint }, caseIds);
          } catch (error) {
            // A refused budget leaves the option unchecked, so it is not accepted.
            if (error instanceof BudgetRefused) return { results: [], costUsd: 0 };
            throw error;
          }
        } : null;
        let agentCounter = 0;
        const checked = await checkAgent({
          tasks: [{ task: bundle.task, options: switches.map(item => ({ key: `${item.endpoint} ${item.model}`, savingUsd: (baseline.costPerCallUsd ?? 0) - (item.costPerCallUsd ?? 0), item })) }],
          measure: agentMeasure ? assignment => ctx.step({
            name: `agent-${++agentCounter}`, timeout: 0, maxRetries: INTERRUPTIONS,
            run: async s => agentMeasure(new Map([...assignment].map(([task, option]) => [task, { model: option.item.endpointModel, endpoint: option.item.endpoint }])), `${jobId}/agent-${agentCounter}`, host.account(s, input.accountId)),
          }) : null,
          ...(guardrails.effective.minAgentPassRate !== undefined ? { minPassRate: guardrails.effective.minAgentPassRate } : {}),
          ...(guardrails.effective.agentEvalRequired ? { required: guardrails.effective.agentEvalRequired } : {}),
        });
        chosen = checked.proposed[0]?.option.item ?? null;
        agentEval = {
          status: checked.status, passed: chosen !== null, warning: checked.warning ?? null, baseline: checked.baseline ? { passes: checked.baseline.passes, total: checked.baseline.total } : null,
          tried: checked.tasks.flatMap(item => item.tried.map(attempt => ({ model: attempt.option.item.model, passes: attempt.score.passes, total: attempt.score.total, passed: attempt.passed }))),
        };
        if (checked.warning) notices.push(checked.warning);
        // Without an agent eval, a required one blocks every switch; the agent's guardrail can allow switches with a warning instead.
        if (checked.warning && checked.status === "missing" && guardrails.effective.agentEvalRequired === "required") {
          fixes.push({ kind: "open", notice: checked.warning, label: "Review guardrails", path: `/guardrails/?level=agent&id=${encodeURIComponent(`${input.environment}:${input.agent}`)}` });
        }
      }

      // 6. Action: the edit and the report.
      await ctx.step({
        name: "action", timeout: 60_000,
        run: async s => {
              const account = host.account(s, input.accountId);
          const spent = await account.spent({ jobId });
          const index = catalogueIndex(await host.catalogue(s));
          const jobStatus: JobResult["status"] = chosen ? "picked" : agentEval && switches.length ? "agent_eval_failed" : !pool.ranked.length && !pool.unplaced.length ? "no_candidates" : "keep_current";
          const report: JobResult = {
            failedCases: failedOf(), baselineByKind: evaluated.baseline.byKind, invalidCases: invalid,
            status: jobStatus, top, nearMisses, baseline, candidates,
            pick: chosen ? pickOf(chosen, baseline, spent.openmeritUsd + spent.customerUsd) : null,
            search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: result.samples, finalists: result.finalists, challengers: challenging.map(item => item.model), shortfall: result.searchShortfall },
            agentEval, edit: chosen ? proposeEdit(bundle, optionOf(chosen), pool.baseline!.endpoint, index.find) : { edits: [], instructions: null },
            // The quality rule over the bundle's evidence, and the approval question both hosts ask.
            basedOn: [...basedOn(strongest(mergeEvidence(bundle.task, bundle.current.model, [agentBundle({ bundle, baselineEndpoint: pool.baseline!.endpoint, find: index.find }).evidence(), caseEvidence(bundle, usable), ...(command ? [evalEvidence({ command: redact(command.command) })] : [])]))), ...[checksBasedOn(bundle)].filter((line): line is string => line !== null)],
            approval: chosen ? approvalQuestion(bundle.task, bundle.current.model, chosen) : null,
            spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices: [...s.state.notices, ...notices], fixes: [...(s.state.fixes ?? []), ...fixes],
            reportUrl: `${host.settings().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts, ...(evalVersion === null ? {} : { evalVersion }),
            ...(grade || acceptedBar === "criteria" ? { grading: { rounds: grade ? loop.round : 0, accepted: grade ? loop.status === "accepted" : true, bar: loop.bar, failedChecks: result.failedChecks ?? [], summary: result.summary ?? null, barSet: loop.barSet ?? null } } : {}),
          };
          await finish(s, host, jobId, "done", report, null);
        },
      });
    } catch (error) {
      if (!(error instanceof JobStop)) throw error;
      const stop = error;
      await ctx.step("stop", async s => {
          const spent = await host.account(s, s.state.input.accountId).spent({ jobId });
        const result = stop.resultStatus ? partial!(stop.resultStatus, [...s.state.notices, stop.message], [...(s.state.fixes ?? []), ...tie(stop.fix, stop.message)], spent) : null;
        await finish(s, host, jobId, stop.status, result, stop.status === "failed" ? stop.message : null, stop.message);
      });
    }
  } catch (error) {
    // A step that failed for good: record the job as failed instead of leaving it running. A later wake replays to here and changes nothing.
    if (!(error instanceof Error && (error.name === "StepExhaustedError" || error.name === "CriticalError"))) throw error;
    const message = redact(error.message).slice(0, 500);
    await ctx.step("failed", async s => {
      const spent = await host.account(s, s.state.input.accountId).spent({ jobId });
      const notice = `The job failed and stopped measuring: ${message}. Nothing is charged for it; call openmerit_recommend again to retry.`;
      await finish(s, host, jobId, "failed", partial?.("failed", [...s.state.notices, notice], [...(s.state.fixes ?? []), { kind: "rerun", notice }], spent) ?? null, message, notice);
    });
  }
}

/**
 * Records the job's end in its state, the account (which counts the evaluation) and the task, and
 * sends run_completed. It is sent only on the transition from a live status to a terminal one, after
 * every write above succeeded: a step that runs again after a failed write sends it then, and one
 * replayed after its state was saved finds the job already ended and sends nothing.
 */
async function finish<S extends JobStepContext>(s: S, host: JobHost<S>, jobId: string, status: "done" | "stopped" | "failed", result: JobResult | null, error: string | null, notice?: string): Promise<void> {
  const { input } = s.state;
  if (result) {
    const markdown = renderMarkdown({ jobId, bundle: input.bundle, result, provisional: input.provisional, createdAt: input.createdAt });
    await host.account(s, input.accountId).saveReport({ jobId, taskId: input.taskId, json: { jobId, task: input.bundle.task, createdAt: input.createdAt, ...result }, markdown });
  }
  await host.task(s, input.accountId, input.taskId).recordResult({ jobId, status, result });
  await host.account(s, input.accountId).jobUpdate({ jobId, status, measured: status === "done" });
  const ended = TERMINAL.has(s.state.status);
  s.state.status = status; s.state.phase = "done"; s.state.result = result; s.state.error = error; s.state.questions = []; s.state.live = null; s.state.updatedAt = now();
  if (notice && !result) s.state.notices.push(notice);
  forgetJob(jobId);
  if (!ended) host.completed(s, status);
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "stopped", "failed"]);
