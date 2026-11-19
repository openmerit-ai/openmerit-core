// The Viktor connection against a fake Viktor: the key check, the listing and its skip reasons, the
// script-run polling, and the evaluation of a task's presets from graded test runs. Expected numbers
// are worked out by hand in the comments; no request leaves the process.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Measurement } from "../src/engine/evaluate.ts";
import {
  batchMeasure, batchSpec, judgeChecks, CREDIT_USD, estimateCredits, evaluateViktor, gradeRun, keyProblem, proposeChange, readTasks, REQUIRED_SCOPES, viktor, viktorClient,
  type BatchRun, type Check,
} from "../src/connectors/viktor/index.ts";

/** A fake Viktor API: answers by path, and records every request. */
function fakeViktor(routes: Record<string, (body: unknown, calls: number) => { status?: number; body: unknown }>) {
  const requests: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const counts = new Map<string, number>();
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    requests.push({ method: String(init?.method ?? "GET"), path, body, auth: new Headers(init?.headers).get("authorization") });
    const route = Object.entries(routes).find(([pattern]) => new RegExp(`^${pattern}$`).test(path));
    if (!route) return new Response(JSON.stringify({ detail: { error: "not_found", message: "no route" } }), { status: 404 });
    const count = (counts.get(route[0]) ?? 0) + 1;
    counts.set(route[0], count);
    const answer = route[1](body, count);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetcher, requests };
}

test("a key connects only with every scope the connection needs, and a refused key says Viktor needs a paid plan", async () => {
  const all = fakeViktor({ "/api/public/v1/me": () => ({ body: { key_type: "personal", team_id: "team_1", key_preview: "zt_live_sk_…eZnk", scopes: [...REQUIRED_SCOPES, "chat:completions"] } }) });
  const ok = await keyProblem(viktorClient({ apiKey: "zt_live_sk_test", fetch: all.fetcher }));
  assert.ok("key" in ok && ok.key.teamId === "team_1");
  assert.equal(all.requests[0]!.auth, "Bearer zt_live_sk_test");

  const partial = fakeViktor({ "/api/public/v1/me": () => ({ body: { scopes: REQUIRED_SCOPES.filter(scope => scope !== "scripts:execute" && scope !== "runs:read") } }) });
  const missing = await keyProblem(viktorClient({ apiKey: "k", fetch: partial.fetcher }));
  assert.ok("problem" in missing);
  assert.match(missing.problem, /missing the scopes scripts:execute, runs:read\b/);

  const refused = fakeViktor({ "/api/public/v1/me": () => ({ status: 401, body: { detail: { error: "invalid_api_key", message: "Missing or invalid API key" } } }) });
  const unpaid = await keyProblem(viktorClient({ apiKey: "k", fetch: refused.fetcher }));
  assert.ok("problem" in unpaid);
  assert.match(unpaid.problem, /paid or Enterprise plan/);
});

test("a script run is polled until it ends, and a failed one throws with its last stderr lines", async () => {
  const fake = fakeViktor({
    "/api/public/v1/scripts/runs": () => ({ body: { id: "run_1", status: "queued", result: null } }),
    // Running on the first poll, done on the second.
    "/api/public/v1/scripts/runs/run_1": (_body, calls) => ({ body: calls < 2 ? { id: "run_1", status: "in_progress", result: null } : { id: "run_1", status: "completed", result: { exit_code: 0, stdout: "{\"ok\": true}\n" } } }),
  });
  const client = viktorClient({ apiKey: "k", fetch: fake.fetcher, sleep: async () => {} });
  assert.equal(await client.runScript("print(1)", ["a"], 60), "{\"ok\": true}\n");
  assert.deepEqual(fake.requests.map(request => `${request.method} ${request.path}`), ["POST /api/public/v1/scripts/runs", "GET /api/public/v1/scripts/runs/run_1", "GET /api/public/v1/scripts/runs/run_1"]);
  assert.deepEqual(fake.requests[0]!.body, { code: "print(1)", args: ["a"], timeout_seconds: 60, wait_seconds: 30 });

  const failing = fakeViktor({ "/api/public/v1/scripts/runs": () => ({ body: { id: "run_2", status: "completed", result: { exit_code: 1, stdout: "", stderr: "Traceback\n  line 3\nValueError: no such cron" } } }) });
  await assert.rejects(viktorClient({ apiKey: "k", fetch: failing.fetcher }).runScript("x"), /run_2 completed: Traceback +line 3 ValueError: no such cron/);
});

