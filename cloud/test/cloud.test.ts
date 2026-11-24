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
import { evaluateTask } from "../src/engine.ts";
import { buildPool } from "../src/pool.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { bundle, caller, costOf, crash, fakeCapture, fakeModels, startApp, stop, subscribe, waitFor, WEAK_BELOW, WRITTEN, TICKETS, catalogue, type App, type FakeModels } from "./helpers.ts";

const CLERK = { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` };
type Data = Record<string, unknown>;
type Result = { status: string; pick: { model: string; passes: number; total: number } | null; edit: { edits: { before: string; after: string }[] }; reportUrl: string; spend: { openmeritUsd: number; customerUsd: number } };
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** What every call the fake answered cost, for a job none of whose steps ran twice. */
const sentCost = (models: FakeModels) => sum(models.calls.map(call => costOf(call.model)));
/**
 * What the CLI's policy does with the fake's answers: openmerit/engine's evaluateTask over the pool the
 * job builds, three runs of the bundle's six labelled examples and both written cases, with a measure
 * that passes a model on every case unless the fake answers it wrongly. Returns the model calls it
 * makes, what they cost, and its Top 3, which the job must match.
 */
async function cliPolicy(task: string) {
  const pool = buildPool({ catalogue, endpoints: [{ id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.test/v1", allowedModels: "all", funding: "openmerit" }], bundle: bundle(task, false) as TaskBundle, guardrails: {} });
  const cases = [...Object.keys(TICKETS).slice(0, 6), ...Object.keys(WRITTEN)];
  let calls = 0, spend = 0;
  const evaluated = await evaluateTask({
    ladder: pool.ranked, unplaced: pool.unplaced, strength: item => item.eci ?? -Infinity, items: cases, repeats: 3, baselinePrice: pool.baseline!.price,
    measure: async (option, items) => {
      const model = (option ?? pool.baseline!).model, ids = items ?? cases;
      calls += ids.length; spend += ids.length * costOf(model);
      const strong = (catalogue.models.find(item => item.id === model)?.eci ?? 200) >= WEAK_BELOW;
      return { items: Object.fromEntries(ids.map(id => [id, strong])), costUsd: ids.length * costOf(model) };
    },
    sample: reliable => reliable.slice(0, 5),
  });
  return { calls, spend, top: evaluated.top.map(item => [item.option.model, item.passes, item.total]) };
}
const writerCalls = (models: FakeModels) => models.calls.filter(call => call.ticket.startsWith("writer:"));

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
  const posthog = await fakeCapture();
  const events = (name: string) => posthog.events.filter(event => event.event === name);
  let app = await startApp({ models, env: { ...CLERK, TEST_CATALOGUE_VERSION: "next", POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: posthog.url } });
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
    // One mcp_tool_called per tool call, as the signed-in user, with no arguments or result.
    const [called, ...more] = (await waitFor(async () => events("mcp_tool_called"), found => found.length > 0, 10_000));
    assert.equal(more.length, 0);
    assert.deepEqual([called!.distinct_id, called!.api_key], ["user_r", "phc_test"]);
    assert.deepEqual({ ...called!.properties, duration_ms: typeof called!.properties.duration_ms }, { interface: "mcp", tool: "openmerit_recommend", client: "claude-code", ok: true, duration_ms: "number", account_id: "org_run" });

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
    assert.equal(new URL(measured.reportUrl).pathname, `/r/${jobId}/`, "the app serves reports at /r/<id>/");
    // Every case, three times.
    assert.equal(measured.pick!.total, 24);
    assert.equal(measured.pick!.passes, 24);
    assert.ok((catalogue.models.find(model => model.id === measured.pick!.model)?.eci ?? 200) >= WEAK_BELOW, `${measured.pick!.model} answers wrongly in the fake`);
    assert.deepEqual(measured.edit.edits.map(edit => [edit.before, edit.after]), [['const MODEL = "gpt-5.4";', `const MODEL = "${measured.pick!.model}";`]]);
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
    assert.ok(Math.abs(report.body.spend.openmeritUsd + report.body.spend.customerUsd - sentCost(models)) < 1e-9);

    const markdown = await agent().fetch(`/api/r/${jobId}.md`);
    assert.match(await markdown.text(), /^# OpenMerit report: ticket classifier[\s\S]*acme\/fine-tune-1` \(measured only\)/);
    assert.equal((await caller(app, "test:user_z:org_other:admin").fetch(`/api/r/${jobId}.md`)).status, 404, "another account cannot read the report");
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
    // run_completed once per job, from the job actor, across the restart: the MCP run as its user, the watch run as the account with no person profile.
    const completed = await waitFor(async () => events("run_completed"), found => found.length >= 2, 10_000);
    assert.deepEqual(completed.map(event => [event.distinct_id, event.properties.trigger, event.properties.status, event.properties.account_id, event.properties.$process_person_profile]),
      [["user_r", "mcp", "done", "org_run", undefined], ["org_run", "watch", "done", "org_run", false]]);
    assert.ok(completed.every(event => event.properties.interface === "cloud" && typeof event.properties.duration_ms === "number" && event.properties.duration_ms >= 0));
    // The first run is no longer the task's latest, and the list still says what it found.
    const listed = (await agent().api<{ id: string; kind: string; askedBy: string | null; result: { status: string; model: string | null; from: string | null } | null }[]>("/api/runs")).body;
    const first = listed.find(run => run.id === jobId);
    assert.deepEqual(first?.result && [first.result.status, first.result.model, first.result.from], ["picked", measured.pick!.model, "openai/gpt-5.4"]);
    assert.deepEqual([first?.askedBy, listed.find(run => run.kind === "watch")?.askedBy], ["claude-code", null]);
    assert.equal(writerCalls(models).length, 2, "the watch job writes no new cases");
    const watched = await agent().api<{ pick: { total: number } }>(`/api/runs/${runs.body.find(run => run.kind === "watch")!.id}`);
    assert.equal(watched.body.pick.total, 24);
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
    assert.equal((await agent().fetch(`/api/r/${jobId}.md`)).status, 200);
    assert.equal((await agent().api<unknown[]>("/api/runs")).body.length, 2);
    assert.equal((await agent().tool("openmerit_retire", { task_id: "nope" })).isError, true);
    const back = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    assert.equal(back.isError, false, back.text);
    assert.equal((await taskView()).state, "watching");
    await waitFor(() => agent().tool("openmerit_result", { job_id: back.data.job_id }), value => value.data.status === "done");
    await waitFor(async () => events("run_completed"), found => found.length >= 3, 10_000);
    assert.deepEqual(events("run_completed").map(event => event.properties.trigger), ["mcp", "watch", "mcp"]);
    assert.ok(posthog.events.every(event => !JSON.stringify(event).includes("ticket")), "no bundle content reaches analytics");

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
    assert.equal((await agent().fetch(`/api/r/${jobId}.md`)).status, 404);
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
    assert.equal(events("run_completed").length, 3, "each job sent run_completed once");
  } finally { await stop(app); await models.close(); await posthog.close(); }
});

