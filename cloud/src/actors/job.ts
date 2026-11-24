// The job actor: one Rivet workflow per job, keyed by its job ID.
//
//   Source ▶ Cases (label check: wait for answers) ▶ Models ▶ Ranking ▶ Agent eval ▶ Action
//
// Every step is recorded, so a crash or a deploy resumes at the first unfinished step, and a job that
// waits on a question sleeps on its queue until openmerit_answer sends the answers. Each measure call
// is its own step. Rivet runs a step again when its result was not recorded, so model calls are not
// exactly-once, but each one reserves and settles under a key made of the job, the step, the
// candidate and the case (openmerit/ranking's `createMeasure` keys): a replayed step finds its keys
// in the account's ledger and counts no spend twice.
//
// Endpoint keys reach the job from the account actor and stay in this process's memory; they are
// never in step results or actor state, which are on disk.
import { createHash, randomInt } from "node:crypto";
import { CriticalError, Loop, StepExhaustedError, workflow } from "@rivet-dev/workflows";
import { queue } from "rivetkit";
import { applyLabelCheck, BudgetRefused, caseKind, checksBasedOn, completeWith, createClient, createMeasure, flow, graderFor, invalidCases, labelCheck, LABEL_CHECK_QUESTION, writeCases, WRITTEN_CASES, type Case, type Complete, type EndpointConfig, type MeasureResult, type TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import { approvalQuestion, basedOn, mergeEvidence, strongest } from "../engine.ts";
import { baselineResult, byKind, floorNote, CandidateUnavailable, catalogueIndex, CHALLENGERS, checkAgent, DEFAULT_REPEATS, EndChallengers, evaluateTask, FINALISTS, modelResult, newProgress, redact, SAMPLE_SIZE, score, taskResult, type AgentRun, type CatalogueModel, type Ledger, type ModelResult, type ResolvedGuardrails } from "../engine.ts";
import { agentBundle, caseEvidence } from "../../../openmerit-core/src/connectors/agent-bundle.ts";
import { advanceLoop, completeHarness, criteriaOf, feedbackOf, gradeQuestions, MAX_ROUNDS, pickSamples, readGrade, reviseEval, startLoop, type CaseAnswer, type LoopState, type SampleGrade } from "../../../openmerit-core/src/eval/loop.ts";
import { buildPool, OPENROUTER, regionNotice, type Option, type Pool, type Provisional } from "../pool.ts";
import { DEFAULT_PROJECT, JOB_BUDGET, specOf, type EvalBar, type EvalSource } from "./account.ts";
import { proposeEdit, renderMarkdown, type AgentEvalSummary, type Fix, type JobResult, type MeasuredModel } from "../report.ts";
import { capture } from "../analytics.ts";
import { services } from "../services.ts";
import { PROVIDER_NAMES, subscriptionWriter } from "../subscriptions.ts";
import { redactBundle, taskIdFor } from "../start.ts";
import type { AppClient, Registry } from "../registry.ts";

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
  /** Absent on jobs started before projects, which are all in the default project. */
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

type AccountHandle = ReturnType<AppClient["account"]["getOrCreate"]>;

function keysFor(jobId: string, account: AccountHandle, projectId: string): Promise<EndpointConfig[]> {
  let keys = endpointKeys.get(jobId);
  if (!keys) {
    keys = account.endpointSecrets(projectId).catch((error: unknown) => { endpointKeys.delete(jobId); throw error; });
    endpointKeys.set(jobId, keys);
  }
  return keys;
}

/** The account's ledger for one job. Keys come from openmerit/ranking and already start with the job ID. */
const jobLedger = (account: AccountHandle, jobId: string): Ledger => ({
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

export const job = workflow({
  createState: (_c, input: JobInput): JobState => ({
    input, status: "queued", phase: "source", questions: [], notices: [], progress: { measured: 0, planned: null }, result: null, error: null, updatedAt: now(),
  }),
  // `by` is the Clerk user who sent the answers, when the sender knows it: a grade's author.
  queues: { answers: queue<{ answers: Answers; by?: string | null }>() },
  run: async ctx => {
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
          const account = s.client<Registry>().account.getOrCreate([input.accountId]);
          const guardrails = await account.resolveGuardrails({ projectId: input.projectId ?? DEFAULT_PROJECT, environment: input.environment, agent: input.agent, taskId: input.taskId });
          const { effective } = guardrails;
          await account.jobUpdate({ jobId, status: "running", budgetUsd: effective.budgetUsd ?? services().config.limits.defaultJobBudgetUsd, capOpenmeritUsd: effective.spendCapUsd ?? null, capCustomerUsd: effective.customerSpendCapUsd ?? null });
          s.state.status = "running"; s.state.phase = "cases"; s.state.updatedAt = now();
          return { bundle, guardrails, accountId: input.accountId, projectId: input.projectId ?? DEFAULT_PROJECT, environment: input.environment, agent: input.agent, provisional: input.provisional };
        },
      });
      const { guardrails } = source as { guardrails: ResolvedGuardrails };
      const sent = (source as { bundle: TaskBundle }).bundle;
      // A job recorded before projects has no projectId in its source step: it is in the default project.
      const projectId = (source as { projectId?: string }).projectId ?? DEFAULT_PROJECT;
      const input = { accountId: source.accountId, environment: source.environment, agent: source.agent };
      const taskId = taskIdFor(projectId, input.environment, sent.task);
      const budgetUsd = guardrails.effective.budgetUsd ?? services().config.limits.defaultJobBudgetUsd;
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
      const step = await ctx.step({
        name: "cases", timeout: 0, maxRetries: INTERRUPTIONS,
        run: async s => {
          const { accountId, taskId } = s.state.input;
          const client = s.client<Registry>();
          const task = client.task.getOrCreate([accountId, taskId]);
          const current = await client.account.getOrCreate([accountId]).evalFor(taskId);
          if (current) {
            const known = new Set(current.cases.map(item => caseKey(item.input)));
            const added = (await writeCases({ bundle: sent, complete: async () => "", count: 0 })).cases.filter(item => item.origin === "example" && !known.has(caseKey(item.input)));
            if (added.length) s.state.notices.push(`${added.length} example${added.length === 1 ? "" : "s"} the coding agent sent ${added.length === 1 ? "is" : "are"} not in the accepted eval, so the run did not use ${added.length === 1 ? "it" : "them"}: revise the eval in the app to add ${added.length === 1 ? "it" : "them"}.`);
            const differs = JSON.stringify(specOf(sent)) !== JSON.stringify(current.spec);
            if (differs) s.state.notices.push(`The run used the criteria of accepted eval version ${current.version}, not the ones the coding agent sent: the eval in the app is the one to edit.`);
            return { cases: current.cases, version: current.version, spec: current.spec, source: "app" as EvalSource, bar: current.bar };
          }
          const [saved, approved] = await Promise.all([task.labels(), task.written()]);
          const { config, fetch } = services();
          let complete: Complete = async () => "";
          let count = 0;
          // The member who started the run may write its cases on their own Claude or ChatGPT subscription.
          // When that sign-in cannot be used, the job says so and writes them on OpenMerit's key.
          const userId = s.state.input.userId ?? null;
          const mine = approved === null && userId ? await client.user.getOrCreate([userId]).writer().catch((error: unknown) => {
            const notice = `Your subscription did not write the cases (${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}): OpenMerit's key wrote them.`;
            s.state.notices.push(notice);
            s.state.fixes = [...(s.state.fixes ?? []), { kind: "open", label: "Account settings", path: "/account/", notice }];
            return null;
          }) : null;
          let writtenBy: string | null = null;
          let source: EvalSource = approved === null ? "examples" : "openmerit";
          if (mine) {
            source = mine.provider;
            const writer = await subscriptionWriter(mine.provider, mine.credential, config.subscriptions, s.abortSignal);
            complete = writer.complete;
            count = WRITTEN_CASES;
            writtenBy = `${PROVIDER_NAMES[mine.provider]} (${writer.model}) wrote the cases, on the subscription of the member who started the run.`;
          } else if (approved === null && config.openrouter.apiKey) {
            const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
            const account = client.account.getOrCreate([accountId]);
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
      const written = Array.isArray(step) ? { cases: step as Case[], version: null, spec: null, source: "openmerit" as EvalSource, bar: "current" as EvalBar } : step;
      // The bundle and cases change when the grading loop writes the eval again.
      let bundle: TaskBundle = written.spec ? { ...sent, ...written.spec } : sent;
      let cases = await ctx.loop({
        name: "label-check", state: written.cases,
        run: async (loop, current) => {
          // An accepted eval was reviewed already: its unanswered cases are left out, not asked about.
          const questions = written.version === null ? labelQuestions(bundle, current) : [];
          if (!questions.length) return Loop.break(current);
          await loop.step("ask", async s => {
            s.state.status = "needs_input"; s.state.phase = "label_check"; s.state.questions = questions; s.state.live = null; s.state.updatedAt = now();
            await s.client<Registry>().account.getOrCreate([s.state.input.accountId]).jobUpdate({ jobId, status: "needs_input" });
          });
          const message = await loop.queue.next("answer", { names: ["answers"] });
          const next = await loop.step("apply", async s => {
            const applied = applyAnswers(bundle, current, message.body.answers);
            s.state.questions = []; s.state.status = "running"; s.state.phase = "cases"; s.state.updatedAt = now();
            s.state.notices = [...s.state.notices.filter(notice => !notice.startsWith("Answer not used: ")), ...applied.problems.map(problem => `Answer not used: ${problem}`)];
            const labels = Object.fromEntries(applied.cases.filter(item => item.origin === "example" && (item.expected !== undefined || item.approved === false)).map(item => [caseKey(item.input), { expected: item.expected, approved: item.approved !== false }]));
            const task = s.client<Registry>().task.getOrCreate([s.state.input.accountId, s.state.input.taskId]);
            await task.saveLabels(labels);
            const kept = applied.cases.filter(item => item.origin === "written" && item.approved === true);
            if (message.body.answers[LABEL_CHECK_QUESTION] !== undefined && kept.length) await task.saveWritten(kept);
            await s.client<Registry>().account.getOrCreate([s.state.input.accountId]).jobUpdate({ jobId, status: "running" });
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

      // The grading loop: in a task's first run, a person started, on cases OpenMerit wrote, a person grades sampled answers
      // after each search (openmerit-core's eval/loop.ts, as the CLI's Scout does), and that is the review that accepts the
      // eval. Where they and the eval disagree, OpenMerit writes the eval again and searches again; once they agree on every
      // answer, the run accepts it as version 1. Jobs that had passed this point before the loop existed accept it here, as they began.
      const gradingVersion = await ctx.getVersion("grading-loop", 2);
      const grade = gradingVersion === 2 && await ctx.step("grading", async s =>
        s.state.input.kind === "run" && written.version === null && usable.some(item => item.origin === "written") && !!services().config.openrouter.apiKey);
      /** Accepts a first run's eval as version 1, as the job measures it, and records the version the job ran on. */
      const acceptFirst = (name: string, source: EvalSource, bar: EvalBar, by: string | null) => ctx.step({
        name, timeout: 60_000,
        run: async s => {
          const account = s.client<Registry>().account.getOrCreate([s.state.input.accountId]);
          const version = written.version ?? await account.acceptFirstEval({ taskId, projectId, bundle: sent, spec: specOf(bundle), cases, source, by: by ?? s.state.input.userId ?? null, bar });
          await account.setJobEval({ jobId, version });
          return version;
        },
      });
      // Without grading, a first run's cases, as the label check left them, are the eval it accepts as version 1. A graded run accepts it once the person agrees.
      let evalVersion: number | null = grade ? null : await acceptFirst("eval", written.source, written.bar ?? "current", null);
      /** The current model's failed cases and why, from its recorded measure steps, so a replay rebuilds the same. */
      const failedCases = new Map<string, { caseId: string; kind: string; reason: string }>();

      // 3. Models: the ECI-ordered pool over every allowed endpoint. A wide pool, for the criteria bar, takes every eligible model whatever its price.
      // An eval a person accepted against the criteria keeps that bar in later runs, watch jobs among them.
      const acceptedBar: EvalBar = written.bar ?? "current";
      const poolStep = (name: string, wide: boolean) => ctx.step({
        name, timeout: 60_000,
        run: async s => {
          const client = s.client<Registry>();
          const catalogue = await client.catalogue.getOrCreate(["global"]).get();
          const endpoints = await client.account.getOrCreate([s.state.input.accountId]).endpointsForJob(projectId);
          const built = buildPool({ catalogue, endpoints, bundle, guardrails: guardrails.effective, wide });
          // The catalogue entries the job's calls are priced by, by the name each endpoint calls the model, so every step prices on this version.
          const index = catalogueIndex(catalogue);
          const priced: Record<string, CatalogueModel> = {};
          for (const option of [built.baseline, ...built.ranked, ...built.unplaced]) {
            const model = option?.inCatalogue ? index.find(option.model) : null;
            if (option && model) priced[option.endpointModel] = model;
          }
          const judgeModel = index.find(services().config.models.judge);
          if (judgeModel) priced[services().config.models.judge] = judgeModel;
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
          if (region && built.notices.includes(region)) s.state.fixes = [...(s.state.fixes ?? []), { kind: "open", notice: region, label: "Add an endpoint", path: "/project/" }];
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
      const rules = { threshold: minPassRate ? minPassRate - 1e-9 : null, maxLatencyMs: Number.isFinite(maxLatency) ? maxLatency : null };
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
        reportUrl: `${services().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts, ...(evalVersion === null ? {} : { evalVersion }),
      });
      /** The job's model client, and the grader the bundle's output calls for. */
      const grading = async (account: AccountHandle) => {
        const { config, fetch } = services();
        const client = createClient(await keysFor(jobId, account, projectId), { fetch, model: model => models.priced[model] ?? null });
        // Text answers go to a fixed judge on OpenMerit's key. Its calls count in the job's spend but not in the candidate's cost per call.
        // The rubric is the task's own (rubricFor), with one check per criterion and guardrail of its spec.
        const judge = (bundle.output.kind === "text" || bundle.guardrails?.length) && config.openrouter.apiKey ? { client, endpoint: OPENROUTER, model: config.models.judge } : undefined;
        return { client, grader: graderFor(bundle, judge ? { judge } : {}) };
      };
      let counter = 0;
      /** How many measure steps the job takes in all, once the search knows its size. Set outside steps, from the step count, so a replay sets the same. */
      let plannedTotal: number | null = null;
      /**
       * One measure call as one workflow step: each repeat and each screen is its own step. Its ledger keys
       * start with the job and the step, so a replay reuses them; a retry after an error is a deliberate
       * repeat, with its own keys. `keep` keeps the run's answers for the grading loop: the step's result
       * is recorded, so they are redacted and cut short here, as the samples are.
       */
      const measure = (option: Option, ids: string[], keep = false): Promise<Measured> => {
        const name = `measure-${++counter}`;
        const against = option !== pool.baseline && progress.baseline.length ? score(progress.baseline).score : null;
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
              done: 0, total: ids.length, passes: 0, history: [], minutesLeft: left,
            };
            s.state.live = live;
            const account = s.client<Registry>().account.getOrCreate([s.state.input.accountId]);
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
                const result = await run({ model: option.endpointModel, endpoint: option.endpoint }, ids, { run: String(attempt - 1) });
                done(s);
                return { kind: "ok" as const, ...result, ...(keep ? { answers: ids.flatMap(id => answers.filter(answer => answer.caseId === id)) } : {}) };
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
        if (policy === 1) throw new JobStop("failed", "failed", "The job started measuring before a deploy changed how OpenMerit measures, so it cannot resume. Nothing is charged for it; call openmerit_recommend again to rerun it.", { kind: "rerun" });
        if (!usable.length) throw new JobStop("stopped", "no_cases", "No case has a known correct answer. Add examples with expected answers to the bundle, or answer the label check.",
          { kind: "ask_agent", prompt: `OpenMerit found no test case with a known correct answer for the task "${bundle.task}". Add examples with their expected answers to its task bundle, taken from the code's tests or fixtures, then call openmerit_recommend again.` });
        if (!pool.baseline) throw new JobStop("failed", "baseline_failed", "No endpoint can run the current model: OpenMerit's OpenRouter key is not configured, and no endpoint of yours serves it.", { kind: "open", label: "Add an endpoint", path: "/project/" });
        const current = pool.baseline;

        /** Each option's answers on its first full run of the round, for the samples. */
        const answersOf = new Map<string, CaseAnswer[]>();

        // 4. Ranking: openmerit/engine's evaluateTask, the policy the CLI runs too. Each of its measure calls is one step.
        // The agent was told the provisional pick: when no measured model beats the current one per call, it is measured before keeping the current model.
        let provisional = null as Option | null;
        const rank = (round: number, bar: LoopState["bar"]) => {
          provisional = (told && [...pool.ranked, ...pool.unplaced].find(item => item.model === told.model && item.endpoint === told.endpoint)) || null;
          return evaluateTask<Option>({
            ladder: pool.ranked, unplaced: pool.unplaced, strength: item => item.eci ?? -Infinity, items: caseIds, repeats, provisional,
            rules, kinds,
            baselinePrice: current.price, progress,
            // Against the criteria, a model qualifies when it meets the eval's checks, whatever the current model scored.
            criteria: bar === "criteria" ? criteriaOf(bundle, guardrails.effective.criteriaPassRate) : null,
            measure: async (option, items, call) => {
              const target = option ?? current;
              if (call.provisional && call.role === "screen") plannedTotal = counter + 1 + repeats;
              const result = await measure(target, [...(items ?? caseIds)], grade && call.role !== "screen" && call.repeat === 1);
              if (result.kind === "unavailable") {
                if (!option) throw new JobStop("stopped", "baseline_failed", `${current.model} could not run: ${result.reason}`, { kind: "rerun" });
                throw new CandidateUnavailable(result.reason);
              }
              if (result.kind !== "ok") {
                const stop = stopFor(result, option ? target.model : `the current model ${current.model}`);
                // The finalists are measured, so a challenger the budget refuses, or one that fails, ends the challengers only.
                if (call.stage === "challenger") { endedFix = stop.fix; throw new EndChallengers(stop.message); }
                throw stop;
              }
              if (!option) for (const item of result.results) if (!item.pass && item.reason && !failedCases.has(item.caseId)) failedCases.set(item.caseId, { caseId: item.caseId, kind: kinds[item.caseId] ?? "case", reason: item.reason });
              if (result.answers && !answersOf.has(target.key)) answersOf.set(target.key, result.answers);
              // The checks a failed case missed, for the criteria bar (meetsCriteria).
              const checks = Object.fromEntries(result.results.flatMap(item => (item.failedChecks?.length ? [[item.caseId, item.failedChecks]] : [])));
              return { items: Object.fromEntries(result.results.map(item => [item.caseId, item.pass])), checks, costUsd: result.costUsd, costIsEstimate: result.costIsEstimate, latencyMs: result.latencyMs };
            },
            // Drawn in a recorded step, so a replay screens on the same cases.
            sample: (reliable, count) => ctx.step(round === 1 ? "samples" : `samples-r${round}`, async () => {
              const left = [...reliable], picked: string[] = [];
              for (let index = 0; index < count; index++) picked.push(left.splice(randomInt(left.length), 1)[0]!);
              return picked;
            }),
            on: {
              // The search is done: the finalists' runs and the challengers are left.
              searched: search => { plannedTotal = counter + search.finalists.length * repeats + (Math.min(CHALLENGERS, pool.ranked.length) + pool.unplaced.length) * (1 + repeats); },
              challengers: options => { plannedTotal = counter + options.length * (1 + repeats); },
            },
          });
        };
        let loop: LoopState = startLoop(1, acceptedBar);
        let evaluated = await rank(1, loop.bar);
        let widened = acceptedBar === "criteria";
        while (grade) {
          const round = loop.round, suffix = round === 1 ? "" : `-r${round}`;
          // The answers a person grades: the current model's first run, and the pick's, else the best measured finalist's.
          const ranked = taskResult(evaluated, describe, describe(current), rules);
          const others = [...answersOf.entries()].filter(([key]) => key !== current.key);
          const rate = (answers: readonly CaseAnswer[]) => answers.filter(answer => answer.pass).length / Math.max(1, answers.length);
          const candidateKey = (ranked.pick && answersOf.has(optionOf(ranked.pick).key) ? optionOf(ranked.pick).key : null) ?? others.sort(([, a], [, b]) => rate(b) - rate(a))[0]?.[0] ?? null;
          const candidate = candidateKey ? [...pool.ranked, ...pool.unplaced].find(option => option.key === candidateKey) ?? null : null;
          const samples = pickSamples([
            { model: current.model, role: "current", answers: answersOf.get(current.key) ?? [] },
            ...(candidate ? [{ model: candidate.model, role: "candidate" as const, answers: answersOf.get(candidate.key)! }] : []),
          ]);
          // No answer to grade: the eval is accepted as a first run's is without grading.
          if (!samples.length) { evalVersion = await acceptFirst(`eval${suffix}`, written.source, loop.bar, null); break; }
          loop = advanceLoop(loop, { type: "searched", artifact: { samples } });
          const questions = gradeQuestions(bundle.task, loop);
          const graded = await ctx.loop({
            name: `grade${suffix}`, state: { grades: {} as Record<string, Omit<SampleGrade, "sampleId">>, by: null as string | null },
            run: async (step, got) => {
              const open = questions.filter(question => !got.grades[question.id]);
              if (!open.length) return Loop.break(got);
              await step.step("ask", async s => {
                s.state.status = "needs_input"; s.state.phase = "grading"; s.state.questions = open; s.state.live = null; s.state.updatedAt = now();
                await s.client<Registry>().account.getOrCreate([s.state.input.accountId]).jobUpdate({ jobId, status: "needs_input" });
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
                await s.client<Registry>().account.getOrCreate([s.state.input.accountId]).jobUpdate({ jobId, status: "running" });
                return { grades, by: message.body.by ?? got.by };
              });
              return Loop.continue(next);
            },
          });
          const grades = questions.map((question, index): SampleGrade => ({ sampleId: samples[index]!.id, ...graded.grades[question.id]! }));
          const artifact = loop.artifact!;
          loop = advanceLoop(loop, { type: "graded", grades });
          const by = graded.by;
          if (loop.status === "accepted") {
            evalVersion = await acceptFirst(`accept${suffix}`, "grading", loop.bar, by);
            const accepted = { version: evalVersion, bar: loop.bar };
            await ctx.step(`accepted${suffix}`, async s => {
              s.state.notices.push(`You accepted the eval as version ${accepted.version}${accepted.bar === "criteria" ? ": since you marked the current model's own answers wrong, models are measured against its checks, and the cheapest that meets them is recommended even when it costs more" : ""}.`);
            });
            break;
          }
          if (loop.status === "regenerating") {
            if (round >= MAX_ROUNDS) throw new JobStop("done", "not_accepted", `After ${MAX_ROUNDS} rounds of grading, the eval still disagrees with your grades, so it is not accepted and no model is recommended. Run the task again to start over.`, { kind: "rerun" });
            const from = { bundle, cases, usable };
            const revised = await ctx.step({
              name: `revise${suffix}`, timeout: 0, maxRetries: INTERRUPTIONS,
              run: async s => {
                s.state.phase = "cases"; s.state.live = null; s.state.updatedAt = now();
                const client = s.client<Registry>();
                const account = client.account.getOrCreate([s.state.input.accountId]);
                const { config, fetch } = services();
                const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
                const writer = createClient(await keysFor(jobId, account, projectId), { fetch, model: model => index.find(model), timeoutMs: 600_000 });
                // The reviser and the case writer run on OpenMerit's key, metered in the job's ledger under this round's keys.
                const complete = completeWith(writer, { endpoint: OPENROUTER, model: config.models.caseWriter }, jobLedger(account, jobId), `${jobId}/revise-r${round}`, s.abortSignal);
                let value;
                try {
                  value = await reviseEval({ bundle: from.bundle, cases: from.usable }, feedbackOf(artifact, grades), completeHarness(complete), s.abortSignal);
                } catch (error) {
                  if (s.abortSignal.aborted) throw error;
                  return { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) };
                }
                // The examples and their labels stay; the written cases are written again, from the person's grades, which stand in for the label check.
                const next = [...from.cases.filter(item => item.origin === "example"), ...value.cases.filter(item => item.origin !== "example").map(item => ({ ...item, approved: true }))];
                const spec = specOf(value.bundle);
                // It is accepted once the person agrees with it, as version 1; until then it lives in this job.
                s.state.notices.push(`OpenMerit wrote the eval again from your grades of round ${round}.`);
                return { spec, cases: next };
              },
            });
            if ("error" in revised) throw new JobStop("failed", "failed", `Writing the eval again from your grades failed: ${revised.error}`, { kind: "rerun" });
            bundle = { ...sent, ...revised.spec }; cases = revised.cases;
            ({ invalid, usable, caseIds, kinds, counts } = casesOf(cases));
            loop = advanceLoop(loop, { type: "regenerated" });
          }
          // The next round measures from scratch, on the wide pool once the bar is the criteria.
          if (loop.bar === "criteria" && !widened) { models = await poolStep("models-criteria", true); pool = models.pool as Pool; widened = true; }
          progress = newProgress<Option>(); failedCases.clear(); answersOf.clear();
          evaluated = await rank(loop.round, loop.bar);
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
        if (ended && !ended.provisional) {
          const notice = `${ended.left.length === 1 ? "Challenger" : "Challengers"} not measured: ${ended.left.map(item => item.model).join(", ")}. ${ended.reason}`;
          notices.push(notice); fixes.push(...tie(endedFix, notice));
        }
        const picked = provisional;
        if (picked && evaluated.provisionalTried) {
          const tried = evaluated.candidates.find(item => item.option.key === picked.key);
          if (ended?.provisional) fixes.push(...tie(endedFix, `The provisional pick ${picked.model} was not measured. ${ended.reason}`));
          notices.push(ended?.provisional ? `The provisional pick ${picked.model} was not measured. ${ended.reason}`
            : tried?.status === "screened_out" ? `No measured model that qualified was cheaper per call than ${current.model}, so the provisional pick ${picked.model} was screened too, and failed the ${evaluated.samples.length} sample cases.`
            : `No measured model that qualified was cheaper per call than ${current.model}, so the provisional pick ${picked.model} was measured on every case too.`);
        }
        const challenging = [...evaluated.challenged, ...(picked && evaluated.provisionalTried ? [picked] : [])];

        // 5. Agent eval: when the task is an agent (it offers tools, so it can take several model calls) or belongs to one,
        // the engine's rule checks the pick, then the next cheaper models. An agent task's own cases run end to end in
        // Pi, each graded on its whole transcript; a group of tasks runs its agent cases, which no source provides yet.
        let chosen = result.pick ? measuredModel(result.pick) : null;
        let agentEval: AgentEvalSummary | null = null;
        const usesTools = !!bundle.tools?.length;
        if (chosen && (input.agent !== null || usesTools)) {
          await ctx.step("agent-eval-start", async s => { s.state.phase = "agent_eval"; s.state.live = null; s.state.updatedAt = now(); });
          const grouped = input.agent === null ? null : services().agentEval({ accountId: input.accountId, environment: input.environment, agent: input.agent });
          const current = pool.baseline!;
          type AgentMeasure = (assignment: ReadonlyMap<string, { model: string; endpoint: string }>, key: string, account: AccountHandle) => Promise<AgentRun>;
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
              run: async s => agentMeasure(new Map([...assignment].map(([task, option]) => [task, { model: option.item.endpointModel, endpoint: option.item.endpoint }])), `${jobId}/agent-${agentCounter}`, s.client<Registry>().account.getOrCreate([input.accountId])),
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
            const client = s.client<Registry>();
            const account = client.account.getOrCreate([input.accountId]);
            const spent = await account.spent({ jobId });
            const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
            const jobStatus: JobResult["status"] = chosen ? "picked" : agentEval && switches.length ? "agent_eval_failed" : !pool.ranked.length && !pool.unplaced.length ? "no_candidates" : "keep_current";
            const report: JobResult = {
              failedCases: failedOf(), baselineByKind: evaluated.baseline.byKind, invalidCases: invalid,
              status: jobStatus, top, nearMisses, baseline, candidates,
              pick: chosen ? { model: chosen.model, endpoint: chosen.endpoint, endpointModel: chosen.endpointModel, passes: chosen.passes, total: chosen.total, costPerCallUsd: chosen.costPerCallUsd, savingPerCallUsd: baseline.costPerCallUsd !== null && chosen.costPerCallUsd !== null ? baseline.costPerCallUsd - chosen.costPerCallUsd : null } : null,
              search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: result.samples, finalists: result.finalists, challengers: challenging.map(item => item.model), shortfall: result.searchShortfall },
              agentEval, edit: chosen ? proposeEdit(bundle, optionOf(chosen), pool.baseline!.endpoint, index.find) : { edits: [], instructions: null },
              // The quality rule over the bundle's evidence, and the approval question both hosts ask.
              basedOn: [...basedOn(strongest(mergeEvidence(bundle.task, bundle.current.model, [agentBundle({ bundle, baselineEndpoint: pool.baseline!.endpoint, find: index.find }).evidence(), caseEvidence(bundle, usable)]))), ...[checksBasedOn(bundle)].filter((line): line is string => line !== null)],
              approval: chosen ? approvalQuestion(bundle.task, bundle.current.model, chosen) : null,
              spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices: [...s.state.notices, ...notices], fixes: [...(s.state.fixes ?? []), ...fixes],
              reportUrl: `${services().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts, ...(evalVersion === null ? {} : { evalVersion }),
              ...(grade || acceptedBar === "criteria" ? { grading: { rounds: grade ? loop.round : 0, accepted: grade ? loop.status === "accepted" : true, bar: loop.bar, failedChecks: result.failedChecks ?? [], summary: result.summary ?? null } } : {}),
            };
            await finish(s, client, jobId, "done", report, null);
          },
        });
      } catch (error) {
        if (!(error instanceof JobStop)) throw error;
        const stop = error;
        await ctx.step("stop", async s => {
          const client = s.client<Registry>();
          const spent = await client.account.getOrCreate([s.state.input.accountId]).spent({ jobId });
          const result = stop.resultStatus ? partial!(stop.resultStatus, [...s.state.notices, stop.message], [...(s.state.fixes ?? []), ...tie(stop.fix, stop.message)], spent) : null;
          await finish(s, client, jobId, stop.status, result, stop.status === "failed" ? stop.message : null, stop.message);
        });
      }
    } catch (error) {
      // A step that failed for good: record the job as failed instead of leaving it running. A later wake replays to here and changes nothing.
      if (!(error instanceof StepExhaustedError || error instanceof CriticalError)) throw error;
      const message = redact(error.message).slice(0, 500);
      await ctx.step("failed", async s => {
        const client = s.client<Registry>();
        const spent = await client.account.getOrCreate([s.state.input.accountId]).spent({ jobId });
        const notice = `The job failed and stopped measuring: ${message}. Nothing is charged for it; call openmerit_recommend again to retry.`;
        await finish(s, client, jobId, "failed", partial?.("failed", [...s.state.notices, notice], [...(s.state.fixes ?? []), { kind: "rerun", notice }], spent) ?? null, message, notice);
      });
    }
  },
  actions: {
    status: (c): JobView => {
      const { input, measuringSince: _since, ...rest } = c.state;
      return { ...rest, live: rest.live ?? null, jobId: c.key[0]!, taskId: input.taskId, task: input.bundle.task, provisional: input.provisional, createdAt: input.createdAt };
    },
    /** For deleting an account. */
    destroy: (c): void => { endpointKeys.delete(c.key[0]!); c.destroy(); },
  },
});

type StepState = { state: JobState; waitUntil: (promise: Promise<void>) => void };

/**
 * Records the job's end in its state, the account (which counts the evaluation) and the task, and
 * sends run_completed. It is sent only on the transition from a live status to a terminal one, after
 * every write above succeeded: a step that runs again after a failed write sends it then, and one
 * replayed after its state was saved finds the job already ended and sends nothing.
 */
async function finish(s: StepState, client: AppClient, jobId: string, status: "done" | "stopped" | "failed", result: JobResult | null, error: string | null, notice?: string): Promise<void> {
  const { input } = s.state;
  if (result) {
    const markdown = renderMarkdown({ jobId, bundle: input.bundle, result, provisional: input.provisional, createdAt: input.createdAt });
    await client.account.getOrCreate([input.accountId]).saveReport({ jobId, taskId: input.taskId, json: { jobId, task: input.bundle.task, createdAt: input.createdAt, ...result }, markdown });
  }
  await client.task.getOrCreate([input.accountId, input.taskId]).recordResult({ jobId, status, result });
  await client.account.getOrCreate([input.accountId]).jobUpdate({ jobId, status, measured: status === "done" });
  const ended = TERMINAL.has(s.state.status);
  s.state.status = status; s.state.phase = "done"; s.state.result = result; s.state.error = error; s.state.questions = []; s.state.live = null; s.state.updatedAt = now();
  if (notice && !result) s.state.notices.push(notice);
  endpointKeys.delete(jobId);
  if (!ended) {
    const userId = input.userId ?? null;
    // A watch job has no user: it is the account's, with no person profile.
    s.waitUntil(capture(services().config.posthog, "run_completed", userId ?? input.accountId, {
      interface: "cloud", status, trigger: input.trigger ?? (input.kind === "watch" ? "watch" : "mcp"), duration_ms: Date.now() - Date.parse(input.createdAt), account_id: input.accountId,
      ...(userId ? {} : { $process_person_profile: false }),
    }));
  }
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "stopped", "failed"]);
