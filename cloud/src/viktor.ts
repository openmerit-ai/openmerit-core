// The Viktor connection in the cloud app: connect with a key, list the workspace's tasks, start
// evaluating them without being asked, highest spend first, and record an approval. What a task is,
// which can be evaluated, what an evaluation costs and what it proposes are openmerit-core's Viktor
// connection; this module checks the account's limits and starts the jobs.
import { randomBytes } from "node:crypto";
import { CLEANUP, COPY_PATH, DEFAULT_CREDIT_CAP, estimateCredits, keyProblem, LIST, readTasks, viktorClient, type ViktorTask } from "../../openmerit-core/src/connectors/viktor/index.ts";
import { approve, DEFAULT_REPEATS, redact } from "./engine.ts";
import type { ConnectionResult, JobResult } from "./report.ts";
import { services } from "./services.ts";
import type { AppClient } from "./registry.ts";

export const VIKTOR = "viktor";
export const MAX_CREDIT_CAP = 100_000;

/** A task's place in the connection's table. */
export type TaskStatus = "skipped" | "waiting" | "evaluating" | "done" | "failed";

export interface ViktorTaskView {
  id: string; title: string; path: string; model: string | null; credits30d: number; paused: boolean;
  status: TaskStatus;
  /** Why it is skipped, waiting or failed; null otherwise. */
  reason: string | null;
  estimatedCredits: number | null;
  jobId: string | null;
  /** A finished evaluation's verdict. */
  result: { status: string; change: string | null; link: string | null; approval: { by: string; at: string } | null } | null;
}

export interface ViktorView {
  connected: boolean;
  keyLast4?: string; keyType?: string | null; creditCap?: number; connectedAt?: string; connectedBy?: string;
  creditsUsed?: number; creditsReserved?: number; listedAt?: string | null; listingError?: string | null;
  tasks: ViktorTaskView[];
}

export const viktorTaskId = (task: Pick<ViktorTask, "id">) => `viktor_${task.id}`;
const newJobId = () => `job_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${randomBytes(6).toString("hex")}`;

type Account = ReturnType<AppClient["account"]["getOrCreate"]>;
const apiFor = (apiKey: string) => viktorClient({ apiKey, baseUrl: services().config.viktor.baseUrl, fetch: services().fetch });

/** Checks the key's scopes, stores it encrypted, lists the tasks and starts evaluating them. */
export async function connectViktor(client: AppClient, input: { accountId: string; userId: string; apiKey: string; creditCap?: number }): Promise<{ ok: true; view: ViktorView } | { ok: false; status: number; error: string }> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 12) return { ok: false, status: 400, error: "Paste the Viktor API key from Settings → API Keys." };
  const cap = input.creditCap ?? DEFAULT_CREDIT_CAP;
  if (!Number.isFinite(cap) || cap < 100 || cap > MAX_CREDIT_CAP) return { ok: false, status: 400, error: `The credit cap must be between 100 and ${MAX_CREDIT_CAP.toLocaleString("en-US")} credits.` };
  const checked = await keyProblem(apiFor(apiKey));
  if ("problem" in checked) return { ok: false, status: 400, error: checked.problem };
  const account = client.account.getOrCreate([input.accountId]);
  const stored = await account.saveConnection({ kind: VIKTOR, apiKey, keyType: checked.key.keyType, teamId: checked.key.teamId, creditCap: cap, userId: input.userId });
  if (!stored.ok) return { ok: false, status: 503, error: stored.error };
  await refreshViktor(client, input.accountId);
  await startViktorTasks(client, { accountId: input.accountId, userId: null });
  return { ok: true, view: await viktorView(client, input.accountId) };
}

