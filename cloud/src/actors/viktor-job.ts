// The Viktor job: one Rivet workflow per evaluation of one Viktor scheduled task.
//
//   Put ▶ Thread (Viktor tests every copy in test mode) ▶ Credits ▶ Grade ▶ Evaluate ▶ Action
//
// The decisions are openmerit-core's Viktor connection and openmerit/engine's `evaluateTask`; this
// actor only runs the steps. Every step is recorded, so a crash or a deploy resumes where it was: the
// batch keeps running in Viktor's sandbox, and the job reads its progress file again. The judge's
// calls reserve and settle under `<job>/checks` and `<job>/grade/<model>/<repeat>`, so a replayed
// step counts no spend twice. Viktor credits come out of the customer's workspace and are recorded
// on the job, not in the ledger. However the job ends, it deletes OpenMerit's copies of the task.
// The key is read from the account in each step that needs it and never stored in step results.
import { randomInt } from "node:crypto";
import { CriticalError, Loop, StepExhaustedError, workflow } from "@rivet-dev/workflows";
import { completeWith, createClient } from "../../../openmerit-core/src/ranking/index.ts";
import { viktorErrorSentence } from "../../../openmerit-core/src/connectors/viktor/api.ts";
import {
  BATCH, batchMessage, batchSpec, CLEANUP, copyPrefix, CREDIT_USD, CREDITS, DESCRIBE, estimateCredits, evaluateViktor, gradeRun, judgeChecks, PUT, proposeChange, READ, readBatch, RUN_CREDITS, isPreset,
  currentPreset, modelLabel, runsOn, viktor, viktorClient, writeChecks, type Batch, type BatchRun, type Check, type ViktorClient, type ViktorTask,
} from "../../../openmerit-core/src/connectors/viktor/index.ts";
import { approvalQuestion, basedOn, catalogueIndex, mergeEvidence, redact, strongest, type Ledger, type Measurement, type ModelResult } from "../engine.ts";
import { OPENROUTER } from "../pool.ts";
import type { ConnectionResult, JobResult, MeasuredModel } from "../report.ts";
import { services } from "../services.ts";
import type { AppClient, Registry } from "../registry.ts";
import type { JobStatus } from "./job.ts";

export interface ViktorJobInput {
  accountId: string;
  /** `viktor_<cron id>`. */
  taskId: string;
  task: ViktorTask;
  repeats: number;
  /** The credits the person confirmed when starting it; the job stops past CREDIT_GUARD times this. Missing on jobs started before it was kept. */
  estimatedCredits?: number;
  /** Who started it: null when it started on its own after connecting. */
  userId: string | null;
  createdAt: string;
}

export interface ViktorJobState {
  input: ViktorJobInput;
  status: JobStatus;
  phase: "testing" | "grading" | "done";
  notices: string[];
  progress: { measured: number; planned: number };
  thread: { threadId: string; runId: string } | null;
  result: JobResult | null;
  error: string | null;
  updatedAt: string;
}

/** What /api/runs/<job> and openmerit_result show while the job runs, in the shape of an agent's job. */
export interface ViktorJobView {
  jobId: string; taskId: string; task: string; status: JobStatus; phase: string; questions: never[]; notices: string[]; progress: { measured: number; planned: number | null };
  result: JobResult | null; provisional: null; createdAt: string; updatedAt: string; live: null; connection: "viktor";
  /** A short sentence when OpenMerit can read the failure, such as Viktor refusing a request; else the error as recorded. */
  error: string | null;
  /** The error as recorded, with its line breaks, when `error` is a sentence about it; null otherwise. */
  errorDetail: string | null;
}

/** The view's error: a sentence for the failure Viktor's API gave, and the recorded error, with real line breaks, as its detail. */
export function readableError(error: string | null): { error: string | null; errorDetail: string | null } {
  const sentence = error ? viktorErrorSentence(error) : null;
  return sentence ? { error: sentence, errorDetail: error!.replaceAll("\\n", "\n") } : { error, errorDetail: null };
}

const now = () => new Date().toISOString();
const INTERRUPTIONS = 5;
/** How long the test runs may take in all before the job gives up on them. */
const TESTING_LIMIT_MS = 90 * 60_000;
/** Polls after the thread's run ended without the batch starting, before the job gives up. */
const MISSING_POLLS = 3;
const ENDED = new Set(["completed", "requires_action", "failed", "cancelled", "timed_out"]);

