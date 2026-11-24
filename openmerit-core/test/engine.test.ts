// The shared engine's contract (`openmerit/engine`): the search over a ladder without ECI, ledger
// idempotency on both implementations, the guardrail resolver, the agent-eval rule, the quality rule
// over a task's evidence and the approval record.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approve, basedOn, binarySearch, CRITERIA_PASS_RATE, EVAL_FLOOR, meetsCriteria, challengers, checkAgent, evaluateTask, stableSample, mergeEvidence, MemoryLedger, proposeEdit, strongest, taskResult, type EvidencePart, type CatalogueModel, resolveGuardrails, type AgentRun, type Ledger, type MeasureCall, type Rung } from "../src/engine/index.ts";
import { State } from "../src/state/db.ts";

test("the search keeps a ladder's own order, and unplaced options are always challengers", async () => {
  // Vendor tiers: no ECI, and an order that is neither alphabetical nor by price.
  const tiers: Rung[] = [{ key: "small", price: 1 }, { key: "medium", price: 5 }, { key: "large", price: 2 }, { key: "xl", price: 20 }];
  const passing = new Set(["medium", "large", "xl"]);
  const searched = await binarySearch(tiers, async tier => passing.has(tier.key), 1);
  assert.equal(searched.selected?.key, "medium");
  const tried = new Set(searched.trials.map(trial => trial.candidate.key));
  const fineTune: Rung = { key: "acme/fraud-ft", price: null };
  assert.deepEqual(challengers(tiers, searched.selected!, tried, { unplaced: [fineTune] }).map(item => item.key), ["large", "acme/fraud-ft"]);
  assert.deepEqual(challengers(tiers, { key: "unpriced", price: null }, tried, { unplaced: [fineTune] }).map(item => item.key), ["acme/fraud-ft"]);
});

test("challengers are capped at the leader's list price, or at the ceiling the caller passes", () => {
  // Weakest first. The leader is cheap by list price; "between" is stronger and priced between the leader and the current model.
  const ladder: Rung[] = [{ key: "leader", price: 1 }, { key: "cheap-strong", price: 0.5 }, { key: "between", price: 3 }, { key: "dear", price: 6 }];
  const leader = ladder[0]!, tried = new Set(["leader"]);
  assert.deepEqual(challengers(ladder, leader, tried).map(item => item.key), ["cheap-strong"]);
  assert.deepEqual(challengers(ladder, leader, tried, { maxPrice: 4 }).map(item => item.key), ["cheap-strong", "between"]);
  assert.deepEqual(challengers(ladder, leader, tried, { maxPrice: 4, count: 1 }).map(item => item.key), ["cheap-strong"], "still cheapest first, and at most count");
});

test("three repeats keep a verdict that one run leaves to chance, when the current model and a candidate are both flaky on one item", async () => {
  // Ten items. The current model and the candidate each fail item i10 in one of every three runs; `seed` sets which run.
  // One run: seed 1 fails only the candidate (10/10 against 9/10), seed 2 only the current model (9/10 against 10/10), and
  // seed 0 neither. Three runs: each fails i10 exactly once, 29/30 against 29/30, whatever the seed.
  const items = Array.from({ length: 10 }, (_, index) => `i${index + 1}`);
  const cheap: Rung = { key: "cheap", price: 1 };
  const evaluate = (repeats: number, seed: number) => evaluateTask({
    ladder: [cheap], strength: () => 1, items, repeats, baselinePrice: 10,
    sample: reliable => reliable.slice(0, 5),
    measure: async (option: Rung | null, ids: readonly string[] | null, call: MeasureCall) => {
      const fails = call.role !== "screen" && (call.repeat + seed + (option ? 1 : 0)) % 3 === 0;
      return { items: Object.fromEntries(ids!.map(id => [id, !(fails && id === "i10")])), costUsd: ids!.length * (option ? 0.001 : 0.01) };
    },
  });
  const once = [await evaluate(1, 0), await evaluate(1, 1), await evaluate(1, 2)];
  assert.deepEqual(once.map(result => [result.baseline.passes, result.candidates[0]!.passes, result.status]), [[10, 10, "ranked"], [10, 9, "no_qualified"], [9, 10, "ranked"]]);
  assert.deepEqual(once[1]!.nearMisses.map(item => [item.option.key, item.passes, item.total]), [["cheap", 9, 10]], "one item short of the bar is a near miss");
  for (const seed of [0, 1, 2]) {
    const thrice = await evaluate(3, seed);
    assert.deepEqual([thrice.baseline.passes, thrice.baseline.total, thrice.candidates[0]!.passes, thrice.candidates[0]!.total, thrice.status], [29, 30, 29, 30, "ranked"], `seed ${seed}`);
    assert.deepEqual(thrice.cheaper.map(item => item.option.key), ["cheap"]);
    assert.ok(Math.abs(thrice.cheaper[0]!.costPerItemUsd! - 0.001) < 1e-12);
    // i10 failed in one of the current model's runs, so it is never a screening item.
    assert.deepEqual(thrice.reliable, items.slice(0, 9));
  }
});

