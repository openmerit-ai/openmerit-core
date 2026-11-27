// The cloud app end to end: MCP over HTTP, the job workflow on a local Rivet engine, the ledger,
// billing webhooks, endpoints, guardrails and watches. Sign-in, Stripe and every model are local
// fakes, and the app runs in a child process so a test can SIGKILL it mid-job.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createClient } from "rivetkit/client";
import { NO_ORGANIZATION } from "../../src/server/auth.ts";
import { signStripePayload } from "../../src/server/billing.ts";
import type { Registry } from "../../src/server/registry.ts";
import { watchState } from "../../src/server/actors/account.ts";
import { evaluateTask } from "../../src/server/engine.ts";
import { buildPool } from "../../src/job/pool.ts";
import type { TaskBundle } from "../../src/ranking/index.ts";
import { bundle, caller, costOf, LOCAL_TOKEN, signedInPerson, crash, fakeCapture, fakeModels, startApp, stop, subscribe, untilDone, waitFor, WEAK_BELOW, WRITTEN, TICKETS, catalogue, type App, type FakeModels } from "./helpers.ts";

const CLERK = { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` };
type Data = Record<string, unknown>;
type Result = { status: string; pick: { model: string; passes: number; total: number; savingPerCallUsd: number | null; paybackCalls: number | null } | null; edit: { edits: { before: string; after: string }[] }; reportUrl: string; spend: { openmeritUsd: number; customerUsd: number } };
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
    assert.deepEqual(tools.body.result?.tools?.map(tool => tool.name), ["openmerit_recommend", "openmerit_result", "openmerit_answer", "openmerit_confirmation", "openmerit_eval_command", "openmerit_tasks", "openmerit_eval", "openmerit_retire"]);

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
    const laterStep = await agent.tool("openmerit_recommend", { bundle: { ...bundle(), steps: [{ description: "Answer", after: [1] }] } });
    assert.equal(laterStep.isError, true, "a step can come only after earlier steps");
    assert.match(laterStep.text, /after to the 1-based numbers of earlier steps/);
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

  test("stores endpoint keys encrypted, never returns them, and resolves environment guardrails", async () => {
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
    // There is no agent level: only environment and task.
    assert.equal((await admin.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "agent", id: "acme/app:claims", settings: { budgetUsd: 9 } }) })).status, 400);
    const resolved = await admin.api<{ effective: Data; from: Data; rejected: { key: string; level: string }[] }>("/api/guardrails?level=environment&id=acme/app");
    assert.deepEqual(resolved.body.effective, { allowedModels: ["a", "b"], budgetUsd: 2 });
    assert.deepEqual(resolved.body.from, { allowedModels: "environment", budgetUsd: "environment" });
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
    // Before anything is measured, the agent gets what the job will make, cost and take, capped at the budget per job.
    const estimate = started.data.estimate as { caseRuns: number; usd: number | null; budgetUsd: number; minutes: { low: number; high: number } };
    assert.ok(estimate.caseRuns > 0 && estimate.usd !== null && estimate.usd > 0 && estimate.usd <= estimate.budgetUsd && estimate.minutes.low <= estimate.minutes.high, JSON.stringify(estimate));
    assert.match(started.text, /Measuring makes about [\d,]+ case runs, about \$[\d.]+, never more than the \$[\d.]+ budget per job, and takes about \d+ to \d+ minutes\./);
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
    const done = await untilDone(agent(), jobId);
    assert.equal(done.data.status, "done", done.text);
    const measured = done.data.result as Result;
    assert.equal(measured.status, "picked");
    assert.equal(new URL(measured.reportUrl).pathname, `/r/${jobId}/`, "the app serves reports at /r/<id>/");
    // Every case, three times.
    assert.equal(measured.pick!.total, 24);
    assert.equal(measured.pick!.passes, 24);
    // The pick says after how many calls its saving repays what the run cost.
    assert.equal(measured.pick!.paybackCalls, Math.ceil((measured.spend.openmeritUsd + measured.spend.customerUsd) / measured.pick!.savingPerCallUsd!));
    assert.match(done.text, /which the saving repays after about [\d,.]+( thousand| million)? calls/);
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
    assert.ok(!publicPath.includes(Buffer.from("org_run").toString("base64url")), "the link does not show the organization's ID");
    const secret = publicPath.split(".").at(-2)!;
    assert.equal((await fetch(`${app.url}/api/share/${Buffer.from("org_run").toString("base64url")}.${secret}.md`)).status, 404, "a link naming the account in the clear is refused");
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
    assert.equal((await agent().api(`/api/guardrails?level=task&id=${taskRow.id}`)).status, 404, "its task-level guardrails go with it");
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
      return untilDone(agent(), jobId);
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

    // The agent relays the decision; it takes effect once the user confirms it in the app, as them.
    const confirm = async (held: { data: Record<string, unknown> }, answer = true) => {
      const id = (held.data.confirmation as { id: string }).id;
      return { id, ...await caller(app, "test:user_d:org_decide:admin").api<{ status: string; result: { status: number } | null }>(`/api/confirmations/${id}`, { method: "POST", body: JSON.stringify({ confirm: answer }) }) };
    };
    const approved = await decide(kept, { configure_ticket_classifier: true });
    assert.equal(approved.data.status, "needs_confirmation", approved.text);
    assert.match(approved.text, /https:\/\/app\.openmerit\.test\/confirm\/\?id=[\w-]+/);
    assert.equal((await agent().tool("openmerit_tasks", {})).text.includes("switched"), false, "nothing changes before the user confirms");
    const pending = (approved.data.confirmation as { id: string }).id;
    const shown = await agent().api<{ title: string; items: string[]; status: string }>(`/api/confirmations/${pending}`);
    assert.deepEqual([shown.body.title, shown.body.status, shown.body.items[0]], ["Approve the switch for ticket classifier", "pending", `openai/gpt-5.4 → ${pick} (openrouter)`]);
    // A new session starts by naming the organization and what waits for the user.
    const brief = async () => String((await agent().rpc("initialize", { protocolVersion: "2025-06-18" })).body.result?.instructions ?? "");
    const before = await brief();
    assert.match(before, /You act in the OpenMerit organization .*org_decide/);
    assert.match(before, new RegExp(`Waiting for the user to confirm: Approve the switch for ticket classifier, at https://app\\.openmerit\\.test/confirm/\\?id=${pending}`));
    const confirmed = await confirm(approved);
    assert.deepEqual([confirmed.status, confirmed.body.status], [200, "done"], JSON.stringify(confirmed.body));
    assert.doesNotMatch(await brief(), /Approve the switch for ticket classifier/, "a confirmed request no longer waits");
    assert.equal((await confirm(approved)).status, 409, "a confirmation runs once");
    assert.match((await agent().tool("openmerit_confirmation", { confirmation_id: confirmed.id })).text, /^The user confirmed Approve the switch for ticket classifier, and it is done\./);
    assert.match((await result(kept)).text, new RegExp(`Decision: openai/gpt-5\\.4 → ${pick.replaceAll(".", "\\.")} \\(openrouter\\), approved by User D on \\d{4}-\\d{2}-\\d{2}\\.`));
    // The first decision stands.
    const again = await decide(kept, { configure_ticket_classifier: false });
    assert.equal(again.isError, true);
    assert.match(again.text, /already recorded[^]*approved by User D/);
    assert.match((await result(kept)).text, /Decision: .*approved by User D/);
    const run = await agent().api<{ decision: { decision: string; by: string; name: string } }>(`/api/runs/${kept}`);
    assert.deepEqual([run.body.decision.decision, run.body.decision.by, run.body.decision.name], ["approved", "user_d", "User D"]);

    assert.equal((other.data.result as Result).status, "picked", other.text);
    const declined = await decide(dropped, { configure_reply_router: false });
    assert.equal(declined.isError, false, declined.text);
    assert.equal((await confirm(declined)).body.status, "done");

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

test("a task goes idle once no recommend call came for the idle period, and retired, review and frozen say why it stopped first", () => {
  const day = 24 * 60 * 60 * 1000, base = { retired: false, review: false, watch: undefined, lastRecommendAt: 0, idleAfterMs: 30 * day };
  assert.deepEqual(watchState({ ...base, now: 30 * day - 1 }), { state: "watching", idleSince: null });
  assert.deepEqual(watchState({ ...base, now: 30 * day }), { state: "idle", idleSince: new Date(30 * day).toISOString() });
  assert.deepEqual(watchState({ ...base, lastRecommendAt: null, now: 90 * day }), { state: "watching", idleSince: null });
  assert.equal(watchState({ ...base, watch: true, now: 30 * day }).state, "idle");
  assert.equal(watchState({ ...base, watch: false, now: 30 * day }).state, "frozen");
  assert.equal(watchState({ ...base, retired: true, watch: false, now: 30 * day }).state, "retired");
  assert.equal(watchState({ ...base, review: true, watch: false, now: 30 * day }).state, "review");
  assert.equal(watchState({ ...base, retired: true, review: true, now: 30 * day }).state, "retired");
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
    const done = await untilDone(agent(), jobId);
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
    const done = await untilDone(agent, jobId);
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

test("an evaluation beyond the plan that Stripe failed to record is reported with the account's next job, once, and a retried recommend with the same key starts no job", async () => {
  const models = await fakeModels();
  // A fake Stripe for the real client: the first meter event fails, as an outage would.
  const meterCalls: string[] = [], recorded: string[] = [];
  const stripe = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const identifier = new URLSearchParams(raw).get("identifier") ?? "";
      meterCalls.push(identifier);
      res.writeHead(meterCalls.length === 1 ? 500 : 200, { "content-type": "application/json" });
      if (meterCalls.length > 1 && !recorded.includes(identifier)) recorded.push(identifier);
      res.end(meterCalls.length === 1 ? JSON.stringify({ error: { message: "Stripe is down" } }) : "{}");
    });
  });
  await new Promise<void>(resolve => stripe.listen(0, "127.0.0.1", resolve));
  const app = await startApp({ models, env: { ...CLERK, TEST_STRIPE_API_BASE: `http://127.0.0.1:${(stripe.address() as AddressInfo).port}` } });
  try {
    await subscribe(app, "org_overage", { includedEvals: 0, overage: "metered" });
    const agent = caller(app, "test:user_o:org_overage:admin");
    const run = async (task: string) => {
      const started = await agent.tool("openmerit_recommend", { bundle: bundle(task, false), environment: "acme/overage", idempotency_key: `key-${task}` });
      const jobId = started.data.job_id as string;
      await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
      await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
      assert.equal((await untilDone(agent, jobId)).data.status, "done");
      return jobId;
    };
    const first = await run("overage classifier");
    // A retried call with the same idempotency key returns the job it started and starts no other.
    const retried = await agent.tool("openmerit_recommend", { bundle: bundle("overage classifier", false), environment: "acme/overage", idempotency_key: "key-overage classifier" });
    assert.deepEqual([retried.isError, retried.data.job_id, retried.data.repeated], [false, first, true], retried.text);
    assert.equal((await agent.api<unknown[]>("/api/runs")).body.length, 1);
    assert.deepEqual([meterCalls, recorded], [[first], []], "the first report failed");
    const second = await run("second overage classifier");
    await waitFor(async () => recorded.length, count => count === 2);
    assert.deepEqual(recorded.toSorted(), [first, second].toSorted(), "both evaluations are billed, the failed one with the next job");
    assert.equal(meterCalls.filter(id => id === first).length, 2, "the failed report was sent again once");
  } finally { await stop(app); await models.close(); await new Promise(resolve => stripe.close(resolve)); }
});

