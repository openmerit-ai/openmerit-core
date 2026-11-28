// Jobs that recover: a step replayed after a crash, an actor a deploy's drain stops, a step that fails
// for good and a start that fails after the account recorded it. The app runs in a child process so a
// test can SIGKILL it mid-job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "rivetkit/client";
import type { Registry } from "../../src/server/registry.ts";
import { evaluateTask, trialOption } from "../../src/server/engine.ts";
import { buildPool } from "../../src/job/pool.ts";
import type { TaskBundle } from "../../src/ranking/index.ts";
import { bundle, caller, CLERK, costOf, crash, fakeModels, startApp, stop, subscribe, sum, untilDone, waitFor, writerCalls, WEAK_BELOW, WRITTEN, TICKETS, catalogue, type Data, type Result } from "./helpers.ts";

/**
 * What the job's policy does with the fake's answers: the grading trial (trialOption) and then openmerit/engine's
 * evaluateTask over the pool the job builds, three runs of the bundle's six labelled examples and both written
 * cases, with a measure that passes a model on every case unless the fake answers it wrongly. The search reads
 * the trial's runs back: the current model's, and its first screen of a model the trial ran. Returns the model calls it
 * makes, what they cost, and its Top 3, which the job must match.
 */
async function cliPolicy(task: string) {
  const pool = buildPool({ catalogue, endpoints: [{ id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.test/v1", allowedModels: "all", funding: "openmerit" }], bundle: bundle(task, false) as TaskBundle, guardrails: {} });
  const cases = [...Object.keys(TICKETS).slice(0, 6), ...Object.keys(WRITTEN)];
  let calls = 0, spend = 0;
  const strongModel = (model: string) => (catalogue.models.find(item => item.id === model)?.eci ?? 200) >= WEAK_BELOW;
  const tried = new Set<string>();
  // The current model passes every case in the fake, so the trial moves down until a model fails one.
  await trialOption(pool.ranked, async option => { calls += cases.length; spend += cases.length * costOf(option.model); tried.add(option.key); return !strongModel(option.model); });
  const evaluated = await evaluateTask({
    ladder: pool.ranked, unplaced: pool.unplaced, strength: item => item.eci ?? -Infinity, items: cases, repeats: 3, baselinePrice: pool.baseline!.price,
    measure: async (option, items, call) => {
      const model = (option ?? pool.baseline!).model, ids = items ?? cases;
      if (!(option && tried.has(option.key) && call.role === "screen" && call.repeat === 1)) { calls += ids.length; spend += ids.length * costOf(model); }
      const strong = strongModel(model);
      return { items: Object.fromEntries(ids.map(id => [id, strong])), costUsd: ids.length * costOf(model) };
    },
    sample: reliable => reliable.slice(0, 5),
  });
  return { calls, spend, top: evaluated.top.map(item => [item.option.model, item.passes, item.total]) };
}

test("a measure step replayed after a crash does not count its spend twice", async () => {
  const models = await fakeModels();
  let app = await startApp({ models, env: CLERK });
  try {
    await subscribe(app, "org_replay");
    const agent = () => caller(app, "test:user_s:org_replay:admin");
    // The fourth measured call is in the current model's first trial step, sent with three others, some of them settled. Then the node dies.
    let crashed: Promise<void> | null = null;
    models.onCall = async () => { if (models.calls.filter(call => !call.ticket.startsWith("writer:")).length === 4) { models.onCall = null; crashed = crash(app); await crashed; } };
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("replayed classifier", false) });
    const jobId = started.data.job_id as string;
    await waitFor(async () => crashed, value => value !== null, 60_000);
    await crashed;
    app = await startApp({ models, env: app.env, storage: app.storage, enginePort: app.enginePort });
    const done = await untilDone(agent(), jobId);
    assert.equal(done.data.status, "done", done.text);

    const expected = await cliPolicy("replayed classifier");
    const measuring = models.calls.filter(call => !call.ticket.startsWith("writer:")).length;
    assert.ok(measuring > expected.calls, `the step must have been replayed: ${measuring} calls sent, ${expected.calls} in the policy`);
    type Row = { key: string; job_id: string; model: string };
    const ledger = (await agent().api<{ ledger: Row[] }>("/api/account/export", { method: "POST" })).body.ledger.filter(row => row.job_id === jobId && !row.key.startsWith(`${jobId}/cases/`));
    assert.equal(ledger.length, expected.calls, "one ledger row per call the policy makes: the replayed step reused its keys");
    // The current model ran every case three times, each run its own step with its own keys.
    const report = (await agent().api<{ baseline: { passes: number; total: number }; top: { model: string; passes: number; total: number }[] }>(`/api/runs/${jobId}`)).body;
    assert.deepEqual([report.baseline.passes, report.baseline.total], [24, 24]);
    assert.equal(new Set(ledger.filter(row => row.model === "openai/gpt-5.4").map(row => row.key.split("/")[1])).size, 3);
    const spend = (done.data.result as Result).spend;
    const writing = sum(writerCalls(models).map(call => costOf(call.model)));
    assert.ok(Math.abs(spend.openmeritUsd - (expected.spend + writing)) < 1e-9, `spend ${spend.openmeritUsd} counts each of the ${expected.calls} calls once (${expected.spend + writing})`);
    assert.deepEqual(report.top.map(item => [item.model, item.passes, item.total]), expected.top, "the job's Top 3 is the one the CLI's policy gives for the same answers");
    const period = await agent().api<{ openmeritUsd: number }>("/api/spend");
    assert.ok(Math.abs(period.body.openmeritUsd - spend.openmeritUsd) < 1e-9);
  } finally { await stop(app); await models.close(); }
});

test("a job whose actor a deploy's drain stops in the middle of a measure step resumes on the new version, and counts each call once", async () => {
  const models = await fakeModels();
  // A deploy starts the new version next to the old one; the engine drains the old one and moves its actors.
  const first = await startApp({ models, env: { ...CLERK, RIVET_NODE_VERSION: "1" } });
  let app = first;
  let release = () => {};
  try {
    await subscribe(app, "org_drain");
    const agent = () => caller(app, "test:user_d:org_drain:admin");
    // Hold the thirtieth model call, past the current model's three trial runs of 8 cases, in the trial's cheaper model, until the new version has taken the job.
    let held = false, reached!: () => void;
    const reachedHold = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    models.onCall = async () => {
      if (held || models.calls.filter(call => !call.ticket.startsWith("writer:")).length < 30) return;
      held = true; reached(); await gate;
    };
    const started = await agent().tool("openmerit_recommend", { bundle: bundle("drained classifier", false), environment: "acme/drain" });
    const jobId = started.data.job_id as string;
    await reachedHold;
    app = await startApp({ models, env: { ...first.env, RIVET_NODE_VERSION: "2" }, storage: first.storage, enginePort: first.enginePort });
    const done = await untilDone(agent(), jobId);
    release();
    assert.equal(done.data.status, "done", done.text);
    assert.equal((done.data.result as Result).status, "picked");
    const expected = await cliPolicy("drained classifier");
    const sent = models.calls.filter(call => !call.ticket.startsWith("writer:")).length;
    assert.ok(sent > expected.calls, `the interrupted step must have run again: ${sent} calls sent, ${expected.calls} in the policy`);
    // One ledger row per call the policy makes: the step that ran again reused its keys. A call the drain cut off counts at its
    // reservation (the provider may have billed it), and every other call at what it cost.
    const ledger = (await agent().api<{ ledger: { key: string; job_id: string; model: string; status: string; reserved_usd: number; actual_usd: number | null; failed: number }[] }>("/api/account/export", { method: "POST" })).body.ledger.filter(row => row.job_id === jobId);
    assert.equal(ledger.length, expected.calls + writerCalls(models).length);
    const cutOff = ledger.filter(row => row.failed && row.actual_usd === null);
    assert.ok(cutOff.length >= 1 && cutOff.length <= 4, `the held call and at most the others in flight with it: ${cutOff.length}`);
    const counted = expected.spend + sum(writerCalls(models).map(call => costOf(call.model))) + cutOff.reduce((total, row) => total + row.reserved_usd - costOf(row.model), 0);
    const spend = (done.data.result as Result).spend;
    assert.ok(Math.abs(spend.openmeritUsd - counted) < 1e-9, `spend ${spend.openmeritUsd} counts each call once (${counted})`);
  } finally {
    release();
    if (first !== app) first.child.kill("SIGKILL");
    await stop(app); await models.close();
  }
});

test("a job whose step fails for good ends failed with a report of what it measured, is not charged, and no longer says running", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { ...CLERK, TEST_AGENT_EVAL: "broken" } });
  try {
    await subscribe(app, "org_broken");
    const agent = caller(app, "test:user_b:org_broken:admin");
    const started = await agent.tool("openmerit_recommend", { bundle: bundle("broken agent classifier", false), environment: "acme/broken", agent: "support-bot" });
    const jobId = started.data.job_id as string;
    const ended = await untilDone(agent, jobId);
    assert.equal(ended.data.status, "failed", ended.text);
    assert.equal(ended.isError, true);
    assert.match(String(ended.data.error), /agent-1.*the agent's eval harness is unreachable/);
    assert.doesNotMatch(ended.text, /call openmerit_result again later/);
    const report = (await agent.api<{ status: string; baseline: { passes: number } | null; candidates: unknown[]; notices: string[] }>(`/api/runs/${jobId}`)).body;
    assert.equal(report.status, "failed");
    assert.ok(report.baseline && report.candidates.length > 0, "the report keeps the measurements so far");
    assert.ok(report.notices.some(notice => notice.startsWith("The job failed and stopped measuring")), report.notices.join("\n"));
    assert.equal((await agent.fetch(`/api/r/${jobId}.md`)).status, 200);
    const me = (await agent.api<{ plan: { usedEvals: number } }>("/api/me")).body;
    assert.equal(me.plan.usedEvals, 0, "a failed job is not charged an evaluation");
  } finally { await stop(app); await models.close(); }
});

