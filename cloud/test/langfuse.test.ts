// The Langfuse connection end to end on the cloud app, against a fake Langfuse and fake models:
// connect with a Viewer key pair, list the project's tasks by spend, evaluate the top one within
// the plan's evaluations on its dataset items' expected outputs, and approve its change. The fake
// records every request, so the test checks that the connection never writes to Langfuse.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { caller, catalogue, costOf, startApp, stop, subscribe, TICKETS, waitFor, WEAK_BELOW, type FakeModels } from "./helpers.ts";

const VIEWER = { publicKey: "pk-lf-viewer-0001", secretKey: "sk-lf-viewer" };
const WRITER = { publicKey: "pk-lf-writer-0002", secretKey: "sk-lf-writer" };
const CURRENT = "openai/gpt-5.4";
/** A key a recorded request leaked; the engine's redact removes key- and token-shaped text. */
const LEAKED = "sk-proj-AbCdEfGh12345678";
const tickets = Object.entries(TICKETS);

/** A recorded call: the routing request, with a leaked key in the first ticket, and its JSON answer. */
const generation = (id: string, traceId: string, name: string, traceName: string, [ticket, queue]: [string, string], at: string) => ({
  id, traceId, type: "GENERATION", name, traceName, startTime: at, endTime: at, level: "DEFAULT", providedModelName: CURRENT, promptName: null, promptVersion: null,
  input: JSON.stringify([{ role: "system", content: "Route the support ticket. Answer JSON: {\"queue\": ...}." }, { role: "user", content: `Ticket: ${ticket}${ticket === tickets[0]![0] ? ` (my key is ${LEAKED})` : ""}` }]),
  output: JSON.stringify({ queue }), totalCost: 0.01,
});

function fakeLangfuse() {
  const requests: { method: string; path: string; auth: string }[] = [];
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  // An experiment that ran `triage › classify` on six dataset items, one call per item.
  const items = tickets.slice(0, 6).map(([ticket, queue], i) => ({ id: `item_${i}`, traceId: `exp_${i}`, ticket, queue }));
  const answer = (method: string, url: URL): { status?: number; body: unknown } => {
    const path = url.pathname;
    if (path === "/api/public/projects") return { body: { data: [{ id: "proj_support", name: "support" }] } };
    if (path === "/api/public/v2/datasets" && method === "POST") return { status: 400, body: { message: "Invalid request data" } };
    if (path === "/api/public/v2/metrics") return { body: { data: [
      { traceName: "triage", name: "classify", promptName: null, promptVersion: null, providedModelName: CURRENT, count_count: 900, sum_totalCost: 9 },
      { traceName: "triage", name: "classify", promptName: null, promptVersion: null, providedModelName: "openai/gpt-5-mini", count_count: 40, sum_totalCost: 0.05 },
      { traceName: "support-chat", name: "summarize", promptName: null, promptVersion: null, providedModelName: CURRENT, count_count: 100, sum_totalCost: 1 },
      { traceName: null, name: null, promptName: null, promptVersion: null, providedModelName: CURRENT, count_count: 5, sum_totalCost: 0.2 },
    ] } };
    if (path === "/api/public/experiment-items") return { body: { data: items.map((item, i) => ({ experimentName: "triage-eval-1", experimentId: "exp_1", experimentItemId: item.id, traceId: item.traceId, startTime: at(60 + i) })), meta: {} } };
    if (path.startsWith("/api/public/dataset-items/")) {
      const item = items.find(entry => entry.id === decodeURIComponent(path.split("/").at(-1)!));
      return item ? { body: { id: item.id, expectedOutput: { queue: item.queue } } } : { status: 404, body: { message: "not found" } };
    }
    if (path === "/api/public/v2/observations") {
      const filter = JSON.parse(url.searchParams.get("filter") ?? "[]") as { column: string; value: string }[];
      const traceId = filter.find(item => item.column === "traceId")?.value;
      if (traceId) {
        const item = items.find(entry => entry.traceId === traceId);
        return { body: { data: item ? [generation(`obs_${traceId}`, traceId, "classify", "triage", [item.ticket, item.queue], at(60))] : [], meta: {} } };
      }
      const traceName = filter.find(item => item.column === "traceName")?.value ?? "";
      return { body: { data: tickets.map((entry, i) => generation(`obs_${traceName}_${i}`, `trace_${traceName}_${i}`, traceName === "triage" ? "classify" : "summarize", traceName, entry, at(i + 1))), meta: {} } };
    }
    return { status: 404, body: { message: `no route ${path}` } };
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      requests.push({ method: req.method!, path: url.pathname, auth: String(req.headers.authorization) });
      const auth = String(req.headers.authorization);
      const pair = [VIEWER, WRITER].find(keys => auth === `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString("base64")}`);
      // A Viewer key may not write: the dataset creation the Viewer check sends gets 403.
      const reply = !pair ? { status: 401, body: { message: "Invalid credentials" } }
        : pair === VIEWER && req.method !== "GET" ? { status: 403, body: { message: "Forbidden" } }
        : answer(req.method!, url);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(reply.body));
    });
  });
  return { server, requests, url: "" };
}

