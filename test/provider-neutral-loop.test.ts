import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSettledTask } from "../src/comparison.js";
import { PiHarnessAdapter } from "../src/pi-trials.js";
import { PiCliChatClient } from "../src/llm.js";
import { recordMeritSpend } from "../src/trials.js";
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
  vi.restoreAllMocks();
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
    const providerExtension = join(dir, "local-provider.ts");
    writeFileSync(providerExtension, "export default function provider() {}\n");
    const resolvedProviderExtension = realpathSync(providerExtension);
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--no-extensions') || args[args.indexOf('--extension') + 1] !== ${JSON.stringify(resolvedProviderExtension)}) process.exit(8);
const prompt = args.at(-1);
let text = 'better candidate answer';
if (prompt.includes('Write a compact grading rubric')) text = '{"rubric":"correctness"}';
else if (prompt.includes("You are grading")) text = prompt.includes('ANSWER: baseline')
  ? '{"score":0.5,"why":"baseline"}' : '{"score":0.9,"why":"better"}';
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }],
  usage: { input: 20, output: 10, totalTokens: 30, cost: { total: 0.001 } }, stopReason: 'stop' } }));
`);
    chmodSync(bin, 0o755);
    process.env.OPENMERIT_PI_BIN = bin;

    const active = modelRoute("native", "a", { input: ["text"], cost: { input: 0.5, output: 1 },
      contextWindow: 8192, maxTokens: 2048 });
    const candidate = modelRoute("local", "b");
    const unknownPrice = modelRoute("local", "c");
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const attachment = join(dir, "input.txt");
    writeFileSync(attachment, "attachment bytes");
    const task = `<file name="${attachment}">attachment bytes</file>\nsolve task`;
    const files = sessionFiles(task);
    const log = vi.spyOn(console, "log");
    const harness = new PiHarnessAdapter([providerExtension]);
    const rec = await compareSettledTask({ ...DEFAULT_POLICY,
      comparison: { max_routes: 2 },
      route_overrides: { "local:b": { input: ["text"], cost: { input: 0.1, output: 0.2 },
        context_window: 8192, max_tokens: 2048 } },
      pi: { provider_extensions: [providerExtension] },
    }, {
      task, images: [], files, model: active.meritId, route: active,
      routes: [active, candidate, unknownPrice], run: { answer: "baseline", costUsd: 0.002, latencyMs: 10,
        errors: 0, toolCalls: 0, toolErrors: 0, changedFiles: 0 }, sessionFile,
      settledAt: "2026-09-16T00:00:00Z", sessionBytes: 1, cwd: dir, usedTools: false,
    }, { harness, client: new PiCliChatClient(undefined, recordMeritSpend, [providerExtension]) });

    expect(rec?.recommended).toMatchObject({ model: "local/b", route: { provider: "local", modelId: "b" } });
    expect(rec?.recommended.route?.cost).toEqual({ input: 0.1, output: 0.2 });
    expect(log.mock.calls.flat().join("\n")).toContain('"model":"local/c via local","reasons":["route price is unknown"]');
    expect(rec?.currentRoute).toEqual(active);
    expect(rec?.taskKey).toBe(taskInputKey(task, [], files));
    const ledger = JSON.parse(readFileSync(paths.ledger(), "utf8"));
    expect(ledger.trials).toBe(1);
    expect(ledger.usd).toBeGreaterThanOrEqual(0.004);
    expect(readFileSync(paths.events(), "utf8")).toContain('"type":"recommendation.created"');
  }, 10_000);
});
