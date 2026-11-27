import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApi, type Endpoint, type Project, type Subscriptions, type GuardrailsAt, type JobView, type Me, type Report, type Run, type Spend, type Task } from "../api.ts";
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
import type { EvalDraft, EvalView, GitHubAccess, Repo, TaskDetail } from "../api.ts";

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

test("guardrails are set for an environment or a task, and show each value with the level it came from", async () => {
  const me = await account();
  const tasks = await get<Task[]>("/api/tasks");
  assert.deepEqual(choices(tasks, "environment").map((item) => item.id), ["sahra-health/claims", "sahra-health/enroll"]);
  const task = await get<GuardrailsAt>("/api/guardrails?level=task&id=ticket-router");
  const shownTask = guardrailsView.render({ tasks, level: "task", id: "ticket-router", guardrails: task }, page(me));
  assert.deepEqual([...shownTask.__html.matchAll(/<a href="\?level=(\w+)"/g)].map((tab) => tab[1]), ["environment", "task"], "no agent level");
  const atTask = text(shownTask);
  assert.match(atTask, /Minimum pass rate minPassRate Default · can be replaced 95% Environment/);
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

test("a result shows the decision the coding agent sent back, or that it waits for one; the endpoints page has no app connections", async () => {
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
  const settings = projectView.render({ project: claims, endpoints: await get<Endpoint[]>("/api/endpoints"), repos: [], github: noGithub }, page(me)).__html;
  assert.doesNotMatch(settings, /Viktor|Langfuse|id="apps"/);
  assert.match(settings, /id="endpoints"/);
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

const claims: Project = { id: "default", name: "Claims", createdAt: "2026-10-01T09:00:00Z", tasks: 4, endpoints: 2, repos: [] };
const noGithub: GitHubAccess = { app: "openmeritai", installUrl: "https://github.com/apps/openmeritai/installations/new", signedIn: false, error: null, installations: [] };

test("Project settings hold the project's endpoints; only admins change them, and Coding agents no longer list endpoints", async () => {
  const me = await account();
  const endpoints = await get<Endpoint[]>("/api/endpoints");
  const shown = projectView.render({ project: claims, endpoints, repos: [], github: noGithub }, page(me)).__html;
  assert.match(shown, /data-action="rename"/);
  assert.match(shown, /id="endpoints"[^]*Key ending 4f2a · you pay[^]*data-action="add"/);
  assert.doesNotMatch(shown, /deleteProject/, "the default project is never deleted");
  const member = projectView.render({ project: claims, endpoints, repos: [], github: noGithub }, page(await account("member"))).__html;
  assert.doesNotMatch(member, /data-action="(add|remove|rename|deleteProject)"/);
  assert.match(text({ __html: member }), /Only an admin of Sahra Health can add or remove endpoints/);
  const agents = connectionsView.render(null, page(me)).__html;
  assert.match(agents, /data-action="disconnect"/);
  assert.doesNotMatch(agents, /id="endpoints"|data-action="add"/);
  assert.doesNotMatch(connectionsView.render(null, page(await account("member"))).__html, /data-action="disconnect"/);
});

test("each call names the open project, a project's endpoints are its own, and only an empty project other than the default is deleted", async () => {
  const projects = createFakeApi();
  const sent: (string | null)[] = [];
  let open: string | null = "prj_enrollment";
  const api = createApi("https://openmerit.ai", async () => "preview-populated", async (input, init) => {
    const request = new Request(input as URL, init);
    sent.push(request.headers.get("x-openmerit-project"));
    return projects(request);
  }, undefined, () => open);
  assert.deepEqual(await api.get("/api/endpoints"), [], "the Enrollment project has no endpoints of its own");
  assert.equal(sent.at(-1), "prj_enrollment");
  open = null;
  assert.ok((await api.get<Endpoint[]>("/api/endpoints")).length > 0, "the default project keeps the organization's");
  assert.equal(sent.at(-1), null);
  const listed = await api.get<Project[]>("/api/projects");
  assert.deepEqual(listed.map((item) => [item.id, item.name]), [["default", "Claims"], ["prj_enrollment", "Enrollment"]]);
  await assert.rejects(api.send("DELETE", "/api/projects/default"), (failure) => failure instanceof ApiError && failure.status === 409);
  open = "prj_missing";
  await assert.rejects(api.get("/api/tasks"), (failure) => failure instanceof ApiError && failure.status === 404);

  const me = await account();
  const enrollment = listed[1]!;
  assert.match(projectView.render({ project: enrollment, endpoints: [], repos: [], github: noGithub }, page(me)).__html, /data-action="deleteProject">Delete project/);
  assert.match(projectView.render({ project: { ...enrollment, tasks: 2 }, endpoints: [], repos: [], github: noGithub }, page(me)).__html, /data-action="deleteProject" disabled/);
});

test("Account settings walk through the ChatGPT sign-in and offer it as the case writer only once connected", async () => {
  const me = await account();
  const base = { ...await get<Subscriptions>("/api/me/subscriptions"), github: noGithub };
  const fresh = text(accountView.render(base, page(me)));
  assert.match(fresh, /ChatGPT ChatGPT Plus or Pro Not connected Sign in with ChatGPT/);
  assert.doesNotMatch(fresh, /Claude/, "the hosted app offers no Claude sign-in");
  const options = accountView.render(base, page(me)).__html;
  assert.match(options, /<option value="chatgpt" disabled>/);
  assert.match(options, /<option value="openmerit" selected>/);
  const [chatgpt] = base.subscriptions as [Subscriptions["subscriptions"][number]];
  const signingIn: Subscriptions & { github: GitHubAccess } = { github: noGithub, writer: "openmerit", subscriptions: [{ ...chatgpt, signIn: { startedAt: "2026-11-24T09:00:00Z", userCode: "KQ7P-M2XW", verificationUri: "https://auth.openai.com/codex/device" } }] };
  assert.match(text(accountView.render(signingIn, page(me))), /Enter this code: KQ7P-M2XW/);
  const connected: Subscriptions & { github: GitHubAccess } = { github: noGithub, writer: "chatgpt", subscriptions: [{ ...chatgpt, connected: true, connectedAt: "2026-11-24T09:00:00Z" }] };
  assert.match(accountView.render(connected, page(me)).__html, /<option value="chatgpt" selected>/);
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
  assert.doesNotMatch(text(router.html), /Repository copy|\.openmerit\/evals/);
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

test("a project adds GitHub repositories by URL, token or the member's GitHub connection, and its review's drafts approve into tasks not run yet", async () => {
  const me = await account();
  const call = createFakeApi();
  const send = async <T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const answer = await call(new Request(`https://openmerit.ai${path}`, { method, headers: { authorization: "Bearer preview-populated", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: answer.status, body: await answer.json() as T };
  };
  const repos = (await send<Repo[]>("/api/repos")).body, github = (await send<GitHubAccess>("/api/github")).body;
  const settings = projectView.render({ project: claims, endpoints: [], repos, github }, page(me));
  const shown = text(settings);
  assert.match(shown, /sahra-health\/claims-api[^]*Private · token ending 9c1e[^]*Review again/);
  assert.match(shown, /From your GitHub connection[^]*sahra-health\/claims-api Private In Claims sahra-health\/billing-worker Private Add/);
  assert.match(settings.__html, /data-action="addRepo"/);
  const member = text(projectView.render({ project: claims, endpoints: [], repos, github }, page(await account("member"))));
  assert.match(member, /Only an admin of Sahra Health can add, review or remove repositories/);
  assert.doesNotMatch(member, /From your GitHub connection/);
  // Without a GitHub connection, the project points to Account settings, which connects it.
  assert.match(text(projectView.render({ project: claims, endpoints: [], repos, github: noGithub }, page(me))), /Connect GitHub on Account settings/);
  const subscriptions = await send<Subscriptions>("/api/me/subscriptions");
  assert.match(text(accountView.render({ ...subscriptions.body, github: noGithub }, page(me))), /GitHub Connect GitHub to add repositories[^]*Not connected Connect GitHub/);
  assert.match(text(accountView.render({ ...subscriptions.body, github }, page(me))), /sahra-health Every repository|sahra-health 3 repositories: sahra-health\/claims-api/);
  // The GitHub App's Setup URL, /connections/, goes on to Account settings.
  const went: string[] = [];
  await connectionsView.load({ ...page(me), params: new URLSearchParams("installation_id=41&setup_action=install"), go: (url: string) => went.push(url) } as unknown as Parameters<typeof connectionsView.load>[0]);
  assert.deepEqual(went, ["/account/?installation_id=41&setup_action=install"]);
  assert.equal((await send<Repo>("/api/repos", "POST", { url: "https://github.com/sahra-health/billing-worker", via: "github" })).status, 201);

  // The review's drafts wait in Review evals; approving one adds the task, not run yet, with no accepted eval.
  const drafts = (await send<EvalDraft[]>("/api/eval-drafts")).body;
  const queue = text(evalsView.render({ drafts, tasks: [] }, page(me)));
  assert.match(queue, /From repository reviews Claim summary writer Denial letter checker[^]*Approve and add task/);
  const approved = await send<{ taskId: string }>(`/api/eval-drafts/${drafts[0]!.id}/approve`, "POST", { spec: { criteria: ["States the amount"] }, cases: drafts[0]!.cases });
  assert.equal(approved.status, 201);
  const task = (await send<Task[]>("/api/tasks")).body.find((item) => item.id === approved.body.taskId)!;
  assert.deepEqual([task.name, task.status, task.lastRunAt], ["Claim summary writer", "new", null]);
  assert.equal((await send<EvalView>(`/api/tasks/${task.id}/eval`)).body.accepted, null, "approval accepts no eval: the first run grades one");
  assert.equal((await send(`/api/eval-drafts/${drafts[1]!.id}`, "DELETE")).status, 200);
  assert.deepEqual((await send<EvalDraft[]>("/api/eval-drafts")).body, []);
});