test("a job whose current model fails more than a fifth of its own eval recommends nothing, asks no approval and lists why its cases failed", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_floor");
    const agent = caller(app, "test:user_t:org_floor:admin");
    // Three of the six examples carry the wrong queue, so the current model, which answers right, passes 3 of the 6 cases.
    // No written case is kept, so the eval is the bundle's own examples, which nobody grades: the floor ends the run.
    const wrong = bundle("floor classifier", false);
    for (const example of wrong.examples.slice(0, 3) as { expected?: string }[]) example.expected = example.expected === "billing" ? "account" : "billing";
    const started = await agent.tool("openmerit_recommend", { bundle: wrong });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: [] } });
    const done = await untilDone(agent, jobId);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { approval: unknown; failedCases: { caseId: string; kind: string; reason: string }[]; baselineByKind: { kind: string; passes: number; total: number }[] }>(`/api/runs/${jobId}`)).body;
    assert.equal(result.status, "below_floor");
    assert.equal(result.pick, null);
    assert.equal(result.approval ?? null, null, "no approval question");
    assert.deepEqual(result.failedCases.map(item => [item.caseId, item.kind]), [["example-1", "example"], ["example-2", "example"], ["example-3", "example"]]);
    assert.match(result.failedCases[0]!.reason, /^Answered (billing|technical|account), expected (billing|account)\.$/);
    // Only 3 cases pass, fewer than a screen needs, so the current model runs once.
    assert.deepEqual(result.baselineByKind, [{ kind: "example", passes: 3, total: 6 }]);
    assert.match(done.text, /passed under 80% of its own eval/);
    assert.match(done.text, /Cases it failed, with the grader's reason:\n- example-1 \(example\): Answered/);
    // Only the current model ran: no candidate was screened.
    assert.deepEqual([...new Set(models.calls.filter(call => !call.ticket.startsWith("writer:")).map(call => call.model))], ["openai/gpt-5.4"]);
  } finally { await stop(app); await models.close(); }
});

