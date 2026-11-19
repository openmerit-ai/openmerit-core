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
import { createHash } from "node:crypto";
import { Loop, workflow } from "@rivet-dev/workflows";
import { queue } from "rivetkit";
import { applyLabelCheck, BudgetRefused, completeWith, createClient, createMeasure, graderFor, labelCheck, LABEL_CHECK_QUESTION, writeCases, WRITTEN_CASES, type Case, type Complete, type EndpointConfig, type MeasureResult, type TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import { binarySearch, CandidateUnavailable, catalogueIndex, CHALLENGERS, challengers, checkAgent, FINALISTS, redact, SAMPLE_SIZE, type CatalogueModel, type Ledger, type Ranked, type ResolvedGuardrails, type Stage } from "../engine.ts";
import { buildPool, OPENROUTER, type Option, type Pool, type Provisional } from "../pool.ts";
import { proposeEdit, renderMarkdown, type AgentEvalSummary, type JobResult, type MeasuredModel } from "../report.ts";
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

export interface JobInput {
  accountId: string;
  taskId: string;
  environment: string;
  agent: string | null;
  bundle: TaskBundle;
  kind: "run" | "watch";
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
 * About how many measure steps a job takes, as the CLI estimates its runs: the current model, the
 * search's screens (about log₂ of the ladder, then the finalists' neighbours), the finalists on the
 * other cases, and the challengers, every unplaced model among them.
 */
export function plannedSteps(ranked: number, unplaced: number): number {
  const screens = Math.min(Math.ceil(Math.log2(ranked + 1)) + FINALISTS + 1, ranked);
  return 1 + screens + Math.min(FINALISTS, ranked) + Math.min(CHALLENGERS, ranked) + unplaced;
}

export const job = workflow({
  createState: (_c, input: JobInput): JobState => ({
    input, status: "queued", phase: "source", questions: [], notices: [], progress: { measured: 0, planned: null }, result: null, error: null, updatedAt: now(),
  }),
  queues: { answers: queue<{ answers: Answers }>() },
  run: async ctx => {
    const jobId = ctx.key[0]!;

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
        if (effective.repeats && effective.repeats > 1) s.state.notices.push(`The repeats guardrail (${effective.repeats}) is not supported by the cloud runner yet: each case runs once.`);
        return { bundle, guardrails, accountId: input.accountId, environment: input.environment, agent: input.agent };
      },
    });
    const { bundle, guardrails } = source as { bundle: TaskBundle; guardrails: ResolvedGuardrails };
    const input = { accountId: source.accountId, environment: source.environment, agent: source.agent };

    // 2. Cases: the bundle's examples first, with labels the user gave in earlier runs, then cases a
    // model writes on OpenMerit's OpenRouter key; then the label check. A task's later runs reuse the
    // written cases the user approved, so a watch job asks nothing and its results stay comparable.
    const written = await ctx.step({
      name: "cases", timeout: 0, maxRetries: 0,
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
        s.state.progress.planned = plannedSteps(built.ranked.length, built.unplaced.length);
        return { pool: built, priced, catalogueVersion: catalogue.version };
      },
    });
    const pool = models.pool as Pool;

    const measuredModels = new Map<string, MeasuredModel>();
    let counter = 0;
    /** How many measure steps the job takes in all, once the search knows its size. Set outside steps, from the step count, so a replay sets the same. */
    let plannedTotal: number | null = null;
    /**
     * One measure call as one workflow step. Its ledger keys start with the job and the step, so a replay
     * reuses them; a retry after an error is a deliberate repeat, with its own keys.
     */
    const measure = (option: Option, ids: string[]): Promise<Measured> => {
      const name = `measure-${++counter}`;
      return ctx.step({
        name, timeout: 0, maxRetries: 0,
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
    const record = (option: Option, stage: MeasuredModel["stage"], role: MeasuredModel["role"], results: Measured[], ids: number): MeasuredModel => {
      const ok = results.filter((item): item is Extract<Measured, { kind: "ok" }> => item.kind === "ok");
      const unavailable = results.find(item => item.kind === "unavailable");
      const passes = ok.reduce((sum, item) => sum + item.results.filter(result => result.pass).length, 0);
      const total = ok.reduce((sum, item) => sum + item.results.length, 0);
      const cost = ok.reduce((sum, item) => sum + item.costUsd, 0);
      const latencies = ok.map(item => item.latencyMs).filter((value): value is number => value !== null);
      const entry: MeasuredModel = {
        model: option.model, endpoint: option.endpoint, endpointModel: option.endpointModel, role, stage, eci: option.eci, inCatalogue: option.inCatalogue, funding: option.funding,
        status: unavailable ? "unavailable" : total < ids ? "screened_out" : "measured", passes, total, costPerCallUsd: total ? cost / total : null,
        costIsEstimate: ok.some(item => item.costIsEstimate), latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        qualified: false, note: unavailable && "reason" in unavailable ? unavailable.reason : "",
      };
      measuredModels.set(`${role}:${option.key}`, entry);
      return entry;
    };
    const stopFor = (result: Measured, what: string): JobStop => result.kind === "refused"
      // The report keeps what was measured before the budget ran out.
      ? new JobStop("stopped", "stopped", `Stopped while measuring ${what}: ${result.reason}. Raise the budget in the task's guardrails at app.openmerit.ai to continue.`)
      : new JobStop("failed", null, `Measuring ${what} failed: ${"reason" in result ? result.reason : "unknown error"}`);

    try {
      if (!usable.length) throw new JobStop("stopped", "no_cases", "No case has a known correct answer. Add examples with expected answers to the bundle, or answer the label check.");
      if (!pool.baseline) throw new JobStop("failed", "baseline_failed", "No endpoint can run the current model: OpenMerit's OpenRouter key is not configured, and no endpoint of yours serves it.");

      // 4. Ranking: the current model on every case, Scout Model Binary Search on samples it passes, then finalists and challengers on every case.
      const baselineRun = await measure(pool.baseline, caseIds);
      if (baselineRun.kind === "refused" || baselineRun.kind === "error") throw stopFor(baselineRun, `the current model ${pool.baseline.model}`);
      const baseline = record(pool.baseline, "baseline", "baseline", [baselineRun], caseIds.length);
      if (baselineRun.kind !== "ok" || !baseline.passes) throw new JobStop("stopped", "baseline_failed", baselineRun.kind === "ok" ? `${pool.baseline.model} passed none of the ${caseIds.length} cases, so there is nothing to compare against. Check the labels.` : `${pool.baseline.model} could not run: ${baselineRun.reason}`);
      const samples = baselineRun.results.filter(item => item.pass).map(item => item.caseId).slice(0, SAMPLE_SIZE);
      const rest = caseIds.filter(id => !samples.includes(id));

      const screens = new Map<string, Measured>();
      const screen = async (option: Option & Ranked, _stage: Stage) => {
        const result = await measure(option, samples);
        screens.set(option.key, result);
        if (result.kind === "unavailable") throw new CandidateUnavailable(result.reason);
        if (result.kind !== "ok") throw stopFor(result, option.model);
        return result.results.every(item => item.pass);
      };
      const search = await binarySearch(pool.ranked, screen);
      const stageOf = new Map(search.trials.map(trial => [trial.candidate.key, trial.stage]));
      for (const trial of search.trials) if (!trial.accepted) record(trial.candidate, trial.stage, "candidate", [screens.get(trial.candidate.key)!], caseIds.length);
      for (const skipped of search.unavailable) record(skipped.candidate, skipped.stage, "candidate", [screens.get(skipped.candidate.key)!], caseIds.length);

      const minPassRate = guardrails.effective.minPassRate ?? 0;
      const maxLatency = Math.min(guardrails.effective.latencyMs ?? Infinity, bundle.constraints?.maxLatencyMs ?? Infinity);
      const qualifies = (item: MeasuredModel) => item.status === "measured" && item.passes >= baseline.passes && item.passes / item.total >= minPassRate - 1e-9 && (item.latencyMs === null || item.latencyMs <= maxLatency);
      const full = async (option: Option, stage: MeasuredModel["stage"], prior: Measured | null) => {
        const runs = prior ? [prior] : [];
        const ids = prior ? rest : caseIds;
        if (ids.length) {
          const result = await measure(option, ids);
          if (result.kind === "refused" || result.kind === "error") throw stopFor(result, option.model);
          runs.push(result);
        }
        const entry = record(option, stage, "candidate", runs, caseIds.length);
        entry.qualified = qualifies(entry);
        return entry;
      };
      // The search is done: the finalists on the other cases and the challengers are left.
      plannedTotal = counter + (rest.length ? search.finalists.length : 0) + Math.min(CHALLENGERS, pool.ranked.length) + pool.unplaced.length;
      const finals: MeasuredModel[] = [];
      for (const finalist of search.finalists) finals.push(await full(finalist, stageOf.get(finalist.key) ?? "search", screens.get(finalist.key) ?? null));
      const leaderModel = finals.filter(item => item.qualified).sort((a, b) => (a.costPerCallUsd ?? Infinity) - (b.costPerCallUsd ?? Infinity))[0];
      const leader = (leaderModel && pool.ranked.find(item => item.key === leaderModel.model)) ?? search.selected;
      const tried = new Set(screens.keys());
      const challenging = leader
        ? challengers(pool.ranked, leader, tried, { strength: item => item.eci ?? -Infinity, unplaced: pool.unplaced })
        : pool.unplaced.filter(item => !tried.has(item.key));
      plannedTotal = counter + challenging.length;
      const notices: string[] = [];
      for (const [index, challenger] of challenging.entries()) {
        // The finalists are measured, so a challenger the budget refuses, or one that fails, ends the challengers only.
        try {
          const entry = await full(challenger, "challenger", null);
          if (entry.status === "unavailable") entry.qualified = false;
        } catch (error) {
          if (!(error instanceof JobStop)) throw error;
          const left = challenging.slice(index).map(item => item.model);
          notices.push(`${left.length === 1 ? "Challenger" : "Challengers"} not measured: ${left.join(", ")}. ${error.message}`);
          break;
        }
      }

      const candidates = [...measuredModels.values()].filter(item => item.role === "candidate");
      const top = candidates.filter(item => item.qualified && item.costPerCallUsd !== null)
        .sort((a, b) => a.costPerCallUsd! - b.costPerCallUsd! || b.passes - a.passes).slice(0, 3);
      const cheaper = top.filter(item => baseline.costPerCallUsd === null || item.costPerCallUsd! < baseline.costPerCallUsd);
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
            name: `agent-${++agentCounter}`, timeout: 0, maxRetries: 0,
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
          const status: JobResult["status"] = chosen ? "picked" : agentEval && cheaper.length ? "agent_eval_failed" : !pool.ranked.length && !pool.unplaced.length ? "no_candidates" : "keep_current";
          const result: JobResult = {
            status, top, baseline, candidates,
            pick: chosen ? { model: chosen.model, endpoint: chosen.endpoint, endpointModel: chosen.endpointModel, passes: chosen.passes, total: chosen.total, costPerCallUsd: chosen.costPerCallUsd, savingPerCallUsd: baseline.costPerCallUsd !== null && chosen.costPerCallUsd !== null ? baseline.costPerCallUsd - chosen.costPerCallUsd : null } : null,
            search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples, finalists: search.finalists.map(item => item.model), challengers: challenging.map(item => item.model), shortfall: search.shortfall ?? null },
            agentEval, edit: chosen ? proposeEdit(bundle, optionOf(chosen), pool.baseline!.endpoint) : { edits: [], instructions: null },
            spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices: [...s.state.notices, ...notices],
            reportUrl: `${services().config.appUrl}/runs/${jobId}`, catalogueVersion: models.catalogueVersion, cases: counts,
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
        const result: JobResult | null = stop.resultStatus ? {
          status: stop.resultStatus, pick: null, top: [], baseline: [...measuredModels.values()].find(item => item.role === "baseline") ?? null, candidates: [...measuredModels.values()].filter(item => item.role === "candidate"),
          search: { pool: pool.ranked.length, unplaced: pool.unplaced.length, samples: [], finalists: [], challengers: [], shortfall: null }, agentEval: null, edit: { edits: [], instructions: null },
          spend: { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }, guardrails, notices: [...s.state.notices, stop.message],
          reportUrl: `${services().config.appUrl}/runs/${jobId}`, catalogueVersion: models.catalogueVersion, cases: counts,
        } : null;
        await finish(s, client, jobId, stop.status, result, stop.status === "failed" ? stop.message : null, stop.message);
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

type StepState = { state: JobState };

/** Records the job's end in its state, the account (which counts the evaluation) and the task. */
async function finish(s: StepState, client: AppClient, jobId: string, status: "done" | "stopped" | "failed", result: JobResult | null, error: string | null, notice?: string): Promise<void> {
  const { input } = s.state;
  if (result) {
    const markdown = renderMarkdown({ jobId, bundle: input.bundle, result, provisional: input.provisional, createdAt: input.createdAt });
    await client.account.getOrCreate([input.accountId]).saveReport({ jobId, taskId: input.taskId, json: { jobId, task: input.bundle.task, createdAt: input.createdAt, ...result }, markdown });
  }
  await client.task.getOrCreate([input.accountId, input.taskId]).recordResult({ jobId, status, result });
  await client.account.getOrCreate([input.accountId]).jobUpdate({ jobId, status, measured: status === "done" });
  s.state.status = status; s.state.phase = "done"; s.state.result = result; s.state.error = error; s.state.questions = []; s.state.updatedAt = now();
  if (notice && !result) s.state.notices.push(notice);
  endpointKeys.delete(jobId);
}
