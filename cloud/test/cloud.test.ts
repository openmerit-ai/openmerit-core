// The cloud app end to end: MCP over HTTP, the job workflow on a local Rivet engine, the ledger,
// billing webhooks, endpoints, guardrails and watches. Sign-in, Stripe and every model are local
// fakes, and the app runs in a child process so a test can SIGKILL it mid-job.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient } from "rivetkit/client";
import { NO_ORGANIZATION } from "../src/auth.ts";
import { signStripePayload } from "../src/billing.ts";
import type { Registry } from "../src/registry.ts";
import { bundle, caller, costOf, crash, fakeModels, startApp, stop, subscribe, waitFor, WEAK_BELOW, catalogue, type App, type FakeModels } from "./helpers.ts";

const CLERK = { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` };
type Data = Record<string, unknown>;
type Result = { status: string; pick: { model: string; passes: number; total: number } | null; edit: { edits: { before: string; after: string }[] }; reportUrl: string; spend: { openmeritUsd: number; customerUsd: number } };
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** What the job should have paid: each distinct model call once, however often it was sent. */
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
    assert.deepEqual(tools.body.result?.tools?.map(tool => tool.name), ["openmerit_recommend", "openmerit_result", "openmerit_answer", "openmerit_tasks"]);

    const noOrganization = await caller(app, "test:user_b").tool("openmerit_tasks", {});
    assert.equal(noOrganization.isError, true);
    assert.equal(noOrganization.text, NO_ORGANIZATION);
  });

  test("refuses a job without a plan, a key passed as an argument, and a bundle that carries a secret", async () => {
    const agent = caller(app, "test:user_c:org_unpaid:admin");
    const unpaid = await agent.tool("openmerit_recommend", { bundle: bundle() });
    assert.equal(unpaid.isError, true);
    assert.match(unpaid.text, /no active OpenMerit plan.*app\.openmerit\.test\/billing/);
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
    const started = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    assert.equal(started.isError, false, started.text);
    const jobId = started.data.job_id as string;
    const provisional = started.data.provisional as { model: string; reason: string };
    assert.notEqual(provisional.model, "openai/gpt-5.4");
    assert.match(provisional.reason, /Catalogue estimate, not yet measured/);

    const result = () => agent().tool("openmerit_result", { job_id: jobId });
    const asking = await waitFor(result, value => value.data.status === "needs_input");
    assert.deepEqual((asking.data.questions as { id: string }[]).map(question => question.id), ["label_ex7"]);
    assert.match(asking.text, /Where is my invoice for March\?/);
    assert.equal(models.calls.length, 0, "nothing is measured before the label check");

    await crash(app);
    app = await startApp({ models, env: app.env, storage: app.storage, enginePort: app.enginePort });
    const resumed = await waitFor(result, value => value.data.status === "needs_input", 90_000);
    assert.deepEqual((resumed.data.questions as { id: string }[]).map(question => question.id), ["label_ex7"]);

    const answered = await agent().tool("openmerit_answer", { job_id: jobId, answers: { label_ex7: "billing" } });
    assert.equal(answered.isError, false, answered.text);
    const done = await waitFor(result, value => value.data.status === "done" || value.data.status === "failed" || value.data.status === "stopped");
    assert.equal(done.data.status, "done", done.text);
    const measured = done.data.result as Result;
    assert.equal(measured.status, "picked");
    assert.equal(measured.pick!.total, 7);
    assert.equal(measured.pick!.passes, 7);
    assert.ok((catalogue.models.find(model => model.id === measured.pick!.model)?.eci ?? 200) >= WEAK_BELOW, `${measured.pick!.model} answers wrongly in the fake`);
    assert.deepEqual(measured.edit.edits.map(edit => edit.before), ["gpt-5.4"]);
    assert.ok(models.calls.some(call => call.ticket === "Where is my invoice for March?"), "the labelled case is measured");

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

    // Watching: a new catalogue version starts a watch job, which reuses the saved label and asks nothing.
    const [taskRow] = (await agent().api<{ id: string }[]>("/api/tasks")).body;
    assert.deepEqual((await agent().api(`/api/tasks/${taskRow!.id}/watch`, { method: "POST", body: JSON.stringify({ on: true }) })).body, { watching: true });
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    assert.deepEqual(await rivet.catalogue.getOrCreate(["global"]).refresh(), { version: "next", changed: true });
    const runs = await waitFor(() => agent().api<{ id: string; kind: string; status: string }[]>("/api/runs"), value => value.body.some(run => run.kind === "watch" && run.status === "done"))
      .catch(async (error: Error) => { throw new Error(`${error.message}\nTask: ${JSON.stringify((await agent().api(`/api/tasks/${taskRow!.id}`)).body).slice(0, 1500)}`); });
    assert.equal(runs.body.filter(run => run.kind === "watch").length, 1);
    const tasks = await agent().tool("openmerit_tasks", {});
    assert.match(tasks.text, /ticket classifier \(acme\/support\): openai\/gpt-5\.4 → .*, picked, watched/);
  } finally { await stop(app); await models.close(); }
});

test("a measure step replayed after a crash does not count its spend twice", async () => {
  const models = await fakeModels();
  let app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_replay");
    const agent = () => caller(app, "test:user_s:org_replay:admin");
    // The fourth call is in the current model's measure step: three of its calls are settled, the fourth is reserved. Then the node dies.
    let crashed: Promise<void> | null = null;
    models.onCall = async index => { if (index === 3) { models.onCall = null; crashed = crash(app); await crashed; } };
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("replayed classifier", false) });
    const jobId = started.data.job_id as string;
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
