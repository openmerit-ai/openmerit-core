// The Langfuse connection in the cloud app: connect with a Viewer key pair, list the project's tasks
// from its generations, evaluate the ones a person picks, within the plan's evaluations, and record
// an approval. What a task is, where its cases come from and what change
// it proposes are openmerit-core's Langfuse connection; each evaluation is an agent `job` that
// reads its bundle and cases from Langfuse (`JobInput.connection`).
import { checkKey, LangfuseError, listTasks, type LangfuseConnection, type LangfuseListing, type LangfuseTask } from "../../openmerit-core/src/connectors/langfuse/connection.ts";
import { normalizeBaseUrl } from "../../openmerit-core/src/connectors/langfuse/client.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import type { Auth } from "./auth.ts";
import { redact } from "./engine.ts";
import { endpointUrlProblem } from "./keys.ts";
import { buildPool, provisionalPick } from "./pool.ts";
import type { AppClient } from "./registry.ts";
import type { JobResult } from "./report.ts";
import { modelKeyRefusal, services } from "./services.ts";
import { newJobId } from "./start.ts";
import { armRelist, isListing, isNew, namedApproval, type Seen, type TaskStatus } from "./viktor.ts";

export const LANGFUSE = "langfuse";
export const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export interface LangfuseTaskView {
  id: string; name: string; model: string; generations: number; costUsd: number | null; models: number;
  status: TaskStatus;
  /** Why it is skipped or failed; null otherwise. */
  reason: string | null;
  /** The most an evaluation may spend on model calls: the task's budget per job. Null when skipped. */
  budgetUsd: number | null;
  /** Why Evaluate or Start again cannot start it now: the plan. Null when it can, or while it is evaluating. */
  blocked: string | null;
  /** First listed after the connection's first listing, and not yet opened or evaluated. */
  isNew: boolean;
  jobId: string | null;
  /** A finished evaluation's verdict. */
  result: { status: string; change: string | null; link: string | null; approval: { by: string; name: string | null; at: string } | null } | null;
}

export interface LangfuseView {
  connected: boolean;
  baseUrl?: string; projectName?: string; keyLast4?: string; connectedAt?: string; connectedBy?: string;
  listedAt?: string | null; listingError?: string | null;
  /** A listing is running: the page polls until it ends. */
  listing?: boolean;
  /** The listing reached Langfuse's row limit, so the cheapest tasks may be missing. */
  truncated?: boolean;
  tasks: LangfuseTaskView[];
}

type Listing = LangfuseListing & { baseUrl: string };
type People = Pick<Auth, "person"> | null;
type Account = ReturnType<AppClient["account"]["getOrCreate"]>;

export const langfuseTaskId = (task: Pick<LangfuseTask, "id">) => `langfuse_${task.id}`;
const active = (job: { status: string }) => job.status === "queued" || job.status === "running";
const options = () => ({ fetch: services().fetch, retries: 2 });

async function credentials(account: Account): Promise<LangfuseConnection | null> {
  const sealed = await account.connectionKey(LANGFUSE);
  return sealed ? JSON.parse(sealed) as LangfuseConnection : null;
}

/**
 * Checks the key pair, refusing one that can write; stores it encrypted and lists the tasks. It starts
 * no evaluation: a person picks which to evaluate. The connection reads the project's generations and dataset items; it never writes.
 */
