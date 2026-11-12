// Mocked: no model or Langfuse calls. Candidates are fixtures; a model "passes" an item when its
// ECI reaches the item's difficulty, so the right search path and winner are known in advance.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperimentQuery, ExperimentRecording, LangfuseConnector } from "../src/connectors/langfuse/index.ts";
import { rankCandidates, type Candidate } from "../src/scout/candidates.ts";
import { parseEciScores } from "../src/scout/eci.ts";
import { jsonMatches } from "../src/scout/evaluators/pi.ts";
import { runScout } from "../src/scout/pipeline.ts";
import { scoutSearch, type EvalItem, type Evaluate } from "../src/scout/search.ts";

const candidate = (name: string, eci: number, price: number | null = 1): Candidate =>
  ({ model: `openrouter/x/${name}`, provider: "openrouter", id: `x/${name}`, name, eci, eciModel: name, eciSource: "published", price });
// Ten models; ECI 100, 110, ..., 190 (listed out of order on purpose).
const models = [5, 2, 9, 0, 7, 1, 8, 3, 6, 4].map(index => candidate(`m${index}`, 100 + index * 10, 10 - index));
// Seven items with difficulty 125: models from ECI 130 pass every item; one hard item needs 165.
const dataset: EvalItem[] = [...Array.from({ length: 6 }, (_, index) => ({ id: `item-${index}`, input: index, expectedOutput: 125 })), { id: "hard", input: 6, expectedOutput: 165 }];
const passes: Evaluate = async (model, item) => ({ pass: model.eci >= (item.expectedOutput as number), costUsd: model.price! / 1000 });
const firstFive = (remaining: number) => (remaining > 2 ? 0 : remaining - 1);

test("binary search finds the weakest model passing the samples, then screens neighbours and runs finals on every item", async () => {
  const result = await scoutSearch({ dataset, candidates: models, evaluate: passes, pickIndex: firstFive });
  assert.equal(result.status, "selected");
  assert.deepEqual(result.sampleIds, ["item-0", "item-1", "item-2", "item-3", "item-4"]);
  // Probes 140 (pass), 110 (fail), 120 (fail), 130 (pass): the pick is the weakest passing model.
  assert.deepEqual(result.trials.filter(trial => trial.stage === "search").map(trial => trial.candidate.eci), [140, 110, 120, 130]);
  assert.equal(result.selected?.eci, 130);
  // 120 failed below the pick, so neighbours are taken from above only: 140 (already passed), 150, 160, 170.
  assert.deepEqual(result.finals.map(trial => trial.candidate.eci).filter(eci => eci <= 170).sort(), [130, 140, 150, 160, 170]);
  // Of the five, only 170 passes the hard item, so it leads. 180 ($2) and 190 ($1) are stronger and
  // cheaper than 170 ($3) but untested: they are screened as challengers, cheapest first, and join the finals.
  assert.deepEqual(result.trials.filter(trial => trial.stage === "challenger").map(trial => trial.candidate.eci), [190, 180]);
  assert.equal(result.finals.length, 7);
  // Every finalist runs every item three times (the default), and each run carries its repeat number.
  assert.ok(result.finals.every(trial => trial.runs === 3 && trial.outcomes.length === dataset.length * 3));
  assert.deepEqual([...new Set(result.finals[0]!.outcomes.map(outcome => outcome.repeat))], [1, 2, 3]);
  assert.ok(result.trials.every(trial => trial.runs === 1 && trial.outcomes.length === 5));
  assert.equal(result.finals[0]!.candidate.eci, 190);
  assert.equal(result.finals[0]!.passes, 21);
});

test("4/5 on the samples is a fail, and an evaluator error stops the search instead of counting as a fail", async () => {
  const flaky: Evaluate = async (model, item) => ({ pass: !(model.eci === 140 && item.id === "item-3") && model.eci >= 125 });
  const result = await scoutSearch({ dataset, candidates: models, evaluate: flaky, pickIndex: firstFive });
  assert.equal(result.trials[0]!.passes, 4);
  assert.equal(result.trials[0]!.accepted, false);

  const broken: Evaluate = async model => { if (model.eci === 110) throw new Error("HTTP 402 insufficient credit"); return { pass: true }; };
  const stopped = await scoutSearch({ dataset, candidates: models, evaluate: broken, pickIndex: firstFive });
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.error ?? "", /402/);
  assert.equal(stopped.finals.length, 0);
});

test("fewer than five labelled items is refused", async () => {
  await assert.rejects(scoutSearch({ dataset: dataset.slice(0, 4), candidates: models, evaluate: passes }), /at least 5/);
});

