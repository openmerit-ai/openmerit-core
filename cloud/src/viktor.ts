// The Viktor connection in the cloud app: connect with a key, list the workspace's tasks, evaluate
// the ones a person picks, and record an approval. What a task is,
// which can be evaluated, what an evaluation costs and what it proposes are openmerit-core's Viktor
// connection; this module checks the account's limits and starts the jobs.
import { randomBytes } from "node:crypto";
import { CLEANUP, COPY_PATH, estimateCredits, keyProblem, LIST, readTasks, viktorClient, type ViktorTask } from "../../openmerit-core/src/connectors/viktor/index.ts";
import type { Approval, JobRow } from "./actors/account.ts";
import type { Auth } from "./auth.ts";
import { approve, DEFAULT_REPEATS, redact } from "./engine.ts";
import type { ConnectionResult, JobResult } from "./report.ts";
import { modelKeyRefusal, services } from "./services.ts";
import type { AppClient } from "./registry.ts";

export const VIKTOR = "viktor";

/** A task's place in the connection's table. */
export type TaskStatus = "skipped" | "not_evaluated" | "evaluating" | "done" | "failed";

export interface ViktorTaskView {
  id: string; title: string; path: string; model: string | null; credits30d: number; paused: boolean;
  /** The workspace's default model, which a task with no model of its own runs; null when unknown. */
  defaultModel: string | null;
  status: TaskStatus;
  /** Why it is skipped or failed; null otherwise. */
  reason: string | null;
  estimatedCredits: number | null;
  /** Why Evaluate or Start again cannot start it now: the plan has no evaluations left. Null when it can, or while it is evaluating. */
  blocked: string | null;
  /** First listed after the connection's first listing, and not yet opened or evaluated. */
  isNew: boolean;
  jobId: string | null;
  /** A finished evaluation's verdict. */
  result: { status: string; change: string | null; link: string | null; approval: { by: string; name: string | null; at: string } | null } | null;
}

export interface ViktorView {
  connected: boolean;
  keyLast4?: string; keyType?: string | null; connectedAt?: string; connectedBy?: string;
  creditsUsed?: number; creditsReserved?: number; listedAt?: string | null; listingError?: string | null;
  /** A listing is running: the page polls until it ends. */
  listing?: boolean;
  tasks: ViktorTaskView[];
}

export const viktorTaskId = (task: Pick<ViktorTask, "id">) => `viktor_${task.id}`;
const newJobId = () => `job_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${randomBytes(6).toString("hex")}`;

type Account = ReturnType<AppClient["account"]["getOrCreate"]>;
/** Looks up approvers' names; null where the server has no sign-in. */
type People = Pick<Auth, "person"> | null;
type JobWithCredits = Awaited<ReturnType<Account["connectionJobs"]>>[number];
const active = (job: { status: string }) => job.status === "queued" || job.status === "running";
const apiFor = (apiKey: string) => viktorClient({ apiKey, baseUrl: services().config.viktor.baseUrl, fetch: services().fetch });

/** Checks the key's scopes, stores it encrypted and lists the tasks. It starts no evaluation: a person picks which to evaluate. */
export async function connectViktor(client: AppClient, input: { accountId: string; userId: string; apiKey: string }): Promise<{ ok: true; view: ViktorView } | { ok: false; status: number; error: string }> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 12) return { ok: false, status: 400, error: "Paste the Viktor API key from Settings → API Keys." };
  const checked = await keyProblem(apiFor(apiKey));
  if ("problem" in checked) return { ok: false, status: 400, error: checked.problem };
  const account = client.account.getOrCreate([input.accountId]);
  const stored = await account.saveConnection({ kind: VIKTOR, apiKey, keyType: checked.key.keyType, teamId: checked.key.teamId, creditCap: 0, userId: input.userId });
  if (!stored.ok) return { ok: false, status: 503, error: stored.error };
  await refreshViktor(client, input.accountId);
  await armRelist(client, input.accountId, VIKTOR, true);
  return { ok: true, view: await viktorView(client, input.accountId) };
}

/**
 * Lists the workspace's tasks again, and deletes OpenMerit's leftover copies when no job is running.
 * Listing runs a script through `run_script`, which costs no Viktor credits. Returns the error kept on
 * the connection, or null.
 */
