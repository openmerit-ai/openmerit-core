import { describe, expect, it } from "vitest";
import { buildRecommendation } from "../src/recommend.js";
import { applyRouteOverrides, modelRoute, routeCatalog, routeKey } from "../src/routes.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { trialBudgetOk } from "../src/trials.js";
import type { TrialPoint } from "../src/types.js";

const direct = modelRoute("anthropic", "claude-sonnet", {
  input: ["text"], cost: { input: 3, output: 15 }, contextWindow: 200_000, maxTokens: 8192,
});
const routed = modelRoute("openrouter", "anthropic/claude-sonnet", {
  input: ["text"], cost: { input: 3.2, output: 15.5 }, contextWindow: 200_000, maxTokens: 8192,
});

function point(route: typeof direct, score: number): TrialPoint {
  const entry = routeCatalog([route]).get(routeKey(route))!;
  return { schemaVersion: 1, model: route.meritId, route, score, price: entry.price,
    priceKnown: entry.priceKnown, ts: "2026-09-16T00:00:00Z", source: "pi_trial" };
}

describe("provider-neutral model routes", () => {
  it("keeps logical identity stable while distinguishing execution routes", () => {
    expect(direct.meritId).toBe("anthropic/claude-sonnet");
    expect(routed.meritId).toBe("anthropic/claude-sonnet");
    expect(routeKey(direct)).not.toBe(routeKey(routed));
  });

  it("can recommend another route for the same logical model", () => {
    const rec = buildRecommendation("task", "task", direct.meritId,
      [point(direct, 0.7), point(routed, 0.9)], DEFAULT_POLICY, "/tmp/session.jsonl", direct)!;
    expect(rec.recommended.model).toBe(direct.meritId);
    expect(rec.recommended.route).toEqual(routed);
    expect(rec.currentRoute).toEqual(direct);
  });

  it("blocks automatic swaps when legacy or custom pricing is unknown", () => {
    const auto: Policy = { ...DEFAULT_POLICY, mode: "auto",
      auto_apply: { ...DEFAULT_POLICY.auto_apply, enabled: true } };
    const unknown = modelRoute("local", "model-b", { input: ["text"], contextWindow: 8192 });
    const candidate = { ...point(unknown, 0.95), priceKnown: false };
    const rec = buildRecommendation("task", "task", direct.meritId,
      [point(direct, 0.7), candidate], auto, "/tmp/session.jsonl", direct)!;
    expect(rec.policy.autoApply).toBe(false);
    expect(rec.policy.reasons).toContain("candidate or current-model price is unknown");
  });

  it("rejects a candidate whose conservative cost estimate exceeds the per-trial limit", () => {
    const expensive = routeCatalog([modelRoute("native", "expensive", {
      input: ["text"], cost: { input: 100, output: 100 }, contextWindow: 8192, maxTokens: 4096,
    })]).values().next().value!;
    expect(trialBudgetOk(DEFAULT_POLICY, expensive, 4000)).toMatchObject({ ok: false });
  });

  it("applies metadata only to the exact provider route", () => {
    const local = modelRoute("local", "qwen:8b");
    const other = modelRoute("openrouter", "local/qwen:8b");
    const [overridden, untouched] = applyRouteOverrides([local, other], {
      "local:qwen:8b": {
        cost: { input: 0, output: 0 }, context_window: 32_768, max_tokens: 4096,
        input: ["text", "image"],
      },
    });
    expect(overridden).toMatchObject({ cost: { input: 0, output: 0 }, contextWindow: 32_768,
      maxTokens: 4096, input: ["text", "image"] });
    expect(untouched.cost).toBeUndefined();
  });
});