test("a task's result picks the cheapest qualifier that costs less than the current model, and keeps it when none does", async () => {
  // Two placed candidates that both pass every item: "mid" costs $0.002 per item, "low" $0.02. The current model costs `current` per item.
  const ladder: Rung[] = [{ key: "low", price: 1 }, { key: "mid", price: 2 }];
  const cost: Record<string, number> = { low: 0.02, mid: 0.002 };
  const items = Array.from({ length: 6 }, (_, index) => `i${index + 1}`);
  const run = async (current: number) => taskResult(await evaluateTask({
    ladder, strength: option => ladder.indexOf(option), items, repeats: 1, baselinePrice: 10, sample: reliable => reliable.slice(0, 5),
    measure: async (option, ids) => ({ items: Object.fromEntries(ids!.map(id => [id, true])), costUsd: ids!.length * (option ? cost[option.key]! : current) }),
  }), option => ({ model: option.key, endpoint: "e", endpointModel: option.key, eci: null }), { model: "now", endpoint: "e", endpointModel: "now", eci: null });
  // Ranked by measured cost, not list price: "mid" first.
  const cheaper = await run(0.01);
  assert.deepEqual([cheaper.top.map(item => item.model), cheaper.pick?.model], [["mid", "low"], "mid"]);
  // Dearer than both: the Top 3 still shows them, and nothing is picked.
  const dearer = await run(0.001);
  assert.deepEqual([dearer.top.map(item => item.model), dearer.cheaper, dearer.pick], [["mid", "low"], [], null]);
});

