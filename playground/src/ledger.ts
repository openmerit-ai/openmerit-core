// Sahra Health's system of record: a SQLite-backed Durable Object named "sahra", plus one per scenario run.
// Every state change of a claim goes through here, and payment is refused unless a human approval
// is recorded first.

import { DurableObject } from "cloudflare:workers";
import type { Accumulators } from "./domain/adjudicate.ts";
import type { Triage } from "./triage.ts";
import { findActivity } from "./domain/codes.ts";
import type {
  AdjudicationLine,
  Approval,
  ClaimState,
  Clinician,
  CodingFinding,
  EnrollmentApplication,
  Extraction,
  Fils,
  FraudSignal,
  Member,
  Provider,
  SubmittedClaim,
} from "./domain/types.ts";

export interface ClaimRecord {
  id: string;
  memberId: string | null;
  providerId: string;
  state: ClaimState;
  receivedAt: string;
  runId: string | null;
  claim: SubmittedClaim;
  xml: string;
  bill: string;
  extraction: Extraction | null;
  coding: { findings: CodingFinding[]; summary: string } | null;
  adjudication: { lines: AdjudicationLine[]; totals: { gross: Fils; patientShare: Fils; payment: Fils }; summary: string } | null;
  fraud: { signals: FraudSignal[]; score: number; recommendation: "pay" | "review" | "hold"; summary: string } | null;
  /** Shadow-mode triage by a decision model, recorded before the agents run. */
  triage: Triage | null;
  approval: Approval | null;
  payment: { amount: Fils; reference: string; at: string } | null;
  error: string | null;
}

export interface EnrollmentRecord {
  application: EnrollmentApplication;
  decision: "enrolled" | "declined" | "pending";
  memberId: string | null;
  reason: string;
  runId?: string | null;
}

export interface SeedData {
  members: Member[];
  providers: Provider[];
  clinicians: Clinician[];
  /** Earlier claims, already paid, that history-dependent fixtures rely on. */
  paidClaims: { claim: SubmittedClaim; lines: AdjudicationLine[]; receivedAt: string }[];
}

/**
 * The ledger a case lives in. Each scenario run gets its own ledger, named by its run ID, so runs can
 * go in parallel without sharing members, claims or history. Everything else uses "sahra".
 */
export const ledgerName = (runId?: string | null): string => runId || "sahra";

type Row = Record<string, SqlStorageValue>;

const JSON_COLUMNS = ["claim", "extraction", "coding", "adjudication", "fraud", "approval", "payment", "triage"] as const;

function parse<T>(value: SqlStorageValue | undefined): T | null {
  return typeof value === "string" ? (JSON.parse(value) as T) : null;
}