export async function connectLangfuse(client: AppClient, input: { accountId: string; userId: string; baseUrl?: string; publicKey: string; secretKey: string }): Promise<{ ok: true; view: LangfuseView } | { ok: false; status: number; error: string }> {
  const publicKey = input.publicKey.trim(), secretKey = input.secretKey.trim();
  if (!/^pk-lf-/.test(publicKey) || !/^sk-lf-/.test(secretKey)) return { ok: false, status: 400, error: "Paste a Langfuse public key (pk-lf-…) and secret key (sk-lf-…) from Project Settings → API Keys." };
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(input.baseUrl?.trim() || DEFAULT_BASE_URL); } catch (error) { return { ok: false, status: 400, error: (error as Error).message.replace("LANGFUSE_BASE_URL", "The base URL") }; }
  // The app calls it from inside Rivet Cloud with the key pair: a public https host only, as for an endpoint.
  const refused = endpointUrlProblem(baseUrl, services().config.allowPrivateEndpoints);
  if (refused) return { ok: false, status: 400, error: `The Langfuse base URL is refused: ${refused.replace("baseUrl", "it")}.` };
  const connection = { baseUrl, publicKey, secretKey };
  let project;
  try { project = await checkKey(connection, options()); } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
    return { ok: false, status: 400, error: error instanceof LangfuseError && error.status === 401 ? `Langfuse refused this key pair at ${baseUrl}. Check both keys, and that the base URL is the region that issued them (such as https://us.cloud.langfuse.com).` : message };
  }
  const account = client.account.getOrCreate([input.accountId]);
  const stored = await account.saveConnection({ kind: LANGFUSE, apiKey: JSON.stringify(connection), keyLast4: publicKey.slice(-4), keyType: project.projectName, teamId: project.projectId, creditCap: 0, userId: input.userId });
  if (!stored.ok) return { ok: false, status: 503, error: stored.error };
  await refreshLangfuse(client, input.accountId);
  await armRelist(client, input.accountId, LANGFUSE, true);
  return { ok: true, view: await langfuseView(client, input.accountId) };
}

/** Lists the project's tasks again, with GETs only; a failure is kept on the connection, and the last listing stays. Returns that error, or null. */
export async function refreshLangfuse(client: AppClient, accountId: string): Promise<string | null> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await credentials(account);
  if (!connection) return null;
  try {
    const listing: Listing = { ...await listTasks(connection, options()), baseUrl: connection.baseUrl };
    await account.saveListing({ kind: LANGFUSE, listing, error: null });
    return null;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
    await account.saveListing({ kind: LANGFUSE, listing: null, error: message });
    return message;
  }
}

/** The most a task's evaluation may spend on model calls: its budget per job, as the job resolves it. */
async function budgetFor(account: Account, task: LangfuseTask): Promise<number> {
  const { effective } = await account.resolveGuardrails({ environment: LANGFUSE, agent: null, taskId: langfuseTaskId(task) });
  return effective.budgetUsd ?? services().config.limits.defaultJobBudgetUsd;
}

/**
 * Starts evaluating `taskIds`, which a signed-in admin picked with Evaluate or Start again; nothing
 * starts one on its own. Each counts `EVALUATIONS_PER_JOB.langfuse` evaluations, and the plan and the
 * account's job limits check it. Returns why the first task that could not start did not.
 */
