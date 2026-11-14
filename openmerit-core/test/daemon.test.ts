// Scout through the daemon: a real local Rivet engine, the CLI's client calls, and a SIGKILL of the
// daemon at every question. The harness and the candidate endpoint are a local fake OpenAI server,
// so no real model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { renderStep } from "../src/cli/render.ts";
import { advanceInDaemon, DaemonStartError, ensureDaemon, readDaemonInfo, stopDaemon } from "../src/daemon/daemon.ts";
import { localContext, startRun } from "../src/local.ts";
import type { Answer, Step } from "../src/scout/workflow.ts";
import { updateGlobalConfig, updateRepoConfig } from "../src/state/config.ts";
import { State } from "../src/state/db.ts";

const fixture = new URL("./fixtures/support-app/", import.meta.url).pathname;
const tickets = new Map(readFileSync(join(fixture, "data/tickets.jsonl"), "utf8").trim().split("\n").map(line => { const item = JSON.parse(line) as { ticket: string; queue: string }; return [item.ticket, item.queue]; }));

// Replies like the scripted harness in scout.test.ts. The harness is a pi API provider defined in
// pi's models.json (OpenAI chat completions, streamed). Before mapping usages it asks to read a
// file outside the repository and one inside it, to check that only the inside read succeeds.
function harnessReply(body: { messages: { role: string; content: unknown }[] }, outsidePath: string): { content: string } | { reads: string[] } {
  const text = JSON.stringify(body.messages);
  if (text.includes("map model usages")) {
    if (!body.messages.some(message => message.role === "tool")) return { reads: [outsidePath, "src/classify.ts"] };
    const prompt = String(body.messages.find(message => message.role === "user")!.content);
    const tasks = new Map<string, string[]>();
    for (const [, id, file] of prompt.matchAll(/^### (u\d+) model[^\n]* at ([^:\n]+):\d+$/gm)) {
      const name = file!.includes("classify") ? "ticket classifier" : file!.includes("draft") ? "reply drafter" : "escalation router";
      tasks.set(name, [...(tasks.get(name) ?? []), id!]);
    }
    return { content: JSON.stringify({ tasks: [...tasks].map(([name, usageIds]) => ({ name, description: `the ${name}`, usageIds, usesTools: false, needsVision: false, structuredOutput: false })) }) };
  }
  return { content: JSON.stringify({ found: true, command: "node evals/classify.eval.ts", cwd: ".", env: [{ name: "CLASSIFIER_MODEL", value: "{{model}}" }], threshold: null, langfuseDataset: "", passScore: "", passMin: null, helpers: [], explanation: "npm run eval:classify", missing: "" }) };
}

const sse = (chunks: object[]) => `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

const ANSWERS: Record<string, Answer> = { model: "openai/gpt-4.1-mini", corrections: "", tasks: ["ticket classifier"], approve_evals: true, retry_units: false, configure_ticket_classifier: false };

test("a run survives a SIGKILL of the daemon at every question, and the harness reads only inside the repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  const outside = `${root}-outside.txt`;
  writeFileSync(outside, "OUTSIDE-SECRET");
  const harnessCalls: string[] = [];
  const toolResults: string[] = [];
  // Every model answers correctly except gpt-4o-mini, so the eval separates the models.
  let requests = 0;
  const endpoint = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.url?.startsWith("/harness/")) {
        const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
        harnessCalls.push(JSON.stringify(parsed.messages).includes("map model usages") ? "map" : "discover");
        toolResults.push(...parsed.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)));
        const reply = harnessReply(parsed, `../${basename(outside)}`);
        const delta = "reads" in reply
          ? { role: "assistant", tool_calls: reply.reads.map((path, index) => ({ index, id: `call_${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } })) }
          : { role: "assistant", content: reply.content };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse([{ id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
          { id: "h", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "reads" in reply ? "tool_calls" : "stop" }] },
          { id: "h", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }]));
        return;
      }
      requests++;
      const parsed = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const ticket = parsed.messages.find(message => message.role === "user")!.content;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: parsed.model === "gpt-4o-mini" ? "other" : tickets.get(ticket) ?? "other" } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));

  cpSync(fixture, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  const home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANGFUSE_")));
  const env = { ...inherited, OPENMERIT_HOME: home, OPENMERIT_DAEMON_PORT: String(21000 + Math.floor(Math.random() * 8000)), OPENMERIT_NO_UPDATE_CHECK: "1", FAKE_ENDPOINT_KEY: "sk-fake" };
  const base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `${base}/harness/v1`, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "harness" }] } } }));
  updateGlobalConfig({ harness: { kind: "api", api: { provider: "fake", model: "harness", apiKey: { env: "FAKE_ENDPOINT_KEY" } } } }, env);
  updateRepoConfig(root, { endpoints: [{ id: "openai", kind: "openai", baseUrl: `${base}/v1`, apiKey: { env: "FAKE_ENDPOINT_KEY" }, allowedModels: ["gpt-5-nano", "gpt-6-luna", "gpt-4o-mini", "gpt-5.6-luna", "gpt-5.4-nano"] }] });
  const ctx = localContext({ cwd: root, env });
  const runId = startRun(ctx);
  ctx.state.close();
  // The CLI passes process.env itself, which is not a plain object; the test does the same.
  for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) delete process.env[key];
  Object.assign(process.env, env);
  const advance = (answers: Record<string, Answer>) => advanceInDaemon({ runId, cwd: root, env: process.env, answers, log: () => {} });

  const restart = async () => {
    const before = readDaemonInfo(env)!;
    process.kill(before.pid, "SIGKILL");
    for (let waited = 0; waited < 10_000; waited += 200) {
      try { await fetch(`http://127.0.0.1:${before.port}/health`, { signal: AbortSignal.timeout(500) }); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return before.pid;
  };

  try {
    let step: Step = await advance({});
    const asked: string[] = [];
    // At every question, kill the daemon; the answer starts a new one and the run continues from that question.
    for (let guard = 0; step.questions.length && guard < 20; guard++) {
      asked.push(...step.questions.map(question => question.id));
      const killed = await restart();
      step = await advance(Object.fromEntries(step.questions.map(question => [question.id, ANSWERS[question.id]!])));
      assert.notEqual(readDaemonInfo(env)!.pid, killed, "a new daemon was started");
    }
    assert.equal(step.status, "done", step.error ?? JSON.stringify(step.questions));
    for (const id of ["model", "tasks", "approve_evals"]) assert.ok(asked.includes(id), `the run asked ${id} and survived a restart there`);
    assert.ok(step.result!.tasks[0]!.top.length > 0, "the search ranked qualifying finalists");
    assert.ok(requests > 0);
    assert.doesNotMatch(readFileSync(join(home, "daemon.log"), "utf8"), /level=warn/, "rivetkit's warnings stay out of the daemon's log");

    assert.deepEqual(harnessCalls, ["map", "map", "discover"], "mapping (one file-read round) and eval discovery each ran once across the restarts");
    assert.equal(toolResults.length, 2);
    assert.match(toolResults[0]!, /reads only files inside/, "the read outside the repository was refused");
    assert.ok(!toolResults.join("").includes("OUTSIDE-SECRET"));
    assert.match(toolResults[1]!, /model/, "the read inside the repository returned the file");

    const state = new State(env);
    try {
      const events = state.events(runId).map(event => event.kind);
      assert.equal(events.filter(kind => kind === "scan").length, 1, "the scan before the restart did not run again");
      assert.equal(events.filter(kind => kind === "map").length, 1, "the mapping before the restart did not run again");
      assert.ok(state.units(runId).every(unit => unit.status === "done" && unit.attempts === 1), "no eval ran twice");
    } finally { state.close(); }
  } finally {
    await stopDaemon(env);
    endpoint.close();
    // The daemon's Rivet store is about 130 MB; repeated runs would fill the disk.
    for (const path of [root, outside, home]) rmSync(path, { recursive: true, force: true });
  }
});

