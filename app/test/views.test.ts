import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApi, type GuardrailsAt, type JobView, type Me, type Report, type Run, type Spend, type Task } from "../api.ts";
import { createFakeApi } from "../dev/fake-api.ts";
import type { Account } from "../view.ts";
import { connectionsView, retried } from "../views/connections.ts";
import { choices, guardrailsView, parse } from "../views/guardrails.ts";
import { planView } from "../views/plan.ts";
import { runView } from "../views/run.ts";
import { runsView } from "../views/runs.ts";
import { tasksView } from "../views/tasks.ts";

// The pages render what the cloud app returns, as served by the local fake of its /api/*.
const fake = createFakeApi();
async function get<T>(path: string, scenario = "populated"): Promise<T> {
  const response = await fake(new Request(`https://openmerit.ai${path}`, { headers: { authorization: `Bearer preview-${scenario}` } }));
  assert.equal(response.status, 200, path);
  return await response.json() as T;
}
const account = async (scenario = "populated"): Promise<Account> => {
  const me = await get<Me>("/api/me", scenario);
  return { ...me, account: { ...me.account, name: me.account.name ?? "Sahra Health" } };
};
const page = (me: Account, params = "", id: string | null = null) => ({ me, params: new URLSearchParams(params), id });
const text = (html: { __html: string }): string => html.__html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

