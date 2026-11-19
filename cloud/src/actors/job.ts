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
import { applyLabelCheck, BudgetRefused, completeWith, createClient, createMeasure, graderFor, labelCheck, LABEL_CHECK_QUESTION, writeCases, WRITTEN_CASES, type Case, type Complete, type EndpointConfig, type MeasureResult, type TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import { CandidateUnavailable, catalogueIndex, CHALLENGERS, checkAgent, DEFAULT_REPEATS, EndChallengers, evaluateTask, FINALISTS, newProgress, redact, SAMPLE_SIZE, score, type CatalogueModel, type Evaluated, type Ledger, type ResolvedGuardrails, type Score } from "../engine.ts";
import { buildPool, OPENROUTER, type Option, type Pool, type Provisional } from "../pool.ts";
import { proposeEdit, renderMarkdown, type AgentEvalSummary, type JobResult, type MeasuredModel } from "../report.ts";
import { capture } from "../analytics.ts";
import { services } from "../services.ts";
import { redactBundle } from "../start.ts";
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
  phase: "source" | "cases" | "label_check" | "models" | "ranking" | "agent_eval" | "action" | "done";
  questions: Question[];
  notices: string[];
  progress: { measured: number; planned: number | null };
  result: JobResult | null;
  error: string | null;
  updatedAt: string;
}

export interface JobView extends Omit<JobState, "input"> { jobId: string; taskId: string; task: string; provisional: Provisional; createdAt: string }

type Measured = ({ kind: "ok" } & MeasureResult) | { kind: "unavailable" | "refused" | "error"; reason: string };

/**
 * Retries for the steps that call models. @rivet-dev/workflows counts a step that the actor's stop
 * aborts, as on a deploy's drain, as a failed attempt; with no retries that one abort exhausts the
 * step and the workflow stays failed. These steps return their own failures as values, so a thrown
 * error is almost always an interruption, and the step runs again where the actor moves, reusing its
 * `<job>/<step>` ledger keys.
 */
const INTERRUPTIONS = 5;

/** Ends the job early; caught by the workflow, which records why. */
class JobStop extends Error {
  readonly status: "stopped" | "failed";
  readonly resultStatus: JobResult["status"] | null;
  constructor(status: "stopped" | "failed", resultStatus: JobResult["status"] | null, message: string) { super(message); this.status = status; this.resultStatus = resultStatus; }
}

/** Endpoints with their keys, by job, in this process only. */
const endpointKeys = new Map<string, Promise<EndpointConfig[]>>();

type AccountHandle = ReturnType<AppClient["account"]["getOrCreate"]>;