const daemonEnv = (port: number) => ({ ...process.env, OPENMERIT_HOME: mkdtempSync(join(tmpdir(), "openmerit-home-")), OPENMERIT_DAEMON_PORT: String(port), OPENMERIT_NO_UPDATE_CHECK: "1" });
const randomPort = () => 21000 + Math.floor(Math.random() * 8000);

test("a run that fails in the daemon comes back as its failed step, which says how to resume it", { timeout: 60_000 }, async () => {
  const env = daemonEnv(randomPort());
  // A repository without model usages: the scan fails the run.
  const root = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  updateGlobalConfig({ harness: { kind: "codex" } }, env);
  const ctx = localContext({ cwd: root, env });
  const runId = startRun(ctx);
  ctx.state.close();
  try {
    const step = await advanceInDaemon({ runId, cwd: root, env, answers: {}, log: () => {} });
    assert.equal(step.status, "failed");
    assert.match(step.error ?? "", /No model usages found/);
    assert.match(renderStep(step), new RegExp(`failed at scan — No model usages found.*Resume with: openmerit scout --resume ${runId}`));
  } finally {
    await stopDaemon(env);
    for (const path of [root, env.OPENMERIT_HOME]) rmSync(path, { recursive: true, force: true });
  }
});

test("a daemon that cannot bind its engine's peer port fails at once with the cause, and is not a lost connection", { timeout: 60_000 }, async () => {
  const port = randomPort();
  const env = daemonEnv(port);
  // The engine's peer API listens on port + 1; another program holds it.
  const holder = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise<void>(resolve => holder.listen(port + 1, "127.0.0.1", resolve));
  const lines: string[] = [];
  const started = Date.now();
  try {
    await assert.rejects(advanceInDaemon({ runId: "run-start-failure", cwd: tmpdir(), env, answers: {}, log: line => lines.push(line) }), (error: Error) => {
      assert.match(error.message, new RegExp(`Port ${port + 1} on 127\\.0\\.0\\.1 is already in use`));
      assert.match(error.message, new RegExp(`OPENMERIT_DAEMON_PORT \\(${port}\\)`));
      assert.match(error.message, /openmerit scout --resume run-start-failure/);
      return true;
    });
    assert.ok(Date.now() - started < 20_000, `failed after ${Date.now() - started} ms, not after rivetkit's 60 s or the reconnects`);
    assert.deepEqual(lines, [], "no lost-connection or reconnect lines");
  } finally {
    holder.close();
    rmSync(env.OPENMERIT_HOME, { recursive: true, force: true });
  }
});

