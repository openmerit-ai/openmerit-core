/**
 * End-to-end loop, offline: fake pi session -> trace ingestion -> trial points
 * -> recommendation in the channel with reasoning + fallback.
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "openmerit-test-"));
process.env.OPENMERIT_HOME = HOME;

const { recommendTick } = await import("../src/daemon.js");
const { loadPolicy, DEFAULT_POLICY } = await import("../src/policy.js");
const { paths, readJsonl, taskKey, writeJson } = await import("../src/store.js");
const { ingestNewTraces } = await import("../src/traces.js");

const TASK = "Write a Python function that reverses a linked list.";

function fakeSession(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-09-11-session.jsonl");
  const entries = [
    { type: "message", id: "1", parentId: null, timestamp: "2026-09-11T10:00:00Z",
      message: { role: "user", content: TASK, timestamp: Date.parse("2026-09-11T10:00:00Z") } },
    { type: "message", id: "2", parentId: "1", timestamp: "2026-09-11T10:00:08Z",
      message: { role: "assistant", content: [{ type: "text", text: "def rev(h): ..." }],
        provider: "openai", model: "gpt-4o-mini", stopReason: "stop",
        usage: { totalTokens: 500, cost: { total: 0.001 } }, timestamp: Date.parse("2026-09-11T10:00:08Z") } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("openmerit loop", () => {
  beforeAll(() => {
    writeJson(paths.policy(), DEFAULT_POLICY);
  });

  it("ingests pi session traces into task observations", () => {
    const sessionsDir = join(HOME, "fake-pi-sessions");
    fakeSession(sessionsDir);
    const obs = ingestNewTraces(sessionsDir);
    expect(obs).toHaveLength(1);
    expect(obs[0].taskKey).toBe(taskKey(TASK));
    expect(obs[0].model).toBe("openai/gpt-4o-mini");
    expect(obs[0].costUsd).toBeCloseTo(0.001);
    expect(obs[0].latencyMs).toBe(8000);
    // second run: cursor prevents re-ingestion
    expect(ingestNewTraces(sessionsDir)).toHaveLength(0);
  });

  it("emits a reasoned, policy-gated recommendation with fallback", () => {
    // simulate the trace tick persisting the observation
    const sessionsDir = join(HOME, "fake-pi-sessions");
    writeJson(paths.traceCursor(), { offsets: {} }); // reset cursor for tracesTick
    process.env.OPENMERIT_HOME = HOME;
    // tracesTick uses the default sessions dir; instead feed observations directly
    appendFileSync(
      paths.observations(),
      JSON.stringify({
        taskKey: taskKey(TASK), taskLabel: TASK, model: "openai/gpt-4o-mini",
        costUsd: 0.001, tokens: 500, latencyMs: 8000, errors: 0,
        ts: "2026-09-11T10:00:00Z", sessionFile: join(sessionsDir, "s.jsonl"),
      }) + "\n",
    );

    // simulate shadow-trial results: current model is beaten
    const tKey = taskKey(TASK);
    for (const p of [
      { model: "openai/gpt-4o-mini", score: 0.7, price: 0.3, latencyMs: 900 },
      { model: "anthropic/claude-sonnet-5", score: 0.95, price: 3.0, latencyMs: 2100 },
      { model: "qwen/qwen3.5-9b", score: 0.82, price: 0.1, latencyMs: 34000 },
    ]) {
      appendFileSync(
        paths.trials(),
        JSON.stringify({ ...p, ts: "2026-09-11T11:00:00Z", source: "shadow_trial", taskKey: tKey }) + "\n",
      );
    }

    // harness currently runs the beaten model
    writeJson(paths.harnessState(), { currentModel: "openai/gpt-4o-mini", updatedAt: new Date().toISOString() });

    const emitted = recommendTick(loadPolicy(paths.policy()));
    expect(emitted).toHaveLength(1);
    const rec = emitted[0];
    expect(rec.recommended.model).toBe("anthropic/claude-sonnet-5");
    expect(rec.currentModel).toBe("openai/gpt-4o-mini");
    expect(rec.evidence.scoreGain).toBeCloseTo(0.25);
    expect(rec.fallback?.model).toBe("qwen/qwen3.5-9b"); // cheapest adequate frontier point
    expect(rec.policy.autoApply).toBe(false); // default policy is recommend-only
    expect(rec.recommended.reason).toContain("0.95");
    expect(rec.policy.reasons.length).toBeGreaterThan(0);

    // dedupe: no second emission for the same (task, model)
    expect(recommendTick(loadPolicy(paths.policy()))).toHaveLength(0);

    // the extension would see it as pending
    const pending = readJsonl<{ status: string }>(paths.recommendations()).filter((r) => r.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
  });
});