function keysFor(jobId: string, account: AccountHandle): Promise<EndpointConfig[]> {
  let keys = endpointKeys.get(jobId);
  if (!keys) {
    keys = account.endpointSecrets().catch((error: unknown) => { endpointKeys.delete(jobId); throw error; });
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
  queues: { answers: queue<{ answers: Answers }>() },
  run: async ctx => {
    const jobId = ctx.key[0]!;
    /** The report of what was measured so far, once the pool is known; a stopped or failed job saves it. */
    let partial: ((status: JobResult["status"], notices: string[], spent: { openmeritUsd: number; customerUsd: number }) => JobResult) | null = null;
    try {

      // 1. Source: redact the bundle, resolve the task's guardrails, set the job's spend limits.
      const source = await ctx.step({
        name: "source", timeout: 60_000,
        run: async s => {
          const { input } = s.state;
          const bundle = redactBundle(input.bundle);
          const account = s.client<Registry>().account.getOrCreate([input.accountId]);
          const guardrails = await account.resolveGuardrails({ environment: input.environment, agent: input.agent, taskId: input.taskId });
          const { effective } = guardrails;
          await account.jobUpdate({ jobId, status: "running", budgetUsd: effective.budgetUsd ?? services().config.limits.defaultJobBudgetUsd, capOpenmeritUsd: effective.spendCapUsd ?? null, capCustomerUsd: effective.customerSpendCapUsd ?? null });
          s.state.status = "running"; s.state.phase = "cases"; s.state.updatedAt = now();
          return { bundle, guardrails, accountId: input.accountId, environment: input.environment, agent: input.agent, provisional: input.provisional };
        },
      });
      const { bundle, guardrails } = source as { bundle: TaskBundle; guardrails: ResolvedGuardrails };
      const input = { accountId: source.accountId, environment: source.environment, agent: source.agent };
      // A job recorded before this step returned its provisional pick has none here.
      const told = (source as { provisional?: Provisional }).provisional ?? null;

      // 2. Cases: the bundle's examples first, with labels the user gave in earlier runs, then cases a
      // model writes on OpenMerit's OpenRouter key; then the label check. A task's later runs reuse the
      // written cases the user approved, so a watch job asks nothing and its results stay comparable.
      const written = await ctx.step({
        name: "cases", timeout: 0, maxRetries: INTERRUPTIONS,
        run: async s => {
          const { accountId, taskId } = s.state.input;
          const client = s.client<Registry>();
          const task = client.task.getOrCreate([accountId, taskId]);
          const [saved, approved] = await Promise.all([task.labels(), task.written()]);
          const { config, fetch } = services();
          let complete: Complete = async () => "";
          let count = 0;
          if (approved === null && config.openrouter.apiKey) {
            const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
            const account = client.account.getOrCreate([accountId]);
            // The writer answers with all its cases at once, so it gets longer than a ranking call to answer.
            const models = createClient(await keysFor(jobId, account), { fetch, model: model => index.find(model), timeoutMs: 600_000 });
            complete = completeWith(models, { endpoint: OPENROUTER, model: config.models.caseWriter }, jobLedger(account, jobId), `${jobId}/cases`, s.abortSignal);
            count = WRITTEN_CASES;
          }
          let made;
          try {
            made = await writeCases({ bundle, complete, count });
          } catch (error) {
            if (s.abortSignal.aborted) throw error;
            s.state.notices.push(`No cases were written (${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}): the job measures on the bundle's examples only.`);
            made = await writeCases({ bundle, complete, count: 0 });
          }
          const examples = made.cases.filter(item => item.origin === "example").map(item => {
            const label = saved[caseKey(item.input)];
            return item.expected === undefined && label ? { ...item, expected: label.expected, approved: label.approved } : item;
          });
          return [...examples, ...(approved ?? made.cases.filter(item => item.origin === "written"))];
        },
      });
      const cases = await ctx.loop({
        name: "label-check", state: written,
        run: async (loop, current) => {
          const questions = labelQuestions(bundle, current);
          if (!questions.length) return Loop.break(current);
          await loop.step("ask", async s => {
            s.state.status = "needs_input"; s.state.phase = "label_check"; s.state.questions = questions; s.state.updatedAt = now();
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
      const usable = cases.filter(labeled);
      const caseIds = usable.map(item => item.id);
      const counts = { total: usable.length, fromExamples: usable.filter(item => item.origin === "example").length, written: usable.filter(item => item.origin !== "example").length };

      // 3. Models: the ECI-ordered pool over every allowed endpoint.
      const models = await ctx.step({
        name: "models", timeout: 60_000,
        run: async s => {
          const client = s.client<Registry>();
          const catalogue = await client.catalogue.getOrCreate(["global"]).get();
          const endpoints = await client.account.getOrCreate([s.state.input.accountId]).endpointsForJob();
          const built = buildPool({ catalogue, endpoints, bundle, guardrails: guardrails.effective });
          // The catalogue entries the job's calls are priced by, by the name each endpoint calls the model, so every step prices on this version.
          const index = catalogueIndex(catalogue);
          const priced: Record<string, CatalogueModel> = {};
          for (const option of [built.baseline, ...built.ranked, ...built.unplaced]) {
            const model = option?.inCatalogue ? index.find(option.model) : null;
            if (option && model) priced[option.endpointModel] = model;
          }
          const judgeModel = index.find(services().config.models.judge);
          if (judgeModel) priced[services().config.models.judge] = judgeModel;
          s.state.phase = "ranking"; s.state.notices.push(...built.notices); s.state.updatedAt = now();
          s.state.progress.planned = plannedSteps(built.ranked.length, built.unplaced.length, Math.max(1, guardrails.effective.repeats ?? DEFAULT_REPEATS));
          return { pool: built, priced, catalogueVersion: catalogue.version };
        },
      });
      const pool = models.pool as Pool;

      // Old jobs that started measuring before the shared policy ran other measure steps: their recorded steps do not replay here.
      const policy = await ctx.getVersion("ranking-policy", 2);
      const repeats = Math.max(1, guardrails.effective.repeats ?? DEFAULT_REPEATS);
      const progress = newProgress<Option>();
      const asModel = (option: Option, figures: Score, extra: Pick<MeasuredModel, "role" | "stage" | "status" | "qualified" | "note">): MeasuredModel => ({
        model: option.model, endpoint: option.endpoint, endpointModel: option.endpointModel, eci: option.eci, inCatalogue: option.inCatalogue, funding: option.funding,
        passes: figures.passes, total: figures.total, costPerCallUsd: figures.costPerItemUsd, costIsEstimate: figures.costIsEstimate,
        latencyMs: figures.latencyMs === null ? null : Math.round(figures.latencyMs), ...extra,
      });
      const entries = new Map<Evaluated<Option>, MeasuredModel>();
      /** One case is one call, so the engine's cost per item is the cost per call. A model that passed its screen but whose full runs did not finish is left out. */
      const modelOf = (item: Evaluated<Option>): MeasuredModel => {
        let found = entries.get(item);
        if (!found) { found = asModel(item.option, item, { role: "candidate", stage: item.stage, status: item.status === "measured" ? "measured" : item.status === "unavailable" ? "unavailable" : "screened_out", qualified: false, note: item.reason ?? "" }); entries.set(item, found); }
        found.qualified = item.qualified;
        return found;
      };
      const listed = (items: Iterable<Evaluated<Option>>) => [...items].filter(item => item.status !== "unmeasured").map(modelOf);
      const baselineOf = () => (pool.baseline && progress.baseline.length ? asModel(pool.baseline, score(progress.baseline), { role: "baseline", stage: "baseline", status: "measured", qualified: false, note: "" }) : null);
      partial = (status, notices, spent) => ({
        status, pick: null, top: [], nearMisses: [], baseline: baselineOf(), candidates: listed(progress.tried.values()),
        search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: [], finalists: [], challengers: [], shortfall: null }, agentEval: null, edit: { edits: [], instructions: null },
        spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices,
        reportUrl: `${services().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts,
      });
      let counter = 0;
      /** How many measure steps the job takes in all, once the search knows its size. Set outside steps, from the step count, so a replay sets the same. */
      let plannedTotal: number | null = null;
      /**
       * One measure call as one workflow step: each repeat and each screen is its own step. Its ledger keys
       * start with the job and the step, so a replay reuses them; a retry after an error is a deliberate
       * repeat, with its own keys.
       */
      const measure = (option: Option, ids: string[]): Promise<Measured> => {
        const name = `measure-${++counter}`;
        return ctx.step({
          name, timeout: 0, maxRetries: INTERRUPTIONS,
          run: async s => {
            if (plannedTotal !== null) s.state.progress.planned = Math.max(plannedTotal, s.state.progress.measured);
            const account = s.client<Registry>().account.getOrCreate([s.state.input.accountId]);
            const { config, fetch } = services();
            const client = createClient(await keysFor(jobId, account), { fetch, model: model => models.priced[model] ?? null });
            // Text answers go to a fixed judge on OpenMerit's key. Its calls count in the job's spend but not in the candidate's cost per call.
            const judge = bundle.output.kind === "text" && config.openrouter.apiKey ? {
              client, endpoint: OPENROUTER, model: config.models.judge,
              rubric: bundle.description ? `The answer does this task well: ${bundle.description}` : "The answer does what the prompt asks and agrees with the reference answer.",
            } : undefined;
            const run = createMeasure({ bundle, cases: usable, client, grader: graderFor(bundle, judge ? { judge } : {}), ledger: jobLedger(account, jobId), key: `${jobId}/${name}`, signal: s.abortSignal });
            for (let attempt = 1; ; attempt++) {
              try {
                const result = await run({ model: option.endpointModel, endpoint: option.endpoint }, ids, { run: String(attempt - 1) });
                done(s);
                return { kind: "ok" as const, ...result };
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
        ? new JobStop("stopped", "stopped", `Stopped while measuring ${what}: ${result.reason}. Raise the budget in the task's guardrails at app.openmerit.ai to continue.`)
        : new JobStop("failed", "failed", `Measuring ${what} failed: ${"reason" in result ? result.reason : "unknown error"}`);

      try {
        if (policy === 1) throw new JobStop("failed", "failed", "The job started measuring before a deploy changed how OpenMerit measures, so it cannot resume. Nothing is charged for it; call openmerit_recommend again to rerun it.");
        if (!usable.length) throw new JobStop("stopped", "no_cases", "No case has a known correct answer. Add examples with expected answers to the bundle, or answer the label check.");
        if (!pool.baseline) throw new JobStop("failed", "baseline_failed", "No endpoint can run the current model: OpenMerit's OpenRouter key is not configured, and no endpoint of yours serves it.");
        const current = pool.baseline;

        // 4. Ranking: openmerit/engine's evaluateTask, the policy the CLI runs too. Each of its measure calls is one step.
        const minPassRate = guardrails.effective.minPassRate ?? 0;
        const maxLatency = Math.min(guardrails.effective.latencyMs ?? Infinity, bundle.constraints?.maxLatencyMs ?? Infinity);
        // The agent was told the provisional pick: when no measured model beats the current one per call, it is measured before keeping the current model.
        const provisional = (told && [...pool.ranked, ...pool.unplaced].find(item => item.model === told.model && item.endpoint === told.endpoint)) || null;
        const evaluated = await evaluateTask<Option>({
          ladder: pool.ranked, unplaced: pool.unplaced, strength: item => item.eci ?? -Infinity, items: caseIds, repeats, provisional,
          rules: { threshold: minPassRate ? minPassRate - 1e-9 : null, maxLatencyMs: Number.isFinite(maxLatency) ? maxLatency : null },
          baselinePrice: current.price, progress,
          measure: async (option, items, call) => {
            const target = option ?? current;
            if (call.provisional && call.role === "screen") plannedTotal = counter + 1 + repeats;
            const result = await measure(target, [...(items ?? caseIds)]);
            if (result.kind === "unavailable") {
              if (!option) throw new JobStop("stopped", "baseline_failed", `${current.model} could not run: ${result.reason}`);
              throw new CandidateUnavailable(result.reason);
            }
            if (result.kind !== "ok") {
              const stop = stopFor(result, option ? target.model : `the current model ${current.model}`);
              // The finalists are measured, so a challenger the budget refuses, or one that fails, ends the challengers only.
              throw call.stage === "challenger" ? new EndChallengers(stop.message) : stop;
            }
            return { items: Object.fromEntries(result.results.map(item => [item.caseId, item.pass])), costUsd: result.costUsd, costIsEstimate: result.costIsEstimate, latencyMs: result.latencyMs };
          },
          // Drawn in a recorded step, so a replay screens on the same cases.
          sample: (reliable, count) => ctx.step("samples", async () => {
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
        const baseline = baselineOf()!;
        if (evaluated.status === "too_few_reliable") {
          const runs = evaluated.baseline.runs.length;
          throw new JobStop("stopped", "baseline_failed", !evaluated.baseline.passes
            ? `${current.model} passed none of the ${caseIds.length} cases, so there is nothing to compare against. Check the labels.`
            : `${current.model} passed only ${evaluated.reliable.length} of the ${caseIds.length} cases in ${runs === 1 ? "its first run" : `every one of its ${runs} runs`}; OpenMerit screens candidates on ${SAMPLE_SIZE} cases it passes. Check the labels, or add examples it gets right.`);
        }
        const candidates = listed(evaluated.candidates);
        const top = evaluated.top.map(modelOf), cheaper = evaluated.cheaper.map(modelOf), nearMisses = evaluated.nearMisses.map(modelOf);
        const notices: string[] = [];
        const { ended } = evaluated;
        if (ended && !ended.provisional) notices.push(`${ended.left.length === 1 ? "Challenger" : "Challengers"} not measured: ${ended.left.map(item => item.model).join(", ")}. ${ended.reason}`);
        if (provisional && evaluated.provisionalTried) {
          const tried = evaluated.candidates.find(item => item.option.key === provisional.key);
          notices.push(ended?.provisional ? `The provisional pick ${provisional.model} was not measured. ${ended.reason}`
            : tried?.status === "screened_out" ? `No measured model that qualified was cheaper per call than ${current.model}, so the provisional pick ${provisional.model} was screened too, and failed the ${evaluated.samples.length} sample cases.`
            : `No measured model that qualified was cheaper per call than ${current.model}, so the provisional pick ${provisional.model} was measured on every case too.`);
        }
        const search = evaluated.search!;
        const challenging = [...evaluated.challenged, ...(provisional && evaluated.provisionalTried ? [provisional] : [])];
        const optionOf = (item: MeasuredModel) => [...pool.ranked, ...pool.unplaced].find(option => option.model === item.model && option.endpoint === item.endpoint)!;

        // 5. Agent eval: when the task belongs to an agent, the engine's rule checks the pick with every other task unchanged.
        let chosen = cheaper[0] ?? null;
        let agentEval: AgentEvalSummary | null = null;
        if (chosen && input.agent !== null) {
          await ctx.step("agent-eval-start", async s => { s.state.phase = "agent_eval"; s.state.updatedAt = now(); });
          const agentMeasure = services().agentEval({ accountId: input.accountId, environment: input.environment, agent: input.agent });
          let agentCounter = 0;
          const checked = await checkAgent({
            tasks: [{ task: bundle.task, options: cheaper.map(item => ({ key: `${item.endpoint} ${item.model}`, savingUsd: (baseline.costPerCallUsd ?? 0) - (item.costPerCallUsd ?? 0), item })) }],
            measure: agentMeasure ? assignment => ctx.step({
              name: `agent-${++agentCounter}`, timeout: 0, maxRetries: INTERRUPTIONS,
              run: async () => agentMeasure(new Map([...assignment].map(([task, option]) => [task, { model: option.item.endpointModel, endpoint: option.item.endpoint }]))),
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
        }

        // 6. Action: the edit and the report.
        await ctx.step({
          name: "action", timeout: 60_000,
          run: async s => {
            const client = s.client<Registry>();
            const account = client.account.getOrCreate([input.accountId]);
            const spent = await account.spent({ jobId });
            const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
            const status: JobResult["status"] = chosen ? "picked" : agentEval && cheaper.length ? "agent_eval_failed" : !pool.ranked.length && !pool.unplaced.length ? "no_candidates" : "keep_current";
            const result: JobResult = {
              status, top, nearMisses, baseline, candidates,
              pick: chosen ? { model: chosen.model, endpoint: chosen.endpoint, endpointModel: chosen.endpointModel, passes: chosen.passes, total: chosen.total, costPerCallUsd: chosen.costPerCallUsd, savingPerCallUsd: baseline.costPerCallUsd !== null && chosen.costPerCallUsd !== null ? baseline.costPerCallUsd - chosen.costPerCallUsd : null } : null,
              search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: evaluated.samples, finalists: search.finalists.map(item => item.model), challengers: challenging.map(item => item.model), shortfall: search.shortfall ?? null },
              agentEval, edit: chosen ? proposeEdit(bundle, optionOf(chosen), pool.baseline!.endpoint, index.find) : { edits: [], instructions: null },
              spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices: [...s.state.notices, ...notices],
              reportUrl: `${services().config.appUrl}/r/${jobId}/`, catalogueVersion: models.catalogueVersion, cases: counts,
            };
            await finish(s, client, jobId, "done", result, null);
          },
        });
      } catch (error) {
        if (!(error instanceof JobStop)) throw error;
        const stop = error;
        await ctx.step("stop", async s => {
          const client = s.client<Registry>();
          const spent = await client.account.getOrCreate([s.state.input.accountId]).spent({ jobId });
          const result = stop.resultStatus ? partial!(stop.resultStatus, [...s.state.notices, stop.message], spent) : null;
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
        await finish(s, client, jobId, "failed", partial?.("failed", [...s.state.notices, notice], spent) ?? null, message, notice);
      });
    }
  },
  actions: {
    status: (c): JobView => {
      const { input, ...rest } = c.state;
      return { ...rest, jobId: c.key[0]!, taskId: input.taskId, task: input.bundle.task, provisional: input.provisional, createdAt: input.createdAt };
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
  s.state.status = status; s.state.phase = "done"; s.state.result = result; s.state.error = error; s.state.questions = []; s.state.updatedAt = now();
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
