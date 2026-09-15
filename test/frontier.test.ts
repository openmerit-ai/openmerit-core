import { describe, expect, it } from "vitest";
import { dominates, paretoFrontier, pickBest, pickFallback, scorePriceChain } from "../src/frontier.js";
import type { TrialPoint } from "../src/types.js";

function pt(model: string, score: number, price: number, latencyMs?: number): TrialPoint {
  return { model, score, price, latencyMs, ts: "2026-09-11T00:00:00Z", source: "shadow_trial" };
}

describe("dominates", () => {
  it("cheaper + higher score dominates", () => {
    expect(dominates(pt("a", 0.9, 1), pt("b", 0.8, 2))).toBe(true);
    expect(dominates(pt("b", 0.8, 2), pt("a", 0.9, 1))).toBe(false);
  });

  it("trade-offs do not dominate", () => {
    // a cheaper but worse, b pricier but better -> neither dominates
    expect(dominates(pt("a", 0.8, 1), pt("b", 0.9, 2))).toBe(false);
    expect(dominates(pt("b", 0.9, 2), pt("a", 0.8, 1))).toBe(false);
  });

  it("latency breaks otherwise-equal points", () => {
    expect(dominates(pt("a", 0.9, 1, 100), pt("b", 0.9, 1, 200))).toBe(true);
  });
});

describe("paretoFrontier", () => {
  const points = [
    pt("cheap-weak", 0.6, 0.1),
    pt("cheap-good", 0.85, 0.2),
    pt("mid", 0.9, 1.0),
    pt("expensive-bad", 0.7, 5.0),
    pt("top", 0.95, 8.0),
  ];

  it("keeps only nondominated points, cheapest first", () => {
    const fr = paretoFrontier(points).map((p) => p.model);
    expect(fr).toEqual(["cheap-weak", "cheap-good", "mid", "top"]);
    expect(fr).not.toContain("expensive-bad");
  });

  it("scorePriceChain keeps the original model-search semantics", () => {
    expect(scorePriceChain(points).map((p) => p.model)).toEqual([
      "cheap-weak",
      "cheap-good",
      "mid",
      "top",
    ]);
  });
});

describe("pickBest / pickFallback", () => {
  const points = [pt("cheap-good", 0.85, 0.2), pt("top", 0.95, 8.0), pt("mid", 0.9, 1.0)];

  it("best = highest score", () => {
    expect(pickBest(points)?.model).toBe("top");
  });

  it("fallback = cheapest frontier point clearing min_score, never best itself", () => {
    const fb = pickFallback(points, pickBest(points)!, 0.6)!;
    expect(fb.model).toBe("cheap-good");
  });

  it("fallback falls back to next-best when nothing clears min_score", () => {
    const fb = pickFallback(points, pickBest(points)!, 0.93)!;
    expect(fb.model).toBe("mid");
  });

  it("no fallback for a single point", () => {
    expect(pickFallback([pt("only", 1, 1)], pt("only", 1, 1), 0.5)).toBeUndefined();
  });
});