test("the listing keeps every task, says why the system, script and default-model tasks are not evaluated, and puts the most credits first", () => {
  const cron = (path: string, title: string, model: string | null, extra: Record<string, unknown> = {}) => ({ id: `id${path}`, path, title, model, execution_type: "agent", cron: "0 9 * * 1", paused: false, description: `${title} instructions`, deleted: false, ...extra });
  const stdout = JSON.stringify({
    tasks: [
      cron("/heartbeat", "Heartbeat", null), cron("/memory_dreaming", "Memory Dreaming", "gpt-6-luna#ReasoningLevel:high"),
      cron("/daily_brief", "Daily brief", "smart"), cron("/ticket_triage", "Ticket triage", "balanced"),
      cron("/sync", "Sync", null, { execution_type: "script", script_path: "/work/sync.py" }), cron("/digest", "Digest", null),
      cron("/pinned", "Pinned", "claude-sonnet-5-5"), cron("/tiny", "Tiny", "cheap"), cron("/gone", "Gone", "smart", { deleted: true }),
      cron("/openmerit/daily-brief-abc-cheap", "OpenMerit: Daily brief", "cheap"),
    ],
    usage: [
      { credits: 70, path: "/agent_runs/crons/daily_brief/2026-11-18T09-00-00" }, { credits: 66, path: "/agent_runs/crons/daily_brief/2026-11-17T09-00-00" },
      { credits: 300, path: "/agent_runs/crons/ticket_triage/2026-11-18T09-00-00" }, { credits: 536, path: "/agent_runs/crons/heartbeat/2026-11-18T09-00-00" },
      // A path that only starts like /daily_brief must not count for it.
      { credits: 9, path: "/agent_runs/crons/daily_brief_old/2026-11-01T09-00-00" },
    ],
  });
  const { tasks, leftovers } = readTasks(`some log line\n${stdout}\n`);
  assert.deepEqual(leftovers, ["/openmerit/daily-brief-abc-cheap"]);
  assert.deepEqual(tasks.map(task => [task.title, task.credits30d, task.skipped]), [
    ["Heartbeat", 536, "Viktor's own task: it cannot be edited"],
    ["Ticket triage", 300, null],
    ["Daily brief", 136, null],
    ["Digest", 0, "uses the workspace's default model: set a preset on it in Viktor to evaluate it"],
    ["Memory Dreaming", 0, "Viktor's own task: it cannot be edited"],
    ["Pinned", 0, "uses claude-sonnet-5-5; only Viktor's presets (cheap, balanced, smart, ultra) are compared for now"],
    ["Sync", 0, "script task, no model"],
    ["Tiny", 0, "already on cheap, the cheapest preset"],
  ]);
  const brief = tasks.find(task => task.title === "Daily brief")!;
  assert.equal(brief.runs30d, 2);
  // 68 credits per run on smart, against 70 assumed: a scale of 68/70. smart + balanced + cheap = 70 + 20 + 4 = 94 assumed credits per round,
  // so 94 × 68/70 = 91.31 per round, × 3 repeats = 273.94, + 90 for the thread = 363.94, rounded up.
  assert.equal(estimateCredits(brief, 3), 364);

  const { spec } = batchSpec("job_20261119_abcdef123456", brief, 3);
  assert.deepEqual(spec.models, ["smart", "balanced", "cheap"]);
  assert.equal(spec.copyTitle, "OpenMerit: Daily brief");
  assert.equal(spec.copyPath, "/openmerit/daily-brief-ef123456-");

  const connection = viktor({ tasks });
  assert.deepEqual(connection.capabilities, ["list", "evidence", "measure", "change"]);
  assert.equal(connection.writes, false);
  assert.deepEqual(connection.evidence(brief.id).priority?.map(item => item.value), [{ kind: "spend", usdPerMonth: 136 * CREDIT_USD }]);
});

const checks: Check[] = ["c1", "c2", "c3", "c4", "c5"].map(id => ({ id, check: `requirement ${id}` }));
const run = (model: string, repeat: number, status = "success"): BatchRun => ({ model, repeat, status, error: status === "success" ? null : "timed out", report: status === "success" ? "done" : null, runModel: model, threadId: `${model}-${repeat}`, actions: [], seconds: 10 });
/** A run that passes every check but `fails`, at `credits` for the run. */
const graded = (credits: number, fails: string[] = []): Measurement => ({ items: Object.fromEntries(checks.map(check => [check.id, !fails.includes(check.id)])), costUsd: credits * CREDIT_USD, latencyMs: 10_000 });
const sample = (reliable: readonly string[], count: number) => reliable.slice(0, count);

