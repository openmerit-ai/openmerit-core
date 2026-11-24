// The account actor, one per Clerk organization: its plan from Stripe, members, endpoints with
// encrypted keys, guardrails at each level, the spend ledger, and the index of tasks, jobs and
// reports. SQLite holds all of it, so the ledger's checks and writes run in one transaction.
import { randomBytes } from "node:crypto";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import type { PlanUpdate } from "../billing.ts";
import { GUARDRAIL_KINDS, LEVELS, resolveGuardrails, settledUsd, type Funding, type GuardrailKey, type Catalogue, type Guardrails, type Level, type ReserveResult, type ResolvedGuardrails, type Settlement } from "../engine.ts";
import { checkRepo, parseRepoUrl, reviewRepository, tokenProblem, type RepoReview } from "../github.ts";
import { decryptKey, encryptKey, endpointUrlProblem } from "../keys.ts";
import { OPENROUTER, type EndpointInfo } from "../pool.ts";
import type { Case, EndpointConfig, EndpointKind, TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import type { Registry } from "../registry.ts";
import { services } from "../services.ts";

type Row = Record<string, unknown>;

/**
 * An account's projects group its tasks, runs, guardrails, model endpoints and GitHub repositories.
 * The plan, members, spend caps and the ledger stay the organization's. Every account has the
 * default project, which holds what the account had before projects and can be renamed but not deleted.
 */
export const DEFAULT_PROJECT = "default";
export const DEFAULT_PROJECT_NAME = "Default project";
export interface Project { id: string; name: string; createdAt: string; tasks: number; repos: string[]; endpoints: number }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, mcp_revoked_before INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plan (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, status TEXT, customer_id TEXT, subscription_id TEXT,
    period_start INTEGER, period_end INTEGER, included_evals INTEGER NOT NULL DEFAULT 0, overage TEXT NOT NULL DEFAULT 'refuse', event_created INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, last_session_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, base_url TEXT NOT NULL, allowed_models TEXT NOT NULL,
    sealed_key TEXT NOT NULL, key_last4 TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS guardrails (project_id TEXT NOT NULL DEFAULT 'default', level TEXT NOT NULL, scope TEXT NOT NULL, settings TEXT NOT NULL, PRIMARY KEY (project_id, level, scope))`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', task_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER, budget_usd REAL, cap_openmerit_usd REAL, cap_customer_usd REAL, counted INTEGER NOT NULL DEFAULT 0, metered INTEGER NOT NULL DEFAULT 0, asked_by TEXT, deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ledger (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, funding TEXT NOT NULL, model TEXT, endpoint TEXT, status TEXT NOT NULL,
    reserved_usd REAL NOT NULL, actual_usd REAL, estimated_usd REAL, failed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', environment TEXT NOT NULL, agent TEXT, name TEXT NOT NULL, current_model TEXT NOT NULL,
    pick TEXT, status TEXT NOT NULL, last_run_at INTEGER, last_job_id TEXT, monthly_saving_usd REAL, retired INTEGER NOT NULL DEFAULT 0, last_recommend_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS deletions (project_id TEXT NOT NULL DEFAULT 'default', task_id TEXT NOT NULL, name TEXT NOT NULL, environment TEXT NOT NULL, user_id TEXT NOT NULL, jobs INTEGER NOT NULL, deleted_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decisions (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, change TEXT NOT NULL,
    decided_by TEXT NOT NULL, decided_by_name TEXT, decided_by_email TEXT, decided_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reports (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, markdown TEXT NOT NULL, share_token TEXT UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', full_name TEXT NOT NULL UNIQUE COLLATE NOCASE, private INTEGER NOT NULL, default_branch TEXT NOT NULL,
    sealed_token TEXT, token_last4 TEXT, added_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
    review_status TEXT NOT NULL, review_requested_at INTEGER NOT NULL, review_finished_at INTEGER, review_error TEXT, review TEXT)`,
  `CREATE TABLE IF NOT EXISTS repo_reviews (repo_id TEXT NOT NULL, requested_at INTEGER NOT NULL)`,
  // A task's eval, versioned: its spec (what the judge checks) and its cases. Every change makes a version; a job records the one it ran.
  `CREATE TABLE IF NOT EXISTS eval_versions (task_id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL, spec TEXT NOT NULL, cases TEXT NOT NULL,
    source TEXT NOT NULL, author TEXT, note TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, version))`,
  // The version the coding agent last wrote to the repository's .openmerit/evals/.
  `CREATE TABLE IF NOT EXISTS eval_sync (task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, synced_by TEXT NOT NULL, client TEXT, synced_at INTEGER NOT NULL)`,
  // Evals a repository review wrote, waiting for a person to approve (which creates the task) or dismiss them.
  `CREATE TABLE IF NOT EXISTS eval_drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repo_id TEXT, environment TEXT NOT NULL, name TEXT NOT NULL, bundle TEXT NOT NULL,
    cases TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, task_id TEXT)`,
];

/** What a ledger row counts: settled at its cost, reserved at its reservation, released not at all. */
const COUNTED = `CASE status WHEN 'settled' THEN COALESCE(actual_usd, estimated_usd, reserved_usd) WHEN 'reserved' THEN reserved_usd ELSE 0 END`;
const FINAL = new Set(["done", "failed", "stopped"]);
const ACTIVE_PLAN = new Set(["active", "trialing"]);

/**
 * What the user decided about a result's change, as the coding agent sent it back: approved (the agent
 * applied the edit) or declined. by is the Clerk user whose MCP token sent it; name and email are what
 * Clerk had for them, null when the lookup failed.
 */
export interface Decision { jobId: string; taskId: string; decision: "approved" | "declined"; change: string; by: string; name: string | null; email: string | null; at: string }

export interface Plan { name: string; status: string; periodStart: number | null; periodEnd: number | null; includedEvals: number; usedEvals: number; overage: "metered" | "refuse"; customerId: string | null }
export interface EndpointView { id: string; kind: EndpointKind; baseUrl: string; allowedModels: string[] | "all"; keyLast4: string; verifiedAt: string | null; builtIn: boolean }
/**
 * Whether OpenMerit re-runs a task when the catalogue changes. Every task is watched; it stops when the
 * `watch: false` guardrail freezes it, when no openmerit_recommend call came for `idleAfterMs` (idle),
 * or when the coding agent retired it with openmerit_retire. A later recommend call ends idle and retired.
 */
export type WatchState = "watching" | "idle" | "frozen" | "retired";
/** `watching` is `state === "watching"`, for clients that predate `state`. `idleSince` is set only while idle. */
export interface TaskRow { id: string; projectId: string; environment: string; agent: string | null; name: string; currentModel: string; pick: string | null; status: string; state: WatchState; idleSince: string | null; watching: boolean; lastRunAt: string | null; lastJobId: string | null; monthlySavingUsd: number | null }
/** What a finished job's report found, so a list of runs can say it without loading each report. */
export interface RunResult { status: string; task: string | null; model: string | null; from: string | null; savingPerCallUsd: number | null }
/** askedBy is the MCP client's name (clientInfo.name) for a run a coding agent started; null for a watch run or an unnamed client. */
/** The end of a ledger refusal's reason when the job's own budget refused it, which raising the task's budget fixes. */
export const JOB_BUDGET = "budget for this job";

export interface JobRow { id: string; projectId: string; taskId: string; kind: string; status: string; startedAt: string; finishedAt: string | null; askedBy: string | null; evalVersion: number | null; result: RunResult | null }

/**
 * The part of a task's spec its eval owns, which the app edits: what the judge checks each case on.
 * A job runs the bundle the coding agent sent with these fields replaced by the eval's.
 */
export type EvalSpec = Pick<TaskBundle, "description" | "input" | "steps" | "criteria" | "guardrails">;
/** Who wrote a version: OpenMerit's case writer, a member's subscription, the coding agent's examples alone, a repository review, a person in the app, or answers to a run's label check. */
export type EvalSource = "openmerit" | "claude" | "chatgpt" | "examples" | "review" | "app" | "label_check";
export interface EvalVersion { version: number; spec: EvalSpec; cases: Case[]; source: EvalSource; author: string | null; note: string | null; createdAt: string; runs: number }
export interface EvalView { taskId: string; projectId: string; latest: EvalVersion | null; versions: Omit<EvalVersion, "spec" | "cases">[]; repo: { version: number; by: string; client: string | null; at: string } | null }
export interface EvalDraft { id: string; projectId: string; repoId: string | null; environment: string; name: string; bundle: TaskBundle; cases: Case[]; status: "pending" | "approved" | "dismissed"; createdAt: string; taskId: string | null }
/** Where the coding agent keeps a task's eval in its repository, by the CLI's rule for a task name. */
export const evalDir = (task: string) => `.openmerit/evals/${task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task"}`;
export const specOf = (bundle: TaskBundle): EvalSpec => Object.fromEntries((["description", "input", "steps", "criteria", "guardrails"] as const).filter(key => bundle[key] !== undefined).map(key => [key, bundle[key]])) as EvalSpec;
export interface GuardrailSetting { key: string; value: unknown; kind: "constraint" | "default" }
/**
 * A GitHub repository the account added. tokenLast4 is null for a public repository added by its URL
 * alone. review.result is the last review that finished, kept while a new one runs or after it fails.
 */
export interface RepoView {
  id: string; projectId: string; fullName: string; url: string; private: boolean; defaultBranch: string; tokenLast4: string | null; addedAt: string; checkedAt: string;
  review: { status: "queued" | "reviewing" | "done" | "failed"; requestedAt: string; finishedAt: string | null; error: string | null; result: RepoReview | null };
}
export type Started = { ok: true } | { ok: false; error: string };

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const startOfMonth = (now: number) => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); };
const scopeKey = (level: Level, input: { environment: string; agent?: string | null; taskId?: string }) =>
  level === "environment" ? input.environment : level === "agent" ? `${input.environment}:${input.agent ?? ""}` : input.taskId ?? "";