class JobStop extends Error {
  readonly status: "stopped" | "failed";
  /** The Viktor credits the job used, when it knows them. */
  readonly credits: number | null;
  constructor(status: "stopped" | "failed", message: string, credits: number | null = null) { super(message); this.status = status; this.credits = credits; }
}

/** A job stops its test runs once their recorded credits pass this many times its estimate: a safety net, not a setting. */
export const CREDIT_GUARD = 2;

type AccountHandle = ReturnType<AppClient["account"]["getOrCreate"]>;
async function viktorFor(account: AccountHandle): Promise<ViktorClient> {
  const apiKey = await account.connectionKey("viktor");
  if (!apiKey) throw new JobStop("failed", "The Viktor connection was removed, or its key no longer decrypts. Connect Viktor again at app.openmerit.ai.");
  const { config, fetch } = services();
  return viktorClient({ apiKey, baseUrl: config.viktor.baseUrl, fetch });
}

const jobLedger = (account: AccountHandle, jobId: string): Ledger => ({
  reserve: reservation => account.reserve({ ...reservation, jobId }),
  settle: (key, cost) => account.settle({ key, cost }),
  release: key => account.release(key),
  spent: async () => { const spent = await account.spent({ jobId }); return { openmeritUsd: spent.openmeritUsd, customerUsd: spent.customerUsd }; },
});

/** A preset's result in the report's names: one check is one item, and its cost per call is per test run. */
function measuredModel(item: ModelResult, checks: number): MeasuredModel {
  return {
    model: item.model, endpoint: "viktor", endpointModel: item.endpointModel, role: item.role, stage: item.stage, eci: null, inCatalogue: false, funding: "customer",
    status: item.status === "unmeasured" ? "screened_out" : item.status, passes: item.passes, total: item.total, costPerCallUsd: item.costPerItemUsd === null ? null : item.costPerItemUsd * checks,
    costIsEstimate: item.costIsEstimate, latencyMs: item.latencyMs === null ? null : Math.round(item.latencyMs), qualified: item.qualified, note: item.note,
  };
}

export function renderViktorMarkdown(input: { jobId: string; createdAt: string; result: JobResult }): string {
  const { result } = input, connection = result.connection!;
  const rate = (item: MeasuredModel) => `${item.passes}/${item.total}`;
  const lines = [
    `# OpenMerit report: ${connection.taskTitle} (Viktor)`, "", `Job \`${input.jobId}\`, ${input.createdAt}.`, "", "## Result", "",
    connection.change ? `${connection.change.text}: it passed ${result.pick ? `${result.pick.passes}/${result.pick.total}` : "?"} of the checks, as the current preset did, for fewer credits. Make the change in Viktor (${connection.change.link}); OpenMerit does not change the task.`
      : `Keep \`${connection.currentModel}\`: no cheaper preset passed every check it passed.`,
    "", "## Presets", "", "| Preset | Checks passed | Credits per run | Qualified |", "| --- | --- | --- | --- |",
    ...[result.baseline, ...result.candidates].filter((item): item is MeasuredModel => item !== null).map(item => `| \`${item.model}\` | ${item.status === "unavailable" ? "unavailable" : rate(item)} | ${item.costPerCallUsd === null ? "–" : Math.round(item.costPerCallUsd / CREDIT_USD)}${item.costIsEstimate ? " (estimate)" : ""} | ${item.role === "baseline" ? "current" : item.qualified ? "yes" : "no"} |`),
    "", "## Checks", "", ...connection.checks.map(check => `- ${check.id}: ${check.check}`),
    "", "## Spend", "", `${connection.creditsUsed} Viktor credits from your workspace; the judge's calls cost OpenMerit $${result.spend.openmeritUsd.toFixed(4)}.`,
  ];
  if (result.basedOn?.length) lines.push("", "Based on:", ...result.basedOn.map(line => `- ${line}`));
  if (result.notices.length) lines.push("", "## Notes", "", ...result.notices.map(notice => `- ${notice}`));
  return `${lines.join("\n")}\n`;
}

