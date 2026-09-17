import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCliChatClient } from "../src/llm.js";
import { modelRoute } from "../src/routes.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("Pi-backed merit calls", () => {
  it("uses Pi credentials/routes and reports evaluator spend", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-pi-chat-test-"));
    const bin = join(dir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf('--provider') + 1] !== 'local-provider' || args[args.indexOf('--model') + 1] !== 'judge') process.exit(9);
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{"score":1}' }], usage: { input: 10, output: 4, totalTokens: 14, cost: { total: 0.0042 } }, stopReason: 'stop' } }));
`);
    chmodSync(bin, 0o755);
    const spend: number[] = [];
    const client = new PiCliChatClient(bin, (usd) => spend.push(usd));
    const result = await client.chat(modelRoute("local-provider", "judge"), "grade", 100, 0);
    expect(result.content).toBe('{"score":1}');
    expect(result.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, costUsd: 0.0042 });
    expect(spend).toEqual([0.0042]);
  });
});