test("the recommendation comes from Langfuse's read-back results, not the local verdicts", async () => {
  const recordings: ExperimentRecording[] = [];
  // Langfuse reports the hard item as failed for ECI 170 (a late human relabel, say): 170 drops to 6/7
  // and ties four others, so the lower measured cost per item decides among the tied finalists.
  const fake = {
    baseUrl: "https://langfuse.test",
    check: async () => ({ baseUrl: "https://langfuse.test", projectId: "p1", projectName: "test" }),
    getDataset: async () => ({ id: "d1", name: "ds" }),
    getDatasetItems: async () => dataset.map(item => ({ ...item, metadata: {} })),
    recordExperimentItems: async (recording: ExperimentRecording) => { recordings.push(recording); return { experimentId: recording.experimentId, traceIds: {}, url: `https://langfuse.test/${recording.experimentId}` }; },
    waitForExperiment: async (query: ExperimentQuery) => {
      const recording = recordings.find(item => item.experimentId === query.experimentId)!;
      const items = recording.items.map(item => ({ itemId: item.itemId, traceId: "t", passed: item.scores[0]!.value === true && !(item.model.endsWith("m7") && item.itemId === "hard"), missingScore: false, scores: {}, costUsd: item.costUsd ?? null }));
      return { experimentId: recording.experimentId, experimentName: recording.experimentName, datasetId: "d1", items, passes: items.filter(item => item.passed).length, total: items.length, missing: [], missingScores: [], costUsd: items.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) };
    },
  } as unknown as LangfuseConnector;
  const report = await runScout({ task: "t", dataset: { langfuseDataset: "ds" }, candidates: models, evaluate: passes, langfuse: fake, passScore: "correct", pickIndex: firstFive, challengers: 0 });
  // Every probe and screen became one Langfuse experiment, and every final one experiment per repeat
  // (Langfuse keeps one result per dataset item per experiment), each carrying the pass score per item.
  assert.equal(recordings.length, report.search.trials.length + report.finals.length * 3);
  assert.ok(recordings.every(recording => new Set(recording.items.map(item => item.itemId)).size === recording.items.length));
  assert.deepEqual(report.finals[0]!.experimentIds.map(id => /-final-(r\d)-/.exec(id)?.[1]), ["r1", "r2", "r3"]);
  assert.ok(recordings.every(recording => recording.items.every(item => item.scores[0]!.name === "correct")));
  const finalsByEci = Object.fromEntries(report.finals.map(item => [item.eci, item.passes]));
  assert.deepEqual(finalsByEci, { 130: 18, 140: 18, 150: 18, 160: 18, 170: 18 });
  assert.equal(report.finals.find(item => item.eci === 170)!.localPasses, 21);
  assert.deepEqual(report.finals.find(item => item.eci === 170)!.passesByItem, { "item-0": 3, "item-1": 3, "item-2": 3, "item-3": 3, "item-4": 3, "item-5": 3, hard: 0 });
  // All tie on 18/21; cost per item is price/1000 and price falls as ECI rises, so ECI 170 ($0.003) is cheapest.
  assert.equal(report.recommendation!.eci, 170);
  assert.ok(Math.abs(report.recommendation!.costPerItemUsd! - 0.003) < 1e-12);
  assert.ok(report.recommendation!.verifiedInLangfuse);
  assert.ok(report.limitations.some(line => /differ/.test(line)));
});

