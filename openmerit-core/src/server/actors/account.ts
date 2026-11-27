// The account actor, one per Clerk organization: its plan from Stripe, members, projects, endpoints with
// encrypted keys, guardrails at each level, the spend ledger, and the index of tasks, jobs and
// reports. SQLite holds all of it, so the ledger's checks and writes run in one transaction.
import { randomBytes } from "node:crypto";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import type { PlanUpdate } from "../billing.ts";
import { GUARDRAIL_KINDS, LEVELS, resolveGuardrails, settledUsd, type Funding, type GuardrailKey, type Guardrails, type Level, type ReserveResult, type ResolvedGuardrails, type Settlement } from "../engine.ts";
import { decryptKey, encryptKey, endpointUrlProblem } from "../keys.ts";
import { checkRepo, parseRepoUrl, reviewRepository, tokenProblem, type RepoReview } from "../github.ts";
import type { Catalogue } from "../engine.ts";
import { OPENROUTER, type EndpointInfo } from "../../job/pool.ts";
import type { Case, EndpointConfig, EndpointKind, TaskBundle } from "../../ranking/index.ts";
import type { EvalCommandSpec } from "../../job/workflow.ts";
import type { Registry } from "../registry.ts";
import { services } from "../services.ts";

type Row = Record<string, unknown>;

// The project, eval and budget names the task job (openmerit-core/src/job/workflow.ts) shares with this actor.
export { DEFAULT_PROJECT, JOB_BUDGET, type EvalBar, type EvalSource, type EvalSpec } from "../../job/workflow.ts";
import { DEFAULT_PROJECT, JOB_BUDGET, type EvalBar, type EvalGrade, type EvalSource, type EvalSpec } from "../../job/workflow.ts";

/**
 * An account's projects group its tasks, runs, guardrails and model endpoints; the plan, members and spend stay the
 * account's. Every account has the default project, which holds what it had before projects and can be renamed but not deleted.
 */
export const DEFAULT_PROJECT_NAME = "Default project";
export interface Project { id: string; name: string; createdAt: string; tasks: number; endpoints: number; repos: string[] }
/**
 * A GitHub repository the project added. tokenLast4 is null unless it was added with a fine-grained token.
 * review.result is the last review that finished, kept while a new one runs or after it fails.
 */
export interface RepoView {
  id: string; projectId: string; fullName: string; url: string; private: boolean; defaultBranch: string; tokenLast4: string | null; addedAt: string; checkedAt: string;
  /** How OpenMerit reads it: by its public URL, with a fine-grained token, or through the GitHub sign-in of the member who added it (`githubUser`, a Clerk user ID). */
  access: "public" | "token" | "github"; githubUser: string | null;
  review: { status: "queued" | "reviewing" | "done" | "failed"; requestedAt: string; finishedAt: string | null; error: string | null; result: RepoReview | null };
}
/**
 * A task a repository review found, waiting for a person: approving it creates the task, not run yet, with the
 * reviewed spec and its examples; its first run writes the cases and grades them with the person, as any first run does.
 */
export interface EvalDraft { id: string; projectId: string; repoId: string | null; environment: string; name: string; bundle: TaskBundle; cases: Case[]; status: "pending" | "approved" | "dismissed"; createdAt: string; taskId: string | null }
/** The tables a project scopes, which accounts stored before projects get a project_id column on, set to the default project. */
const PROJECT_TABLES = ["endpoints", "jobs", "tasks", "deletions", "confirmations"];