test("a proposed edit replaces only the model literal, keeps an SDK's provider prefix, and says when the literal is a fallback", () => {
  const known = new Set(["openai/gpt-5", "openai/gpt-5-nano"]);
  const find = (id: string) => (known.has(id) ? { id } as CatalogueModel : known.has(`openai/${id.replace(/^openai:/, "")}`) ? { id: `openai/${id.replace(/^openai:/, "")}` } as CatalogueModel : null);
  const pick = { model: "openai/gpt-5-nano", endpoint: "openai", endpointModel: "gpt-5-nano", onOpenRouter: false };
  const sdk = proposeEdit({ task: "t", current: "openai/gpt-5", refs: [{ file: "a.py", line: 1, spelling: 'init_chat_model("openai:gpt-5")' }], pick, baselineEndpoint: "openai", find });
  assert.deepEqual([sdk.edits.map(edit => edit.after), sdk.instructions], [['init_chat_model("openai:gpt-5-nano")'], null]);
  const fallback = proposeEdit({ task: "t", current: "openai/gpt-5", refs: [{ file: "a.ts", line: 2, spelling: "env.MODEL ?? 'gpt-5-nano'" }], pick: { ...pick, model: "openai/gpt-5", endpointModel: "gpt-5" }, baselineEndpoint: "openai", find });
  assert.deepEqual(fallback.edits.map(edit => edit.after), ["env.MODEL ?? 'gpt-5'"]);
  assert.match(fallback.instructions ?? "", /The code's literal is a fallback/);
});

async function ledgerContract(ledger: Ledger) {
  const customer = async () => (await ledger.spent()).customerUsd;
  const near = async (expected: number) => assert.ok(Math.abs(await customer() - expected) < 1e-9, `spent ${await customer()}, expected ${expected}`);
  const reserve = (key: string, usd: number) => ledger.reserve({ key, usd, funding: "customer", model: "m", endpoint: "e" });

  assert.deepEqual(await reserve("a", 0.4), { ok: true });
  assert.deepEqual(await reserve("a", 0.4), { ok: true }, "a replayed reservation succeeds");
  await near(0.4);
  assert.deepEqual(await reserve("b", 0.5), { ok: true });
  const refused = await reserve("c", 0.2);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.neededUsd, 0.2);
  await near(0.9);

  await ledger.settle("a", { actualUsd: 0.1, estimatedUsd: null });
  await ledger.settle("a", { actualUsd: 0.3, estimatedUsd: null });
  await near(0.6);
  assert.deepEqual(await reserve("a", 0.4), { ok: true }, "reserving a settled key changes nothing");
  await near(0.6);

  await ledger.release("b");
  await ledger.release("b");
  await ledger.settle("b", { actualUsd: 0.5, estimatedUsd: null });
  await ledger.release("a");
  await near(0.1);

  assert.deepEqual(await reserve("c", 0.2), { ok: true }, "released spend frees the cap");
  await ledger.settle("c", { actualUsd: null, estimatedUsd: 0.05 });
  assert.deepEqual(await reserve("d", 0.3), { ok: true });
  await ledger.settle("d", { actualUsd: null, estimatedUsd: null, failed: true });
  await near(0.1 + 0.05 + 0.3);
  await assert.rejects(ledger.settle("never-reserved", { actualUsd: 0, estimatedUsd: null }));
}

test("MemoryLedger: reserve, settle and release are idempotent by key", () => ledgerContract(new MemoryLedger({ customer: 1 })));

test("State's ledger: the same contract on the CLI's SQLite usage table", async () => {
  const home = mkdtempSync(join(tmpdir(), "openmerit-ledger-"));
  const state = new State({ OPENMERIT_HOME: home });
  try {
    state.createRun({ id: "run", repo: { id: "repo", root: home, gitRoot: null, revision: null, dirty: false }, packageVersion: "0", catalogueVersion: "0", harness: "fake", budgetUsd: 1, state: {} });
    const ledger = state.ledger({ runId: "run", unitId: "unit" });
    await ledgerContract(ledger);
    // Released reservations leave no row; refused ones were never written.
    assert.equal(state.spend("run").requests, 3);
    await assert.rejects(ledger.reserve({ key: "x", usd: 0.1, funding: "openmerit" }));
  } finally { state.close(); }
});

test("MemoryLedger caps and reports each funding apart", async () => {
  const ledger = new MemoryLedger({ openmerit: 1 });
  assert.deepEqual(await ledger.reserve({ key: "c", usd: 5, funding: "customer" }), { ok: true });
  assert.deepEqual(await ledger.reserve({ key: "o1", usd: 0.6, funding: "openmerit" }), { ok: true });
  const refused = await ledger.reserve({ key: "o2", usd: 0.6, funding: "openmerit" });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /OpenMerit-paid/);
  assert.deepEqual(await ledger.spent(), { openmeritUsd: 0.6, customerUsd: 5 });
});