test("names from the cloud app are shown as text, never as markup", async () => {
  const me = await account();
  const hostile = '<img src=x onerror="alert(1)">';
  const tasks = (await get<Task[]>("/api/tasks")).map((task) => ({ ...task, name: hostile, environment: hostile }));
  const report = { ...await get<Report>("/api/runs/k7m2q9"), task: hostile, notices: [hostile] };
  const job = { ...await get<JobView>("/api/runs/z1c7m4"), error: hostile };
  for (const html of [tasksView.render({ tasks }, page({ ...me, account: { ...me.account, name: hostile } })), runView.render(report, page(me)), runView.render(job, page(me))]) {
    assert.doesNotMatch(html.__html, /<img/);
    assert.match(html.__html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  }
});

test("a finished run lists the notices that change how to read it, without the search's routine ones", async () => {
  const me = await account();
  const base = await get<Report>("/api/runs/k7m2q9");
  const notices = ["118 catalogue models without an ECI left out: the search places models by their capability index.", "2 models have no capability index, so they are measured as challengers and placed by measurement only.", "Challengers not measured: `x-ai/grok-4.6`. The budget refused it."];
  const shown = runView.render({ ...base, notices }, page(me)).__html;
  assert.match(shown, /<h2 id="notes">Notes<\/h2>/);
  assert.match(shown, /Challengers not measured: <code>x-ai\/grok-4.6<\/code>/);
  assert.doesNotMatch(shown, /without an ECI|no capability index/);
  assert.doesNotMatch(runView.render({ ...base, notices: notices.slice(0, 2) }, page(me)).__html, /id="notes"/, "no Notes section for routine notices alone");
  // A fix shows beside the notice it names, and only there.
  const fixed = text(runView.render({ ...base, notices, fixes: [{ kind: "raise_budget", notice: notices[2]!, budgetUsd: 12 }, { kind: "open", notice: notices[0]!, label: "Add an endpoint", path: "/connections/" }] }, page(me)));
  assert.match(fixed, /The budget refused it\. Raise budget to \$12 and rerun/);
  assert.doesNotMatch(fixed, /Add an endpoint/, "a routine notice stays hidden with its fix");
});

test("a rerun with a higher budget sets the task's budget and starts a new run of the same task", async () => {
  const send = (path: string, body: unknown) => fake(new Request(`https://openmerit.ai${path}`, { method: "POST", headers: { authorization: "Bearer preview-populated", "content-type": "application/json" }, body: JSON.stringify(body) }));
  const started = await send("/api/runs/k7m2q9/rerun", { budgetUsd: 12 });
  assert.equal(started.status, 201);
  const { jobId, taskId } = await started.json() as { jobId: string; taskId: string };
  assert.equal(taskId, "ticket-router");
  assert.equal((await get<JobView>(`/api/runs/${jobId}`)).status, "running");
  const rails = await get<{ settings: { key: string; value: unknown }[] }>("/api/guardrails?level=task&id=ticket-router");
  assert.deepEqual(rails.settings.find((item) => item.key === "budgetUsd")?.value, 12);
  assert.equal((await send("/api/runs/k7m2q9/rerun", { budgetUsd: -1 })).status, 409);
});

test("a run shows its saved report, or the job's live state until it has one", async () => {
  const me = await account();
  const report = text(runView.render(await get<Report>("/api/runs/k7m2q9"), page(me)));
  assert.match(report, /Ticket router: switch to claude-haiku-5-5/);
  assert.match(report, /claude-haiku-5-5 OpenRouter 40\/40 \$0\.07 0\.5 s Picked/);
  assert.match(report, /sahra-triage-ft-2 ep_baseten · your key · placed by measurement only/);
  // The fallback instruction and the near misses the cloud app returns beside the pick.
  assert.match(report, /production's model comes from elsewhere \(for example an environment variable\)\. Set it to anthropic\/claude-haiku-5-5 \./);
  assert.match(report, /gpt-5-mini ep_openai · your key · 1 case below the current model 38\/40 \$0\.65 1\.8 s Near miss/);
  assert.match(report, /Near Misses 1 model missed gpt-5's 39\/40 by at most one case per run.* gpt-5-mini ep_openai · 38\/40 passed · \$0\.65 per 1,000 calls · cheaper than now/);
  // A report saved before near misses existed still renders.
  const { nearMisses: _added, ...older } = await get<Report>("/api/runs/k7m2q9");
  assert.doesNotMatch(text(runView.render(older, page(me))), /Near miss/);
  const waiting = text(runView.render(await get<JobView>("/api/runs/w8r3k1"), page(me)));
  assert.match(waiting, /Needs input/);
  assert.doesNotMatch(waiting, /Models Compared/);
  assert.match(text(runView.render(await get<JobView>("/api/runs/z1c7m4"), page(me))), /Coding reviewer: the run did not finish .*no known answers/);
});

test("agent guardrails use environment:agent IDs, and show each value with the level it came from", async () => {
  const me = await account();
  const tasks = await get<Task[]>("/api/tasks");
  assert.deepEqual(choices(tasks, "agent").map((item) => item.id), ["sahra-health/claims:claim pipeline"]);
  const agent = await get<GuardrailsAt>(`/api/guardrails?level=agent&id=${encodeURIComponent("sahra-health/claims:claim pipeline")}`);
  const atAgent = text(guardrailsView.render({ tasks, level: "agent", id: "sahra-health/claims:claim pipeline", guardrails: agent }, page(me)));
  assert.match(atAgent, /Agent eval agentEvalRequired Default · can be replaced required This level/);
  assert.match(atAgent, /Minimum pass rate minPassRate Default · can be replaced 95% Environment/);
  const task = await get<GuardrailsAt>("/api/guardrails?level=task&id=ticket-router");
  const atTask = text(guardrailsView.render({ tasks, level: "task", id: "ticket-router", guardrails: task }, page(me)));
  // Set at the environment and kept: the task's wider list was refused, with the resolver's reason.
  assert.match(atTask, /Allowed providers allowedProviders Constraint · only narrows openai, anthropic Environment/);
  assert.match(atTask, /Allowed providers at the task level is not applied: it widens the environment level's allowedProviders: adds deepseek/);
  assert.match(atTask, /Latency limit \(ms\) latencyMs Default · can be replaced 1000 This level/);
  // Members cannot change the environment level, which the cloud app refuses for them.
  const member = await account("member");
  const environment = await get<GuardrailsAt>("/api/guardrails?level=environment&id=sahra-health%2Fclaims", "member");
  const locked = guardrailsView.render({ tasks, level: "environment", id: "sahra-health/claims", guardrails: environment }, page(member)).__html;
  assert.doesNotMatch(locked, /type="submit"/);
  assert.match(locked, /disabled/);
});

test("typed guardrail values become the values the cloud app stores, and empty means inherit", () => {
  assert.deepEqual(parse("allowedProviders", " openai, anthropic ,"), ["openai", "anthropic"]);
  assert.equal(parse("minPassRate", "95%"), 0.95);
  assert.equal(parse("minPassRate", "95"), 0.95);
  assert.equal(parse("minPassRate", "0.9"), 0.9);
  assert.equal(parse("spendCapUsd", "$25"), 25);
  assert.equal(parse("watch", "off"), false);
  assert.equal(parse("watch", "On"), true);
  assert.equal(parse("agentEvalRequired", " required "), "required");
  assert.equal(parse("budgetUsd", "  "), null);
});

test("spend is shown split into OpenMerit-paid and customer-paid, and only admins get billing buttons", async () => {
  const me = await account();
  const spend = await get<Spend>("/api/spend");
  const shown = text(planView.render(spend, page(me)));
  assert.match(shown, /Paid by OpenMerit \$18\.42 of the \$250 cap/);
  assert.match(shown, /Paid by you \$6\.10 of the \$50 cap · billed to your keys/);
  assert.match(planView.render(spend, page(me)).__html, /data-action="portal"/);
  const noPlan = await account("noplan");
  assert.match(planView.render(spend, page(noPlan)).__html, /data-action="checkout"/);
  const member = planView.render(spend, page({ ...noPlan, role: "member" })).__html;
  assert.doesNotMatch(member, /data-action="(checkout|portal)"/);
  assert.match(member, /Ask an admin of Sahra Health to choose a plan/);
});

test("a delete that needs a recent sign-in opens Clerk's prompt and retries once, through the fake cloud app", async () => {
  // The fake API, like the cloud app, takes a token's .v<seconds> suffix as its last verification.
  let verifiedAt: number | null = null, prompts = 0;
  const api = (allow: boolean) => createApi("https://api.test", async () => `preview-tonic${verifiedAt ? `.v${verifiedAt}` : ""}`, (input, init) => fake(new Request(input, init)), async (level) => {
    prompts += 1;
    assert.equal(level, "first_factor");
    if (allow) verifiedAt = Math.floor(Date.now() / 1000);
    return allow;
  });
  await assert.rejects(api(false).send("DELETE", "/api/tasks/rfp-reader"), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "reverification");
  assert.equal(prompts, 1);
  assert.deepEqual(await api(true).send("DELETE", "/api/tasks/rfp-reader"), { deleted: true, jobs: 1 });
  assert.equal(prompts, 2);
  // A task with a run in progress cannot be deleted, and verifying again does not change that.
  await assert.rejects(api(true).send("DELETE", "/api/tasks/booking-chat"), (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal(prompts, 2);
});

test("a page asks the cloud app again while it wakes after a deploy, but not after a refusal", async () => {
  // A request that timed out or failed on the server is tried again; a refusal is not.
  let calls = 0;
  const flaky = () => { calls += 1; return calls < 3 ? Promise.reject(new ApiError(calls === 1 ? 0 : 503, "slow")) : Promise.resolve("ok"); };
  assert.equal(await retried(flaky, [0, 0]), "ok");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retried(() => { calls += 1; return Promise.reject(new ApiError(403, "no")); }, [0, 0]), /no/);
  assert.equal(calls, 1);
});

test("a result shows the decision the coding agent sent back, or that it waits for one; Connections has no app connections", async () => {
  const me = await account();
  const approved = await get<Report>("/api/runs/k7m2q9");
  const shown = text(runView.render(approved, page(me)));
  assert.match(shown, /Approved Approved in the coding agent by Amira Haddad on /);
  assert.doesNotMatch(runView.render(approved, page(me)).__html, /data-action="approve"/, "only the coding agent sends a decision");
  // A decision recorded without a name in Clerk shows the user ID.
  assert.match(text(runView.render({ ...approved, decision: { ...approved.decision!, name: null } }, page(me))), /by user_amira on/);
  assert.match(text(runView.render(await get<Report>("/api/runs/b2v5h3"), page(me))), /Declined Declined in the coding agent by Amira Haddad on /);
  const waiting = text(runView.render({ ...approved, decision: null }, page(me)));
  assert.match(waiting, /asks you before applying it, and sends your answer back here/);
  // Tasks: an approved task runs the pick now, with the decision; a pick without one waits for it.
  // A fresh fake: earlier tests start runs in the shared one.
  const listed = text(tasksView.render({ tasks: await (await createFakeApi()(new Request("https://openmerit.ai/api/tasks", { headers: { authorization: "Bearer preview-populated" } }))).json() as Task[] }, page(me)));
  assert.match(listed, /Ticket router[^]*?claude-haiku-5-5[^]*?Switched to claude-haiku-5-5 saves about \$234 a month Approved in the coding agent by Amira Haddad[^]*?Bill and claim matcher/);
  assert.match(listed, /Reply drafter[^]*?Switch to claude-haiku-5-5[^]*?Waiting for a decision in the coding agent/);
  const connections = connectionsView.render({ endpoints: await get("/api/endpoints") }, page(me)).__html;
  assert.doesNotMatch(connections, /Viktor|Langfuse|id="apps"/);
  assert.match(connections, /id="endpoints"/);
});

test("a run whose current model could not run reads as failed, offers Run again and never says to keep the model; a measured one still says no switch", async () => {
  const me = await account();
  const base = await get<Report>("/api/runs/k7m2q9");
  const why = "anthropic/claude-sonnet-5.5 could not run: anthropic/claude-sonnet-5.5 on openrouter: API key expired.";
  // As a run saved it when the current model's key had expired: no baseline.
  const failed: Report = { ...base, task: "assess-enrollment", status: "baseline_failed", pick: null, top: [], nearMisses: [], baseline: null, candidates: [],
    edit: { edits: [], instructions: null }, notices: ["118 catalogue models without an ECI left out: the search places models by their capability index.", why], fixes: [{ kind: "rerun", notice: why }] };
  const shown = text(runView.render(failed, page(me)));
  assert.match(shown, /assess-enrollment: the run did not finish/);
  assert.match(shown, /The run did not finish: anthropic\/claude-sonnet-5\.5 could not run: .*API key expired\./);
  assert.match(shown, /Run again/);
  assert.doesNotMatch(shown, /no switch|keep the model in use now/);
  assert.equal(runView.title?.(failed), "assess-enrollment: the run did not finish");
  // A current model that ran and passed too few cases was measured: that stays a verdict.
  const measured = text(runView.render({ ...failed, baseline: base.baseline, fixes: [] }, page(me)));
  assert.match(measured, /assess-enrollment: no switch/);
});
