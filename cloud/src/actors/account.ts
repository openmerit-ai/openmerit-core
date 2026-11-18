// The account actor, one per Clerk organization: its plan from Stripe, members, endpoints with
// encrypted keys, guardrails at each level, the spend ledger, and the index of tasks, jobs and
// reports. SQLite holds all of it, so the ledger's checks and writes run in one transaction.
import { randomBytes } from "node:crypto";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import type { PlanUpdate } from "../billing.ts";
import { GUARDRAIL_KINDS, LEVELS, resolveGuardrails, settledUsd, type Funding, type GuardrailKey, type Guardrails, type Level, type ReserveResult, type ResolvedGuardrails, type Settlement } from "../engine.ts";
import { decryptKey, encryptKey, endpointUrlProblem } from "../keys.ts";
import { OPENROUTER, type EndpointInfo } from "../pool.ts";
import type { EndpointConfig, EndpointKind } from "../../../openmerit-core/src/ranking/index.ts";
import { services } from "../services.ts";

type Row = Record<string, unknown>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, mcp_revoked_before INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plan (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, status TEXT, customer_id TEXT, subscription_id TEXT,
    period_start INTEGER, period_end INTEGER, included_evals INTEGER NOT NULL DEFAULT 0, overage TEXT NOT NULL DEFAULT 'refuse', event_created INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, last_session_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, kind TEXT NOT NULL, base_url TEXT NOT NULL, allowed_models TEXT NOT NULL,
    sealed_key TEXT NOT NULL, key_last4 TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS guardrails (level TEXT NOT NULL, scope TEXT NOT NULL, settings TEXT NOT NULL, PRIMARY KEY (level, scope))`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER, budget_usd REAL, cap_openmerit_usd REAL, cap_customer_usd REAL, counted INTEGER NOT NULL DEFAULT 0, metered INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ledger (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, funding TEXT NOT NULL, model TEXT, endpoint TEXT, status TEXT NOT NULL,
    reserved_usd REAL NOT NULL, actual_usd REAL, estimated_usd REAL, failed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, environment TEXT NOT NULL, agent TEXT, name TEXT NOT NULL, current_model TEXT NOT NULL,
    pick TEXT, status TEXT NOT NULL, watching INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, last_job_id TEXT, monthly_saving_usd REAL)`,
  `CREATE TABLE IF NOT EXISTS reports (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, markdown TEXT NOT NULL, share_token TEXT UNIQUE)`,
];

/** What a ledger row counts: settled at its cost, reserved at its reservation, released not at all. */
const COUNTED = `CASE status WHEN 'settled' THEN COALESCE(actual_usd, estimated_usd, reserved_usd) WHEN 'reserved' THEN reserved_usd ELSE 0 END`;
const FINAL = new Set(["done", "failed", "stopped"]);
const ACTIVE_PLAN = new Set(["active", "trialing"]);

export interface Plan { name: string; status: string; periodStart: number | null; periodEnd: number | null; includedEvals: number; usedEvals: number; overage: "metered" | "refuse"; customerId: string | null }
export interface EndpointView { id: string; kind: EndpointKind; baseUrl: string; allowedModels: string[] | "all"; keyLast4: string; verifiedAt: string | null; builtIn: boolean }
export interface TaskRow { id: string; environment: string; agent: string | null; name: string; currentModel: string; pick: string | null; status: string; watching: boolean; lastRunAt: string | null; lastJobId: string | null; monthlySavingUsd: number | null }
/** What a finished job's report found, so a list of runs can say it without loading each report. */
export interface RunResult { status: string; model: string | null; from: string | null; savingPerCallUsd: number | null }
export interface JobRow { id: string; taskId: string; kind: string; status: string; startedAt: string; finishedAt: string | null; result: RunResult | null }
export interface GuardrailSetting { key: string; value: unknown; kind: "constraint" | "default" }
export type Started = { ok: true } | { ok: false; error: string };

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const startOfMonth = (now: number) => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); };
const scopeKey = (level: Level, input: { environment: string; agent?: string | null; taskId?: string }) =>
  level === "environment" ? input.environment : level === "agent" ? `${input.environment}:${input.agent ?? ""}` : input.taskId ?? "";

