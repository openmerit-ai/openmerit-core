import { describe, expect, it, vi } from "vitest";

vi.mock("../src/judge.js", () => ({
  judge: vi.fn(async () => ({ score: 0.75, why: "adapter result judged" })),
  judgeWithImages: vi.fn(async () => ({ score: 0.75, why: "adapter result judged" })),
}));
vi.mock("../src/invoice-eval.js", () => ({
  knownInvoiceScore: vi.fn(async () => null),
}));

import type { HarnessAdapter } from "../src/harness.js";
import { runPiTrial } from "../src/pi-trials.js";

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

    const result = await runPiTrial(
      "provider-key", "judge/model", "task", "rubric", "vendor/model",
      { id: "vendor/model", name: "Model", ctx: 1000, pp: 0.000001, pc: 0.000002, price: 1.5 },
      "/tmp", [], [], harness,
    );

    expect(harness.runTask).toHaveBeenCalledWith("vendor/model", {
      task: "task", cwd: "/tmp", images: [], files: [],
    });
    expect(result).toMatchObject({ costUsd: 0.004, sessionId: "external-session" });
    expect(result.point).toMatchObject({
      model: "vendor/model", score: 0.75, latencyMs: 321,
      toolCalls: 2, toolErrors: 0, changedFiles: 1,
    });
  });
});
