// A job from its label check to a watch: a person grades its trial and a run's answers, the coding agent
// sends back the user's decision, and later runs reuse the accepted eval. The app runs in a child process
// so a test can restart it mid-job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "rivetkit/client";
import type { Registry } from "../../src/server/registry.ts";
import type { TaskBundle } from "../../src/ranking/index.ts";
import { bundle, caller, CLERK, costOf, crash, fakeCapture, fakeModels, startApp, stop, subscribe, sum, untilDone, personGrade, waitFor, writerCalls, WEAK_BELOW, WRITTEN, catalogue, type Data, type FakeModels, type Result } from "./helpers.ts";

/** What every call the fake answered cost, for a job none of whose steps ran twice. */
const sentCost = (models: FakeModels) => sum(models.calls.map(call => costOf(call.model)));

test("a job waits on its label check across a restart, then a person grades its trial, it measures on OpenRouter and the customer's endpoint, and a watch re-runs it", async () => {
  const models = await fakeModels();
  const posthog = await fakeCapture();
  const events = (name: string) => posthog.events.filter(event => event.event === name);
  let app = await startApp({ models, env: { ...CLERK, TEST_CATALOGUE_VERSION: "next", TEST_CATALOGUE_NEW_MODEL: "2", POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: posthog.url } });
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
    // The example without an answer is asked about; the written cases are not: a person grades the trial's answers instead.
    const asking = await waitFor(result, value => value.data.status === "needs_input");
    assert.deepEqual((asking.data.questions as { id: string }[]).map(question => question.id), ["label_example-7"]);
    assert.match(asking.text, /Where is my invoice for March\?/);
    // The writer asks for 12 cases, gets 2, and asks once more for the other 10.
    assert.deepEqual(models.calls.map(call => call.ticket), ["writer:12", "writer:10"], "nothing is measured before the label check");

    await crash(app);
    app = await startApp({ models, env: app.env, storage: app.storage, enginePort: app.enginePort });
    const resumed = await waitFor(result, value => value.data.status === "needs_input", 90_000);
    assert.deepEqual((resumed.data.questions as { id: string }[]).map(question => question.id), ["label_example-7"]);

    const answered = await agent().tool("openmerit_answer", { job_id: jobId, answers: { "label_example-7": "billing" } });
    assert.equal(answered.isError, false, answered.text);
    const done = await untilDone(agent(), jobId);
    assert.equal(done.data.status, "done", done.text);
    const measured = done.data.result as Result;
    assert.equal(measured.status, "picked");
    assert.equal(new URL(measured.reportUrl).pathname, `/r/${jobId}/`, "the app serves reports at /r/<id>/");
    // Every case, three times: the seven examples and both written cases.
    assert.equal(measured.pick!.total, 27);
    assert.equal(measured.pick!.passes, 27);
    // The pick says after how many calls its saving repays what the run cost.
    assert.equal(measured.pick!.paybackCalls, Math.ceil((measured.spend.openmeritUsd + measured.spend.customerUsd) / measured.pick!.savingPerCallUsd!));
    assert.match(done.text, /which the saving repays after about [\d,.]+( thousand| million)? calls/);
    assert.ok((catalogue.models.find(model => model.id === measured.pick!.model)?.eci ?? 200) >= WEAK_BELOW, `${measured.pick!.model} answers wrongly in the fake`);
    assert.deepEqual(measured.edit.edits.map(edit => [edit.before, edit.after]), [['const MODEL = "gpt-5.4";', `const MODEL = "${measured.pick!.model}";`]]);
    assert.ok(models.calls.some(call => call.ticket === "Where is my invoice for March?"), "the labelled case is measured");
    assert.ok(Object.keys(WRITTEN).every(ticket => models.calls.some(call => call.ticket === ticket)), "both written cases are measured");
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

    // Watching is on from the first job: a new catalogue version starts a watch job, which runs on the accepted eval and asks nothing.
    type TaskView = { id: string; state: string; idleSince: string | null; watching: boolean };
    const taskView = async () => (await agent().api<TaskView[]>("/api/tasks")).body[0]!;
    const taskRow = await taskView();
    assert.deepEqual([taskRow.state, taskRow.idleSince, taskRow.watching], ["watching", null, true]);
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    // A new day's catalogue with the same models starts nothing; one with a new model as capable and cheaper re-runs the task.
    assert.deepEqual(await rivet.catalogue.getOrCreate(["global"]).refresh(), { version: "next", changed: true, models: [] });
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.ok(!(await agent().api<{ kind: string }[]>("/api/runs")).body.some(run => run.kind === "watch"), "no watch job without a model that could beat the pick");
    assert.deepEqual(await rivet.catalogue.getOrCreate(["global"]).refresh(), { version: "next-2", changed: true, models: ["test/new-cheap"] });
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
    assert.equal(watched.body.pick.total, 27);
    const tasks = await agent().tool("openmerit_tasks", {});
    assert.match(tasks.text, /ticket classifier \[[\w-]+\] \(acme\/support\): openai\/gpt-5\.4 → .*, picked, watching/);

    // Freezing: the watch guardrail inherits from the environment, a task-level value overrides it, and a frozen task's tick starts nothing.
    const tick = () => rivet.task.get(["org_run", taskRow.id]).watchTick({ models: ["test/new-cheap"] });
    const guardrail = (level: string, id: string, settings: Record<string, unknown>) => agent().api("/api/guardrails", { method: "PUT", body: JSON.stringify({ level, id, settings }) });
    await guardrail("environment", "acme/support", { watch: false });
    assert.deepEqual([(await taskView()).state, (await taskView()).watching], ["frozen", false]);
    assert.deepEqual(await tick(), { started: null, reason: "task is frozen" });
    // A task armed before watches followed the catalogue still has a daily schedule, which calls without models: it removes it.
    assert.deepEqual(await rivet.task.get(["org_run", taskRow.id]).watchTick(), { started: null, reason: "the daily check is gone: a catalogue change starts a watch job" });
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
    // A later recommend call starts the task fresh: its labels and accepted eval went with it, so it asks again.
    const fresh = await agent().tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    const asked = await waitFor(() => agent().tool("openmerit_result", { job_id: fresh.data.job_id }), value => value.data.status === "needs_input");
    assert.deepEqual((asked.data.questions as { id: string }[]).map(question => question.id), ["label_example-7"]);
    assert.equal((await caller(app, "test:user_q:org_run:admin:30").api("/api/account", { method: "DELETE" })).status, 403, "deleting the account needs a recent sign-in too");
    assert.equal(events("run_completed").length, 3, "each job sent run_completed once");
  } finally { await stop(app); await models.close(); await posthog.close(); }
});

