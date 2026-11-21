// Starting a job, for openmerit_recommend and for a watched task: the account checks its plan and
// limits, the task records the bundle, the provisional pick comes from the catalogue and past
// results, and the job's workflow starts.
import { createHash, randomBytes } from "node:crypto";
import { redact } from "./engine.ts";
import { buildPool, provisionalPick, type Provisional } from "./pool.ts";
import { modelKeyRefusal } from "./services.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import type { Guardrails } from "./engine.ts";
import type { AppClient } from "./registry.ts";
import type { JobTrigger } from "./actors/job.ts";

export const DEFAULT_ENVIRONMENT = "default";

/** A task's ID within its account: stable for the same environment and task name. */
export const taskIdFor = (environment: string, task: string) => `t_${createHash("sha256").update(`${environment}\0${task}`).digest("hex").slice(0, 16)}`;
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
  // Keys are never model-visible arguments: they enter only through app.openmerit.ai.
  if (/"(api[_-]?key|authorization|secret|password)"\s*:/i.test(JSON.stringify(value))) return "bundle must not contain keys or secrets: add endpoint keys at app.openmerit.ai instead";
  return null;
}

/** The bundle with secrets redacted from every string, by the CLI's rules, before it is stored anywhere. */
export function redactBundle<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactBundle(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactBundle(item)])) as T;
  return value;
}

/** The highest budget per job a rerun sets; the spend caps still apply. */
export const MAX_RERUN_BUDGET_USD = 1000;

export type StartResult = { ok: true; jobId: string; taskId: string; provisional: Provisional } | { ok: false; error: string };

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
  const started = await account.startJob({ jobId, taskId, kind: input.kind, askedBy: input.askedBy ?? null });
  if (!started.ok) return started;
  const task = client.task.getOrCreate([input.accountId, taskId], { createWithInput: { accountId: input.accountId, taskId, environment: input.environment, name: input.bundle.task } });
  const [catalogue, endpoints, guardrails, past] = await Promise.all([
    client.catalogue.getOrCreate(["global"]).get(), account.endpointsForJob(),
    account.resolveGuardrails({ environment: input.environment, agent: input.agent, taskId }), task.info(),
  ]);
  const measured = past.lastResult?.pick && past.lastResult.currentModel === input.bundle.current.model ? past.lastResult : null;
  const provisional: Provisional = measured
    ? { model: measured.pick!, endpoint: measured.endpoint ?? "openrouter", reason: `Measured for this task on ${measured.finishedAt.slice(0, 10)} (job ${measured.jobId}); this job measures it again.`, estCostPerCallUsd: null }
    : provisionalPick(catalogue, buildPool({ catalogue, endpoints, bundle: input.bundle, guardrails: guardrails.effective }), input.bundle);
  await task.recordJob({ jobId, bundle: input.bundle, agent: input.agent, kind: input.kind });
  await client.job.create([jobId], { input: { accountId: input.accountId, taskId, environment: input.environment, agent: input.agent, bundle: input.bundle, kind: input.kind, trigger: input.trigger, userId: input.userId, provisional, createdAt: new Date().toISOString() } });
  return { ok: true, jobId, taskId, provisional };
}

/**
 * Runs a past run's task again, on the bundle the task last ran on, for a fix in the app or the
 * coding agent. With `budgetUsd`, it first sets the task's budget per job, a task-level guardrail.
 */
export async function rerunJob(client: AppClient, input: { accountId: string; userId: string; jobId: string; budgetUsd?: number | null; trigger: JobTrigger; askedBy?: string | null }): Promise<StartResult> {
  const account = client.account.getOrCreate([input.accountId]);
  const job = await account.job(input.jobId);
  if (!job) return { ok: false, error: `No run ${input.jobId} in this account.` };
  if (job.kind === "langfuse") return { ok: false, error: `${input.jobId} evaluated a Langfuse task, whose cases come from Langfuse rather than a bundle. An admin starts it again with Run again on the run's page in the OpenMerit app.` };
  if (job.kind === "viktor") return { ok: false, error: `${input.jobId} evaluated a Viktor task, which has no bundle to run again. An admin starts it again with Start again on the run's page in the OpenMerit app; it uses Viktor credits from the workspace.` };
  const row = await account.task(job.taskId);
  const bundle = row ? (await client.task.get([input.accountId, row.id]).info()).bundle : null;
  if (!row || !bundle) return { ok: false, error: "This run's task no longer has a bundle to run again: send one with openmerit_recommend." };
  if (input.budgetUsd !== undefined && input.budgetUsd !== null) {
    if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0 || input.budgetUsd > MAX_RERUN_BUDGET_USD) return { ok: false, error: `The budget must be more than $0 and at most $${MAX_RERUN_BUDGET_USD}.` };
    const settings = Object.fromEntries((await account.guardrails({ level: "task", scope: row.id })).map(item => [item.key, item.value])) as Guardrails;
    await account.setGuardrails({ level: "task", scope: row.id, settings: { ...settings, budgetUsd: input.budgetUsd } });
  }
  return startJob(client, { accountId: input.accountId, environment: row.environment, agent: row.agent, bundle, kind: "run", trigger: input.trigger, userId: input.userId, askedBy: input.askedBy ?? null });
}
