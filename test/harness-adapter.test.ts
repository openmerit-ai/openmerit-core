import { describe, expect, it, vi } from "vitest";

vi.mock("../src/judge.js", () => ({
  judge: vi.fn(async () => ({ score: 0.75, why: "adapter result judged" })),
  judgeWithImages: vi.fn(async () => ({ score: 0.75, why: "adapter result judged" })),
}));
import type { HarnessAdapter } from "../src/harness.js";
import { runPiTrial } from "../src/pi-trials.js";
import { modelRoute } from "../src/routes.js";

describe("harness adapter boundary", () => {
  it("scores a normalized run supplied by a non-Pi adapter", async () => {
    const harness: HarnessAdapter = {
      runTask: vi.fn(async () => ({
        answer: "adapter answer",
        costUsd: 0.004,
        latencyMs: 321,
        errors: 0,
        sessionId: "external-session",
        toolCalls: 2,
        toolErrors: 0,
        changedFiles: 1,
      })),
    };

    const route = modelRoute("vendor", "model", { cost: { input: 1, output: 2 } });
    const evaluator = modelRoute("vendor", "evaluator", { cost: { input: 1, output: 2 } });
    const client = { chat: vi.fn(), chatWithImages: vi.fn() };
    const result = await runPiTrial(evaluator, "task", "rubric", route, client,
      "/tmp", [], [], harness);

    expect(harness.runTask).toHaveBeenCalledWith(route, {
      task: "task", cwd: "/tmp", images: [], files: [],
    });
    expect(result).toMatchObject({ costUsd: 0.004, sessionId: "external-session" });
    expect(result.point).toMatchObject({
      model: "vendor/model", score: 0.75, latencyMs: 321,
      toolCalls: 2, toolErrors: 0, changedFiles: 1,
    });
  });
});