/** A task's watch state. Retired wins over frozen, and frozen over idle: each says why the watch stopped, most deliberate first. */
export function watchState(input: { retired: boolean; watch: boolean | undefined; lastRecommendAt: number | null; now: number; idleAfterMs: number }): { state: WatchState; idleSince: string | null } {
  if (input.retired) return { state: "retired", idleSince: null };
  if (input.watch === false) return { state: "frozen", idleSince: null };
  const idleAt = input.lastRecommendAt === null ? null : input.lastRecommendAt + input.idleAfterMs;
  if (idleAt !== null && input.now >= idleAt) return { state: "idle", idleSince: new Date(idleAt).toISOString() };
  return { state: "watching", idleSince: null };
}

const taskRow = (row: Row, watch: boolean | undefined): TaskRow => {
  const { state, idleSince } = watchState({ retired: row.retired === 1, watch, lastRecommendAt: (row.last_recommend_at as number | null) ?? null, now: Date.now(), idleAfterMs: services().config.idleAfterMs });
  return {
    id: String(row.id), projectId: String(row.project_id), environment: String(row.environment), agent: (row.agent as string | null) ?? null, name: String(row.name), currentModel: String(row.current_model),
    pick: (row.pick as string | null) ?? null, status: String(row.status), state, idleSince, watching: state === "watching", lastRunAt: iso(row.last_run_at), lastJobId: (row.last_job_id as string | null) ?? null,
    monthlySavingUsd: (row.monthly_saving_usd as number | null) ?? null,
  };
};
function runResult(json: unknown): RunResult | null {
  if (typeof json !== "string") return null;
  const report = JSON.parse(json) as { status?: unknown; task?: unknown; pick?: { model?: unknown; savingPerCallUsd?: unknown } | null; baseline?: { model?: unknown } | null };
  if (typeof report.status !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { status: report.status, task: text(report.task), model: text(report.pick?.model), from: text(report.baseline?.model), savingPerCallUsd: typeof report.pick?.savingPerCallUsd === "number" ? report.pick.savingPerCallUsd : null };
}
const jobRow = (row: Row): JobRow => ({
  id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), kind: String(row.kind), status: String(row.status), startedAt: iso(row.started_at)!, finishedAt: iso(row.finished_at),
  askedBy: (row.asked_by as string | null) ?? null, evalVersion: (row.eval_version as number | null) ?? null, result: runResult(row.report_json),
});