test("a job whose start fails after the account recorded it is marked failed, and deleting its task settles one an earlier failed start left queued", async () => {
  const models = await fakeModels();
  const app = await startApp({ models, env: { TEST_CATALOGUE: "broken", OPENMERIT_ORPHAN_AFTER_MS: "2000" } });
  try {
    await subscribe(app, "org_orphan");
    const agent = caller(app, "test:user_o:org_orphan:admin:1");
    const rivet = createClient<Registry>({ endpoint: `http://127.0.0.1:${app.enginePort}`, token: "test-token" });
    type Run = { id: string; taskId: string; status: string };
    const runs = async () => (await agent.api<Run[]>("/api/runs")).body;

    // A task with a job that waits for answers, which a delete does not wait for.
    const first = await agent.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/support" });
    await waitFor(() => agent.tool("openmerit_result", { job_id: first.data.job_id }), value => value.data.status === "needs_input");
    const [task] = (await agent.api<{ id: string }[]>("/api/tasks")).body;
    // What a start that failed in an outage left before startJob caught it: the account's row and no job actor.
    const orphan = "job_20261124_0rphan000001";
    assert.equal((await rivet.account.getOrCreate(["org_orphan"]).startJob({ jobId: orphan, projectId: "default", taskId: task!.id, kind: "run", askedBy: null })).ok, true);
    assert.equal((await runs()).find(run => run.id === orphan)?.status, "queued");
    await new Promise(resolve => setTimeout(resolve, 2_500));
    const deleted = await agent.api<Data>(`/api/tasks/${task!.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(await runs(), []);

    // A start that fails after the account recorded the job: on a catalogue with no models, picking a provisional model throws.
    // The refresh saves it, then fails to compare its missing models with the last catalogue's.
    await assert.rejects(rivet.catalogue.getOrCreate(["global"]).refresh());
    const failed = await agent.tool("openmerit_recommend", { bundle: bundle("reply router"), environment: "acme/support" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /OpenMerit could not start the job \(.*\)\. Nothing was charged: try again\./);
    assert.deepEqual((await runs()).map(run => run.status), ["failed"], "the job is not left queued");
    assert.equal((await agent.api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals, 0, "a job that never started is not charged an evaluation");
  } finally { await stop(app); await models.close(); }
});