/** Lists the workspace's tasks again, and deletes OpenMerit's leftover copies when no job is running. */
export async function refreshViktor(client: AppClient, accountId: string): Promise<void> {
  const account = client.account.getOrCreate([accountId]);
  const apiKey = await account.connectionKey(VIKTOR);
  if (!apiKey) return;
  try {
    const api = apiFor(apiKey);
    const { tasks, leftovers } = readTasks(await api.runScript(LIST, [], 180));
    await account.saveListing({ kind: VIKTOR, listing: tasks, error: null });
    const running = (await account.connectionJobs({ kind: VIKTOR, since: 0 })).some(job => job.status === "queued" || job.status === "running");
    if (leftovers.length && !running) await api.runScript(CLEANUP, [COPY_PATH], 120);
  } catch (error) {
    await account.saveListing({ kind: VIKTOR, listing: null, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
}

/**
 * Starts evaluations, highest credits first: every task that can be evaluated and has none yet, or
 * only `taskIds` when a person pressed Start. Each counts one of the plan's evaluations, and none
 * starts past the credit cap, counting what running jobs expect to use. Returns why the first one
 * that could not start did not.
 */
export async function startViktorTasks(client: AppClient, input: { accountId: string; userId: string | null; taskIds?: readonly string[] }): Promise<{ started: string[]; jobIds: string[]; refused: string | null }> {
  const account = client.account.getOrCreate([input.accountId]);
  const connection = await account.connection(VIKTOR);
  if (!connection) return { started: [], jobIds: [], refused: "Viktor is not connected." };
  const tasks = (connection.listing as ViktorTask[] | null) ?? [];
  const jobs = await account.connectionJobs({ kind: VIKTOR, since: Date.parse(connection.connectedAt) });
  const evaluated = new Set(jobs.map(job => job.taskId));
  let committed = jobs.reduce((sum, job) => sum + (job.credits ?? 0), 0);
  const wanted = tasks.filter(task => !task.skipped && (input.taskIds ? input.taskIds.includes(task.id) : !evaluated.has(viktorTaskId(task))));
  const started: string[] = [], jobIds: string[] = [];
  for (const task of wanted) {
    if (jobs.some(job => job.taskId === viktorTaskId(task) && (job.status === "queued" || job.status === "running"))) continue;
    const credits = estimateCredits(task, DEFAULT_REPEATS);
    if (committed + credits > connection.creditCap) return { started, jobIds, refused: `Evaluating ${task.title} needs about ${credits} credits, and ${Math.round(committed)} of the ${connection.creditCap}-credit cap are used or expected. Raise the cap to start it.` };
    const jobId = newJobId();
    const ok = await account.startJob({ jobId, taskId: viktorTaskId(task), kind: "viktor", askedBy: null, credits });
    if (!ok.ok) return { started, jobIds, refused: ok.error };
    await client.viktorJob.create([jobId], { input: { accountId: input.accountId, taskId: viktorTaskId(task), task, repeats: DEFAULT_REPEATS, userId: input.userId, createdAt: new Date().toISOString() } });
    committed += credits; started.push(task.id); jobIds.push(jobId);
  }
  return { started, jobIds, refused: null };
}

/** The connection and its task table: each task's latest evaluation, or why it waits or is skipped. */
export async function viktorView(client: AppClient, accountId: string): Promise<ViktorView> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await account.connection(VIKTOR);
  if (!connection) return { connected: false, tasks: [] };
  const jobs = await account.connectionJobs({ kind: VIKTOR, since: Date.parse(connection.connectedAt) });
  const used = jobs.filter(job => !(job.status === "queued" || job.status === "running")).reduce((sum, job) => sum + (job.credits ?? 0), 0);
  const reserved = jobs.filter(job => job.status === "queued" || job.status === "running").reduce((sum, job) => sum + (job.credits ?? 0), 0);
  const tasks = await Promise.all(((connection.listing as ViktorTask[] | null) ?? []).map(async (task): Promise<ViktorTaskView> => {
    const latest = jobs.find(job => job.taskId === viktorTaskId(task)) ?? null;
    const base = { id: task.id, title: task.title, path: task.path, model: task.model, credits30d: task.credits30d, paused: task.paused, jobId: latest?.id ?? null, estimatedCredits: task.skipped ? null : estimateCredits(task, DEFAULT_REPEATS), result: null };
    if (task.skipped) return { ...base, status: "skipped", reason: task.skipped };
    if (!latest) return { ...base, status: "waiting", reason: "Not started: past the credit cap or the plan's evaluations." };
    if (latest.status === "queued" || latest.status === "running") return { ...base, status: "evaluating", reason: null };
    if (latest.status !== "done") return { ...base, status: "failed", reason: (await client.viktorJob.get([latest.id]).status().catch(() => null))?.error ?? latest.status };
    const report = (await account.report({ jobId: latest.id }))?.json as (JobResult & { connection?: ConnectionResult }) | undefined;
    const approval = await account.approval(latest.id);
    return { ...base, status: "done", reason: null, result: { status: report?.status ?? "done", change: report?.connection?.change?.text ?? null, link: report?.connection?.change?.link ?? null, approval: approval ? { by: approval.by, at: approval.at } : null } };
  }));
  return {
    connected: true, keyLast4: connection.keyLast4, keyType: connection.keyType, creditCap: connection.creditCap, connectedAt: connection.connectedAt, connectedBy: connection.connectedBy,
    creditsUsed: Math.round(used), creditsReserved: Math.round(reserved), listedAt: connection.listedAt, listingError: connection.listingError, tasks,
  };
}

/** Records who approved a finished result's change, and when. It changes nothing in Viktor (decision 9). */
export async function approveChange(client: AppClient, input: { accountId: string; userId: string; jobId: string }): Promise<{ ok: true; approval: { change: string; link: string | null; by: string; at: string } } | { ok: false; status: number; error: string }> {
  const account = client.account.getOrCreate([input.accountId]);
  const report = (await account.report({ jobId: input.jobId }))?.json as (JobResult & { connection?: ConnectionResult }) | undefined;
  if (!report) return { ok: false, status: 404, error: "This run has no result yet." };
  const change = report.connection?.change;
  if (!change || !report.pick) return { ok: false, status: 409, error: "This result proposes no change to approve." };
  const approved = approve({ edits: [], instructions: report.edit.instructions }, { model: change.model, endpoint: "viktor", endpointModel: change.model, onOpenRouter: false }, { by: input.userId, at: new Date().toISOString() });
  const saved = await account.approve({ jobId: input.jobId, change: change.text, link: change.link, by: approved.approval.by, at: approved.approval.at });
  return { ok: true, approval: { change: saved.change, link: saved.link, by: saved.by, at: saved.at } };
}