test("guardrails: the Sahra Health example resolves with where each value came from", () => {
  const resolved = resolveGuardrails({
    // Lower levels first, to show the order comes from the levels, not the object.
    task: { allowedProviders: ["workers-ai"], budgetUsd: 25 },
    agent: { minPassRate: 0.95, actionPolicy: "ask_first", agentEvalRequired: "required" },
    environment: { region: "uae", allowedProviders: ["workers-ai", "openrouter"], budgetUsd: 10, actionPolicy: "open_pr", agentEvalRequired: "warn" },
  });
  assert.deepEqual(resolved.rejected, []);
  assert.deepEqual(resolved.effective, { region: "uae", allowedProviders: ["workers-ai"], budgetUsd: 25, minPassRate: 0.95, actionPolicy: "ask_first", agentEvalRequired: "required" });
  assert.deepEqual(resolved.from, { region: "environment", allowedProviders: "task", budgetUsd: "task", minPassRate: "agent", actionPolicy: "agent", agentEvalRequired: "agent" });
});

test("guardrails: constraints only narrow, against the nearest level that set them; defaults move either way", () => {
  const resolved = resolveGuardrails({
    environment: { allowedProviders: ["workers-ai", "openrouter"], spendCapUsd: 20, budgetUsd: 10, repeats: 3 },
    agent: { allowedProviders: ["workers-ai"], spendCapUsd: 10, budgetUsd: 5 },
    // openrouter is in the environment's list but the agent removed it; region is set for the first time.
    task: { allowedProviders: ["workers-ai", "openrouter"], spendCapUsd: 15, budgetUsd: 30, region: "uae", repeats: 1 },
  });
  assert.deepEqual(resolved.effective, { allowedProviders: ["workers-ai"], spendCapUsd: 10, budgetUsd: 30, region: "uae", repeats: 1 });
  assert.deepEqual(resolved.from, { allowedProviders: "agent", spendCapUsd: "agent", budgetUsd: "task", region: "task", repeats: "task" });
  assert.deepEqual(resolved.rejected.map(item => [item.key, item.level]), [["allowedProviders", "task"], ["spendCapUsd", "task"]]);
  assert.match(resolved.rejected[0]!.reason, /agent.*adds openrouter/);

  const changed = resolveGuardrails({ environment: { region: "uae", minPassRate: 0.9 }, task: { region: "eu", minPassRate: 95, ...({ colour: "red" } as object) } });
  assert.deepEqual(changed.effective, { region: "uae", minPassRate: 0.9 });
  assert.deepEqual(changed.rejected.map(item => item.key).sort(), ["colour", "minPassRate", "region"]);
});

/** An agent run on ten cases that passes the first `passes`. */
const run = (passes: number): AgentRun => ({ results: Array.from({ length: 10 }, (_, index) => ({ caseId: `c${index}`, pass: index < passes })), costUsd: 1 });

test("agent eval: a pick that passes fewer agent cases than today falls back to the next finalist", async () => {
  const options = [{ key: "pick", savingUsd: 3 }, { key: "second", savingUsd: 2 }, { key: "third", savingUsd: 1 }];
  const scores: Record<string, number> = { pick: 7, second: 9, third: 10 };
  const calls: string[] = [];
  const result = await checkAgent({
    tasks: [{ task: "intake", options }], minPassRate: 0.5,
    measure: async assignment => { const key = assignment.get("intake")?.key ?? "current"; calls.push(key); return run(scores[key] ?? 8); },
  });
  assert.equal(result.status, "checked");
  assert.deepEqual(result.tasks[0]!.tried.map(item => [item.option.key, item.passed]), [["pick", false], ["second", true]]);
  assert.deepEqual(result.proposed.map(item => item.option.key), ["second"]);
  assert.deepEqual(calls, ["current", "pick", "second"], "stops at the first finalist that passes");
});

test("agent eval: matching today is not enough below the agent's minimum pass rate", async () => {
  const result = await checkAgent({
    tasks: [{ task: "intake", options: [{ key: "pick", savingUsd: 3 }, { key: "second", savingUsd: 2 }] }], minPassRate: 0.7,
    measure: async assignment => run(({ pick: 6, second: 7 } as Record<string, number>)[assignment.get("intake")?.key ?? ""] ?? 6),
  });
  assert.deepEqual(result.tasks[0]!.tried.map(item => item.passed), [false, true]);
});