export const viktorJob = workflow({
  createState: (_c, input: ViktorJobInput): ViktorJobState => ({
    input, status: "queued", phase: "testing", notices: [], progress: { measured: 0, planned: 0 }, thread: null, result: null, error: null, updatedAt: now(),
  }),
  run: async ctx => {
    const jobId = ctx.key[0]!;
    const { task: listed, repeats, estimatedCredits } = await ctx.step("input", async s => ({ task: s.state.input.task, repeats: s.state.input.repeats, estimatedCredits: s.state.input.estimatedCredits }));
    const { directory, spec } = batchSpec(jobId, listed, repeats);
    // The listing has only the start of the instructions; the judge reads the full text, fetched below.
    let task = listed;
    // The preset it runs on: its own, or the workspace's default, which its copy keeps unset.
    const current = currentPreset(listed)!;
    try {
      try {
        // 0. The task's full instructions, read once and recorded.
        const description = await ctx.step({
          name: "instructions", timeout: 300_000, maxRetries: INTERRUPTIONS,
          run: async s => {
            const viktorApi = await viktorFor(s.client<Registry>().account.getOrCreate([s.state.input.accountId]));
            const parsed = JSON.parse((await viktorApi.runScriptPaged(DESCRIBE, [listed.path], 120)).trim().split("\n").at(-1) ?? "{}") as { description?: unknown };
            return typeof parsed.description === "string" && parsed.description ? parsed.description : listed.description;
          },
        });
        task = { ...listed, description };

        // 1. Start: the job's spend limit for the judge, and the batch's script and spec in the sandbox.
        await ctx.step({
          name: "put", timeout: 300_000, maxRetries: INTERRUPTIONS,
          run: async s => {
            const account = s.client<Registry>().account.getOrCreate([s.state.input.accountId]);
            await account.jobUpdate({ jobId, status: "running", budgetUsd: services().config.limits.defaultJobBudgetUsd });
            await (await viktorFor(account)).runScript(PUT, [directory, BATCH, JSON.stringify(spec)], 120);
            s.state.status = "running"; s.state.progress.planned = spec.models.length * repeats; s.state.updatedAt = now();
          },
        });

        // 2. One API thread runs the batch, since a test run needs a parent thread. The idempotency key makes a replayed step get the same thread.
        const thread = await ctx.step({
          name: "thread", timeout: 120_000, maxRetries: INTERRUPTIONS,
          run: async s => {
            const account = s.client<Registry>().account.getOrCreate([s.state.input.accountId]);
            const started = await (await viktorFor(account)).startThread(batchMessage(directory), `openmerit-${jobId}`);
            s.state.thread = started; s.state.updatedAt = now();
            return started;
          },
        });

        // 3. Wait for the batch: its progress file says which runs finished; it deletes its copies when it ends.
        // Each time more runs finish, their credits so far are read: past CREDIT_GUARD times the estimate, the job stops.
        const startedAt = Date.now();
        const estimate = estimatedCredits ?? estimateCredits(listed, repeats);
        type Polled = { polls: number; missing: number; counted?: number };
        const batch = await ctx.loop({
          name: "testing", state: { polls: 0, missing: 0, counted: 0 } as Polled,
          run: async (loop, state): Promise<ReturnType<typeof Loop.break<Batch>> | ReturnType<typeof Loop.continue<Polled>>> => {
            await loop.sleep("wait", services().config.viktor.pollMs);
            const read = await loop.step({
              name: "read", timeout: 180_000, maxRetries: INTERRUPTIONS,
              run: async s => {
                const viktorApi = await viktorFor(s.client<Registry>().account.getOrCreate([s.state.input.accountId]));
                const current = readBatch(await viktorApi.runScriptPaged(READ, [spec.out], 60));
                const run = await viktorApi.run(thread.runId);
                s.state.progress.measured = current.runs.length; s.state.updatedAt = now();
                const ids = current.runs.map(item => item.threadId).filter((id): id is string => !!id);
                let used: number | null = null;
                if (current.runs.length > (state.counted ?? 0) && !(current.status === "done" || current.status === "failed")) {
                  const parsed = JSON.parse((await viktorApi.runScript(CREDITS, [JSON.stringify([thread.threadId, ...ids])], 120)).trim().split("\n").at(-1) ?? "{}") as { credits?: Record<string, number | null> };
                  used = Math.round(Object.values(parsed.credits ?? {}).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0));
                }
                return { batch: current.status === "done" || current.status === "failed" ? current : null, status: current.status, run: run.status, runError: run.error, runs: current.runs.length, used };
              },
            });
            if (read.batch) return Loop.break(read.batch);
            if (read.used !== null && read.used > CREDIT_GUARD * estimate) {
              throw new JobStop("stopped", `OpenMerit stopped this evaluation: its test runs had used ${read.used.toLocaleString("en-US")} Viktor credits, more than ${CREDIT_GUARD} times its estimate of about ${estimate.toLocaleString("en-US")}. It stopped the test runs and deleted its copies of the task.`, read.used);
            }
            const missing = read.status === "missing" && ENDED.has(read.run) ? state.missing + 1 : 0;
            if (missing >= MISSING_POLLS) return Loop.break({ status: "failed", runs: [], copies: [], error: `Viktor's thread ended (${read.run}${read.runError ? `: ${read.runError}` : ""}) without running the tests.` });
            if (Date.now() - startedAt > TESTING_LIMIT_MS) return Loop.break({ status: "failed", runs: [], copies: [], error: `The test runs had not finished after ${TESTING_LIMIT_MS / 60_000} minutes.` });
            return Loop.continue({ polls: state.polls + 1, missing, counted: read.runs });
          },
        });
        const reference = batch.runs.filter(run => run.model === current && run.status === "success" && run.report).sort((a, b) => a.repeat - b.repeat)[0];
        if (batch.status === "failed" || !reference) throw new JobStop("failed", `The test runs did not finish: ${redact(batch.error ?? batch.runs.find(run => run.model === current)?.error ?? "no run of the current preset finished").slice(0, 500)}`);

        // 4. Credits per test run, and for the thread that started them.
        const credits = await ctx.step({
          name: "credits", timeout: 180_000, maxRetries: INTERRUPTIONS,
          run: async s => {
            const viktorApi = await viktorFor(s.client<Registry>().account.getOrCreate([s.state.input.accountId]));
            const ids = [thread.threadId, ...batch.runs.map(run => run.threadId).filter((id): id is string => !!id)];
            const parsed = JSON.parse((await viktorApi.runScript(CREDITS, [JSON.stringify(ids)], 120)).trim().split("\n").at(-1) ?? "{}") as { credits?: Record<string, number | null> };
            return parsed.credits ?? {};
          },
        });

        // 5. Grade: a judge on OpenMerit's OpenRouter key writes the checklist, then grades every run on it.
        const graded = await ctx.step({
          name: "grade", timeout: 0, maxRetries: INTERRUPTIONS,
          run: async s => {
            s.state.phase = "grading"; s.state.updatedAt = now();
            const client = s.client<Registry>();
            const account = client.account.getOrCreate([s.state.input.accountId]);
            const { config, fetch } = services();
            if (!config.openrouter.apiKey) throw new JobStop("failed", "OpenMerit's judge is not configured on this server (no OpenRouter key).");
            const index = catalogueIndex(await client.catalogue.getOrCreate(["global"]).get());
            const models = createClient(await account.endpointSecrets(), { fetch, model: id => index.find(id), timeoutMs: 300_000 });
            const ledger = jobLedger(account, jobId);
            const complete = (key: string) => completeWith(models, { endpoint: OPENROUTER, model: config.models.judge, maxTokens: 4096 }, ledger, key, s.abortSignal);
            const checks: Check[] = await writeChecks(complete(`${jobId}/checks`), task, reference);
            const byModel: [string, Measurement[]][] = [];
            for (const model of spec.models) {
              const runs = batch.runs.filter(run => run.model === model).sort((a, b) => a.repeat - b.repeat);
              const measured: Measurement[] = [];
              for (const run of runs) {
                const known = run.threadId ? credits[run.threadId] : undefined;
                const runCredits = typeof known === "number" ? known : isPreset(model) ? RUN_CREDITS[model] : null;
                const measurement = await gradeRun(run, checks, judgeChecks(complete(`${jobId}/grade/${model}/${run.repeat}`), task, reference), runCredits);
                measured.push(typeof known === "number" ? measurement : { ...measurement, costIsEstimate: true });
              }
              byModel.push([model, measured]);
            }
            return { checks, byModel };
          },
        });

        // 6. Evaluate: openmerit/engine's evaluateTask over the cheaper presets, as the connection runs it. The samples are drawn in a recorded step.
        const { evaluated, result } = await evaluateViktor({
          task, checks: graded.checks, graded: new Map(graded.byModel), runs: batch.runs, repeats,
          sample: (reliable, count) => ctx.step("samples", async () => {
            const left = [...reliable], picked: string[] = [];
            for (let index = 0; index < count; index++) picked.push(left.splice(randomInt(left.length), 1)[0]!);
            return picked;
          }),
        });
        if (evaluated.status === "too_few_reliable") throw new JobStop("stopped", `${modelLabel(task)} passed only ${evaluated.reliable.length} of the ${graded.checks.length} checks in every run, so there is nothing reliable to compare the cheaper presets against.`);

        // 7. Action: the report, then the copies are deleted.
        await ctx.step({
          name: "action", timeout: 300_000, maxRetries: INTERRUPTIONS,
          run: async s => {
            const client = s.client<Registry>();
            const account = client.account.getOrCreate([s.state.input.accountId]);
            const left = await cleanup(await viktorFor(account), jobId, task, directory);
            const spent = await account.spent({ jobId });
            const count = graded.checks.length;
            const pick = result.pick;
            const change = pick ? proposeChange(task, { model: pick.model }) : null;
            const usedCredits = Math.round(Object.values(credits).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0));
            const baseline = measuredModel(result.baseline, count);
            const connection: ConnectionResult = {
              kind: "viktor", taskId: task.id, taskTitle: task.title, currentModel: modelLabel(task), change: change && pick ? { text: change.change, link: change.link, model: pick.model } : null,
              creditsUsed: usedCredits, checks: graded.checks, copiesLeft: left,
              runs: batch.runs.map(run => ({ model: run.model, repeat: run.repeat, status: run.status, actions: run.actions.map(action => action.summary ?? "an action"), credits: run.threadId && typeof credits[run.threadId] === "number" ? credits[run.threadId]! : null })),
            };
            const notices = [
              ...(task.conditionScript ? [`${task.title} has a condition script, which decides whether a scheduled run happens. Test mode runs the task whatever it decides, so these runs show what the task does when it runs.`] : []),
              ...(batch.runs.some(run => run.actions.length) ? [`Test mode captured ${batch.runs.reduce((sum, run) => sum + run.actions.length, 0)} outside actions, such as Slack posts, instead of sending them.`] : []),
              ...batch.runs.filter(run => run.status !== "success").map(run => `The ${run.model} test run ${run.repeat} did not finish (${redact(run.error ?? run.status).slice(0, 200)}), so it failed every check.`),
              ...(left.length ? [`OpenMerit could not delete its copies ${left.join(", ")}: delete them in Viktor's scheduled tasks.`] : []),
            ];
            const report: JobResult = {
              status: pick ? "picked" : "keep_current", top: result.top.map(item => measuredModel(item, count)), nearMisses: result.nearMisses.map(item => measuredModel(item, count)), baseline,
              candidates: result.candidates.filter(item => item.status !== "unmeasured").map(item => measuredModel(item, count)),
              pick: pick ? { model: pick.model, endpoint: "viktor", endpointModel: pick.endpointModel, passes: pick.passes, total: pick.total, costPerCallUsd: measuredModel(pick, count).costPerCallUsd, savingPerCallUsd: baseline.costPerCallUsd !== null && pick.costPerItemUsd !== null ? baseline.costPerCallUsd - pick.costPerItemUsd * count : null } : null,
              search: { pool: spec.models.length - 1, unplaced: 0, samples: result.samples, finalists: result.finalists, challengers: result.challengers, shortfall: result.searchShortfall },
              agentEval: null, edit: { edits: [], instructions: change?.instructions ?? null },
              basedOn: basedOn(strongest(mergeEvidence(task.title, runsOn(task)!, [viktor({ tasks: [task] }).evidence(task.id)]))),
              approval: pick ? approvalQuestion(task.title, modelLabel(task), { model: pick.model, endpoint: "viktor" }) : null,
              spend: { openmeritUsd: spent.openmeritUsd, customerUsd: usedCredits * CREDIT_USD }, guardrails: { effective: {}, from: {}, rejected: [] }, notices, fixes: [],
              reportUrl: `${services().config.appUrl}/r/${jobId}/`, catalogueVersion: "viktor-presets", cases: { total: count, fromExamples: 0, written: count },
              connection,
            };
            await finish(s, client, jobId, "done", report, null, usedCredits);
          },
        });
      } catch (error) {
        if (!(error instanceof JobStop)) throw error;
        const stop = error;
        await ctx.step({ name: "stop", timeout: 300_000, maxRetries: INTERRUPTIONS, run: async s => {
          const client = s.client<Registry>();
          const left = await cleanupQuietly(client, s.state, jobId, task, directory);
          await finish(s, client, jobId, stop.status, null, stop.message, stop.credits ?? spentBefore(s.state), left);
        } });
      }
    } catch (error) {
      if (!(error instanceof StepExhaustedError || error instanceof CriticalError)) throw error;
      // The view shows a sentence when it can, and this as its detail.
      const message = redact(error.message).slice(0, 4000);
      await ctx.step({ name: "failed", timeout: 300_000, maxRetries: INTERRUPTIONS, run: async s => {
        const client = s.client<Registry>();
        const left = await cleanupQuietly(client, s.state, jobId, task, directory);
        await finish(s, client, jobId, "failed", null, `The job failed: ${message}`, spentBefore(s.state), left);
      } });
    }
  },
  actions: {
    status: (c): ViktorJobView => {
      const { input, thread: _thread, ...rest } = c.state;
      // Jobs that failed before the error stopped being a notice too kept it in both.
      return { ...rest, notices: rest.notices.filter(notice => notice !== rest.error), ...readableError(rest.error), questions: [], provisional: null, live: null, connection: "viktor", jobId: c.key[0]!, taskId: input.taskId, task: input.task.title, createdAt: input.createdAt };
    },
    /** The task and who started the job, for runs recorded before the account kept them: userId is null when it started on its own. */
    origin: (c): { title: string; path: string; userId: string | null } => ({ title: c.state.input.task.title, path: c.state.input.task.path, userId: c.state.input.userId }),
    /** Whether the job started its Viktor thread, after which it spends credits. */
    threadStarted: (c): boolean => c.state.thread !== null,
    destroy: (c): void => { c.destroy(); },
  },
});

