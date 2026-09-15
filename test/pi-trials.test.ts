import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePiTask } from "../src/pi-trials.js";

const oldPath = process.env.PATH;
let fixtureDir: string | null = null;

afterEach(() => {
  process.env.PATH = oldPath;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
});

describe("pi-backed task measurement", () => {
  it("reads the result and observed cost from pi's event stream", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openmerit-pi-"));
    const bin = join(fixtureDir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--mode') || !args.includes('json') || !args.includes('--provider') || !args.includes('openrouter')) process.exit(2);
const model = args[args.indexOf('--model') + 1];
const task = args.at(-1);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model, content: [{ type: 'text', text: task + ' done' }], usage: { cost: { total: 0.0123 } } } }));
console.log(JSON.stringify({ type: 'agent_settled' }));
`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${fixtureDir}:${oldPath}`;
    const result = await executePiTask("vendor/model-a", "task A", fixtureDir);
    expect(result.answer).toBe("task A done");
    expect(result.costUsd).toBe(0.0123);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