test("agent eval: switches that fail together keep the largest savings that pass together", async () => {
  let calls = 0;
  const result = await checkAgent({
    tasks: [
      { task: "a", options: [{ key: "a-cheap", savingUsd: 5 }] },
      { task: "b", options: [{ key: "b-cheap", savingUsd: 10 }] },
      { task: "c", options: [{ key: "c-cheap", savingUsd: 1 }] },
    ],
    // Each switch passes alone; a and b break the agent together.
    measure: async assignment => { calls++; return run(assignment.has("a") && assignment.has("b") ? 5 : 8); },
  });
  assert.deepEqual(result.proposed.map(item => item.task), ["b", "c"]);
  assert.deepEqual(result.incompatible.map(item => item.task), ["a"]);
  assert.equal(result.together?.passes, 8);
  assert.equal(calls, 1 + 3 + 1 + 2, "baseline, each switch, all together, then b+a and b+c");
});

test("agent eval: switches that pass together are proposed after one combined run, largest saving first", async () => {
  const assignments: string[][] = [];
  const result = await checkAgent({
    tasks: [{ task: "a", options: [{ key: "a1", savingUsd: 1 }] }, { task: "b", options: [{ key: "b1", savingUsd: 4 }] }],
    measure: async assignment => { assignments.push([...assignment.keys()].sort()); return run(8); },
  });
  assert.deepEqual(result.proposed.map(item => item.task), ["b", "a"]);
  assert.deepEqual(assignments, [[], ["a"], ["b"], ["a", "b"]]);
});

test("agent eval: without an agent eval the guardrail decides", async () => {
  const tasks = [{ task: "a", options: [{ key: "a1", savingUsd: 1 }] }, { task: "b", options: [{ key: "b1", savingUsd: 4 }] }];
  const warned = await checkAgent({ tasks, measure: null });
  assert.equal(warned.status, "missing");
  assert.deepEqual(warned.proposed.map(item => item.task), ["b", "a"]);
  assert.ok(warned.warning);
  const required = await checkAgent({ tasks, measure: null, required: "required" });
  assert.deepEqual(required.proposed, []);
  const empty = await checkAgent({ tasks, measure: async () => ({ results: [], costUsd: 0 }), required: "required" });
  assert.equal(empty.status, "missing");
});

test("the quality rule takes the strongest grader, real cases and recorded spend, whatever order the connections came in", () => {
  // The agent's bundle comes first and offers the weakest of each; the eval platform's evidence comes second.
  const agent: EvidencePart = {
    graders: [{ value: { kind: "judge", description: "a judge model" }, source: { connector: "agent-bundle", detail: "" } }],
    cases: [{ value: { kind: "written", count: 12, description: "12 written cases" }, source: { connector: "agent-bundle", detail: "" } }],
    priority: [{ value: { kind: "request" }, source: { connector: "agent-bundle", detail: "" } }],
  };
  const platform: EvidencePart = {
    graders: [
      { value: { kind: "confirmed_label", description: "labels you confirmed" }, source: { connector: "langfuse", detail: "" } },
      { value: { kind: "expected_output", description: "expected outputs" }, source: { connector: "langfuse", detail: "support-tickets" } },
    ],
    cases: [{ value: { kind: "real", count: 4, description: "4 dataset items" }, source: { connector: "langfuse", detail: "support-tickets" } }],
    priority: [{ value: { kind: "spend", usdPerMonth: 41.5 }, source: { connector: "langfuse", detail: "" } }],
  };
  const evidence = mergeEvidence("ticket classifier", "openai/gpt-5.4", [agent, platform]);
  const chosen = strongest(evidence);
  assert.equal(chosen.grader?.value.kind, "expected_output");
  assert.deepEqual(chosen.cases.map(item => item.value.description), ["4 dataset items"]);
  assert.equal(chosen.priority?.value.kind, "spend");
  assert.deepEqual(basedOn(chosen), [
    "Grader: expected outputs, from langfuse (support-tickets).",
    "Cases: 4 dataset items from langfuse (support-tickets).",
    "Priority: $41.50 a month of recorded spend, from langfuse.",
  ]);
  // Fewer real cases than the run needs: the written ones join them; exactly enough, they do not.
  assert.deepEqual(strongest(evidence, 5).cases.map(item => item.value.kind), ["real", "written"]);
  assert.deepEqual(strongest(evidence, 4).cases.map(item => item.value.kind), ["real"]);
  // With the agent's evidence alone, the weakest is what there is.
  assert.deepEqual(basedOn(strongest(mergeEvidence("ticket classifier", "openai/gpt-5.4", [agent]))), [
    "Grader: a judge model, from agent-bundle.", "Cases: 12 written cases from agent-bundle.", "Priority: you asked about this task, from agent-bundle.",
  ]);
});