test("the coding agent sends back the user's decision on a result's change: an approval moves the watched task onto the pick, a decline keeps it", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { ...CLERK, TEST_CATALOGUE_VERSION: "next" } });
  try {
    await subscribe(app, "org_decide");
    const agent = () => caller(app, "test:user_d:org_decide:admin");
    const start = async (task: string) => (await agent().tool("openmerit_recommend", { bundle: bundle(task), environment: "acme/decide" })).data.job_id as string;
    const [kept, dropped] = [await start("ticket classifier"), await start("reply router")];
    const result = (jobId: string) => agent().tool("openmerit_result", { job_id: jobId });
    const finish = async (jobId: string) => {
      await waitFor(() => result(jobId), value => value.data.status === "needs_input");
      await agent().tool("openmerit_answer", { job_id: jobId, answers: { "label_example-7": "billing", label_check: ["written-1", "written-2"] } });
      return waitFor(() => result(jobId), value => ["done", "failed", "stopped"].includes(String(value.data.status)));
    };
    const [done, other] = [await finish(kept), await finish(dropped)];
    const measured = done.data.result as Result & { approval: { id: string } };
    assert.equal(measured.status, "picked", done.text);
    const pick = measured.pick!.model;
    // The result tells the agent to send the user's answer back, keyed by the approval question's ID.
    assert.equal(measured.approval.id, "configure_ticket_classifier");
    assert.match(done.text, /send their answer with openmerit_answer, job_id "[\w-]+" and answers \{"configure_ticket_classifier": true\}/);
    const decide = (jobId: string, answers: Record<string, unknown>) => agent().tool("openmerit_answer", { job_id: jobId, answers });
    assert.equal((await decide(kept, { configure_ticket_classifier: "yes" })).isError, true, "a decision is true or false");

    const approved = await decide(kept, { configure_ticket_classifier: true });
    assert.equal(approved.isError, false, approved.text);
    assert.match(approved.text, new RegExp(`Decision: openai/gpt-5\\.4 → ${pick.replaceAll(".", "\\.")} \\(openrouter\\), approved by User D on \\d{4}-\\d{2}-\\d{2}\\.`));
    // The first decision stands.
    const again = await decide(kept, { configure_ticket_classifier: false });
    assert.equal(again.isError, true);
    assert.match(again.text, /already recorded[^]*approved by User D/);
    assert.match((await result(kept)).text, /Decision: .*approved by User D/);
    const run = await agent().api<{ decision: { decision: string; by: string; name: string } }>(`/api/runs/${kept}`);
    assert.deepEqual([run.body.decision.decision, run.body.decision.by, run.body.decision.name], ["approved", "user_d", "User D"]);

    assert.equal((other.data.result as Result).status, "picked", other.text);
    assert.equal((await decide(dropped, { configure_reply_router: false })).isError, false);

    // The approved task now runs the pick, and its code ref has the edited literal; the declined one is unchanged.
    type TaskRow = { id: string; name: string; currentModel: string; decision: { decision: string } | null };
    const tasks = (await agent().api<TaskRow[]>("/api/tasks")).body;
    const classifier = tasks.find(task => task.name === "ticket classifier")!, router = tasks.find(task => task.name === "reply router")!;
    assert.deepEqual([classifier.currentModel, classifier.decision?.decision], [pick, "approved"]);
    assert.deepEqual([router.currentModel, router.decision?.decision], ["openai/gpt-5.4", "declined"]);
    const saved = (await agent().api<{ bundle: TaskBundle }>(`/api/tasks/${classifier.id}`)).body.bundle;
    assert.deepEqual([saved.current.model, saved.codeRefs?.[0]?.spelling], [pick, `const MODEL = "${pick}";`]);
    const listed = (await agent().tool("openmerit_tasks", {})).text;
    assert.match(listed, new RegExp(`ticket classifier .*: ${pick.replaceAll(".", "\\.")}, switched, watching, switched: .*approved by User D`));
    assert.match(listed, /reply router .*: openai\/gpt-5\.4 → .*, picked, watching, declined: .*declined by User D/);

    // The next watch run measures the pick as the current model.
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    await rivet.catalogue.getOrCreate(["global"]).refresh();
    const runs = await waitFor(() => agent().api<{ id: string; taskId: string; kind: string; status: string }[]>("/api/runs"), value => value.body.some(item => item.kind === "watch" && item.taskId === classifier.id && item.status === "done"));
    const watch = runs.body.find(item => item.kind === "watch" && item.taskId === classifier.id)!;
    const watched = await agent().api<{ baseline: { model: string }; edit: { edits: { before: string }[] } }>(`/api/runs/${watch.id}`);
    assert.equal(watched.body.baseline.model, pick);
    assert.ok(watched.body.edit.edits.every(edit => edit.before === `const MODEL = "${pick}";`), "an edit proposed by the watch run matches the code as edited");
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

    const expected = await cliPolicy("replayed classifier");
    const measuring = models.calls.filter(call => !call.ticket.startsWith("writer:")).length;
    assert.ok(measuring > expected.calls, `the step must have been replayed: ${measuring} calls sent, ${expected.calls} in the policy`);
    type Row = { key: string; job_id: string; model: string };
    const ledger = (await agent().api<{ ledger: Row[] }>("/api/account/export", { method: "POST" })).body.ledger.filter(row => row.job_id === jobId && !row.key.startsWith(`${jobId}/cases/`));
    assert.equal(ledger.length, expected.calls, "one ledger row per call the policy makes: the replayed step reused its keys");
    // The current model ran every case three times, each run its own step with its own keys.
    const report = (await agent().api<{ baseline: { passes: number; total: number }; top: { model: string; passes: number; total: number }[] }>(`/api/runs/${jobId}`)).body;
    assert.deepEqual([report.baseline.passes, report.baseline.total], [24, 24]);
    assert.equal(new Set(ledger.filter(row => row.model === "openai/gpt-5.4").map(row => row.key.split("/")[1])).size, 3);
    const spend = (done.data.result as Result).spend;
    const writing = sum(writerCalls(models).map(call => costOf(call.model)));
    assert.ok(Math.abs(spend.openmeritUsd - (expected.spend + writing)) < 1e-9, `spend ${spend.openmeritUsd} counts each of the ${expected.calls} calls once (${expected.spend + writing})`);
    assert.deepEqual(report.top.map(item => [item.model, item.passes, item.total]), expected.top, "the job's Top 3 is the one the CLI's policy gives for the same answers");
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
    // A cap for the job is a guardrail to review, not a budget to raise.
    const fixes = (result as { fixes?: { kind: string; notice: string; path?: string }[] }).fixes ?? [];
    const capped = fixes.find(fix => /^Challengers? not measured/.test(fix.notice));
    assert.equal(capped?.kind, "open", JSON.stringify(fixes));
    assert.match(capped!.path!, /^\/guardrails\/\?level=task&id=t_/);
    assert.equal(models.calls.filter(call => call.model === "acme/fine-tune-1").length, 0, "nothing is sent to a refused challenger");
    const progress = done.data.progress as { measured: number; planned: number };
    assert.ok(progress.planned >= progress.measured && progress.planned <= progress.measured + 4, JSON.stringify(progress));
  } finally { await stop(app); await models.close(); }
});