export async function refreshViktor(client: AppClient, accountId: string): Promise<string | null> {
  const account = client.account.getOrCreate([accountId]);
  const apiKey = await account.connectionKey(VIKTOR);
  if (!apiKey) return null;
  try {
    const api = apiFor(apiKey);
    const { tasks, leftovers } = readTasks(await api.runScriptPaged(LIST, [], 180));
    await account.saveListing({ kind: VIKTOR, listing: tasks, error: null });
    const running = (await account.connectionJobs({ kind: VIKTOR, since: 0 })).some(job => job.status === "queued" || job.status === "running");
    if (leftovers.length && !running) await api.runScript(CLEANUP, [COPY_PATH], 120);
    return null;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
    await account.saveListing({ kind: VIKTOR, listing: null, error: message });
    return message;
  }
}

/** When a listed task was first listed, and when someone opened its row: kept across listings by the account. */
export interface Seen { firstSeenAt?: string | null; seenAt?: string | null }

/** Starts the connection's background re-list (`connectionRelist`), once per process for each account and kind. */
const armed = new Set<string>();
export async function armRelist(client: AppClient, accountId: string, kind: string, force = false): Promise<void> {
  if (armed.has(`${accountId}:${kind}`) && !force) return;
  await client.connectionRelist.getOrCreate([accountId, kind], { createWithInput: { accountId, kind } }).arm();
  armed.add(`${accountId}:${kind}`);
}
const relister = (client: AppClient, accountId: string, kind: string) => client.connectionRelist.getOrCreate([accountId, kind], { createWithInput: { accountId, kind } });
/** Refresh: starts a listing through the connection's actor unless one is running, and returns at once. */
export async function startRelist(client: AppClient, accountId: string, kind: string): Promise<{ started: boolean }> {
  return relister(client, accountId, kind).relist();
}
/** Whether a listing is running, for the page to poll; `wait` waits for it, at most a minute. */
export async function isListing(client: AppClient, accountId: string, kind: string, wait = false): Promise<boolean> {
  const handle = relister(client, accountId, kind);
  for (const until = Date.now() + 60_000; ; await new Promise(resolve => setTimeout(resolve, 500))) {
    const running = await handle.listing().catch(() => false);
    if (!running || !wait || Date.now() > until) return running;
  }
}
/** Stops it, for removing the connection. */
export async function disarmRelist(client: AppClient, accountId: string, kind: string): Promise<void> {
  armed.delete(`${accountId}:${kind}`);
  await client.connectionRelist.getOrCreate([accountId, kind], { createWithInput: { accountId, kind } }).disarm();
}

/**
 * A task first seen after the connection's first listing is new until someone opens its row or it
 * has an evaluation. `firstSeenAt` is kept with each task in the listing (account `saveListing`).
 */
export const isNew = (task: { firstSeenAt?: string | null; seenAt?: string | null }, connectedAt: string, evaluated: boolean): boolean =>
  !evaluated && !task.seenAt && !!task.firstSeenAt && Date.parse(task.firstSeenAt) > Date.parse(connectedAt);

/**
 * Starts evaluating `taskIds`, which a signed-in admin picked with Evaluate or Start again; nothing
 * starts one on its own. Each counts one of the plan's evaluations; there is no credit cap, since a
 * person confirms each estimate, and the job stops itself past twice its estimate. Returns why the
 * first one that could not start did not.
 */
export async function startViktorTasks(client: AppClient, input: { accountId: string; userId: string; taskIds: readonly string[] }): Promise<{ started: string[]; jobIds: string[]; refused: string | null }> {
  const account = client.account.getOrCreate([input.accountId]);
  const connection = await account.connection(VIKTOR);
  if (!connection) return { started: [], jobIds: [], refused: "Viktor is not connected." };
  const tasks = (connection.listing as ViktorTask[] | null) ?? [];
  const jobs = await connectionJobs(client, account, Date.parse(connection.connectedAt));
  const wanted = tasks.filter(task => !task.skipped && input.taskIds.includes(task.id));
  // Before any job: the judge grades only after the test runs have spent the workspace's credits.
  const keyRefusal = wanted.length ? await modelKeyRefusal() : null;
  if (keyRefusal) return { started: [], jobIds: [], refused: keyRefusal };
  const started: string[] = [], jobIds: string[] = [];
  for (const task of wanted) {
    if (jobs.some(job => job.taskId === viktorTaskId(task) && active(job))) continue;
    const credits = estimateCredits(task, DEFAULT_REPEATS);
    const blocked = await account.evaluationRefusal(VIKTOR);
    if (blocked) return { started, jobIds, refused: `${task.title} cannot start: ${blocked}` };
    const jobId = newJobId();
    const ok = await account.startJob({ jobId, taskId: viktorTaskId(task), kind: "viktor", askedBy: null, credits, title: task.title, startedBy: input.userId });
    if (!ok.ok) return { started, jobIds, refused: ok.error };
    await client.viktorJob.create([jobId], { input: { accountId: input.accountId, taskId: viktorTaskId(task), task, repeats: DEFAULT_REPEATS, estimatedCredits: credits, userId: input.userId, createdAt: new Date().toISOString() } });
    started.push(task.id); jobIds.push(jobId);
  }
  return { started, jobIds, refused: null };
}

