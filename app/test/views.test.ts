import assert from "node:assert/strict";
import test from "node:test";
import type { GuardrailsAt, JobView, Me, Report, Spend, Task } from "../api.ts";
import { createFakeApi } from "../dev/fake-api.ts";
import type { Account } from "../view.ts";
import { choices, guardrailsView, parse } from "../views/guardrails.ts";
import { planView } from "../views/plan.ts";
import { runView } from "../views/run.ts";
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
  for (const html of [tasksView.render(tasks, page({ ...me, account: { ...me.account, name: hostile } })), runView.render(report, page(me)), runView.render(job, page(me))]) {
    assert.doesNotMatch(html.__html, /<img/);
    assert.match(html.__html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  }
});

test("a run shows its saved report, or the job's live state until it has one", async () => {
  const me = await account();
  const report = text(runView.render(await get<Report>("/api/runs/k7m2q9"), page(me)));
  assert.match(report, /Ticket router: switch to claude-haiku-5-5/);
  assert.match(report, /claude-haiku-5-5 OpenRouter 40\/40 \$0\.07 0\.5 s Picked/);
  assert.match(report, /sahra-triage-ft-2 ep_baseten · your key · placed by measurement only/);
  assert.match(report, /\$1\.84 on OpenMerit's account and \$0\.62 on your own endpoints' keys/);
  const waiting = text(runView.render(await get<JobView>("/api/runs/w8r3k1"), page(me)));
  assert.match(waiting, /Waiting for your answer/);
  assert.doesNotMatch(waiting, /How the models compared/);
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
