import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedActiveTask } from "../src/pi-trials.js";

const oldHome = process.env.OPENMERIT_HOME;
let dir: string | null = null;
afterEach(() => {
  process.env.OPENMERIT_HOME = oldHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("active pi task trace", () => {
  it("reuses model A's completed answer and rejects another task", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-recorded-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(join(dir, "harness-state.json"), JSON.stringify({ sessionFile: session }));
    writeFileSync(session, [
      { type: "message", message: { role: "user", timestamp: 1000,
        content: [{ type: "text", text: "Task A" }] } },
      { type: "message", message: { role: "assistant", provider: "openrouter",
        model: "vendor/model-a", timestamp: 2400, stopReason: "end_turn",
        content: [{ type: "text", text: "Result A" }], usage: { cost: { total: 0.004 } } } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    expect(recordedActiveTask("task A", "vendor/model-a")).toEqual({
      answer: "Result A", costUsd: 0.004, latencyMs: 1400, errors: 0,
    });
    expect(recordedActiveTask("task B", "vendor/model-a")).toBeNull();
    expect(recordedActiveTask("task A", "vendor/model-b")).toBeNull();
  });
});