/** Bumped when the schema changes in a way old accounts cannot keep: their tables are dropped. */
const SCHEMA_VERSION = 2;
const RESET_TABLES = ["projects", "endpoints", "guardrails", "jobs", "tasks", "deletions", "decisions", "reports", "repos", "repo_reviews", "evals", "eval_sync", "eval_drafts", "confirmations", "eval_commands"];
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
    finished_at INTEGER, budget_usd REAL, cap_openmerit_usd REAL, cap_customer_usd REAL, counted INTEGER NOT NULL DEFAULT 0, metered INTEGER NOT NULL DEFAULT 0, asked_by TEXT, deleted_at INTEGER, eval_version INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ledger (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, funding TEXT NOT NULL, model TEXT, endpoint TEXT, status TEXT NOT NULL,
    reserved_usd REAL NOT NULL, actual_usd REAL, estimated_usd REAL, failed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', environment TEXT NOT NULL, agent TEXT, name TEXT NOT NULL, current_model TEXT NOT NULL,
    pick TEXT, status TEXT NOT NULL, last_run_at INTEGER, last_job_id TEXT, monthly_saving_usd REAL, retired INTEGER NOT NULL DEFAULT 0, last_recommend_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS deletions (project_id TEXT NOT NULL DEFAULT 'default', task_id TEXT NOT NULL, name TEXT NOT NULL, environment TEXT NOT NULL, user_id TEXT NOT NULL, jobs INTEGER NOT NULL, deleted_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decisions (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, change TEXT NOT NULL,
    decided_by TEXT NOT NULL, decided_by_name TEXT, decided_by_email TEXT, decided_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reports (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, markdown TEXT NOT NULL, share_token TEXT UNIQUE)`,
  // openmerit_recommend's idempotency keys, kept a day: the job each started, or null while it is starting.
  `CREATE TABLE IF NOT EXISTS recommend_keys (key TEXT PRIMARY KEY, job_id TEXT, created_at INTEGER NOT NULL)`,
  // A task's eval: the accepted one runs, unchanged, until the task changes or someone revises it. version counts acceptances;
  // shape is the prompt, tools and output it was accepted for. The draft_ columns hold the eval under review, edited in place;
  // draft_bundle is the changed task's bundle, which replaces the task's on acceptance. bar is `criteria` once a person grading
  // a run's answers marked the current model's own wrong, so models are measured against the eval's checks; else null.
  `CREATE TABLE IF NOT EXISTS evals (task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, spec TEXT NOT NULL, cases TEXT NOT NULL, shape TEXT NOT NULL,
    source TEXT NOT NULL, accepted_by TEXT, accepted_at INTEGER NOT NULL, bar TEXT,
    draft_reason TEXT, draft_changed TEXT, draft_spec TEXT, draft_cases TEXT, draft_bundle TEXT, draft_by TEXT, draft_at INTEGER)`,
  // Critical requests a coding agent made, waiting for a person to confirm them (api.ts). body is the request's JSON, sealed with the
  // key-encryption key when the server has one, since an endpoint's key can be in it; it is cleared once the request ran.
  `CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', method TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
    checks TEXT NOT NULL, title TEXT NOT NULL, items TEXT NOT NULL, requested_by TEXT NOT NULL, requested_via TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    decided_by TEXT, decided_at INTEGER, result TEXT)`,
  // The answers a person graded when they accepted a task's eval, as version holds it: each answer's case, model, text and tool
  // calls, and their verdict. A run on that version has the judge grade them again, and says when it disagrees with the person.
  `CREATE TABLE IF NOT EXISTS eval_grades (task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, grades TEXT NOT NULL)`,
  // A task's own eval command, which a self-hosted server runs to measure it, as a person confirmed it (api.ts).
  `CREATE TABLE IF NOT EXISTS eval_commands (task_id TEXT PRIMARY KEY, spec TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at INTEGER NOT NULL)`,
  // GitHub repositories a project reads: each belongs to one project. sealed_token is a fine-grained token, encrypted; github_user the member whose GitHub sign-in reads it.
  `CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', full_name TEXT NOT NULL UNIQUE COLLATE NOCASE, private INTEGER NOT NULL, default_branch TEXT NOT NULL,
    sealed_token TEXT, token_last4 TEXT, github_user TEXT, added_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
    review_status TEXT NOT NULL, review_requested_at INTEGER NOT NULL, review_finished_at INTEGER, review_error TEXT, review TEXT)`,
  `CREATE TABLE IF NOT EXISTS repo_reviews (repo_id TEXT NOT NULL, requested_at INTEGER NOT NULL)`,
  // Tasks a repository review found, until a person approves (creating the task) or dismisses each.
  `CREATE TABLE IF NOT EXISTS eval_drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repo_id TEXT, environment TEXT NOT NULL, name TEXT NOT NULL, bundle TEXT NOT NULL,
    cases TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, task_id TEXT)`,
];

/** What a ledger row counts: settled at its cost, reserved at its reservation, released not at all. */
const COUNTED = `CASE status WHEN 'settled' THEN COALESCE(actual_usd, estimated_usd, reserved_usd) WHEN 'reserved' THEN reserved_usd ELSE 0 END`;
/** Whether task t's eval has a draft open, which pauses its runs and watch. */
const REVIEWING = `EXISTS (SELECT 1 FROM evals e WHERE e.task_id = t.id AND e.draft_reason IS NOT NULL)`;
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
 * when the coding agent retired it with openmerit_retire, or while its eval waits for review (review). A later
 * recommend call ends idle and retired; accepting the eval ends review.
 */
export type WatchState = "watching" | "idle" | "frozen" | "retired" | "review";
/** `watching` is `state === "watching"`, for clients that predate `state`. `idleSince` is set only while idle. */
export interface TaskRow { id: string; projectId: string; environment: string; agent: string | null; name: string; currentModel: string; pick: string | null; status: string; state: WatchState; idleSince: string | null; watching: boolean; lastRunAt: string | null; lastJobId: string | null; monthlySavingUsd: number | null }
/** What a finished job's report found, so a list of runs can say it without loading each report. */
export interface RunResult { status: string; task: string | null; model: string | null; from: string | null; savingPerCallUsd: number | null }
/** askedBy is the MCP client's name (clientInfo.name) for a run a coding agent started; null for a watch run or an unnamed client. */

export interface JobRow { id: string; projectId: string; taskId: string; kind: string; status: string; startedAt: string; finishedAt: string | null; askedBy: string | null; evalVersion: number | null; result: RunResult | null }

/** What about a task its eval was accepted for; a bundle that differs in one reopens the eval. */
export type TaskPart = "prompt" | "tools" | "output";
/**
 * A task's eval. accepted is what runs, unchanged, until someone accepts a draft; its version counts the
 * acceptances. draft is the eval under review, edited in place: reopened because the coding agent sent the
 * task with a different prompt, tools or output (task_changed, with what changed and the new output shape)
 * or by a person (revise). While a draft is open the task's runs and watch wait for it.
 * by is a Clerk user ID; /api adds byName, that person's name or email from Clerk, or null when Clerk does not know them.
 */
export interface EvalView {
  taskId: string;
  accepted: { version: number; spec: EvalSpec; cases: Case[]; source: EvalSource; by: string | null; byName?: string | null; at: string; runs: number; bar: EvalBar } | null;
  draft: { reason: "task_changed" | "revise"; changed: TaskPart[]; spec: EvalSpec; cases: Case[]; output: TaskBundle["output"] | null; by: string | null; byName?: string | null; at: string } | null;
}
/** JSON with object keys sorted, so the same value compares equal however the coding agent ordered it. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
/** The parts of a task its eval depends on. A tool's mockResult is test data, not the task. */
export const shapeOf = (bundle: TaskBundle): Record<TaskPart, string> => ({
  prompt: canonical(bundle.prompt), tools: canonical((bundle.tools ?? []).map(({ mockResult: _mock, ...tool }) => tool)), output: canonical(bundle.output),
});
const PARTS: TaskPart[] = ["prompt", "tools", "output"];
export interface GuardrailSetting { key: string; value: unknown; kind: "constraint" | "default" }
export type Started = { ok: true } | { ok: false; error: string };

/**
 * A critical request a coding agent made, which runs only once a person confirms it. checks is what the
 * person must show: `person`, a signed-in person, or `reverify`, one who verified their sign-in in the last
 * 10 minutes (hosted). result is the request's answer once it ran: `done` when it succeeded, `failed` when not.
 */
export type ConfirmationStatus = "pending" | "confirming" | "done" | "failed" | "declined" | "expired";
export interface ConfirmationView {
  id: string; projectId: string; method: string; path: string; checks: "person" | "reverify"; title: string; items: string[];
  requestedBy: string; requestedVia: string | null; status: ConfirmationStatus; createdAt: string; expiresAt: string; decidedBy: string | null; decidedAt: string | null;
  result: { status: number; body: unknown } | null;
}
/** How long a confirmation waits for a person. */
export const CONFIRM_HOURS = 24;

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const confirmationRow = (row: Row): ConfirmationView => ({
  id: String(row.id), projectId: String(row.project_id), method: String(row.method), path: String(row.path), checks: row.checks === "reverify" ? "reverify" : "person",
  title: String(row.title), items: JSON.parse(String(row.items)) as string[], requestedBy: String(row.requested_by), requestedVia: (row.requested_via as string | null) ?? null,
  status: row.status === "pending" && Number(row.expires_at) <= Date.now() ? "expired" : String(row.status) as ConfirmationStatus,
  createdAt: iso(row.created_at)!, expiresAt: iso(row.expires_at)!, decidedBy: (row.decided_by as string | null) ?? null, decidedAt: iso(row.decided_at),
  result: row.result ? JSON.parse(String(row.result)) as { status: number; body: unknown } : null,
});
const startOfMonth = (now: number) => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); };
const scopeKey = (level: Level, input: { environment: string; taskId?: string }) => level === "environment" ? input.environment : input.taskId ?? "";

/** A task's watch state. Retired wins over review, review over frozen, and frozen over idle: each says why the watch stopped, most deliberate first. */
export function watchState(input: { retired: boolean; review: boolean; watch: boolean | undefined; lastRecommendAt: number | null; now: number; idleAfterMs: number }): { state: WatchState; idleSince: string | null } {
  if (input.retired) return { state: "retired", idleSince: null };
  if (input.review) return { state: "review", idleSince: null };
  if (input.watch === false) return { state: "frozen", idleSince: null };
  const idleAt = input.lastRecommendAt === null ? null : input.lastRecommendAt + input.idleAfterMs;
  if (idleAt !== null && input.now >= idleAt) return { state: "idle", idleSince: new Date(idleAt).toISOString() };
  return { state: "watching", idleSince: null };
}

const taskRow = (row: Row, watch: boolean | undefined): TaskRow => {
  const { state, idleSince } = watchState({ retired: row.retired === 1, review: Boolean(row.eval_review), watch, lastRecommendAt: (row.last_recommend_at as number | null) ?? null, now: Date.now(), idleAfterMs: services().config.idleAfterMs });
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
    // An account stored before schema version 2 had projects and repository reviews. There were no customers yet, so its
    // tasks, runs, evals and settings are deleted rather than migrated. Its plan, members and ledger, which this month's caps count, stay.
    const [version] = await database.execute(`PRAGMA user_version`);
    if (Number(version?.user_version ?? 0) < SCHEMA_VERSION) {
      for (const table of RESET_TABLES) await database.execute(`DROP TABLE IF EXISTS ${table}`);
      await database.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    for (const statement of SCHEMA) await database.execute(statement);
    // Accounts stored before projects came back: everything they hold moves into the default project, and nothing is dropped.
    for (const table of PROJECT_TABLES) {
      const columns = await database.execute(`PRAGMA table_info(${table})`);
      if (!columns.some(column => column.name === "project_id")) await database.execute(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}'`);
    }
    // A guardrail's scope (an environment name or a task ID) is unique within its project only.
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
      const problem = projectNameProblem(input.name) ?? await nameTaken(c.db, input.name.trim(), null);
      if (problem) return { ok: false, error: problem };
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

    /** Deletes a project with its endpoints, repositories, drafts and guardrails. A project that still has tasks is refused: delete them first. */
    deleteProject: async (c, id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> => c.db.transaction(async tx => {
      if (id === DEFAULT_PROJECT) return { ok: false, status: 409, error: "The default project cannot be deleted. Rename it instead." };
      const [found] = await tx.execute(`SELECT id FROM projects WHERE id = ?`, id);
      if (!found) return { ok: false, status: 404, error: "No such project in this account." };
      const [tasks] = await tx.execute(`SELECT count(*) AS n FROM tasks WHERE project_id = ?`, id);
      if (Number(tasks?.n)) return { ok: false, status: 409, error: `This project has ${Number(tasks?.n)} task${Number(tasks?.n) === 1 ? "" : "s"}. Delete them first.` };
      for (const table of ["endpoints", "repos", "eval_drafts", "guardrails"]) await tx.execute(`DELETE FROM ${table} WHERE project_id = ?`, id);
      await tx.execute(`DELETE FROM projects WHERE id = ?`, id);
      return { ok: true as const };
    }, { name: "delete_project" }),

    /**
     * The project a coding agent's call that names none works in: the project whose GitHub repository the environment
     * names (owner/repo, ignoring case), else the project whose tasks already use it when exactly one does, else the default.
     */
    projectForEnvironment: async (c, environment: string): Promise<string> => {
      const [repo] = await c.db.execute(`SELECT project_id FROM repos WHERE full_name = ?`, environment);
      if (repo) return String(repo.project_id);
      const rows = await c.db.execute(`SELECT DISTINCT project_id FROM tasks WHERE environment = ?`, environment);
      return rows.length === 1 ? String(rows[0]!.project_id) : DEFAULT_PROJECT;
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
    startJob: async (c, input: { jobId: string; projectId: string; taskId: string; kind: "run" | "watch"; askedBy?: string | null }): Promise<Started> => c.db.transaction(async (tx): Promise<Started> => {
      const { limits, appUrl } = services().config;
      const current = await plan(tx);
      const unpaid = planRefusal(current);
      if (unpaid) return { ok: false, error: unpaid };
      if (current?.overage === "refuse" && current.usedEvals >= current.includedEvals) return { ok: false, error: `This month's ${current.includedEvals} evaluations are used. More start at ${current.periodEnd ? new Date(current.periodEnd * 1000).toISOString().slice(0, 10) : "the next period"}, or change the plan at ${appUrl}/plan/.` };
      const now = Date.now();
      const [hour] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE started_at > ?`, now - 3_600_000);
      if (Number(hour?.n) >= limits.jobsPerHour) return { ok: false, error: `This account started ${limits.jobsPerHour} jobs in the last hour, its limit. Try again later.` };
      const [running] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running')`);
      if (Number(running?.n) >= limits.concurrentJobs) return { ok: false, error: `This account has ${limits.concurrentJobs} jobs running, its limit. Try again when one finishes.` };
      await tx.execute(`INSERT INTO jobs (id, project_id, task_id, kind, status, started_at, asked_by) VALUES (?, ?, ?, ?, 'queued', ?, ?)`, input.jobId, input.projectId, input.taskId, input.kind, now, input.askedBy ?? null);
      return { ok: true };
    }, { name: "start_job" }).then(async started => { await meterOverage(c.db); return started; }),

    /**
     * Claims an openmerit_recommend idempotency key for a day. A key already claimed returns the job it
     * started, or null while that call is still starting it.
     */
    claimRecommendKey: async (c, key: string): Promise<{ claimed: true } | { claimed: false; jobId: string | null }> => c.db.transaction(async tx => {
      const now = Date.now();
      await tx.execute(`DELETE FROM recommend_keys WHERE created_at < ?`, now - 86_400_000);
      const [row] = await tx.execute(`SELECT job_id FROM recommend_keys WHERE key = ?`, key);
      if (row) return { claimed: false as const, jobId: (row.job_id as string | null) ?? null };
      await tx.execute(`INSERT INTO recommend_keys (key, job_id, created_at) VALUES (?, NULL, ?)`, key, now);
      return { claimed: true as const };
    }, { name: "claim_recommend_key" }),

    /** Records the job a claimed key started, or frees the key when the call started none. */
    settleRecommendKey: async (c, input: { key: string; jobId: string | null }): Promise<void> => {
      if (input.jobId) await c.db.execute(`UPDATE recommend_keys SET job_id = ? WHERE key = ?`, input.jobId, input.key);
      else await c.db.execute(`DELETE FROM recommend_keys WHERE key = ?`, input.key);
    },

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
      if (count) await meterOverage(c.db);
    },

    job: async (c, jobId: string): Promise<JobRow | null> => {
      const [row] = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.id = ? AND jobs.deleted_at IS NULL`, jobId);
      return row ? jobRow(row) : null;
    },

    /** Jobs not finished yet, which hold the account's concurrent jobs, with when each started. */
    unfinishedJobs: async (c): Promise<{ id: string; taskId: string; startedAt: number }[]> =>
      (await c.db.execute(`SELECT id, task_id, started_at FROM jobs WHERE status IN ('queued', 'running') AND deleted_at IS NULL`)).map(row => ({ id: String(row.id), taskId: String(row.task_id), startedAt: Number(row.started_at) })),

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
      // An estimate is kept at most at the reservation, the call's maximum possible cost.
      await tx.execute(`UPDATE ledger SET status = 'settled', actual_usd = ?, estimated_usd = MIN(?, reserved_usd), failed = ? WHERE key = ?`,
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

    endpoints: async (c, projectId: string = DEFAULT_PROJECT): Promise<EndpointView[]> => endpointViews(c.db, projectId),

    removeEndpoint: async (c, input: { projectId: string; id: string }): Promise<boolean> =>
      (await c.db.execute(`DELETE FROM endpoints WHERE id = ? AND project_id = ? RETURNING id`, input.id, input.projectId)).length > 0,

    // GitHub repositories. A token arrives only through /api/repos and is stored encrypted, as endpoint keys are.
    /** Checks that OpenMerit can read the repository, saves it in the project and starts its review. Adding one again replaces its token. */
    addRepo: async (c, input: { projectId: string; url: string; token?: string | null; githubUser?: string | null }): Promise<{ ok: true; repo: RepoView } | { ok: false; error: string }> => {
      const { config, fetch } = services();
      // Reviews are part of a paid plan: without one, nothing reaches GitHub, is cloned or is spent.
      const unpaid = planRefusal(await plan(c.db));
      if (unpaid) return { ok: false, error: unpaid };
      const ref = parseRepoUrl(typeof input.url === "string" ? input.url : "");
      if (!ref) return { ok: false, error: "Paste the repository's GitHub URL, such as https://github.com/acme/app." };
      const pasted = typeof input.token === "string" && input.token.trim() ? input.token.trim() : null;
      // Through a member's GitHub sign-in, OpenMerit reads it with that member's GitHub token, which Clerk renews; it stores no token.
      const githubUser = !pasted && input.githubUser ? input.githubUser : null;
      const signIn = githubUser ? await services().githubToken(githubUser).catch(() => null) : null;
      if (githubUser && !signIn) return { ok: false, error: "Your OpenMerit sign-in has no GitHub account. Connect GitHub on Account settings, or add the repository with a fine-grained token." };
      const token = pasted ?? signIn;
      if (pasted) {
        const problem = tokenProblem(pasted);
        if (problem) return { ok: false, error: problem };
        if (!config.keyEncryptionKey) return { ok: false, error: "Private repositories are not available yet: the app has no key-encryption key." };
      }
      if (!(await projectViews(c.db, input.projectId)).length) return { ok: false, error: "No such project in this account." };
      // A repository belongs to one project, so a coding agent's call from it finds its project.
      const [known] = await c.db.execute(`SELECT repos.id, repos.project_id, projects.name FROM repos LEFT JOIN projects ON projects.id = repos.project_id WHERE full_name = ?`, `${ref.owner}/${ref.name}`);
      if (known && known.project_id !== input.projectId) return { ok: false, error: `${ref.owner}/${ref.name} is already in the project ${String(known.name ?? known.project_id)}. Remove it there first.` };
      const [count] = await c.db.execute(`SELECT count(*) AS n FROM repos`);
      if (!known && Number(count?.n) >= config.limits.repos) return { ok: false, error: `This account has ${config.limits.repos} repositories, its limit. Remove one to add another.` };
      const busy = await reviewsRefusal(c.db);
      if (busy) return { ok: false, error: busy };
      const checked = await checkRepo(ref, token, config.github, fetch);
      if (!checked.ok) return { ok: false, error: githubUser ? checked.error.replace(/^This token cannot see (\S+)\. Check that its Repository access includes it\.$/, "The OpenMerit GitHub App cannot see $1 for you. Install it on the repository's account or organization and select the repository.") : checked.error };
      const { repo } = checked;
      const now = Date.now();
      const id = known ? String(known.id) : `repo_${randomBytes(6).toString("hex")}`;
      await c.db.execute(`INSERT INTO repos (id, project_id, full_name, private, default_branch, sealed_token, token_last4, github_user, added_at, checked_at, review_status, review_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        ON CONFLICT (id) DO UPDATE SET full_name = excluded.full_name, private = excluded.private, default_branch = excluded.default_branch, sealed_token = excluded.sealed_token,
        token_last4 = excluded.token_last4, github_user = excluded.github_user, checked_at = excluded.checked_at`,
      id, input.projectId, repo.fullName, repo.private ? 1 : 0, repo.defaultBranch, pasted ? encryptKey(config.keyEncryptionKey!, c.key[0]!, pasted) : null, pasted ? pasted.slice(-4) : null, githubUser, now, now, now);
      await startReview(c, id, () => c.client<Registry>().catalogue.getOrCreate(["global"]).get());
      return { ok: true, repo: (await repoViews(c.db, { id }))[0]! };
    },

    repos: async (c, projectId: string): Promise<RepoView[]> => repoViews(c.db, { projectId }),

    /** Reviews the repository again, unless a review is already queued or running. */
    reviewRepo: async (c, input: { projectId: string; id: string }): Promise<{ ok: true; repo: RepoView } | { ok: false; status: 402 | 404 | 409; error: string }> => {
      const [view] = await repoViews(c.db, input);
      if (!view) return { ok: false, status: 404, error: "No such repository in this project." };
      if (view.review.status === "queued" || view.review.status === "reviewing") return { ok: true, repo: view };
      const unpaid = planRefusal(await plan(c.db));
      if (unpaid) return { ok: false, status: 402, error: unpaid };
      const busy = await reviewsRefusal(c.db);
      if (busy) return { ok: false, status: 409, error: busy };
      await startReview(c, input.id, () => c.client<Registry>().catalogue.getOrCreate(["global"]).get());
      return { ok: true, repo: (await repoViews(c.db, { id: input.id }))[0]! };
    },

    /** Deletes the repository, its token, its review and its pending drafts. A review still running finishes without saving. */
    removeRepo: async (c, input: { projectId: string; id: string }): Promise<boolean> => {
      const removed = (await c.db.execute(`DELETE FROM repos WHERE id = ? AND project_id = ? RETURNING id`, input.id, input.projectId)).length > 0;
      if (removed) await c.db.execute(`DELETE FROM eval_drafts WHERE repo_id = ? AND status = 'pending'`, input.id);
      return removed;
    },

    // Drafts: tasks a repository review found, for a person to approve or dismiss.
    evalDrafts: async (c, input: { projectId?: string; status?: EvalDraft["status"] } = {}): Promise<EvalDraft[]> =>
      (await c.db.execute(`SELECT * FROM eval_drafts WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at`, input.projectId ?? null, input.projectId ?? null, input.status ?? null, input.status ?? null)).map(draftRow),

    /**
     * Approves a pending draft: the task joins the draft's project, not run yet, with the reviewed bundle, which the caller
     * gives the task actor. It has no accepted eval: its first run writes the cases from the bundle's examples and spec, and
     * the person grades them before any search, which accepts version 1.
     */
    approveDraft: async (c, input: { id: string; taskId: string; userId: string; bundle: TaskBundle }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT * FROM eval_drafts WHERE id = ?`, input.id);
      if (!row) return { ok: false, status: 404, error: "No such draft in this project." };
      if (row.status !== "pending") return { ok: false, status: 409, error: `This draft was already ${String(row.status)}.` };
      const [task] = await tx.execute(`SELECT id FROM tasks WHERE id = ?`, input.taskId);
      if (task) return { ok: false, status: 409, error: "This project already has a task by that name. Dismiss the draft, or revise the task's eval." };
      const now = Date.now();
      await tx.execute(`INSERT INTO tasks (id, project_id, environment, agent, name, current_model, pick, status, retired) VALUES (?, ?, ?, NULL, ?, ?, NULL, 'new', 0)`,
        input.taskId, String(row.project_id), String(row.environment), input.bundle.task, input.bundle.current.model);
      await tx.execute(`UPDATE eval_drafts SET status = 'approved', decided_by = ?, decided_at = ?, task_id = ? WHERE id = ?`, input.userId, now, input.taskId, input.id);
      return { ok: true };
    }, { name: "approve_draft" }),

    /** Dismisses a pending draft and forgets its content; the same task is not offered again. */
    dismissDraft: async (c, input: { projectId: string; id: string; userId: string }): Promise<boolean> =>
      (await c.db.execute(`UPDATE eval_drafts SET status = 'dismissed', decided_by = ?, decided_at = ?, bundle = '{}', cases = '[]' WHERE id = ? AND project_id = ? AND status = 'pending' RETURNING id`, input.userId, Date.now(), input.id, input.projectId)).length > 0,

    /** The endpoints a job in the project may call, without keys: OpenRouter on OpenMerit's key first, then the project's. */
    endpointsForJob: async (c, projectId: string = DEFAULT_PROJECT): Promise<EndpointInfo[]> => (await jobEndpoints(c.db, c.key[0]!, projectId, false)).map(({ apiKey: _key, ...info }) => info),

    /** The same endpoints with their keys, for the job's model client. Returned only to the job, held in its memory, never stored. */
    endpointSecrets: async (c, projectId: string = DEFAULT_PROJECT): Promise<EndpointConfig[]> => jobEndpoints(c.db, c.key[0]!, projectId, true),

    // Guardrails, per project and level: environment (its name) and task (its ID).
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
    resolveGuardrails: async (c, input: { projectId?: string; environment: string; agent?: string | null; taskId?: string }): Promise<ResolvedGuardrails> => {
      const levels: Partial<Record<Level, Guardrails>> = {};
      for (const level of LEVELS) {
        if (level === "task" && !input.taskId) continue;
        levels[level] = await levelSettings(c.db, input.projectId ?? DEFAULT_PROJECT, level, scopeKey(level, input));
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
      const rows = await c.db.execute(`SELECT t.*, ${REVIEWING} AS eval_review FROM tasks t WHERE ? IS NULL OR t.project_id = ? ORDER BY COALESCE(last_run_at, 0) DESC`, projectId ?? null, projectId ?? null);
      const watch = await watchGuardrails(c.db);
      return rows.map(row => taskRow(row, watch(row)));
    },

    task: async (c, id: string): Promise<TaskRow | null> => {
      const [row] = await c.db.execute(`SELECT t.*, ${REVIEWING} AS eval_review FROM tasks t WHERE id = ?`, id);
      return row ? taskRow(row, (await watchGuardrails(c.db))(row)) : null;
    },

    /**
     * Erases a task's rows: the task, its reports (so run pages and share links stop loading) and its
     * task-level guardrails. Its runs leave every listing, but each keeps a row without content, as
     * its ledger rows do, so the plan's evaluation count and the spend caps still include them.
     * Records who deleted which task, without its content.
     */
    deleteTask: async (c, input: { taskId: string; userId: string }): Promise<{ jobs: number }> => c.db.transaction(async tx => {
      const [task] = await tx.execute(`SELECT project_id, name, environment FROM tasks WHERE id = ?`, input.taskId);
      if (!task) return { jobs: 0 };
      const [jobs] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE task_id = ? AND deleted_at IS NULL`, input.taskId);
      const now = Date.now();
      await tx.execute(`UPDATE jobs SET deleted_at = ?, asked_by = NULL WHERE task_id = ? AND deleted_at IS NULL`, now, input.taskId);
      await tx.execute(`DELETE FROM reports WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM decisions WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM guardrails WHERE project_id = ? AND level = 'task' AND scope = ?`, String(task.project_id), input.taskId);
      await tx.execute(`DELETE FROM tasks WHERE id = ?`, input.taskId);
      // Its eval and eval command go with it.
      await tx.execute(`DELETE FROM evals WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM eval_grades WHERE task_id = ?`, input.taskId);
      await tx.execute(`DELETE FROM eval_commands WHERE task_id = ?`, input.taskId);
      await tx.execute(`UPDATE eval_drafts SET bundle = '{}', cases = '[]' WHERE task_id = ?`, input.taskId);
      await tx.execute(`INSERT INTO deletions (project_id, task_id, name, environment, user_id, jobs, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, String(task.project_id), input.taskId, String(task.name), String(task.environment), input.userId, Number(jobs?.n ?? 0), now);
      return { jobs: Number(jobs?.n ?? 0) };
    }, { name: "delete_task" }),

    /** Tasks deleted from one project, or the whole account: who, when, and the task's ID and name. */
    deletions: async (c, projectId?: string): Promise<{ taskId: string; name: string; environment: string; userId: string; jobs: number; deletedAt: string }[]> =>
      (await c.db.execute(`SELECT * FROM deletions WHERE ? IS NULL OR project_id = ? ORDER BY deleted_at DESC`, projectId ?? null, projectId ?? null)).map(row => ({ taskId: String(row.task_id), name: String(row.name), environment: String(row.environment), userId: String(row.user_id), jobs: Number(row.jobs), deletedAt: iso(row.deleted_at)! })),

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

    /** The task's eval command, which the job runs on a self-hosted server. */
    evalCommandFor: async (c, taskId: string): Promise<EvalCommandSpec | null> => {
      const [row] = await c.db.execute(`SELECT spec FROM eval_commands WHERE task_id = ?`, taskId);
      return row ? JSON.parse(String(row.spec)) as EvalCommandSpec : null;
    },
    /** Sets the task's eval command, as a person confirmed it, or clears it with null. */
    setEvalCommand: async (c, input: { taskId: string; spec: EvalCommandSpec | null; by: string }): Promise<void> => {
      if (!input.spec) await c.db.execute(`DELETE FROM eval_commands WHERE task_id = ?`, input.taskId);
      else await c.db.execute(`INSERT INTO eval_commands (task_id, spec, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET spec = excluded.spec, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`, input.taskId, JSON.stringify(input.spec), input.by, Date.now());
    },
    /** Creates a task's row before its first run, so a person can confirm its eval command first. */
    createTask: async (c, input: { taskId: string; projectId: string; environment: string; agent: string | null; name: string; currentModel: string }): Promise<void> => {
      await c.db.execute(`INSERT INTO tasks (id, project_id, environment, agent, name, current_model, pick, status, retired) VALUES (?, ?, ?, ?, ?, ?, NULL, 'new', 0) ON CONFLICT (id) DO NOTHING`, input.taskId, input.projectId, input.environment, input.agent, input.name, input.currentModel);
    },

    /** Saves a coding agent's critical request until a person confirms or declines it. */
    requestConfirmation: async (c, input: { projectId: string; method: string; path: string; body: string; checks: "person" | "reverify"; title: string; items: string[]; requestedBy: string; requestedVia: string | null }): Promise<ConfirmationView> => {
      const id = randomBytes(18).toString("base64url"), now = Date.now(), key = services().config.keyEncryptionKey;
      const body = key && input.body ? `sealed:${encryptKey(key, c.key[0]!, input.body)}` : input.body;
      await c.db.execute(`INSERT INTO confirmations (id, nonce, project_id, method, path, body, checks, title, items, requested_by, requested_via, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, randomBytes(18).toString("base64url"), input.projectId, input.method, input.path, body, input.checks, input.title, JSON.stringify(input.items), input.requestedBy, input.requestedVia, now, now + CONFIRM_HOURS * 3600_000);
      const [row] = await c.db.execute(`SELECT * FROM confirmations WHERE id = ?`, id);
      return confirmationRow(row!);
    },
    /** Confirmations still waiting for a person, oldest first. */
    pendingConfirmations: async (c): Promise<ConfirmationView[]> =>
      (await c.db.execute(`SELECT * FROM confirmations WHERE status = 'pending' AND expires_at > ? ORDER BY created_at`, Date.now())).map(confirmationRow),
    /** A confirmation, with the nonce the self-hosted confirm page's form sends back. */
    confirmation: async (c, id: string): Promise<(ConfirmationView & { nonce: string }) | null> => {
      const [row] = await c.db.execute(`SELECT * FROM confirmations WHERE id = ?`, id);
      return row ? { ...confirmationRow(row), nonce: String(row.nonce) } : null;
    },
    /** Moves a pending confirmation to confirming or declined, once; for a confirmation, returns the request to run, with its body unsealed. */
    decideConfirmation: async (c, input: { id: string; confirm: boolean; by: string }): Promise<{ ok: true; view: ConfirmationView; body: string } | { ok: false; view: ConfirmationView | null }> => {
      const [row] = await c.db.execute(`UPDATE confirmations SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING *`,
        input.confirm ? "confirming" : "declined", input.by, Date.now(), input.id, Date.now());
      if (!row) {
        const [found] = await c.db.execute(`SELECT * FROM confirmations WHERE id = ?`, input.id);
        return { ok: false, view: found ? confirmationRow(found) : null };
      }
      const sealed = String(row.body), key = services().config.keyEncryptionKey;
      return { ok: true, view: confirmationRow(row), body: sealed.startsWith("sealed:") && key ? decryptKey(key, c.key[0]!, sealed.slice(7)) : sealed };
    },
    /** Records a confirmed request's answer and forgets its body. */
    finishConfirmation: async (c, input: { id: string; result: { status: number; body: unknown } }): Promise<ConfirmationView> => {
      const [row] = await c.db.execute(`UPDATE confirmations SET status = ?, result = ?, body = '' WHERE id = ? RETURNING *`, input.result.status < 400 ? "done" : "failed", JSON.stringify(input.result), input.id);
      return confirmationRow(row!);
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

    // Evals. The server holds each task's accepted eval and any draft under review.
    eval: async (c, taskId: string): Promise<EvalView | null> => evalView(c.db, taskId),

    /** Each task's accepted eval version and whether a draft waits for review, for the coding agent's task list. */
    evalHeads: async (c): Promise<Record<string, { version: number; review: boolean }>> =>
      Object.fromEntries((await c.db.execute(`SELECT task_id, version, draft_reason FROM evals`))
        .map(row => [String(row.task_id), { version: Number(row.version), review: row.draft_reason !== null && row.draft_reason !== undefined }])),

    /** The accepted eval a job runs on, unchanged, and the bar it was accepted against; null before the task has one. */
    evalFor: async (c, taskId: string): Promise<{ version: number; spec: EvalSpec; cases: Case[]; bar: EvalBar } | null> => {
      const [row] = await c.db.execute(`SELECT version, spec, cases, bar FROM evals WHERE task_id = ?`, taskId);
      return row ? { version: Number(row.version), spec: JSON.parse(String(row.spec)) as EvalSpec, cases: JSON.parse(String(row.cases)) as Case[], bar: row.bar === "criteria" ? "criteria" : "current" } : null;
    },

    /**
     * Whether a job may start on this bundle. A task with no eval yet, or whose bundle has the prompt, tools and
     * output its eval was accepted for, may. A bundle that differs reopens the eval as a draft: the accepted spec
     * and cases with the bundle's new examples. A run a person starts (`run`) grades the changed task's draft with them,
     * as a first run grades a new eval (`reopened`); the watch waits until it is accepted. A draft someone opened to
     * revise holds every job until they accept or discard it. A bundle that changed again replaces the draft's.
     */
    evalGate: async (c, input: { taskId: string; bundle: TaskBundle; examples: Case[]; kind?: "run" | "watch" }): Promise<{ ok: true; reopened?: boolean } | { ok: false; error: string }> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT * FROM evals WHERE task_id = ?`, input.taskId);
      if (!row) return { ok: true };
      const accepted = JSON.parse(String(row.shape)) as Record<TaskPart, string>, sent = shapeOf(input.bundle);
      const changed = PARTS.filter(part => accepted[part] !== sent[part]);
      const url = `${services().config.appUrl}/tasks/?task=${encodeURIComponent(input.taskId)}&tab=eval`;
      const drafted = row.draft_bundle ? shapeOf(JSON.parse(String(row.draft_bundle)) as TaskBundle) : null;
      if (changed.length && (!drafted || PARTS.some(part => drafted[part] !== sent[part]))) {
        const base = JSON.parse(String(row.draft_cases ?? row.cases)) as Case[];
        const known = new Set(base.map(item => JSON.stringify(item.input))), ids = new Set(base.map(item => item.id));
        const added = input.examples.filter(item => !known.has(JSON.stringify(item.input))).map(item => ids.has(item.id) ? { ...item, id: `${item.id}-new` } : item);
        await tx.execute(`UPDATE evals SET draft_reason = 'task_changed', draft_changed = ?, draft_spec = COALESCE(draft_spec, spec), draft_cases = ?, draft_bundle = ?, draft_by = NULL, draft_at = ? WHERE task_id = ?`,
          JSON.stringify(changed), JSON.stringify([...base, ...added]), JSON.stringify(input.bundle), Date.now(), input.taskId);
        if (input.kind === "run") return { ok: true, reopened: true };
        return { ok: false, error: `The task changed since its eval was accepted (its ${changed.join(", ")}), so its eval may no longer fit. Tell the user to review the eval at ${url}: runs and the watch resume once they accept it.` };
      }
      if (row.draft_reason === "task_changed" && input.kind === "run") return { ok: true, reopened: true };
      if (row.draft_reason) return { ok: false, error: `This task's eval waits for review at ${url}${row.draft_reason === "task_changed" ? " because the task changed" : ""}. Tell the user: runs and the watch resume once they accept it.` };
      return { ok: true };
    }, { name: "eval_gate" }),

    /**
     * The eval a task's first run wrote, after its label check, accepted as version 1 for the bundle it ran.
     * A run whose answers a person graded accepts it once they agree with it, against the bar they graded to.
     * An eval accepted meanwhile stays; the version returned is the one the job ran on.
     */
    acceptFirstEval: async (c, input: { taskId: string; bundle: TaskBundle; spec: EvalSpec; cases: Case[]; source: EvalSource; by: string | null; bar?: EvalBar }): Promise<number> => {
      await c.db.execute(`INSERT INTO evals (task_id, version, spec, cases, shape, source, accepted_by, accepted_at, bar) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (task_id) DO NOTHING`,
        input.taskId, JSON.stringify(input.spec), JSON.stringify(input.cases), JSON.stringify(shapeOf(input.bundle)), input.source, input.by, Date.now(), input.bar === "criteria" ? "criteria" : null);
      const [row] = await c.db.execute(`SELECT version FROM evals WHERE task_id = ?`, input.taskId);
      return Number(row?.version ?? 1);
    },

    /** A changed task's draft, which a run a person started grades before any search; null when the task has none. */
    changedDraftFor: async (c, taskId: string): Promise<{ version: number; spec: EvalSpec; cases: Case[]; bar: EvalBar } | null> => {
      const [row] = await c.db.execute(`SELECT version, draft_spec, draft_cases, bar FROM evals WHERE task_id = ? AND draft_reason = 'task_changed'`, taskId);
      return row ? { version: Number(row.version), spec: JSON.parse(String(row.draft_spec)) as EvalSpec, cases: JSON.parse(String(row.draft_cases)) as Case[], bar: row.bar === "criteria" ? "criteria" : "current" } : null;
    },

    /**
     * Accepts a changed task's draft as the next version, as a run graded it: its spec and cases, the bar the person
     * graded to, and the changed bundle's shape. Returns the version the job ran on: the one a draft accepted
     * meanwhile, in the app, made, when it is gone.
     */
    acceptReopenedEval: async (c, input: { taskId: string; spec: EvalSpec; cases: Case[]; by: string | null; bar: EvalBar; source: EvalSource }): Promise<number> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT * FROM evals WHERE task_id = ?`, input.taskId);
      if (row?.draft_reason !== "task_changed") return Number(row?.version ?? 1);
      const bundle = JSON.parse(String(row.draft_bundle)) as TaskBundle;
      const version = Number(row.version) + 1;
      await tx.execute(`UPDATE evals SET version = ?, spec = ?, cases = ?, shape = ?, source = ?, accepted_by = ?, accepted_at = ?, bar = ?,
        draft_reason = NULL, draft_changed = NULL, draft_spec = NULL, draft_cases = NULL, draft_bundle = NULL, draft_by = NULL, draft_at = NULL WHERE task_id = ?`,
        version, JSON.stringify(input.spec), JSON.stringify(input.cases), JSON.stringify(shapeOf(bundle)), input.source, input.by, Date.now(), input.bar === "criteria" ? "criteria" : null, input.taskId);
      return version;
    }, { name: "accept_reopened_eval" }),

    /** Keeps the answers a person graded with the version they accepted, replacing any an earlier version kept. */
    saveEvalGrades: async (c, input: { taskId: string; version: number; grades: EvalGrade[] }): Promise<void> => {
      await c.db.execute(`INSERT INTO eval_grades (task_id, version, grades) VALUES (?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET version = excluded.version, grades = excluded.grades`, input.taskId, input.version, JSON.stringify(input.grades));
    },

    /** The graded answers kept with a version of the task's eval; null when that version kept none. */
    evalGrades: async (c, input: { taskId: string; version: number }): Promise<EvalGrade[] | null> => {
      const [row] = await c.db.execute(`SELECT grades FROM eval_grades WHERE task_id = ? AND version = ?`, input.taskId, input.version);
      return row ? JSON.parse(String(row.grades)) as EvalGrade[] : null;
    },

    /** Reopens an accepted eval for a person to revise. Runs and the watch wait until a draft is accepted or discarded. */
    reviseEval: async (c, input: { taskId: string; by: string }): Promise<boolean> =>
      (await c.db.execute(`UPDATE evals SET draft_reason = 'revise', draft_changed = '[]', draft_spec = spec, draft_cases = cases, draft_by = ?, draft_at = ? WHERE task_id = ? AND draft_reason IS NULL RETURNING task_id`, input.by, Date.now(), input.taskId)).length > 0,

    /**
     * Saves the draft in place; nothing keeps the earlier text. With base, the draft's time as the app loaded it,
     * a save someone made meanwhile refuses the change, so two people reviewing do not overwrite each other.
     */
    saveEvalDraft: async (c, input: { taskId: string; spec: EvalSpec; cases: Case[]; by: string; base?: string | null }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT draft_reason, draft_at FROM evals WHERE task_id = ?`, input.taskId);
      if (!row?.draft_reason) return { ok: false, status: 409, error: "This eval is accepted, not under review. Choose Revise eval to change it." };
      if (input.base && input.base !== iso(row.draft_at)) return { ok: false, status: 409, error: "Someone saved this draft while you edited it. Reload it and make your change again." };
      await tx.execute(`UPDATE evals SET draft_spec = ?, draft_cases = ?, draft_by = ?, draft_at = ? WHERE task_id = ?`, JSON.stringify(input.spec), JSON.stringify(input.cases), input.by, Date.now(), input.taskId);
      return { ok: true };
    }, { name: "save_eval_draft" }),

    /**
     * Accepts the draft, with the reviewer's last edits, as the next version: runs and the watch resume on it,
     * and returns the changed task's bundle, which the
     * caller gives the task actor, or null when only the eval changed.
     */
    acceptEval: async (c, input: { taskId: string; spec: EvalSpec; cases: Case[]; by: string; base?: string | null }): Promise<{ ok: true; version: number; bundle: TaskBundle | null } | { ok: false; status: 409; error: string }> => c.db.transaction(async tx => {
      const [row] = await tx.execute(`SELECT * FROM evals WHERE task_id = ?`, input.taskId);
      if (!row?.draft_reason) return { ok: false, status: 409, error: "This eval has no draft to accept." };
      if (input.base && input.base !== iso(row.draft_at)) return { ok: false, status: 409, error: "Someone saved this draft while you edited it. Reload it and make your change again." };
      const bundle = row.draft_bundle ? JSON.parse(String(row.draft_bundle)) as TaskBundle : null;
      const version = Number(row.version) + 1;
      await tx.execute(`UPDATE evals SET version = ?, spec = ?, cases = ?, shape = COALESCE(?, shape), source = 'app', accepted_by = ?, accepted_at = ?,
        draft_reason = NULL, draft_changed = NULL, draft_spec = NULL, draft_cases = NULL, draft_bundle = NULL, draft_by = NULL, draft_at = NULL WHERE task_id = ?`,
        version, JSON.stringify(input.spec), JSON.stringify(input.cases), bundle ? JSON.stringify(shapeOf(bundle)) : null, input.by, Date.now(), input.taskId);
      return { ok: true, version, bundle };
    }, { name: "accept_eval" }),

    /** Drops a draft a person opened, keeping the accepted eval. A changed task's draft stays: its accepted eval no longer fits. */
    discardEvalDraft: async (c, taskId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const [row] = await c.db.execute(`SELECT draft_reason FROM evals WHERE task_id = ?`, taskId);
      if (row?.draft_reason !== "revise") return { ok: false, error: row?.draft_reason ? "The task changed, so its accepted eval no longer fits: review and accept the draft." : "This eval has no draft." };
      await c.db.execute(`UPDATE evals SET draft_reason = NULL, draft_changed = NULL, draft_spec = NULL, draft_cases = NULL, draft_bundle = NULL, draft_by = NULL, draft_at = NULL WHERE task_id = ?`, taskId);
      return { ok: true };
    },

    /** The eval version a job runs on, recorded once it is known. */
    setJobEval: async (c, input: { jobId: string; version: number }): Promise<void> => {
      await c.db.execute(`UPDATE jobs SET eval_version = ? WHERE id = ?`, input.version, input.jobId);
    },

    /** Everything the account holds, except keys and repository tokens. */
    export: async (c): Promise<Record<string, unknown>> => {
      const all = async (table: string) => c.db.execute(`SELECT * FROM ${table}`);
      return {
        account: c.key[0], exportedAt: new Date().toISOString(), plan: await plan(c.db), members: await all("members"), projects: await projectViews(c.db),
        endpoints: (await all("endpoints")).map(row => ({ id: row.id, projectId: row.project_id, kind: row.kind, baseUrl: row.base_url, allowedModels: JSON.parse(String(row.allowed_models)) as unknown, keyLast4: row.key_last4 })),
        guardrails: (await all("guardrails")).map(row => ({ ...row, settings: JSON.parse(String(row.settings)) as unknown })), tasks: await (async () => { const watch = await watchGuardrails(c.db); return (await c.db.execute(`SELECT t.*, ${REVIEWING} AS eval_review FROM tasks t`)).map(row => taskRow(row, watch(row))); })(),
        decisions: (await all("decisions")).map(decisionRow), repos: await repoViews(c.db), evalDrafts: (await all("eval_drafts")).map(draftRow),
        evals: await Promise.all((await all("evals")).map(async row => evalView(c.db, String(row.task_id)))),
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
  return {
    name: String(row.name ?? "OpenMerit"), status: String(row.status ?? "incomplete"), periodStart: (row.period_start as number | null) ?? null, periodEnd: (row.period_end as number | null) ?? null,
    includedEvals: Number(row.included_evals ?? 0), usedEvals: Number(used?.n ?? 0), overage: row.overage === "metered" ? "metered" : "refuse", customerId: (row.customer_id as string | null) ?? null,
  };
}

/**
 * Why the account cannot start paid work, or null: on the hosted server, every evaluation needs a plan that Stripe says is active or trialing. There is no free hosted plan; a self-hosted
 * server needs no plan, and its spend caps still apply.
 */
function planRefusal(current: Plan | null): string | null {
  if (services().config.mode === "self-hosted" || (current && ACTIVE_PLAN.has(current.status))) return null;
  return `This account has no active OpenMerit plan${current ? ` (Stripe says ${current.status})` : ""}. Subscribe at ${services().config.appUrl}/plan/, then try again.`;
}

/** The start of the billing period in milliseconds: Stripe's, else the calendar month. */
async function periodStart(database: Database): Promise<number> {
  const [row] = await database.execute(`SELECT period_start FROM plan WHERE id = 1`);
  return typeof row?.period_start === "number" ? row.period_start * 1000 : startOfMonth(Date.now());
}

/**
 * Reports this period's evaluations beyond the plan that Stripe has not recorded yet, newest first.
 * It runs whenever a job starts or counts, so a report that failed (Stripe down, a timeout) is sent
 * with the account's next job instead of being lost. Stripe counts each job's identifier once, so a
 * report sent twice bills once. A failure is logged, never thrown: billing must not fail a job.
 */
async function meterOverage(database: Database): Promise<void> {
  try {
    const current = await plan(database);
    const billing = services().billing;
    if (!current?.customerId || current.overage !== "metered" || !billing) return;
    const start = await periodStart(database);
    const [done] = await database.execute(`SELECT count(*) AS n FROM jobs WHERE counted > 0 AND metered = 1 AND finished_at >= ?`, start);
    const owed = current.usedEvals - current.includedEvals - Number(done?.n ?? 0);
    if (owed <= 0) return;
    const pending = await database.execute(`SELECT id FROM jobs WHERE counted > 0 AND metered = 0 AND finished_at >= ? ORDER BY finished_at DESC LIMIT ?`, start, owed);
    for (const job of pending) {
      await billing.reportUsage({ customerId: current.customerId, identifier: String(job.id), quantity: 1 });
      await database.execute(`UPDATE jobs SET metered = 1 WHERE id = ?`, job.id);
    }
  } catch (error) {
    console.error(`Metering overage failed; the account's next job retries it: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function levelSettings(database: Database, projectId: string, level: Level, scope: string): Promise<Guardrails> {
  const [row] = await database.execute(`SELECT settings FROM guardrails WHERE project_id = ? AND level = ? AND scope = ?`, projectId, level, scope);
  return row ? JSON.parse(String(row.settings)) as Guardrails : {};
}

/** Each task's effective `watch` guardrail, from one read of every level's settings. */
async function watchGuardrails(database: Database): Promise<(row: Row) => boolean | undefined> {
  const settings = new Map((await database.execute(`SELECT project_id, level, scope, settings FROM guardrails`)).map(item => [`${String(item.project_id)}\0${String(item.level)}\0${String(item.scope)}`, JSON.parse(String(item.settings)) as Guardrails]));
  return row => {
    const input = { environment: String(row.environment), taskId: String(row.id) };
    const levels: Partial<Record<Level, Guardrails>> = {};
    for (const level of LEVELS) levels[level] = settings.get(`${String(row.project_id)}\0${level}\0${scopeKey(level, input)}`) ?? {};
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

async function endpointViews(database: Database, projectId: string): Promise<EndpointView[]> {
  const rows = await database.execute(`SELECT id, kind, base_url, allowed_models, key_last4, verified_at FROM endpoints WHERE project_id = ? ORDER BY created_at`, projectId);
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

/** Ledger keys, and job IDs, of repository reviews: `review/<repo id>/<requested at>`. A review is OpenMerit-paid spend, not one of the plan's evaluations. */
const REVIEW_LEDGER = "review/";

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
 * Queues a review and runs it after the action returns: the clone and review take longer than an action may.
 * The request time tells this review's result from a later one's: a review whose repository was added again or
 * removed meanwhile saves nothing. Each task spec it writes becomes a draft for a person to approve.
 */
async function startReview(c: { db: Transactional; key: readonly string[]; keepAwake: <T>(promise: Promise<T>) => Promise<T> }, id: string, catalogue: () => Promise<Catalogue>): Promise<void> {
  const requestedAt = Date.now();
  await c.db.execute(`UPDATE repos SET review_status = 'queued', review_requested_at = ? WHERE id = ?`, requestedAt, id);
  await c.db.execute(`DELETE FROM repo_reviews WHERE requested_at < ?`, requestedAt - 3_600_000);
  await c.db.execute(`INSERT INTO repo_reviews (repo_id, requested_at) VALUES (?, ?)`, id, requestedAt);
  const current = `id = ? AND review_requested_at = ?`;
  const run = async () => {
    const [row] = await c.db.execute(`SELECT full_name, default_branch, sealed_token, github_user FROM repos WHERE ${current}`, id, requestedAt);
    if (!row) return;
    await c.db.execute(`UPDATE repos SET review_status = 'reviewing' WHERE ${current}`, id, requestedAt);
    const { config } = services();
    const { limits, models, openrouter } = config;
    // The review's model calls are reserved against the monthly OpenMerit-paid cap before the clone, and settled at what they cost.
    const key = `${REVIEW_LEDGER}${id}/${requestedAt}`;
    const reviewer = openrouter.apiKey ? { model: models.reviewer, apiKey: openrouter.apiKey, baseUrl: openrouter.baseUrl, budgetUsd: limits.reviewBudgetUsd, timeoutMs: limits.reviewMinutes * 60_000 } : null;
    let reserved = false;
    try {
      let token: string | null = null;
      if (row.sealed_token) {
        try { token = decryptKey(config.keyEncryptionKey!, c.key[0]!, String(row.sealed_token)); } catch { throw new Error("OpenMerit can no longer read this repository's token. Add the repository again with its token."); }
      } else if (row.github_user) {
        // The adding member's GitHub token, fresh from Clerk: it lasts 8 hours and Clerk renews it.
        token = await services().githubToken(String(row.github_user)).catch(() => null);
        if (!token) throw new Error("The member who added this repository through GitHub sign-in no longer has GitHub connected on OpenMerit. Add it again with your GitHub sign-in, or with a fine-grained token.");
      }
      if (reviewer) {
        const refused = await reserveReview(c.db, key, reviewer.model, reviewer.budgetUsd);
        if (refused) throw new Error(refused);
        reserved = true;
      }
      const review = await reviewRepository({ fullName: String(row.full_name), branch: String(row.default_branch), token, config: config.github, catalogue: await catalogue(), reviewer });
      if (reserved) await c.db.execute(`UPDATE ledger SET status = 'settled', actual_usd = ? WHERE key = ? AND status = 'reserved'`, review.costUsd, key);
      const saved = await c.db.execute(`UPDATE repos SET review_status = 'done', review_finished_at = ?, review_error = NULL, review = ? WHERE ${current} RETURNING project_id`, Date.now(), JSON.stringify(review), id, requestedAt);
      // Each task spec becomes a draft; its examples are the cases a person sees before approving it.
      const drafts = review.tasks.map(bundle => ({ bundle, cases: casesOf(bundle) }));
      if (saved[0] && drafts.length) await addDrafts(c.db, { projectId: String(saved[0].project_id), repoId: id, environment: String(row.full_name), drafts });
    } catch (error) {
      // Only the clone or the scan throws, before any model call: nothing was spent.
      if (reserved) await c.db.execute(`UPDATE ledger SET status = 'released' WHERE key = ? AND status = 'reserved'`, key);
      await c.db.execute(`UPDATE repos SET review_status = 'failed', review_finished_at = ?, review_error = ? WHERE ${current}`, Date.now(), error instanceof Error ? error.message : "The review failed.", id, requestedAt);
    }
  };
  void c.keepAwake(run()).catch(() => undefined);
}

/** A spec's examples as the draft's cases. */
const casesOf = (bundle: TaskBundle): Case[] => (bundle.examples ?? []).map((example, index): Case => ({ id: `example-${index + 1}`, input: example.input, ...(example.expected === undefined ? {} : { expected: example.expected }), origin: "example", ...(example.toolResults ? { toolResults: example.toolResults } : {}) }));

async function repoViews(database: Database, input: { id?: string; projectId?: string } = {}): Promise<RepoView[]> {
  const rows = await database.execute(`SELECT * FROM repos WHERE (? IS NULL OR id = ?) AND (? IS NULL OR project_id = ?) ORDER BY added_at`, input.id ?? null, input.id ?? null, input.projectId ?? null, input.projectId ?? null);
  const stale = Date.now() - reviewStaleMs();
  return rows.map(row => {
    const active = row.review_status === "queued" || row.review_status === "reviewing";
    const stopped = active && Number(row.review_requested_at) < stale;
    return {
      id: String(row.id), projectId: String(row.project_id), fullName: String(row.full_name), url: `https://github.com/${String(row.full_name)}`, private: row.private === 1, defaultBranch: String(row.default_branch),
      tokenLast4: (row.token_last4 as string | null) ?? null, addedAt: iso(row.added_at)!, checkedAt: iso(row.checked_at)!,
      access: row.sealed_token ? "token" : row.github_user ? "github" : "public", githubUser: (row.github_user as string | null) ?? null,
      review: {
        status: stopped ? "failed" : row.review_status as RepoView["review"]["status"], requestedAt: iso(row.review_requested_at)!, finishedAt: iso(row.review_finished_at),
        error: stopped ? "The review stopped before it finished. Review the repository again." : (row.review_error as string | null) ?? null,
        result: typeof row.review === "string" ? JSON.parse(row.review) as RepoReview : null,
      },
    };
  });
}

