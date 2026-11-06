// Claim triage with a decision model, in shadow mode: before the agents run, OpenRouter's Decisions API
// answers one yes/no question, "does this claim need review?", as a probability. Sahra records it and
// scores it against the fixture labels; it does not route claims yet, and a person still approves
// every payment.

import { PLAN } from "./domain/plan.ts";
import type { Fils } from "./domain/types.ts";
import type { ClaimRecord } from "./ledger.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export const TRIAGE_QUESTION = {
  type: "noul",
  instructions:
    "Should this outpatient claim be examined by the full review pipeline or a person before payment, instead of being paid as submitted?",
  criteria: {
    true: "At least one line should be denied or reduced, or the claim looks like a duplicate, a billing mismatch, upcoding, unbundling, an unsupported service, an ineligible member, a missing referral or prior approval, an excluded service, or a pre-existing condition within the waiting period.",
    false: "Every line is supported by the diagnoses and the itemized bill, the member is covered, and nothing suggests duplication, abuse or a plan rule being broken.",
  },
} as const;

export interface Triage {
  /** Probability that the claim needs review; null when the call failed. */
  needsReview: number | null;
  model: string;
  /** The model version and provider OpenRouter routed to. */
  servedModel?: string;
  provider?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
  startedAt: string;
  latencyMs: number;
  error?: string;
}

const aed = (fils: Fils): number => fils / 100;

/** What the decision model sees: the claim, the bill and the context the agents would look up, in AED. */
export function triageState(input: {
  record: ClaimRecord;
  member: unknown;
  clinicians: unknown;
  history: { id: string; providerId: string; serviceDate: string | undefined; codes: string[]; diagnoses: string[] }[];
  providerStats: unknown;
}): Record<string, unknown> {
  const { claim } = input.record;
  return {
    plan: {
      name: PLAN.name,
      rules: Object.values(PLAN.rules).map((rule) => rule.citation),
      exclusions: PLAN.excludedDiagnosisPrefixes.map((item) => `${item.prefix}: ${item.reason}`),
      preExistingWaitingMonths: PLAN.preExistingWaitingMonths,
    },
    claim: {
      id: claim.id,
      providerId: claim.providerId,
      grossAed: aed(claim.gross),
      diagnoses: claim.diagnoses,
      activities: claim.activities.map((item) => ({ id: item.id, start: item.start, type: item.type, code: item.code, quantity: item.quantity, netAed: aed(item.net), clinician: item.clinician, priorAuthorizationId: item.priorAuthorizationId, observations: item.observations })),
    },
    itemizedBill: input.record.bill,
    member: input.member,
    clinicians: input.clinicians,
    memberClaimHistory: input.history,
    providerStats: input.providerStats,
  };
}

/** Asks the decision model; never throws, so triage cannot stop a claim. */
export async function triageClaim(apiKey: string | undefined, model: string, state: Record<string, unknown>, sessionId: string): Promise<Triage> {
  const started = Date.now();
  const base = { model, startedAt: new Date(started).toISOString() };
  try {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    const request = () => fetch(DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, state, questions: { needs_review: TRIAGE_QUESTION }, session_id: sessionId }),
      signal: AbortSignal.timeout(60_000),
    });
    let response = await request();
    // Decision providers answer 429 when they have no capacity; retry once after a pause.
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      response = await request();
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Decisions API ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { model?: string; provider?: string; answers?: { needs_review?: { noul?: number } }; usage?: { input_tokens: number; output_tokens: number; cost?: number } };
    const probability = body.answers?.needs_review?.noul;
    if (typeof probability !== "number" || probability < 0 || probability > 1) throw new Error(`Decisions API returned no needs_review probability: ${text.slice(0, 300)}`);
    return {
      ...base,
      needsReview: probability,
      servedModel: body.model,
      provider: body.provider,
      usage: body.usage && { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens, costUsd: body.usage.cost ?? null },
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ...base, needsReview: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A claim needs review when any line should be denied or the fraud review should not simply pay it. */
export const needsReviewLabel = (expected: { lines: Record<string, unknown>; fraud: readonly string[] }): boolean =>
  Object.values(expected.lines).some((outcome) => outcome !== "pay") || !expected.fraud.includes("pay");

export interface TriageMetrics {
  scored: number;
  failed: number;
  /** Share of claims on the right side of 0.5. */
  accuracy: number | null;
  /** Mean squared error of the probability: 0 is perfect, 0.25 is always answering 0.5. */
  brier: number | null;
  /** Chance a random needs-review claim scores above a random clean one; ties count half. */
  auc: number | null;
  /** Claims that need review but scored below 0.5: they would skip the full pipeline under routing. */
  missedReviews: number;
  costUsd: number;
}

export function triageMetrics(items: { label: boolean; triage: Triage | null }[]): TriageMetrics {
  const scored = items.flatMap((item) => (item.triage?.needsReview == null ? [] : [{ label: item.label, p: item.triage.needsReview }]));
  const positives = scored.filter((item) => item.label), negatives = scored.filter((item) => !item.label);
  let pairs = 0;
  for (const positive of positives) for (const negative of negatives) pairs += positive.p > negative.p ? 1 : positive.p === negative.p ? 0.5 : 0;
  return {
    scored: scored.length,
    failed: items.length - scored.length,
    accuracy: scored.length ? scored.filter((item) => (item.p >= 0.5) === item.label).length / scored.length : null,
    brier: scored.length ? scored.reduce((sum, item) => sum + (item.p - (item.label ? 1 : 0)) ** 2, 0) / scored.length : null,
    auc: positives.length && negatives.length ? pairs / (positives.length * negatives.length) : null,
    missedReviews: scored.filter((item) => item.label && item.p < 0.5).length,
    costUsd: items.reduce((sum, item) => sum + (item.triage?.usage?.costUsd ?? 0), 0),
  };
}
