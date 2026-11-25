// Local run history in SQLite (~/.openmerit/state.db), shared by the CLI and the MCP server and
// scoped by repository. It records runs, progress, eval units, paid usage and budget approvals,
// rankings and configuration decisions; never keys or raw dataset contents.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import type { Ledger } from "../engine/ledger.ts";
import { openmeritHome, type Repo } from "./paths.ts";

// node:sqlite prints an ExperimentalWarning on Node 22; keep it off the terminal (and MCP clients).
const sqlite = await (async () => {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", warning => { if (warning.name !== "ExperimentalWarning") for (const listener of listeners) listener(warning); });
  return import("node:sqlite");
})();

export type RunStatus = "running" | "needs_input" | "budget_paused" | "interrupted" | "failed" | "done" | "cancelled";
export type UnitStatus = "pending" | "running" | "done" | "failed" | "unavailable" | "budget_paused" | "interrupted";

export interface RunRow {
  id: string;
  repoId: string;
  repoRoot: string;
  revision: string | null;
  status: RunStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  packageVersion: string;
  catalogueVersion: string;
  harness: string;
  budgetUsd: number;
  state: Record<string, unknown>;
  error: string | null;
  lockPid: number | null;
}

export interface UnitRow {
  id: string;
  runId: string;
  task: string;
  model: string;
  endpoint: string;
  /** baseline: the current model on every item; screen: a candidate on the sampled items; final: a candidate on every item. */
  role: "baseline" | "screen" | "final";
  repeat: number;
  status: UnitStatus;
  attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface Spend {
  /** Settled requests: provider-reported cost, or list-price estimates where the provider reports none. */
  settledUsd: number;
  /** Part of settledUsd that is a list-price estimate. */
  estimatedUsd: number;
  /** Reserved for requests still in flight (or cut off by an interruption): cost unknown, counted at the reservation. */
  inFlightUsd: number;
  inFlight: number;
  /** Requests with no price at all, counted at their reservation. */
  unknown: number;
  requests: number;
  totalUsd: number;
}

const MIGRATIONS = [
  `CREATE TABLE repos (id TEXT PRIMARY KEY, root TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), revision TEXT, status TEXT NOT NULL, phase TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, package_version TEXT NOT NULL, catalogue_version TEXT NOT NULL, harness TEXT NOT NULL,
     budget_usd REAL NOT NULL, state_json TEXT NOT NULL, error TEXT, lock_pid INTEGER);
   CREATE INDEX runs_repo ON runs(repo_id, created_at);
   CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
   CREATE TABLE eval_units (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
     role TEXT NOT NULL, repeat INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT, updated_at TEXT NOT NULL);
   CREATE TABLE usage (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), unit_id TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
     status TEXT NOT NULL, reserved_usd REAL NOT NULL, estimated_usd REAL, actual_usd REAL, latency_ms INTEGER, created_at TEXT NOT NULL, settled_at TEXT);
   CREATE INDEX usage_run ON usage(run_id);
   CREATE TABLE budget_events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL,
     from_usd REAL, to_usd REAL, scope TEXT, spent_usd REAL);
   CREATE TABLE decisions (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL, decision TEXT NOT NULL, detail_json TEXT NOT NULL);`,
];

const now = () => new Date().toISOString();

function alive(pid: number | null) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class State {
  readonly db: Database;
  readonly path: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const home = openmeritHome(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.path = join(home, "state.db");
    this.db = new sqlite.DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  /** Applies schema upgrades in order; older history stays readable. */
  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const version = row ? Number(row.value) : 0;
      for (let index = version; index < MIGRATIONS.length; index++) this.db.exec(MIGRATIONS[index]!);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Math.max(version, MIGRATIONS.length)));
    });
  }

  get schemaVersion() { return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value); }

  /** BEGIN IMMEDIATE: one writer at a time across CLI and MCP processes. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { this.db.close(); }

  createRun(input: { id: string; repo: Repo; packageVersion: string; catalogueVersion: string; harness: string; budgetUsd: number; state: Record<string, unknown> }): RunRow {
    const at = now();
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO repos (id, root, created_at) VALUES (?, ?, ?)").run(input.repo.id, input.repo.root, at);
      this.db.prepare(`INSERT INTO runs (id, repo_id, revision, status, phase, created_at, updated_at, package_version, catalogue_version, harness, budget_usd, state_json, lock_pid)
        VALUES (?, ?, ?, 'running', 'scan', ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(input.id, input.repo.id, input.repo.revision ? `${input.repo.revision}${input.repo.dirty ? "+dirty" : ""}` : null, at, at, input.packageVersion, input.catalogueVersion, input.harness, input.budgetUsd, JSON.stringify(input.state));
    });
    this.event(input.id, "start", `Run started (openmerit ${input.packageVersion}, catalogue ${input.catalogueVersion}, harness ${input.harness}, budget $${input.budgetUsd.toFixed(2)})`);
    return this.getRun(input.id)!;
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare("SELECT runs.*, repos.root FROM runs JOIN repos ON repos.id = runs.repo_id WHERE runs.id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toRun(row) : null;
  }

  listRuns(repoId: string, limit = 50): RunRow[] {
    return (this.db.prepare("SELECT runs.*, repos.root FROM runs JOIN repos ON repos.id = runs.repo_id WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?").all(repoId, limit) as Record<string, unknown>[]).map(row => this.toRun(row));
  }

  private toRun(row: Record<string, unknown>): RunRow {
    return {
      id: row.id as string, repoId: row.repo_id as string, repoRoot: row.root as string, revision: row.revision as string | null, status: row.status as RunStatus, phase: row.phase as string,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string, packageVersion: row.package_version as string, catalogueVersion: row.catalogue_version as string,
      harness: row.harness as string, budgetUsd: row.budget_usd as number, state: JSON.parse(row.state_json as string) as Record<string, unknown>, error: row.error as string | null, lockPid: row.lock_pid as number | null,
    };
  }

  updateRun(id: string, patch: { status?: RunStatus; phase?: string; state?: Record<string, unknown>; error?: string | null; budgetUsd?: number; harness?: string }) {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [now()];
    if (patch.status) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.phase) { sets.push("phase = ?"); values.push(patch.phase); }
    if (patch.state) { sets.push("state_json = ?"); values.push(JSON.stringify(patch.state)); }
    if (patch.error !== undefined) { sets.push("error = ?"); values.push(patch.error); }
    if (patch.budgetUsd !== undefined) { sets.push("budget_usd = ?"); values.push(patch.budgetUsd); }
    if (patch.harness) { sets.push("harness = ?"); values.push(patch.harness); }
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Takes the run for this process. Fails while another live process works on it. */
  lock(id: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT lock_pid FROM runs WHERE id = ?").get(id) as { lock_pid: number | null } | undefined;
      if (!row) throw new Error(`No run ${id}`);
      if (row.lock_pid && row.lock_pid !== process.pid && alive(row.lock_pid)) return false;
      this.db.prepare("UPDATE runs SET lock_pid = ? WHERE id = ?").run(process.pid, id);
      return true;
    });
  }

  unlock(id: string) { this.db.prepare("UPDATE runs SET lock_pid = NULL WHERE id = ? AND lock_pid = ?").run(id, process.pid); }

  /**
   * Runs whose process died mid-work become `interrupted`: running units are interrupted, and
   * reservations of requests that never settled stay counted as in-flight spend of unknown cost.
   */
  reapInterrupted(repoId: string): string[] {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id, lock_pid FROM runs WHERE repo_id = ? AND status = 'running' AND lock_pid IS NOT NULL").all(repoId) as { id: string; lock_pid: number }[];
      const reaped = rows.filter(row => !alive(row.lock_pid)).map(row => row.id);
      for (const id of reaped) this.interrupted(id, "The process stopped before the run finished; completed work and spend are kept.");
      return reaped;
    });
  }

  /** Marks a run interrupted (Ctrl-C, or a dead process). Unsettled reservations stay counted as in-flight spend. */
  markInterrupted(runId: string, message = "Interrupted; completed work and spend are kept.") { this.transaction(() => this.interrupted(runId, message)); }

  private interrupted(id: string, message: string) {
    this.db.prepare("UPDATE runs SET status = 'interrupted', lock_pid = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    this.db.prepare("UPDATE eval_units SET status = 'interrupted', updated_at = ? WHERE run_id = ? AND status = 'running'").run(now(), id);
    this.db.prepare("UPDATE usage SET status = 'interrupted' WHERE run_id = ? AND status = 'reserved'").run(id);
    this.db.prepare("INSERT INTO events (run_id, at, kind, message) VALUES (?, ?, 'interrupted', ?)").run(id, now(), message);
  }

  event(runId: string, kind: string, message: string) {
    this.db.prepare("INSERT INTO events (run_id, at, kind, message) VALUES (?, ?, ?, ?)").run(runId, now(), kind, message);
  }

  events(runId: string): { at: string; kind: string; message: string }[] {
    return this.db.prepare("SELECT at, kind, message FROM events WHERE run_id = ? ORDER BY id").all(runId) as { at: string; kind: string; message: string }[];
  }

  ensureUnit(unit: Omit<UnitRow, "status" | "attempts" | "result" | "error">): UnitRow {
    this.db.prepare("INSERT OR IGNORE INTO eval_units (id, run_id, task, model, endpoint, role, repeat, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(unit.id, unit.runId, unit.task, unit.model, unit.endpoint, unit.role, unit.repeat, now());
    return this.units(unit.runId).find(item => item.id === unit.id)!;
  }

  units(runId: string): UnitRow[] {
    return (this.db.prepare("SELECT * FROM eval_units WHERE run_id = ? ORDER BY rowid").all(runId) as Record<string, unknown>[]).map(row => ({
      id: row.id as string, runId: row.run_id as string, task: row.task as string, model: row.model as string, endpoint: row.endpoint as string, role: row.role as UnitRow["role"],
      repeat: row.repeat as number, status: row.status as UnitStatus, attempts: row.attempts as number,
      result: row.result_json ? JSON.parse(row.result_json as string) as Record<string, unknown> : null, error: row.error as string | null,
    }));
  }

  setUnit(id: string, patch: { status: UnitStatus; result?: Record<string, unknown> | null; error?: string | null; attempt?: boolean }) {
    this.db.prepare(`UPDATE eval_units SET status = ?, result_json = COALESCE(?, result_json), error = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .run(patch.status, patch.result ? JSON.stringify(patch.result) : null, patch.error ?? null, patch.attempt ? 1 : 0, now(), id);
  }

  spend(runId: string, unitId?: string): Spend {
    const rows = this.db.prepare(`SELECT status, reserved_usd, estimated_usd, actual_usd FROM usage WHERE run_id = ?${unitId ? " AND unit_id = ?" : ""}`).all(...(unitId ? [runId, unitId] : [runId])) as { status: string; reserved_usd: number; estimated_usd: number | null; actual_usd: number | null }[];
    const spend: Spend = { settledUsd: 0, estimatedUsd: 0, inFlightUsd: 0, inFlight: 0, unknown: 0, requests: rows.length, totalUsd: 0 };
    for (const row of rows) {
      if (row.status === "reserved" || row.status === "interrupted") { spend.inFlightUsd += row.reserved_usd; spend.inFlight++; continue; }
      if (row.actual_usd !== null) spend.settledUsd += row.actual_usd;
      else if (row.estimated_usd !== null) { spend.settledUsd += row.estimated_usd; spend.estimatedUsd += row.estimated_usd; }
      else { spend.settledUsd += row.reserved_usd; spend.unknown++; }
    }
    spend.totalUsd = spend.settledUsd + spend.inFlightUsd;
    return spend;
  }

  /**
   * Reserves a paid request's expected cost against the run budget, atomically across processes.
   * Refused when settled plus reserved spend plus this request would pass the run's budget.
   */
  reserve(input: { runId: string; unitId: string; model: string; endpoint: string; expectedUsd: number }): { ok: true; id: number } | { ok: false; spend: Spend; budgetUsd: number } {
    return this.transaction(() => {
      const budgetUsd = (this.db.prepare("SELECT budget_usd FROM runs WHERE id = ?").get(input.runId) as { budget_usd: number }).budget_usd;
      const spend = this.spend(input.runId);
      if (spend.totalUsd + input.expectedUsd > budgetUsd + 1e-9) return { ok: false as const, spend, budgetUsd };
      const result = this.db.prepare("INSERT INTO usage (run_id, unit_id, model, endpoint, status, reserved_usd, created_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)")
        .run(input.runId, input.unitId, input.model, input.endpoint, input.expectedUsd, now());
      return { ok: true as const, id: Number(result.lastInsertRowid) };
    });
  }

  /**
   * Records what a reserved request cost: provider-reported (`actualUsd`), list-price estimate, or unknown (both null).
   * An estimate is kept at most at the reservation, the request's maximum possible cost.
   */
  settle(id: number, cost: { actualUsd: number | null; estimatedUsd: number | null; latencyMs: number; failed?: boolean }) {
    this.db.prepare("UPDATE usage SET status = ?, actual_usd = ?, estimated_usd = MIN(?, reserved_usd), latency_ms = ?, settled_at = ? WHERE id = ?")
      .run(cost.failed ? "failed" : "settled", cost.actualUsd, cost.estimatedUsd, cost.latencyMs, now(), id);
  }

  /** Drops a reservation whose request was never sent. */
  release(id: number) { this.db.prepare("DELETE FROM usage WHERE id = ? AND status = 'reserved'").run(id); }

  /**
   * The run's spend as a `Ledger`, recording requests under one eval unit. Every request is
   * customer-paid: the CLI calls only the user's own endpoints. Keys are remembered by this ledger
   * object, which lives as long as the unit's proxy token.
   */
  ledger(scope: { runId: string; unitId: string }): Ledger {
    const rows = new Map<string, { id: number; open: boolean }>(), released = new Set<string>();
    return {
      reserve: async input => {
        if (input.funding !== "customer") throw new Error("The local CLI records only customer-paid requests");
        if (rows.has(input.key)) return { ok: true };
        const reservation = this.reserve({ ...scope, model: input.model ?? "", endpoint: input.endpoint ?? "", expectedUsd: input.usd });
        if (!reservation.ok) return { ok: false, reason: `$${reservation.spend.totalUsd.toFixed(4)} used or reserved of $${reservation.budgetUsd.toFixed(2)}`, neededUsd: input.usd };
        rows.set(input.key, { id: reservation.id, open: true });
        released.delete(input.key);
        return { ok: true };
      },
      settle: async (key, cost) => {
        const row = rows.get(key);
        if (!row) { if (released.has(key)) return; throw new Error(`No reservation ${key} to settle`); }
        if (!row.open) return;
        row.open = false;
        this.settle(row.id, { ...cost, latencyMs: cost.latencyMs ?? 0 });
      },
      release: async key => {
        const row = rows.get(key);
        if (!row?.open) return;
        rows.delete(key);
        released.add(key);
        this.release(row.id);
      },
      spent: async () => ({ openmeritUsd: 0, customerUsd: this.spend(scope.runId).totalUsd }),
    };
  }

  usage(runId: string, unitId: string): { requests: number; latencyMs: number; actualUsd: number; estimatedUsd: number; unknown: number } {
    const rows = this.db.prepare("SELECT status, actual_usd, estimated_usd, latency_ms FROM usage WHERE run_id = ? AND unit_id = ?").all(runId, unitId) as { status: string; actual_usd: number | null; estimated_usd: number | null; latency_ms: number | null }[];
    const settled = rows.filter(row => row.status === "settled");
    return {
      requests: settled.length, latencyMs: settled.reduce((sum, row) => sum + (row.latency_ms ?? 0), 0),
      actualUsd: settled.reduce((sum, row) => sum + (row.actual_usd ?? 0), 0),
      estimatedUsd: settled.reduce((sum, row) => sum + (row.actual_usd === null ? row.estimated_usd ?? 0 : 0), 0),
      unknown: settled.filter(row => row.actual_usd === null && row.estimated_usd === null).length,
    };
  }

  budgetEvent(runId: string, event: { kind: "alert" | "raise" | "decline"; fromUsd: number; toUsd?: number; scope?: "run" | "default"; spentUsd: number }) {
    this.db.prepare("INSERT INTO budget_events (run_id, at, kind, from_usd, to_usd, scope, spent_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, now(), event.kind, event.fromUsd, event.toUsd ?? null, event.scope ?? null, event.spentUsd);
  }

  budgetEvents(runId: string) {
    return this.db.prepare("SELECT at, kind, from_usd AS fromUsd, to_usd AS toUsd, scope, spent_usd AS spentUsd FROM budget_events WHERE run_id = ? ORDER BY id").all(runId) as { at: string; kind: string; fromUsd: number; toUsd: number | null; scope: string | null; spentUsd: number }[];
  }

  decision(runId: string, kind: string, decision: string, detail: unknown) {
    this.db.prepare("INSERT INTO decisions (run_id, at, kind, decision, detail_json) VALUES (?, ?, ?, ?, ?)").run(runId, now(), kind, decision, JSON.stringify(detail));
  }

  decisions(runId: string) {
    return (this.db.prepare("SELECT at, kind, decision, detail_json FROM decisions WHERE run_id = ? ORDER BY id").all(runId) as { at: string; kind: string; decision: string; detail_json: string }[])
      .map(row => ({ at: row.at, kind: row.kind, decision: row.decision, detail: JSON.parse(row.detail_json) as unknown }));
  }
}
