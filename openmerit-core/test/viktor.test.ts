// The Viktor connection against a fake Viktor: the key check, the listing and its skip reasons, the
// script-run polling, and the evaluation of a task's presets from graded test runs. Expected numbers
// are worked out by hand in the comments; no request leaves the process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Measurement } from "../src/engine/evaluate.ts";
import {
  batchMeasure, batchSpec, cheaperPresets, CLEANUP, draftedTools, viktorErrorSentence, judgeChecks, CREDIT_USD, estimateCredits, evaluateViktor, gradeRun, keyProblem, LIST, proposeChange, readTasks, REQUIRED_SCOPES, viktor, viktorClient,
  withArgs, writeChecks, WORK_DIR, WRITING_CHECKS, type BatchRun, type Check,
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

test("Viktor keeps only the last 64,000 characters of a script's stdout: runScript refuses cut output, and runScriptPaged reads all of it through a file", async () => {
  // A sandbox that runs the code it is sent with this machine's Python, under a temporary WORK_DIR,
  // and returns stdout as Viktor does: the end of it, flagged, when it passes 64,000 characters.
  const sandbox = mkdtempSync(join(tmpdir(), "viktor-sandbox-"));
  try {
    const fake = fakeViktor({ "/api/public/v1/scripts/runs": body => {
      const code = String((body as { code: string }).code).replaceAll(WORK_DIR, sandbox);
      const run = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", maxBuffer: 1 << 26 });
      const cut = run.stdout.length > 64_000;
      return { body: { id: "run_p", status: "completed", result: { exit_code: run.status, stdout: cut ? run.stdout.slice(-64_000) : run.stdout, stdout_truncated: cut, stderr: run.stderr } } };
    } });
    const client = viktorClient({ apiKey: "k", fetch: fake.fetcher, sleep: async () => {} });
    // A listing past the limit, with characters of 1 to 4 bytes so pages split inside one, printed after a log line.
    const listing = `# openmerit:list\nimport json, sys\nprint("listing")\nprint(json.dumps({"tasks": [{"id": str(i), "description": "Résumé € 🎫 " * 3000} for i in range(4)]}, ensure_ascii=False))\n`;
    await assert.rejects(client.runScript(listing), { code: "stdout_truncated", message: /^Viktor cut the listing's output at 64,000 characters \(script run run_p\), so OpenMerit did not read it\.$/ });
    const full = await client.runScriptPaged(listing, ["unused"], 60);
    const parsed = JSON.parse(full.trim().split("\n").at(-1)!) as { tasks: { id: string; description: string }[] };
    assert.equal(full.split("\n")[0], "listing");
    assert.deepEqual(parsed.tasks.map(task => [task.id, task.description.length]), [0, 1, 2, 3].map(i => [String(i), "Résumé € 🎫 ".length * 3000]));
    assert.ok(Buffer.byteLength(full) > 3 * 44_000, "the output took more than three pages");
    // Each page fits under the limit, and the last one deleted the output file.
    assert.ok(fake.requests.length >= 5);
    assert.deepEqual(readdirSync(join(sandbox, "out")), []);
    // An output of nothing reads as nothing.
    assert.equal(await client.runScriptPaged("# openmerit:read\nimport sys\n"), "");
    assert.ok(existsSync(join(sandbox, "out")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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
  assert.deepEqual(fake.requests[0]!.body, { code: withArgs("print(1)", ["a"]), args: [], timeout_seconds: 60, wait_seconds: 30 });

  const failing = fakeViktor({ "/api/public/v1/scripts/runs": () => ({ body: { id: "run_2", status: "completed", result: { exit_code: 1, stdout: "", stderr: "Traceback\n  line 3\nValueError: no such cron" } } }) });
  await assert.rejects(viktorClient({ apiKey: "k", fetch: failing.fetcher }).runScript("x"), /run_2 completed: Traceback +line 3 ValueError: no such cron/);

  // A workspace that makes tools wait for approval: the gateway saves each call as a draft, and the
  // script fails on the draft receipt. The error names the tools, whether or not the script failed.
  const stderr = "[tool-gateway] list_crons: draft created, not executed\n[tool-gateway] read_file: draft created, not executed\n[tool-gateway] list_crons: draft created, not executed\npydantic_core.ValidationError: 1 validation error";
  assert.deepEqual(draftedTools(stderr), ["list_crons", "read_file"]);
  assert.deepEqual(draftedTools("[tool-gateway] list_crons: executed"), []);
  const drafted = fakeViktor({ "/api/public/v1/scripts/runs": () => ({ body: { id: "run_3", status: "completed", result: { exit_code: 1, stdout: "", stderr } } }) });
  // A request validation error reads as a sentence, even cut short as a job records it; other errors have none.
  const refused = 'The job failed: Step "put" exhausted retries: ViktorError: Viktor POST /api/public/v1/scripts/runs: [{"type":"value_error","loc":["body","args"],"msg":"Value error, each arg may be at most 2000 characters","input":["/work","# openmerit:batch\\nimport asyn';
  assert.equal(viktorErrorSentence(refused), "Viktor refused the request: each script argument may be at most 2,000 characters.");
  assert.equal(viktorErrorSentence('[{"type":"missing","loc":["body","code"],"msg":"Field required"}]'), "Viktor refused the request: code: field required.");
  assert.equal(viktorErrorSentence("Viktor script run run_2 completed: ValueError: no such cron"), null);
  await assert.rejects(viktorClient({ apiKey: "k", fetch: drafted.fetcher }).runScript("x"), { code: "needs_approval", message: /calls to list_crons, read_file as drafts that wait for approval in chat, so they did not run/ });
});

test("script arguments travel in the code, since Viktor refuses one over 2,000 characters, and reach sys.argv unchanged", (t) => {
  const args = ["/work/temp/openmerit/job_1", `# openmerit:batch\nprint("it's \\ \"quoted\"")\n${"x".repeat(5000)}`, JSON.stringify({ description: "Classify — tickets 🎫 \u2028 then post to #check-this-out" })];
  const code = withArgs("# openmerit:read\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n", args);
  assert.match(code, /^# openmerit:read\n/, "the tag stays the first line");
  const python = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" });
  if (python.error) return t.skip("python3 is not installed");
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), args);
  assert.equal(withArgs("print(1)", []), "print(1)");
});

test("the listing keeps every task, says why the system, script, pre-run and pinned tasks are not evaluated, and puts the most credits first", () => {
  const cron = (path: string, title: string, model: string | null, extra: Record<string, unknown> = {}) => ({ id: `id${path}`, path, title, model, execution_type: "agent", cron: "0 9 * * 1", paused: false, description: `${title} instructions`, deleted: false, ...extra });
  const stdout = JSON.stringify({
    tasks: [
      cron("/heartbeat", "Heartbeat", null), cron("/memory_dreaming", "Memory Dreaming", "gpt-6-luna#ReasoningLevel:high"),
      cron("/daily_brief", "Daily brief", "smart"), cron("/ticket_triage", "Ticket triage", "balanced"),
      cron("/sync", "Sync", null, { execution_type: "script", script_path: "/work/sync.py" }), cron("/digest", "Digest", null),
      cron("/pinned", "Pinned", "claude-sonnet-5-5"), cron("/tiny", "Tiny", "cheap"), cron("/gone", "Gone", "smart", { deleted: true }),
      // A condition script only decides whether a run happens: evaluated. A pre-run script feeds the agent: skipped.
      cron("/cond", "Cond", "balanced", { condition_script_path: "/work/crons/cond/check.py" }), cron("/prerun", "Prerun", "smart", { pre_run_script_path: "/work/crons/prerun/gather.py" }),
      // OpenMerit's copies, with today's prefix and the one before 20 Nov 2026, under /openmerit/ only.
      cron("/openmerit/daily-brief-abc-cheap", "OpenMerit: Daily brief", "cheap"), cron("/openmerit/daily-brief-def-balanced", "[OpenMerit]: Daily brief", "balanced"),
      // A person's own tasks: titled like a copy but elsewhere, or under /openmerit/ with another title.
      cron("/u0cb2f8emqc/projects/zip/blog_review", "OpenMerit: Blog review", "smart-writing"), cron("/openmerit/notes", "Team notes", "balanced-writing"),
    ],
    defaultModel: "smart",
    usage: [
      { credits: 70, path: "/agent_runs/crons/daily_brief/2026-11-18T09-00-00" }, { credits: 66, path: "/agent_runs/crons/daily_brief/2026-11-17T09-00-00" },
      { credits: 300, path: "/agent_runs/crons/ticket_triage/2026-11-18T09-00-00" }, { credits: 536, path: "/agent_runs/crons/heartbeat/2026-11-18T09-00-00" },
      // A path that only starts like /daily_brief must not count for it.
      { credits: 9, path: "/agent_runs/crons/daily_brief_old/2026-11-01T09-00-00" },
    ],
  });
  const { tasks, leftovers } = readTasks(`some log line\n${stdout}\n`);
  assert.deepEqual(leftovers, ["/openmerit/daily-brief-abc-cheap", "/openmerit/daily-brief-def-balanced"]);
  assert.deepEqual(tasks.map(task => [task.title, task.credits30d, task.skipped]), [
    ["Heartbeat", 536, "Viktor's own task: it cannot be edited"],
    ["Ticket triage", 300, null],
    ["Daily brief", 136, null],
    ["Cond", 0, null],
    ["Digest", 0, null],
    ["Memory Dreaming", 0, "Viktor's own task: it cannot be edited"],
    ["OpenMerit: Blog review", 0, null],
    ["Pinned", 0, "uses claude-sonnet-5-5; only Viktor's presets (cheap, balanced, balanced-writing, smart, smart-writing, ultra) are compared for now"],
    ["Prerun", 0, "runs a pre-run script whose output the agent reads, which test mode does not capture"],
    ["Sync", 0, "script task, no model"],
    ["Team notes", 0, null],
    ["Tiny", 0, "already on cheap, the cheapest preset"],
  ]);
  assert.deepEqual(tasks.filter(task => task.conditionScript).map(task => task.title), ["Cond"]);
  const brief = tasks.find(task => task.title === "Daily brief")!;
  assert.equal(brief.runs30d, 2);
  // 68 credits per run on smart, against 70 measured: a scale of 68/70. smart + balanced + cheap = 70 + 19 + 4 = 93 credits per round,
  // so 93 × 68/70 = 90.34 per round, × 3 repeats = 271.03, + 90 for the thread = 361.03, rounded up.
  assert.equal(estimateCredits(brief, 3), 362);

  const { spec } = batchSpec("job_20261119_abcdef123456", brief, 3);
  assert.deepEqual([spec.models, spec.inherit], [["smart", "balanced", "cheap"], false]);
  // Copies always get today's prefix, even of a task whose own title starts with the old one.
  assert.equal(spec.copyTitle, "[OpenMerit]: Daily brief");
  assert.equal(batchSpec("job_1", tasks.find(task => task.title === "OpenMerit: Blog review")!, 3).spec.copyTitle, "[OpenMerit]: OpenMerit: Blog review");
  assert.equal(spec.copyPath, "/openmerit/daily-brief-ef123456-");

  // A task with no model runs the workspace's default, smart: the smart ladder, with its baseline copy's model left unset.
  const digest = tasks.find(task => task.title === "Digest")!;
  assert.deepEqual([digest.model, digest.defaultModel], [null, "smart"]);
  assert.deepEqual([batchSpec("job_1", digest, 3).spec.models, batchSpec("job_1", digest, 3).spec.inherit], [["smart", "balanced", "cheap"], true]);
  assert.equal(proposeChange(digest, { model: "cheap" }).change, "Set Digest from Team default (smart) to cheap");
  assert.equal(proposeChange(brief, { model: "cheap" }).change, "Set Daily brief to cheap");
  // A default OpenMerit could not read, or one that is not a preset, skips the task with why.
  const unread = readTasks(JSON.stringify({ tasks: [cron("/digest", "Digest", null)], usage: [] })).tasks[0]!;
  assert.equal(unread.skipped, "uses the workspace's default model, which OpenMerit could not read");
  const pinned = readTasks(JSON.stringify({ tasks: [cron("/digest", "Digest", null)], usage: [], defaultModel: "gpt-6-luna" })).tasks[0]!;
  assert.equal(pinned.skipped, "uses the workspace's default model, gpt-6-luna, which is not one of Viktor's presets");

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

test("a writing task is compared against the cheaper writing preset and the plain presets, and its estimate counts every one", () => {
  assert.deepEqual(cheaperPresets("smart-writing"), ["cheap", "balanced", "balanced-writing"]);
  assert.deepEqual(cheaperPresets("balanced-writing"), ["cheap", "balanced"]);
  assert.deepEqual(cheaperPresets("smart"), ["cheap", "balanced"]);
  const blog = { path: "/u0cb2f8emqc/projects/zip/blog_review", title: "OpenMerit: Blog review", model: "smart-writing", credits30d: 0, runs30d: 0 };
  const { spec } = batchSpec("job_20261120_abcdef123456", blog, 3);
  assert.deepEqual(spec.models, ["smart-writing", "balanced-writing", "balanced", "cheap"]);
  // 4 presets × 3 runs = 12 test runs: 3 × (81 + 25 + 19 + 4) = 387, + 90 for the thread = 477.
  assert.equal(spec.models.length * spec.repeats, 12);
  assert.equal(estimateCredits(blog, 3), 477);
  // balanced-writing: 3 × (25 + 19 + 4) = 144, + 90 = 234.
  assert.equal(estimateCredits({ ...blog, model: "balanced-writing" }, 3), 234);
});

test("the judge adds writing checks for a task on a writing preset, and only then", async () => {
  const systems: string[] = [];
  const complete = async (request: { system?: string }) => { systems.push(request.system ?? ""); return JSON.stringify({ checks: ["a", "b", "c"] }); };
  const reference = run("smart-writing", 1);
  await writeChecks(complete, { title: "Blog review", description: "Write for customers in a warm tone.", model: "smart-writing" }, reference);
  await writeChecks(complete, { title: "Digest", description: "…", model: null, defaultModel: "smart" }, reference);
  await writeChecks(complete, { title: "Notes", description: "…", model: "balanced-writing" }, reference);
  assert.deepEqual(systems.map(system => system.includes(WRITING_CHECKS)), [true, false, true]);
  assert.match(WRITING_CHECKS, /audience, the tone, the voice and the format/);
  assert.match(WRITING_CHECKS, /do not invent a brand voice/);
});

test("a smart-writing task can move to a plain preset when the judge passes it on every check", async () => {
  const models = ["smart-writing", "balanced-writing", "balanced", "cheap"];
  const runs = models.flatMap(model => [1, 2, 3].map(repeat => run(model, repeat)));
  // cheap misses the tone check (c3) every run; balanced passes everything for 19 credits a run; balanced-writing does too, for 25.
  const { result } = await evaluateViktor({
    task: { model: "smart-writing" }, checks, runs, repeats: 3, sample,
    graded: new Map([["smart-writing", [graded(81), graded(81), graded(81)]], ["balanced-writing", [graded(25), graded(25), graded(25)]], ["balanced", [graded(19), graded(19), graded(19)]], ["cheap", [graded(4, ["c3"]), graded(4, ["c3"]), graded(4, ["c3"])]]]),
  });
  assert.equal(result.pick?.model, "balanced");
  assert.equal(result.candidates.find(item => item.model === "cheap")?.qualified, false);
});

/** Runs one of the connection's Python scripts against a fake Viktor SDK holding `crons`; returns its output and the crons it deleted. */
function runPython(t: { skip: (message: string) => void }, code: string, args: string[], crons: { path: string; title: string; model?: string | null }[]) {
  const root = mkdtempSync(join(tmpdir(), "viktor-sdk-"));
  try {
    mkdirSync(join(root, "sdk", "tools"), { recursive: true });
    writeFileSync(join(root, "sdk", "__init__.py"), "");
    writeFileSync(join(root, "sdk", "tools", "__init__.py"), "");
    writeFileSync(join(root, "sdk", "tools", "scheduled_crons.py"), [
      "import json, os", "from types import SimpleNamespace",
      `CRONS = json.loads(${JSON.stringify(JSON.stringify(crons))})`,
      "class Cron(SimpleNamespace):", "    def model_dump(self): return dict(vars(self))",
      "async def list_crons(**kw): return SimpleNamespace(crons=[Cron(**c) for c in CRONS])",
      "async def delete_cron(path): open(os.environ['DELETED'], 'a').write(path + '\\n')",
    ].join("\n"));
    writeFileSync(join(root, "sdk", "tools", "account_tools.py"), [
      "from types import SimpleNamespace",
      "async def get_usage_threads(**kw): return SimpleNamespace(threads=[])",
      "async def get_workspace_settings(): return SimpleNamespace(model_dump=lambda: {'default_agent_model': 'smart', 'fast_model_option': 'balanced'})",
    ].join("\n"));
    const deleted = join(root, "deleted.txt");
    writeFileSync(deleted, "");
    const python = spawnSync("python3", ["-c", withArgs(code, args)], { encoding: "utf8", cwd: root, env: { ...process.env, PYTHONPATH: root, DELETED: deleted } });
    if (python.error) { t.skip("python3 is not installed"); return null; }
    assert.equal(python.status, 0, python.stderr);
    return { stdout: python.stdout, deleted: readFileSync(deleted, "utf8").split("\n").filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("CLEANUP deletes OpenMerit's copies with either prefix under /openmerit/, and never a person's task titled like one", (t) => {
  const crons = [
    { path: "/openmerit/brief-abc-cheap", title: "[OpenMerit]: Daily brief" }, { path: "/openmerit/brief-def-cheap", title: "OpenMerit: Daily brief" },
    { path: "/openmerit/notes", title: "Team notes" },
    { path: "/u0cb2f8emqc/projects/zip/blog_review", title: "OpenMerit: Blog review" }, { path: "/u0cb2f8emqc/projects/zip/intake", title: "[OpenMerit]: Content intake" },
  ];
  const out = runPython(t, CLEANUP, ["/openmerit/"], crons);
  if (!out) return;
  assert.deepEqual(out.deleted, ["/openmerit/brief-abc-cheap", "/openmerit/brief-def-cheap"]);
  assert.deepEqual(JSON.parse(out.stdout).deleted, out.deleted);
  // A job's own prefix deletes only that job's copies.
  assert.deepEqual(runPython(t, CLEANUP, ["/openmerit/brief-def-"], crons)?.deleted, ["/openmerit/brief-def-cheap"]);
});

test("LIST reads the workspace's default model once, so a task with none shows it", (t) => {
  const out = runPython(t, LIST, [], [{ path: "/digest", title: "Digest", model: null }]);
  if (!out) return;
  const digest = readTasks(out.stdout).tasks[0]!;
  assert.deepEqual([digest.model, digest.defaultModel, digest.skipped], [null, "smart", null]);
});
