// The Langfuse connection in the cloud app: connect with a Viewer key pair, list the project's tasks
// from its generations, evaluate them without being asked, highest spend first, within the plan's
// evaluations, and record an approval. What a task is, where its cases come from and what change
// it proposes are openmerit-core's Langfuse connection; each evaluation is an agent `job` that
// reads its bundle and cases from Langfuse (`JobInput.connection`).
import { checkKey, LangfuseError, listTasks, type LangfuseConnection, type LangfuseListing, type LangfuseTask } from "../../openmerit-core/src/connectors/langfuse/connection.ts";
import { normalizeBaseUrl } from "../../openmerit-core/src/connectors/langfuse/client.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { EVALUATIONS_PER_JOB } from "./actors/account.ts";
import type { Auth } from "./auth.ts";
import { redact } from "./engine.ts";
import { endpointUrlProblem } from "./keys.ts";
import { buildPool, provisionalPick } from "./pool.ts";
import type { AppClient } from "./registry.ts";
import type { JobResult } from "./report.ts";
import { services } from "./services.ts";
import { newJobId } from "./start.ts";
import { namedApproval, type TaskStatus } from "./viktor.ts";

export const LANGFUSE = "langfuse";
export const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export interface LangfuseTaskView {
  id: string; name: string; model: string; generations: number; costUsd: number | null; models: number;
  status: TaskStatus;
  /** Why it is skipped, waiting or failed; null otherwise. */
  reason: string | null;
  jobId: string | null;
  /** A finished evaluation's verdict. */
  result: { status: string; change: string | null; link: string | null; approval: { by: string; name: string | null; at: string } | null } | null;
}

export interface LangfuseView {
  connected: boolean;
  baseUrl?: string; projectName?: string; keyLast4?: string; connectedAt?: string; connectedBy?: string;
  listedAt?: string | null; listingError?: string | null;
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
 * Checks the key pair, refusing one that can write; stores it encrypted, lists the tasks and starts
 * evaluating them. The connection reads the project's generations and dataset items; it never writes.
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
  await startLangfuseTasks(client, { accountId: input.accountId, userId: null });
  return { ok: true, view: await langfuseView(client, input.accountId) };
}

/** Lists the project's tasks again; a failure is kept on the connection, and the last listing stays. */
export async function refreshLangfuse(client: AppClient, accountId: string): Promise<void> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await credentials(account);
  if (!connection) return;
  try {
    const listing: Listing = { ...await listTasks(connection, options()), baseUrl: connection.baseUrl };
    await account.saveListing({ kind: LANGFUSE, listing, error: null });
  } catch (error) {
    await account.saveListing({ kind: LANGFUSE, listing: null, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
}

/** Evaluations the plan has left this period, after the jobs that are running. */
async function evaluationsLeft(account: Account): Promise<number> {
  const plan = (await account.info()).plan;
  if (!plan) return 0;
  const running = (await account.jobs({ limit: 200 })).filter(active).length;
  return plan.includedEvals - plan.usedEvals - running;
}

/**
 * Starts evaluations, highest spend first: every task that can be evaluated and has none yet, while
 * the plan has evaluations left, or only `taskIds` when a person pressed Start, which the account's
 * own limits still check. Each counts `EVALUATIONS_PER_JOB.langfuse` evaluations. Returns why the
 * first task that could not start did not.
 */
export async function startLangfuseTasks(client: AppClient, input: { accountId: string; userId: string | null; taskIds?: readonly string[] }): Promise<{ started: string[]; jobIds: string[]; refused: string | null }> {
  const account = client.account.getOrCreate([input.accountId]);
  const connection = await account.connection(LANGFUSE);
  if (!connection) return { started: [], jobIds: [], refused: "Langfuse is not connected." };
  const listing = connection.listing as Listing | null;
  const jobs = await account.connectionJobs({ kind: LANGFUSE, since: Date.parse(connection.connectedAt) });
  const evaluated = new Set(jobs.map(job => job.taskId)), running = new Set(jobs.filter(active).map(job => job.taskId));
  const wanted = (listing?.tasks ?? []).filter(task => !task.skipped && !running.has(langfuseTaskId(task)) && (input.taskIds ? input.taskIds.includes(task.id) : !evaluated.has(langfuseTaskId(task))));
  const per = EVALUATIONS_PER_JOB[LANGFUSE] ?? 1;
  let left = input.taskIds ? Infinity : await evaluationsLeft(account);
  const started: string[] = [], jobIds: string[] = [];
  for (const task of wanted) {
    if (left < per) return { started, jobIds, refused: `${task.name} waits: the plan has no evaluations left this period. Start it from the table, or change the plan.` };
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
    left -= per; started.push(task.id); jobIds.push(jobId);
  }
  return { started, jobIds, refused: null };
}

/** The connection and its task table: each task's latest evaluation, or why it waits or is skipped. */
export async function langfuseView(client: AppClient, accountId: string, people: People = null): Promise<LangfuseView> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await account.connection(LANGFUSE);
  if (!connection) return { connected: false, tasks: [] };
  const listing = connection.listing as Listing | null;
  const jobs = await account.connectionJobs({ kind: LANGFUSE, since: Date.parse(connection.connectedAt) });
  const tasks = await Promise.all((listing?.tasks ?? []).map(async (task): Promise<LangfuseTaskView> => {
    const latest = jobs.find(job => job.taskId === langfuseTaskId(task));
    const base = { id: task.id, name: task.name, model: task.model, generations: task.generations, costUsd: task.costUsd, models: task.models.length, jobId: latest?.id ?? null, result: null };
    if (task.skipped) return { ...base, status: "skipped", reason: task.skipped };
    if (!latest) return { ...base, status: "waiting", reason: "Not evaluated yet." };
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
    listedAt: connection.listedAt, listingError: connection.listingError, truncated: listing?.truncated ?? false, tasks,
  };
}