test("a job whose current model fails more than a fifth of its own eval recommends nothing, asks no approval and lists why its cases failed", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_floor");
    const agent = caller(app, "test:user_t:org_floor:admin");
    // Three of the six examples carry the wrong queue, so the current model, which answers right, passes 5 of the 8 cases.
    const wrong = bundle("floor classifier", false);
    for (const example of wrong.examples.slice(0, 3) as { expected?: string }[]) example.expected = example.expected === "billing" ? "account" : "billing";
    const started = await agent.tool("openmerit_recommend", { bundle: wrong });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    const done = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { approval: unknown; failedCases: { caseId: string; kind: string; reason: string }[]; baselineByKind: { kind: string; passes: number; total: number }[] }>(`/api/runs/${jobId}`)).body;
    assert.equal(result.status, "below_floor");
    assert.equal(result.pick, null);
    assert.equal(result.approval ?? null, null, "no approval question");
    assert.deepEqual(result.failedCases.map(item => [item.caseId, item.kind]), [["example-1", "example"], ["example-2", "example"], ["example-3", "example"]]);
    assert.match(result.failedCases[0]!.reason, /^Answered (billing|technical|account), expected (billing|account)\.$/);
    assert.deepEqual(result.baselineByKind, [{ kind: "example", passes: 9, total: 18 }, { kind: "typical", passes: 6, total: 6 }]);
    assert.match(done.text, /passed under 80% of its own eval/);
    assert.match(done.text, /Cases it failed, with the grader's reason \(passed by kind: example 9\/18, typical 6\/6\):\n- example-1 \(example\): Answered/);
    // Only the current model ran: no candidate was screened.
    assert.deepEqual([...new Set(models.calls.filter(call => !call.ticket.startsWith("writer:")).map(call => call.model))], ["openai/gpt-5.4"]);
  } finally { await stop(app); await models.close(); }
});