test("the coding agent sends back the user's decision on a result's change: an approval moves the watched task onto the pick, a decline keeps it", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { ...CLERK, TEST_CATALOGUE_VERSION: "next", TEST_CATALOGUE_NEW_MODEL: "1" } });
  try {
    await subscribe(app, "org_decide");
    const agent = () => caller(app, "test:user_d:org_decide:admin");
    const start = async (task: string) => (await agent().tool("openmerit_recommend", { bundle: bundle(task), environment: "acme/decide" })).data.job_id as string;
    const [kept, dropped] = [await start("ticket classifier"), await start("reply router")];
    const result = (jobId: string) => agent().tool("openmerit_result", { job_id: jobId });
    const finish = async (jobId: string) => {
      await waitFor(() => result(jobId), value => value.data.status === "needs_input");
      await agent().tool("openmerit_answer", { job_id: jobId, answers: { "label_example-7": "billing" } });
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

test("a person grades a run's answers: a disagreement writes the eval again, agreement accepts it, and later runs reuse it without asking", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_grade");
    const agent = caller(app, "test:user_g:org_grade:admin");
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("graded classifier", false), environment: "acme/grade" });
    const jobId = started.data.job_id as string;
    // A first run may run its grading trial once per round, and its estimate says so.
    assert.equal((started.data.estimate as { rounds: number }).rounds, 3);
    assert.match(started.text, /Before it searches, you grade answers of the current model and a cheaper one: .* up to 3 rounds/);
    const result = () => agent.tool("openmerit_result", { job_id: jobId });

    // Round 1, before any search: the current model's answers and a cheaper model's from the trial, without the eval's grade.
    const asked = await waitFor(result, value => value.data.phase === "grading");
    const questions = asked.data.questions as { id: string; detail: string }[];
    assert.ok(questions.length > 6 && questions.every(question => question.id.startsWith("grade_graded_classifier_r1_")), asked.text);
    assert.match(asked.text, /It needs a person to grade its answers[^]*Never grade for them/);
    const current = questions.filter(question => question.detail.startsWith("openai/gpt-5.4 (your current model)"));
    const cheaper = questions.filter(question => /^\S+ \(a cheaper model\)/.test(question.detail));
    assert.equal(current.length + cheaper.length, questions.length);
    assert.ok(questions.every(question => !/OpenMerit's grade|passed|failed/.test(question.detail)), "a person judges the answer without the eval's grade");
    assert.ok(current.every(question => personGrade(question.detail) === "good"), "the fake's current model answers every case right");
    // The trial moved down the pool to a model the fake answers wrongly, so a person sees wrong answers too.
    assert.ok(cheaper.length > 0 && cheaper.some(question => personGrade(question.detail) === "bad"), JSON.stringify(cheaper.map(question => question.detail.split("\n")[0])));
    const screened = models.calls.filter(call => !call.ticket.startsWith("writer:")).map(call => call.model);
    assert.equal(new Set(screened).size, 1 + new Set(screened.filter(model => model !== "openai/gpt-5.4")).size);
    assert.ok(new Set(screened.filter(model => model !== "openai/gpt-5.4")).size <= Math.ceil(Math.log2(catalogue.models.length + 1)), "only the trial's models ran before grading, not the search");
    const mine = current[0]!;
    // Grading is the review: nothing is accepted until the person agrees with the eval.
    const [task] = (await agent.api<{ id: string }[]>("/api/tasks")).body;
    assert.equal((await agent.api<{ accepted: unknown }>(`/api/tasks/${task!.id}/eval`)).body.accepted, null);
    // A wrong grade is refused and asked again; a person grades in the app as the coding agent does.
    const refused = await agent.api<{ notices: string[]; questions: unknown[] }>(`/api/runs/${jobId}/answers`, { method: "POST", body: JSON.stringify({ answers: { [mine.id]: "maybe" } }) });
    assert.equal(refused.status, 200);
    assert.ok(refused.body.notices.some(notice => notice.startsWith(`Answer not used: ${mine.id}`)), refused.body.notices.join("\n"));
    const grades = Object.fromEntries(questions.map(question => [question.id, question === mine ? "bad: the queue should name the product area" : personGrade(question.detail)]));
    const sent = await agent.api(`/api/runs/${jobId}/answers`, { method: "POST", body: JSON.stringify({ answers: grades }) });
    assert.equal(sent.status, 200);

    // Round 2's trial runs on the eval written again from that grade, against its checks, since the current model's own answer looked wrong.
    const again = await waitFor(result, value => value.data.phase === "grading" && (value.data.questions as { id: string }[])[0]!.id.includes("_r2_"), 120_000);
    assert.ok(models.calls.some(call => call.ticket === "reviser"), "the reviser ran on OpenMerit's key");
    assert.ok((again.data.notices as string[]).includes("OpenMerit wrote the eval again from your grades of round 1."), JSON.stringify(again.data.notices));
    const spotChecked: { id: string; detail: string }[][] = [];
    const done = await untilDone(agent, jobId, undefined, questions => spotChecked.push(questions));
    assert.equal(done.data.status, "done", done.text);
    const report = (await agent.api<{ grading: { rounds: number; accepted: boolean; bar: string; summary: string | null }; evalVersion: number }>(`/api/runs/${jobId}`)).body;
    // Two trial rounds, then the spot-check of the pick, which counts toward the 3 rounds.
    assert.deepEqual([report.grading.rounds, report.grading.accepted, report.grading.bar, report.evalVersion], [3, true, "criteria", 1]);
    assert.match(report.grading.summary ?? "", /^Your current model meets your checks(, though it fails \d+ of its \d+ case runs)?[;,]/);
    assert.match(done.text, /You accepted the eval as version 1\. In round 1 you graded the current model's answer to \S+ as wrong, so models are measured against the eval's checks/);
    const evaluation = (await agent.api<{ accepted: { version: number; source: string; by: string | null; bar: string; spec: { criteria?: string[] } } }>(`/api/tasks/${task!.id}/eval`)).body.accepted;
    assert.deepEqual([evaluation.version, evaluation.source, evaluation.by, evaluation.bar], [1, "grading", "user_g", "criteria"]);
    assert.deepEqual(evaluation.spec.criteria, ["The queue is the one the ticket's main problem belongs to."]);

    // Before it was recommended, the person checked a few of the pick's answers, in a round of their own.
    const spot = (asked: { id: string; detail: string }[]) => asked.filter(question => /\(a candidate\)/.test(question.detail));
    assert.ok(spotChecked.some(questions => spot(questions).length > 0 && spot(questions).length <= 4), "a spot-check of the pick's answers");

    // The accepted eval keeps the answers the person graded. One the judge now grades differently is flagged on the next run.
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    const accountActor = rivet.account.getOrCreate(["org_grade"]);
    const kept = (await accountActor.evalGrades({ taskId: task!.id, version: 1 }))!;
    assert.ok(kept.length > 0 && kept.every(item => item.verdict === "good" || item.verdict === "bad"), JSON.stringify(kept).slice(0, 300));
    await accountActor.saveEvalGrades({ taskId: task!.id, version: 1, grades: kept.map((item, index) => (index === 0 ? { ...item, verdict: item.verdict === "good" ? "bad" : "good" } : item)) });

    // The next run measures on the accepted eval against its bar, and asks nothing.
    const next = await agent.tool("openmerit_recommend", { bundle: bundle("graded classifier", false), environment: "acme/grade" });
    assert.equal((next.data.estimate as { rounds: number }).rounds, 1, "a run on the accepted eval grades nothing");
    assert.doesNotMatch(next.text, /Before it searches/);
    const second = await waitFor(() => agent.tool("openmerit_result", { job_id: next.data.job_id }), value => ["done", "failed", "stopped", "needs_input"].includes(String(value.data.status)), 180_000);
    assert.equal(second.data.status, "done", second.text);
    const later = (await agent.api<{ grading: { rounds: number; accepted: boolean; bar: string }; evalVersion: number }>(`/api/runs/${String(next.data.job_id)}`)).body;
    assert.deepEqual([later.grading.rounds, later.grading.accepted, later.grading.bar, later.evalVersion], [0, true, "criteria", 1]);
    assert.match(second.text, new RegExp(`The eval now grades 1 of the ${kept.length} answers you graded when you accepted version 1 differently from you: ${kept[0]!.caseId}`));
  } finally { await stop(app); await models.close(); }
});
