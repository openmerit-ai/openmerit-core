// Starting a job, for openmerit_recommend and for a watched task: the account checks that the task's
// eval is not waiting for review, its plan and limits, the task records the bundle, the provisional pick comes from the catalogue and past
// results, and the job's workflow starts.
import { createHash, randomBytes } from "node:crypto";
import { redact } from "./engine.ts";
import { buildPool, provisionalPick, type Provisional } from "../../openmerit-core/src/job/pool.ts";
import { modelKeyRefusal, services } from "./services.ts";
import { writeCases, type TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import type { Guardrails } from "./engine.ts";
import type { AppClient } from "./registry.ts";
import { estimateJob, redactBundle, taskIdFor, type JobEstimate, type JobTrigger } from "../../openmerit-core/src/job/workflow.ts";
import { callCost } from "../../openmerit-core/src/ranking/index.ts";
import { catalogueIndex, DEFAULT_REPEATS } from "../../openmerit-core/src/engine/index.ts";

export { redactBundle, taskIdFor };

export const DEFAULT_ENVIRONMENT = "default";

/**
 * A task's ID within its account: stable for the same project, environment and task name. The default
 * project keeps the ID tasks had before projects, so their runs, labels and guardrails stay theirs.
 */
export const newJobId = () => `job_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${randomBytes(6).toString("hex")}`;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_BUNDLE_BYTES = 256 * 1024;

/** Why a task bundle cannot be used, or null. Checks shape only; the case writer judges the content. */
export function bundleProblem(value: unknown): string | null {
  if (!object(value)) return "bundle must be an object";
  if (JSON.stringify(value).length > MAX_BUNDLE_BYTES) return `bundle is larger than ${MAX_BUNDLE_BYTES / 1024} KB`;
  if (typeof value.task !== "string" || !value.task.trim() || value.task.length > 200) return "bundle.task must be the task's name, up to 200 characters";
  if (!object(value.current) || typeof value.current.model !== "string" || !value.current.model.trim()) return "bundle.current.model must name the model the code uses now";
  if (!object(value.prompt) || !Array.isArray(value.prompt.messages) || !value.prompt.messages.length) return "bundle.prompt.messages must list the prompt's messages";
  if (!value.prompt.messages.every(message => object(message) && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")) return "each prompt message needs a role of user or assistant and string content";
  const output = value.output;
  if (!object(output) || !["text", "json", "label"].includes(String(output.kind))) return "bundle.output.kind must be text, json or label";
  if (output.kind === "label" && (!Array.isArray(output.labels) || !output.labels.length || !output.labels.every(label => typeof label === "string"))) return "bundle.output.labels must list the labels";
  if (output.kind === "json" && !object(output.schema)) return "bundle.output.schema must be a JSON schema";
  if (value.examples !== undefined && (!Array.isArray(value.examples) || !value.examples.every(example => object(example) && object(example.input) && Object.values(example.input).every(item => typeof item === "string")))) return "each example needs an input object of strings";
  for (const field of ["criteria", "guardrails"] as const) if (value[field] !== undefined && (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(item => typeof item === "string" && item.trim()))) return `bundle.${field} must list statements as strings`;
  if (value.steps !== undefined && (!Array.isArray(value.steps) || !value.steps.every(item => object(item) && typeof item.description === "string"))) return "each of bundle.steps needs a description";
  if (Array.isArray(value.steps) && !value.steps.every((item, index) => object(item) && (item.required === undefined || typeof item.required === "boolean")
    && (item.after === undefined || (Array.isArray(item.after) && item.after.every(number => Number.isInteger(number) && number >= 1 && number <= index))))) return "each of bundle.steps may set required to true or false, and after to the 1-based numbers of earlier steps";
  // Keys are never model-visible arguments: they enter only through app.openmerit.ai.
  if (/"(api[_-]?key|authorization|secret|password)"\s*:/i.test(JSON.stringify(value))) return "bundle must not contain keys or secrets: add endpoint keys at app.openmerit.ai instead";
  return null;
}


/** The highest budget per job a rerun sets; the spend caps still apply. */
export const MAX_RERUN_BUDGET_USD = 1000;

export type StartResult = { ok: true; jobId: string; taskId: string; provisional: Provisional; estimate: JobEstimate } | { ok: false; error: string };

/**
 * `trigger` is where the job was started: app.openmerit.ai, an MCP tool call or a task's watch.
 * `userId` is the Clerk user who started it; a watch job has none.
 */
export async function startJob(client: AppClient, start: { accountId: string; environment: string; agent: string | null; bundle: TaskBundle; kind: "run" | "watch"; trigger: JobTrigger; userId: string | null; askedBy?: string | null }): Promise<StartResult> {
  const input = { ...start, bundle: redactBundle(start.bundle) };
  const taskId = taskIdFor(input.environment, input.bundle.task);
  const jobId = newJobId();
  const account = client.account.getOrCreate([input.accountId]);
  const keyRefusal = await modelKeyRefusal();
  if (keyRefusal) return { ok: false, error: keyRefusal };
  // A task whose prompt, tools or output changed since its eval was accepted waits for a person to review the eval.
  const examples = (await writeCases({ bundle: input.bundle, complete: async () => "", count: 0 })).cases;
  const gate = await account.evalGate({ taskId, bundle: input.bundle, examples });
  if (!gate.ok) return gate;
  await settleOrphans(client, input.accountId);
  const started = await account.startJob({ jobId, taskId, kind: input.kind, askedBy: input.askedBy ?? null });
  if (!started.ok) return started;
  try {
    return await launch(client, input, { jobId, taskId });
  } catch (error) {
    // The account recorded the job but its actor may not exist: left queued, it would never run, would hold one of the
    // account's concurrent jobs and would block deleting its task. A job whose actor did start keeps going, and one
    // Rivet cannot answer for is left for settleOrphans.
    if (await jobExists(client, jobId) !== false) throw error;
    await account.jobUpdate({ jobId, status: "failed" }).catch(() => undefined);
    return { ok: false, error: `OpenMerit could not start the job (${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}). Nothing was charged: try again.` };
  }
}

/** Whether a job's actor exists: false when Rivet says it does not, null when Rivet could not say. */
async function jobExists(client: AppClient, jobId: string): Promise<boolean | null> {
  try { await client.job.get([jobId]).status(); return true; } catch (error) {
    const { group, code } = error as { group?: unknown; code?: unknown };
    return group === "actor" && (code === "not_found" || code === "destroyed") ? false : null;
  }
}

/**
 * Marks failed the account's unfinished jobs whose actor does not exist, such as one whose start failed in an
 * outage before startJob caught that: they would never finish. Only jobs older than config.orphanAfterMs, so a
 * start under way is left alone. Returns the IDs it settled.
 */
export async function settleOrphans(client: AppClient, accountId: string, taskId?: string): Promise<string[]> {
  const account = client.account.getOrCreate([accountId]);
  const stale = (await account.unfinishedJobs()).filter(job => (!taskId || job.taskId === taskId) && Date.now() - job.startedAt > services().config.orphanAfterMs);
  const settled: string[] = [];
  for (const job of stale) {
    if (await jobExists(client, job.id) !== false) continue;
    await account.jobUpdate({ jobId: job.id, status: "failed" });
    settled.push(job.id);
  }
  return settled;
}

async function launch(client: AppClient, input: { accountId: string; environment: string; agent: string | null; bundle: TaskBundle; kind: "run" | "watch"; trigger: JobTrigger; userId: string | null }, ids: { jobId: string; taskId: string }): Promise<StartResult> {
  const { jobId, taskId } = ids;
  const account = client.account.getOrCreate([input.accountId]);
  const task = client.task.getOrCreate([input.accountId, taskId], { createWithInput: { accountId: input.accountId, taskId, environment: input.environment, name: input.bundle.task } });
  const [catalogue, endpoints, guardrails, past, accepted] = await Promise.all([
    client.catalogue.getOrCreate(["global"]).get(), account.endpointsForJob(),
    account.resolveGuardrails({ environment: input.environment, agent: input.agent, taskId }), task.info(), account.evalFor(taskId),
  ]);
  const measured = past.lastResult?.pick && past.lastResult.currentModel === input.bundle.current.model ? past.lastResult : null;
  const pool = buildPool({ catalogue, endpoints, bundle: input.bundle, guardrails: guardrails.effective });
  const provisional: Provisional = measured
    ? { model: measured.pick!, endpoint: measured.endpoint ?? "openrouter", reason: `Measured for this task on ${measured.finishedAt.slice(0, 10)} (job ${measured.jobId}); this job measures it again.`, estCostPerCallUsd: null }
    : provisionalPick(catalogue, pool, input.bundle);
  const { config } = services();
  const index = catalogueIndex(catalogue);
  const estimate = estimateJob(pool, input.bundle, {
    repeats: Math.max(1, guardrails.effective.repeats ?? DEFAULT_REPEATS), budgetUsd: guardrails.effective.budgetUsd ?? config.limits.defaultJobBudgetUsd,
    costPerCall: model => callCost(index.find(model), input.bundle), judge: input.bundle.output.kind === "text" || input.bundle.guardrails?.length ? config.models.judge : null,
    // As the job decides: a person grades a first run's answers, before any eval is accepted.
    grading: input.kind === "run" && !accepted && !!config.openrouter.apiKey,
  });
  await task.recordJob({ jobId, bundle: input.bundle, agent: input.agent, kind: input.kind });
  await client.job.create([jobId], { input: { accountId: input.accountId, taskId, environment: input.environment, agent: input.agent, bundle: input.bundle, kind: input.kind, trigger: input.trigger, userId: input.userId, provisional, createdAt: new Date().toISOString() } });
  return { ok: true, jobId, taskId, provisional, estimate };
}

/**
 * Runs a past run's task again, on the bundle the task last ran on, for a fix in the app or the
 * coding agent. With `budgetUsd`, it first sets the task's budget per job, a task-level guardrail.
 */
export async function rerunJob(client: AppClient, input: { accountId: string; userId: string; jobId: string; budgetUsd?: number | null; trigger: JobTrigger; askedBy?: string | null }): Promise<StartResult> {
  const job = await client.account.getOrCreate([input.accountId]).job(input.jobId);
  if (!job) return { ok: false, error: `No run ${input.jobId} in this account.` };
  return runTask(client, { ...input, taskId: job.taskId });
}

/** Runs a task on the bundle it last ran on. */
export async function runTask(client: AppClient, input: { accountId: string; userId: string; taskId: string; budgetUsd?: number | null; trigger: JobTrigger; askedBy?: string | null }): Promise<StartResult> {
  const account = client.account.getOrCreate([input.accountId]);
  const row = await account.task(input.taskId);
  const bundle = row ? (await client.task.get([input.accountId, row.id]).info()).bundle : null;
  if (!row || !bundle) return { ok: false, error: "This run's task no longer has a bundle to run again: send one with openmerit_recommend." };
  if (input.budgetUsd !== undefined && input.budgetUsd !== null) {
    if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0 || input.budgetUsd > MAX_RERUN_BUDGET_USD) return { ok: false, error: `The budget must be more than $0 and at most $${MAX_RERUN_BUDGET_USD}.` };
    const settings = Object.fromEntries((await account.guardrails({ level: "task", scope: row.id })).map(item => [item.key, item.value])) as Guardrails;
    await account.setGuardrails({ level: "task", scope: row.id, settings: { ...settings, budgetUsd: input.budgetUsd } });
  }
  return startJob(client, { accountId: input.accountId, environment: row.environment, agent: row.agent, bundle, kind: "run", trigger: input.trigger, userId: input.userId, askedBy: input.askedBy ?? null });
}