export async function startLangfuseTasks(client: AppClient, input: { accountId: string; userId: string; taskIds: readonly string[] }): Promise<{ started: string[]; jobIds: string[]; refused: string | null }> {
  const account = client.account.getOrCreate([input.accountId]);
  const connection = await account.connection(LANGFUSE);
  if (!connection) return { started: [], jobIds: [], refused: "Langfuse is not connected." };
  const listing = connection.listing as Listing | null;
  const jobs = await account.connectionJobs({ kind: LANGFUSE, since: Date.parse(connection.connectedAt) });
  const running = new Set(jobs.filter(active).map(job => job.taskId));
  const wanted = (listing?.tasks ?? []).filter(task => !task.skipped && !running.has(langfuseTaskId(task)) && input.taskIds.includes(task.id));
  const keyRefusal = wanted.length ? await modelKeyRefusal() : null;
  if (keyRefusal) return { started: [], jobIds: [], refused: keyRefusal };
  const started: string[] = [], jobIds: string[] = [];
  for (const task of wanted) {
    const refusal = await account.evaluationRefusal(LANGFUSE);
    if (refusal) return { started, jobIds, refused: `${task.name} cannot start: ${refusal}` };
    const jobId = newJobId();
    const ok = await account.startJob({ jobId, taskId: langfuseTaskId(task), kind: LANGFUSE, askedBy: null, title: task.name, startedBy: input.userId });
    if (!ok.ok) return { started, jobIds, refused: ok.error };
    // The job reads the bundle from Langfuse; until then the pool and provisional pick go by the current model.
    const bundle: TaskBundle = { task: task.name, current: { model: task.model }, prompt: { messages: [] }, output: { kind: "text" } };
    const [catalogue, endpoints, guardrails] = await Promise.all([client.catalogue.getOrCreate(["global"]).get(), account.endpointsForJob(), account.resolveGuardrails({ environment: LANGFUSE, agent: null, taskId: langfuseTaskId(task) })]);
    const provisional = provisionalPick(catalogue, buildPool({ catalogue, endpoints, bundle, guardrails: guardrails.effective }), bundle);
    await client.job.create([jobId], { input: {
      accountId: input.accountId, taskId: langfuseTaskId(task), environment: LANGFUSE, agent: null, bundle, kind: "run", trigger: "app", userId: input.userId,
      provisional, createdAt: new Date().toISOString(), connection: { kind: "langfuse", task, links: { baseUrl: listing!.baseUrl, projectId: listing!.projectId } },
    } });
    started.push(task.id); jobIds.push(jobId);
  }
  return { started, jobIds, refused: null };
}

/** The connection and its task table: each task's latest evaluation, why it is skipped, and whether Evaluate can start it now. */
export async function langfuseView(client: AppClient, accountId: string, people: People = null): Promise<LangfuseView> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await account.connection(LANGFUSE);
  if (!connection) return { connected: false, tasks: [] };
  const listing = connection.listing as Listing | null;
  const jobs = await account.connectionJobs({ kind: LANGFUSE, since: Date.parse(connection.connectedAt) });
  const refusal = await account.evaluationRefusal(LANGFUSE);
  await armRelist(client, accountId, LANGFUSE);
  const tasks = await Promise.all((listing?.tasks as (LangfuseTask & Seen)[] | undefined ?? []).map(async (task): Promise<LangfuseTaskView> => {
    const latest = jobs.find(job => job.taskId === langfuseTaskId(task));
    const blocked = task.skipped || (latest && active(latest)) ? null : refusal;
    const base = { id: task.id, name: task.name, model: task.model, generations: task.generations, costUsd: task.costUsd, models: task.models.length, budgetUsd: task.skipped ? null : await budgetFor(account, task), blocked, isNew: !task.skipped && isNew(task, connection.connectedAt, !!latest), jobId: latest?.id ?? null, result: null };
    if (task.skipped) return { ...base, status: "skipped", reason: task.skipped };
    if (!latest) return { ...base, status: "not_evaluated", reason: null };
    if (active(latest)) return { ...base, status: "evaluating", reason: null };
    const report = (await account.report({ jobId: latest.id }))?.json as JobResult | undefined;
    if (latest.status !== "done" || !report) return { ...base, status: "failed", reason: latest.status === "stopped" ? "The evaluation was stopped." : "The evaluation did not finish." };
    const approval = await namedApproval(client, people, accountId, latest.id);
    return { ...base, status: "done", reason: null, result: { status: report.status, change: report.langfuse?.change?.text ?? null, link: report.langfuse?.change?.link ?? null, approval: approval ? { by: approval.by, name: approval.name, at: approval.at } : null } };
  }));
  const baseUrl = listing?.baseUrl ?? (await credentials(account))?.baseUrl ?? null;
  return {
    connected: true, ...(baseUrl ? { baseUrl } : {}), ...(connection.keyType ? { projectName: connection.keyType } : {}),
    keyLast4: connection.keyLast4, connectedAt: connection.connectedAt, connectedBy: connection.connectedBy,
    listedAt: connection.listedAt, listingError: connection.listingError, listing: await isListing(client, accountId, LANGFUSE), truncated: listing?.truncated ?? false, tasks,
  };
}
