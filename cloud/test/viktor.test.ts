// The Viktor connection end to end on the cloud app, against a fake Viktor and a fake judge: connect
// with a key, list the workspace's tasks, evaluate the one that can be evaluated without being asked,
// and approve its change. The fake Viktor runs the scripts the connection sends by their first line,
// as the real sandbox would run them, and keeps the workspace's scheduled tasks in memory.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createClient } from "rivetkit/client";
import { REQUIRED_SCOPES } from "../../openmerit-core/src/connectors/viktor/index.ts";
import type { Registry } from "../src/registry.ts";
import { caller, costOf, startApp, stop, subscribe, waitFor, type FakeModels } from "./helpers.ts";

const KEY = "zt_live_sk_fake_owner_key_1234";
const SLACK = "T1 · billing · Duplicate November charge";
type Cron = { id: string; path: string; title: string; model: string | null; execution_type: string; description: string; cron: string; paused: boolean; deleted: boolean; condition_script_path?: string };

/** Credits Viktor reports for each test run, by preset, and for the API thread that starts them. */
const RUN = { smart: 70, balanced: 20, cheap: 4 } as Record<string, number>;
const THREAD = 40;

/** The test task's instructions, longer than list_crons' 240-character preview: the judge must get all of it. */
const TRIAGE = `Classify these 6 support tickets, then post the result to #check-this-out. ${"Use the categories billing, bug, account and other, one line per ticket. ".repeat(6)}End of instructions.`;

/** Every prompt the fake judge got. */
const judged: string[] = [];

