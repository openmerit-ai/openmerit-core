import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, gate, loadPolicy, providerAllowed, type Policy } from "../src/policy.js";
import { buildRecommendation } from "../src/recommend.js";
import type { TrialPoint } from "../src/types.js";

const autoPolicy: Policy = {
  ...DEFAULT_POLICY,
  mode: "auto",
  auto_apply: { enabled: true, min_score_gain: 0.1, max_price_ratio: 1.5, require_frontier: true },
};

describe("gate", () => {
  it("ships in supervised recommendation mode", () => {
    expect(DEFAULT_POLICY.mode).toBe("recommend");
    expect(DEFAULT_POLICY.auto_apply.enabled).toBe(false);
  });

  it("blocks in recommend mode regardless of evidence", () => {
    const d = gate({ ...DEFAULT_POLICY, mode: "recommend" }, { scoreGain: 0.5, priceRatio: 1, onFrontier: true, providerOk: true });
    expect(d.autoApply).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/recommend/);
  });

  it("passes when all thresholds are met in auto mode", () => {
    const d = gate(autoPolicy, { scoreGain: 0.2, priceRatio: 1.2, onFrontier: true, providerOk: true });
    expect(d.autoApply).toBe(true);
  });

  it("blocks on each threshold with a reason", () => {
    expect(gate(autoPolicy, { scoreGain: 0.05, priceRatio: 1, onFrontier: true, providerOk: true }).autoApply).toBe(false);
    expect(gate(autoPolicy, { scoreGain: 0.2, priceRatio: 2, onFrontier: true, providerOk: true }).autoApply).toBe(false);
    expect(gate(autoPolicy, { scoreGain: 0.2, priceRatio: 1, onFrontier: false, providerOk: true }).autoApply).toBe(false);
    expect(gate(autoPolicy, { scoreGain: 0.2, priceRatio: 1, onFrontier: true, providerOk: false }).autoApply).toBe(false);
  });
});

describe("providerAllowed", () => {
  it("supports *, vendor/*, exact ids, and deny wins", () => {
    const p: Policy = {
      ...DEFAULT_POLICY,
      providers: { allow: ["anthropic/*", "openai/gpt-4o"], deny: ["anthropic/claude-instant"] },
    };
    expect(providerAllowed(p, "anthropic/claude-sonnet-5")).toBe(true);
    expect(providerAllowed(p, "anthropic/claude-instant")).toBe(false);
    expect(providerAllowed(p, "openai/gpt-4o")).toBe(true);
    expect(providerAllowed(p, "openai/gpt-4o-mini")).toBe(false);
    expect(providerAllowed(p, "google/gemini-3.8-flash")).toBe(false);
  });
});

function pt(model: string, score: number, price: number): TrialPoint {
  return { model, score, price, ts: "2026-09-11T00:00:00Z", source: "shadow_trial" };
}

describe("buildRecommendation", () => {
  const points = [pt("cur", 0.7, 1.0), pt("better", 0.9, 1.2), pt("cheap", 0.75, 0.3)];

  it("recommends the best model with evidence and a fallback", () => {
    const rec = buildRecommendation("t1", "task", "cur", points, DEFAULT_POLICY)!;
    expect(rec.recommended.model).toBe("better");
    expect(rec.evidence.scoreGain).toBeCloseTo(0.2);
    expect(rec.evidence.priceRatio).toBeCloseTo(1.2);
    expect(rec.evidence.onFrontier).toBe(true);
    expect(rec.fallback?.model).toBe("cheap");
    expect(rec.status).toBe("pending");
    expect(rec.recommended.reason).toContain("better");
  });

  it("stays silent when already on the best model", () => {
    expect(buildRecommendation("t1", "task", "better", points, DEFAULT_POLICY)).toBeNull();
  });

  it("stays silent when there is no gain", () => {
    expect(buildRecommendation("t1", "task", "better", [pt("better", 0.9, 1), pt("worse", 0.8, 2)], DEFAULT_POLICY)).toBeNull();
  });

  it("recommends the cheaper model when measured quality ties", () => {
    const rec = buildRecommendation("t1", "task", "expensive", [
      pt("expensive", 0.9, 1.0), pt("cheap", 0.9, 0.3),
    ], DEFAULT_POLICY)!;
    expect(rec.recommended.model).toBe("cheap");
    expect(rec.evidence.scoreGain).toBe(0);
    expect(rec.evidence.priceRatio).toBeCloseTo(0.3);
    expect(rec.recommended.reason).toContain("equal measured quality");
  });

  it("does not auto-apply without a measured current-model baseline", () => {
    const rec = buildRecommendation("t1", "task", "unmeasured", [pt("candidate", 0.9, 0.3)], autoPolicy)!;
    expect(rec.policy.autoApply).toBe(false);
    expect(rec.policy.reasons).toContain("current model has no measured baseline");
  });

  it("auto-applies only when the gate passes", () => {
    const rec = buildRecommendation("t1", "task", "cur", points, autoPolicy, "/tmp/pi-session.jsonl")!;
    expect(rec.policy.autoApply).toBe(true);
  });
});

describe("loadPolicy", () => {
  it("returns defaults for a missing file", () => {
    expect(loadPolicy("/nonexistent/policy.json")).toEqual(DEFAULT_POLICY);
  });
});