test("a person grades a run's answers: a disagreement writes the eval again, agreement accepts it, and later runs reuse it without asking", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_grade");
    const agent = caller(app, "test:user_g:org_grade:admin");
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("graded classifier", false), environment: "acme/grade" });
    const jobId = started.data.job_id as string;
    // A first run may search once per grading round, and its estimate says so.
    assert.equal((started.data.estimate as { rounds: number }).rounds, 3);
    assert.match(started.text, /That is one round: .* up to 3 rounds/);
    const result = () => agent.tool("openmerit_result", { job_id: jobId });
    await waitFor(result, value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });

    // Round 1: the current model's answers and the pick's, each with OpenMerit's grade. Every one passed.
    const asked = await waitFor(result, value => value.data.phase === "grading");
    const questions = asked.data.questions as { id: string; detail: string }[];
    assert.ok(questions.length > 6 && questions.every(question => question.id.startsWith("grade_graded_classifier_r1_")), asked.text);
    assert.match(asked.text, /It needs a person to grade its answers[^]*Never grade for them/);
    assert.ok(questions.every(question => question.detail.endsWith("OpenMerit's grade: passed")), "the fake answers every case right");
    const mine = questions.find(question => question.detail.startsWith("openai/gpt-5.4 (your current model)"))!;
    // Grading is the review: nothing is accepted until the person agrees with the eval.
    const [task] = (await agent.api<{ id: string }[]>("/api/tasks")).body;
    assert.equal((await agent.api<{ accepted: unknown }>(`/api/tasks/${task!.id}/eval`)).body.accepted, null);
    // A wrong grade is refused and asked again; a person grades in the app as the coding agent does.
    const refused = await agent.api<{ notices: string[]; questions: unknown[] }>(`/api/runs/${jobId}/answers`, { method: "POST", body: JSON.stringify({ answers: { [mine.id]: "maybe" } }) });
    assert.equal(refused.status, 200);
    assert.ok(refused.body.notices.some(notice => notice.startsWith(`Answer not used: ${mine.id}`)), refused.body.notices.join("\n"));
    const grades = Object.fromEntries(questions.map(question => [question.id, question === mine ? "bad: the queue should name the product area" : "good"]));
    const sent = await agent.api(`/api/runs/${jobId}/answers`, { method: "POST", body: JSON.stringify({ answers: grades }) });
    assert.equal(sent.status, 200);

    // Round 2 runs on the eval written again from that grade, against its checks, since the current model's own answer looked wrong.
    const again = await waitFor(result, value => value.data.phase === "grading" && (value.data.questions as { id: string }[])[0]!.id.includes("_r2_"), 120_000);
    assert.ok(models.calls.some(call => call.ticket === "reviser"), "the reviser ran on OpenMerit's key");
    assert.ok((again.data.notices as string[]).includes("OpenMerit wrote the eval again from your grades of round 1."), JSON.stringify(again.data.notices));
    const done = await untilDone(agent, jobId);
    assert.equal(done.data.status, "done", done.text);
    const report = (await agent.api<{ grading: { rounds: number; accepted: boolean; bar: string; summary: string | null }; evalVersion: number }>(`/api/runs/${jobId}`)).body;
    assert.deepEqual([report.grading.rounds, report.grading.accepted, report.grading.bar, report.evalVersion], [2, true, "criteria", 1]);
    assert.match(report.grading.summary ?? "", /^Your current model meets your checks(, though it fails \d+ of its \d+ case runs)?[;,]/);
    const evaluation = (await agent.api<{ accepted: { version: number; source: string; by: string | null; bar: string; spec: { criteria?: string[] } } }>(`/api/tasks/${task!.id}/eval`)).body.accepted;
    assert.deepEqual([evaluation.version, evaluation.source, evaluation.by, evaluation.bar], [1, "grading", "user_g", "criteria"]);
    assert.deepEqual(evaluation.spec.criteria, ["The queue is the one the ticket's main problem belongs to."]);

    // The next run measures on the accepted eval against its bar, and asks nothing.
    const next = await agent.tool("openmerit_recommend", { bundle: bundle("graded classifier", false), environment: "acme/grade" });
    assert.equal((next.data.estimate as { rounds: number }).rounds, 1, "a run on the accepted eval grades nothing, so it searches once");
    assert.doesNotMatch(next.text, /That is one round/);
    const second = await waitFor(() => agent.tool("openmerit_result", { job_id: next.data.job_id }), value => ["done", "failed", "stopped", "needs_input"].includes(String(value.data.status)), 180_000);
    assert.equal(second.data.status, "done", second.text);
    const later = (await agent.api<{ grading: { rounds: number; accepted: boolean; bar: string }; evalVersion: number }>(`/api/runs/${String(next.data.job_id)}`)).body;
    assert.deepEqual([later.grading.rounds, later.grading.accepted, later.grading.bar, later.evalVersion], [0, true, "criteria", 1]);
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
    // Looking the ticket up is a required step, which the current model's flow takes.
    const steps = [{ description: "Look the ticket up", tools: ["lookup_ticket"], access: "read", required: true }, { description: "Pick the queue", after: [1] }];
    const started = await agent.tool("openmerit_recommend", { bundle: { ...bundle("agent classifier", false), tools, steps }, environment: "acme/agent" });
    const jobId = started.data.job_id as string;
    await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => value.data.status === "needs_input");
    await agent.tool("openmerit_answer", { job_id: jobId, answers: { label_check: ["written-1", "written-2"] } });
    const done = await untilDone(agent, jobId);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { basedOn: string[]; agentEval: { status: string; passed: boolean; baseline: { passes: number; total: number }; tried: { passed: boolean }[] } }>(`/api/runs/${jobId}`)).body;
    assert.ok(result.basedOn.includes("Checks: S1 (the spec's steps, on each case's tool calls). S2 lists no tools, so it is not checked."), JSON.stringify(result.basedOn));
    assert.match(done.text, /Based on: .*S1 \(the spec's steps/);
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
      return untilDone(agent, id);
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
    // A higher budget spends more: the user confirms it, after verifying their sign-in, and the run starts then.
    const rerun = await agent.tool("openmerit_recommend", { job_id: jobId, budget_usd: raise.budgetUsd });
    assert.equal(rerun.data.status, "needs_confirmation", rerun.text);
    const held = (rerun.data.confirmation as { id: string }).id;
    const confirmAs = (token: string) => caller(app, token).api<{ status: string; result: { body: { jobId: string } } }>(`/api/confirmations/${held}`, { method: "POST", body: JSON.stringify({ confirm: true }) });
    assert.equal((await confirmAs("test:user_u:org_rerun:admin:30")).status, 403, "a stale sign-in verifies first");
    assert.equal((await caller(app, "test:user_x:org_other:admin").api(`/api/confirmations/${held}`)).status, 404, "another organization cannot see it");
    const confirmed = await confirmAs("test:user_u:org_rerun:admin");
    assert.equal(confirmed.body.status, "done", JSON.stringify(confirmed.body));
    const rerunJob = confirmed.body.result.body.jobId;
    assert.match((await agent.tool("openmerit_confirmation", { confirmation_id: held })).text, new RegExp(`started job ${rerunJob}`));
    const task = (await agent.api<{ settings: { key: string; value: unknown }[] }>(`/api/guardrails?level=task&id=${taskId}`)).body;
    assert.deepEqual(Object.fromEntries(task.settings.map(item => [item.key, item.value])), { minPassRate: 0.5, budgetUsd: 1 }, "the budget is raised and the task's other settings kept");
    const done = await settle(rerunJob);
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
      const done = await untilDone(agent, jobId);
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
    assert.ok(switched.notices.includes(`The provisional pick ${switched.provisional} was measured on every case too.`), switched.notices.join("\n"));
    assert.ok(!switched.notices.some(notice => notice.includes("No measured model that qualified")), "the notice makes no claim the result contradicts");
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
    const done = await untilDone(agent(), jobId);
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
    // Hold the thirtieth model call: the current model's three runs of 8 cases are done, and a candidate's screen of all 8 (a small eval) is under way.
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
    assert.equal(live.total, 8, "a small eval's screen runs every case");
    assert.ok(live.done < live.total, "the held case is not done");
    assert.equal(live.history.length, live.done);
    assert.equal(live.history.at(-1)!.rate, live.passes / live.done * 100);
    assert.ok(live.minutesLeft !== null && live.minutesLeft >= 1);
    release();
    const done = await untilDone(agent(), jobId);
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
    const ended = await untilDone(agent, jobId);
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

test("a job whose start fails after the account recorded it is marked failed, and deleting its task settles one an earlier failed start left queued", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { TEST_CATALOGUE: "broken", OPENMERIT_ORPHAN_AFTER_MS: "2000" } });
  try {
    await subscribe(app, "org_orphan");
    const agent = caller(app, "test:user_o:org_orphan:admin:1");
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    type Run = { id: string; taskId: string; status: string };
    const runs = async () => (await agent.api<Run[]>("/api/runs")).body;

    // A task with a job that waits for answers, which a delete does not wait for.
    const first = await agent.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    await waitFor(() => agent.tool("openmerit_result", { job_id: first.data.job_id }), value => value.data.status === "needs_input");
    const [task] = (await agent.api<{ id: string }[]>("/api/tasks")).body;
    // What a start that failed in an outage left before startJob caught it: the account's row and no job actor.
    const orphan = "job_20261124_0rphan000001";
    assert.equal((await rivet.account.getOrCreate(["org_orphan"]).startJob({ jobId: orphan, taskId: task!.id, kind: "run", askedBy: null })).ok, true);
    assert.equal((await runs()).find(run => run.id === orphan)?.status, "queued");
    await new Promise(resolve => setTimeout(resolve, 2_500));
    const deleted = await agent.api<Data>(`/api/tasks/${task!.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(await runs(), []);

    // A start that fails after the account recorded the job: on a catalogue with no models, picking a provisional model throws.
    assert.deepEqual(await rivet.catalogue.getOrCreate(["global"]).refresh(), { version: "broken", changed: true });
    const failed = await agent.tool("openmerit_recommend", { bundle: bundle("reply router"), environment: "acme/support" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /OpenMerit could not start the job \(.*\)\. Nothing was charged: try again\./);
    assert.deepEqual((await runs()).map(run => run.status), ["failed"], "the job is not left queued");
    assert.equal((await agent.api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals, 0, "a job that never started is not charged an evaluation");
  } finally { await stop(app); await models.close(); }
});

test("a self-hosted server starts a job without a plan, and its Stripe settings and webhooks are off", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { ...CLERK, OPENMERIT_MODE: "self-hosted", STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_ID: "price_test" } });
  try {
    const agent = caller(app, LOCAL_TOKEN);
    assert.equal((await agent.api<{ mode: string }>("/api/me")).body.mode, "self-hosted");
    // The server's token is the coding agent's: a critical /api request waits for the person, in the web app.
    const held = await agent.api<{ status: string; confirmation: { id: string; url: string } }>("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/support", settings: { budgetUsd: 3 } }) });
    assert.deepEqual([held.status, held.body.status], [202, "needs_confirmation"]);
    const { id } = held.body.confirmation;
    assert.equal(held.body.confirmation.url, `https://app.openmerit.test/confirm/?id=${id}`, "the web app's confirm page, which the server serves");
    assert.equal((await agent.api(`/api/confirmations/${id}`, { method: "POST", body: JSON.stringify({ confirm: true }) })).status, 403, "the token cannot confirm");
    const budget = async () => (await agent.api<{ settings: { key: string; value: unknown }[] }>("/api/guardrails?level=environment&id=acme/support")).body.settings;
    assert.deepEqual(await budget(), []);
    // The person signs in with a one-time link, which a second use refuses.
    const person = await signedInPerson(app);
    assert.equal((await fetch(new URL(new URL(person.link).pathname + new URL(person.link).search, app.url), { redirect: "manual" })).status, 401, "a sign-in link works once");
    assert.match((await person.api<{ title: string; items: string[] }>(`/api/confirmations/${id}`)).body.items.join(), /Budget per job: \$3/);
    const foreign = await fetch(`${app.url}/api/confirmations/${id}`, { method: "POST", headers: { cookie: person.cookie, origin: "https://elsewhere.test", "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    assert.equal(foreign.status, 403, "another site cannot confirm with the person's cookie");
    assert.equal((await person.api<{ status: string }>(`/api/confirmations/${id}`, { method: "POST", body: JSON.stringify({ confirm: true }) })).body.status, "done");
    assert.deepEqual(await budget(), [{ key: "budgetUsd", value: 3, kind: "default" }]);
    // The person's own change in the web app is not held.
    assert.equal((await person.api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level: "environment", id: "acme/support", settings: { budgetUsd: 4 } }) })).status, 200);
    const started = await agent.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    assert.equal(started.isError, false, started.text);
    await waitFor(() => agent.tool("openmerit_result", { job_id: started.data.job_id }), value => value.data.status === "needs_input");
    const metadata = await (await fetch(`${app.url}/.well-known/oauth-protected-resource`)).json() as Data;
    assert.deepEqual(metadata.authorization_servers, [], "self-hosted names no Clerk issuer");
    assert.equal((await subscribe(app, "org_self")).status, 503, "no Stripe webhook is applied");
  } finally { await stop(app); await models.close(); }
});