function draftRow(row: Row): EvalDraft {
  return {
    id: String(row.id), projectId: String(row.project_id), repoId: (row.repo_id as string | null) ?? null, environment: String(row.environment), name: String(row.name),
    bundle: JSON.parse(String(row.bundle)) as TaskBundle, cases: JSON.parse(String(row.cases)) as Case[], status: row.status as EvalDraft["status"], createdAt: iso(row.created_at)!, taskId: (row.task_id as string | null) ?? null,
  };
}

/** Adds a review's drafts. A new review replaces the pending draft of the same task; a task the project has, or a draft someone decided, is not offered again. */
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

async function evalView(database: Database, taskId: string): Promise<EvalView | null> {
  const [task] = await database.execute(`SELECT id FROM tasks WHERE id = ?`, taskId);
  if (!task) return null;
  const [row] = await database.execute(`SELECT e.*, (SELECT count(*) FROM jobs j WHERE j.task_id = e.task_id AND j.eval_version = e.version AND j.deleted_at IS NULL) AS runs FROM evals e WHERE task_id = ?`, taskId);
  const draftBundle = row?.draft_bundle ? JSON.parse(String(row.draft_bundle)) as TaskBundle : null;
  return {
    taskId,
    accepted: row ? { version: Number(row.version), spec: JSON.parse(String(row.spec)) as EvalSpec, cases: JSON.parse(String(row.cases)) as Case[], source: row.source as EvalSource, by: (row.accepted_by as string | null) ?? null, at: iso(row.accepted_at)!, runs: Number(row.runs), bar: row.bar === "criteria" ? "criteria" : "current" } : null,
    draft: row?.draft_reason ? {
      reason: row.draft_reason as "task_changed" | "revise", changed: JSON.parse(String(row.draft_changed ?? "[]")) as TaskPart[], spec: JSON.parse(String(row.draft_spec)) as EvalSpec, cases: JSON.parse(String(row.draft_cases)) as Case[],
      output: draftBundle?.output ?? null, by: (row.draft_by as string | null) ?? null, at: iso(row.draft_at)!,
    } : null,
  };
}
