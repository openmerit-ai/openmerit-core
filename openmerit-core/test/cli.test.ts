// Update prompts, the stdio MCP server and the read-only Langfuse connector. No network: a local
// HTTP server stands in for the npm registry, and Langfuse is a fake fetch.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createLangfuseConnector } from "../src/connectors/langfuse/index.ts";
import { claudeBinary } from "../src/harness/claude-bridge.ts";
import { checkForUpdate, newer, offerUpdate, packageVersion } from "../src/update.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

test("version comparison, and offline or failing registries continue on the installed version", async () => {
  assert.ok(newer("0.4.10", "0.4.9"));
  assert.ok(!newer("0.4.9", "0.4.10"));
  assert.ok(!newer("0.4.1", "0.4.1"));
  assert.ok(newer("0.4.1", "0.4.1-beta.1"));
  assert.deepEqual(await checkForUpdate({}, offline).then(info => [info.available, info.latest, info.current]), [false, null, packageVersion()]);
  const missing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  assert.equal((await checkForUpdate({}, missing)).available, false);
});

test("Claude Code login runs the executable bundled with the Claude Agent SDK, so no `claude` on PATH is needed", () => {
  const binary = claudeBinary({});
  assert.ok(isAbsolute(binary) && existsSync(binary), `expected the bundled executable, got ${binary}`);
  assert.equal(claudeBinary({ OPENMERIT_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
});

test("an update installs only with approval and continues on the chosen version", async () => {
  const info = { current: "0.4.1", latest: "0.4.2", available: true };
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const argv = ["history"];
  assert.equal(await offerUpdate(info, { interactive: true, confirm: async () => false, log, argv, env: { ...process.env, OPENMERIT_NPM: "false" } }), null);
  assert.match(lines.at(-1)!, /Continuing with openmerit 0\.4\.1/);
  assert.equal(await offerUpdate(info, { interactive: true, confirm: async () => true, log, argv, env: { ...process.env, OPENMERIT_NPM: "false" } }), null, "a failed install continues on the installed version");
  assert.match(lines.at(-1)!, /did not install/);
  assert.equal(await offerUpdate(info, { interactive: true, confirm: async () => true, log, argv, env: { ...process.env, OPENMERIT_NPM: "true", OPENMERIT_BIN: "true" } }), 0, "the updated binary takes over");
  let asked = false;
  assert.equal(await offerUpdate(info, { interactive: false, confirm: async () => (asked = true), log, argv }), null);
  assert.equal(asked, false, "non-interactive use never prompts");
});

test("the MCP server keeps stdout to protocol messages and reports an available update through the client", async () => {
  const registry = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ version: "99.0.0" })); });
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const repo = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const child = spawn(process.execPath, [cli, "mcp"], { cwd: repo, env: { ...process.env, OPENMERIT_HOME: home, OPENMERIT_REGISTRY: `http://127.0.0.1:${(registry.address() as AddressInfo).port}` }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "openmerit_history", arguments: { cwd: repo } } });
  send({ id: 4, method: "tools/call", params: { name: "openmerit_scout", arguments: { cwd: repo } } });
  child.stdin.end();
  await new Promise(resolve => child.on("close", resolve));
  registry.close();
  const messages = stdout.trim().split("\n").map(line => JSON.parse(line) as { id?: number; method?: string; params?: { data?: string }; result?: Record<string, unknown> });
  assert.ok(messages.every(message => (message as { jsonrpc?: string }).jsonrpc === "2.0"), "every stdout line is a JSON-RPC message");
  const byId = (id: number) => messages.find(message => message.id === id)!.result!;
  assert.match(String(byId(1).instructions), /99\.0\.0/);
  assert.ok(messages.some(message => message.method === "notifications/message" && /99\.0\.0/.test(String(message.params?.data))));
  const tools = byId(2).tools as { name: string; annotations: { readOnlyHint: boolean } }[];
  assert.deepEqual(tools.map(tool => [tool.name, tool.annotations.readOnlyHint]), [["openmerit_status", true], ["openmerit_scout", false], ["openmerit_history", true]]);
  assert.deepEqual((byId(3).structuredContent as { runs: unknown[] }).runs, []);
  const scout = byId(4).structuredContent as { status: string; missing: string[] };
  assert.equal(scout.status, "needs_setup", "missing setup is a structured answer, not a terminal prompt");
  assert.equal(scout.missing.length, 2);
});

test("the Langfuse connector only reads, and accepts nothing but a Viewer key", async () => {
  const calls: { method: string; path: string; body?: string }[] = [];
  const fake = (status: number) => (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (init?.method === "POST") return new Response(JSON.stringify({ message: "nope" }), { status });
    if (url.pathname.endsWith("/projects")) return Response.json({ data: [{ id: "p1", name: "support" }] });
    const query = JSON.parse(url.searchParams.get("query")!) as { view: string };
    return Response.json({ data: query.view === "observations" ? [{ providedModelName: "gpt-4.1-mini", count_count: 40, sum_totalCost: 0.12, p50_latency: 900 }] : [{ name: "queue-correct", avg_value: 0.92, count_count: 40 }] });
  }) as unknown as typeof fetch;
  const connection = { baseUrl: "https://langfuse.internal/lf", publicKey: "pk-lf-x", secretKey: "sk-lf-x" };
  await assert.rejects(createLangfuseConnector(connection, { fetch: fake(400), retries: 0 }).verifyViewer(), /can write/);
  calls.length = 0;
  const viewer = createLangfuseConnector(connection, { fetch: fake(403), retries: 0 });
  await viewer.verifyViewer();
  const evidence = await viewer.taskEvidence({ traceName: "classify-ticket", scores: ["queue-correct"] });
  assert.deepEqual(evidence.models, [{ model: "gpt-4.1-mini", generations: 40, costUsd: 0.12, p50LatencyMs: 900 }]);
  assert.deepEqual(evidence.scores, [{ name: "queue-correct", average: 0.92, count: 40 }]);
  // The only write-shaped request is the invalid {} probe; everything else is a GET on the self-hosted path prefix.
  assert.deepEqual(calls.filter(call => call.method !== "GET"), [{ method: "POST", path: "/lf/api/public/v2/datasets", body: "{}" }]);
  assert.ok(calls.every(call => call.path.startsWith("/lf/api/public/")));
});