test("an agent's pick is checked on its whole transcript: a cheaper model that calls a tool the task does not offer is not picked", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_agent");
    const agent = caller(app, "test:user_t:org_agent:admin");
    // Every model but the current one answers right after calling a tool the task does not offer.
    const current = bundle().current.model;
    models.misuse = model => model !== current;
    const tools = [{ name: "lookup_ticket", description: "Finds the customer's plan", parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] }, mockResult: { plan: "pro" } }];
    const started = await agent.tool("openmerit_recommend", { bundle: { ...bundle("agent classifier", false), tools }, environment: "acme/agent" });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    const done = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { agentEval: { status: string; passed: boolean; baseline: { passes: number; total: number }; tried: { passed: boolean }[] } }>(`/api/runs/${jobId}`)).body;
    assert.equal(result.status, "agent_eval_failed", "the task's eval passed cheaper models; their flows did not");
    assert.equal(result.agentEval.status, "checked");
    assert.equal(result.agentEval.baseline.passes, result.agentEval.baseline.total, "the current model's flow passes on every case");
    assert.ok(result.agentEval.tried.length > 0 && result.agentEval.tried.every(item => !item.passed), JSON.stringify(result.agentEval));
    assert.ok(models.calls.some(call => call.model !== current), "cheaper models were measured");
  } finally { await stop(app); await models.close(); }
});

