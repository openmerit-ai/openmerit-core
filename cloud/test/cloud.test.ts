// The cloud app end to end: MCP over HTTP, the job workflow on a local Rivet engine, the ledger,
// billing webhooks, endpoints, guardrails and watches. Sign-in, Stripe and every model are local
// fakes, and the app runs in a child process so a test can SIGKILL it mid-job.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient } from "rivetkit/client";
import { NO_ORGANIZATION } from "../src/auth.ts";
import { signStripePayload } from "../src/billing.ts";
import type { Registry } from "../src/registry.ts";
import { watchState } from "../src/actors/account.ts";
import { bundle, caller, costOf, crash, fakeModels, startApp, stop, subscribe, waitFor, WEAK_BELOW, WRITTEN, catalogue, type App, type FakeModels } from "./helpers.ts";

const CLERK = { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` };
type Data = Record<string, unknown>;
type Result = { status: string; pick: { model: string; passes: number; total: number } | null; edit: { edits: { before: string; after: string }[] }; reportUrl: string; spend: { openmeritUsd: number; customerUsd: number } };
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** What the job should have paid: each distinct model call once, however often it was sent. */
const writerCalls = (models: FakeModels) => models.calls.filter(call => call.ticket.startsWith("writer:"));
const distinctCost = (models: FakeModels) => sum([...new Set(models.calls.map(call => `${call.model}\0${call.ticket}`))].map(key => costOf(key.split("\0")[0]!)));

describe("the cloud app", () => {
  let models: FakeModels;
  let app: App;
  before(async () => { models = await fakeModels(); app = await startApp({ models, env: CLERK }); });
  after(async () => { await stop(app); await models.close(); });

  test("serves protected-resource metadata naming Clerk, and answers MCP only with a token that names an organization", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const metadata = await (await fetch(`${app.url}${path}`)).json() as Data;
      assert.equal(metadata.resource, "https://openmerit.test/mcp");
      assert.deepEqual(metadata.authorization_servers, ["https://clerk.openmerit.test"]);
      assert.ok((metadata.scopes_supported as string[]).includes("user:org:read"));
    }
    const anonymous = await caller(app, null).rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/openmerit\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

    const signedIn = caller(app, "test:user_a:org_a:admin");
    const init = await signedIn.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.body.result?.protocolVersion, "2025-06-18");
    const tools = await signedIn.rpc("tools/list");
    assert.deepEqual(tools.body.result?.tools?.map(tool => tool.name), ["openmerit_recommend", "openmerit_result", "openmerit_answer", "openmerit_tasks", "openmerit_retire"]);

    const noOrganization = await caller(app, "test:user_b").tool("openmerit_tasks", {});
    assert.equal(noOrganization.isError, true);
    assert.equal(noOrganization.text, NO_ORGANIZATION);
  });

  test("refuses a job without a plan, a key passed as an argument, and a bundle that carries a secret", async () => {
    const agent = caller(app, "test:user_c:org_unpaid:admin");
    const unpaid = await agent.tool("openmerit_recommend", { bundle: bundle() });
    assert.equal(unpaid.isError, true);
    assert.match(unpaid.text, /no active OpenMerit plan.*app\.openmerit\.test\/plan\//);
    await subscribe(app, "org_unpaid");
    const keyArgument = await agent.tool("openmerit_recommend", { bundle: bundle(), apiKey: "sk-live-123456" });
    assert.equal(keyArgument.isError, true);
    assert.match(keyArgument.text, /No tool takes keys/);
    const secretInBundle = await agent.tool("openmerit_recommend", { bundle: { ...bundle(), tools: [{ name: "lookup", parameters: { type: "object" }, mockResult: { api_key: "x" } }] } });
    assert.equal(secretInBundle.isError, true);
    assert.match(secretInBundle.text, /must not contain keys/);
    assert.equal(models.calls.length, 0);
  });

  test("applies only Stripe webhooks with a valid signature, once each", async () => {
    const payload = JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", created: 1, data: { object: { client_reference_id: "org_x", customer: "cus_x" } } });
    const forged = await fetch(`${app.url}/api/stripe/webhook`, { method: "POST", body: payload, headers: { "stripe-signature": signStripePayload(payload, "whsec_wrong") } });
    assert.equal(forged.status, 400);
    const first = await subscribe(app, "org_billing", { includedEvals: 10 });
    assert.deepEqual(await first.json(), { received: true, applied: true });
    const replayed = await subscribe(app, "org_billing", { includedEvals: 99 });
    assert.deepEqual(await replayed.json(), { received: true, applied: false });
    const me = await caller(app, "test:user_d:org_billing:admin").api<Data>("/api/me");
    assert.deepEqual({ ...(me.body.plan as Data), periodEnd: null }, { name: "Team", status: "active", periodEnd: null, includedEvals: 10, usedEvals: 0 });
    const checkout = await caller(app, "test:user_d:org_billing:admin").api<{ url: string }>("/api/billing/checkout", { method: "POST" });
    assert.match(checkout.body.url, /^https:\/\/checkout\.stripe\.test\/org_billing$/);
    const member = await caller(app, "test:user_e:org_billing").api("/api/billing/portal", { method: "POST" });
    assert.equal(member.status, 403);
  });

  test("stores endpoint keys encrypted, never returns them, and lets a lower guardrail level only narrow a constraint", async () => {
    const admin = caller(app, "test:user_f:org_keys:admin");
    const key = "sk-customer-secret-abcd";
    const added = await admin.api<Data>("/api/endpoints", { method: "POST", body: JSON.stringify({ kind: "openai-compatible", baseUrl: "https://api.fireworks.test/v1", apiKey: key, allowedModels: ["acme/fine-tune-1"] }) });
    assert.equal(added.status, 201);
    assert.equal(added.body.keyLast4, "abcd");
    const listed = await admin.fetch("/api/endpoints");
    const exported = await admin.fetch("/api/account/export", { method: "POST" });
    for (const text of [JSON.stringify(added.body), await listed.text(), await exported.text()]) assert.ok(!text.includes(key.slice(0, -4)), "the key must never be returned");
    assert.equal((await caller(app, "test:user_g:org_keys").api("/api/endpoints", { method: "POST", body: "{}" })).status, 403);
    const local = await admin.api<{ error: string }>("/api/endpoints", { method: "POST", body: JSON.stringify({ kind: "anthropic", baseUrl: "ftp://x", apiKey: key, allowedModels: ["m"] }) });
    assert.equal(local.status, 400);

    await admin.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/app", settings: { allowedModels: ["a", "b"], budgetUsd: 2 } }) });
    await admin.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "agent", id: "acme/app:claims", settings: { allowedModels: ["a", "c"], budgetUsd: 9 } }) });
    const resolved = await admin.api<{ effective: Data; from: Data; rejected: { key: string; level: string }[] }>("/api/guardrails?level=agent&id=acme/app:claims");
    assert.deepEqual(resolved.body.effective, { allowedModels: ["a", "b"], budgetUsd: 9 });
    assert.deepEqual(resolved.body.from, { allowedModels: "environment", budgetUsd: "agent" });
    assert.deepEqual(resolved.body.rejected.map(item => [item.key, item.level]), [["allowedModels", "agent"]]);
    assert.equal((await caller(app, "test:user_g:org_keys").api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/app", settings: {} }) })).status, 403);

    const preflight = await fetch(`${app.url}/api/me`, { method: "OPTIONS", headers: { origin: "https://app.openmerit.test" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.openmerit.test");
    const elsewhere = await fetch(`${app.url}/api/me`, { method: "OPTIONS", headers: { origin: "https://evil.test" } });
    assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);
  });
});

test("a job waits on its label check across a restart, then measures on OpenRouter and the customer's endpoint, and a watch re-runs it", async () => {
  const models = await fakeModels();
  let app = await startApp({ models, env: { ...CLERK, TEST_CATALOGUE_VERSION: "next" } });
  try {
    await subscribe(app, "org_run");
    const customerKey = "sk-customer-key-9876";
    await caller(app, "test:user_r:org_run:admin").api("/api/endpoints", { method: "POST", body: JSON.stringify({ kind: "openai-compatible", baseUrl: `${models.url}/v1`, apiKey: customerKey, allowedModels: ["acme/fine-tune-1"] }) });
    const agent = () => caller(app, "test:user_r:org_run:admin");
    // The session ID from initialize names the client, and the run records it.
    const session = (await agent().rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.0" } })).headers.get("mcp-session-id") ?? "";
    const started = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" }, { "mcp-session-id": session });
    assert.equal(started.isError, false, started.text);
    const jobId = started.data.job_id as string;
    const provisional = started.data.provisional as { model: string; reason: string };
    assert.notEqual(provisional.model, "openai/gpt-5.4");
    assert.match(provisional.reason, /Catalogue estimate, not yet measured/);

    const result = () => agent().tool("openmerit_result", { job_id: jobId });
    const asking = await waitFor(result, value => value.data.status === "needs_input");
    assert.deepEqual((asking.data.questions as { id: string }[]).map(question => question.id), ["label_example-7", "label_check"]);
    assert.match(asking.text, /Where is my invoice for March\?/);
    const check = (asking.data.questions as { id: string; options: { value: string; label: string }[] }[])[1]!;
    assert.deepEqual(check.options.map(option => option.value), ["written-1", "written-2"]);
    assert.match(check.options[1]!.label, /The dashboard shows a blank page → technical/);
    // The writer asks for 12 cases, gets 2, and asks once more for the other 10.
    assert.deepEqual(models.calls.map(call => call.ticket), ["writer:12", "writer:10"], "nothing is measured before the label check");

    await crash(app);
    app = await startApp({ models, env: app.env, storage: app.storage, enginePort: app.enginePort });
    const resumed = await waitFor(result, value => value.data.status === "needs_input", 90_000);
    assert.deepEqual((resumed.data.questions as { id: string }[]).map(question => question.id), ["label_example-7", "label_check"]);

    // Unticking written-2 drops that case.
    const answered = await agent().tool("openmerit_answer", { job_id: jobId, answers: { "label_example-7": "billing", label_check: ["written-1"] } });
    assert.equal(answered.isError, false, answered.text);
    const done = await waitFor(result, value => value.data.status === "done" || value.data.status === "failed" || value.data.status === "stopped");
    assert.equal(done.data.status, "done", done.text);
    const measured = done.data.result as Result;
    assert.equal(measured.status, "picked");
    assert.equal(measured.pick!.total, 8);
    assert.equal(measured.pick!.passes, 8);
    assert.ok((catalogue.models.find(model => model.id === measured.pick!.model)?.eci ?? 200) >= WEAK_BELOW, `${measured.pick!.model} answers wrongly in the fake`);
    assert.deepEqual(measured.edit.edits.map(edit => edit.before), ["gpt-5.4"]);
    assert.ok(models.calls.some(call => call.ticket === "Where is my invoice for March?"), "the labelled case is measured");
    const [kept, dropped] = Object.keys(WRITTEN);
    assert.ok(models.calls.some(call => call.ticket === kept) && !models.calls.some(call => call.ticket === dropped), "only the ticked written case is measured");
    assert.equal(writerCalls(models).length, 2, "the restart writes no new cases");

    // OpenRouter calls carry OpenMerit's key; the customer's endpoint gets the customer's key, decrypted in memory.
    assert.ok(models.calls.filter(call => call.model !== "acme/fine-tune-1").every(call => call.auth === "Bearer or-test-key"));
    const fineTune = models.calls.filter(call => call.model === "acme/fine-tune-1");
    assert.ok(fineTune.length > 0 && fineTune.every(call => call.auth === `Bearer ${customerKey}`));
    const report = await agent().api<{ candidates: { model: string; inCatalogue: boolean; funding: string; stage: string }[]; spend: Result["spend"] }>(`/api/runs/${jobId}`);
    assert.deepEqual(report.body.candidates.filter(item => item.model === "acme/fine-tune-1").map(item => [item.inCatalogue, item.funding, item.stage]), [[false, "customer", "challenger"]]);
    assert.ok(Math.abs(report.body.spend.customerUsd - fineTune.length * costOf("acme/fine-tune-1")) < 1e-9);
    assert.ok(Math.abs(report.body.spend.openmeritUsd + report.body.spend.customerUsd - distinctCost(models)) < 1e-9);

    const markdown = await agent().fetch(`/r/${jobId}.md`);
    assert.match(await markdown.text(), /^# OpenMerit report: ticket classifier[\s\S]*acme\/fine-tune-1` \(measured only\)/);
    assert.equal((await caller(app, "test:user_z:org_other:admin").fetch(`/r/${jobId}.md`)).status, 404, "another account cannot read the report");
    const share = await agent().api<{ url: string }>(`/api/runs/${jobId}/share`, { method: "POST" });
    const publicPath = new URL(share.body.url).pathname;
    assert.equal((await fetch(`${app.url}${publicPath}`)).status, 200);
    const me = await agent().api<{ plan: { usedEvals: number } }>("/api/me");
    assert.equal(me.body.plan.usedEvals, 1);

    // Watching is on from the first job: a new catalogue version starts a watch job, which reuses the saved label and written case and asks nothing.
    type TaskView = { id: string; state: string; idleSince: string | null; watching: boolean };
    const taskView = async () => (await agent().api<TaskView[]>("/api/tasks")).body[0]!;
    const taskRow = await taskView();
    assert.deepEqual([taskRow.state, taskRow.idleSince, taskRow.watching], ["watching", null, true]);
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    assert.deepEqual(await rivet.catalogue.getOrCreate(["global"]).refresh(), { version: "next", changed: true });
    const runs = await waitFor(() => agent().api<{ id: string; kind: string; status: string }[]>("/api/runs"), value => value.body.some(run => run.kind === "watch" && run.status === "done"))
      .catch(async (error: Error) => { throw new Error(`${error.message}\nTask: ${JSON.stringify((await agent().api(`/api/tasks/${taskRow!.id}`)).body).slice(0, 1500)}`); });
    assert.equal(runs.body.filter(run => run.kind === "watch").length, 1);
    // The first run is no longer the task's latest, and the list still says what it found.
    const listed = (await agent().api<{ id: string; kind: string; askedBy: string | null; result: { status: string; model: string | null; from: string | null } | null }[]>("/api/runs")).body;
    const first = listed.find(run => run.id === jobId);
    assert.deepEqual(first?.result && [first.result.status, first.result.model, first.result.from], ["picked", measured.pick!.model, "openai/gpt-5.4"]);
    assert.deepEqual([first?.askedBy, listed.find(run => run.kind === "watch")?.askedBy], ["claude-code", null]);
    assert.equal(writerCalls(models).length, 2, "the watch job writes no new cases");
    const watched = await agent().api<{ pick: { total: number } }>(`/api/runs/${runs.body.find(run => run.kind === "watch")!.id}`);
    assert.equal(watched.body.pick.total, 8);
    const tasks = await agent().tool("openmerit_tasks", {});
    assert.match(tasks.text, /ticket classifier \[[\w-]+\] \(acme\/support\): openai\/gpt-5\.4 → .*, picked, watching/);

    // Freezing: the watch guardrail inherits from the environment, a task-level value overrides it, and a frozen task's tick starts nothing.
    const tick = () => rivet.task.get(["org_run", taskRow.id]).watchTick();
    const guardrail = (level: string, id: string, settings: Record<string, unknown>) => agent().api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level, id, settings }) });
    await guardrail("environment", "acme/support", { watch: false });
    assert.deepEqual([(await taskView()).state, (await taskView()).watching], ["frozen", false]);
    assert.deepEqual(await tick(), { started: null, reason: "task is frozen" });
    await guardrail("task", taskRow.id, { watch: true });
    assert.equal((await taskView()).state, "watching");
    await guardrail("task", taskRow.id, {});
    assert.equal((await taskView()).state, "frozen");
    await guardrail("environment", "acme/support", {});

    // Retiring stops the watch and keeps the runs and reports; the next recommend call brings the task back.
    assert.deepEqual((await agent().tool("openmerit_retire", { task_id: taskRow.id })).data, { task_id: taskRow.id, state: "retired" });
    assert.equal((await taskView()).state, "retired");
    assert.deepEqual(await tick(), { started: null, reason: "not watching" });
    assert.equal((await agent().fetch(`/r/${jobId}.md`)).status, 200);
    assert.equal((await agent().api<unknown[]>("/api/runs")).body.length, 2);
    assert.equal((await agent().tool("openmerit_retire", { task_id: "nope" })).isError, true);
    const back = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    assert.equal(back.isError, false, back.text);
    assert.equal((await taskView()).state, "watching");
    await waitFor(() => agent().tool("openmerit_result", { job_id: back.data.job_id }), value => value.data.status === "done");

    // Deleting needs an admin who verified a first factor in the last 10 minutes, and erases the task, its runs and its reports.
    await guardrail("task", taskRow.id, { budgetUsd: 2 });
    const usedBefore = (await agent().api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals;
    const remove = (token: string, id = taskRow.id) => caller(app, token).api<Data>(`/api/tasks/${id}`, { method: "DELETE" });
    assert.equal((await remove("test:user_m:org_run")).status, 403, "a member cannot delete");
    const stale = await remove("test:user_r:org_run:admin:11");
    assert.equal(stale.status, 403);
    assert.deepEqual(stale.body, { clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: { level: "first_factor", afterMinutes: 10 } } } });
    assert.equal((await remove("test:user_r:org_run:admin:9", "nope")).status, 404);
    assert.deepEqual((await remove("test:user_r:org_run:admin:9")).body, { deleted: true, jobs: 3 });
    assert.deepEqual((await agent().api<unknown[]>("/api/tasks")).body, []);
    assert.deepEqual((await agent().api<unknown[]>("/api/runs")).body, []);
    assert.equal((await agent().fetch(`/r/${jobId}.md`)).status, 404);
    assert.equal((await agent().api(`/api/runs/${jobId}`)).status, 404);
    assert.equal((await fetch(`${app.url}${publicPath}`)).status, 404, "the share link stops loading");
    assert.equal((await agent().tool("openmerit_result", { job_id: jobId })).isError, true);
    assert.deepEqual((await agent().api<{ settings: unknown[] }>(`/api/guardrails?level=task&id=${taskRow.id}`)).body.settings, []);
    assert.equal((await agent().api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals, usedBefore, "deleting does not give evaluations back");
    const [deletion] = (await agent().api<Data[]>("/api/tasks/deleted")).body;
    assert.deepEqual([deletion!.taskId, deletion!.name, deletion!.userId, deletion!.jobs], [taskRow.id, "ticket classifier", "user_r", 3]);
    // A later recommend call starts the task fresh: its labels and approved cases went with it, so it asks again.
    const fresh = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    const asked = await waitFor(() => agent().tool("openmerit_result", { job_id: fresh.data.job_id }), value => value.data.status === "needs_input");
    assert.deepEqual((asked.data.questions as { id: string }[]).map(question => question.id), ["label_example-7", "label_check"]);
    assert.equal((await caller(app, "test:user_q:org_run:admin:30").api("/api/account", { method: "DELETE" })).status, 403, "deleting the account needs a recent sign-in too");
  } finally { await stop(app); await models.close(); }
});

