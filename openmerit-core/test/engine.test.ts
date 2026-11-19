// The shared engine's contract (`openmerit/engine`): the search over a ladder without ECI, ledger
// idempotency on both implementations, the guardrail resolver and the agent-eval rule.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { binarySearch, challengers, checkAgent, MemoryLedger, resolveGuardrails, type AgentRun, type Ledger, type Rung } from "../src/engine/index.ts";
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