function fakeViktor(extra: Cron[] = []) {
  const crons: Cron[] = [
    ...["heartbeat", "memory_dreaming", "skill_refining", "workflow_discovery"].map(name => ({ id: `sys_${name}`, path: `/${name}`, title: name, model: null, execution_type: "agent", description: "system", cron: "0 9 * * *", paused: false, deleted: false })),
    { id: "Cut8kTVZ", path: "/ticket_triage_test", title: "Ticket triage test", model: "smart", execution_type: "agent", description: TRIAGE, cron: "0 9 * * 1", paused: true, deleted: false },
    ...extra,
  ];
  const files = new Map<string, string>();
  const state = { scopes: [...REQUIRED_SCOPES] as string[], created: [] as string[], deleted: [] as string[], threads: [] as { id: string; message: string }[], scripts: [] as string[], auth: new Set<string>(), draft: null as string | null, refuse: null as string | null, hold: false, partial: false, creditScale: 1, slowListMs: 0, pending: null as Parameters<typeof runBatch>[0] | null, specs: [] as { models: string[]; copyTitle: string; inherit?: boolean }[] };
  const runBatch = (spec: { source: string; models: string[]; repeats: number; copyPath: string; copyTitle: string; out: string; inherit?: boolean }) => {
    state.specs.push(spec);
    const runs = [];
    for (const model of spec.models) { state.created.push(spec.copyPath + model); crons.push({ ...crons.find(cron => cron.path === spec.source)!, id: `copy_${model}`, path: spec.copyPath + model, title: spec.copyTitle, model, paused: true }); }
    for (let repeat = 1; repeat <= spec.repeats; repeat++) for (const model of spec.models) {
      // balanced posts the wrong category once; the rest post the right one each time.
      const text = model === "balanced" && repeat === 2 ? "T1 · bug · Duplicate November charge" : SLACK;
      // Reports long enough that the progress file passes Viktor's 64,000-character stdout, as 4 presets × 3 runs can.
      runs.push({ model, repeat, status: "success", error: null, report: `Classified the tickets on ${model}. ${"Ticket notes. ".repeat(600)}`, runModel: model, threadId: `run_${model}_${repeat}`, actions: [{ summary: "Captured Slack message to C0CAZCERFCM; no Slack message was sent", channel_id: "C0CAZCERFCM", text }], seconds: 12 });
    }
    // The batch deletes its copies at the end, as BATCH does.
    for (const model of spec.models) { const index = crons.findIndex(cron => cron.path === spec.copyPath + model); crons.splice(index, 1); state.deleted.push(spec.copyPath + model); }
    files.set(spec.out, JSON.stringify({ status: "done", runs, copies: spec.models.map(model => spec.copyPath + model) }));
  };
  const answer = (path: string, method: string, body: Record<string, unknown> | null): { status?: number; body: unknown } => {
    if (path === "/api/public/v1/me") return { body: { key_type: "personal", team_id: "team_fake", key_preview: "zt_live_sk_…1234", scopes: state.scopes } };
    if (path === "/api/public/v1/scripts/runs" && method === "POST") {
      // Viktor refuses an argument over 2,000 characters; the connection sends its arguments in the code.
      if (((body!.args as string[]) ?? []).some(arg => arg.length > 2000)) return { status: 422, body: { detail: [{ type: "value_error", loc: ["body", "args"], msg: "Value error, each arg may be at most 2000 characters" }] } };
      const code = String(body!.code), kind = /^# openmerit:(\w+)/.exec(code)?.[1] ?? "?";
      const inCode = /^import sys as _sys, json as _json; _sys\.argv\[1:\] = _json\.loads\((".*")\)$/m.exec(code)?.[1];
      const args = inCode ? JSON.parse(JSON.parse(inCode) as string) as string[] : (body!.args as string[]) ?? [];
      state.scripts.push(kind);
      // Viktor's request validation, as it refused an argument over 2,000 characters before the arguments moved into the code.
      if (kind === state.refuse) return { status: 422, body: { detail: [{ type: "value_error", loc: ["body", "args"], msg: "Value error, each arg may be at most 2000 characters", input: ["/work/temp/openmerit/x", "# openmerit:batch\nimport asyncio, json"] }] } };
      // A workspace that makes a tool wait for approval: the gateway saves the call as a draft, and the script fails on the draft receipt.
      if (kind === state.draft) return { body: { id: `script_${state.scripts.length}`, status: "completed", result: { exit_code: 1, stdout: "", stderr: `[tool-gateway] ${kind}_tool: draft created, not executed\npydantic_core._pydantic_core.ValidationError: 1 validation error for Response` } } };
      let stdout = "";
      // list_crons gives the first 240 characters of the instructions; get_path_info, which the listing used to call for each task, all of them.
      const full = code.includes("get_path_info");
      if (kind === "list") stdout = JSON.stringify({ tasks: crons.filter(cron => !cron.deleted).map(cron => ({ ...cron, description: full ? cron.description : cron.description.slice(0, 240) })), usage: [{ credits: 140, path: "/agent_runs/crons/ticket_triage_test/2026-11-18T09-00-00" }, { credits: 536, path: "/agent_runs/crons/workflow_discovery/2026-11-19T10-56-20" }], ...(code.includes("get_workspace_settings") ? { defaultModel: "smart" } : {}) });
      if (kind === "put") { files.set(`${args[0]}/spec.json`, args[2]!); stdout = "{\"ok\": true}"; }
      if (kind === "read") stdout = files.get(args[0]!) ?? "{\"status\": \"missing\"}";
      if (kind === "describe") stdout = JSON.stringify({ description: crons.find(cron => cron.path === args[0])!.description });
      // PAGE: the output file's size in bytes, then a piece of it in base64; the last piece deletes the file.
      if (kind === "page") {
        const bytes = Buffer.from(files.get(args[0]!) ?? "", "utf8"), offset = Number(args[1]), size = Number(args[2]);
        stdout = `${bytes.length}\n${bytes.subarray(offset, offset + size).toString("base64")}`;
        if (offset + size >= bytes.length) files.delete(args[0]!);
      }
      // A script whose stdout goes to a file prints nothing itself.
      const toFile = /^import os as _os, sys as _osys, atexit as _atexit; .*_out = open\(("[^"]+"), "w"/m.exec(code)?.[1];
      if (toFile) { files.set(JSON.parse(toFile) as string, stdout); stdout = ""; }
      // Viktor returns at most 64,000 characters of stdout: the end of it, flagged.
      if (stdout.length > 64_000) return { body: { id: `script_${state.scripts.length}`, status: "completed", result: { exit_code: 0, stdout: stdout.slice(-64_000), stdout_truncated: true, stderr: "" } } };
      if (kind === "credits") stdout = JSON.stringify({ credits: Object.fromEntries((JSON.parse(args[0]!) as string[]).map(id => [id, (id.startsWith("run_") ? RUN[id.split("_")[1]!]! : THREAD) * state.creditScale])) });
      if (kind === "cleanup") {
        const left = crons.filter(cron => cron.path.startsWith(args[0]!) && (cron.title.startsWith("[OpenMerit]: ") || cron.title.startsWith("OpenMerit: ")));
        for (const cron of left) { crons.splice(crons.indexOf(cron), 1); state.deleted.push(cron.path); }
        stdout = JSON.stringify({ deleted: left.map(cron => cron.path), errors: [] });
      }
      return { body: { id: `script_${state.scripts.length}`, status: "completed", result: { exit_code: 0, stdout, stderr: "" } } };
    }
    if (path === "/api/public/v1/threads" && method === "POST") {
      const message = String(body!.message), directory = /uv run python (\S+)\/batch\.py/.exec(message)?.[1];
      state.threads.push({ id: `thread_${state.threads.length + 1}`, message });
      const spec = directory ? JSON.parse(files.get(`${directory}/spec.json`)!) as Parameters<typeof runBatch>[0] : null;
      // A held batch keeps running until the test releases it.
      if (spec && state.partial) {
        // A batch still running: its copies exist, and the first round of runs has finished.
        for (const model of spec.models) { state.created.push(spec.copyPath + model); crons.push({ ...crons.find(cron => cron.path === spec.source)!, id: `copy_${model}`, path: spec.copyPath + model, title: spec.copyTitle, model, paused: true }); }
        const runs = spec.models.map(model => ({ model, repeat: 1, status: "success", error: null, report: `Classified the tickets on ${model}.`, runModel: model, threadId: `run_${model}_1`, actions: [], seconds: 12 }));
        files.set(spec.out, JSON.stringify({ status: "running", runs, copies: spec.models.map(model => spec.copyPath + model) }));
      } else if (spec && state.hold) state.pending = spec; else if (spec) runBatch(spec);
      return { status: 202, body: { thread: { id: `thread_${state.threads.length}` }, run: { id: `agentrun_${state.threads.length}`, status: "queued" } } };
    }
    const run = /^\/api\/public\/v1\/runs\/([\w]+)$/.exec(path);
    if (run) return { body: { id: run[1], thread_id: "thread_1", status: state.hold || state.partial ? "running" : "completed", error: null } };
    return { status: 404, body: { detail: { error: "not_found", message: path } } };
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      state.auth.add(String(req.headers.authorization));
      const reply = req.headers.authorization === `Bearer ${KEY}` ? answer(new URL(req.url!, "http://x").pathname, req.method!, raw ? JSON.parse(raw) as Record<string, unknown> : null) : { status: 401, body: { detail: { error: "invalid_api_key", message: "Missing or invalid API key" } } };
      // A slow Viktor: the listing's script run answers after `slowListMs`.
      const delay = raw.includes("# openmerit:list") ? state.slowListMs : 0;
      setTimeout(() => { res.writeHead(reply.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(reply.body)); }, delay);
    });
  });
  const release = () => { state.hold = false; if (state.pending) runBatch(state.pending); state.pending = null; };
  return { crons, state, server, url: "", release };
}