test("a job its budget stops offers to raise the budget, and the rerun it asks for runs the task again under the new budget", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_rerun");
    const agent = caller(app, "test:user_u:org_rerun:admin");
    await agent.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/rerun", settings: { repeats: 1, budgetUsd: 0.00001 } }) });
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("rerun classifier", false), environment: "acme/rerun" });
    const jobId = started.data.job_id as string;
    const taskId = (await agent.api<{ id: string; name: string }[]>("/api/tasks")).body.find(task => task.name === "rerun classifier")!.id;
    const settle = async (id: string) => {
      const asked = await waitFor(() => agent.tool("openmerit_result", { job_id: id }), value => ["needs_input", "done", "failed", "stopped"].includes(value.data.status as string), 180_000);
      if (asked.data.status === "needs_input") await agent.tool("openmerit_answer", { job_id: id, answers: { label_check: ["written-1", "written-2"] } });
      return waitFor(() => agent.tool("openmerit_result", { job_id: id }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    };
    const stopped = await settle(jobId);
    assert.equal(stopped.data.status, "stopped", stopped.text);
    type Fix = { kind: string; notice: string; budgetUsd?: number };
    const fixes = (stopped.data.result as { fixes: Fix[] }).fixes;
    const raise = fixes.find(fix => fix.kind === "raise_budget");
    assert.ok(raise && /Stopped while measuring/.test(raise.notice), JSON.stringify(fixes));
    assert.equal(raise.budgetUsd, 1, "twice the budget, rounded up to whole dollars");
    assert.match(stopped.text, new RegExp(`Fix: ask the user to raise this task's budget per job to \\$1, then call openmerit_recommend with job_id "${jobId}" and budget_usd 1\\.`));

    await agent.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "task", id: taskId, settings: { minPassRate: 0.5 } }) });
    assert.equal((await agent.tool("openmerit_recommend", { job_id: jobId, bundle: bundle("rerun classifier", false) })).isError, true, "a rerun takes no bundle");
    const rerun = await agent.tool("openmerit_recommend", { job_id: jobId, budget_usd: raise.budgetUsd });
    assert.equal(rerun.isError, false, rerun.text);
    const task = (await agent.api<{ settings: { key: string; value: unknown }[] }>(`/api/guardrails?level=task&id=${taskId}`)).body;
    assert.deepEqual(Object.fromEntries(task.settings.map(item => [item.key, item.value])), { minPassRate: 0.5, budgetUsd: 1 }, "the budget is raised and the task's other settings kept");
    const done = await settle(rerun.data.job_id as string);
    assert.equal(done.data.status, "done", done.text);
    assert.equal((done.data.result as Result).status, "picked");

    // The app's Run again starts the same task from the run page.
    const again = await agent.api<{ jobId: string; taskId: string }>(`/api/runs/${jobId}/rerun`, { method: "POST", body: "{}" });
    assert.equal(again.status, 201);
    assert.equal(again.body.taskId, taskId);
    assert.equal((await agent.api(`/api/runs/job_nope/rerun`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await agent.api(`/api/runs/${jobId}/rerun`, { method: "POST", body: JSON.stringify({ budgetUsd: -1 }) })).status, 409);
    await settle(again.body.jobId);
  } finally { await stop(app); await models.close(); }
});