export const account = actor({
  db: db({ onMigrate: async database => {
    for (const statement of SCHEMA) await database.execute(statement);
    // Accounts created before jobs recorded the asking client.
    const columns = await database.execute(`PRAGMA table_info(jobs)`);
    if (!columns.some(column => column.name === "asked_by")) await database.execute(`ALTER TABLE jobs ADD COLUMN asked_by TEXT`);
    if (!columns.some(column => column.name === "deleted_at")) await database.execute(`ALTER TABLE jobs ADD COLUMN deleted_at INTEGER`);
    if (!columns.some(column => column.name === "eval_version")) await database.execute(`ALTER TABLE jobs ADD COLUMN eval_version INTEGER`);
    const deletionColumns = await database.execute(`PRAGMA table_info(deletions)`);
    if (!deletionColumns.some(column => column.name === "repo_copy")) await database.execute(`ALTER TABLE deletions ADD COLUMN repo_copy TEXT`);
    // The Viktor and Langfuse connections' tables, from before they were removed.
    await database.execute(`DROP TABLE IF EXISTS connections`);
    await database.execute(`DROP TABLE IF EXISTS approvals`);
    // Accounts created before tasks could be retired or go idle. Their tasks become watched; a task's idle clock starts at its last recommend call.
    const taskColumns = await database.execute(`PRAGMA table_info(tasks)`);
    if (!taskColumns.some(column => column.name === "retired")) await database.execute(`ALTER TABLE tasks ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);
    if (!taskColumns.some(column => column.name === "last_recommend_at")) {
      await database.execute(`ALTER TABLE tasks ADD COLUMN last_recommend_at INTEGER`);
      await database.execute(`UPDATE tasks SET last_recommend_at = (SELECT max(started_at) FROM jobs WHERE jobs.task_id = tasks.id AND jobs.kind = 'run')`);
    }
    // Accounts created before projects: everything they hold moves into the default project.
    for (const table of ["endpoints", "jobs", "tasks", "deletions", "repos"]) {
      const found = await database.execute(`PRAGMA table_info(${table})`);
      if (!found.some(column => column.name === "project_id")) await database.execute(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}'`);
    }
    // A guardrail's scope (an environment name, environment:agent or a task ID) is unique within its project only.
    const guardrailColumns = await database.execute(`PRAGMA table_info(guardrails)`);
    if (!guardrailColumns.some(column => column.name === "project_id")) {
      await database.execute(`CREATE TABLE guardrails_by_project (project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}', level TEXT NOT NULL, scope TEXT NOT NULL, settings TEXT NOT NULL, PRIMARY KEY (project_id, level, scope))`);
      await database.execute(`INSERT INTO guardrails_by_project (level, scope, settings) SELECT level, scope, settings FROM guardrails`);
      await database.execute(`DROP TABLE guardrails`);
      await database.execute(`ALTER TABLE guardrails_by_project RENAME TO guardrails`);
    }
    await database.execute(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`, DEFAULT_PROJECT, DEFAULT_PROJECT_NAME, Date.now());
  } }),
  actions: {
    /** Records the calling member and the account's name. A null role, from a token that names none, keeps the recorded one. */
    touch: async (c, input: { userId: string; role: "admin" | "member" | null; name: string | null }): Promise<void> => {
      await c.db.execute(`INSERT INTO members (user_id, role) VALUES (?, COALESCE(?, 'member')) ON CONFLICT (user_id) DO UPDATE SET role = COALESCE(?, members.role)`, input.userId, input.role, input.role);
      await c.db.execute(`INSERT INTO account (id, name) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, account.name)`, input.name);
    },

    info: async (c): Promise<{ id: string; name: string | null; plan: Plan | null; mcpRevokedBefore: number | null }> => {
      const [row] = await c.db.execute(`SELECT name, mcp_revoked_before FROM account WHERE id = 1`);
      return { id: c.key[0]!, name: (row?.name as string | null) ?? null, plan: await plan(c.db), mcpRevokedBefore: (row?.mcp_revoked_before as number | null) ?? null };
    },

    // Projects. Names are unique in the account, ignoring case.
    projects: async (c): Promise<Project[]> => projectViews(c.db),
    project: async (c, id: string): Promise<Project | null> => (await projectViews(c.db, id))[0] ?? null,

    createProject: async (c, input: { name: string }): Promise<{ ok: true; project: Project } | { ok: false; error: string }> => {
      const name = projectNameProblem(input.name) ?? await nameTaken(c.db, input.name.trim(), null);
      if (name) return { ok: false, error: name };
      const [count] = await c.db.execute(`SELECT count(*) AS n FROM projects`);
      if (Number(count?.n) >= MAX_PROJECTS) return { ok: false, error: `This account has ${MAX_PROJECTS} projects, its limit. Delete one to add another.` };
      const id = `prj_${randomBytes(6).toString("hex")}`;
      await c.db.execute(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, id, input.name.trim(), Date.now());
      return { ok: true, project: (await projectViews(c.db, id))[0]! };
    },

    renameProject: async (c, input: { id: string; name: string }): Promise<{ ok: true; project: Project } | { ok: false; status: 400 | 404; error: string }> => {
      if (!(await projectViews(c.db, input.id)).length) return { ok: false, status: 404, error: "No such project in this account." };
      const problem = projectNameProblem(input.name) ?? await nameTaken(c.db, input.name.trim(), input.id);
      if (problem) return { ok: false, status: 400, error: problem };
      await c.db.execute(`UPDATE projects SET name = ? WHERE id = ?`, input.name.trim(), input.id);
      return { ok: true, project: (await projectViews(c.db, input.id))[0]! };
    },

    /**
     * Deletes a project with its endpoints, repositories and guardrails. A project that still has
     * tasks is refused: deleting a task erases its runs, which the caller does task by task.
     */
    deleteProject: async (c, id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> => c.db.transaction(async tx => {
      if (id === DEFAULT_PROJECT) return { ok: false, status: 409, error: "The default project cannot be deleted. Rename it instead." };
      const [found] = await tx.execute(`SELECT id FROM projects WHERE id = ?`, id);
      if (!found) return { ok: false, status: 404, error: "No such project in this account." };
      const [tasks] = await tx.execute(`SELECT count(*) AS n FROM tasks WHERE project_id = ?`, id);
      if (Number(tasks?.n)) return { ok: false, status: 409, error: `This project has ${Number(tasks?.n)} task${Number(tasks?.n) === 1 ? "" : "s"}. Delete them first.` };
      for (const table of ["endpoints", "repos", "guardrails", "projects"]) await tx.execute(`DELETE FROM ${table} WHERE ${table === "projects" ? "id" : "project_id"} = ?`, id);
      return { ok: true };
    }, { name: "delete_project" }),

    /**
     * The project an MCP call without one works in: the project whose GitHub repository the call's
     * environment names (owner/repo, ignoring case), else the default project.
     */
    projectForEnvironment: async (c, environment: string): Promise<string> => {
      const [row] = await c.db.execute(`SELECT project_id FROM repos WHERE full_name = ?`, environment);
      return row ? String(row.project_id) : DEFAULT_PROJECT;
    },

    /** Applies a Stripe webhook. Each event applies once; an older subscription event never overwrites a newer one. */
    applyStripe: async (c, update: PlanUpdate): Promise<{ applied: boolean }> => c.db.transaction(async tx => {
      const [seen] = await tx.execute(`SELECT id FROM stripe_events WHERE id = ?`, update.eventId);
      if (seen) return { applied: false };
      await tx.execute(`INSERT INTO stripe_events (id, received_at) VALUES (?, ?)`, update.eventId, Date.now());
      if (update.kind === "customer") {
        await tx.execute(`INSERT INTO plan (id, customer_id, status) VALUES (1, ?, 'incomplete') ON CONFLICT (id) DO UPDATE SET customer_id = excluded.customer_id`, update.customerId);
        return { applied: true };
      }
      const [current] = await tx.execute(`SELECT event_created FROM plan WHERE id = 1`);
      if (current && Number(current.event_created) > update.eventCreated) return { applied: false };
      await tx.execute(`INSERT INTO plan (id, name, status, customer_id, subscription_id, period_start, period_end, included_evals, overage, event_created)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, customer_id = excluded.customer_id,
        subscription_id = excluded.subscription_id, period_start = excluded.period_start, period_end = excluded.period_end, included_evals = excluded.included_evals,
        overage = excluded.overage, event_created = excluded.event_created`,
      update.name, update.status, update.customerId, update.subscriptionId, update.periodStart, update.periodEnd, update.includedEvals, update.overage, update.eventCreated);
      return { applied: true };
    }, { name: "apply_stripe" }),

    /** Checks the plan and the account's job limits, then records the job. */
    startJob: async (c, input: { jobId: string; projectId: string; taskId: string; kind: "run" | "watch"; askedBy?: string | null }): Promise<Started> => c.db.transaction(async tx => {
      const { limits, appUrl } = services().config;
      const current = await plan(tx);
      if (!current || !ACTIVE_PLAN.has(current.status)) return { ok: false, error: planRefusal(current)! };
      if (current.overage === "refuse" && current.usedEvals >= current.includedEvals) return { ok: false, error: `This month's ${current.includedEvals} evaluations are used. More start at ${current.periodEnd ? new Date(current.periodEnd * 1000).toISOString().slice(0, 10) : "the next period"}, or change the plan at ${appUrl}/plan/.` };
      const now = Date.now();
      const [hour] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE started_at > ?`, now - 3_600_000);
      if (Number(hour?.n) >= limits.jobsPerHour) return { ok: false, error: `This account started ${limits.jobsPerHour} jobs in the last hour, its limit. Try again later.` };
      const [running] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running')`);
      if (Number(running?.n) >= limits.concurrentJobs) return { ok: false, error: `This account has ${limits.concurrentJobs} jobs running, its limit. Try again when one finishes.` };
      await tx.execute(`INSERT INTO jobs (id, project_id, task_id, kind, status, started_at, asked_by) VALUES (?, ?, ?, ?, 'queued', ?, ?)`, input.jobId, input.projectId, input.taskId, input.kind, now, input.askedBy ?? null);
      return { ok: true };
    }, { name: "start_job" }),

    /** A job's status and, once it knows them, its spend limits. Its first final status counts one evaluation. */
    jobUpdate: async (c, input: { jobId: string; status: string; budgetUsd?: number; capOpenmeritUsd?: number | null; capCustomerUsd?: number | null; measured?: boolean }): Promise<void> => {
      const count = await c.db.transaction(async tx => {
        const [job] = await tx.execute(`SELECT status FROM jobs WHERE id = ?`, input.jobId);
        if (!job) return false;
        if (FINAL.has(String(job.status))) return false;
        const final = FINAL.has(input.status);
        await tx.execute(`UPDATE jobs SET status = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
          budget_usd = COALESCE(?, budget_usd), cap_openmerit_usd = COALESCE(?, cap_openmerit_usd), cap_customer_usd = COALESCE(?, cap_customer_usd),
          counted = CASE WHEN ? THEN 1 ELSE counted END WHERE id = ?`,
        input.status, final ? 1 : 0, Date.now(), input.budgetUsd ?? null, input.capOpenmeritUsd ?? null, input.capCustomerUsd ?? null, final && input.measured ? 1 : 0, input.jobId);
        return final && input.measured === true;
      }, { name: "job_update" });
      if (count) await meter(c.db, input.jobId);
    },

    job: async (c, jobId: string): Promise<JobRow | null> => {
      const [row] = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.id = ? AND jobs.deleted_at IS NULL`, jobId);
      return row ? jobRow(row) : null;
    },

    /** The account's jobs, newest first: one task's, one project's, or every project's. */
    jobs: async (c, input: { projectId?: string; taskId?: string; limit?: number } = {}): Promise<JobRow[]> => {
      const rows = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id
        WHERE jobs.deleted_at IS NULL AND (? IS NULL OR jobs.task_id = ?) AND (? IS NULL OR jobs.project_id = ?) ORDER BY jobs.started_at DESC LIMIT ?`,
      input.taskId ?? null, input.taskId ?? null, input.projectId ?? null, input.projectId ?? null, input.limit ?? 50);
      return rows.map(jobRow);
    },

    // The ledger. Keys are idempotent: a replayed workflow step reserves and settles the same keys, which changes nothing.
    reserve: async (c, input: { jobId: string; key: string; usd: number; funding: Funding; model?: string; endpoint?: string }): Promise<ReserveResult> => c.db.transaction(async tx => {
      if (!Number.isFinite(input.usd) || input.usd < 0) throw new RangeError(`Reservation ${input.key}: expected cost must be a non-negative number`);
      const [existing] = await tx.execute(`SELECT status FROM ledger WHERE key = ?`, input.key);
      if (existing && existing.status !== "released") return { ok: true };
      const [job] = await tx.execute(`SELECT budget_usd, cap_openmerit_usd, cap_customer_usd FROM jobs WHERE id = ?`, input.jobId);
      if (!job) return { ok: false, reason: `No job ${input.jobId} in this account`, neededUsd: input.usd };
      const { limits } = services().config;
      const sum = async (where: string, ...args: unknown[]) => Number((await tx.execute(`SELECT COALESCE(sum(${COUNTED}), 0) AS usd FROM ledger WHERE ${where}`, ...args))[0]?.usd ?? 0);
      const refuse = (used: number, cap: number, what: string): ReserveResult => ({ ok: false, reason: `$${used.toFixed(4)} used or reserved of the $${cap.toFixed(2)} ${what}`, neededUsd: input.usd });
      const budget = (job.budget_usd as number | null) ?? limits.defaultJobBudgetUsd;
      const jobUsed = await sum(`job_id = ?`, input.jobId);
      if (jobUsed + input.usd > budget + 1e-9) return refuse(jobUsed, budget, JOB_BUDGET);
      const jobCap = input.funding === "openmerit" ? job.cap_openmerit_usd : job.cap_customer_usd;
      if (typeof jobCap === "number") {
        const used = await sum(`job_id = ? AND funding = ?`, input.jobId, input.funding);
        if (used + input.usd > jobCap + 1e-9) return refuse(used, jobCap, `${input.funding === "openmerit" ? "OpenMerit-paid" : "customer-paid"} cap for this job`);
      }
      const monthCap = input.funding === "openmerit" ? limits.monthlyCapUsd : limits.customerCapUsd;
      const monthUsed = await sum(`funding = ? AND created_at >= ?`, input.funding, await periodStart(tx));
      if (monthUsed + input.usd > monthCap + 1e-9) return refuse(monthUsed, monthCap, `monthly ${input.funding === "openmerit" ? "OpenMerit-paid" : "customer-paid"} cap`);
      await tx.execute(`INSERT INTO ledger (key, job_id, funding, model, endpoint, status, reserved_usd, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
        ON CONFLICT (key) DO UPDATE SET status = 'reserved', reserved_usd = excluded.reserved_usd, actual_usd = NULL, estimated_usd = NULL, failed = 0`,
      input.key, input.jobId, input.funding, input.model ?? null, input.endpoint ?? null, input.usd, Date.now());
      return { ok: true };
    }, { name: "ledger_reserve" }),

    settle: async (c, input: { key: string; cost: Settlement }): Promise<void> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT status FROM ledger WHERE key = ?`, input.key);
      if (!row) throw new Error(`No reservation ${input.key} to settle`);
      if (row.status !== "reserved") return;
      await tx.execute(`UPDATE ledger SET status = 'settled', actual_usd = ?, estimated_usd = ?, failed = ? WHERE key = ?`,
        input.cost.actualUsd, input.cost.estimatedUsd, input.cost.failed ? 1 : 0, input.key);
    }, { name: "ledger_settle" }),

    release: async (c, key: string): Promise<void> => {
      await c.db.execute(`UPDATE ledger SET status = 'released' WHERE key = ? AND status = 'reserved'`, key);
    },

    /** Spend this period, or for one job, split by who pays. */
    spent: async (c, input: { jobId?: string } = {}): Promise<{ openmeritUsd: number; customerUsd: number; monthlyCapUsd: number; customerCapUsd: number; period: { start: string; end: string | null } }> => {
      const start = await periodStart(c.db);
      const rows = input.jobId
        ? await c.db.execute(`SELECT funding, COALESCE(sum(${COUNTED}), 0) AS usd FROM ledger WHERE job_id = ? GROUP BY funding`, input.jobId)
        : await c.db.execute(`SELECT funding, COALESCE(sum(${COUNTED}), 0) AS usd FROM ledger WHERE created_at >= ? GROUP BY funding`, start);
      const usd = (funding: Funding) => Number(rows.find(row => row.funding === funding)?.usd ?? 0);
      const current = await plan(c.db);
      const { limits } = services().config;
      return { openmeritUsd: usd("openmerit"), customerUsd: usd("customer"), monthlyCapUsd: limits.monthlyCapUsd, customerCapUsd: limits.customerCapUsd, period: { start: new Date(start).toISOString(), end: current?.periodEnd ? new Date(current.periodEnd * 1000).toISOString() : null } };
    },

    /** One job's ledger rows, for its report. */
    ledgerOf: async (c, jobId: string): Promise<{ key: string; funding: Funding; model: string | null; endpoint: string | null; usd: number; status: string }[]> =>
      (await c.db.execute(`SELECT key, funding, model, endpoint, status, reserved_usd, actual_usd, estimated_usd FROM ledger WHERE job_id = ? ORDER BY created_at`, jobId)).map(row => ({
        key: String(row.key), funding: row.funding as Funding, model: (row.model as string | null) ?? null, endpoint: (row.endpoint as string | null) ?? null, status: String(row.status),
        usd: row.status === "settled" ? settledUsd(Number(row.reserved_usd), { actualUsd: (row.actual_usd as number | null) ?? null, estimatedUsd: (row.estimated_usd as number | null) ?? null }) : row.status === "reserved" ? Number(row.reserved_usd) : 0,
      })),

    // Endpoints, per project. Keys arrive only through /api/endpoints and are stored encrypted with the app's key.
    addEndpoint: async (c, input: { projectId: string; kind: EndpointKind; baseUrl: string; apiKey: string; allowedModels: string[] | "all" }): Promise<{ ok: true; endpoint: EndpointView } | { ok: false; error: string }> => {
      const { keyEncryptionKey, allowPrivateEndpoints } = services().config;
      if (!keyEncryptionKey) return { ok: false, error: "Customer endpoints are not available yet: the app has no key-encryption key." };
      if (!["openrouter", "openai-compatible", "anthropic"].includes(input.kind)) return { ok: false, error: "kind must be openrouter, openai-compatible or anthropic" };
      const problem = endpointUrlProblem(input.baseUrl, allowPrivateEndpoints);
      if (problem) return { ok: false, error: problem };
      if (typeof input.apiKey !== "string" || input.apiKey.trim().length < 8) return { ok: false, error: "apiKey is missing" };
      const models = input.allowedModels === "all" ? "all" : Array.isArray(input.allowedModels) ? input.allowedModels.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : null;
      if (!models || (models !== "all" && !models.length)) return { ok: false, error: "allowedModels must be \"all\" or a list of model IDs" };
      if (models === "all" && input.kind !== "openrouter") return { ok: false, error: "List the models this endpoint may run: only an OpenRouter endpoint can allow all" };
      if (!(await projectViews(c.db, input.projectId)).length) return { ok: false, error: "No such project in this account." };
      const id = `ep_${randomBytes(6).toString("hex")}`;
      const key = input.apiKey.trim();
      await c.db.execute(`INSERT INTO endpoints (id, project_id, kind, base_url, allowed_models, sealed_key, key_last4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.projectId, input.kind, input.baseUrl.replace(/\/$/, ""), JSON.stringify(models), encryptKey(keyEncryptionKey, c.key[0]!, key), key.slice(-4), Date.now());
      return { ok: true, endpoint: (await endpointViews(c.db, input.projectId)).find(item => item.id === id)! };
    },

    endpoints: async (c, projectId: string): Promise<EndpointView[]> => endpointViews(c.db, projectId),

    removeEndpoint: async (c, input: { projectId: string; id: string }): Promise<boolean> =>
      (await c.db.execute(`DELETE FROM endpoints WHERE id = ? AND project_id = ? RETURNING id`, input.id, input.projectId)).length > 0,

    // GitHub repositories. A token arrives only through /api/repos and is stored encrypted, as endpoint keys are.
    /** Checks that OpenMerit can read the repository, saves it and starts its review. Adding one again replaces its token. */
    addRepo: async (c, input: { projectId: string; url: string; token?: string | null }): Promise<{ ok: true; repo: RepoView } | { ok: false; error: string }> => {
      const { config, fetch } = services();
      // Reviews are part of a paid plan: without one, nothing reaches GitHub, is cloned or is spent.
      const unpaid = planRefusal(await plan(c.db));
      if (unpaid) return { ok: false, error: unpaid };
      const ref = parseRepoUrl(typeof input.url === "string" ? input.url : "");
      if (!ref) return { ok: false, error: "Paste the repository's GitHub URL, such as https://github.com/acme/app." };
      const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : null;
      if (token) {
        const problem = tokenProblem(token);
        if (problem) return { ok: false, error: problem };
        if (!config.keyEncryptionKey) return { ok: false, error: "Private repositories are not available yet: the app has no key-encryption key." };
      }
      if (!(await projectViews(c.db, input.projectId)).length) return { ok: false, error: "No such project in this account." };
      // A repository belongs to one project, so an MCP call from it finds its project.
      const [known] = await c.db.execute(`SELECT repos.id, repos.project_id, projects.name FROM repos LEFT JOIN projects ON projects.id = repos.project_id WHERE full_name = ?`, `${ref.owner}/${ref.name}`);
      if (known && known.project_id !== input.projectId) return { ok: false, error: `${ref.owner}/${ref.name} is already in the project ${String(known.name ?? known.project_id)}. Remove it there first.` };
      const [count] = await c.db.execute(`SELECT count(*) AS n FROM repos`);
      if (!known && Number(count?.n) >= config.limits.repos) return { ok: false, error: `This account has ${config.limits.repos} repositories, its limit. Remove one to add another.` };
      const busy = await reviewsRefusal(c.db);
      if (busy) return { ok: false, error: busy };
      const checked = await checkRepo(ref, token, config.github, fetch);
      if (!checked.ok) return checked;
      const { repo } = checked;
      const now = Date.now();
      const [existing] = await c.db.execute(`SELECT id FROM repos WHERE full_name = ?`, repo.fullName);
      const id = existing ? String(existing.id) : `repo_${randomBytes(6).toString("hex")}`;
      await c.db.execute(`INSERT INTO repos (id, project_id, full_name, private, default_branch, sealed_token, token_last4, added_at, checked_at, review_status, review_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        ON CONFLICT (id) DO UPDATE SET full_name = excluded.full_name, private = excluded.private, default_branch = excluded.default_branch, sealed_token = excluded.sealed_token,
        token_last4 = excluded.token_last4, checked_at = excluded.checked_at`,
      id, input.projectId, repo.fullName, repo.private ? 1 : 0, repo.defaultBranch, token ? encryptKey(config.keyEncryptionKey!, c.key[0]!, token) : null, token ? token.slice(-4) : null, now, now, now);
      await startReview(c, id, () => c.client<Registry>().catalogue.getOrCreate(["global"]).get());
      return { ok: true, repo: (await repoViews(c.db, { id }))[0]! };
    },

    repos: async (c, projectId: string): Promise<RepoView[]> => repoViews(c.db, { projectId }),

    /** Reviews the repository again, unless a review is already queued or running. */
    reviewRepo: async (c, input: { projectId: string; id: string }): Promise<{ ok: true; repo: RepoView } | { ok: false; status: 402 | 404 | 409; error: string }> => {
      const { id } = input;
      const [view] = await repoViews(c.db, input);
      if (!view) return { ok: false, status: 404, error: "No such repository in this account." };
      if (view.review.status === "queued" || view.review.status === "reviewing") return { ok: true, repo: view };
      const unpaid = planRefusal(await plan(c.db));
      if (unpaid) return { ok: false, status: 402, error: unpaid };
      const busy = await reviewsRefusal(c.db);
      if (busy) return { ok: false, status: 409, error: busy };
      await startReview(c, id, () => c.client<Registry>().catalogue.getOrCreate(["global"]).get());
      return { ok: true, repo: (await repoViews(c.db, { id }))[0]! };
    },

    /** Deletes the repository, its token and its review. A review still running finishes without saving. */
    removeRepo: async (c, input: { projectId: string; id: string }): Promise<boolean> =>
      (await c.db.execute(`DELETE FROM repos WHERE id = ? AND project_id = ? RETURNING id`, input.id, input.projectId)).length > 0,

    /** The endpoints a job may call, without keys: OpenRouter on OpenMerit's key first, then the customer's. */
    endpointsForJob: async (c, projectId: string): Promise<EndpointInfo[]> => (await jobEndpoints(c.db, c.key[0]!, projectId, false)).map(({ apiKey: _key, ...info }) => info),

    /** The same endpoints with their keys, for the job's model client. Returned only to the job, held in its memory, never stored. */
    endpointSecrets: async (c, projectId: string): Promise<EndpointConfig[]> => jobEndpoints(c.db, c.key[0]!, projectId, true),

    // Guardrails, per project and level: environment (a name), agent (`environment:agent`; environment names hold no colon) and task (task ID).
    setGuardrails: async (c, input: { projectId: string; level: Level; scope: string; settings: Guardrails }): Promise<{ rejected: { key: string; reason: string }[] }> => {
      const rejected = Object.keys(input.settings).filter(key => !Object.hasOwn(GUARDRAIL_KINDS, key)).map(key => ({ key, reason: "not a guardrail" }));
      const kept = Object.fromEntries(Object.entries(input.settings).filter(([key, value]) => Object.hasOwn(GUARDRAIL_KINDS, key) && value !== null && value !== undefined));
      await c.db.execute(`INSERT INTO guardrails (project_id, level, scope, settings) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, level, scope) DO UPDATE SET settings = excluded.settings`, input.projectId, input.level, input.scope, JSON.stringify(kept));
      return { rejected };
    },

    guardrails: async (c, input: { projectId: string; level: Level; scope: string }): Promise<GuardrailSetting[]> => {
      const settings = await levelSettings(c.db, input.projectId, input.level, input.scope);
      return Object.entries(settings).map(([key, value]) => ({ key, value, kind: GUARDRAIL_KINDS[key as GuardrailKey] }));
    },

    /** A task's effective guardrails, which level set each, and the settings refused. */
    resolveGuardrails: async (c, input: { projectId: string; environment: string; agent?: string | null; taskId?: string }): Promise<ResolvedGuardrails> => {
      const levels: Partial<Record<Level, Guardrails>> = {};
      for (const level of LEVELS) {
        if (level === "agent" && !input.agent) continue;
        if (level === "task" && !input.taskId) continue;
        levels[level] = await levelSettings(c.db, input.projectId, level, scopeKey(level, input));
      }
      return resolveGuardrails(levels);
    },

    // The task index, which the task actors keep current.
    // A recommend call (lastRecommendAt) brings a retired task back; retired is set only by openmerit_retire.
    // Status `switched` (the user approved the pick, now the current model) clears the pick.
    upsertTask: async (c, row: Pick<TaskRow, "id" | "projectId" | "environment" | "agent" | "name" | "currentModel" | "pick" | "status"> & { lastRunAt?: number; lastJobId?: string; lastRecommendAt?: number; retired?: boolean; monthlySavingUsd?: number | null }): Promise<void> => {
      const retired = row.retired === undefined ? (row.lastRecommendAt === undefined ? null : 0) : row.retired ? 1 : 0;
      await c.db.execute(`INSERT INTO tasks (id, project_id, environment, agent, name, current_model, pick, status, last_run_at, last_job_id, monthly_saving_usd, retired, last_recommend_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?) ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, current_model = excluded.current_model,
        pick = CASE WHEN excluded.status = 'switched' THEN NULL ELSE COALESCE(excluded.pick, tasks.pick) END, status = excluded.status, last_run_at = COALESCE(excluded.last_run_at, tasks.last_run_at),
        last_job_id = COALESCE(excluded.last_job_id, tasks.last_job_id), monthly_saving_usd = COALESCE(excluded.monthly_saving_usd, tasks.monthly_saving_usd),
        retired = COALESCE(?, tasks.retired), last_recommend_at = COALESCE(excluded.last_recommend_at, tasks.last_recommend_at)`,
      row.id, row.projectId, row.environment, row.agent, row.name, row.currentModel, row.pick, row.status, row.lastRunAt ?? null, row.lastJobId ?? null, row.monthlySavingUsd ?? null,
      retired, row.lastRecommendAt ?? null, retired);
    },

    /** One project's tasks, or every project's. */
    tasks: async (c, projectId?: string): Promise<TaskRow[]> => {
      const rows = await c.db.execute(`SELECT * FROM tasks WHERE ? IS NULL OR project_id = ? ORDER BY COALESCE(last_run_at, 0) DESC`, projectId ?? null, projectId ?? null);
      const watch = await watchGuardrails(c.db);
      return rows.map(row => taskRow(row, watch(row)));
    },

    task: async (c, id: string): Promise<TaskRow | null> => {
      const [row] = await c.db.execute(`SELECT * FROM tasks WHERE id = ?`, id);
      return row ? taskRow(row, (await watchGuardrails(c.db))(row)) : null;
    },

    /**
     * Erases a task's rows: the task, its reports (so run pages and share links stop loading) and its
     * task-level guardrails. Its runs leave every listing, but each keeps a row without content, as
     * its ledger rows do, so the plan's evaluation count and the spend caps still include them.
     * Records who deleted which task, without its content.
     */
    deleteTask: async (c, input: { taskId: string; userId: string }): Promise<{ jobs: number }> => c.db.transaction(async tx => {
      const [task] = await tx.execute(`SELECT name, environment, project_id FROM tasks WHERE id = ?`, input.taskId);
      if (!task) return { jobs: 0 };
      const [jobs] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE task_id = ? AND deleted_at IS NULL`, input.taskId);
      const now = Date.now();
      await tx.execute(`UPDATE jobs SET deleted_at = ?, asked_by = NULL WHERE task_id = ? AND deleted_at IS NULL`, now, input.taskId);
      await tx.execute(`DELETE FROM reports WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM decisions WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM guardrails WHERE project_id = ? AND level = 'task' AND scope = ?`, String(task.project_id), input.taskId);
      const [synced] = await tx.execute(`SELECT version FROM eval_sync WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM tasks WHERE id = ?`, input.taskId);
      // Its eval goes with it: every version and the record of the repository copy. A draft it was approved from keeps no content.
      await tx.execute(`DELETE FROM eval_versions WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM eval_sync WHERE task_id = ?`, input.taskId);
      await tx.execute(`UPDATE eval_drafts SET bundle = '{}', cases = '[]' WHERE task_id = ?`, input.taskId);
      // The repository copy stays until the coding agent removes it: its directory is kept here until then, and the agent is asked on its next call.
      const repoCopy = synced ? evalDir(String(task.name)) : null;
      await tx.execute(`INSERT INTO deletions (project_id, task_id, name, environment, user_id, jobs, deleted_at, repo_copy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, String(task.project_id), input.taskId, String(task.name), String(task.environment), input.userId, Number(jobs?.n ?? 0), now, repoCopy);
      return { jobs: Number(jobs?.n ?? 0) };
    }, { name: "delete_task" }),

    /** Tasks deleted from this account: who, when, and the task's ID and name. */
    deletions: async (c, projectId: string): Promise<{ taskId: string; name: string; environment: string; userId: string; jobs: number; deletedAt: string; repoCopy: string | null }[]> =>
      (await c.db.execute(`SELECT * FROM deletions WHERE project_id = ? ORDER BY deleted_at DESC`, projectId)).map(row => ({ taskId: String(row.task_id), name: String(row.name), environment: String(row.environment), userId: String(row.user_id), jobs: Number(row.jobs), deletedAt: iso(row.deleted_at)!, repoCopy: (row.repo_copy as string | null) ?? null })),

    /** Repository copies of deleted tasks' evals, which the coding agent offers to remove. */
    staleEvalCopies: async (c): Promise<{ taskId: string; name: string; environment: string; dir: string }[]> =>
      (await c.db.execute(`SELECT task_id, name, environment, repo_copy FROM deletions WHERE repo_copy IS NOT NULL ORDER BY deleted_at`)).map(row => ({ taskId: String(row.task_id), name: String(row.name), environment: String(row.environment), dir: String(row.repo_copy) })),
    /** The coding agent removed a deleted task's repository copy, or the user chose to keep it. */
    forgetEvalCopy: async (c, taskId: string): Promise<boolean> => (await c.db.execute(`UPDATE deletions SET repo_copy = NULL WHERE task_id = ? AND repo_copy IS NOT NULL RETURNING task_id`, taskId)).length > 0,

    // Reports.
    saveReport: async (c, input: { jobId: string; taskId: string; json: unknown; markdown: string }): Promise<void> => {
      await c.db.execute(`INSERT INTO reports (job_id, task_id, created_at, json, markdown) VALUES (?, ?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET json = excluded.json, markdown = excluded.markdown`,
        input.jobId, input.taskId, Date.now(), JSON.stringify(input.json), input.markdown);
    },

    report: async (c, input: { jobId: string } | { shareToken: string }): Promise<{ jobId: string; json: unknown; markdown: string } | null> => {
      const [row] = "jobId" in input
        ? await c.db.execute(`SELECT job_id, json, markdown FROM reports WHERE job_id = ?`, input.jobId)
        : await c.db.execute(`SELECT job_id, json, markdown FROM reports WHERE share_token = ?`, input.shareToken);
      return row ? { jobId: String(row.job_id), json: JSON.parse(String(row.json)) as unknown, markdown: String(row.markdown) } : null;
    },

    /** A token for a public link to one report; the same token on every call. */
    share: async (c, jobId: string): Promise<string | null> => {
      const [row] = await c.db.execute(`SELECT share_token FROM reports WHERE job_id = ?`, jobId);
      if (!row) return null;
      if (row.share_token) return String(row.share_token);
      const token = randomBytes(18).toString("base64url");
      await c.db.execute(`UPDATE reports SET share_token = ? WHERE job_id = ?`, token, jobId);
      return token;
    },

    /** Jobs that finished since this member's last MCP session, and starts a new session. */
    readySince: async (c, userId: string): Promise<JobRow[]> => {
      const [member] = await c.db.execute(`SELECT last_session_at FROM members WHERE user_id = ?`, userId);
      const since = Number(member?.last_session_at ?? 0);
      const rows = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.finished_at > ? AND jobs.deleted_at IS NULL ORDER BY jobs.finished_at DESC LIMIT 20`, since);
      await c.db.execute(`UPDATE members SET last_session_at = ? WHERE user_id = ?`, Date.now(), userId);
      return rows.map(jobRow);
    },

    /** Refuses MCP access tokens issued before now. */
    disconnect: async (c): Promise<void> => {
      await c.db.execute(`INSERT INTO account (id, mcp_revoked_before) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET mcp_revoked_before = excluded.mcp_revoked_before`, Math.floor(Date.now() / 1000));
    },

    /** Records the user's decision on a job's change, as the coding agent sent it; the first decision stands. */
    decide: async (c, input: Omit<Decision, "at">): Promise<{ recorded: boolean; decision: Decision }> => {
      const inserted = await c.db.execute(`INSERT INTO decisions (job_id, task_id, decision, change, decided_by, decided_by_name, decided_by_email, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_id) DO NOTHING RETURNING job_id`, input.jobId, input.taskId, input.decision, input.change, input.by, input.name, input.email, Date.now());
      return { recorded: inserted.length > 0, decision: (await decisionOf(c.db, input.jobId))! };
    },
    decision: async (c, jobId: string): Promise<Decision | null> => decisionOf(c.db, jobId),
    /** The latest decision on each task, keyed by task ID. */
    taskDecisions: async (c): Promise<Record<string, Decision>> => {
      const rows = await c.db.execute(`SELECT * FROM decisions d WHERE decided_at = (SELECT max(decided_at) FROM decisions WHERE task_id = d.task_id)`);
      return Object.fromEntries(rows.map(row => [String(row.task_id), decisionRow(row)]));
    },

    // Evals. The cloud holds every version; the coding agent writes the latest to the repository when the user agrees.
    eval: async (c, taskId: string): Promise<EvalView | null> => evalView(c.db, taskId),

    /** Each task's latest eval version and the version in its repository, for the coding agent's task list. */
    evalHeads: async (c): Promise<Record<string, { version: number; repo: number | null }>> =>
      Object.fromEntries((await c.db.execute(`SELECT v.task_id, max(v.version) AS version, s.version AS repo FROM eval_versions v LEFT JOIN eval_sync s ON s.task_id = v.task_id GROUP BY v.task_id`))
        .map(row => [String(row.task_id), { version: Number(row.version), repo: row.repo === null || row.repo === undefined ? null : Number(row.repo) }])),

    /**
     * The latest version's spec and cases, for a job to run on, and the inputs of every case any version
     * had, so an example someone removed is not added back; null before the task has an eval.
     */
    evalFor: async (c, taskId: string): Promise<{ version: number; spec: EvalSpec; cases: Case[]; seen: Case["input"][] } | null> => {
      const latest = (await evalView(c.db, taskId))?.latest;
      if (!latest) return null;
      const seen = new Map<string, Case["input"]>();
      for (const row of await c.db.execute(`SELECT cases FROM eval_versions WHERE task_id = ?`, taskId)) for (const item of JSON.parse(String(row.cases)) as Case[]) seen.set(JSON.stringify(item.input), item.input);
      return { version: latest.version, spec: latest.spec, cases: latest.cases, seen: [...seen.values()] };
    },

    /**
     * Saves a new version when the spec or cases changed. With baseVersion, as the app sends it, a version
     * saved meanwhile refuses the change, so two people editing do not overwrite each other.
     */
    saveEval: async (c, input: { taskId: string; projectId: string; spec: EvalSpec; cases: Case[]; source: EvalSource; author: string | null; note?: string | null; baseVersion?: number | null }): Promise<{ ok: true; version: number; changed: boolean } | { ok: false; error: string }> => c.db.transaction(async tx => {
      const [latest] = await tx.execute(`SELECT version, spec, cases FROM eval_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1`, input.taskId);
      const current = latest ? Number(latest.version) : 0;
      if (input.baseVersion !== undefined && input.baseVersion !== null && input.baseVersion !== current) return { ok: false, error: `Someone saved version ${current} of this eval while you edited version ${input.baseVersion}. Reload it and make your change again.` };
      const spec = JSON.stringify(input.spec), cases = JSON.stringify(input.cases);
      if (latest && String(latest.spec) === spec && String(latest.cases) === cases) return { ok: true, version: current, changed: false };
      await tx.execute(`INSERT INTO eval_versions (task_id, version, project_id, spec, cases, source, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.taskId, current + 1, input.projectId, spec, cases, input.source, input.author, input.note ?? null, Date.now());
      return { ok: true, version: current + 1, changed: true };
    }, { name: "save_eval" }),

    /** The eval version a job runs on, recorded once it is known. */
    setJobEval: async (c, input: { jobId: string; version: number }): Promise<void> => {
      await c.db.execute(`UPDATE jobs SET eval_version = ? WHERE id = ?`, input.version, input.jobId);
    },

    /** The coding agent wrote this version to the repository. */
    syncEval: async (c, input: { taskId: string; version: number; by: string; client: string | null }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const [found] = await c.db.execute(`SELECT version FROM eval_versions WHERE task_id = ? AND version = ?`, input.taskId, input.version);
      if (!found) return { ok: false, error: `This task's eval has no version ${input.version}.` };
      await c.db.execute(`INSERT INTO eval_sync (task_id, version, synced_by, client, synced_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (task_id) DO UPDATE SET version = excluded.version, synced_by = excluded.synced_by, client = excluded.client, synced_at = excluded.synced_at`, input.taskId, input.version, input.by, input.client, Date.now());
      return { ok: true };
    },

    /**
     * Evals a repository review wrote. A new review replaces the pending draft of the same task; a task
     * the project already has, or a draft someone approved or dismissed, is not offered again.
     */
    addEvalDrafts: async (c, input: { projectId: string; repoId: string | null; environment: string; drafts: { bundle: TaskBundle; cases: Case[] }[] }): Promise<number> => addDrafts(c.db, input),

    evalDrafts: async (c, input: { projectId?: string; status?: EvalDraft["status"] } = {}): Promise<EvalDraft[]> =>
      (await c.db.execute(`SELECT * FROM eval_drafts WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at`, input.projectId ?? null, input.projectId ?? null, input.status ?? null, input.status ?? null)).map(draftRow),

    /**
     * Approves a pending draft: the task joins the project, not run yet, with the draft as its eval's first
     * version, which its first run uses instead of writing cases. The caller creates the task actor with the bundle.
     */
    approveDraft: async (c, input: { id: string; taskId: string; userId: string; bundle: TaskBundle; cases: Case[] }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT * FROM eval_drafts WHERE id = ?`, input.id);
      if (!row) return { ok: false, status: 404, error: "No such draft in this account." };
      if (row.status !== "pending") return { ok: false, status: 409, error: `This draft was already ${String(row.status)}.` };
      const [task] = await tx.execute(`SELECT id FROM tasks WHERE id = ?`, input.taskId);
      if (task) return { ok: false, status: 409, error: "This project already has a task by that name. Dismiss the draft, or edit the task's eval." };
      const now = Date.now();
      await tx.execute(`INSERT INTO tasks (id, project_id, environment, agent, name, current_model, pick, status, retired) VALUES (?, ?, ?, NULL, ?, ?, NULL, 'new', 0)`,
        input.taskId, String(row.project_id), String(row.environment), input.bundle.task, input.bundle.current.model);
      await tx.execute(`INSERT INTO eval_versions (task_id, version, project_id, spec, cases, source, author, note, created_at) VALUES (?, 1, ?, ?, ?, 'review', ?, NULL, ?)`,
        input.taskId, String(row.project_id), JSON.stringify(specOf(input.bundle)), JSON.stringify(input.cases), input.userId, now);
      await tx.execute(`UPDATE eval_drafts SET status = 'approved', decided_by = ?, decided_at = ?, task_id = ? WHERE id = ?`, input.userId, now, input.taskId, input.id);
      return { ok: true };
    }, { name: "approve_draft" }),

    dismissDraft: async (c, input: { id: string; userId: string }): Promise<boolean> =>
      (await c.db.execute(`UPDATE eval_drafts SET status = 'dismissed', decided_by = ?, decided_at = ?, bundle = '{}', cases = '[]' WHERE id = ? AND status = 'pending' RETURNING id`, input.userId, Date.now(), input.id)).length > 0,

    /** Everything the account holds, except keys and repository tokens. */
    export: async (c): Promise<Record<string, unknown>> => {
      const all = async (table: string) => c.db.execute(`SELECT * FROM ${table}`);
      return {
        account: c.key[0], exportedAt: new Date().toISOString(), plan: await plan(c.db), members: await all("members"), projects: await projectViews(c.db),
        endpoints: (await all("endpoints")).map(row => ({ id: row.id, projectId: row.project_id, kind: row.kind, baseUrl: row.base_url, allowedModels: JSON.parse(String(row.allowed_models)) as unknown, keyLast4: row.key_last4 })),
        guardrails: (await all("guardrails")).map(row => ({ ...row, settings: JSON.parse(String(row.settings)) as unknown })), tasks: await (async () => { const watch = await watchGuardrails(c.db); return (await all("tasks")).map(row => taskRow(row, watch(row))); })(),
        decisions: (await all("decisions")).map(decisionRow), repos: await repoViews(c.db),
        evals: (await all("eval_versions")).map(row => ({ taskId: row.task_id, projectId: row.project_id, version: row.version, source: row.source, author: row.author, createdAt: iso(row.created_at), spec: JSON.parse(String(row.spec)) as unknown, cases: JSON.parse(String(row.cases)) as unknown })),
        evalSync: await all("eval_sync"), evalDrafts: (await all("eval_drafts")).map(draftRow),
        jobs: (await c.db.execute(`SELECT * FROM jobs WHERE deleted_at IS NULL`)).map(jobRow), deletions: await all("deletions"), ledger: await all("ledger"), reports: (await all("reports")).map(row => ({ jobId: row.job_id, taskId: row.task_id, report: JSON.parse(String(row.json)) as unknown })),
      };
    },

    /** Destroys this actor and its storage. The caller destroys the account's task and job actors first. */
    destroy: (c): void => { c.destroy(); },
  },
});

type Database = { execute: <T extends Row = Row>(query: string, ...args: unknown[]) => Promise<T[]> };
/** The actor's database, whose transactions run their checks and writes together. */
type Transactional = Database & { transaction: <T>(run: (tx: Database) => Promise<T>, options: { name: string }) => Promise<T> };

function decisionRow(row: Row): Decision {
  return {
    jobId: String(row.job_id), taskId: String(row.task_id), decision: row.decision === "approved" ? "approved" : "declined", change: String(row.change), by: String(row.decided_by),
    name: (row.decided_by_name as string | null) ?? null, email: (row.decided_by_email as string | null) ?? null, at: iso(row.decided_at)!,
  };
}

async function decisionOf(database: Database, jobId: string): Promise<Decision | null> {
  const [row] = await database.execute(`SELECT * FROM decisions WHERE job_id = ?`, jobId);
  return row ? decisionRow(row) : null;
}

async function plan(database: Database): Promise<Plan | null> {
  const [row] = await database.execute(`SELECT * FROM plan WHERE id = 1`);
  if (!row) return null;
  const start = typeof row.period_start === "number" ? row.period_start * 1000 : startOfMonth(Date.now());
  const [used] = await database.execute(`SELECT COALESCE(sum(counted), 0) AS n FROM jobs WHERE counted > 0 AND finished_at >= ?`, start);
  const [reviews] = EVALUATIONS_PER_REVIEW ? await database.execute(`SELECT count(*) AS n FROM ledger WHERE key LIKE '${REVIEW_LEDGER}%' AND status = 'settled' AND created_at >= ?`, start) : [];
  return {
    name: String(row.name ?? "OpenMerit"), status: String(row.status ?? "incomplete"), periodStart: (row.period_start as number | null) ?? null, periodEnd: (row.period_end as number | null) ?? null,
    includedEvals: Number(row.included_evals ?? 0), usedEvals: Number(used?.n ?? 0) + EVALUATIONS_PER_REVIEW * Number(reviews?.n ?? 0), overage: row.overage === "metered" ? "metered" : "refuse", customerId: (row.customer_id as string | null) ?? null,
  };
}

/**
 * Why the account cannot start paid work, or null: every evaluation and every repository review needs a
 * plan that Stripe says is active or trialing. There is no free cloud plan; the CLI is the free option.
 */
function planRefusal(current: Plan | null): string | null {
  if (current && ACTIVE_PLAN.has(current.status)) return null;
  return `This account has no active OpenMerit plan${current ? ` (Stripe says ${current.status})` : ""}. Subscribe at ${services().config.appUrl}/plan/, then try again.`;
}

/** The start of the billing period in milliseconds: Stripe's, else the calendar month. */
async function periodStart(database: Database): Promise<number> {
  const [row] = await database.execute(`SELECT period_start FROM plan WHERE id = 1`);
  return typeof row?.period_start === "number" ? row.period_start * 1000 : startOfMonth(Date.now());
}

/** Reports an evaluation beyond the plan to Stripe, once per job. */
async function meter(database: Database, jobId: string): Promise<void> {
  const current = await plan(database);
  const billing = services().billing;
  if (!current?.customerId || current.overage !== "metered" || current.usedEvals <= current.includedEvals || !billing) return;
  const [job] = await database.execute(`SELECT metered FROM jobs WHERE id = ?`, jobId);
  if (!job || job.metered === 1) return;
  await billing.reportUsage({ customerId: current.customerId, identifier: jobId, quantity: 1 });
  await database.execute(`UPDATE jobs SET metered = 1 WHERE id = ?`, jobId);
}

async function levelSettings(database: Database, projectId: string, level: Level, scope: string): Promise<Guardrails> {
  const [row] = await database.execute(`SELECT settings FROM guardrails WHERE project_id = ? AND level = ? AND scope = ?`, projectId, level, scope);
  return row ? JSON.parse(String(row.settings)) as Guardrails : {};
}

/** Each task's effective `watch` guardrail, from one read of every level's settings. */
async function watchGuardrails(database: Database): Promise<(row: Row) => boolean | undefined> {
  const settings = new Map((await database.execute(`SELECT project_id, level, scope, settings FROM guardrails`)).map(item => [`${String(item.project_id)}\0${String(item.level)}\0${String(item.scope)}`, JSON.parse(String(item.settings)) as Guardrails]));
  return row => {
    const input = { environment: String(row.environment), agent: (row.agent as string | null) ?? null, taskId: String(row.id) };
    const levels: Partial<Record<Level, Guardrails>> = {};
    for (const level of LEVELS) if (level !== "agent" || input.agent) levels[level] = settings.get(`${String(row.project_id)}\0${level}\0${scopeKey(level, input)}`) ?? {};
    return resolveGuardrails(levels).effective.watch;
  };
}

const MAX_PROJECTS = 50;
const projectNameProblem = (name: unknown): string | null =>
  typeof name !== "string" || !name.trim() ? "Name the project." : name.trim().length > 64 ? "A project's name is at most 64 characters." : null;
async function nameTaken(database: Database, name: string, except: string | null): Promise<string | null> {
  const [row] = await database.execute(`SELECT id FROM projects WHERE lower(name) = lower(?) AND id IS NOT ?`, name, except);
  return row ? `This account already has a project named ${name}.` : null;
}

/** The account's projects, default first, then by creation, with what each holds. */
async function projectViews(database: Database, id?: string): Promise<Project[]> {
  const rows = await database.execute(`SELECT p.id, p.name, p.created_at,
      (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS tasks,
      (SELECT count(*) FROM endpoints e WHERE e.project_id = p.id) AS endpoints,
      (SELECT json_group_array(full_name) FROM (SELECT full_name FROM repos r WHERE r.project_id = p.id ORDER BY added_at)) AS repos
    FROM projects p ${id ? "WHERE p.id = ?" : ""} ORDER BY p.id = '${DEFAULT_PROJECT}' DESC, p.created_at`, ...(id ? [id] : []));
  return rows.map(row => ({ id: String(row.id), name: String(row.name), createdAt: iso(row.created_at)!, tasks: Number(row.tasks), endpoints: Number(row.endpoints), repos: JSON.parse(String(row.repos)) as string[] }));
}

async function endpointViews(database: Database, project: string): Promise<EndpointView[]> {
  const rows = await database.execute(`SELECT id, kind, base_url, allowed_models, key_last4, verified_at FROM endpoints WHERE project_id = ? ORDER BY created_at`, project);
  return rows.map(row => ({ id: String(row.id), kind: row.kind as EndpointKind, baseUrl: String(row.base_url), allowedModels: JSON.parse(String(row.allowed_models)) as string[] | "all", keyLast4: String(row.key_last4), verifiedAt: iso(row.verified_at), builtIn: false }));
}

/** Why the account cannot start another review this hour, or null. */
async function reviewsRefusal(database: Database): Promise<string | null> {
  const { reviewsPerHour } = services().config.limits;
  const [row] = await database.execute(`SELECT count(*) AS n FROM repo_reviews WHERE requested_at > ?`, Date.now() - 3_600_000);
  return Number(row?.n) >= reviewsPerHour ? `This account started ${reviewsPerHour} repository reviews in the last hour, its limit. Try again later.` : null;
}

/** A review queued or running for longer than this stopped with its node, such as in a deploy, and can start again. */
const reviewStaleMs = () => services().config.github.cloneTimeoutMs + (services().config.limits.reviewMinutes + 5) * 60_000;

/** Ledger keys, and job IDs, of repository reviews: `review/<repo id>/<requested at>`. */
const REVIEW_LEDGER = "review/";

/**
 * Evaluations one repository review counts against the plan. None for now: whether a review is one is
 * undecided, and this is the only place to change it. Its spend always goes into the ledger.
 */
const EVALUATIONS_PER_REVIEW = 0;

/** Reserves a review's budget as OpenMerit-paid spend, or says which monthly cap refuses it. */
async function reserveReview(database: Transactional, key: string, model: string, usd: number): Promise<string | null> {
  return database.transaction(async tx => {
    const cap = services().config.limits.monthlyCapUsd;
    const [row] = await tx.execute(`SELECT COALESCE(sum(${COUNTED}), 0) AS usd FROM ledger WHERE funding = 'openmerit' AND created_at >= ?`, await periodStart(tx));
    const used = Number(row?.usd ?? 0);
    if (used + usd > cap + 1e-9) return `The review needs up to $${usd.toFixed(2)}, and this account has used or reserved $${used.toFixed(4)} of its $${cap.toFixed(2)} monthly OpenMerit-paid cap. Try again next period.`;
    await tx.execute(`INSERT INTO ledger (key, job_id, funding, model, status, reserved_usd, created_at) VALUES (?, ?, 'openmerit', ?, 'reserved', ?, ?)`, key, key, model, usd, Date.now());
    return null;
  }, { name: "review_reserve" });
}

/**
 * Queues a review and runs it after the action returns: the clone and scan take longer than an
 * action may. The request time tells this review's result from a later one's: a review whose
 * repository was added again or removed meanwhile saves nothing.
 */
async function startReview(c: { db: Transactional; key: readonly string[]; keepAwake: <T>(promise: Promise<T>) => Promise<T> }, id: string, catalogue: () => Promise<Catalogue>): Promise<void> {
  const requestedAt = Date.now();
  await c.db.execute(`UPDATE repos SET review_status = 'queued', review_requested_at = ? WHERE id = ?`, requestedAt, id);
  await c.db.execute(`DELETE FROM repo_reviews WHERE requested_at < ?`, requestedAt - 3_600_000);
  await c.db.execute(`INSERT INTO repo_reviews (repo_id, requested_at) VALUES (?, ?)`, id, requestedAt);
  const current = `id = ? AND review_requested_at = ?`;
  const run = async () => {
    const [row] = await c.db.execute(`SELECT full_name, default_branch, sealed_token FROM repos WHERE ${current}`, id, requestedAt);
    if (!row) return;
    await c.db.execute(`UPDATE repos SET review_status = 'reviewing' WHERE ${current}`, id, requestedAt);
    const { config } = services();
    const { limits, models, openrouter } = config;
    // The review's model calls are OpenMerit-paid spend: its budget is reserved against the monthly cap before
    // the clone, and settled at what the calls cost. It starts no job, so it is not one of the plan's evaluations.
    const key = `${REVIEW_LEDGER}${id}/${requestedAt}`;
    const reviewer = openrouter.apiKey ? { model: models.reviewer, apiKey: openrouter.apiKey, baseUrl: openrouter.baseUrl, budgetUsd: limits.reviewBudgetUsd, timeoutMs: limits.reviewMinutes * 60_000 } : null;
    let reserved = false;
    try {
      let token: string | null = null;
      if (row.sealed_token) {
        try { token = decryptKey(config.keyEncryptionKey!, c.key[0]!, String(row.sealed_token)); } catch { throw new Error("OpenMerit can no longer read this repository's token. Add the repository again with its token."); }
      }
      if (reviewer) {
        const refused = await reserveReview(c.db, key, reviewer.model, reviewer.budgetUsd);
        if (refused) throw new Error(refused);
        reserved = true;
      }
      // The evals it found are drafts, not part of the saved review, which keeps the model calls and task specs.
      const { evals, ...review } = await reviewRepository({ fullName: String(row.full_name), branch: String(row.default_branch), token, config: config.github, catalogue: await catalogue(), reviewer });
      if (reserved) await c.db.execute(`UPDATE ledger SET status = 'settled', actual_usd = ? WHERE key = ? AND status = 'reserved'`, review.costUsd, key);
      const saved = await c.db.execute(`UPDATE repos SET review_status = 'done', review_finished_at = ?, review_error = NULL, review = ? WHERE ${current} RETURNING project_id`, Date.now(), JSON.stringify(review), id, requestedAt);
      // Each task spec the review wrote, and each eval Scout wrote in the repository, becomes a draft for a person to approve; a spec's
      // examples are its first cases. Scout's evals come last, so for the same task the one with written cases is offered.
      const drafts = [...review.tasks.map(bundle => ({ bundle, cases: (bundle.examples ?? []).map((example, index): Case => ({ id: `example-${index + 1}`, input: example.input, expected: example.expected, origin: "example", ...(example.toolResults ? { toolResults: example.toolResults } : {}) })) })),
        ...evals.map(item => ({ bundle: item.bundle, cases: item.cases }))];
      if (saved[0] && drafts.length) await addDrafts(c.db, { projectId: String(saved[0].project_id), repoId: id, environment: String(row.full_name), drafts });
    } catch (error) {
      // Only the clone or the scan throws, before any model call: nothing was spent.
      if (reserved) await c.db.execute(`UPDATE ledger SET status = 'released' WHERE key = ? AND status = 'reserved'`, key);
      await c.db.execute(`UPDATE repos SET review_status = 'failed', review_finished_at = ?, review_error = ? WHERE ${current}`, Date.now(), error instanceof Error ? error.message : "The review failed.", id, requestedAt);
    }
  };
  void c.keepAwake(run()).catch(() => undefined);
}

async function repoViews(database: Database, input: { id?: string; projectId?: string } = {}): Promise<RepoView[]> {
  const rows = await database.execute(`SELECT * FROM repos WHERE (? IS NULL OR id = ?) AND (? IS NULL OR project_id = ?) ORDER BY added_at`, input.id ?? null, input.id ?? null, input.projectId ?? null, input.projectId ?? null);
  const stale = Date.now() - reviewStaleMs();
  return rows.map(row => {
    const active = row.review_status === "queued" || row.review_status === "reviewing";
    const stopped = active && Number(row.review_requested_at) < stale;
    return {
      id: String(row.id), projectId: String(row.project_id), fullName: String(row.full_name), url: `https://github.com/${String(row.full_name)}`, private: row.private === 1, defaultBranch: String(row.default_branch),
      tokenLast4: (row.token_last4 as string | null) ?? null, addedAt: iso(row.added_at)!, checkedAt: iso(row.checked_at)!,
      review: {
        status: stopped ? "failed" : row.review_status as RepoView["review"]["status"], requestedAt: iso(row.review_requested_at)!, finishedAt: iso(row.review_finished_at),
        error: stopped ? "The review stopped before it finished. Review the repository again." : (row.review_error as string | null) ?? null,
        result: typeof row.review === "string" ? JSON.parse(row.review) as RepoReview : null,
      },
    };
  });
}