test("a second OpenMerit home on the same port does not use the first home's engine", { timeout: 60_000 }, async () => {
  const port = randomPort();
  const first = daemonEnv(port);
  const second = daemonEnv(port);
  try {
    await ensureDaemon(first);
    await assert.rejects(ensureDaemon(second), (error: Error) => {
      assert.ok(error instanceof DaemonStartError);
      assert.match(error.message, new RegExp(`Ports ${port}, ${port + 1} and ${port + 10} on 127\\.0\\.0\\.1 are already in use`));
      assert.match(error.message, /Set OPENMERIT_DAEMON_PORT to another port/);
      return true;
    });
    assert.equal(readDaemonInfo(second), null);
  } finally {
    await stopDaemon(first);
    for (const env of [first, second]) rmSync(env.OPENMERIT_HOME, { recursive: true, force: true });
  }
});

test("the next client replaces a frozen daemon, and a new daemon moves an oversized log aside and prunes old engine logs", { timeout: 90_000 }, async () => {
  const env = daemonEnv(randomPort());
  const home = env.OPENMERIT_HOME;
  const engineLogs = join(home, "rivet", ".rivetkit", "var", "logs", "rivet-engine");
  const pair = (start: number) => [`engine-${start}-stderr.log`, `engine-${start}-stdout.log`];
  mkdirSync(engineLogs, { recursive: true });
  for (let start = 100; start < 107; start++) for (const name of pair(start)) writeFileSync(join(engineLogs, name), "");
  writeFileSync(join(home, "daemon.log"), "x".repeat(6 * 1024 * 1024));
  const status = () => execFileSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "daemon", "status"], { env, encoding: "utf8" });
  let frozen: number | undefined;
  try {
    frozen = (await ensureDaemon(env)).pid;
    assert.equal(statSync(join(home, "daemon.log.1")).size, 6 * 1024 * 1024, "the oversized log was moved aside");
    assert.ok(statSync(join(home, "daemon.log")).size < 10_000, "the new log has only the new daemon's lines");
    assert.deepEqual(readdirSync(engineLogs).filter(name => /^engine-1\d\d-/.test(name)).sort(), [102, 103, 104, 105, 106].flatMap(pair), "the logs of the last five engine starts are kept");

    // Stop the daemon's process, and age its heartbeat instead of waiting out the threshold. Its engine still answers.
    process.kill(frozen, "SIGSTOP");
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(home, "daemon.json"), past, past);
    assert.equal(status(), "not running\n");
    const next = await ensureDaemon(env);
    assert.notEqual(next.pid, frozen, "a new daemon was started");
    assert.throws(() => process.kill(frozen!, 0), "the frozen daemon was killed");
    assert.match(status(), new RegExp(`^running: .*pid ${next.pid}`));
    // `openmerit daemon stop` does not wait for a frozen daemon to handle SIGTERM.
    process.kill(next.pid, "SIGSTOP");
    utimesSync(join(home, "daemon.json"), past, past);
    const stopping = Date.now();
    assert.equal(await stopDaemon(env), true);
    assert.ok(Date.now() - stopping < 5000, `stopped after ${Date.now() - stopping} ms`);
    assert.throws(() => process.kill(next.pid, 0), "the frozen daemon was killed");
  } finally {
    if (frozen) try { process.kill(frozen, "SIGKILL"); } catch { /* already replaced */ }
    await stopDaemon(env);
    rmSync(home, { recursive: true, force: true });
  }
});