/** Deletes the job's copies and its files in the sandbox; returns the copies that are left. */
async function cleanup(viktorApi: ViktorClient, jobId: string, task: ViktorTask, directory: string): Promise<string[]> {
  const out = JSON.parse((await viktorApi.runScript(CLEANUP, [copyPrefix(jobId, task), directory], 120)).trim().split("\n").at(-1) ?? "{}") as { errors?: string[] };
  return (out.errors ?? []).map(error => error.split(":")[0]!);
}

/** On a failure: cancel the thread's run if it still runs, then clean up; a cleanup that fails is reported, not thrown. */
async function cleanupQuietly(client: AppClient, state: ViktorJobState, jobId: string, task: ViktorTask, directory: string): Promise<string[]> {
  try {
    const viktorApi = await viktorFor(client.account.getOrCreate([state.input.accountId]));
    if (state.thread) {
      const run = await viktorApi.run(state.thread.runId).catch(() => null);
      if (run && !ENDED.has(run.status)) await viktorApi.cancelRun(state.thread.runId).catch(() => {});
    }
    return await cleanup(viktorApi, jobId, task, directory);
  } catch (error) {
    return [`${copyPrefix(jobId, task)}* (${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)})`];
  }
}

type StepState = { state: ViktorJobState };

/** A job that ends before its Viktor thread started spent no credits; after that, its estimate stands in for what it used. */
const spentBefore = (state: { thread: unknown }): number | null => (state.thread ? null : 0);

async function finish(s: StepState, client: AppClient, jobId: string, status: "done" | "stopped" | "failed", result: JobResult | null, error: string | null, credits: number | null, left: string[] = []): Promise<void> {
  const { input } = s.state;
  const account = client.account.getOrCreate([input.accountId]);
  if (result) await account.saveReport({ jobId, taskId: input.taskId, json: { jobId, task: input.task.title, createdAt: input.createdAt, ...result }, markdown: renderViktorMarkdown({ jobId, createdAt: input.createdAt, result }) });
  await account.jobUpdate({ jobId, status, measured: status === "done", ...(credits === null ? {} : { credits }) });
  s.state.status = status; s.state.phase = "done"; s.state.result = result; s.state.error = error; s.state.updatedAt = now();
  if (left.length) s.state.notices.push(`OpenMerit could not delete its copies ${left.join(", ")}: delete them in Viktor's scheduled tasks.`);
}

export type { BatchRun };
