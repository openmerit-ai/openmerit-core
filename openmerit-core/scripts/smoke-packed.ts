// Packs this package, installs the tarball globally into a temporary prefix, and runs the
// self-hosted flow with the installed `openmerit` binary: connect api, setup, scout (scan, map,
// approve, binary search, compare), history and the MCP server's tools/list. It also imports
// `openmerit/engine` and `openmerit/ranking` from a project that depends on the installed package. The harness and the
// candidate endpoint are a local fake OpenAI server, so no model is called. CI runs it on Linux
// x64 and arm64 and on macOS arm64 and x64; locally: `node scripts/smoke-packed.ts` from
// openmerit-core/ after `npm ci`.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const pkg = new URL("../", import.meta.url).pathname;
const fixture = join(pkg, "test/fixtures/support-app");
const version = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version;
const tickets = new Map(readFileSync(join(fixture, "data/tickets.jsonl"), "utf8").trim().split("\n").map(line => { const item = JSON.parse(line) as { ticket: string; queue: string }; return [item.ticket, item.queue]; }));
const run = promisify(execFile);
const started = Date.now();
const say = (line: string) => process.stdout.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);

// The same replies as the fake in test/daemon.test.ts, without its file-read round. /harness/v1 is
// the harness (streamed chat completions); /v1 is the candidate endpoint, where every model answers
// correctly except gpt-4o-mini, so the eval separates the models.
const sse = (chunks: object[]) => `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
function harnessContent(messages: { role: string; content: unknown }[]): string {
  const text = JSON.stringify(messages);
  if (text.includes("map model usages")) {
    const prompt = String(messages.find(message => message.role === "user")!.content);
    const tasks = new Map<string, string[]>();
    for (const [, id, file] of prompt.matchAll(/^### (u\d+) model[^\n]* at ([^:\n]+):\d+$/gm)) {
      const name = file!.includes("classify") ? "ticket classifier" : file!.includes("draft") ? "reply drafter" : "escalation router";
      tasks.set(name, [...(tasks.get(name) ?? []), id!]);
    }
    return JSON.stringify({ tasks: [...tasks].map(([name, usageIds]) => ({ name, description: `the ${name}`, usageIds, usesTools: false, needsVision: false, structuredOutput: false })) });
  }
  if (text.includes("reviewing an application's code")) return JSON.stringify({ description: "Routes a ticket", input: "a ticket", steps: [], criteria: ["Picks the right queue"], guardrails: [], system: "", user: "{{ticket}}", tools: [], output: { kind: "label", labels: ["billing", "technical", "account", "other"], schemaJson: "" }, examples: [], maxTurns: 0 });
  if (text.includes("You write test cases")) return JSON.stringify({ cases: [] });
  if (text.includes("eval")) return JSON.stringify({ found: true, command: "node evals/classify.eval.ts", cwd: ".", env: [{ name: "CLASSIFIER_MODEL", value: "{{model}}" }], threshold: null, helpers: [], explanation: "npm run eval:classify", missing: "" });
  return JSON.stringify({ status: "OPENMERIT_READY", harness: "fake" });
}
let endpointRequests = 0;
const telemetry: { api_key: string; properties: { command: string; surface: string } }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.url === "/i/v0/e/") { telemetry.push(JSON.parse(body) as typeof telemetry[number]); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"status\":\"Ok\"}"); return; }
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [] })); return; }
    const parsed = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[] };
    if (req.url?.startsWith("/harness/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: harnessContent(parsed.messages) }, finish_reason: null }] },
        { id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "h", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }]));
      return;
    }
    endpointRequests++;
    const ticket = String(parsed.messages.find(message => message.role === "user")!.content);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: parsed.model === "gpt-4o-mini" ? "other" : tickets.get(ticket) ?? "other" } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
});

// realpath: macOS's tmpdir is a symlink, and the CLI reports repositories by their real path.
const work = realpathSync(mkdtempSync(join(tmpdir(), "openmerit-smoke-")));
const prefix = join(work, "prefix");
const home = join(work, "home");
const repo = join(work, "app");
const bin = join(prefix, "bin", "openmerit");
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPENMERIT_|^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GOOGLE)_API_KEY$/.test(key)));
const env: Record<string, string | undefined> = {
  ...inherited, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1",
  // The installed package would send telemetry to the production project.
  OPENMERIT_TELEMETRY: "0", DO_NOT_TRACK: "1",
  OPENMERIT_DAEMON_PORT: String(21000 + Math.floor(Math.random() * 8000)), FAKE_KEY: "sk-fake",
};

/** Runs the installed CLI in the fixture repository with stdin closed, so it never prompts. */
async function openmerit(...args: string[]): Promise<string> {
  say(`openmerit ${args.join(" ")}`);
  const child = run(bin, args, { cwd: repo, env, timeout: 180_000, maxBuffer: 16 << 20 });
  child.child.stdin?.end();
  try { return (await child).stdout; } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`openmerit ${args.join(" ")} failed: ${String(error)}\n--- stdout\n${stdout ?? ""}\n--- stderr\n${stderr ?? ""}`);
  }
}

/** Starts `openmerit mcp`, sends initialize and tools/list, and returns the tools/list result. */
async function mcpToolsList(): Promise<{ tools: { name: string }[] }> {
  say("openmerit mcp: initialize, tools/list");
  const child = spawn(bin, ["mcp"], { cwd: repo, env, stdio: ["pipe", "pipe", "inherit"] });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    const reply = new Promise<{ result?: { tools: { name: string }[] }; error?: unknown }>((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line) as { id?: number; result?: { tools: { name: string }[] }; error?: unknown };
        if (message.id === 2) resolve(message);
      });
      child.on("exit", code => reject(new Error(`openmerit mcp exited with ${code} before answering tools/list`)));
      setTimeout(() => reject(new Error("openmerit mcp did not answer tools/list within 30 s")), 30_000).unref();
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const message = await reply;
    assert.ok(message.result, `tools/list failed: ${JSON.stringify(message.error)}`);
    return message.result;
  } finally { child.kill(); }
}

let failed = false;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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

  cpSync(fixture, repo, { recursive: true });
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "fixture"]]) await run("git", args, { cwd: repo });
  assert.equal((await openmerit("--version")).trim(), version);
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `${base}/harness/v1`, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "harness" }] } } }));

  await openmerit("connect", "api", "--api-provider", "fake", "--api-model", "harness", "--api-key-env", "FAKE_KEY", "--yes");
  await openmerit("setup", "--yes", "--no-register-mcp", "--endpoint", `fake=${base}/v1:FAKE_KEY`, "--allowed-models", "gpt-4.1-mini,gpt-5-nano,gpt-6-luna,gpt-4o-mini,gpt-5.6-luna,gpt-5.4-nano");

  // One CLI call per question, as an agent answering --json questions would.
  const answers: Record<string, string> = { model: "openai/gpt-4.1-mini", corrections: "", tasks: "ticket classifier", approve_evals: "true", retry_units: "false", configure_ticket_classifier: "false" };
  type Step = { runId: string; status: string; questions: { id: string }[]; error?: string; result?: { tasks: { task: string; status: string; baseline: { score: number | null } | null; top: { model: string }[]; search?: { status: string; pick: string | null; trials: { model: string; accepted: boolean }[] } }[] } };
  let step = JSON.parse(await openmerit("scout", "--json")) as Step;
  const runId = step.runId;
  const asked: string[] = [];
  for (let guard = 0; step.status === "needs_input" && guard < 10; guard++) {
    asked.push(...step.questions.map(question => question.id));
    const flags = step.questions.flatMap(question => {
      assert.ok(question.id in answers, `unexpected question ${question.id}`);
      return ["--answer", `${question.id}=${answers[question.id]}`];
    });
    step = JSON.parse(await openmerit("scout", "--resume", runId, "--json", ...flags)) as Step;
  }
  assert.equal(step.status, "done", step.error ?? JSON.stringify(step.questions));
  for (const id of ["model", "tasks", "approve_evals", "configure_ticket_classifier"]) assert.ok(asked.includes(id), `scout asked ${id}`);
  const [task] = step.result!.tasks;
  assert.equal(task?.task, "ticket classifier");
  assert.equal(task.status, "ranked", task.status);
  assert.equal(task.search?.status, "selected");
  assert.ok(task.search.pick, "the binary search picked a model");
  assert.ok(task.search.trials.some(trial => trial.model.endsWith("gpt-4o-mini") && !trial.accepted), "the search rejected gpt-4o-mini, which answers wrongly");
  assert.ok(task.top.length > 0 && task.top.every(model => !model.model.endsWith("gpt-4o-mini")), "the comparison ranked only passing models");
  assert.ok(endpointRequests > 0, "the evals called the fake endpoint");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo })).stdout, "", "declining configure left the code unchanged");

  const runs = JSON.parse(await openmerit("history", "--json")) as { id: string; status: string }[];
  assert.equal(runs.find(item => item.id === runId)?.status, "done");
  assert.match(await openmerit("history", runId), new RegExp(`Run ${runId}`));

  const { tools } = await mcpToolsList();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["openmerit_answer", "openmerit_confirmation", "openmerit_eval", "openmerit_eval_command", "openmerit_recommend", "openmerit_result", "openmerit_retire", "openmerit_tasks"], "openmerit mcp lists the server's tools before there is a server");
  // Telemetry is off above. The installed package sends to the production project; here only to this fake.
  assert.equal(telemetry.length, 0, "the opted-out commands sent no telemetry");
  const tracking = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !["CI", "DO_NOT_TRACK", "OPENMERIT_TELEMETRY"].includes(key))), OPENMERIT_POSTHOG_HOST: base };
  say("openmerit history --json, with telemetry on");
  await run(bin, ["history", "--json"], { cwd: repo, env: tracking });
  assert.deepEqual(telemetry.map(event => [event.api_key, event.properties.command, event.properties.surface]), [["phc_uGqGVy96bhXQsq59dsx4Wt5N7zSG2zYs3xBT2jqY4KKB", "history", "cli"]], "the installed package uses the production token");
  say(`passed: run ${runId} picked ${task.search.pick}; top ${task.top.map(model => model.model).join(", ")}; ${endpointRequests} endpoint requests`);
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  const log = join(home, "daemon.log");
  // Without Rivet's per-transaction "SQLite transaction is unnamed" warnings, which crowd out the rest.
  if (existsSync(log)) process.stderr.write(`--- end of ${log}\n${readFileSync(log, "utf8").split("\n").filter(line => !line.includes("SQLite transaction is unnamed")).slice(-60).join("\n")}\n`);
} finally {
  if (existsSync(bin)) await run(bin, ["daemon", "stop"], { env }).catch(() => {});
  server.close();
  // The daemon's Rivet store is about 130 MB and the install about 700 MB.
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