test("an approval records who approved and when, and refuses one without either", () => {
  const change = { edits: [], instructions: null };
  const target = { model: "openai/gpt-5-nano", endpoint: "openrouter", endpointModel: "openai/gpt-5-nano", onOpenRouter: true };
  const approved = approve(change, target, { by: " praveen@openmerit.ai ", at: "2026-11-19T14:00:00+01:00" });
  assert.deepEqual(approved.approval, { by: "praveen@openmerit.ai", at: "2026-11-19T13:00:00.000Z" });
  assert.equal(approved.target, target);
  assert.throws(() => approve(change, target, { by: "  ", at: "2026-11-19T13:00:00Z" }), /person who approved/);
  assert.throws(() => approve(change, target, { by: "praveen@openmerit.ai", at: "yesterday" }), /time it was given/);
});

test("the floor: under 80% of its own eval, the current model's eval ranks nothing and screens no candidate", async () => {
  // Ten items, the last four guardrail cases. `misses` items fail for the current model in every run; candidates pass everything.
  const items = Array.from({ length: 10 }, (_, index) => `i${index + 1}`);
  const kinds = Object.fromEntries(items.map((id, index) => [id, index < 6 ? "typical" : "guardrail"]));
  const run = async (misses: string[], floor?: number | null) => {
    const calls: string[] = [];
    const result = await evaluateTask({
      ladder: [{ key: "cheap", price: 1 }], strength: () => 1, items, repeats: 3, baselinePrice: 10, kinds, ...(floor === undefined ? {} : { floor }),
      sample: reliable => reliable.slice(0, 5),
      measure: async (option: Rung | null, ids: readonly string[] | null, call: MeasureCall) => {
        calls.push(call.role);
        return { items: Object.fromEntries(ids!.map(id => [id, !!option || !misses.includes(id)])), costUsd: 0.001 };
      },
    });
    return { result, calls };
  };
  const below = await run(["i8", "i9", "i10"]);
  assert.equal(EVAL_FLOOR, 0.8);
  assert.equal(below.result.status, "below_floor");
  assert.deepEqual(below.calls, ["baseline", "baseline", "baseline"], "nothing is screened");
  assert.deepEqual(below.result.baseline.byKind, [{ kind: "typical", passes: 18, total: 18 }, { kind: "guardrail", passes: 3, total: 12 }]);
  assert.deepEqual(below.result.top, []);
  // Exactly 80% is enough; and a caller whose eval has its own threshold turns the floor off.
  assert.equal((await run(["i9", "i10"])).result.status, "ranked");
  assert.equal((await run(["i8", "i9", "i10"], null)).result.status, "ranked");
});

