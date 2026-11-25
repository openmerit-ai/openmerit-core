import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApi, type Endpoint, type Project, type Subscriptions, type GuardrailsAt, type JobView, type Me, type Repo, type Report, type Run, type Spend, type Task } from "../api.ts";
import { createFakeApi } from "../dev/fake-api.ts";
import type { Account } from "../view.ts";
import { connectionsView, retried } from "../views/connections.ts";
import { projectView } from "../views/project.ts";
import { accountView } from "../views/account.ts";
import { choices, guardrailsView, parse } from "../views/guardrails.ts";
import { planView } from "../views/plan.ts";
import { runView } from "../views/run.ts";
import { runsView } from "../views/runs.ts";
import { tasksView } from "../views/tasks.ts";
import { evalsView } from "../views/evals.ts";
import type { EvalDraft, EvalView, GitHubAccess, TaskDetail } from "../api.ts";

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
const claims: Project = { id: "default", name: "Claims", createdAt: "2026-10-01T09:00:00Z", tasks: 4, endpoints: 1, repos: ["sahra-health/claims-api"] };
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

test("a run in the grading loop shows each sampled answer to grade, and a report says what the grades decided", async () => {
  const me = await account();
  const job = await get<JobView>("/api/runs/g4r9d2");
  const shown = runView.render(job, page(me)).__html;
  assert.equal(shown.match(/<fieldset class="card grade"/g)?.length, 2);
  for (const question of job.questions) assert.match(shown, new RegExp(`name="${question.id}" value="good"[^>]*> Looks good`));
  const read = text(runView.render(job, page(me)));
  assert.match(read, /Grade its answers Grade them here or in your coding agent, which shows you the same 2 answers/);
  assert.match(read, /Coding reviewer, answer 1 of 2: does it look right\? anthropic\/claude-sonnet-5\.5 \(your current model\), typical case written-1/);
  assert.match(read, /OpenMerit: passed/);
  assert.match(read, /OpenMerit: failed G3: The invalid_code finding for R5O\.9 has no activity_id\./);
  assert.match(read, /Send 2 grades/);
  // The fake applies grades as the cloud app does: once every answer has one, the run measures again.
  const graded = await fake(new Request("https://openmerit.ai/api/runs/g4r9d2/answers", { method: "POST", headers: { authorization: "Bearer preview-populated", "content-type": "application/json" }, body: JSON.stringify({ answers: Object.fromEntries(job.questions.map(question => [question.id, "bad: placeholder code"])) }) }));
  assert.deepEqual([graded.status, ((await graded.json()) as JobView).status], [200, "running"]);

  const base = await get<Report>("/api/runs/k7m2q9");
  const summary = "Your current model fails 1 of your checks (G3); the cheapest model that passes them is anthropic/claude-haiku-5-5, at $0.40 more per 1,000 calls.";
  const criteria = text(runView.render({ ...base, grading: { rounds: 2, accepted: true, bar: "criteria", failedChecks: ["G3"], summary, barSet: { round: 1, cases: ["written-4"] } } }, page(me)));
  assert.match(criteria, /You accepted the eval after 2 rounds of grading\. In round 1 you graded the answer of the model in use now to written-4 as not looking right, so every model was measured against the eval's checks/);
  assert.ok(criteria.includes(summary), "the pick card says what the current model misses");
  assert.doesNotMatch(text(runView.render(base, page(me))), /Your Grades/, "a run nobody graded has no grades section");
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

test("a result shows the decision the coding agent sent back, or that it waits for one; project settings have no app connections", async () => {
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
  // Tinted rows: Tasks marks only a model that changed; Runs marks every run that found a cheaper one,
  // including a pick still waiting and an older one declined since.
  const fresh = createFakeApi();
  const load = async <T>(path: string): Promise<T> => await (await fresh(new Request(`https://openmerit.ai${path}`, { headers: { authorization: "Bearer preview-populated" } }))).json() as T;
  const tinted = (html: { __html: string }) => [...html.__html.matchAll(/<tr class="switch">\s*<td><a href="[^"]*">([^<]+)<\/a>/g)].map((row) => row[1]);
  const freshTasks = await load<Task[]>("/api/tasks");
  assert.deepEqual(tinted(tasksView.render({ tasks: freshTasks }, page(me))), ["Ticket router"]);
  const runRows = runsView.render({ runs: await load<Run[]>("/api/runs"), tasks: freshTasks, jobs: [] }, page(me)).__html;
  assert.deepEqual([...runRows.matchAll(/<tr class="switch"><td><a href="\/r\/(\w+)\/">/g)].map((row) => row[1]).sort(), ["b2v5h3", "k7m2q9", "m5d8q2"]);
  const settings = projectView.render({ project: claims, endpoints: await get("/api/endpoints"), repos: [] }, page(me)).__html;
  assert.doesNotMatch(settings, /Viktor|Langfuse|id="apps"/);
  assert.match(settings, /id="endpoints"/);
});

test("Project settings lists each repository with its model calls, how it is read, and its review's state, and only admins change them", async () => {
  const me = await account();
  const repos = await get<Repo[]>("/api/repos");
  const endpoints = await get<Endpoint[]>("/api/endpoints");
  const shown = text(projectView.render({ project: claims, endpoints, repos }, page(me)));
  assert.match(shown, /sahra-health\/claims-api 6 model calls: gpt-5, claude-sonnet-5\.5, gpt-5-mini, settings\.reply_model · 3 more in tests, fixtures or docs, not listed · 2 task specs · 214 files at 4be1c07 on main Private · token ending 9c1e/);
  assert.match(shown, /src\/replies\/draft\.py:31 settings\.reply_model 3 more in tests, fixtures or docs, not listed\./);
  assert.match(shown, /sahra-health\/enroll-web 1 model call: gpt-5-mini · 88 files at 4be1c07 on main Public/);
  assert.match(shown, /src\/triage\.ts:14 gpt-5 from TRIAGE_MODEL/);
  assert.match(shown, /never runs your code, pushes, or opens a pull request/);
  assert.match(shown, /Contents: Read-only/);
  // A review that wrote task specs counts them, and shows each one's checks, the calls in no spec and what it cost.
  assert.match(shown, /Show the 2 task specs claim triage · Sorts an incoming claim into its review queue\. answers one of 3 labels · src\/triage\.ts:14 A right answer Sends claims with a missing policy number to adjuster\./);
  assert.match(shown, /reply drafter · Drafts the reply .* answers in text · 1 tool · src\/replies\/draft\.py:8, src\/replies\/draft\.py:31 .* It must never Never shares another member's claim\. Never promises a payment date\./);
  assert.match(shown, /2 model calls in no spec: The review of claim matching stopped: it reached its \$2\.00 budget\./);
  assert.match(shown, /This review cost OpenMerit \$0\.38 in model calls, counted in your spend; it is not one of your plan's evaluations\./);
  // A scan-only review has no specs to show.
  assert.doesNotMatch(text(projectView.render({ project: claims, endpoints, repos: [repos[1]!] }, page(me))), /\d task specs?/);
  // A repository whose model calls are all in tests lists none, and says how many it left out.
  const testsOnly = { ...repos[1]!, review: { ...repos[1]!.review, result: { ...repos[1]!.review.result!, models: [], modelCalls: [], totalCalls: 0, supportCalls: 2, notListed: "2 more in tests, fixtures or docs, not listed" } } };
  const none = text(projectView.render({ project: claims, endpoints, repos: [testsOnly] }, page(me)));
  assert.match(none, /enroll-web No model calls in application code · 2 more in tests, fixtures or docs, not listed · 88 files/);
  assert.doesNotMatch(none, /Show the/);
  // A review that failed says why and keeps what the last one found; one under way says so and cannot start again.
  const failed = { ...repos[0]!, review: { ...repos[0]!.review, status: "failed" as const, error: "Cloning sahra-health/claims-api failed: took longer than 120 s" } };
  const running = { ...repos[1]!, review: { ...repos[1]!.review, status: "reviewing" as const } };
  const states = projectView.render({ project: claims, endpoints, repos: [failed, running] }, page(me)).__html;
  assert.match(text({ __html: states }), /The last review failed: Cloning sahra-health\/claims-api failed: took longer than 120 s 6 model calls/);
  assert.match(text({ __html: states }), /enroll-web Reviewing the code, read-only… 1 model call/);
  assert.match(states, /data-action="review" data-id="repo_sahrahealthenrollweb" disabled/);
  // A member sees the repositories but no form and no buttons.
  const member = projectView.render({ project: claims, endpoints, repos }, page(await account("member"))).__html;
  assert.doesNotMatch(member, /data-action="(addRepo|review|removeRepo)"/);
  assert.match(text({ __html: member }), /Only an admin of Sahra Health can add, review or remove repositories/);
});

test("without an active plan, Project settings keep the repositories listed and says a review needs a plan; the fake refuses as the cloud app does", async () => {
  const me = await account("noplan");
  const repos = await get<Repo[]>("/api/repos", "noplan");
  const shown = text(projectView.render({ project: claims, endpoints: [], repos }, page(me)));
  assert.match(shown, /sahra-health\/claims-api/);
  assert.match(shown, /Reviewing a repository needs an active plan\. Your repositories stay listed with their last review\. Choose a plan to add or review one\./);
  assert.doesNotMatch(text(projectView.render({ project: claims, endpoints: [], repos }, page(await account()))), /needs an active plan/);
  const send = (path: string, body?: object) => createFakeApi()(new Request(`https://openmerit.ai${path}`, { method: "POST", headers: { authorization: "Bearer preview-noplan" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const added = await send("/api/repos", { url: "https://github.com/acme/app" });
  assert.equal(added.status, 400);
  assert.match((await added.json() as { error: string }).error, /^This account has no active OpenMerit plan\. Subscribe at .*\/plan\/, then try again\.$/);
  assert.equal((await send(`/api/repos/${repos[0]!.id}/review`)).status, 402);
});

test("the preview's fake checks a repository like the cloud app: a private one needs a fine-grained token, and its review finishes", async () => {
  const api = createFakeApi();
  const send = async (body: object) => {
    const response = await api(new Request("https://openmerit.ai/api/repos", { method: "POST", headers: { authorization: "Bearer preview-empty" }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Repo & { error: string } };
  };
  assert.match((await send({ url: "https://gitlab.com/a/b" })).body.error, /GitHub URL/);
  assert.match((await send({ url: "github.com/acme/private-app" })).body.error, /fine-grained token/);
  assert.match((await send({ url: "github.com/acme/private-app", token: `ghp_${"x".repeat(36)}` })).body.error, /classic token/);
  const added = await send({ url: "https://github.com/acme/private-app", token: `github_pat_${"x".repeat(30)}` });
  assert.equal(added.status, 201);
  assert.equal(added.body.review.status, "reviewing");
  assert.equal(added.body.tokenLast4, "xxxx");
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

test("each call names the open project, and a project's endpoints and repositories are its own", async () => {
  const sent: (string | null)[] = [];
  const api = createApi("https://openmerit.ai", async () => "preview-populated", async (input, init) => {
    const request = new Request(input as URL, init);
    sent.push(request.headers.get("x-openmerit-project"));
    return fake(request);
  }, undefined, () => "prj_enrollment");
  assert.deepEqual(await api.get("/api/endpoints"), [], "the Enrollment project has no endpoints of its own");
  assert.ok((await get<Endpoint[]>("/api/endpoints")).length > 0, "the default project keeps the organization's");
  assert.deepEqual(sent, ["prj_enrollment"]);
  const projects = await get<Project[]>("/api/projects");
  assert.deepEqual(projects.map((item) => [item.id, item.name]), [["default", "Claims"], ["prj_enrollment", "Enrollment"]]);
});

test("Project settings let an admin rename the project and delete one without tasks; the default project is never deleted", async () => {
  const me = await account();
  const enrollment: Project = { id: "prj_enrollment", name: "Enrollment", createdAt: "2026-11-21T09:00:00Z", tasks: 0, endpoints: 0, repos: [] };
  const empty = projectView.render({ project: enrollment, endpoints: [], repos: [] }, page(me)).__html;
  assert.match(empty, /data-action="rename"/);
  assert.match(empty, /data-action="deleteProject">Delete project/);
  assert.match(projectView.render({ project: { ...enrollment, tasks: 2 }, endpoints: [], repos: [] }, page(me)).__html, /data-action="deleteProject" disabled/);
  assert.doesNotMatch(projectView.render({ project: claims, endpoints: [], repos: [] }, page(me)).__html, /deleteProject/);
  const member = projectView.render({ project: enrollment, endpoints: [], repos: [] }, page(await account("member"))).__html;
  assert.doesNotMatch(member, /data-action="(rename|deleteProject|add|addRepo)"/);
  // Coding agents keeps only adding OpenMerit and Disconnect.
  const agents = connectionsView.render({ github: { app: null, installUrl: null, signedIn: false, error: null, installations: [] }, repos: [], project: claims }, page(me)).__html;
  assert.match(agents, /data-action="disconnect"/);
  assert.doesNotMatch(agents, /id="(endpoints|repos|github)"/);
});

test("Coding agents lets a member signed in with GitHub add the repositories the GitHub App gives them, and links the install for everyone else", async () => {
  const me = await account();
  const github = await get<GitHubAccess>("/api/github");
  const repos = await get<Repo[]>("/api/repos");
  const shown = connectionsView.render({ github, repos, project: claims }, page(me, "installation_id=41&setup_action=install")).__html;
  assert.match(text({ __html: shown }), /The OpenMerit GitHub App is installed\. Its repositories are below\./);
  assert.match(text({ __html: shown }), /sahra-health Every repository|sahra-health 3 repositories/);
  // claims-api is already in the project; the other two can be added.
  assert.match(text({ __html: shown }), /sahra-health\/claims-api Private In Claims/);
  assert.match(shown, /data-action="addGithubRepo" data-repo="sahra-health\/billing-worker" aria-label="Add sahra-health\/billing-worker to Claims">/);
  assert.match(shown, /href="https:\/\/github\.com\/apps\/openmeritai\/installations\/new"[^>]*>Install on another account or organization/);
  // Without a plan the buttons stay, disabled, with the reason.
  const unpaid = connectionsView.render({ github, repos, project: claims }, page({ ...me, plan: { ...me.plan, status: "none" } })).__html;
  assert.match(unpaid, /data-repo="sahra-health\/billing-worker" disabled/);
  assert.match(text({ __html: unpaid }), /Reviewing a repository needs an active plan/);
  // A member sees the repositories but cannot add one.
  assert.doesNotMatch(connectionsView.render({ github, repos, project: claims }, page(await account("member"))).__html, /data-action="addGithubRepo"/);
  // Without a GitHub sign-in: Connect GitHub, and the fake refuses a GitHub add as the cloud app does.
  const plain = await get<GitHubAccess>("/api/github", "empty");
  assert.match(connectionsView.render({ github: plain, repos: [], project: claims }, page(me)).__html, /data-action="connectGithub">Connect GitHub/);
  const send = (scenario: string, url: string) => createFakeApi()(new Request("https://openmerit.ai/api/repos", { method: "POST", headers: { authorization: `Bearer preview-${scenario}` }, body: JSON.stringify({ url, via: "github" }) }));
  assert.match((await (await send("empty", "https://github.com/sahra-health/billing-worker")).json() as { error: string }).error, /no GitHub account/);
  const added = await (await send("populated", "https://github.com/sahra-health/billing-worker")).json() as Repo;
  assert.deepEqual([added.access, added.private, added.tokenLast4], ["github", true, null]);
  assert.match(text(projectView.render({ project: claims, endpoints: [], repos: [added] }, page(me))), /billing-worker .*Private · GitHub sign-in/);
});

test("Account settings walk through the ChatGPT sign-in and offer it as the case writer only once connected", async () => {
  const me = await account();
  const base = await get<Subscriptions>("/api/me/subscriptions");
  const fresh = text(accountView.render(base, page(me)));
  assert.match(fresh, /ChatGPT ChatGPT Plus or Pro Not connected Sign in with ChatGPT/);
  assert.doesNotMatch(fresh, /Claude/, "the hosted app offers no Claude sign-in");
  const options = accountView.render(base, page(me)).__html;
  assert.match(options, /<option value="chatgpt" disabled>/);
  assert.match(options, /<option value="openmerit" selected>/);
  const [chatgpt] = base.subscriptions as [Subscriptions["subscriptions"][number]];
  const signingIn: Subscriptions = { writer: "openmerit", subscriptions: [{ ...chatgpt, signIn: { startedAt: "2026-11-24T09:00:00Z", userCode: "KQ7P-M2XW", verificationUri: "https://auth.openai.com/codex/device" } }] };
  assert.match(text(accountView.render(signingIn, page(me))), /Enter this code: KQ7P-M2XW/);
  const connected: Subscriptions = { writer: "chatgpt", subscriptions: [{ ...chatgpt, connected: true, connectedAt: "2026-11-24T09:00:00Z" }] };
  assert.match(accountView.render(connected, page(me)).__html, /<option value="chatgpt" selected>/);
});

test("approving a reviewed eval adds the task last, not run yet; dismissing one empties the queue", async () => {
  const me = await account();
  const call = createFakeApi();
  const send = async <T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await call(new Request(`https://openmerit.ai${path}`, { method, headers: { authorization: "Bearer preview-populated" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, body: await response.json() as T };
  };
  const drafts = (await send<EvalDraft[]>("/api/eval-drafts")).body;
  const queue = evalsView.render({ drafts, tasks: [] }, page(me, "draft=draft_denial"));
  assert.match(queue.__html, /<a href="\?draft=draft_denial" aria-current="page">Denial letter checker/);
  assert.match(queue.__html, /<option value="missing_reason" selected>/, "a label task's expected answer is one of its labels");
  assert.match(text(queue), /Approve and add task Dismiss/);
  assert.match(text(evalsView.render({ drafts, tasks: [] }, page(me))), /Claim summary writer From sahra-health\/claims-api[^]*2 cases of 3 can be measured now/);

  const approved = await send<{ taskId: string }>("/api/eval-drafts/draft_summary/approve", "POST", { spec: { criteria: ["States the amount"] } });
  assert.equal(approved.status, 201);
  assert.equal((await send("/api/eval-drafts/draft_summary/approve", "POST")).status, 409);
  const listed = text(tasksView.render({ tasks: (await send<Task[]>("/api/tasks")).body }, page(me)));
  assert.match(listed, /Coding reviewer[^]*Claim summary writer [^]*Not run yet Not run yet starts with its first run/, "the new task is last and does not watch yet");
  const detail = (await send<TaskDetail>(`/api/tasks/${approved.body.taskId}`)).body;
  const evaluation = (await send<EvalView>(`/api/tasks/${approved.body.taskId}/eval`)).body;
  assert.deepEqual([evaluation.accepted!.version, evaluation.accepted!.spec.criteria, evaluation.draft], [1, ["States the amount"], null]);
  const runs = text(tasksView.render({ kind: "task", detail, eval: evaluation }, page(me, `task=${approved.body.taskId}`)));
  assert.match(runs, /Not run yet This task was approved from a repository review[^]*Run now/);
  assert.equal((await send(`/api/eval-drafts/draft_denial`, "DELETE")).status, 200);
  assert.deepEqual((await send("/api/eval-drafts")).body, []);
  assert.match(text(evalsView.render({ drafts: [], tasks: [] }, page(me))), /Nothing to review/);
});

test("a task's Eval tab shows the accepted eval read-only; a revision pauses runs until it is accepted as the next version", async () => {
  const me = await account();
  const call = createFakeApi();
  const send = async <T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await call(new Request(`https://openmerit.ai${path}`, { method, headers: { authorization: "Bearer preview-populated" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, body: await response.json() as T };
  };
  const render = async (id: string, tab = "eval") => {
    const [detail, evaluation] = [(await send<TaskDetail>(`/api/tasks/${id}`)).body, (await send<EvalView>(`/api/tasks/${id}/eval`)).body];
    return { detail, evaluation, html: tasksView.render({ kind: "task", detail, eval: evaluation }, page(me, `task=${id}${tab ? `&tab=${tab}` : ""}`)) };
  };
  const router = await render("ticket-router");
  assert.match(text(router.html), /Accepted: version 2 Accepted in the app · Amira Haddad[^]*6 cases measured of 6 1 run on this version/);
  assert.match(text(router.html), /Behind \.openmerit\/evals\/ticket-router has version 1, written by Amira Haddad with claude-code/);
  assert.match(router.html.__html, /<fieldset disabled>/, "an accepted eval is not edited in place");
  assert.match(router.html.__html, /data-action="revise"/);
  assert.doesNotMatch(router.html.__html, /Accept as version/);
  assert.match(text((await render("ticket-router", "")).html), /measured on 2 eval versions. Results from different versions are not comparable/);

  // Revising opens a draft and pauses the task; saving keeps it a draft, and accepting makes version 3.
  const draft = await send<EvalView>("/api/tasks/ticket-router/eval/revise", "POST");
  assert.equal(draft.body.draft!.reason, "revise");
  assert.equal((await send("/api/tasks/ticket-router/run", "POST")).status, 409, "runs wait for the revision");
  const revising = await render("ticket-router");
  assert.match(text(revising.html), /Needs review[^]*Draft of version 3[^]*Runs and the watch wait until you accept or discard it/);
  assert.doesNotMatch(revising.html.__html, /data-action="run"/);
  assert.match(revising.html.__html, /Accept as version 3[^]*data-action="saveDraft"[^]*data-action="discardDraft"/);
  const cases = draft.body.draft!.cases.slice(1);
  assert.equal((await send("/api/tasks/ticket-router/eval/draft", "PUT", { spec: draft.body.draft!.spec, cases, base: "2026-01-01T00:00:00Z" })).status, 409, "a save on a stale copy is refused");
  const saved = await send<EvalView>("/api/tasks/ticket-router/eval/draft", "PUT", { spec: draft.body.draft!.spec, cases, base: draft.body.draft!.at });
  assert.deepEqual([saved.body.accepted!.version, saved.body.draft!.cases.length], [2, cases.length]);
  const accepted = await send<EvalView>("/api/tasks/ticket-router/eval/accept", "POST", { base: saved.body.draft!.at });
  assert.deepEqual([accepted.body.accepted!.version, accepted.body.accepted!.cases.length, accepted.body.draft], [3, cases.length, null]);
  assert.equal((await send<Task[]>("/api/tasks")).body.find((task) => task.id === "ticket-router")!.state, "watching");

  // A changed task's draft says what changed, and cannot be discarded.
  const drafter = await render("reply-drafter");
  assert.match(text(drafter.html), /Your coding agent sent Reply drafter with its tools changed[^]*Runs and the watch wait until you accept it\./);
  assert.doesNotMatch(drafter.html.__html, /data-action="discardDraft"/);
  assert.equal((await send("/api/tasks/reply-drafter/eval/draft", "DELETE")).status, 409);
  const queue = text(evalsView.render({ drafts: [], tasks: (await send<Task[]>("/api/tasks")).body.filter((task) => task.state === "review") }, page(me)));
  assert.match(queue, /Tasks waiting for their eval Reply drafter/);

  // A retired task's eval is read-only, with no revise.
  const retired = tasksView.render({ kind: "task", detail: { ...router.detail, state: "retired" }, eval: accepted.body }, page(me, "task=ticket-router&tab=eval")).__html;
  assert.match(retired, /<fieldset disabled>/);
  assert.doesNotMatch(retired, /data-action="retire"|data-action="revise"/);
});