test("a self-hosted server measures a task with its own eval command once a person confirms the command", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { OPENMERIT_MODE: "self-hosted" } });
  // The repository's own eval: it classifies each ticket through OPENAI_BASE_URL with $OPENMERIT_MODEL and reports each item's pass or fail.
  const repo = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  writeFileSync(join(repo, "eval.mjs"), `import { writeFileSync } from "node:fs";
const tickets = ${JSON.stringify(Object.entries(TICKETS).map(([ticket, queue], index) => ({ id: `t${index + 1}`, ticket, queue })))};
const only = (process.env.OPENMERIT_ITEMS ?? "").split(",").filter(Boolean);
const items = [];
for (const item of tickets.filter(each => !only.length || only.includes(each.id))) {
  const response = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENMERIT_MODEL, messages: [{ role: "user", content: "Which queue? " + item.ticket }], max_tokens: 5 }) });
  const answer = (await response.json()).choices?.[0]?.message?.content ?? "";
  items.push({ id: item.id, pass: answer.trim() === item.queue });
}
writeFileSync(process.env.OPENMERIT_RESULT, JSON.stringify({ items }));
`);
  try {
    const agent = caller(app, LOCAL_TOKEN);
    const held = await agent.tool("openmerit_eval_command", { bundle: bundle("own classifier", false), environment: "acme/own", command: "node eval.mjs", root: repo, threshold: 0.5 });
    assert.equal(held.data.status, "needs_confirmation", held.text);
    const taskId = held.data.task_id as string, { id } = held.data.confirmation as { id: string };
    assert.equal((await agent.api<{ evalCommand: unknown }>(`/api/tasks/${taskId}/eval-command`)).body.evalCommand, null, "nothing runs before the person confirms");
    const person = await signedInPerson(app);
    const shown = (await person.api<{ title: string; items: string[] }>(`/api/confirmations/${id}`)).body;
    assert.match(`${shown.title} ${shown.items.join(" ")}`, /Measure own classifier by running a command on this machine[^]*Command: node eval\.mjs/);
    assert.equal((await person.api<{ status: string }>(`/api/confirmations/${id}`, { method: "POST", body: JSON.stringify({ confirm: true }) })).body.status, "done");
    assert.equal((await agent.api<{ evalCommand: { command: string } }>(`/api/tasks/${taskId}/eval-command`)).body.evalCommand.command, "node eval.mjs");
    assert.equal((await agent.tool("openmerit_eval_command", { task_id: taskId, command: "node eval.mjs", root: join(repo, "nope") })).isError, true, "a root that does not exist is refused");

    const before = models.calls.length;
    const started = await agent.tool("openmerit_recommend", { task_id: taskId });
    assert.equal(started.isError, false, started.text);
    // No label check and no grading: the customer's eval is the grader.
    const done = await waitFor(() => agent.tool("openmerit_result", { job_id: started.data.job_id }), value => ["done", "failed", "stopped", "needs_input"].includes(String(value.data.status)), 180_000);
    assert.equal(done.data.status, "done", done.text);
    const result = (await agent.api<Result & { notices: string[]; basedOn: string[] }>(`/api/runs/${String(started.data.job_id)}`)).body;
    assert.equal(result.status, "picked", done.text);
    assert.ok(result.notices.some(notice => notice.startsWith("Measured with your eval command, `node eval.mjs`")), result.notices.join("\n"));
    assert.ok(result.basedOn.some(line => /your eval's pass or fail per item/.test(line)), result.basedOn.join("\n"));
    assert.equal(result.pick!.total, Object.keys(TICKETS).length * 3, "the eval's own items, three runs each");
    const calls = models.calls.slice(before);
    assert.ok(calls.length > 0 && calls.every(call => !call.ticket.startsWith("writer") && call.auth === "Bearer or-test-key"), "the eval's calls reach the endpoint with its key, through the proxy, and no cases are written");
    const spend = (await agent.api<{ openmeritUsd: number }>("/api/spend")).body;
    assert.ok(spend.openmeritUsd > 0, "the eval's calls are booked in the account's ledger");
  } finally { await stop(app); await models.close(); }
});
