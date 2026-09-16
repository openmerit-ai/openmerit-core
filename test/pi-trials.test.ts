import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availablePiRoutes, executePiTask, piTrialToolArgs, settledActiveTask } from "../src/pi-trials.js";
import { paths, taskKey } from "../src/store.js";
import { sessionFiles, taskInputKey } from "../src/task-input.js";
import { piProviderExtensionArgs } from "../src/pi-config.js";

const oldPath = process.env.PATH;
const oldHome = process.env.OPENMERIT_HOME;
const oldTrialTools = process.env.OPENMERIT_PI_TRIAL_TOOLS;
let fixtureDir: string | null = null;

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldHome === undefined) delete process.env.OPENMERIT_HOME;
  else process.env.OPENMERIT_HOME = oldHome;
  if (oldTrialTools === undefined) delete process.env.OPENMERIT_PI_TRIAL_TOOLS;
  else process.env.OPENMERIT_PI_TRIAL_TOOLS = oldTrialTools;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
});

describe("pi-backed task measurement", () => {
  it("preserves Pi list-model capabilities in provider routes", () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-list-"));
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
console.log('provider  model       context  max-out  thinking  images');
console.log('native    model-a     128K     16.4K    no        yes');
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    expect(availablePiRoutes()).toEqual([{
      provider: "native", modelId: "model-a", meritId: "native/model-a",
      input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_400,
    }]);
  });

  it("disables candidate tools unless the user explicitly opts in", () => {
    delete process.env.OPENMERIT_PI_TRIAL_TOOLS;
    expect(piTrialToolArgs()).toEqual(["--no-tools"]);
    process.env.OPENMERIT_PI_TRIAL_TOOLS = "read,bash,edit,write";
    expect(piTrialToolArgs()).toEqual(["--tools", "read,bash,edit,write"]);
    process.env.OPENMERIT_PI_TRIAL_TOOLS = "none";
    expect(piTrialToolArgs()).toEqual(["--no-tools"]);
    process.env.OPENMERIT_PI_TRIAL_TOOLS = "read,unknown";
    expect(() => piTrialToolArgs()).toThrow(/invalid OPENMERIT_PI_TRIAL_TOOLS: unknown/);
  });

  it("loads only explicit provider extension files and refuses recursive OpenMerit", () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-provider-extension-"));
    const provider = join(fixtureDir, "ollama-provider.ts");
    writeFileSync(provider, "export default function provider() {}\n");
    expect(piProviderExtensionArgs([provider])).toEqual(["--extension", realpathSync(provider)]);
    expect(() => piProviderExtensionArgs(["relative-provider.ts"])).toThrow(/not absolute/);
    const recursive = join(fixtureDir, "openmerit.ts");
    writeFileSync(recursive, "export default function openmerit() {}\n");
    expect(() => piProviderExtensionArgs([recursive])).toThrow(/recursively/);
  });

  it("reads the result and observed cost from pi's event stream", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-"));
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('--mode') || !args.includes('json') || !args.includes('--provider') || !args.includes('openrouter') || !args.includes('--no-tools')) process.exit(2);
fs.writeFileSync('candidate-side-effect.txt', 'isolated');
const model = args[args.indexOf('--model') + 1];
const task = args.at(-1);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'write' }] } }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', isError: false, content: [{ type: 'text', text: 'ok' }] } }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model, content: [{ type: 'text', text: task + ' done' }], usage: { cost: { total: 0.0123 } } } }));
console.log(JSON.stringify({ type: 'agent_settled' }));
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    const result = await executePiTask("vendor/model-a", "task A", fixtureDir);
    expect(result.answer).toBe("task A done");
    expect(result.costUsd).toBe(0.0123);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.toolCalls).toBe(1);
    expect(result.changedFiles).toBe(1);
    expect(result.traceFile).toBeTruthy();
  });

  it("passes a native provider route to pi instead of forcing OpenRouter", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-native-"));
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf('--provider') + 1] !== 'anthropic' || args[args.indexOf('--model') + 1] !== 'claude-test') process.exit(7);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'native answer' }], usage: { cost: { total: 0.002 } } } }));
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    const result = await executePiTask({ provider: "anthropic", modelId: "claude-test",
      meritId: "anthropic/claude-test", input: ["text"] }, "task", fixtureDir);
    expect(result.answer).toBe("native answer");
    expect(result.costUsd).toBe(0.002);
  });

  it("forwards an attached PDF into the isolated tool workspace", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-file-"));
    const pdf = join(fixtureDir, "invoice.pdf");
    writeFileSync(pdf, "PDF fixture");
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.find(x => x.startsWith('@') && x.endsWith('invoice.pdf'));
if (!a || fs.readFileSync(a.slice(1), 'utf8') !== 'PDF fixture' || process.cwd() === ${JSON.stringify(fixtureDir)}) process.exit(4);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'read PDF' }] } }));
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    const files = sessionFiles(`<file name="${pdf}">PDF text</file>`);
    expect(files).toHaveLength(1);
    const result = await executePiTask("vendor/model-a", "Read the attached PDF", fixtureDir, [], files);
    expect(result.answer).toBe("read PDF");
    expect(result.changedFiles).toBe(0);
  });

  it("accepts only the settled latest text task and its measured A result", () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-settled-"));
    process.env.OPENMERIT_HOME = fixtureDir;
    const sessionFile = join(fixtureDir, "session.jsonl");
    const task = "Explain a simple word ladder.";
    const lines = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: task }], timestamp: 1000 } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-4o-mini",
        content: [{ type: "text", text: "cat to cot to dot" }], timestamp: 2100,
        usage: { cost: { total: 0.001 } }, stopReason: "stop" } },
    ];
    writeFileSync(sessionFile, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(paths.harnessState(), JSON.stringify({ currentModel: "openai/gpt-4o-mini",
      sessionFile, settledTaskKey: taskKey(task), settledAt: "2026-09-16T00:00:00Z", cwd: fixtureDir }));
    const settled = settledActiveTask();
    expect(settled?.task).toBe(task);
    expect(settled?.run.answer).toBe("cat to cot to dot");
    expect(settled?.run.costUsd).toBe(0.001);
    lines.splice(1, 0, { type: "message", message: { role: "assistant", provider: "openrouter",
      model: "openai/gpt-4o-mini", content: [{ type: "toolCall", text: "write" }], timestamp: 1100,
      usage: { cost: { total: 0 } }, stopReason: "toolUse" } });
    writeFileSync(sessionFile, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
    expect(settledActiveTask()?.usedTools).toBe(true);
    expect(settledActiveTask()?.run.toolCalls).toBe(1);
  });

  it("keeps model A bound to the settled session bytes when a later task arrives", () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-session-snapshot-"));
    process.env.OPENMERIT_HOME = fixtureDir;
    const sessionFile = join(fixtureDir, "session.jsonl");
    const first = "Convert café invoice to JSON";
    writeFileSync(sessionFile, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: first }], timestamp: 1000 } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "vendor/a",
        content: [{ type: "text", text: "{\"invoice\":1}" }], timestamp: 1200,
        stopReason: "stop", usage: { cost: { total: 0.002 } } } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const sessionBytes = readFileSync(sessionFile).length;
    appendFileSync(sessionFile, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Second task" }], timestamp: 2000 } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "vendor/b",
        content: [{ type: "text", text: "second answer" }], timestamp: 2300, stopReason: "stop" } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const captured = settledActiveTask({ sessionFile, sessionBytes, currentModel: "vendor/a",
      settledTaskKey: taskKey(first), settledAt: "2026-09-16T00:00:00Z", cwd: fixtureDir });
    expect(captured?.task).toBe(first);
    expect(captured?.run.answer).toBe('{"invoice":1}');
    expect(captured?.run.costUsd).toBe(0.002);
  });

  it("replays the saved image as a pi image input and separates invoice task keys", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-image-"));
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const image = args.find(x => x.startsWith('@'));
if (!image || fs.readFileSync(image.slice(1), 'utf8') !== 'invoice pixels') process.exit(3);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'invoice JSON' }] } }));
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    const image = { type: "image" as const, data: Buffer.from("invoice pixels").toString("base64"),
      mimeType: "image/jpeg" };
    const other = { ...image, data: Buffer.from("different invoice").toString("base64") };
    expect(taskInputKey("Extract invoice", [image])).not.toBe(taskInputKey("Extract invoice", [other]));
    expect(taskInputKey("Extract invoice", [])).toBe(taskKey("Extract invoice"));
    const result = await executePiTask("vendor/vision", "Extract invoice", fixtureDir, [image]);
    expect(result.answer).toBe("invoice JSON");
    process.env.OPENMERIT_HOME = fixtureDir;
    const sessionFile = join(fixtureDir, "invoice-session.jsonl");
    writeFileSync(sessionFile, [
      { type: "message", message: { role: "user", timestamp: 1000,
        content: [{ type: "text", text: "Extract invoice" }, image] } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "vendor/vision",
        content: [{ type: "text", text: "invoice JSON" }], timestamp: 2200,
        usage: { cost: { total: 0.002 } }, stopReason: "stop" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    writeFileSync(paths.harnessState(), JSON.stringify({ sessionFile, currentModel: "vendor/vision",
      settledTaskKey: taskInputKey("Extract invoice", [image]), settledAt: "2026-09-16T00:00:00Z" }));
    expect(settledActiveTask()?.images).toEqual([image]);
    expect(settledActiveTask()?.run.answer).toBe("invoice JSON");
  });
});