test("when no measured model is cheaper per call than the current one, the job measures the provisional pick before keeping it, and says why", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_provisional");
    const agent = caller(app, "test:user_p:org_provisional:admin");
    const run = async (task: string, cheap: (model: string, provisional: string) => boolean) => {
      const started = await agent.tool("openmerit_recommend", { bundle: bundle(task, false), environment: "acme/provisional" });
      const jobId = started.data.job_id as string;
      const provisional = (started.data.provisional as { model: string }).model;
      // Measured per call, every model the search reaches costs more than the current one.
      models.cost = model => (cheap(model, provisional) ? undefined : 0.01);
      await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
      await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
      const done = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
      assert.equal(done.data.status, "done", done.text);
      type Top = { model: string; cheaperThanCurrent: boolean | null };
      const result = done.data.result as Result & { reason: string; baseline: { passes: number; total: number; costPerCallUsd: number; latencyMs: number | null }; top: Top[] };
      const report = (await agent.api<{ notices: string[]; reason: string; top: Top[] }>(`/api/runs/${jobId}`)).body;
      // The app's report JSON explains the result as openmerit_result does.
      assert.equal(report.reason, result.reason);
      assert.deepEqual(report.top.map(item => item.cheaperThanCurrent), result.top.map(item => item.cheaperThanCurrent));
      const notices = report.notices;
      return { jobId, provisional, done, result, notices };
    };

    const switched = await run("provisional classifier", (model, provisional) => model === "openai/gpt-5.4" || model === provisional);
    assert.equal(switched.result.status, "picked", switched.done.text);
    assert.equal(switched.result.pick!.model, switched.provisional);
    assert.ok(switched.notices.some(notice => notice.includes(`the provisional pick ${switched.provisional} was measured on every case`)), switched.notices.join("\n"));
    assert.match(switched.result.reason, new RegExp(`^Switch from \`openai/gpt-5.4\` to \`${switched.provisional}\``));
    assert.deepEqual([switched.result.baseline.passes, switched.result.baseline.total], [24, 24]);
    assert.ok(switched.result.baseline.costPerCallUsd > 0);
    assert.deepEqual(switched.result.top.map(item => item.cheaperThanCurrent), [true, false, false]);
    assert.equal(new URL(switched.result.reportUrl).pathname, `/r/${switched.jobId}/`);
    assert.match(switched.done.text, /Current model openai\/gpt-5\.4: 24\/24 cases passed, \$0\.000\d+ per call/);

    // When the provisional pick costs more too, the job keeps the current model and says which model came closest.
    const kept = await run("costly classifier", model => model === "openai/gpt-5.4");
    assert.equal(kept.result.status, "keep_current", kept.done.text);
    assert.match(kept.result.reason, /^Keep `openai\/gpt-5\.4`: \S+ passed 24\/24 but costs \$0\.0100 per call against \$0\.000\d+, and no measured model was both as accurate and cheaper\.$/);
    assert.ok(kept.result.top.length > 0 && kept.result.top.every(item => item.cheaperThanCurrent === false));
    assert.match(kept.done.text, /No switch proposed \(keep_current\)\. Keep `openai\/gpt-5\.4`/);
  } finally { await stop(app); await models.close(); }
});

test("a job whose actor a deploy's drain stops in the middle of a measure step resumes on the new version, and counts each call once", async () => {
  const models = await fakeModels();
  // A deploy starts the new version next to the old one; the engine drains the old one and moves its actors.
  const first = await startApp({ models, env: { ...CLERK, RIVET_NODE_VERSION: "1" } });
  let app = first;
  let release = () => {};
  try {
    await subscribe(app, "org_drain");
    const agent = () => caller(app, "test:user_d:org_drain:admin");
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("drained classifier", false), environment: "acme/drain" });
    const jobId = started.data.job_id as string;
    const result = () => agent().tool("openmerit_result", { job_id: jobId });
    await waitFor(result, value => value.data.status === "needs_input");
    // Hold the thirtieth model call, past the current model's three runs of 8 cases, until the new version has taken the job.
    let held = false, reached!: () => void;
    const reachedHold = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    models.onCall = async () => {
      if (held || models.calls.filter(call => !call.ticket.startsWith("writer:")).length < 30) return;
      held = true; reached(); await gate;
    };
    await agent().tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    await reachedHold;
    app = await startApp({ models, env: { ...first.env, RIVET_NODE_VERSION: "2" }, storage: first.storage, enginePort: first.enginePort });
    const done = await waitFor(result, value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    release();
    assert.equal(done.data.status, "done", done.text);
    assert.equal((done.data.result as Result).status, "picked");
    const expected = await cliPolicy("drained classifier");
    const sent = models.calls.filter(call => !call.ticket.startsWith("writer:")).length;
    assert.ok(sent > expected.calls, `the interrupted step must have run again: ${sent} calls sent, ${expected.calls} in the policy`);
    // One ledger row per call the policy makes: the step that ran again reused its keys. A call the drain cut off counts at its
    // reservation (the provider may have billed it), and every other call at what it cost.
    const ledger = (await agent().api<{ ledger: { key: string; job_id: string; model: string; status: string; reserved_usd: number; actual_usd: number | null; failed: number }[] }>("/api/account/export", { method: "POST" })).body.ledger.filter(row => row.job_id === jobId);
    assert.equal(ledger.length, expected.calls + writerCalls(models).length);
    const cutOff = ledger.filter(row => row.failed && row.actual_usd === null);
    assert.ok(cutOff.length >= 1 && cutOff.length <= 4, `the held call and at most the others in flight with it: ${cutOff.length}`);
    const counted = expected.spend + sum(writerCalls(models).map(call => costOf(call.model))) + cutOff.reduce((total, row) => total + row.reserved_usd - costOf(row.model), 0);
    const spend = (done.data.result as Result).spend;
    assert.ok(Math.abs(spend.openmeritUsd - counted) < 1e-9, `spend ${spend.openmeritUsd} counts each call once (${counted})`);
  } finally {
    release();
    if (first !== app) first.child.kill("SIGKILL");
    await stop(app); await models.close();
  }
});

