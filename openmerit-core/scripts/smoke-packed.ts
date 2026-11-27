// Packs this package, installs the tarball globally into a temporary prefix, and runs the self-hosted
// flow with the installed `openmerit` binary: `server start` (the server, its engine and the web app),
// whoami, a job started with `openmerit recommend` up to its first question, `openmerit mcp` against
// the server, and `server stop`. It also imports `openmerit/engine` and `openmerit/ranking` from a
// project that depends on the installed package. OpenRouter is the server tests' local fake, so no
// model is called. CI runs it on Linux x64 and arm64 and on macOS arm64 and x64; locally:
// `node scripts/smoke-packed.ts` from openmerit-core/ after `npm ci`.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { bundle, fakeModels } from "../test/server/helpers.ts";

const pkg = new URL("../", import.meta.url).pathname;
const version = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version;
const run = promisify(execFile);
const started = Date.now();
const say = (line: string) => process.stdout.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);

const telemetry: { api_key: string; properties: { command: string; surface: string } }[] = [];
const posthog = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => { telemetry.push(JSON.parse(body) as typeof telemetry[number]); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"status\":\"Ok\"}"); });
});

// realpath: macOS's tmpdir is a symlink.
const work = realpathSync(mkdtempSync(join(tmpdir(), "openmerit-smoke-")));
const prefix = join(work, "prefix");
const home = join(work, "home");
const bin = join(prefix, "bin", "openmerit");
const port = 21000 + Math.floor(Math.random() * 8000);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPENMERIT_|^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GOOGLE)_API_KEY$/.test(key)));
const env: Record<string, string | undefined> = {
  ...inherited, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1",
  // The installed package would send telemetry to the production project.
  OPENMERIT_TELEMETRY: "0", DO_NOT_TRACK: "1", RIVET_LOG_LEVEL: "error",
};

/** Runs the installed CLI with stdin closed, so it never prompts. */
async function openmerit(...args: string[]): Promise<string> {
  say(`openmerit ${args.join(" ")}`);
  const child = run(bin, args, { cwd: work, env, timeout: 180_000, maxBuffer: 16 << 20 });
  child.child.stdin?.end();
  try { return (await child).stdout; } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`openmerit ${args.join(" ")} failed: ${String(error)}\n--- stdout\n${stdout ?? ""}\n--- stderr\n${stderr ?? ""}`);
  }
}