test("against the task's criteria: every guardrail on every case, each criterion on 90% of them, and the cheapest model that meets them even above the current model's price", async () => {
  // Twenty items. Each option fails the listed items on the listed check; the current model (price 10) misses C1 on 6 items.
  const items = Array.from({ length: 20 }, (_, index) => `i${index + 1}`);
  const criteria = { criteria: ["C1", "C2"], guardrails: ["G1", "S1"] };
  const run = async (fails: Record<string, Record<string, string>>, mode: "criteria" | "current") => evaluateTask({
    ladder: [{ key: "cheap", price: 1 }, { key: "mid", price: 5 }, { key: "dear", price: 20 }], strength: () => 1, items, repeats: 1, baselinePrice: 10,
    ...(mode === "criteria" ? { criteria } : {}),
    sample: pool => pool.slice(-5),
    measure: async (option: Rung | null, ids: readonly string[] | null) => {
      const missed = fails[option?.key ?? "current"] ?? {};
      return { items: Object.fromEntries(ids!.map(id => [id, !missed[id]])), checks: Object.fromEntries(Object.entries(missed).map(([id, check]) => [id, [check]])), costUsd: (option?.price ?? 10) * 0.001 * ids!.length };
    },
  });
  const current = Object.fromEntries(items.slice(0, 6).map(id => [id, "C1"]));
  // cheap breaks a guardrail once; mid misses C2 on 2 of 20 cases, exactly 90%.
  const atBoundary = await run({ current, cheap: { i1: "G1" }, mid: { i2: "C2", i3: "C2" } }, "criteria");
  assert.equal(CRITERIA_PASS_RATE, 0.9);
  assert.equal(atBoundary.status, "ranked", "no floor against the criteria, although the current model passes 70%");
  assert.deepEqual(atBoundary.baseline.failedChecks, ["C1"]);
  assert.equal(atBoundary.top[0]?.option.key, "mid");
  assert.equal(atBoundary.candidates.find(item => item.option.key === "cheap")?.shortfall, "criteria", "one broken guardrail is enough");
  // One more miss is 85%: the cheapest model that meets them now costs more than the current model.
  const pricier = await run({ current, cheap: { i1: "G1" }, mid: { i2: "C2", i3: "C2", i4: "C2" } }, "criteria");
  assert.equal(pricier.top[0]?.option.key, "dear");
  assert.ok(pricier.top[0]!.costPerItemUsd! > pricier.baseline.costPerItemUsd!);
  const describe = (option: Rung) => ({ model: option.key, endpoint: "e", endpointModel: option.key, eci: null });
  const result = taskResult(pricier, describe, describe({ key: "current", price: 10 }));
  assert.equal(result.bar, "criteria");
  assert.equal(result.pick?.model, "dear", "the pick costs more than the current model");
  assert.equal(result.summary, "Your current model fails 1 of your checks (C1); the cheapest model that passes them is dear, at $10.00 more per 1,000 calls.");
  // The same answers against the current model stop at the floor.
  assert.equal((await run({ current }, "current")).status, "below_floor");
  // A failure the grader named no check for counts against every criterion, not against a guardrail.
  assert.deepEqual(meetsCriteria([{ items: { a: false, b: true, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true }, costUsd: 0 }], criteria), { meets: true, failed: [] });
  assert.deepEqual(meetsCriteria([{ items: { a: false, b: false, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true }, costUsd: 0 }], criteria).failed, ["C1", "C2"]);
});