async function jobEndpoints(database: Database, accountId: string, projectId: string, withKeys: boolean): Promise<(EndpointConfig & EndpointInfo)[]> {
  const { openrouter, keyEncryptionKey } = services().config;
  const out: (EndpointConfig & EndpointInfo)[] = [];
  if (openrouter.apiKey) out.push({ id: OPENROUTER, kind: "openrouter", baseUrl: openrouter.baseUrl, allowedModels: "all", funding: "openmerit", apiKey: withKeys ? openrouter.apiKey : "" });
  const rows = await database.execute(`SELECT id, kind, base_url, allowed_models, sealed_key FROM endpoints WHERE project_id = ? ORDER BY created_at`, projectId);
  for (const row of rows) {
    // An endpoint whose key no longer decrypts, such as after a key rotation, is left out rather than failing the job.
    let apiKey = "";
    if (withKeys) { try { apiKey = decryptKey(keyEncryptionKey!, accountId, String(row.sealed_key)); } catch { continue; } }
    out.push({ id: String(row.id), kind: row.kind as EndpointKind, baseUrl: String(row.base_url), allowedModels: JSON.parse(String(row.allowed_models)) as string[] | "all", funding: "customer", apiKey });
  }
  return out;
}

function draftRow(row: Row): EvalDraft {
  return {
    id: String(row.id), projectId: String(row.project_id), repoId: (row.repo_id as string | null) ?? null, environment: String(row.environment), name: String(row.name),
    bundle: JSON.parse(String(row.bundle)) as TaskBundle, cases: JSON.parse(String(row.cases)) as Case[], status: row.status as EvalDraft["status"], createdAt: iso(row.created_at)!, taskId: (row.task_id as string | null) ?? null,
  };
}

