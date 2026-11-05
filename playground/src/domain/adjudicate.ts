// Deterministic benefit math and hard plan rules. The adjudication agent decides which lines to
// pay or deny and why; this module refuses decisions that break a hard rule and computes every
// amount, so a model never does arithmetic on money.

import { DELETED_ICD10CM, findActivity, findDiagnosis } from "./codes.ts";
import { DENIAL_CODES, type DenialCode, PLAN } from "./plan.ts";
import type { AdjudicationLine, Clinician, Fils, Member, SubmittedClaim } from "./types.ts";

export interface LineDecision {
  activityId: string;
  decision: "pay" | "deny";
  denialCode?: string;
  reason: string;
}

export interface Accumulators {
  /** Allowed amounts already counted against the annual limit this policy year. */
  annualUsed: Fils;
  /** Allowed drug amounts already counted against the drug limit, including coinsurance. */
  drugsUsed: Fils;
  physiotherapySessions: number;
  /** ISO dates of earlier paid consultations, for the seven-day follow-up waiver. */
  consultationDates: string[];
}

export interface RemittanceInput {
  claim: SubmittedClaim;
  member: Member | undefined;
  clinicians: Clinician[];
  accumulators: Accumulators;
  decisions: LineDecision[];
}

export interface Remittance {
  lines: AdjudicationLine[];
  /** Decisions that break a hard rule. When non-empty, `lines` is empty and nothing is recorded. */
  violations: string[];
  totals: { gross: Fils; patientShare: Fils; payment: Fils };
}

const DAY_MS = 86_400_000;

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function share(amount: Fils, basisPoints: number): Fils {
  return Math.round((amount * basisPoints) / 10_000);
}

/** Hard rules for one activity: the denial codes a correct decision must use, if any. */
export function requiredDenials(input: Omit<RemittanceInput, "decisions">, activityId: string): DenialCode[] {
  const { claim, member, clinicians } = input;
  const activity = claim.activities.find((candidate) => candidate.id === activityId);
  if (!activity) return [];
  const required: DenialCode[] = [];
  const serviceDate = dateOnly(activity.start);
  if (!member || serviceDate < member.policyStart || serviceDate > member.policyEnd) required.push("SH-ELIG-01");
  const code = findActivity(activity.type, activity.code);
  const invalidDiagnosis = claim.diagnoses.some((diagnosis) => !findDiagnosis(diagnosis.code) || diagnosis.code in DELETED_ICD10CM);
  if (!code || invalidDiagnosis) required.push("SH-CODE-01");
  if (code && PLAN.rules[code.benefit].priorApprovalRequired && !activity.priorAuthorizationId) required.push("SH-AUTH-01");
  const principal = claim.diagnoses.find((diagnosis) => diagnosis.type === "Principal")?.code ?? "";
  if (PLAN.excludedDiagnosisPrefixes.some((exclusion) => principal.startsWith(exclusion.prefix))) required.push("SH-NCOV-01");
  if (member?.firstUaeScheme && serviceDate < addMonths(member.policyStart, PLAN.preExistingWaitingMonths)) {
    const chronic = findDiagnosis(principal)?.chronic;
    const declared = member.declaredConditions.some((condition) => principal.startsWith(condition));
    if (chronic && declared) required.push("SH-PREX-01");
  }
  const clinician = clinicians.find((candidate) => candidate.id === activity.clinician);
  const referred = activity.observations.some((observation) => observation.code === "eReferral" && observation.value);
  if (code?.benefit === "consultation" && clinician?.role === "Specialist" && !referred) required.push("SH-REF-01");
  return required;
}

