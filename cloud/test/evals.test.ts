// A task's eval end to end: the first run saves its cases as version 1, the app edits it into new
// versions, later runs measure on the latest version and record it, the coding agent writes the
// repository copy and reports the version, and deleting the task deletes the eval and asks the agent
// about the copy. Drafts from repository reviews are in github.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { EvalView, JobRow } from "../src/actors/account.ts";
import { bundle, caller, fakeModels, startApp, stop, subscribe, waitFor, type App, type FakeModels } from "./helpers.ts";

interface Case { id: string; input: Record<string, string>; expected?: unknown; origin: string; approved?: boolean }

describe("evals", () => {
  let models: FakeModels, app: App;
  before(async () => { models = await fakeModels(); app = await startApp({ models }); });
  after(async () => { await stop(app); await models.close(); });

  test("runs pin an eval version; the app's edits make new versions, which the coding agent writes to the repository", async () => {
    const me = caller(app, "test:user_e:org_evals:admin");
    await subscribe(app, "org_evals");
    const result = (jobId: string) => () => me.tool("openmerit_result", { job_id: jobId });
    const finished = (value: { data: Record<string, unknown> }) => ["done", "failed", "stopped"].includes(String(value.data.status));

    const first = await me.tool("openmerit_recommend", { bundle: bundle("eval classifier"), environment: "acme/app" });
    const firstJob = first.data.job_id as string;
    await waitFor(result(firstJob), value => value.data.status === "needs_input");
    await me.tool("openmerit_answer", { job_id: firstJob, answers: { "label_example-7": "billing", label_check: ["written-1"] } });
    const done = await waitFor(result(firstJob), finished);
    assert.equal(done.data.status, "done", done.text);
    assert.match(done.text, /eval classifier's eval is at version 1; the repository has no copy/);

    const [task] = (await me.api<{ id: string }[]>("/api/tasks")).body;
    const first1 = (await me.api<EvalView>(`/api/tasks/${task!.id}/eval`)).body;
    assert.equal(first1.latest!.version, 1);
    assert.equal(first1.latest!.source, "openmerit");
    assert.equal(first1.latest!.runs, 1);
    const cases = first1.latest!.cases as Case[];
    assert.equal(cases.find(item => item.id === "example-7")!.expected, "billing", "the label-check answer is in the eval");
    assert.deepEqual(cases.filter(item => item.origin === "written").map(item => [item.id, item.approved]), [["written-1", true], ["written-2", false]]);
    assert.equal((await me.api<JobRow[]>("/api/runs")).body[0]!.evalVersion, 1);

    // An edit in the app: drop a case and fix an expected answer. A stale base version is refused.
    const edited = cases.filter(item => item.id !== "example-1").map(item => (item.id === "example-7" ? { ...item, expected: "account" } : item));
    const spec = { ...first1.latest!.spec, criteria: ["Routes the ticket to the queue that owns it"] };
    const saved = await me.api<EvalView>(`/api/tasks/${task!.id}/eval`, { method: "PUT", body: JSON.stringify({ spec, cases: edited, baseVersion: 1 }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.latest!.version, saved.body.latest!.source, saved.body.latest!.author], [2, "app", "user_e"]);
    const stale = await me.api<{ error: string }>(`/api/tasks/${task!.id}/eval`, { method: "PUT", body: JSON.stringify({ spec, cases, baseVersion: 1 }) });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /saved version 2/);
    assert.equal((await me.api(`/api/tasks/${task!.id}/eval`, { method: "PUT", body: JSON.stringify({ spec, cases: [{ id: "x", input: { ticket: 3 }, origin: "example" }], baseVersion: 2 }) })).status, 400);

    // The coding agent writes the copy it is given, read-only, and reports the version.
    assert.match((await me.tool("openmerit_tasks", {})).text, /eval classifier's eval is at version 2; the repository has no copy/);
    const files = await me.tool("openmerit_eval", { task_id: task!.id });
    const written = files.data.files as Record<string, string>;
    assert.deepEqual(Object.keys(written), [".openmerit/evals/eval-classifier/bundle.json", ".openmerit/evals/eval-classifier/cases.json", ".openmerit/evals/eval-classifier/eval.json", ".openmerit/evals/eval-classifier/MANAGED.md"]);
    assert.match(written[".openmerit/evals/eval-classifier/MANAGED.md"]!, /Do not edit these files/);
    assert.equal((JSON.parse(written[".openmerit/evals/eval-classifier/eval.json"]!) as { version: number }).version, 2);
    assert.deepEqual((JSON.parse(written[".openmerit/evals/eval-classifier/bundle.json"]!) as { criteria: string[] }).criteria, spec.criteria);
    assert.equal((JSON.parse(written[".openmerit/evals/eval-classifier/cases.json"]!) as Case[]).length, edited.length);
    assert.equal((await me.tool("openmerit_eval", { task_id: task!.id, action: "synced", version: 9 })).isError, true);
    assert.equal((await me.tool("openmerit_eval", { task_id: task!.id, action: "synced", version: 2 })).isError, false);
    assert.deepEqual((await me.api<EvalView>(`/api/tasks/${task!.id}/eval`)).body.repo!.version, 2);
    assert.doesNotMatch((await me.tool("openmerit_tasks", {})).text, /the repository has/);

    // The next run measures on version 2, asks nothing, and sends the app's criteria to the judge in place of the agent's.
    const callsBefore = models.calls.length;
    const second = await me.tool("openmerit_recommend", { bundle: bundle("eval classifier"), environment: "acme/app" });
    const again = await waitFor(result(second.data.job_id as string), value => finished(value) || value.data.status === "needs_input");
    assert.equal(again.data.status, "done", again.text);
    const report = (await me.api<{ failedCases: { caseId: string; reason: string }[]; cases: { total: number }; evalVersion: number }>(`/api/runs/${String(second.data.job_id)}`)).body;
    assert.equal(report.evalVersion, 2);
    assert.equal(report.cases.total, edited.filter(item => item.expected !== undefined && item.approved !== false).length, "the case the app dropped stays dropped");
    assert.deepEqual(report.failedCases.map(item => [item.caseId, item.reason]), [["example-7", "Answered billing, expected account."]], "the app's fixed answer is the one graded");
    assert.ok(!models.calls.slice(callsBefore).some(call => call.ticket.startsWith("writer:")), "no cases are written");
    assert.match(again.text, /used the criteria of eval version 2/);
    assert.deepEqual((await me.api<JobRow[]>("/api/runs")).body.map(item => item.evalVersion), [2, 1]);
    assert.equal((await me.api<EvalView>(`/api/tasks/${task!.id}/eval`)).body.latest!.version, 2, "an unchanged eval makes no version");

    // Deleting the task deletes its eval; the coding agent is asked about the repository copy until it answers.
    const deleted = await me.api(`/api/tasks/${task!.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await me.api(`/api/tasks/${task!.id}/eval`)).status, 404);
    const exported = JSON.stringify((await me.api<{ evals: unknown[] }>("/api/account/export", { method: "POST" })).body.evals);
    assert.equal(exported, "[]");
    const asked = await me.tool("openmerit_tasks", {});
    assert.match(asked.text, /eval classifier was deleted at .*; its eval copy at \.openmerit\/evals\/eval-classifier in acme\/app stays/);
    assert.equal((await me.tool("openmerit_eval", { task_id: task!.id, action: "removed" })).isError, false);
    assert.doesNotMatch((await me.tool("openmerit_tasks", {})).text, /eval copy/);
  });
});