/** The judge on OpenMerit's OpenRouter key: five checks, and a run passes every one unless its Slack post files T1 as a bug. */
async function fakeJudge(): Promise<FakeModels> {
  const fake: FakeModels = { url: "", calls: [], onCall: null, cost: null, close: async () => {} };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      // OpenMerit checks its model key with OpenRouter's free GET /key before a job starts.
      if (req.url === "/key") { res.writeHead(fake.keyStatus ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(fake.keyStatus ? { error: { code: fake.keyStatus, message: "API key expired" } } : { data: { label: "test" } })); return; }
      const parsed = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] };
      const system = parsed.messages.find(message => message.role === "system")?.content ?? "", prompt = parsed.messages.find(message => message.role === "user")?.content ?? "";
      judged.push(prompt);
      fake.calls.push({ model: parsed.model, ticket: system.slice(0, 20), auth: "" });
      const ids = ["check-1", "check-2", "check-3", "check-4", "check-5"];
      const graded = prompt.split("Run to grade:")[1] ?? "";
      const content = system.startsWith("You write the checklist")
        ? JSON.stringify({ checks: ["Every ticket has a category", "T1 is billing", "Each line has a summary", "One Slack message", "Lines use the T<n> · <category> · <summary> format"] })
        : JSON.stringify(Object.fromEntries(ids.map(id => [id, !(id === "check-2" && graded.includes("T1 · bug"))])));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 500, completion_tokens: 50, cost: costOf(parsed.model) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

