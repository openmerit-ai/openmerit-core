import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUsage, type Observation } from "../scripts/usage.ts";

const root: Observation = { type: "AGENT", endTime: "2026-11-06T08:00:00Z", latency: 7.3, metadata: { generations: "2" } };
const generation = (totalCost: number | null): Observation => ({ type: "GENERATION", totalCost });

test("usage waits for all declared generations and prices, retaining a genuine zero-cost control", async () => {
  const pages: Observation[][] = [[], [root, generation(0.75)], [root, generation(0.75), generation(null)], [root, generation(0.75), generation(1.6)]];
  const result = await collectUsage([
    { caseId: "fictional-a", agent: "coding", traceId: "delayed" },
    { caseId: "fictional-b", agent: "intake", traceId: "free" },
  ], async id => id === "delayed" ? pages.shift() ?? [] : [{ ...root, latency: 0.2, metadata: { generations: "1" } }, generation(0)], { intervalMs: 1, timeoutMs: 1000 });
  assert.deepEqual(result, [
    { caseId: "fictional-a", agent: "coding", cost: 2.35, seconds: 7.3, generations: 2, complete: true },
    { caseId: "fictional-b", agent: "intake", cost: 0, seconds: 0.2, generations: 1, complete: true },
  ]);
});

test("timed-out, unpriced and unavailable usage stays explicitly unknown rather than zero", async () => {
  const result = await collectUsage([
    { caseId: "fictional-a", agent: "coding", traceId: "unpriced" },
    { caseId: "fictional-b", agent: "intake", traceId: "unavailable" },
  ], async id => {
    if (id === "unavailable") throw new Error("Fictional outage");
    return [root, generation(0.75), generation(null)];
  }, { intervalMs: 1, timeoutMs: 15 });
  assert.deepEqual(result, [
    { caseId: "fictional-a", agent: "coding", cost: null, seconds: 7.3, generations: 2, complete: false },
    { caseId: "fictional-b", agent: "intake", cost: null, seconds: null, generations: 0, complete: false },
  ]);
});