/** Models that route tickets in JSON: right unless the catalogue rates them below WEAK_BELOW. Records each request's text. */
async function fakeRouters(): Promise<FakeModels & { texts: string[] }> {
  const eci = new Map(catalogue.models.map(model => [model.id, model.eci]));
  const fake: FakeModels & { texts: string[] } = { url: "", calls: [], onCall: null, cost: null, close: async () => {}, texts: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] };
      const text = parsed.messages.map(message => message.content).join("\n");
      fake.texts.push(text);
      const ticket = tickets.find(([item]) => text.includes(item));
      fake.calls.push({ model: parsed.model, ticket: ticket?.[0] ?? "", auth: "" });
      const queue = (eci.get(parsed.model) ?? 200) < WEAK_BELOW ? "other" : ticket?.[1] ?? "other";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ queue }) } }], usage: { prompt_tokens: 50, completion_tokens: 2, cost: costOf(parsed.model) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

test("Langfuse: only a Viewer key connects, tasks are listed by spend, the top one is evaluated on its dataset items within the plan, and Approve records who without writing to Langfuse", async () => {
  const langfuse = fakeLangfuse();
  await new Promise<void>(resolve => langfuse.server.listen(0, "127.0.0.1", resolve));
  langfuse.url = `http://127.0.0.1:${(langfuse.server.address() as AddressInfo).port}`;
  const models = await fakeRouters();
  const app = await startApp({ models });
  try {
    // One evaluation on the plan: the top task starts, the next waits.
    await subscribe(app, "org_lf", { includedEvals: 1 });
    const admin = caller(app, "test:user_l:org_lf:admin"), member = caller(app, "test:user_m:org_lf:member");
    type Row = { id: string; name: string; model: string; generations: number; costUsd: number | null; status: string; reason: string | null; jobId: string | null };
    const connect = (agent: typeof admin, keys: typeof VIEWER) => agent.api<{ error?: string; tasks?: Row[]; projectName?: string; keyLast4?: string }>("/api/connections/langfuse", { method: "POST", body: JSON.stringify({ baseUrl: langfuse.url, ...keys }) });

    // Refusals: a member, and a key pair that can write. Neither stores anything.
    assert.equal((await connect(member, VIEWER)).status, 403);
    const writer = await connect(admin, WRITER);
    assert.equal(writer.status, 400);
    assert.match(writer.body.error!, /can write to Langfuse\. Create a separate Viewer key/);
    assert.equal((await admin.api<{ connected: boolean }>("/api/connections/langfuse")).body.connected, false);

    const connected = await connect(admin, VIEWER);
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    assert.deepEqual([connected.body.projectName, connected.body.keyLast4], ["support", "0001"]);
    assert.doesNotMatch(JSON.stringify(connected.body), /sk-lf-/, "the secret key is never returned");
    // One task per generation name, its current model the one with the most calls, by spend.
    assert.deepEqual(connected.body.tasks!.map(row => [row.name, row.model, row.generations, row.status]), [
      ["triage › classify", CURRENT, 940, "evaluating"],
      ["support-chat › summarize", CURRENT, 100, "waiting"],
      ["(no trace name) › (no name)", CURRENT, 5, "skipped"],
    ]);
    const [top, next, unnamed] = connected.body.tasks!;
    assert.equal(unnamed!.reason, "generations without a name");
    assert.match(next!.reason!, /Not evaluated yet/);

    const done = await waitFor(() => admin.tool("openmerit_result", { job_id: top!.jobId! }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 120_000);
    assert.equal(done.data.status, "done", done.text);
    assert.match(done.text, /Proposed change: Set classify to [\w./-]+, \d+\/\d+ cases passed \(current model \d+\/\d+\)\. A person approves it with Approve change at https:\/\/app\.openmerit\.test\/r\/job_\w+\/, then makes it: Where your application makes the "classify" call in "triage", set the model to /);
    assert.match(done.text, /Based on: Grader: the expected outputs of 6 dataset items, from langfuse \(experiment "triage-eval-1"\)\. Cases: 6 dataset items run in experiment "triage-eval-1" from langfuse \(triage › classify\)\. Priority: \$9\.05 a month of recorded spend/);
    type Report = { status: string; pick: { model: string }; langfuse: { change: { text: string; model: string; link: string | null }; dataset: { items: number }; replayed: number }; approved: unknown };
    const report = (await admin.api<Report>(`/api/runs/${top!.jobId}`)).body;
    assert.equal(report.status, "picked");
    assert.deepEqual([report.langfuse.change.text, report.langfuse.change.model, report.langfuse.dataset.items, report.langfuse.replayed], [`Set classify to \`${report.pick.model}\``, report.pick.model, 6, 0]);
    // The model saw the recorded requests, redacted.
    assert.ok(models.texts.some(text => text.includes(tickets[0]![0])));
    assert.ok(models.texts.every(text => !text.includes(LEAKED)), "a key in a recorded request is redacted before any model sees it");

    // Approve: admins only; it records who, by name, and changes nothing in Langfuse.
    assert.equal((await member.api(`/api/runs/${top!.jobId}/approve`, { method: "POST" })).status, 403);
    const approved = await admin.api<{ change: string; by: string; name: string }>(`/api/runs/${top!.jobId}/approve`, { method: "POST" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([approved.body.by, approved.body.name], ["user_l", "User L"]);

    // The plan's one evaluation is used, so pressing Start on the waiting task is refused.
    const refused = await admin.api<{ error: string }>(`/api/connections/langfuse/tasks/${next!.id}/start`, { method: "POST" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /This month's 1 evaluations are used/);

    // openmerit_tasks lists the connection's tasks with the verdict and the approval.
    const tasks = await admin.tool("openmerit_tasks", {});
    assert.match(tasks.text, /Langfuse \(project support\): 3 tasks over the last 30 days:/);
    assert.match(tasks.text, /- triage › classify \(openai\/gpt-5\.4, 940 calls, \$9\.05 in 30 days\): Set classify to [\w./-]+, approved by User L on \d{4}-\d{2}-\d{2}; openmerit_result with job_id/);
    assert.match(tasks.text, /- support-chat › summarize \(openai\/gpt-5\.4, 100 calls, \$1\.00 in 30 days\): waiting: Not evaluated yet\./);

    // Read-only: apart from the Viewer check's invalid dataset creation, one per key pair, every request was a GET.
    assert.deepEqual(langfuse.requests.filter(request => request.method !== "GET").map(request => `${request.method} ${request.path}`), ["POST /api/public/v2/datasets", "POST /api/public/v2/datasets"]);

    // Disconnecting deletes the keys; the run and its approval stay.
    assert.equal((await admin.api("/api/connections/langfuse", { method: "DELETE" })).status, 200);
    assert.equal((await admin.api<{ connected: boolean }>("/api/connections/langfuse")).body.connected, false);
    assert.equal((await admin.api<{ approved: { name: string } }>(`/api/runs/${top!.jobId}`)).body.approved.name, "User L");
  } finally {
    await stop(app); await models.close();
    await new Promise<void>(resolve => { langfuse.server.closeAllConnections(); langfuse.server.close(() => resolve()); });
  }
});
