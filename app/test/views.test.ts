import assert from "node:assert/strict";
import test from "node:test";
import type { Guardrails, Me, Report, Spend, Task } from "../api.ts";
import { createFakeApi } from "../dev/fake-api.ts";
import { guardrailsView, parse } from "../views/guardrails.ts";
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
const page = (me: Me, params = "", id: string | null = null) => ({ me, params: new URLSearchParams(params), id });
const text = (html: { __html: string }): string => html.__html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("names and inputs from the cloud app are shown as text, never as markup", async () => {
  const me = await get<Me>("/api/me");
  const hostile = '<img src=x onerror="alert(1)">';
  const tasks = (await get<Task[]>("/api/tasks")).map((task) => ({ ...task, name: hostile, environment: hostile }));
  const report = await get<Report>("/api/runs/k7m2q9");
  report.task = hostile;
  report.cases = report.cases.map((item) => ({ ...item, input: hostile, expected: hostile }));
  for (const html of [tasksView.render(tasks, page({ ...me, account: { ...me.account, name: hostile } })), runView.render(report, page(me))]) {
    assert.doesNotMatch(html.__html, /<img/);
    assert.match(html.__html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  }
});

test("guardrails show each effective value with the level it came from, and why a wider value was refused", async () => {
  const me = await get<Me>("/api/me");
  const tasks = await get<Task[]>("/api/tasks");
  const guardrails = await get<Guardrails>("/api/guardrails?level=task&id=ticket-router");
  const shown = text(guardrailsView.render({ tasks, level: "task", id: "ticket-router", guardrails }, page(me, "level=task&id=ticket-router")));
  // Set at the environment and kept: the task's wider list was refused.
  assert.match(shown, /Allowed providers allowedProviders Constraint · only narrows openai, anthropic Environment/);
  assert.match(shown, /Allowed providers at the task level was not applied: it is wider than the environment level allows/);
  // Set at the task itself.
  assert.match(shown, /Latency limit \(ms\) latencyMs Default · can be replaced 1000 This level/);
  assert.match(shown, /Minimum pass rate minPassRate Default · can be replaced 95% Environment/);
});

test("typed guardrail values become the values the cloud app stores, and empty means inherit", () => {
  assert.deepEqual(parse("allowedProviders", " openai, anthropic ,"), ["openai", "anthropic"]);
  assert.equal(parse("minPassRate", "95%"), 0.95);
  assert.equal(parse("minPassRate", "95"), 0.95);
  assert.equal(parse("minPassRate", "0.9"), 0.9);
  assert.equal(parse("spendCapUsd", "$25"), 25);
  assert.equal(parse("watch", "off"), false);
  assert.equal(parse("watch", "On"), true);
  assert.equal(parse("region", " eu "), "eu");
  assert.equal(parse("budgetUsd", "  "), null);
});

test("spend is shown split into OpenMerit-paid and customer-paid, and only admins get billing buttons", async () => {
  const me = await get<Me>("/api/me");
  const spend = await get<Spend>("/api/spend");
  const shown = text(planView.render(spend, page(me)));
  assert.match(shown, /Paid by OpenMerit \$18\.42 of the \$250 cap/);
  assert.match(shown, /Paid by you \$6\.10 of the \$50 cap · billed to your keys/);
  assert.match(planView.render(spend, page(me)).__html, /data-action="portal"/);
  const noPlan = { ...me, plan: { name: "Cloud", status: "none" as const, periodEnd: null, includedEvals: 0, usedEvals: 0 } };
  assert.match(planView.render(spend, page(noPlan)).__html, /data-action="checkout"/);
  const member = planView.render(spend, page({ ...noPlan, role: "member" })).__html;
  assert.doesNotMatch(member, /data-action="(checkout|portal)"/);
  assert.match(member, /Ask an admin of Sahra Health to choose a plan/);
});