export class Ledger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, emirates_id TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clinicians (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, member_id TEXT, provider_id TEXT NOT NULL, state TEXT NOT NULL,
        received_at TEXT NOT NULL, run_id TEXT, xml TEXT NOT NULL, bill TEXT NOT NULL,
        claim TEXT NOT NULL, extraction TEXT, coding TEXT, adjudication TEXT, fraud TEXT,
        approval TEXT, payment TEXT, error TEXT, triage TEXT
      );
    `);
    // Ledgers created before triage get its column.
    if (!ctx.storage.sql.exec<Row>("SELECT name FROM pragma_table_info('claims') WHERE name = 'triage'").toArray().length) ctx.storage.sql.exec("ALTER TABLE claims ADD COLUMN triage TEXT");
  }

  reset(): void {
    for (const table of ["members", "providers", "clinicians", "enrollments", "claims"]) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
  }

  seed(data: SeedData): void {
    const sql = this.ctx.storage.sql;
    for (const member of data.members) sql.exec("INSERT OR REPLACE INTO members VALUES (?, ?, ?)", member.id, member.emiratesId, JSON.stringify(member));
    for (const provider of data.providers) sql.exec("INSERT OR REPLACE INTO providers VALUES (?, ?)", provider.id, JSON.stringify(provider));
    for (const clinician of data.clinicians) sql.exec("INSERT OR REPLACE INTO clinicians VALUES (?, ?)", clinician.id, JSON.stringify(clinician));
    for (const paid of data.paidClaims) {
      const payment = paid.lines.reduce((sum, line) => sum + line.paymentAmount, 0);
      const totals = {
        gross: paid.lines.reduce((sum, line) => sum + line.gross, 0),
        patientShare: paid.lines.reduce((sum, line) => sum + line.patientShare, 0),
        payment,
      };
      sql.exec(
        `INSERT OR REPLACE INTO claims (id, member_id, provider_id, state, received_at, run_id, xml, bill, claim, adjudication, payment)
         VALUES (?, ?, ?, 'paid', ?, NULL, '', '', ?, ?, ?)`,
        paid.claim.id,
        paid.claim.memberId ?? null,
        paid.claim.providerId,
        paid.receivedAt,
        JSON.stringify(paid.claim),
        JSON.stringify({ lines: paid.lines, totals, summary: "Seeded history" }),
        JSON.stringify({ amount: payment, reference: `SEED-${paid.claim.id}`, at: paid.receivedAt }),
      );
    }
  }

  // Members and enrollment

  getMember(id: string): Member | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT json FROM members WHERE id = ?", id).toArray()[0];
    return row ? parse<Member>(row.json) : null;
  }

  findMemberByEmiratesId(emiratesId: string): Member | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT json FROM members WHERE emirates_id = ?", emiratesId).toArray()[0];
    return row ? parse<Member>(row.json) : null;
  }

  createMember(member: Member): Member {
    if (this.findMemberByEmiratesId(member.emiratesId)) throw new Error(`A member with Emirates ID ${member.emiratesId} already exists`);
    this.ctx.storage.sql.exec("INSERT INTO members VALUES (?, ?, ?)", member.id, member.emiratesId, JSON.stringify(member));
    return member;
  }

  saveEnrollment(record: EnrollmentRecord): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO enrollments VALUES (?, ?)", record.application.applicationId, JSON.stringify(record));
  }

  getEnrollment(applicationId: string): EnrollmentRecord | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT json FROM enrollments WHERE id = ?", applicationId).toArray()[0];
    return row ? parse<EnrollmentRecord>(row.json) : null;
  }

  getProvider(id: string): Provider | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT json FROM providers WHERE id = ?", id).toArray()[0];
    return row ? parse<Provider>(row.json) : null;
  }

  getClinicians(ids: string[]): Clinician[] {
    return ids.flatMap((id) => {
      const row = this.ctx.storage.sql.exec<Row>("SELECT json FROM clinicians WHERE id = ?", id).toArray()[0];
      const clinician = row ? parse<Clinician>(row.json) : null;
      return clinician ? [clinician] : [];
    });
  }

  // Claims

  receiveClaim(input: { claim: SubmittedClaim; xml: string; bill: string; runId?: string }): ClaimRecord {
    const { claim } = input;
    if (this.getClaim(claim.id)) throw new Error(`Claim ${claim.id} was already received`);
    const member = claim.memberId ? this.getMember(claim.memberId) : this.findMemberByEmiratesId(claim.emiratesIdNumber);
    this.ctx.storage.sql.exec(
      `INSERT INTO claims (id, member_id, provider_id, state, received_at, run_id, xml, bill, claim) VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?)`,
      claim.id,
      member?.id ?? null,
      claim.providerId,
      new Date().toISOString(),
      input.runId ?? null,
      input.xml,
      input.bill,
      JSON.stringify(claim),
    );
    const record = this.getClaim(claim.id);
    if (!record) throw new Error(`Claim ${claim.id} was not stored`);
    return record;
  }

  getClaim(id: string): ClaimRecord | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM claims WHERE id = ?", id).toArray()[0];
    return row ? this.toRecord(row) : null;
  }

  listClaims(runId?: string): ClaimRecord[] {
    const rows = runId
      ? this.ctx.storage.sql.exec<Row>("SELECT * FROM claims WHERE run_id = ? ORDER BY received_at", runId).toArray()
      : this.ctx.storage.sql.exec<Row>("SELECT * FROM claims ORDER BY received_at").toArray();
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: Row): ClaimRecord {
    const record: Record<string, unknown> = {
      id: row.id,
      memberId: row.member_id,
      providerId: row.provider_id,
      state: row.state,
      receivedAt: row.received_at,
      runId: row.run_id,
      xml: row.xml,
      bill: row.bill,
      error: row.error,
    };
    for (const column of JSON_COLUMNS) record[column] = parse(row[column]);
    return record as unknown as ClaimRecord;
  }

  private update(id: string, expected: ClaimState[], next: ClaimState, column: (typeof JSON_COLUMNS)[number] | null, value: unknown): ClaimRecord {
    const current = this.getClaim(id);
    if (!current) throw new Error(`Unknown claim ${id}`);
    if (!expected.includes(current.state)) throw new Error(`Claim ${id} is ${current.state}; expected ${expected.join(" or ")}`);
    if (column) this.ctx.storage.sql.exec(`UPDATE claims SET ${column} = ?, state = ? WHERE id = ?`, JSON.stringify(value), next, id);
    else this.ctx.storage.sql.exec("UPDATE claims SET state = ? WHERE id = ?", next, id);
    const updated = this.getClaim(id);
    if (!updated) throw new Error(`Claim ${id} disappeared`);
    return updated;
  }

  // Each step may be retried by the workflow, so it also accepts the state it produces.
  setExtraction(id: string, extraction: Extraction): ClaimRecord {
    return this.update(id, ["received", "extracted"], "extracted", "extraction", extraction);
  }

  setCoding(id: string, coding: NonNullable<ClaimRecord["coding"]>): ClaimRecord {
    return this.update(id, ["extracted", "coded"], "coded", "coding", coding);
  }

  setAdjudication(id: string, adjudication: NonNullable<ClaimRecord["adjudication"]>): ClaimRecord {
    return this.update(id, ["coded", "adjudicated"], "adjudicated", "adjudication", adjudication);
  }

  setFraud(id: string, fraud: NonNullable<ClaimRecord["fraud"]>): ClaimRecord {
    return this.update(id, ["adjudicated", "fraud_checked"], "fraud_checked", "fraud", fraud);
  }

  /** Triage does not change the claim's state. */
  setTriage(id: string, triage: Triage): void {
    this.ctx.storage.sql.exec("UPDATE claims SET triage = ? WHERE id = ?", JSON.stringify(triage), id);
  }

  requestApproval(id: string): ClaimRecord {
    return this.update(id, ["fraud_checked", "awaiting_approval"], "awaiting_approval", null, null);
  }

  recordApproval(id: string, approval: Approval): ClaimRecord {
    const next = approval.decision === "approve" ? "approved" : "rejected";
    const current = this.getClaim(id);
    if (current?.approval) {
      if (current.approval.decision === approval.decision && current.approval.by === approval.by) return current;
      throw new Error(`Claim ${id} already has a ${current.approval.decision} decision by ${current.approval.by}`);
    }
    return this.update(id, ["awaiting_approval"], next, "approval", approval);
  }

  /** The only way money moves. Refuses any claim without a recorded human approval. */
  issuePayment(id: string): ClaimRecord {
    const current = this.getClaim(id);
    if (current?.state === "paid") return current;
    if (!current?.approval || current.approval.decision !== "approve" || current.state !== "approved") {
      throw new Error(`Claim ${id} has no human approval; payment refused`);
    }
    const amount = current.adjudication?.totals.payment ?? 0;
    return this.update(id, ["approved"], "paid", "payment", { amount, reference: `FICT-PAY-${id}`, at: new Date().toISOString() });
  }

  fail(id: string, error: string): void {
    this.ctx.storage.sql.exec("UPDATE claims SET state = 'error', error = ? WHERE id = ?", error, id);
  }

  // Queries the agents use

  claimHistory(memberId: string, excludeClaimId?: string): { id: string; state: ClaimState; providerId: string; receivedAt: string; serviceDate: string | undefined; codes: string[]; diagnoses: string[]; gross: Fils }[] {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM claims WHERE member_id = ? AND id != ? ORDER BY received_at", memberId, excludeClaimId ?? "")
      .toArray()
      .map((row) => this.toRecord(row))
      .map((record) => ({
        id: record.id,
        state: record.state,
        providerId: record.providerId,
        receivedAt: record.receivedAt,
        serviceDate: record.claim.encounter?.start ?? record.claim.activities[0]?.start,
        codes: record.claim.activities.map((activity) => `${activity.code} x${activity.quantity} (${activity.net / 100} AED)`),
        diagnoses: record.claim.diagnoses.map((diagnosis) => diagnosis.code),
        gross: record.claim.gross,
      }));
  }

  providerStats(providerId: string): { claims: number; byCode: Record<string, number>; highestLevelVisitShare: number } {
    const records = this.ctx.storage.sql.exec<Row>("SELECT * FROM claims WHERE provider_id = ?", providerId).toArray().map((row) => this.toRecord(row));
    const byCode: Record<string, number> = {};
    let visits = 0;
    let highest = 0;
    for (const record of records) {
      for (const activity of record.claim.activities) {
        byCode[activity.code] = (byCode[activity.code] ?? 0) + 1;
        if (findActivity(activity.type, activity.code)?.benefit === "consultation") {
          visits += 1;
          if (activity.code === "99215" || activity.code === "99205") highest += 1;
        }
      }
    }
    return { claims: records.length, byCode, highestLevelVisitShare: visits ? Math.round((highest / visits) * 100) / 100 : 0 };
  }

  /** Benefit use this policy year from claims that are paid, approved or awaiting approval. */
  accumulators(memberId: string, excludeClaimId: string): Accumulators {
    const member = this.getMember(memberId);
    const accumulators: Accumulators = { annualUsed: 0, drugsUsed: 0, physiotherapySessions: 0, consultationDates: [] };
    if (!member) return accumulators;
    const records = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM claims WHERE member_id = ? AND id != ? AND state IN ('awaiting_approval', 'approved', 'paid')", memberId, excludeClaimId)
      .toArray()
      .map((row) => this.toRecord(row));
    for (const record of records) {
      for (const line of record.adjudication?.lines ?? []) {
        if (line.denialCode) continue;
        const activity = record.claim.activities.find((candidate) => candidate.id === line.activityId);
        if (!activity || activity.start.slice(0, 10) < member.policyStart || activity.start.slice(0, 10) > member.policyEnd) continue;
        const counted = line.paymentAmount + line.patientShare;
        accumulators.annualUsed += counted;
        if (line.benefit === "drugs") accumulators.drugsUsed += counted;
        if (line.benefit === "physiotherapy") accumulators.physiotherapySessions += 1;
        if (line.benefit === "consultation") accumulators.consultationDates.push(activity.start);
      }
    }
    return accumulators;
  }
}
