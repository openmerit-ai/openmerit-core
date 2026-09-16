import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoTaskTick } from "../src/daemon.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { modelRoute } from "../src/routes.js";
import { paths } from "../src/store.js";
import { sessionFiles, taskInputKey } from "../src/task-input.js";

const previous = {
  home: process.env.OPENMERIT_HOME,
  bin: process.env.OPENMERIT_PI_BIN,
};
let dir: string | null = null;

afterEach(() => {
  if (previous.home === undefined) delete process.env.OPENMERIT_HOME;
  else process.env.OPENMERIT_HOME = previous.home;
  if (previous.bin === undefined) delete process.env.OPENMERIT_PI_BIN;
  else process.env.OPENMERIT_PI_BIN = previous.bin;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("provider-neutral automatic loop", () => {
  it("trials and judges a native Pi route without an OpenRouter key", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-neutral-loop-"));
    process.env.OPENMERIT_HOME = dir;
    const bin = join(dir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1);
let text = 'better candidate answer';
if (prompt.includes('Write a compact grading rubric')) text = '{"rubric":"correctness"}';
else if (prompt.includes('finding the best configured model route')) text = '{"next_model":"local:b","why":"cheap and capable"}';
else if (prompt.includes("You are grading")) text = prompt.includes('ANSWER: baseline')
  ? '{"score":0.5,"why":"baseline"}' : '{"score":0.9,"why":"better"}';
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }],
  usage: { input: 20, output: 10, totalTokens: 30, cost: { total: 0.001 } }, stopReason: 'stop' } }));
`);
    chmodSync(bin, 0o755);
    process.env.OPENMERIT_PI_BIN = bin;

    const active = modelRoute("native", "a", { input: ["text"], cost: { input: 0.5, output: 1 },
      contextWindow: 8192, maxTokens: 2048 });
    const candidate = modelRoute("local", "b", { input: ["text"], cost: { input: 0.1, output: 0.2 },
      contextWindow: 8192, maxTokens: 2048 });
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const attachment = join(dir, "input.txt");
    writeFileSync(attachment, "attachment bytes");
    const task = `<file name="${attachment}">attachment bytes</file>\nsolve task`;
    const files = sessionFiles(task);
    const rec = await autoTaskTick(null, { ...DEFAULT_POLICY,
      watch: { ...DEFAULT_POLICY.watch, models_per_task: 2 } }, {
      task, images: [], files, model: active.meritId, route: active,
      routes: [active, candidate], run: { answer: "baseline", costUsd: 0.002, latencyMs: 10,
        errors: 0, toolCalls: 0, toolErrors: 0, changedFiles: 0 }, sessionFile,
      settledAt: "2026-09-16T00:00:00Z", sessionBytes: 1, cwd: dir, usedTools: false,
    });

    expect(rec?.recommended).toMatchObject({ model: "local/b", route: { provider: "local", modelId: "b" } });
    expect(rec?.currentRoute).toEqual(active);
    expect(rec?.taskKey).toBe(taskInputKey(task, [], files));
    const ledger = JSON.parse(readFileSync(paths.ledger(), "utf8"));
    expect(ledger.trials).toBe(1);
    expect(ledger.usd).toBeGreaterThanOrEqual(0.004);
    expect(readFileSync(paths.events(), "utf8")).toContain('"type":"recommendation.created"');
  }, 10_000);
});
