// A task's eval end to end: the first run's label check makes the accepted version 1, later runs
// measure on the accepted eval unchanged, a person revises it into a draft that pauses runs until they
// accept it as the next version, a task whose prompt changed reopens it the same way, the coding agent
// reads the accepted version, and deleting the task deletes the eval.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { EvalView, JobRow } from "../../src/server/actors/account.ts";
import { bundle, caller, fakeModels, startApp, stop, subscribe, untilDone, waitFor, type App, type FakeModels } from "./helpers.ts";

interface Case { id: string; input: Record<string, string>; expected?: unknown; origin: string; approved?: boolean }

describe("evals", () => {
  let models: FakeModels, app: App;
  before(async () => { models = await fakeModels(); app = await startApp({ models }); });
  after(async () => { await stop(app); await models.close(); });

  test("runs measure on the accepted eval unchanged; a revision or a changed task pauses them until someone accepts the next version", async () => {
    const me = caller(app, "test:user_e:org_evals:admin");
    await subscribe(app, "org_evals");
    const result = (jobId: string) => () => me.tool("openmerit_result", { job_id: jobId });
    const finished = (value: { data: Record<string, unknown> }) => ["done", "failed", "stopped"].includes(String(value.data.status));

    const first = await me.tool("openmerit_recommend", { bundle: bundle("eval classifier"), environment: "acme/app" });
    const firstJob = first.data.job_id as string;
    await waitFor(result(firstJob), value => value.data.status === "needs_input");
    await me.tool("openmerit_answer", { job_id: firstJob, answers: { "label_example-7": "billing", label_check: ["written-1"] } });
    const done = await untilDone(me, firstJob);
    assert.equal(done.data.status, "done", done.text);

    const [task] = (await me.api<{ id: string }[]>("/api/tasks")).body;
    const evalUrl = `/api/tasks/${task!.id}/eval`;
    const first1 = (await me.api<EvalView>(evalUrl)).body;
    // untilDone graded the run's answers as OpenMerit did, which is the review that accepted it.
    assert.deepEqual([first1.accepted!.version, first1.accepted!.source, first1.accepted!.runs, first1.draft], [1, "grading", 1, null]);
    const cases = first1.accepted!.cases as Case[];
    assert.equal(cases.find(item => item.id === "example-7")!.expected, "billing", "the label-check answer is in the eval");
    assert.deepEqual(cases.filter(item => item.origin === "written").map(item => [item.id, item.approved]), [["written-1", true], ["written-2", false]]);
    assert.equal((await me.api<JobRow[]>("/api/runs")).body[0]!.evalVersion, 1);

    // An accepted eval is not edited in place: a person revises it into a draft, which pauses the task's runs.
    const edited = cases.filter(item => item.id !== "example-1").map(item => (item.id === "example-7" ? { ...item, expected: "account" } : item));
    const spec = { ...first1.accepted!.spec, criteria: ["Routes the ticket to the queue that owns it"] };
    assert.equal((await me.api(`${evalUrl}/draft`, { method: "PUT", body: JSON.stringify({ spec, cases: edited }) })).status, 409);
    const opened = await me.api<EvalView>(`${evalUrl}/revise`, { method: "POST" });
    assert.deepEqual([opened.body.draft!.reason, opened.body.draft!.cases.length, opened.body.accepted!.version], ["revise", cases.length, 1]);
    assert.equal((await me.api<{ state: string }[]>("/api/tasks")).body[0]!.state, "review");
    const paused = await me.tool("openmerit_recommend", { bundle: bundle("eval classifier"), environment: "acme/app" });
    assert.equal(paused.isError, true);
    assert.match(paused.text, /eval waits for review at .*tab=eval/);
    // Saves overwrite the draft; one made on a stale copy is refused, and a malformed case is refused.
    const saved = await me.api<EvalView>(`${evalUrl}/draft`, { method: "PUT", body: JSON.stringify({ spec, cases: edited, base: opened.body.draft!.at }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.draft!.cases.length, saved.body.draft!.by, saved.body.draft!.byName, saved.body.accepted!.version], [edited.length, "user_e", "User E", 1]);
    const stale = await me.api<{ error: string }>(`${evalUrl}/draft`, { method: "PUT", body: JSON.stringify({ spec, cases, base: opened.body.draft!.at }) });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /Someone saved this draft/);
    assert.equal((await me.api(`${evalUrl}/draft`, { method: "PUT", body: JSON.stringify({ spec, cases: [{ id: "x", input: { ticket: 3 }, origin: "example" }] }) })).status, 400);
    const accepted = await me.api<EvalView>(`${evalUrl}/accept`, { method: "POST", body: JSON.stringify({ base: saved.body.draft!.at }) });
    assert.deepEqual([accepted.body.accepted!.version, accepted.body.accepted!.source, accepted.body.accepted!.by, accepted.body.accepted!.byName, accepted.body.draft], [2, "app", "user_e", "User E", null]);
    assert.equal((await me.api<{ state: string }[]>("/api/tasks")).body[0]!.state, "watching");

    // The coding agent reads the accepted eval as the app edited it.
    const read = await me.tool("openmerit_eval", { task_id: task!.id });
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /eval classifier's accepted eval, version 2: \d+ cases/);
    assert.deepEqual([read.data.version, (read.data.spec as { criteria: string[] }).criteria, (read.data.cases as Case[]).length], [2, spec.criteria, edited.length]);

    // The next run measures on version 2 as accepted: it asks nothing, writes no cases, sends the app's criteria to
    // the judge in place of the agent's, and leaves out an example the agent added without changing the eval.
    const callsBefore = models.calls.length;
    const withExample = { ...bundle("eval classifier"), examples: [...bundle("eval classifier").examples, { input: { ticket: "A ticket nobody has seen" }, expected: "billing" }] };
    const second = await me.tool("openmerit_recommend", { bundle: withExample, environment: "acme/app" });
    const again = await waitFor(result(second.data.job_id as string), value => finished(value) || value.data.status === "needs_input");
    assert.equal(again.data.status, "done", again.text);
    const report = (await me.api<{ failedCases: { caseId: string; reason: string }[]; cases: { total: number }; evalVersion: number }>(`/api/runs/${String(second.data.job_id)}`)).body;
    assert.equal(report.evalVersion, 2);
    assert.equal(report.cases.total, edited.filter(item => item.expected !== undefined && item.approved !== false).length, "the case the app dropped stays dropped, and the new example is not used");
    assert.deepEqual(report.failedCases.map(item => [item.caseId, item.reason]), [["example-7", "Answered billing, expected account."]], "the app's fixed answer is the one graded");
    assert.ok(!models.calls.slice(callsBefore).some(call => call.ticket.startsWith("writer:")), "no cases are written");
    assert.match(again.text, /used the criteria of accepted eval version 2/);
    assert.match(again.text, /2 examples the coding agent sent are not in the accepted eval/, "the one the app removed and the new one");
    assert.deepEqual((await me.api<JobRow[]>("/api/runs")).body.map(item => item.evalVersion), [2, 1]);
    const unchanged = (await me.api<EvalView>(evalUrl)).body;
    assert.deepEqual([unchanged.accepted!.version, unchanged.accepted!.cases.length, unchanged.accepted!.runs], [2, edited.length, 1], "a run does not change the accepted eval");

    // The task changes: the agent sends a different prompt. The eval reopens with the new example, and runs wait for review.
    const changed = { ...withExample, prompt: { system: "You route support tickets for the EU team.", messages: [{ role: "user", content: "Ticket: {{ticket}}" }] } };
    const refused = await me.tool("openmerit_recommend", { bundle: changed, environment: "acme/app" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /The task changed since its eval was accepted \(its prompt\)/);
    const reopened = (await me.api<EvalView>(evalUrl)).body;
    assert.deepEqual([reopened.draft!.reason, reopened.draft!.changed, reopened.accepted!.version], ["task_changed", ["prompt"], 2]);
    assert.ok(reopened.draft!.cases.some(item => item.input.ticket === "A ticket nobody has seen"), "the changed task's new example joins the draft");
    assert.match((await me.tool("openmerit_tasks", {})).text, /eval classifier \[[^\]]+\][^\n]*, review, [^\n]*a draft waits for review/);
    assert.equal((await me.api(`${evalUrl}/draft`, { method: "DELETE" })).status, 409, "a changed task's draft cannot be discarded");
    assert.equal((await me.api<{ started: string | null; reason: string }>(`/api/tasks/${task!.id}/run`, { method: "POST" })).status, 409);
    // Accepting it makes version 3 and moves the task onto the changed bundle, so a run by task_id measures the new prompt.
    assert.equal((await me.api<EvalView>(`${evalUrl}/accept`, { method: "POST", body: "{}" })).body.accepted!.version, 3);
    const third = await me.tool("openmerit_recommend", { task_id: task!.id });
    assert.ok(!third.isError, third.text);
    const thirdDone = await waitFor(result(third.data.job_id as string), value => finished(value) || value.data.status === "needs_input");
    assert.equal(thirdDone.data.status, "done", thirdDone.text);
    assert.equal((await me.api<{ evalVersion: number }>(`/api/runs/${String(third.data.job_id)}`)).body.evalVersion, 3);
    assert.equal((await me.api<{ bundle: { prompt: { system: string } } }>(`/api/tasks/${task!.id}`)).body.bundle.prompt.system, "You route support tickets for the EU team.", "the run used the changed prompt");

    // Deleting the task deletes its eval.
    const deleted = await me.api(`/api/tasks/${task!.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await me.api(`/api/tasks/${task!.id}/eval`)).status, 404);
    const exported = JSON.stringify((await me.api<{ evals: unknown[] }>("/api/account/export", { method: "POST" })).body.evals);
    assert.equal(exported, "[]");
    assert.equal((await me.tool("openmerit_eval", { task_id: task!.id })).isError, true);
    assert.match((await me.tool("openmerit_tasks", {})).text, /^No tasks yet/);
  });
});
