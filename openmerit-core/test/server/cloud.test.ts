// The cloud app end to end: MCP over HTTP, sign-in, billing webhooks, endpoints, guardrails, budgets, the
// search's picks and the self-hosted server. Sign-in, Stripe and every model are local fakes. grading.test.ts
// and recovery.test.ts hold the other end-to-end jobs, split so test:server runs them in parallel.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { NO_ORGANIZATION } from "../../src/server/auth.ts";
import { signStripePayload } from "../../src/server/billing.ts";
import { watchState } from "../../src/server/actors/account.ts";
import { bundle, caller, CLERK, LOCAL_TOKEN, signedInPerson, fakeModels, startApp, stop, subscribe, untilDone, waitFor, TICKETS, type App, type Data, type FakeModels, type Result } from "./helpers.ts";

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

  test("a project keeps its own endpoints, guardrails and tasks; the default project holds the rest and cannot be deleted", async () => {
    type Project = { id: string; name: string; tasks: number; endpoints: number };
    const admin = caller(app, "test:user_p:org_projects:admin");
    const member = caller(app, "test:user_m:org_projects");
    assert.deepEqual((await admin.api<Project[]>("/api/projects")).body.map(item => [item.id, item.name]), [["default", "Default project"]]);
    assert.equal((await member.api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Claims" }) })).status, 403);
    const claims = (await admin.api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Claims" }) })).body;
    assert.equal((await admin.api("/api/projects", { method: "POST", body: JSON.stringify({ name: " claims " }) })).status, 400, "names are unique, ignoring case");
    const inClaims = { "x-openmerit-project": claims.id };

    const endpoint = { kind: "openai-compatible", baseUrl: "https://api.fireworks.test/v1", apiKey: "sk-project-key-1234", allowedModels: ["acme/fine-tune-1"] };
    const added = await admin.api<{ id: string }>("/api/endpoints", { method: "POST", headers: inClaims, body: JSON.stringify(endpoint) });
    assert.equal(added.status, 201);
    assert.deepEqual((await admin.api("/api/endpoints")).body, [], "the default project has none");
    assert.equal((await admin.api(`/api/endpoints/${added.body.id}`, { method: "DELETE" })).status, 404, "another project cannot remove it");
    assert.equal((await admin.api<unknown[]>("/api/endpoints", { headers: inClaims })).body.length, 1);

    // The same environment's guardrails differ by project.
    await admin.api("/api/guardrails", { method: "PUT", headers: inClaims, body: JSON.stringify({ level: "environment", id: "acme/app", settings: { budgetUsd: 2 } }) });
    assert.deepEqual((await admin.api<{ effective: Data }>("/api/guardrails?level=environment&id=acme/app", { headers: inClaims })).body.effective, { budgetUsd: 2 });
    assert.deepEqual((await admin.api<{ effective: Data }>("/api/guardrails?level=environment&id=acme/app")).body.effective, {});

    // A coding agent names the project; the task lands there and the default project does not list it.
    await subscribe(app, "org_projects");
    const unknown = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app", project: "Nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Its projects: Default project, Claims/);
    const started = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app", project: "claims" });
    assert.equal(started.isError, false, started.text);
    assert.equal((await admin.api<unknown[]>("/api/tasks", { headers: inClaims })).body.length, 1);
    assert.deepEqual((await admin.api("/api/tasks")).body, []);
    // A later call from the same environment that names no project lands in the project its tasks are in.
    const again = await admin.tool("openmerit_recommend", { bundle: bundle("reply drafter"), environment: "acme/app" });
    assert.equal(again.isError, false, again.text);
    assert.equal((await admin.api<unknown[]>("/api/tasks", { headers: inClaims })).body.length, 2);
    // The same task name in the default project is another task.
    const elsewhere = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app", project: "default" });
    assert.equal(elsewhere.isError, false, elsewhere.text);
    const [inDefault] = (await admin.api<{ id: string }[]>("/api/tasks")).body;
    assert.ok(inDefault && !(await admin.api<{ id: string }[]>("/api/tasks", { headers: inClaims })).body.some(item => item.id === inDefault.id));
    assert.match((await admin.tool("openmerit_tasks", {})).text, /project Claims, acme\/app/);

    const busy = await admin.api<{ error: string }>(`/api/projects/${claims.id}`, { method: "DELETE" });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /has 2 tasks/);
    assert.equal((await admin.api("/api/projects/default", { method: "DELETE" })).status, 409);
    const renamed = await admin.api<Project>("/api/projects/default", { method: "PUT", body: JSON.stringify({ name: "Main" }) });
    assert.equal(renamed.body.name, "Main");
    const empty = (await admin.api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Scratch" }) })).body;
    assert.equal((await admin.api(`/api/projects/${empty.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await admin.api("/api/tasks", { headers: { "x-openmerit-project": empty.id } })).status, 404);
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
    // The writer writes no case, so the eval is the bundle's own examples, which nobody grades: the floor ends the run.
    models.writes = false;
    const wrong = bundle("floor classifier", false);
    for (const example of wrong.examples.slice(0, 3) as { expected?: string }[]) example.expected = example.expected === "billing" ? "account" : "billing";
    const started = await agent.tool("openmerit_recommend", { bundle: wrong });
    const jobId = started.data.job_id as string;
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
      return asked.data.status === "needs_input" ? untilDone(agent, id) : asked;
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

test("a measuring job shows the app the candidate under test, case by case, against the current model", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  let release = () => {};
  try {
    await subscribe(app, "org_live");
    const agent = () => caller(app, "test:user_l:org_live:admin");
    // Hold the thirtieth model call: the current model's three trial runs of 8 cases are done, and the trial's cheaper model is under way on all 8.
    let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    models.onCall = async () => {
      if (held || models.calls.filter(call => !call.ticket.startsWith("writer:")).length < 30) return;
      held = true; await gate;
    };
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("live classifier", false), environment: "acme/live" });
    const jobId = started.data.job_id as string;
    type Live = { model: string; baseline: { model: string; rate: number } | null; done: number; total: number; passes: number; history: { rate: number }[]; minutesLeft: number | null };
    const view = await waitFor(() => agent().api<{ status: string; live: Live | null }>(`/api/runs/${jobId}`), value => (value.body.live?.done ?? 0) >= 1 && held);
    const live = view.body.live!;
    assert.equal(view.body.status, "running");
    assert.notEqual(live.model, "openai/gpt-5.4", "a candidate, not the current model");
    assert.deepEqual(live.baseline, { model: "openai/gpt-5.4", rate: 100 });
    assert.equal(live.total, 8, "the trial runs every case");
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

test("a self-hosted server writes a task's cases with the OpenMerit Harness openmerit connect set up, not on OpenMerit's key", async () => {
  const models = await fakeModels();
  // `openmerit connect api` with a Pi provider on the fake model server: what ~/.openmerit holds afterwards.
  const home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ harness: { kind: "api", api: { provider: "fake", model: "harness", apiKey: { env: "FAKE_HARNESS_KEY" } } } }));
  mkdirSync(join(home, "agent"));
  writeFileSync(join(home, "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: models.url, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "harness" }] } } }));
  const app = await startApp({ models, env: { OPENMERIT_MODE: "self-hosted", OPENMERIT_HOME: home, FAKE_HARNESS_KEY: "sk-fake" } });
  try {
    const agent = caller(app, LOCAL_TOKEN);
    const started = await agent.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    assert.equal(started.isError, false, started.text);
    const waiting = await waitFor(() => agent.tool("openmerit_result", { job_id: started.data.job_id }), value => value.data.status === "needs_input");
    const writers = models.calls.filter(call => call.ticket.startsWith("writer:"));
    assert.ok(writers.length > 0 && writers.every(call => call.model === "harness"), `the harness wrote the cases: ${JSON.stringify(writers)}`);
    assert.ok((waiting.data.notices as string[]).some(notice => /OpenMerit Harness \(api:fake\/harness\) wrote the cases/.test(notice)), JSON.stringify(waiting.data.notices));
    // The harness's cases are graded on the trial's answers, not in the label check, which asks only about the example without an answer.
    assert.deepEqual((waiting.data.questions as { id: string }[]).map(question => question.id), ["label_example-7"]);
    await agent.tool("openmerit_answer", { job_id: started.data.job_id, answers: { "label_example-7": "billing" } });
    const grading = await waitFor(() => agent.tool("openmerit_result", { job_id: started.data.job_id }), value => value.data.phase === "grading");
    assert.match(JSON.stringify(grading.data.questions), /I was charged after I cancelled/, "the grading trial shows answers to the harness's cases");
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