test("a screen that misses one sampled item is screened once more on the next five; two misses, or a broken guardrail against the criteria, end it", async () => {
  // Twenty items the current model always passes. The sampler returns them in order: i1–i5 screen, i6–i10 retry.
  const items = Array.from({ length: 20 }, (_, index) => `i${index + 1}`);
  const run = async (missed: Record<string, string>, criteria = false) => {
    const screens: string[][] = [];
    const result = await evaluateTask({
      ladder: [{ key: "x", price: 1 }], strength: () => 1, items, repeats: 1, baselinePrice: 10,
      ...(criteria ? { criteria: { criteria: ["C1"], guardrails: ["G1"] } } : {}),
      sample: (pool, count) => pool.slice(0, count),
      measure: async (option: Rung | null, ids: readonly string[] | null, call: MeasureCall) => {
        if (call.role === "screen") screens.push([...ids!]);
        const misses = option ? missed : {};
        return { items: Object.fromEntries(ids!.map(id => [id, !misses[id]])), checks: Object.fromEntries(Object.entries(misses).map(([id, check]) => [id, [check]])), costUsd: ids!.length * (option ? 0.001 : 0.01) };
      },
    });
    return { x: result.candidates.find(item => item.option.key === "x")!, screens, result };
  };
  const lucky = await run({ i3: "C1" });
  assert.deepEqual(lucky.screens, [items.slice(0, 5), items.slice(5, 10)], "retried on the next five items");
  assert.deepEqual([lucky.x.status, lucky.x.runs.length, lucky.result.samples], ["measured", 1, items.slice(0, 5)]);
  const twice = await run({ i3: "C1", i7: "C1" });
  assert.deepEqual([twice.x.status, twice.x.passes, twice.x.total], ["screened_out", 8, 10], "a miss in the retry too ends it");
  const weak = await run({ i3: "C1", i4: "C1" });
  assert.deepEqual([weak.x.status, weak.screens.length], ["screened_out", 1], "two misses are not retried");
  // Against the criteria: a missed criterion is retried, a broken guardrail never is, since every case must pass it.
  assert.equal((await run({ i3: "C1" }, true)).x.status, "measured");
  const guardrail = await run({ i3: "G1" }, true);
  assert.deepEqual([guardrail.x.status, guardrail.screens.length], ["screened_out", 1]);
});

test("a provisional pick listed under the cheapest qualified model is measured, so the task's last pick is not dropped for a dearer one", async () => {
  // "lead" passes everything and costs less than the current model; "last", the last run's pick, is off the ladder the search took.
  const items = Array.from({ length: 10 }, (_, index) => `i${index + 1}`);
  const cost: Record<string, number> = { lead: 0.005, last: 0.001 };
  const run = (last: Rung) => evaluateTask({
    ladder: [{ key: "lead", price: 5 }], strength: () => 1, items, repeats: 1, baselinePrice: 10, provisional: last,
    sample: (pool, count) => pool.slice(0, count),
    measure: async (option: Rung | null, ids: readonly string[] | null) => ({ items: Object.fromEntries(ids!.map(id => [id, true])), costUsd: ids!.length * (option ? cost[option.key]! : 0.01) }),
  });
  const cheaper = await run({ key: "last", price: 1 });
  assert.deepEqual([cheaper.provisionalTried, cheaper.top.map(item => item.option.key)], [true, ["last", "lead"]]);
  const dearer = await run({ key: "last", price: 8 });
  assert.deepEqual([dearer.provisionalTried, dearer.top.map(item => item.option.key)], [false, ["lead"]], "one listed above the cheapest qualifier is left");
});

test("stableSample draws the same items for the same eval, whatever the pool's order, and an item leaving the pool moves no other", () => {
  const pool = Array.from({ length: 30 }, (_, index) => `case-${index + 1}`);
  const key = (id: string) => `ticket router\n${id}`;
  const drawn = stableSample(pool, 10, key);
  assert.equal(new Set(drawn).size, 10);
  assert.deepEqual(stableSample([...pool].reverse(), 10, key), drawn);
  const left = pool.find(id => !drawn.includes(id))!;
  assert.deepEqual(stableSample(pool.filter(id => id !== left), 10, key), drawn);
  assert.deepEqual(stableSample(pool.filter(id => id !== drawn[2]), 10, key).slice(0, 9), drawn.filter(id => id !== drawn[2]), "only the item that left is replaced");
  assert.notDeepEqual(stableSample(pool, 10, id => `refund triage\n${id}`), drawn, "another eval draws other items");
});