test("a task on smart moves to the cheapest preset that passes every check the current model passes, and one check short is a near miss", async () => {
  const runs = ["smart", "balanced", "cheap"].flatMap(model => [1, 2, 3].map(repeat => run(model, repeat)));
  // smart passes 15/15 at 70 credits a run. balanced misses c4 in its second run, 14/15. cheap passes 15/15 at 4 credits a run.
  const { evaluated, result } = await evaluateViktor({
    task: { model: "smart" }, checks, runs, repeats: 3, sample,
    graded: new Map([["smart", [graded(70), graded(70), graded(70)]], ["balanced", [graded(20), graded(20, ["c4"]), graded(20)]], ["cheap", [graded(4), graded(4), graded(4)]]]),
  });
  assert.equal(evaluated.status, "ranked");
  assert.deepEqual([result.baseline.passes, result.baseline.total], [15, 15]);
  // Per check run: smart 70 × $0.0025 / 5 = $0.035; cheap 4 × $0.0025 / 5 = $0.002.
  assert.ok(Math.abs(result.baseline.costPerItemUsd! - 0.035) < 1e-12);
  assert.equal(result.pick?.model, "cheap");
  assert.ok(Math.abs(result.pick!.costPerItemUsd! - 0.002) < 1e-12);
  assert.deepEqual(result.top.map(item => item.model), ["cheap"]);
  // balanced missed 1 of 15: (1 − 14/15) × 5 checks = 1/3 of a check per run, within the one-item bar.
  assert.deepEqual(result.nearMisses.map(item => [item.model, item.passes, item.total]), [["balanced", 14, 15]]);
  assert.deepEqual(proposeChange({ title: "Daily brief" }, result.pick!).change, "Set Daily brief to cheap");
});

test("when cheap misses a check every time, balanced is the pick; a preset whose runs all failed is unavailable, not a pass", async () => {
  const runs = ["smart", "balanced", "cheap"].flatMap(model => [1, 2, 3].map(repeat => run(model, repeat)));
  const { result } = await evaluateViktor({
    task: { model: "smart" }, checks, runs, repeats: 3, sample,
    graded: new Map([["smart", [graded(70), graded(70), graded(70)]], ["balanced", [graded(20), graded(20), graded(20)]], ["cheap", [graded(4, ["c2"]), graded(4, ["c2"]), graded(4, ["c2"])]]]),
  });
  assert.equal(result.pick?.model, "balanced");
  // cheap fails c2, a sample, so it is screened out on its first run: 4/5.
  const cheap = result.candidates.find(item => item.model === "cheap")!;
  assert.deepEqual([cheap.status, cheap.passes, cheap.total], ["screened_out", 4, 5]);

  const measure = batchMeasure(new Map([["smart", [graded(70)]], ["cheap", []]]), [run("smart", 1), run("cheap", 1, "timed_out")], "smart");
  await assert.rejects(measure({ key: "cheap", model: "cheap", price: 4 }, null, { repeat: 1 }), (error: Error) => error.name === "CandidateUnavailable" && /every test run on cheap failed: timed out/.test(error.message));
  assert.ok(await measure(null, null, { repeat: 1 }));
});

test("a run that did not finish fails every check without asking the judge", async () => {
  let asked = 0;
  const measured = await gradeRun(run("cheap", 1, "timed_out"), checks, async () => { asked++; return {}; }, 4);
  assert.equal(asked, 0);
  assert.deepEqual(Object.values(measured.items), [false, false, false, false, false]);
  assert.equal(measured.costUsd, 4 * CREDIT_USD);
  const passed = await gradeRun(run("cheap", 1), checks, async list => Object.fromEntries(list.map(check => [check.id, check.id !== "c3"])), null);
  assert.deepEqual(measured.latencyMs, 10_000);
  assert.deepEqual(Object.entries(passed.items).filter(([, pass]) => !pass).map(([id]) => id), ["c3"]);
  assert.equal(passed.costUsd, null);

  // The judge must grade every check; one it leaves out fails the run's grading instead of passing or failing silently.
  const judged = judgeChecks(async () => '{"c1": true, "c2": false, "c3": true, "c4": true}', { title: "Daily brief", description: "…" }, run("smart", 1));
  await assert.rejects(judged(checks, run("cheap", 1)), /left c5 ungraded for cheap run 1/);
});
