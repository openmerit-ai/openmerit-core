import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHarness } from "./harness.ts";

const sse = (chunks: object[]) => `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

test("a reply that wraps its values in the schema's properties and drops a brace is asked for again once; cached prompt tokens count as input", async () => {
  // Claude Haiku 5.5 on OpenRouter answered eval discovery like this in 3 of 4 real runs.
  const replies = ['{"type":"object","properties":{"found":true,"command":"npm run eval:classify"}', '{"found":true,"command":"npm run eval:classify"}'];
  const requests: { role: string; content: unknown }[][] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push((JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: replies[requests.length - 1] }, finish_reason: null }] },
        { id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "h", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } } }]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "openmerit-harness-"));
  try {
    mkdirSync(join(home, "agent"));
    writeFileSync(join(home, "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "harness" }] } } }));
    const harness = await createHarness({ kind: "api", api: { provider: "fake", model: "harness", apiKey: { env: "FAKE_KEY" } } }, { OPENMERIT_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), FAKE_KEY: "sk-fake" });
    const schema = { type: "object", properties: { found: { type: "boolean" }, command: { type: "string" } }, required: ["found", "command"], additionalProperties: false };
    const reply = await harness.json<{ found: boolean; command: string }>({ system: "Find the eval.", prompt: "Which eval?", schema });
    assert.deepEqual(reply, { found: true, command: "npm run eval:classify" });
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]!.at(-1)), /did not reply with a JSON object/, "the second request says what was wrong with the first reply");
    assert.equal(harness.usage.inputTokens, 2000);
    assert.equal(harness.usage.calls, 2);

    // A second bad reply fails instead of asking again.
    replies.splice(0, 2, '{"type":"object","properties":{"found":true}}', '{"type":"object","properties":{"found":true}}');
    requests.length = 0;
    await assert.rejects(harness.json({ system: "Find the eval.", prompt: "Which eval?", schema }), /missing found, command/);
    assert.equal(requests.length, 2);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