async function addDrafts(database: Database, input: { projectId: string; repoId: string | null; environment: string; drafts: { bundle: TaskBundle; cases: Case[] }[] }): Promise<number> {
  const now = Date.now();
  let added = 0;
  for (const draft of input.drafts) {
    const [decided] = await database.execute(`SELECT 1 FROM eval_drafts WHERE project_id = ? AND environment = ? AND lower(name) = lower(?) AND status <> 'pending'
      UNION SELECT 1 FROM tasks WHERE project_id = ? AND environment = ? AND lower(name) = lower(?)`, input.projectId, input.environment, draft.bundle.task, input.projectId, input.environment, draft.bundle.task);
    if (decided) continue;
    added++;
    await database.execute(`DELETE FROM eval_drafts WHERE project_id = ? AND environment = ? AND lower(name) = lower(?) AND status = 'pending'`, input.projectId, input.environment, draft.bundle.task);
    await database.execute(`INSERT INTO eval_drafts (id, project_id, repo_id, environment, name, bundle, cases, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      `draft_${randomBytes(6).toString("hex")}`, input.projectId, input.repoId, input.environment, draft.bundle.task, JSON.stringify(draft.bundle), JSON.stringify(draft.cases), now);
  }
  return added;
}

async function evalView(database: Database, taskId: string): Promise<EvalView | null> {
  const rows = await database.execute(`SELECT v.*, (SELECT count(*) FROM jobs j WHERE j.task_id = v.task_id AND j.eval_version = v.version AND j.deleted_at IS NULL) AS runs FROM eval_versions v WHERE task_id = ? ORDER BY version DESC`, taskId);
  const [task] = await database.execute(`SELECT project_id FROM tasks WHERE id = ?`, taskId);
  if (!task) return null;
  const [sync] = await database.execute(`SELECT * FROM eval_sync WHERE task_id = ?`, taskId);
  const meta = (row: Row) => ({ version: Number(row.version), source: row.source as EvalSource, author: (row.author as string | null) ?? null, note: (row.note as string | null) ?? null, createdAt: iso(row.created_at)!, runs: Number(row.runs) });
  const head = rows[0];
  return {
    taskId, projectId: String(task.project_id),
    latest: head ? { ...meta(head), spec: JSON.parse(String(head.spec)) as EvalSpec, cases: JSON.parse(String(head.cases)) as Case[] } : null,
    versions: rows.map(meta),
    repo: sync ? { version: Number(sync.version), by: String(sync.synced_by), client: (sync.client as string | null) ?? null, at: iso(sync.synced_at)! } : null,
  };
}