/**
 * The connection's jobs with the credits each spent, or expects to while it runs. A job that ended
 * before its Viktor thread started spent nothing; jobs that ended that way before they recorded 0
 * kept their estimate, which is corrected here once.
 */
async function connectionJobs(client: AppClient, account: Account, since: number): Promise<JobWithCredits[]> {
  return Promise.all((await account.connectionJobs({ kind: VIKTOR, since })).map(async job => {
    if (active(job) || job.status === "done" || !job.credits) return job;
    if (await client.viktorJob.get([job.id]).threadStarted().catch(() => true)) return job;
    await account.setJobCredits({ jobId: job.id, credits: 0 });
    return { ...job, credits: 0 };
  }));
}

/** When this process last started a listing for a stale read, by account. */
const staleStarts = new Map<string, number>();

/**
 * The connection as `viktorView` gives it. When the listing is older than `OPENMERIT_VIKTOR_STALE_MS`
 * (2 minutes) it starts listing again, at most once in that time per account even when listing fails,
 * so a task deleted in Viktor leaves the table. The view says `listing` while it runs and the page
 * polls; `wait` (openmerit_tasks) waits for it instead. Listing never starts an evaluation.
 */
export async function currentViktorView(client: AppClient, accountId: string, people: People, wait = false): Promise<ViktorView> {
  const connection = await client.account.getOrCreate([accountId]).connection(VIKTOR);
  if (connection) {
    // A connection made before the background re-list starts it the first time it is read.
    await armRelist(client, accountId, VIKTOR);
    const staleMs = services().config.viktor.staleMs, listed = connection.listedAt ? Date.parse(connection.listedAt) : 0;
    const last = staleStarts.get(accountId) ?? 0;
    if (Date.now() - listed > staleMs && Date.now() - last > staleMs) {
      staleStarts.set(accountId, Date.now());
      await startRelist(client, accountId, VIKTOR);
    }
    if (wait) await isListing(client, accountId, VIKTOR, true);
  }
  return viktorView(client, accountId, people);
}

/** A run as Runs lists it: a connection job's title, never its ID, and the name of whoever started it. */
export type LabelledRun = JobRow & { startedByName: string | null };

/**
 * Labels runs for Runs. A Viktor job recorded before the account kept its title and starter gets
 * them once from the job's own input; when that is gone, the title in the connection's listing,
 * else the task's path, else "Viktor task". Starters' names come from Clerk, the user ID when it has none.
 */
export async function labelRuns(client: AppClient, people: People, accountId: string, rows: readonly JobRow[]): Promise<LabelledRun[]> {
  const account = client.account.getOrCreate([accountId]);
  let listing: ViktorTask[] | null | undefined;
  const labelled = await Promise.all(rows.map(async (row): Promise<JobRow> => {
    if (row.kind !== VIKTOR || row.title) return row;
    const origin = await client.viktorJob.get([row.id]).origin().catch(() => null);
    listing ??= ((await account.connection(VIKTOR))?.listing as ViktorTask[] | null) ?? null;
    const listed = listing?.find(task => viktorTaskId(task) === row.taskId);
    const title = origin?.title || listed?.title || origin?.path || listed?.path || "Viktor task";
    const startedBy = origin?.userId ?? null;
    if (origin) await account.setJobOrigin({ jobId: row.id, title, startedBy });
    return { ...row, title, startedBy };
  }));
  const ids = [...new Set(labelled.map(row => row.startedBy).filter((id): id is string => !!id))];
  const names = new Map(await Promise.all(ids.map(async id => [id, (await people?.person(id).catch(() => null))?.name ?? null] as const)));
  return labelled.map(row => ({ ...row, startedByName: row.startedBy ? names.get(row.startedBy) ?? null : null }));
}