test("a task goes idle once no recommend call came for the idle period, and retired and frozen say why it stopped first", () => {
  const day = 24 * 60 * 60 * 1000, base = { retired: false, watch: undefined, lastRecommendAt: 0, idleAfterMs: 30 * day };
  assert.deepEqual(watchState({ ...base, now: 30 * day - 1 }), { state: "watching", idleSince: null });
  assert.deepEqual(watchState({ ...base, now: 30 * day }), { state: "idle", idleSince: new Date(30 * day).toISOString() });
  assert.deepEqual(watchState({ ...base, lastRecommendAt: null, now: 90 * day }), { state: "watching", idleSince: null });
  assert.equal(watchState({ ...base, watch: true, now: 30 * day }).state, "idle");
  assert.equal(watchState({ ...base, watch: false, now: 30 * day }).state, "frozen");
  assert.equal(watchState({ ...base, retired: true, watch: false, now: 30 * day }).state, "retired");
});

test("a measure step replayed after a crash does not count its spend twice", async () => {
  const models = await fakeModels();
  let app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_replay");
    const agent = () => caller(app, "test:user_s:org_replay:admin");
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("replayed classifier", false) });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent().tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    // The fourth measured call is in the current model's measure step, sent with three others, some of them settled. Then the node dies.
    let crashed: Promise<void> | null = null;
    const written = models.calls.length;
    models.onCall = async index => { if (index === written + 3) { models.onCall = null; crashed = crash(app); await crashed; } };
    // The answer reaches the job's queue before measuring starts, so the node may die before this call returns.
    await agent().tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } }).catch(() => null);
    await waitFor(async () => crashed, value => value !== null, 60_000);
    await crashed;
    app = await startApp({ models, env: app.env, storage: app.storage, enginePort: app.enginePort });
    const done = await waitFor(() => agent().tool("openmerit_result", { job_id: jobId }), value => value.data.status === "done" || value.data.status === "failed", 180_000);
    assert.equal(done.data.status, "done", done.text);

    const sent = models.calls.length;
    const distinct = new Set(models.calls.map(call => `${call.model}\0${call.ticket}`)).size;
    assert.ok(sent > distinct, `the step must have been replayed: ${sent} calls sent, ${distinct} distinct`);
    const spend = (done.data.result as Result).spend;
    assert.ok(Math.abs(spend.openmeritUsd - distinctCost(models)) < 1e-9, `spend ${spend.openmeritUsd} counts each of the ${distinct} calls once (${distinctCost(models)})`);
    const period = await agent().api<{ openmeritUsd: number }>("/api/spend");
    assert.ok(Math.abs(period.body.openmeritUsd - spend.openmeritUsd) < 1e-9);
  } finally { await stop(app); await models.close(); }
});