export function computeRemittance(input: RemittanceInput): Remittance {
  const { claim, accumulators, decisions } = input;
  const violations: string[] = [];
  const decided = new Map(decisions.map((decision) => [decision.activityId, decision]));
  for (const decision of decisions) {
    if (!claim.activities.some((activity) => activity.id === decision.activityId)) violations.push(`Unknown activity ${decision.activityId}`);
  }
  for (const activity of claim.activities) {
    const decision = decided.get(activity.id);
    if (!decision) {
      violations.push(`Activity ${activity.id} has no decision`);
      continue;
    }
    const required = requiredDenials(input, activity.id);
    if (decision.decision === "pay" && required.length) {
      violations.push(`Activity ${activity.id} (${activity.code}) must be denied: ${required.map((code) => `${code} ${DENIAL_CODES[code]}`).join("; ")}`);
    }
    if (decision.decision === "deny" && !(decision.denialCode && Object.hasOwn(DENIAL_CODES, decision.denialCode))) {
      violations.push(`Activity ${activity.id} is denied without a valid denial code`);
    }
  }
  if (violations.length) return { lines: [], violations, totals: { gross: 0, patientShare: 0, payment: 0 } };

  let annualUsed = accumulators.annualUsed;
  let drugsUsed = accumulators.drugsUsed;
  let physiotherapySessions = accumulators.physiotherapySessions;
  const lines: AdjudicationLine[] = [];
  for (const activity of claim.activities) {
    const decision = decided.get(activity.id);
    if (!decision) continue;
    const code = findActivity(activity.type, activity.code);
    const benefit = code?.benefit ?? "unknown";
    if (decision.decision === "deny" || !code) {
      lines.push({ activityId: activity.id, code: activity.code, benefit, gross: activity.net, patientShare: 0, paymentAmount: 0, denialCode: decision.denialCode, reason: decision.reason });
      continue;
    }
    const rule = PLAN.rules[code.benefit];
    let allowed = Math.min(activity.net, code.tariff * activity.quantity);
    const notes: string[] = [];
    if (allowed < activity.net) notes.push(`billed above tariff; allowed ${allowed / 100} AED`);
    let coinsuranceBp = rule.coinsuranceBp;
    if (code.benefit === "consultation") {
      const visit = new Date(activity.start).getTime();
      const followUp = accumulators.consultationDates.some((earlier) => {
        const gap = visit - new Date(earlier).getTime();
        return gap > 0 && gap <= PLAN.followUpWaiverDays * DAY_MS;
      });
      if (followUp) {
        coinsuranceBp = 0;
        notes.push("follow-up within seven days, no coinsurance");
      }
    }
    if (code.benefit === "physiotherapy") {
      if (physiotherapySessions >= PLAN.physiotherapySessionsPerYear) {
        lines.push({ activityId: activity.id, code: activity.code, benefit, gross: activity.net, patientShare: 0, paymentAmount: 0, denialCode: "SH-LIM-01", reason: "Physiotherapy session limit reached" });
        continue;
      }
      physiotherapySessions += 1;
    }
    let uncovered: Fils = 0;
    if (code.benefit === "drugs") {
      const drugRoom = Math.max(0, PLAN.drugsAnnualLimit - drugsUsed);
      if (allowed > drugRoom) {
        uncovered += allowed - drugRoom;
        notes.push("drug annual limit reached");
      }
      drugsUsed += Math.min(allowed, drugRoom);
    }
    const annualRoom = Math.max(0, PLAN.annualLimit - annualUsed);
    const counted = allowed - uncovered;
    if (counted > annualRoom) {
      uncovered += counted - annualRoom;
      notes.push("annual limit reached");
    }
    annualUsed += Math.min(counted, annualRoom);
    const coveredAmount = allowed - uncovered;
    const coinsurance = share(coveredAmount, coinsuranceBp);
    allowed = coveredAmount;
    lines.push({
      activityId: activity.id,
      code: activity.code,
      benefit,
      gross: activity.net,
      patientShare: coinsurance + uncovered,
      paymentAmount: allowed - coinsurance,
      reason: [decision.reason, ...notes].join("; "),
    });
  }
  return {
    lines,
    violations,
    totals: {
      gross: lines.reduce((sum, line) => sum + line.gross, 0),
      patientShare: lines.reduce((sum, line) => sum + line.patientShare, 0),
      payment: lines.reduce((sum, line) => sum + line.paymentAmount, 0),
    },
  };
}