/** Starts `openmerit mcp`, initializes it and returns its tools/list and one openmerit_tasks call. */
async function mcp(): Promise<{ tools: { name: string }[]; tasks: { content: { text: string }[]; isError?: boolean } }> {
  say("openmerit mcp: initialize, tools/list, tools/call openmerit_tasks");
  const child = spawn(bin, ["mcp"], { cwd: work, env, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  const ask = <T>(id: number, method: string, params?: object) => new Promise<T>((resolve, reject) => {
    replies.set(id, message => (message.result ? resolve(message.result as T) : reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`))));
    setTimeout(() => reject(new Error(`openmerit mcp did not answer ${method} within 30 s`)), 30_000).unref();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { tools } = await ask<{ tools: { name: string }[] }>(2, "tools/list");
    const tasks = await ask<{ content: { text: string }[]; isError?: boolean }>(3, "tools/call", { name: "openmerit_tasks", arguments: {} });
    return { tools, tasks };
  } finally { child.kill(); }
}

const models = await fakeModels();
let failed = false;
try {
  await new Promise<void>(resolve => posthog.listen(0, "127.0.0.1", resolve));
  Object.assign(env, { OPENROUTER_API_KEY: "or-smoke", OPENROUTER_BASE_URL: models.url, OPENMERIT_ALLOW_PRIVATE_ENDPOINTS: "1" });

  say("npm pack (runs the build)");
  // Not --json: the prepack build also prints to stdout.
  await run("npm", ["pack", "--pack-destination", work], { cwd: pkg, maxBuffer: 16 << 20 });
  const tarball = join(work, `openmerit-${version}.tgz`);
  // An empty npm cache, as on a machine that never installed these packages: every dependency,
  // including the platform's engine binary, comes from the registry.
  say(`npm install -g openmerit-${version}.tgz (empty npm cache)`);
  const installed = Date.now();
  await run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { cwd: work, env: { ...process.env, npm_config_cache: join(work, "npm-cache") }, maxBuffer: 16 << 20 });
  const [installMb, cacheMb] = (await run("du", ["-sk", prefix, join(work, "npm-cache")])).stdout.trim().split("\n").map(line => Math.round(Number(line.split("\t")[0]) / 1024));
  say(`installed ${process.platform}-${process.arch} in ${((Date.now() - installed) / 1000).toFixed(1)}s: ${installMb} MB installed, ${cacheMb} MB downloaded into the npm cache`);

  // The library entry points resolve from a project that depends on the installed package.
  const consumer = join(work, "consumer");
  mkdirSync(join(consumer, "node_modules"), { recursive: true });
  symlinkSync(join(prefix, "lib", "node_modules", "openmerit"), join(consumer, "node_modules", "openmerit"), "dir");
  const exported = (await run(process.execPath, ["--input-type=module", "-e", `const engine = await import("openmerit/engine"); const root = await import("openmerit"); console.log(JSON.stringify({ engine: Object.keys(engine).sort(), redact: root.redact === engine.redact }));`], { cwd: consumer })).stdout;
  const { engine, redact } = JSON.parse(exported) as { engine: string[]; redact: boolean };
  for (const name of ["binarySearch", "challengers", "order", "ladder", "MemoryLedger", "resolveGuardrails", "checkAgent", "redact"]) assert.ok(engine.includes(name), `openmerit/engine exports ${name}`);
  assert.ok(redact, "openmerit and openmerit/engine export the same redact");
  assert.ok(existsSync(join(consumer, "node_modules", "openmerit", "dist", "engine", "index.d.ts")), "openmerit/engine ships its types");
  say(`openmerit/engine exports ${engine.length} names`);
  const ranking = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", `console.log(JSON.stringify(Object.keys(await import("openmerit/ranking"))))`], { cwd: consumer })).stdout) as string[];
  for (const name of ["createClient", "createMeasure", "writeCases", "runCase", "graderFor", "judge", "MemoryLedger"]) assert.ok(ranking.includes(name), `openmerit/ranking exports ${name}`);
  assert.ok(existsSync(join(consumer, "node_modules", "openmerit", "dist", "ranking", "index.d.ts")), "openmerit/ranking ships its types");
  say(`openmerit/ranking exports ${ranking.length} names`);

  assert.equal((await openmerit("--version")).trim(), version);
  const noServer = await mcp();
  assert.deepEqual(noServer.tools.map(tool => tool.name).sort(), ["openmerit_answer", "openmerit_confirmation", "openmerit_eval", "openmerit_eval_command", "openmerit_recommend", "openmerit_result", "openmerit_retire", "openmerit_tasks"], "openmerit mcp lists the server's tools before there is a server");
  assert.ok(noServer.tasks.isError && /openmerit server start/.test(noServer.tasks.content[0]!.text), "without a server, a tool call says how to get one");

  const link = /https?:\/\/\S+\/signin\?code=\S+/.exec(await openmerit("server", "start", "--port", String(port)))?.[0];
  assert.ok(link, "server start prints a sign-in link");
  const url = `http://localhost:${port}`;
  assert.match(await openmerit("server", "status"), new RegExp(`^running: ${url}`));
  assert.match(await (await fetch(`${url}/`)).text(), /<html/i, "the server serves the web app");
  // A coding agent's new endpoint waits, sealed with the server's own key, for the person; it opens after a restart.
  const token = readFileSync(join(home, "server", "token"), "utf8").trim();
  const endpoint = { kind: "openai-compatible", baseUrl: `${models.url}/v1`, apiKey: "sk-smoke-endpoint", allowedModels: ["openai/gpt-5-nano"] };
  const held = await (await fetch(`${url}/api/endpoints`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(endpoint) })).json() as { status: string; confirmation: { id: string } };
  assert.equal(held.status, "needs_confirmation", JSON.stringify(held));
  const keyFile = join(home, "server", "key");
  const key = readFileSync(keyFile, "utf8");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, "the key is readable by its owner only");
  await openmerit("server", "stop");
  const again = /https?:\/\/\S+\/signin\?code=\S+/.exec(await openmerit("server", "start", "--port", String(port)))![0];
  assert.equal(readFileSync(keyFile, "utf8"), key, "a restart keeps the key");
  const opened = await fetch(again, { redirect: "manual" });
  assert.equal(opened.status, 303, "the sign-in link opens a browser session");
  assert.equal((await fetch(link, { redirect: "manual" })).status, 401, "the first server's link no longer works");
  const person = { cookie: opened.headers.get("set-cookie")!.split(";")[0]!, origin: url, "content-type": "application/json" };
  const confirmed = await (await fetch(`${url}/api/confirmations/${held.confirmation.id}`, { method: "POST", headers: person, body: JSON.stringify({ confirm: true }) })).json() as { status: string };
  assert.equal(confirmed.status, "done", `the person confirmed the endpoint: ${JSON.stringify(confirmed)}`);
  const endpoints = await (await fetch(`${url}/api/endpoints`, { headers: person })).json() as { baseUrl: string; keyLast4: string }[];
  assert.ok(endpoints.some(item => item.baseUrl === endpoint.baseUrl), `the endpoint was saved: ${JSON.stringify(endpoints)}`);

  const me = JSON.parse(await openmerit("whoami", "--json")) as { server: string; mode: string };
  assert.deepEqual([me.server, me.mode], [url, "self-hosted"]);
  const bundleFile = join(work, "bundle.json");
  writeFileSync(bundleFile, JSON.stringify({ bundle: bundle(), environment: "acme/support" }));
  const startedJob = JSON.parse(await openmerit("recommend", "--input", `@${bundleFile}`, "--json")) as { job_id?: string };
  assert.ok(startedJob.job_id, JSON.stringify(startedJob));
  // The label check is the job's first question: the server wrote cases on the fake OpenRouter and waits for the person.
  let status = "";
  for (let waited = 0; status !== "needs_input" && waited < 120_000; waited += 2000) {
    status = String((JSON.parse(await openmerit("result", "--job-id", startedJob.job_id, "--json")) as { status?: string }).status);
    if (status === "failed" || status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(status, "needs_input", "the job reached its label check");
  assert.ok(models.calls.length > 0, "the server called the fake OpenRouter");
  const withServer = await mcp();
  assert.match(withServer.tasks.content[0]!.text, /ticket classifier/, "openmerit mcp reaches the server and lists the task");

  // Telemetry is off above. The installed package sends to the production project; here only to this fake.
  assert.equal(telemetry.length, 0, "the opted-out commands sent no telemetry");
  const tracking = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !["CI", "DO_NOT_TRACK", "OPENMERIT_TELEMETRY"].includes(key))), OPENMERIT_POSTHOG_HOST: `http://127.0.0.1:${(posthog.address() as AddressInfo).port}` };
  say("openmerit whoami, with telemetry on");
  await run(bin, ["whoami"], { cwd: work, env: tracking });
  assert.deepEqual(telemetry.map(event => [event.api_key, event.properties.command, event.properties.surface]), [["phc_uGqGVy96bhXQsq59dsx4Wt5N7zSG2zYs3xBT2jqY4KKB", "whoami", "cli"]], "the installed package uses the production token");

  await openmerit("server", "stop");
  assert.equal((await openmerit("server", "status")).trim(), "not running");
  say(`passed: job ${startedJob.job_id} reached its label check; ${models.calls.length} model requests`);
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  const log = join(home, "server", "server.log");
  // Without Rivet's per-transaction "SQLite transaction is unnamed" warnings, which crowd out the rest.
  if (existsSync(log)) process.stderr.write(`--- end of ${log}\n${readFileSync(log, "utf8").split("\n").filter(line => !line.includes("SQLite transaction is unnamed")).slice(-60).join("\n")}\n`);
} finally {
  if (existsSync(bin)) await run(bin, ["server", "stop"], { env }).catch(() => {});
  posthog.close();
  await models.close();
  // The server's engine store is about 130 MB and the install about 700 MB.
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
