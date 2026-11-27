// Terminal prompts, update prompts and the stdio MCP server. No network: a local HTTP server stands in
// for the npm registry.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { terminalPrompter } from "../src/cli/prompt.ts";
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

test("--help after a command prints the usage instead of failing", () => {
  const home = mkdtempSync(join(tmpdir(), "openmerit-help-"));
  for (const args of [["setup", "--help"], ["connect", "-h"]]) {
    const out = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1" } });
    assert.match(out, /Setup options/);
  }
});

test("setup registers openmerit mcp with the claude on PATH, leaves an existing entry alone, and says how to get a server", () => {
  const bin = mkdtempSync(join(tmpdir(), "openmerit-bin-"));
  const calls = join(bin, "calls");
  // A fake claude: `mcp get openmerit` fails until `mcp add` ran.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> ${calls}\nif [ "$1 $2" = "mcp get" ]; then [ -f ${bin}/added ]; exit $?; fi\nif [ "$1 $2" = "mcp add" ]; then touch ${bin}/added; fi\nexit 0\n`, { mode: 0o755 });
  const setup = () => execFileSync(process.execPath, [cli, "setup", "--yes"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, OPENMERIT_CODEX_BIN: join(bin, "no-codex"), OPENMERIT_HOME: mkdtempSync(join(tmpdir(), "openmerit-home-")), OPENMERIT_NO_UPDATE_CHECK: "1", OPENMERIT_TELEMETRY: "0" } });
  setup();
  setup();
  const lines = execFileSync("cat", [calls], { encoding: "utf8" }).trim().split("\n").filter(line => line.startsWith("mcp"));
  assert.deepEqual(lines.filter(line => line.startsWith("mcp add")).length, 1, "the second setup left the entry alone");
  assert.match(lines.find(line => line.startsWith("mcp add"))!, /^mcp add --scope user openmerit -- .+ mcp$/);
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

test("OpenMerit Harness runs the user's own Claude Code: OPENMERIT_CLAUDE_BIN, else claude on the PATH", () => {
  assert.equal(claudeBinary({ OPENMERIT_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  const bin = mkdtempSync(join(tmpdir(), "openmerit-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(claudeBinary({ PATH: bin }), join(bin, "claude"));
  assert.equal(claudeBinary({ PATH: mkdtempSync(join(tmpdir(), "openmerit-empty-")) }), "claude", "no claude installed: the bare name, which connect reports as not installed");
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

test("openmerit mcp forwards each message to the server's /mcp with the CLI's token, and says how to get a server when there is none", async () => {
  const seen: { auth: string | undefined; session: string | undefined; body: { method?: string } }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method?: string };
      seen.push({ auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined, body: message });
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
        : message.method === "tools/call" ? { content: [{ type: "text", text: "held" }], structuredContent: { status: "held" } } : { tools: [{ name: "from_server" }] };
      res.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": "s-1" } : {}) });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const mcp = async (env: Record<string, string>) => {
    const home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
    const child = spawn(process.execPath, [cli, "mcp"], { env: { ...process.env, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1", OPENMERIT_TELEMETRY: "0", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    // The next messages wait for initialize's reply, as a client does, so they carry its session.
    await new Promise<void>(resolve => { const check = () => (stdout.includes("\n") ? resolve() : setTimeout(check, 20)); check(); });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "tools/call", params: { name: "openmerit_tasks", arguments: {} } });
    child.stdin.end();
    await new Promise(resolve => child.on("close", resolve));
    const messages = stdout.trim().split("\n").map(line => JSON.parse(line) as { jsonrpc?: string; id?: number; result?: Record<string, unknown> });
    assert.ok(messages.every(message => message.jsonrpc === "2.0"), "every stdout line is a JSON-RPC message");
    return (id: number) => messages.find(message => message.id === id)!.result!;
  };
  try {
    const proxied = await mcp({ OPENMERIT_SERVER: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, OPENMERIT_TOKEN: "tok" });
    assert.deepEqual((proxied(1).serverInfo as { name: string }).name, "fake", "initialize is the server's");
    assert.deepEqual(proxied(2).tools, [{ name: "from_server" }]);
    assert.deepEqual(proxied(3).structuredContent, { status: "held" });
    assert.deepEqual(seen.map(request => request.body.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    assert.ok(seen.every(request => request.auth === "Bearer tok"), "every request carries the CLI's token");
    assert.deepEqual(seen.slice(1).map(request => request.session), ["s-1", "s-1", "s-1"], "later requests carry the session initialize returned");

    const alone = await mcp({});
    assert.match(String(alone(1).instructions), /openmerit login/);
    assert.ok((alone(2).tools as { name: string }[]).some(tool => tool.name === "openmerit_recommend"), "tools/list works before there is a server");
    assert.equal(alone(3).isError, true);
    assert.match(String((alone(3).content as { text: string }[])[0]!.text), /openmerit login.*openmerit server start/);
  } finally { server.close(); }
});
