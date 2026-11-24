// Terminal prompts, update prompts and the stdio MCP server. No network: a local HTTP server stands in
// for the npm registry.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askQuestion, terminalPrompter } from "../src/cli/prompt.ts";
import { GRADE_HINT, type Question, readGrade } from "../src/scout/workflow.ts";
import { claudeBinary } from "../src/harness/claude-bridge.ts";
import { checkForUpdate, newer, offerUpdate, packageVersion } from "../src/update.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
test("a secret typed at a terminal prompt is not echoed", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  let shown = "";
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.on("data", chunk => { shown += String(chunk); });
  const prompter = terminalPrompter(input, output);
  const answer = prompter.secret("API key (input hidden):");
  input.write("sk-typed-secret\r");
  assert.equal(await answer, "sk-typed-secret");
  const name = prompter.ask("Name?");
  input.write("visible\r");
  assert.equal(await name, "visible");
  prompter.close();
  assert.ok(shown.includes("API key (input hidden):") && shown.includes("visible"), shown);
  assert.ok(!shown.includes("sk-typed-secret"), shown);
});

test("a grade typed at the terminal keeps its note", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
  const prompter = terminalPrompter(input, output);
  const question: Question = { id: "grade_t_r1_1", kind: "choice", prompt: "t, answer 1 of 2: does it look right?", options: [{ value: "good", label: "Looks good" }, { value: "bad", label: "Doesn't look right" }], hint: GRADE_HINT };
  const typed = async (line: string) => { const answer = askQuestion(prompter, question, () => {}); input.write(`${line}\r`); return answer; };
  assert.deepEqual(readGrade(await typed("2: the finding names code ALL, which is not a code")), { verdict: "bad", note: "the finding names code ALL, which is not a code" });
  assert.deepEqual(readGrade(await typed("1")), { verdict: "good" });
  assert.deepEqual(readGrade(await typed("bad")), { verdict: "bad" });
  prompter.close();
});

test("--help after a command prints the usage instead of failing", () => {
  const home = mkdtempSync(join(tmpdir(), "openmerit-help-"));
  for (const args of [["setup", "--help"], ["scout", "-h"]]) {
    const out = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1" } });
    assert.match(out, /Setup options/);
  }
});

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