test("Viktor: a key connects only with every scope, the tasks are listed, the one that can be is evaluated in test mode, and Approve records who and when without changing it", async () => {
  const viktor = fakeViktor();
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  const app = await startApp({ models: judge, env: {
    CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}`,
    OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200", OPENMERIT_VIKTOR_STALE_MS: "1500",
  } });
  try {
    await subscribe(app, "org_viktor");
    const admin = caller(app, "test:user_v:org_viktor:admin"), member = caller(app, "test:user_m:org_viktor:member");
    const connect = (agent: typeof admin, body: unknown) => agent.api<{ error?: string; tasks?: { title: string; status: string; reason: string | null; jobId: string | null; estimatedCredits: number | null; blocked: string | null }[] }>("/api/connections/viktor", { method: "POST", body: JSON.stringify(body) });

    // Refusals: a member, a bad key, and a key missing scopes. None stores a key or lists anything.
    assert.equal((await connect(member, { apiKey: KEY })).status, 403);
    const bad = await connect(admin, { apiKey: "zt_live_sk_wrong_key_000" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error!, /paid or Enterprise plan/);
    viktor.state.scopes = REQUIRED_SCOPES.filter(scope => scope !== "runs:read");
    const partial = await connect(admin, { apiKey: KEY });
    assert.match(partial.body.error!, /missing the scope runs:read\./);
    assert.deepEqual(viktor.state.scripts, [], "no script ran for a refused key");
    viktor.state.scopes = [...REQUIRED_SCOPES];

    // Connecting lists the five tasks and starts nothing; the system tasks are skipped with why.
    const connected = await connect(admin, { apiKey: KEY, creditCap: 2000 });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    const rows = connected.body.tasks!;
    assert.deepEqual(rows.map(row => [row.title, row.status]), [["workflow_discovery", "skipped"], ["Ticket triage test", "not_evaluated"], ["heartbeat", "skipped"], ["memory_dreaming", "skipped"], ["skill_refining", "skipped"]]);
    assert.ok(rows.filter(row => row.status === "skipped").every(row => row.reason === "Viktor's own task: it cannot be edited"));
    const triage = rows.find(row => row.title === "Ticket triage test")!;
    assert.deepEqual([triage.jobId, triage.blocked], [null, null]);
    assert.ok(triage.estimatedCredits! > 0);
    // Refresh lists again and starts nothing either; the coding agent sees the task waiting for a person.
    // Refresh returns once the listing started; a second press while it runs starts no other listing, and the page polls `listing`.
    type Listed = { listing: boolean; listingError: string | null; tasks: { title: string; status: string; isNew: boolean }[] };
    const refresh = async () => {
      const pressed = await admin.api<Listed & { started: boolean }>("/api/connections/viktor/refresh", { method: "POST" });
      assert.equal(pressed.status, 202);
      return { pressed: pressed.body, done: (await waitFor(() => admin.api<Listed>("/api/connections/viktor"), view => !view.body.listing, 30_000)).body };
    };
    const lists = () => viktor.state.scripts.filter(kind => kind === "list").length;
    const listsBefore = lists();
    viktor.state.slowListMs = 1500;
    const first = await admin.api<{ started: boolean }>("/api/connections/viktor/refresh", { method: "POST" });
    const second = await admin.api<{ started: boolean }>("/api/connections/viktor/refresh", { method: "POST" });
    assert.deepEqual([first.body.started, second.body.started], [true, false]);
    const relisted = (await waitFor(() => admin.api<Listed>("/api/connections/viktor"), view => !view.body.listing, 30_000)).body;
    assert.equal(lists(), listsBefore + 1, "one listing for two presses");
    viktor.state.slowListMs = 0;
    assert.equal(relisted.tasks[1]!.status, "not_evaluated");
    assert.deepEqual((await admin.api<unknown[]>("/api/runs")).body, []);
    assert.match((await admin.tool("openmerit_tasks", {})).text, new RegExp(`Ticket triage test \\(smart, 140 credits in 30 days\\): not evaluated; an admin can evaluate it with Evaluate at https://app\\.openmerit\\.test/connections/ \\(about ${triage.estimatedCredits} Viktor credits\\)`));
    // Evaluate: an admin starts it, and the job records who.
    assert.equal((await member.api("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" })).status, 403);
    const evaluate = await admin.api<{ jobIds: string[] }>("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" });
    assert.equal(evaluate.status, 201, JSON.stringify(evaluate.body));
    const jobId = evaluate.body.jobIds[0]!;
    const shown = await admin.api<{ keyLast4: string }>("/api/connections/viktor");
    assert.equal(shown.body.keyLast4, "1234");
    assert.doesNotMatch(JSON.stringify(shown.body), new RegExp(KEY), "the key is never returned");

    // The evaluation: smart against balanced and cheap, three test runs each, in one API thread.
    const done = await waitFor(() => admin.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 60_000);
    assert.equal(done.data.status, "done", done.text);
    assert.match(done.text, /Proposed change: Set Ticket triage test to cheap\. It passed 15\/15 checks, as smart passed 15\/15, for 4 credits per test run instead of 70 credits\./);
    // A Viktor result is priced in credits per test run, never in dollars per call.
    assert.match(done.text, /Current preset smart: 15\/15 checks passed, 70 credits per test run\./);
    assert.match(done.text, /`balanced` passed 14\/15 at 20 credits a test run/);
    assert.doesNotMatch(done.text, /per call|a call/);
    assert.equal(viktor.state.threads.length, 1, "every test run shares one thread");
    type Row = { model: string; passes: number; total: number; costPerCallUsd: number | null };
    const report = (await admin.api<{ status: string; pick: Row; baseline: Row; nearMisses: Row[]; edit: { instructions: string }; notices: string[]; connection: { change: { text: string; link: string }; creditsUsed: number; copiesLeft: string[] }; approved: unknown }>(`/api/runs/${jobId}`)).body;
    assert.equal(report.status, "picked");
    assert.deepEqual([report.pick.model, report.pick.passes, report.pick.total], ["cheap", 15, 15]);
    // Per test run: cheap 4 credits and smart 70, at $2.50 per 1,000 credits.
    assert.ok(Math.abs(report.pick.costPerCallUsd! - 0.01) < 1e-9 && Math.abs(report.baseline.costPerCallUsd! - 0.175) < 1e-9);
    // balanced filed T1 as a bug once: 14 of 15, within one check per run of the bar.
    assert.deepEqual(report.nearMisses.map(item => [item.model, item.passes, item.total]), [["balanced", 14, 15]]);
    assert.equal(report.connection.change.link, "https://app.viktor.com/scheduled-tasks");
    // The thread and 3 runs on each preset: 40 + 3 × (70 + 20 + 4).
    assert.equal(report.connection.creditsUsed, 322);
    // The listing kept only the start of the instructions; the judge got all of them, read once by the job.
    assert.ok(judged.length > 0 && judged.filter(prompt => prompt.includes("Instructions:")).every(prompt => prompt.includes(TRIAGE)));
    assert.equal(viktor.state.scripts.filter(kind => kind === "describe").length, 1);
    assert.ok(report.notices.some(notice => /Test mode captured 9 outside actions/.test(notice)));
    assert.deepEqual(report.connection.copiesLeft, []);
    assert.deepEqual([...viktor.state.created].sort(), [...viktor.state.deleted].sort(), "every copy OpenMerit made is deleted");
    assert.ok(viktor.state.created.every(path => path.startsWith("/openmerit/ticket-triage-test-")));
    assert.equal(report.approved, null);

    // Approve change: admins only; it records who and when, and the real task stays on smart.
    assert.equal((await member.api(`/api/runs/${jobId}/approve`, { method: "POST" })).status, 403);
    const before = Date.now();
    const approved = await admin.api<{ change: string; by: string; name: string; email: string; at: string }>(`/api/runs/${jobId}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    // The approver's name and email come from Clerk (TestAuth here) and are kept with the approval.
    assert.deepEqual([approved.body.change, approved.body.by, approved.body.name, approved.body.email], ["Set Ticket triage test to cheap", "user_v", "User V", "v@example.test"]);
    assert.ok(Date.parse(approved.body.at) >= before - 1000);
    assert.equal(viktor.crons.find(cron => cron.path === "/ticket_triage_test")!.model, "smart");
    const again = await admin.api<{ by: string; at: string }>(`/api/runs/${jobId}/approve`, { method: "POST" });
    assert.equal(again.body.at, approved.body.at, "the first approval stands");

    // openmerit_tasks lists the connection's tasks with the verdict and the approval.
    const tasks = await admin.tool("openmerit_tasks", {});
    assert.match(tasks.text, /Viktor \(322 Viktor credits used by OpenMerit's tests\): 5 scheduled tasks/);
    assert.match(tasks.text, /Ticket triage test \(smart, 140 credits in 30 days\): Set Ticket triage test to cheap, approved by User V on \d{4}-\d{2}-\d{2}; /);
    assert.match(tasks.text, /heartbeat \(Team default \(smart\), 0 credits in 30 days\): skipped: Viktor's own task/);
    assert.equal(viktor.state.auth.size, 2, "only the stored key and the one refused key reached Viktor");

    // A task deleted in Viktor leaves the table once the listing is stale; its result stays in Runs under its name.
    const view = () => admin.api<{ creditsUsed: number; listingError: string | null; tasks: { title: string }[] }>("/api/connections/viktor");
    viktor.crons.find(cron => cron.path === "/ticket_triage_test")!.deleted = true;
    await new Promise(resolve => setTimeout(resolve, 1600));
    // The read starts the listing and returns the last one; the page polls until it is done.
    const relistedView = await waitFor(() => view(), value => value.body.tasks.length === 4, 30_000);
    assert.deepEqual(relistedView.body.tasks.map(task => task.title), ["workflow_discovery", "heartbeat", "memory_dreaming", "skill_refining"]);
    assert.doesNotMatch((await admin.tool("openmerit_tasks", {})).text, /Ticket triage test/);
    const runs = (await admin.api<{ id: string; result: { task: string | null } | null }[]>("/api/runs")).body;
    assert.equal(runs.find(run => run.id === jobId)!.result!.task, "Ticket triage test");

    // A listing whose tool call Viktor saved as a draft says so on the connection, and keeps the last listing.
    viktor.state.draft = "list";
    const drafted = { body: (await refresh()).done };
    assert.match(drafted.body.listingError!, /Viktor saved OpenMerit's call to list_tool as a draft that waits for approval in chat, so it did not run\./);
    assert.equal(drafted.body.tasks.length, 4);
    viktor.state.draft = null;
    viktor.crons.find(cron => cron.path === "/ticket_triage_test")!.deleted = false;
    assert.equal((await refresh()).done.tasks.length, 5);

    // A job that fails before its Viktor thread starts spends no credits, and says why once.
    viktor.state.draft = "put";
    const restarted = await admin.api<{ started: string[] }>("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" });
    assert.equal(restarted.status, 201, JSON.stringify(restarted.body));
    const failedId = (await admin.api<{ id: string }[]>("/api/runs")).body[0]!.id;
    assert.notEqual(failedId, jobId);
    const failed = await waitFor(() => admin.tool("openmerit_result", { job_id: failedId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 60_000);
    assert.equal(failed.data.status, "failed", failed.text);
    assert.equal(failed.text.match(/draft that waits for approval/g)?.length, 1, failed.text);
    const failedView = (await admin.api<{ error: string; notices: string[] }>(`/api/runs/${failedId}`)).body;
    assert.match(failedView.error, /^The job failed: .*put_tool as a draft/);
    assert.deepEqual(failedView.notices, []);
    assert.equal((await view()).body.creditsUsed, 322, "the failed job counts 0 credits");
    viktor.state.draft = null;

    // A request Viktor refuses reads as one sentence, with the error as recorded, line breaks kept, behind it.
    viktor.state.refuse = "put";
    assert.equal((await admin.api("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" })).status, 201);
    const refusedId = (await admin.api<{ id: string }[]>("/api/runs")).body[0]!.id;
    const refused = await waitFor(() => admin.tool("openmerit_result", { job_id: refusedId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 60_000);
    const sentence = "Viktor refused the request: each script argument may be at most 2,000 characters.";
    assert.match(refused.text, new RegExp(`\\nError: ${sentence.replaceAll(".", "\\.")}\\nDetails:\\nThe job failed: Step "put" exhausted retries: ViktorError: Viktor POST /api/public/v1/scripts/runs: \\[\\{"type":"value_error"`), refused.text);
    const refusedView = (await admin.api<{ error: string; errorDetail: string }>(`/api/runs/${refusedId}`)).body;
    assert.equal(refusedView.error, sentence);
    assert.match(refusedView.errorDetail, /"# openmerit:batch\nimport asyncio, json"/, "the detail has real line breaks, not \\n");
    viktor.state.refuse = null;

    // Runs labels each Viktor run by its task's title, and says who started it from the app.
    type RunRow = { id: string; title: string | null; startedBy: string | null; startedByName: string | null };
    const labelled = new Map((await admin.api<RunRow[]>("/api/runs")).body.map(run => [run.id, run]));
    for (const id of [jobId, failedId, refusedId]) assert.deepEqual(labelled.get(id), { ...labelled.get(id), title: "Ticket triage test", startedBy: "user_v", startedByName: "User V" });

    // Removing the connection deletes the key; the run and its approval stay.
    assert.equal((await admin.api("/api/connections/viktor", { method: "DELETE" })).status, 200);
    assert.deepEqual((await admin.api<{ connected: boolean }>("/api/connections/viktor")).body.connected, false);
    assert.equal((await admin.api<{ approved: { by: string } }>(`/api/runs/${jobId}`)).body.approved.by, "user_v");
    // Run again on a Viktor result evaluates the task again through the connection, not a bundle: admins only.
    assert.equal((await member.api(`/api/runs/${jobId}/rerun`, { method: "POST" })).status, 403);
    const rerun = await admin.api<{ error: string }>(`/api/runs/${jobId}/rerun`, { method: "POST" });
    assert.deepEqual([rerun.status, rerun.body.error], [409, "Viktor is not connected."]);
    // The coding agent cannot rerun a Viktor task: it has no bundle, and an admin spends the workspace's credits in the app.
    const recommend = await admin.tool("openmerit_recommend", { job_id: jobId });
    assert.equal(recommend.isError, true);
    assert.match(recommend.text, /evaluated a Viktor task, which has no bundle to run again\. An admin starts it again with Start again/);
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});

test("Viktor: a workspace whose instructions pass Viktor's 64,000-character stdout lists in full", async () => {
  // Seven project tasks with long instructions, about 73,000 characters in all, as in Praveen's workspace.
  const lengths = [1_317, 4_200, 6_800, 9_100, 11_500, 14_877, 25_206];
  const project = lengths.map((length, index): Cron => ({
    id: `proj_${index}`, path: `/u0cb2f8emqc/projects/prompts/task_${index}`, title: `OpenMerit: Project task ${index + 1}`, model: index % 2 ? "balanced" : "smart-writing", execution_type: "agent",
    description: `Task ${index + 1}: ${"Review the drafts, raw packets and facts JSON against the style guide. ".repeat(length / 72 + 1)}`.slice(0, length), cron: "0 9 * * *", paused: index === 6, deleted: false, condition_script_path: `/u0cb2f8emqc/projects/prompts/check_${index}.py`,
  }));
  const viktor = fakeViktor(project);
  // As in Praveen's workspace: the 4 system tasks and the 7 project tasks; the test task was deleted.
  viktor.crons.find(cron => cron.path === "/ticket_triage_test")!.deleted = true;
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  const app = await startApp({ models: judge, env: { OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200" } });
  try {
    await subscribe(app, "org_long");
    const admin = caller(app, "test:user_l:org_long:admin");
    const connected = await admin.api<{ listingError: string | null; tasks: { title: string; status: string; reason: string | null; blocked: string | null; estimatedCredits: number | null }[] }>("/api/connections/viktor", { method: "POST", body: JSON.stringify({ apiKey: KEY, creditCap: 100 }) });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    assert.equal(connected.body.listingError, null);
    assert.equal(connected.body.tasks.length, 11);
    // Each has a condition script, which test mode ignores, so all 7 can be evaluated; titled "OpenMerit: …" outside /openmerit/, none is a copy.
    // Connecting starts none. There is no credit cap: a creditCap an older client sends is ignored, and Evaluate is on for each, with its estimate.
    const rows = connected.body.tasks.filter(task => task.title.startsWith("OpenMerit: Project"));
    assert.deepEqual(rows.map(task => task.status), Array(7).fill("not_evaluated"));
    assert.ok(rows.every(task => task.estimatedCredits! > 100 && task.blocked === null), JSON.stringify(rows.map(task => task.blocked)));
    assert.deepEqual([viktor.state.created, viktor.state.deleted, viktor.state.threads.length], [[], [], 0]);
    assert.ok(!viktor.state.scripts.includes("cleanup"), "no task of the person's is cleaned up as a copy");
    assert.deepEqual(viktor.state.scripts.slice(0, 2), ["list", "page"]);
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});

test("Viktor: the background re-list finds a new task without Refresh and marks it New, starts nothing, waits while a job runs, and stops on disconnect", async () => {
  const viktor = fakeViktor();
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  // A 5-second schedule, and a stale time no read reaches, so only the schedule lists again.
  const app = await startApp({ models: judge, env: { OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200", OPENMERIT_RELIST_MS: "5000", OPENMERIT_VIKTOR_STALE_MS: "3600000" } });
  try {
    await subscribe(app, "org_relist");
    const admin = caller(app, "test:user_r:org_relist:admin");
    type Row = { id: string; title: string; status: string; isNew: boolean };
    const view = () => admin.api<{ tasks: Row[] }>("/api/connections/viktor");
    assert.equal((await admin.api("/api/connections/viktor", { method: "POST", body: JSON.stringify({ apiKey: KEY, creditCap: 2000 }) })).status, 201);
    // The first listing's tasks are not New.
    assert.ok((await view()).body.tasks.every(task => !task.isNew));

    // A task added in Viktor appears, marked New, without anyone pressing Refresh, and nothing is evaluated.
    viktor.crons.push({ id: "Wk1", path: "/weekly_report", title: "Weekly report", model: "balanced", execution_type: "agent", description: "Write the weekly report.", cron: "0 9 * * 1", paused: true, deleted: false });
    const found = await waitFor(() => view(), value => value.body.tasks.some(task => task.title === "Weekly report"), 30_000);
    assert.deepEqual(found.body.tasks.filter(task => task.isNew).map(task => [task.title, task.status]), [["Weekly report", "not_evaluated"]]);
    assert.deepEqual([(await admin.api<unknown[]>("/api/runs")).body, viktor.state.threads.length], [[], 0]);
    // Opening its row clears New.
    assert.equal((await admin.api("/api/connections/viktor/tasks/Wk1/seen", { method: "POST" })).status, 200);
    assert.equal((await view()).body.tasks.find(task => task.title === "Weekly report")!.isNew, false);

    // While one of the connection's jobs runs, the schedule does not list, so cleanup cannot race the batch.
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    const relist = rivet.connectionRelist.getOrCreate(["org_relist", "viktor"], { createWithInput: { accountId: "org_relist", kind: "viktor" } });
    viktor.state.hold = true;
    const started = await admin.api<{ jobIds: string[] }>("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await waitFor(async () => viktor.state.pending, pending => pending !== null, 30_000);
    assert.deepEqual(await relist.tick(), { listed: false, reason: "a job is running" });
    viktor.release();
    await waitFor(() => admin.tool("openmerit_result", { job_id: started.body.jobIds[0]! }), value => value.data.status === "done", 60_000);
    assert.deepEqual(await waitFor(() => relist.tick(), tick => tick.listed, 15_000), { listed: true });

    // Removing the connection stops the schedule and removes its actor.
    assert.equal((await admin.api("/api/connections/viktor", { method: "DELETE" })).status, 200);
    await assert.rejects(rivet.connectionRelist.get(["org_relist", "viktor"]).info());
    const lists = viktor.state.scripts.filter(kind => kind === "list").length;
    await new Promise(resolve => setTimeout(resolve, 6000));
    assert.equal(viktor.state.scripts.filter(kind => kind === "list").length, lists, "no listing after the connection is removed");
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});

test("Viktor: a task on the workspace's default model is evaluated against the presets cheaper than that default, its baseline left on the default", async () => {
  const viktor = fakeViktor([{ id: "Dg1", path: "/digest", title: "Digest", model: null, execution_type: "agent", description: TRIAGE, cron: "0 9 * * 1", paused: true, deleted: false }]);
  viktor.crons.find(cron => cron.path === "/ticket_triage_test")!.deleted = true;
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  const app = await startApp({ models: judge, env: { OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200" } });
  try {
    await subscribe(app, "org_default");
    const admin = caller(app, "test:user_d:org_default:admin");
    const connected = await admin.api<{ tasks: { title: string; model: string | null; defaultModel: string | null; status: string; estimatedCredits: number | null }[] }>("/api/connections/viktor", { method: "POST", body: JSON.stringify({ apiKey: KEY, creditCap: 2000 }) });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    const digest = connected.body.tasks.find(task => task.title === "Digest")!;
    assert.deepEqual([digest.model, digest.defaultModel], [null, "smart"]);
    assert.ok(digest.estimatedCredits! > 0);
    const heartbeat = connected.body.tasks.find(task => task.title === "heartbeat")!;
    assert.deepEqual([heartbeat.defaultModel, heartbeat.status], ["smart", "skipped"]);
    assert.equal(digest.status, "not_evaluated");
    const evaluate = await admin.api<{ jobIds: string[] }>("/api/connections/viktor/tasks/Dg1/start", { method: "POST" });
    assert.equal(evaluate.status, 201, JSON.stringify(evaluate.body));
    const jobId = evaluate.body.jobIds[0]!;
    const done = await waitFor(() => admin.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 60_000);
    assert.equal(done.data.status, "done", done.text);
    // The smart ladder; the baseline copy keeps its model unset, so it runs what the task runs.
    assert.deepEqual([viktor.state.specs[0]!.models, viktor.state.specs[0]!.inherit, viktor.state.specs[0]!.copyTitle], [["smart", "balanced", "cheap"], true, "[OpenMerit]: Digest"]);
    const report = (await admin.api<{ connection: { currentModel: string; change: { text: string } } }>(`/api/runs/${jobId}`)).body;
    assert.deepEqual([report.connection.currentModel, report.connection.change.text], ["Team default (smart)", "Set Digest from Team default (smart) to cheap"]);
    assert.deepEqual([...viktor.state.created].sort(), [...viktor.state.deleted].sort());
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});

test("Viktor: a job whose test runs pass twice its estimate stops them, deletes its copies and says so", async () => {
  const viktor = fakeViktor();
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  const app = await startApp({ models: judge, env: { OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200" } });
  try {
    await subscribe(app, "org_guard");
    const admin = caller(app, "test:user_g:org_guard:admin");
    const connected = await admin.api<{ tasks: { id: string; estimatedCredits: number | null }[] }>("/api/connections/viktor", { method: "POST", body: JSON.stringify({ apiKey: KEY }) });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    const estimate = connected.body.tasks.find(task => task.id === "Cut8kTVZ")!.estimatedCredits!;
    // The first round of runs costs 20 times what Viktor usually reports: (70 + 20 + 4) × 20 + 40 × 20 = 2,680 credits, past twice the estimate.
    viktor.state.partial = true; viktor.state.creditScale = 20;
    assert.ok(2_680 > 2 * estimate, `estimate ${estimate}`);
    const started = await admin.api<{ jobIds: string[] }>("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const jobId = started.body.jobIds[0]!;
    const stopped = await waitFor(() => admin.api<{ status: string; error: string | null }>(`/api/runs/${jobId}`), view => ["done", "failed", "stopped"].includes(view.body.status), 60_000);
    assert.equal(stopped.body.status, "stopped", JSON.stringify(stopped.body));
    assert.equal(stopped.body.error, `OpenMerit stopped this evaluation: its test runs had used 2,680 Viktor credits, more than 2 times its estimate of about ${estimate.toLocaleString("en-US")}. It stopped the test runs and deleted its copies of the task.`);
    // Its copies are gone, and the credits it used are recorded, not its estimate.
    assert.ok(viktor.state.created.length === 3 && viktor.state.created.every(path => viktor.state.deleted.includes(path)));
    assert.equal(viktor.crons.filter(cron => cron.path.startsWith("/openmerit/")).length, 0);
    assert.equal((await admin.api<{ creditsUsed: number }>("/api/connections/viktor")).body.creditsUsed, 2_680);
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});

test("Viktor: when OpenMerit's model key stops working, Evaluate is refused before any Viktor call, and nothing is spent or counted", async () => {
  const viktor = fakeViktor();
  await new Promise<void>(resolve => viktor.server.listen(0, "127.0.0.1", resolve));
  viktor.url = `http://127.0.0.1:${(viktor.server.address() as AddressInfo).port}`;
  const judge = await fakeJudge();
  // No read relists while the test runs, so every Viktor call after connecting would come from the start.
  const app = await startApp({ models: judge, env: { OPENMERIT_VIKTOR_URL: viktor.url, OPENMERIT_VIKTOR_POLL_MS: "200", OPENMERIT_VIKTOR_STALE_MS: "3600000", OPENMERIT_RELIST_MS: "3600000" } });
  try {
    await subscribe(app, "org_key");
    const admin = caller(app, "test:user_k:org_key:admin");
    assert.equal((await admin.api("/api/connections/viktor", { method: "POST", body: JSON.stringify({ apiKey: KEY }) })).status, 201);
    const used = (await admin.api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals;
    const calls = { scripts: viktor.state.scripts.length, threads: viktor.state.threads.length };
    // OpenRouter refuses the key, as it did on 21 Nov 2026 when it expired.
    judge.keyStatus = 401;
    const refused = await admin.api<{ error: string }>("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "OpenMerit's model key is not working, so this evaluation did not start. Nothing was spent, and it does not count as an evaluation.");
    assert.deepEqual({ scripts: viktor.state.scripts.length, threads: viktor.state.threads.length }, calls, "no Viktor script or thread for a refused job");
    assert.deepEqual([viktor.state.created, (await admin.api<unknown[]>("/api/runs")).body], [[], []]);
    assert.equal((await admin.api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals, used, "a refused job counts no evaluation");
    // A key that works again lets the job start.
    delete judge.keyStatus;
    assert.equal((await admin.api("/api/connections/viktor/tasks/Cut8kTVZ/start", { method: "POST" })).status, 201);
  } finally {
    await stop(app); await judge.close();
    await new Promise<void>(resolve => { viktor.server.closeAllConnections(); viktor.server.close(() => resolve()); });
  }
});