/** An approval with its approver's name, looked up in Clerk and kept when the approval has none yet. */
export async function namedApproval(client: AppClient, people: People, accountId: string, jobId: string): Promise<Approval | null> {
  const account = client.account.getOrCreate([accountId]);
  const approval = await account.approval(jobId);
  if (!approval || approval.name || !people) return approval;
  const person = await people.person(approval.by);
  return person?.name ? await account.nameApproval({ jobId, name: person.name, email: person.email }) ?? approval : approval;
}

/** The connection and its task table: each task's latest evaluation, why it is skipped, and whether Evaluate can start it now. */
export async function viktorView(client: AppClient, accountId: string, people: People = null): Promise<ViktorView> {
  const account = client.account.getOrCreate([accountId]);
  const connection = await account.connection(VIKTOR);
  if (!connection) return { connected: false, tasks: [] };
  const jobs = await connectionJobs(client, account, Date.parse(connection.connectedAt));
  const used = jobs.filter(job => !active(job)).reduce((sum, job) => sum + (job.credits ?? 0), 0);
  const reserved = jobs.filter(active).reduce((sum, job) => sum + (job.credits ?? 0), 0);
  const refusal = await account.evaluationRefusal(VIKTOR);
  const tasks = await Promise.all(((connection.listing as (ViktorTask & Seen)[] | null) ?? []).map(async (task): Promise<ViktorTaskView> => {
    const latest = jobs.find(job => job.taskId === viktorTaskId(task)) ?? null;
    const estimatedCredits = task.skipped ? null : estimateCredits(task, DEFAULT_REPEATS);
    const blocked = estimatedCredits === null || (latest && active(latest)) ? null : refusal;
    const base = { id: task.id, title: task.title, path: task.path, model: task.model, defaultModel: task.defaultModel ?? null, credits30d: task.credits30d, paused: task.paused, jobId: latest?.id ?? null, estimatedCredits, blocked, isNew: !task.skipped && isNew(task, connection.connectedAt, !!latest), result: null };
    if (task.skipped) return { ...base, status: "skipped", reason: task.skipped };
    if (!latest) return { ...base, status: "not_evaluated", reason: null };
    if (active(latest)) return { ...base, status: "evaluating", reason: null };
    if (latest.status !== "done") return { ...base, status: "failed", reason: (await client.viktorJob.get([latest.id]).status().catch(() => null))?.error ?? latest.status };
    const report = (await account.report({ jobId: latest.id }))?.json as (JobResult & { connection?: ConnectionResult }) | undefined;
    const approval = await namedApproval(client, people, accountId, latest.id);
    return { ...base, status: "done", reason: null, result: { status: report?.status ?? "done", change: report?.connection?.change?.text ?? null, link: report?.connection?.change?.link ?? null, approval: approval ? { by: approval.by, name: approval.name, at: approval.at } : null } };
  }));
  return {
    connected: true, keyLast4: connection.keyLast4, keyType: connection.keyType, connectedAt: connection.connectedAt, connectedBy: connection.connectedBy,
    creditsUsed: Math.round(used), creditsReserved: Math.round(reserved), listedAt: connection.listedAt, listingError: connection.listingError, listing: await isListing(client, accountId, VIKTOR), tasks,
  };
}

/** Records who approved a finished result's change, and when. It changes nothing in Viktor (decision 9). */
export async function approveChange(client: AppClient, people: People, input: { accountId: string; userId: string; jobId: string }): Promise<{ ok: true; approval: Approval } | { ok: false; status: number; error: string }> {
  const account = client.account.getOrCreate([input.accountId]);
  const report = (await account.report({ jobId: input.jobId }))?.json as (JobResult & { connection?: ConnectionResult }) | undefined;
  if (!report) return { ok: false, status: 404, error: "This run has no result yet." };
  // A connected app's change: a Viktor task's preset, or a Langfuse task's model.
  const change = report.connection?.change ?? report.langfuse?.change;
  if (!change || !report.pick) return { ok: false, status: 409, error: "This result proposes no change to approve." };
  const approved = approve({ edits: [], instructions: report.edit.instructions }, { model: change.model, endpoint: report.langfuse ? "langfuse" : "viktor", endpointModel: change.model, onOpenRouter: false }, { by: input.userId, at: new Date().toISOString() });
  const person = await people?.person(input.userId) ?? null;
  await account.approve({ jobId: input.jobId, change: change.text, link: change.link, by: approved.approval.by, name: person?.name ?? null, email: person?.email ?? null, at: approved.approval.at });
  // The first approval stands; an earlier one recorded without a name gets one now.
  return { ok: true, approval: (await namedApproval(client, people, input.accountId, input.jobId))! };
}