const taskRow = (row: Row): TaskRow => ({
  id: String(row.id), environment: String(row.environment), agent: (row.agent as string | null) ?? null, name: String(row.name), currentModel: String(row.current_model),
  pick: (row.pick as string | null) ?? null, status: String(row.status), watching: row.watching === 1, lastRunAt: iso(row.last_run_at), lastJobId: (row.last_job_id as string | null) ?? null,
  monthlySavingUsd: (row.monthly_saving_usd as number | null) ?? null,
});
function runResult(json: unknown): RunResult | null {
  if (typeof json !== "string") return null;
  const report = JSON.parse(json) as { status?: unknown; pick?: { model?: unknown; savingPerCallUsd?: unknown } | null; baseline?: { model?: unknown } | null };
  if (typeof report.status !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { status: report.status, model: text(report.pick?.model), from: text(report.baseline?.model), savingPerCallUsd: typeof report.pick?.savingPerCallUsd === "number" ? report.pick.savingPerCallUsd : null };
}
const jobRow = (row: Row): JobRow => ({
  id: String(row.id), taskId: String(row.task_id), kind: String(row.kind), status: String(row.status), startedAt: iso(row.started_at)!, finishedAt: iso(row.finished_at),
  result: runResult(row.report_json),
});

export const account = actor({
  db: db({ onMigrate: async database => { for (const statement of SCHEMA) await database.execute(statement); } }),
  actions: {
    /** Records the calling member and the account's name. */
    touch: async (c, input: { userId: string; role: "admin" | "member"; name: string | null }): Promise<void> => {
      await c.db.execute(`INSERT INTO members (user_id, role) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role`, input.userId, input.role);
      await c.db.execute(`INSERT INTO account (id, name) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, account.name)`, input.name);
    },

    info: async (c): Promise<{ id: string; name: string | null; plan: Plan | null; mcpRevokedBefore: number | null }> => {
      const [row] = await c.db.execute(`SELECT name, mcp_revoked_before FROM account WHERE id = 1`);
      return { id: c.key[0]!, name: (row?.name as string | null) ?? null, plan: await plan(c.db), mcpRevokedBefore: (row?.mcp_revoked_before as number | null) ?? null };
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
    startJob: async (c, input: { jobId: string; taskId: string; kind: "run" | "watch" }): Promise<Started> => c.db.transaction(async tx => {
      const { limits, appUrl } = services().config;
      const current = await plan(tx);
      if (!current || !ACTIVE_PLAN.has(current.status)) return { ok: false, error: `This account has no active OpenMerit plan${current ? ` (Stripe says ${current.status})` : ""}. Subscribe at ${appUrl}/plan/, then try again.` };
      if (current.overage === "refuse" && current.usedEvals >= current.includedEvals) return { ok: false, error: `This month's ${current.includedEvals} evaluations are used. More start at ${current.periodEnd ? new Date(current.periodEnd * 1000).toISOString().slice(0, 10) : "the next period"}, or change the plan at ${appUrl}/plan/.` };
      const now = Date.now();
      const [hour] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE started_at > ?`, now - 3_600_000);
      if (Number(hour?.n) >= limits.jobsPerHour) return { ok: false, error: `This account started ${limits.jobsPerHour} jobs in the last hour, its limit. Try again later.` };
      const [running] = await tx.execute(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running')`);
      if (Number(running?.n) >= limits.concurrentJobs) return { ok: false, error: `This account has ${limits.concurrentJobs} jobs running, its limit. Try again when one finishes.` };
      await tx.execute(`INSERT INTO jobs (id, task_id, kind, status, started_at) VALUES (?, ?, ?, 'queued', ?)`, input.jobId, input.taskId, input.kind, now);
      return { ok: true };
    }, { name: "start_job" }),

    /** A job's status and, once it knows them, its spend limits. Its first final status counts one evaluation. */
    jobUpdate: async (c, input: { jobId: string; status: string; budgetUsd?: number; capOpenmeritUsd?: number | null; capCustomerUsd?: number | null; measured?: boolean }): Promise<void> => {
      const count = await c.db.transaction(async tx => {
        const [job] = await tx.execute(`SELECT status, counted FROM jobs WHERE id = ?`, input.jobId);
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
      const [row] = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.id = ?`, jobId);
      return row ? jobRow(row) : null;
    },

    jobs: async (c, input: { taskId?: string; limit?: number } = {}): Promise<JobRow[]> => {
      const rows = input.taskId
        ? await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.task_id = ? ORDER BY jobs.started_at DESC LIMIT ?`, input.taskId, input.limit ?? 50)
        : await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id ORDER BY jobs.started_at DESC LIMIT ?`, input.limit ?? 50);
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
      if (jobUsed + input.usd > budget + 1e-9) return refuse(jobUsed, budget, "budget for this job");
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

    // Endpoints. Keys arrive only through /api/endpoints and are stored encrypted with the app's key.
    addEndpoint: async (c, input: { kind: EndpointKind; baseUrl: string; apiKey: string; allowedModels: string[] | "all" }): Promise<{ ok: true; endpoint: EndpointView } | { ok: false; error: string }> => {
      const { keyEncryptionKey, allowPrivateEndpoints } = services().config;
      if (!keyEncryptionKey) return { ok: false, error: "Customer endpoints are not available yet: the app has no key-encryption key." };
      if (!["openrouter", "openai-compatible", "anthropic"].includes(input.kind)) return { ok: false, error: "kind must be openrouter, openai-compatible or anthropic" };
      const problem = endpointUrlProblem(input.baseUrl, allowPrivateEndpoints);
      if (problem) return { ok: false, error: problem };
      if (typeof input.apiKey !== "string" || input.apiKey.trim().length < 8) return { ok: false, error: "apiKey is missing" };
      const models = input.allowedModels === "all" ? "all" : Array.isArray(input.allowedModels) ? input.allowedModels.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : null;
      if (!models || (models !== "all" && !models.length)) return { ok: false, error: "allowedModels must be \"all\" or a list of model IDs" };
      if (models === "all" && input.kind !== "openrouter") return { ok: false, error: "List the models this endpoint may run: only an OpenRouter endpoint can allow all" };
      const id = `ep_${randomBytes(6).toString("hex")}`;
      const key = input.apiKey.trim();
      await c.db.execute(`INSERT INTO endpoints (id, kind, base_url, allowed_models, sealed_key, key_last4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, input.kind, input.baseUrl.replace(/\/$/, ""), JSON.stringify(models), encryptKey(keyEncryptionKey, c.key[0]!, key), key.slice(-4), Date.now());
      return { ok: true, endpoint: (await endpointViews(c.db)).find(item => item.id === id)! };
    },

    endpoints: async (c): Promise<EndpointView[]> => endpointViews(c.db),

    removeEndpoint: async (c, id: string): Promise<boolean> => {
      const before = await c.db.execute(`SELECT id FROM endpoints WHERE id = ?`, id);
      await c.db.execute(`DELETE FROM endpoints WHERE id = ?`, id);
      return before.length > 0;
    },

    /** The endpoints a job may call, without keys: OpenRouter on OpenMerit's key first, then the customer's. */
    endpointsForJob: async (c): Promise<EndpointInfo[]> => (await jobEndpoints(c.db, c.key[0]!, false)).map(({ apiKey: _key, ...info }) => info),

    /** The same endpoints with their keys, for the job's model client. Returned only to the job, held in its memory, never stored. */
    endpointSecrets: async (c): Promise<EndpointConfig[]> => jobEndpoints(c.db, c.key[0]!, true),

    // Guardrails, per level: environment (a name), agent (`environment:agent`; environment names hold no colon) and task (task ID).
    setGuardrails: async (c, input: { level: Level; scope: string; settings: Guardrails }): Promise<{ rejected: { key: string; reason: string }[] }> => {
      const rejected = Object.keys(input.settings).filter(key => !Object.hasOwn(GUARDRAIL_KINDS, key)).map(key => ({ key, reason: "not a guardrail" }));
      const kept = Object.fromEntries(Object.entries(input.settings).filter(([key, value]) => Object.hasOwn(GUARDRAIL_KINDS, key) && value !== null && value !== undefined));
      await c.db.execute(`INSERT INTO guardrails (level, scope, settings) VALUES (?, ?, ?) ON CONFLICT (level, scope) DO UPDATE SET settings = excluded.settings`, input.level, input.scope, JSON.stringify(kept));
      return { rejected };
    },

    guardrails: async (c, input: { level: Level; scope: string }): Promise<GuardrailSetting[]> => {
      const settings = await levelSettings(c.db, input.level, input.scope);
      return Object.entries(settings).map(([key, value]) => ({ key, value, kind: GUARDRAIL_KINDS[key as GuardrailKey] }));
    },

    /** A task's effective guardrails, which level set each, and the settings refused. */
    resolveGuardrails: async (c, input: { environment: string; agent?: string | null; taskId?: string }): Promise<ResolvedGuardrails> => {
      const levels: Partial<Record<Level, Guardrails>> = {};
      for (const level of LEVELS) {
        if (level === "agent" && !input.agent) continue;
        if (level === "task" && !input.taskId) continue;
        levels[level] = await levelSettings(c.db, level, scopeKey(level, input));
      }
      return resolveGuardrails(levels);
    },

    // The task index, which the task actors keep current.
    upsertTask: async (c, row: Omit<TaskRow, "lastRunAt" | "watching" | "monthlySavingUsd" | "lastJobId"> & { lastRunAt?: number; lastJobId?: string; watching?: boolean; monthlySavingUsd?: number | null }): Promise<void> => {
      await c.db.execute(`INSERT INTO tasks (id, environment, agent, name, current_model, pick, status, watching, last_run_at, last_job_id, monthly_saving_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?) ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, current_model = excluded.current_model,
        pick = COALESCE(excluded.pick, tasks.pick), status = excluded.status, watching = COALESCE(?, tasks.watching), last_run_at = COALESCE(excluded.last_run_at, tasks.last_run_at),
        last_job_id = COALESCE(excluded.last_job_id, tasks.last_job_id), monthly_saving_usd = COALESCE(excluded.monthly_saving_usd, tasks.monthly_saving_usd)`,
      row.id, row.environment, row.agent, row.name, row.currentModel, row.pick, row.status, row.watching === undefined ? null : row.watching ? 1 : 0,
      row.lastRunAt ?? null, row.lastJobId ?? null, row.monthlySavingUsd ?? null, row.watching === undefined ? null : row.watching ? 1 : 0);
    },

    tasks: async (c): Promise<TaskRow[]> => (await c.db.execute(`SELECT * FROM tasks ORDER BY COALESCE(last_run_at, 0) DESC`)).map(taskRow),

    task: async (c, id: string): Promise<TaskRow | null> => {
      const [row] = await c.db.execute(`SELECT * FROM tasks WHERE id = ?`, id);
      return row ? taskRow(row) : null;
    },

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
      const rows = await c.db.execute(`SELECT jobs.*, reports.json AS report_json FROM jobs LEFT JOIN reports ON reports.job_id = jobs.id WHERE jobs.finished_at > ? ORDER BY jobs.finished_at DESC LIMIT 20`, since);
      await c.db.execute(`UPDATE members SET last_session_at = ? WHERE user_id = ?`, Date.now(), userId);
      return rows.map(jobRow);
    },

    /** Refuses MCP access tokens issued before now. */
    disconnect: async (c): Promise<void> => {
      await c.db.execute(`INSERT INTO account (id, mcp_revoked_before) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET mcp_revoked_before = excluded.mcp_revoked_before`, Math.floor(Date.now() / 1000));
    },

    /** Everything the account holds, except keys. */
    export: async (c): Promise<Record<string, unknown>> => {
      const all = async (table: string) => c.db.execute(`SELECT * FROM ${table}`);
      return {
        account: c.key[0], exportedAt: new Date().toISOString(), plan: await plan(c.db), members: await all("members"), endpoints: await endpointViews(c.db),
        guardrails: (await all("guardrails")).map(row => ({ ...row, settings: JSON.parse(String(row.settings)) as unknown })), tasks: (await all("tasks")).map(taskRow),
        jobs: (await all("jobs")).map(jobRow), ledger: await all("ledger"), reports: (await all("reports")).map(row => ({ jobId: row.job_id, taskId: row.task_id, report: JSON.parse(String(row.json)) as unknown })),
      };
    },

    /** Destroys this actor and its storage. The caller destroys the account's task and job actors first. */
    destroy: (c): void => { c.destroy(); },
  },
});

type Database = { execute: <T extends Row = Row>(query: string, ...args: unknown[]) => Promise<T[]> };

async function plan(database: Database): Promise<Plan | null> {
  const [row] = await database.execute(`SELECT * FROM plan WHERE id = 1`);
  if (!row) return null;
  const start = typeof row.period_start === "number" ? row.period_start * 1000 : startOfMonth(Date.now());
  const [used] = await database.execute(`SELECT count(*) AS n FROM jobs WHERE counted = 1 AND finished_at >= ?`, start);
  return {
    name: String(row.name ?? "OpenMerit"), status: String(row.status ?? "incomplete"), periodStart: (row.period_start as number | null) ?? null, periodEnd: (row.period_end as number | null) ?? null,
    includedEvals: Number(row.included_evals ?? 0), usedEvals: Number(used?.n ?? 0), overage: row.overage === "metered" ? "metered" : "refuse", customerId: (row.customer_id as string | null) ?? null,
  };
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

async function levelSettings(database: Database, level: Level, scope: string): Promise<Guardrails> {
  const [row] = await database.execute(`SELECT settings FROM guardrails WHERE level = ? AND scope = ?`, level, scope);
  return row ? JSON.parse(String(row.settings)) as Guardrails : {};
}

async function endpointViews(database: Database): Promise<EndpointView[]> {
  const rows = await database.execute(`SELECT id, kind, base_url, allowed_models, key_last4, verified_at FROM endpoints ORDER BY created_at`);
  return rows.map(row => ({ id: String(row.id), kind: row.kind as EndpointKind, baseUrl: String(row.base_url), allowedModels: JSON.parse(String(row.allowed_models)) as string[] | "all", keyLast4: String(row.key_last4), verifiedAt: iso(row.verified_at), builtIn: false }));
}

async function jobEndpoints(database: Database, accountId: string, withKeys: boolean): Promise<(EndpointConfig & EndpointInfo)[]> {
  const { openrouter, keyEncryptionKey } = services().config;
  const out: (EndpointConfig & EndpointInfo)[] = [];
  if (openrouter.apiKey) out.push({ id: OPENROUTER, kind: "openrouter", baseUrl: openrouter.baseUrl, allowedModels: "all", funding: "openmerit", apiKey: withKeys ? openrouter.apiKey : "" });
  const rows = await database.execute(`SELECT id, kind, base_url, allowed_models, sealed_key FROM endpoints ORDER BY created_at`);
  for (const row of rows) {
    // An endpoint whose key no longer decrypts, such as after a key rotation, is left out rather than failing the job.
    let apiKey = "";
    if (withKeys) { try { apiKey = decryptKey(keyEncryptionKey!, accountId, String(row.sealed_key)); } catch { continue; } }
    out.push({ id: String(row.id), kind: row.kind as EndpointKind, baseUrl: String(row.base_url), allowedModels: JSON.parse(String(row.allowed_models)) as string[] | "all", funding: "customer", apiKey });
  }
  return out;
}