test("a challenger the budget refuses ends the challengers, and the job still reports the finalists' pick", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_capped");
    const agent = caller(app, "test:user_t:org_capped:admin");
    // The customer's fine-tune is the only customer-paid model, and a challenger: the customer cap refuses it before anything is sent.
    await agent.api("/api/endpoints", { method: "POST", body: JSON.stringify({ kind: "openai-compatible", baseUrl: `${models.url}/v1`, apiKey: "sk-customer-capped-1234", allowedModels: ["acme/fine-tune-1"] }) });
    await agent.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/capped", settings: { customerSpendCapUsd: 0.000001 } }) });
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("capped classifier", false), environment: "acme/capped" });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    const done = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { top: unknown[]; notices: string[] }>(`/api/runs/${jobId}`)).body;
    assert.equal(result.status, "picked");
    assert.ok(result.pick && result.top.length > 0);
    assert.ok(result.notices.some(notice => /^Challengers? not measured: .*acme\/fine-tune-1.*Stopped while measuring acme\/fine-tune-1/.test(notice)), result.notices.join("\n"));
    assert.match(done.text, /Note: Challengers? not measured/);
    assert.equal(models.calls.filter(call => call.model === "acme/fine-tune-1").length, 0, "nothing is sent to a refused challenger");
    const progress = done.data.progress as { measured: number; planned: number };
    assert.ok(progress.planned >= progress.measured && progress.planned <= progress.measured + 4, JSON.stringify(progress));
  } finally { await stop(app); await models.close(); }
});