test("candidates are runnable models with a published ECI, one per Epoch row, cheapest listing first", () => {
  const rows = parseEciScores('Model,Display name,eci,eci_ci_low,eci_ci_high,date,model_versions\nGPT-6.1 Sol,GPT-6.1 Sol,168.9,166,172,2026-09-29,"gpt-6.1-sol-2026-09,gpt-6.1-sol"\nDeepSeek V4 Pro,DeepSeek V4 Pro,150.2,148,152,2026-06-01,\n');
  const ranked = rankCandidates([
    { provider: "openrouter", id: "openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", cost: { input: 2, output: 10 } },
    { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", cost: { input: 2, output: 10 } },
    { provider: "openrouter", id: "deepseek/deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro", cost: { input: 0.3, output: 0.5 } },
    { provider: "openrouter", id: "deepseek/deepseek-v4-pro:free", name: "DeepSeek: DeepSeek V4 Pro (free)" },
    { provider: "openrouter", id: "~openai/gpt-sol-latest", name: "OpenAI: GPT Sol Latest" },
    { provider: "openrouter", id: "acme/unknown-1", name: "Acme: Unknown 1" },
  ], rows, { providers: ["openai", "openrouter"] });
  assert.deepEqual(ranked.candidates.map(item => item.model), ["openrouter/deepseek/deepseek-v4-pro", "openai/gpt-6.1-sol"]);
  assert.equal(ranked.candidates[0]!.price, 0.8);
  assert.deepEqual(ranked.unranked, ["openrouter/acme/unknown-1"]);
});

test("the json grader needs every expected field: arrays as sets, strings case-insensitive", () => {
  assert.ok(jsonMatches({ decision: "Declined", codes: ["E11", "I10"] }, { decision: "declined", codes: ["I10", "E11"], note: "extra" }));
  assert.ok(!jsonMatches({ decision: "enrolled", codes: ["E11"] }, { decision: "enrolled", codes: ["E11", "O24"] }));
  assert.ok(!jsonMatches({ decision: "enrolled" }, { decision: "declined" }));
});

test("a candidate that cannot run is skipped as untested, and the search continues without it", async () => {
  const { CandidateUnavailable } = await import("../src/scout/search.ts");
  // ECI 140 is the first probe; the provider rejects it (402). The search must not count it as a fail.
  const evaluate: Evaluate = async (model, item) => {
    if (model.eci === 140) throw new CandidateUnavailable("402: requires more credits");
    return passes(model, item, { stage: "search" });
  };
  const result = await scoutSearch({ dataset, candidates: models, evaluate, pickIndex: firstFive });
  assert.equal(result.status, "selected");
  assert.deepEqual(result.unavailable.map(item => item.model), ["openrouter/x/m4"]);
  assert.equal(result.selected?.eci, 130);
  assert.ok(!result.trials.some(trial => trial.candidate.eci === 140));
  assert.ok(!result.finals.some(trial => trial.candidate.eci === 140));
  // Without 140 the pick is 130 again; its five finalists reach up to 180, and 190 joins as a challenger.
  assert.deepEqual(result.finals.map(trial => trial.candidate.eci).sort(), [130, 150, 160, 170, 180, 190]);
});

test("the Pi evaluator retries transient provider errors, marks rejected models unavailable, and grades the reply", async () => {
  const { piEvaluator } = await import("../src/scout/evaluators/pi.ts");
  const { CandidateUnavailable } = await import("../src/scout/search.ts");
  const replies: { stopReason: "stop" | "error"; text?: string; errorMessage?: string }[] = [];
  const caller = {
    getModel: (provider: string, id: string) => ({ provider, id }) as never,
    complete: async () => {
      const next = replies.shift()!;
      return { role: "assistant", content: next.text ? [{ type: "text", text: next.text }] : [], stopReason: next.stopReason, errorMessage: next.errorMessage,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } } as never;
    },
  };
  const evaluate = piEvaluator(caller, { systemPrompt: "List codes as JSON.", grader: { type: "json" } }, { retryDelaysMs: [1, 1] });
  const item = { id: "HD-08", input: "AF and hypertension", expectedOutput: { conditions: ["I48", "I10"] } };
  const model = candidate("m", 150);

  replies.push({ stopReason: "error", errorMessage: "429: rate limited upstream" }, { stopReason: "stop", text: "```json\n{\"conditions\": [\"I10\", \"I48\"]}\n```" });
  const outcome = await evaluate(model, item, { stage: "search" });
  assert.equal(outcome.pass, true);
  assert.equal(outcome.costUsd, 0.002);
  assert.equal(replies.length, 0);

  replies.push({ stopReason: "stop", text: "{\"conditions\": [\"I48\"]}" });
  assert.equal((await evaluate(model, item, { stage: "search" })).pass, false);

  replies.push({ stopReason: "error", errorMessage: "404: No endpoints found for x/m" });
  await assert.rejects(evaluate(model, item, { stage: "search" }), CandidateUnavailable);

  replies.push({ stopReason: "error", errorMessage: "401: invalid key" });
  await assert.rejects(evaluate(model, item, { stage: "search" }), (error: unknown) => error instanceof Error && !(error instanceof CandidateUnavailable) && /401/.test(error.message));
});

test("models Epoch does not score rank on ScoutBM's bundled estimates, and published scores win", async () => {
  const { loadEciEstimates } = await import("../src/scout/eci.ts");
  const bundled = await loadEciEstimates();
  assert.ok(bundled.estimates.length > 100, "the package ships the estimates CSV");
  assert.match(bundled.provenance, /Catalogue [0-9a-f]{32}/);
  const rows = parseEciScores('Model,Display name,eci,eci_ci_low,eci_ci_high,date,model_versions\nGPT-6.1 Sol,GPT-6.1 Sol,168.9,166,172,2026-09-29,\n');
  const estimates = [
    { catalogueModel: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash", openRouterId: "qwen/qwen3.8-flash", eci: 154.2, source: "estimated" as const, standardError: 4.7, benchmarks: ["GPQA diamond"] },
    { catalogueModel: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", openRouterId: "openai/gpt-6.1-sol", eci: 140, source: "calibrated" as const, standardError: 2, benchmarks: [] },
  ];
  const ranked = rankCandidates([
    { provider: "openrouter", id: "qwen/qwen3.8-flash", name: "Qwen: Qwen3.8 Flash", cost: { input: 0.1, output: 0.4 } },
    { provider: "openrouter", id: "openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", cost: { input: 2, output: 10 } },
    { provider: "openrouter", id: "acme/unknown-1", name: "Acme: Unknown 1" },
  ], rows, {}, estimates);
  assert.deepEqual(ranked.candidates.map(item => [item.model, item.eciSource, item.eci]), [
    ["openrouter/qwen/qwen3.8-flash", "estimated", 154.2],
    ["openrouter/openai/gpt-6.1-sol", "published", 168.9],
  ]);
  assert.equal(ranked.candidates[0]!.eciError, 4.7);
  assert.deepEqual(ranked.unranked, ["openrouter/acme/unknown-1"]);
});