test("a measuring job shows the app the candidate under test, case by case, against the current model", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  let release = () => {};
  try {
    await subscribe(app, "org_live");
    const agent = () => caller(app, "test:user_l:org_live:admin");
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("live classifier", false), environment: "acme/live" });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent().tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    // Hold the thirtieth model call: the current model's three runs of 8 cases are done, and a candidate's screen of 5 is under way.
    let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    models.onCall = async () => {
      if (held || models.calls.filter(call => !call.ticket.startsWith("writer:")).length < 30) return;
      held = true; await gate;
    };
    await agent().tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    type Live = { model: string; baseline: { model: string; rate: number } | null; done: number; total: number; passes: number; history: { rate: number }[]; minutesLeft: number | null };
    const view = await waitFor(() => agent().api<{ status: string; live: Live | null }>(`/api/runs/${jobId}`), value => (value.body.live?.done ?? 0) >= 1 && held);
    const live = view.body.live!;
    assert.equal(view.body.status, "running");
    assert.notEqual(live.model, "openai/gpt-5.4", "a candidate, not the current model");
    assert.deepEqual(live.baseline, { model: "openai/gpt-5.4", rate: 100 });
    assert.equal(live.total, 5, "a screen runs the sample cases");
    assert.ok(live.done < live.total, "the held case is not done");
    assert.equal(live.history.length, live.done);
    assert.equal(live.history.at(-1)!.rate, live.passes / live.done * 100);
    assert.ok(live.minutesLeft !== null && live.minutesLeft >= 1);
    release();
    const done = await waitFor(() => agent().tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped"].includes(value.data.status as string), 180_000);
    assert.equal(done.data.status, "done", done.text);
  } finally {
    release();
    await stop(app); await models.close();
  }
});

test("a job whose step fails for good ends failed with a report of what it measured, is not charged, and no longer says running", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { ...CLERK, TEST_AGENT_EVAL: "broken" } });
  try {
    await subscribe(app, "org_broken");
    const agent = caller(app, "test:user_b:org_broken:admin");
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("broken agent classifier", false), environment: "acme/broken", agent: "support-bot" });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    const ended = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status !== "running" && value.data.status !== "queued", 180_000);
    assert.equal(ended.data.status, "failed", ended.text);
    assert.equal(ended.isError, true);
    assert.match(String(ended.data.error), /agent-1.*the agent's eval harness is unreachable/);
    assert.doesNotMatch(ended.text, /call openmerit_result again later/);
    const report = (await agent.api<{ status: string; baseline: { passes: number } | null; candidates: unknown[]; notices: string[] }>(`/api/runs/${jobId}`)).body;
    assert.equal(report.status, "failed");
    assert.ok(report.baseline && report.candidates.length > 0, "the report keeps the measurements so far");
    assert.ok(report.notices.some(notice => notice.startsWith("The job failed and stopped measuring")), report.notices.join("\n"));
    assert.equal((await agent.fetch(`/api/r/${jobId}.md`)).status, 200);
    const me = (await agent.api<{ plan: { usedEvals: number } }>("/api/me")).body;
    assert.equal(me.plan.usedEvals, 0, "a failed job is not charged an evaluation");
  } finally { await stop(app); await models.close(); }
});
