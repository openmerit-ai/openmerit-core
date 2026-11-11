// LIVE: talks to the real Langfuse project in LANGFUSE_BASE_URL with LANGFUSE_PUBLIC_KEY and
// LANGFUSE_SECRET_KEY. It is skipped unless OPENMERIT_LANGFUSE_LIVE=1, so CI and `node --test`
// stay offline. Run from openmerit-core/:
//   OPENMERIT_LANGFUSE_LIVE=1 OPENMERIT_LANGFUSE_EVIDENCE=/tmp/langfuse-live.json node --test src/connectors/langfuse/live.test.ts
//
// Reads: the playground's labelled dataset (default sahra-enrollments) and its latest full experiment.
// Writes: only to a scratch dataset (default openmerit-core-langfuse-check): two items, one new
// experiment per run, two traces and four scores. Nothing is deleted or overwritten.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { it } from "node:test";
import { connectionFromEnv, createLangfuseConnector } from "./index.ts";

const live = process.env.OPENMERIT_LANGFUSE_LIVE === "1";
const PLAYGROUND_DATASET = process.env.OPENMERIT_LANGFUSE_PLAYGROUND_DATASET ?? "sahra-enrollments";
const PLAYGROUND_SCORE = process.env.OPENMERIT_LANGFUSE_PLAYGROUND_SCORE ?? "enrollment-correct";
const SCRATCH_DATASET = process.env.OPENMERIT_LANGFUSE_SCRATCH_DATASET ?? "openmerit-core-langfuse-check";

const requests: Record<string, number> = {};
const countingFetch: typeof fetch = (input, init) => {
  const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
  requests[key] = (requests[key] ?? 0) + 1;
  return fetch(input, init);
};
const evidence: Record<string, unknown> = { kind: "LIVE Langfuse check (not mocked)", startedAt: new Date().toISOString(), node: process.version, requests };
const save = () => process.env.OPENMERIT_LANGFUSE_EVIDENCE && writeFileSync(process.env.OPENMERIT_LANGFUSE_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

it("LIVE: Langfuse playground reads and a recorded experiment round trip", { skip: !live && "set OPENMERIT_LANGFUSE_LIVE=1 to run against real Langfuse", timeout: 15 * 60_000 }, async () => {
  const connector = createLangfuseConnector(connectionFromEnv(), { fetch: countingFetch, environment: "openmerit-check" });
  try {
    const project = await connector.check();
    evidence.project = project;

    // Playground workflow: the labelled items Scout samples from, and the runs the scenario runner wrote.
    const playground = await connector.getDataset(PLAYGROUND_DATASET);
    const items = await connector.getDatasetItems(PLAYGROUND_DATASET);
    assert.ok(items.length >= 5, `${PLAYGROUND_DATASET} needs at least 5 labelled items for screening; it has ${items.length}`);
    assert.ok(items.every((item) => item.expectedOutput !== null), "every playground item has an expected output");
    const experiments = await connector.listExperiments({ datasetId: playground.id, since: "2026-11-01" });
    // Every run, so unscored runs show up as missingScores instead of hiding behind one chosen run.
    const summaries: { id: string; models: Record<string, string>; itemCount: number | null; passes: number; total: number; missingScores: number; items: string[] }[] = [];
    for (const experiment of experiments) {
      const result = await connector.experimentResults({ experimentId: experiment.id, pass: { score: PLAYGROUND_SCORE }, since: "2026-11-01" });
      assert.ok(result.items.every((item) => /^[0-9a-f]{32}$/.test(item.traceId)));
      summaries.push({ id: experiment.id, models: experiment.models, itemCount: experiment.itemCount, passes: result.passes, total: result.total, missingScores: result.missingScores.length,
        items: result.items.map((item) => `${item.itemId}:${item.missingScore ? "unscored" : item.passed ? "pass" : "fail"}`) });
    }
    const scored = experiments.find((experiment, index) => (experiment.itemCount ?? 0) >= items.length && summaries[index]!.missingScores === 0);
    assert.ok(scored, `no experiment on ${PLAYGROUND_DATASET} has ${PLAYGROUND_SCORE} on all ${items.length} items`);
    const scoredResult = await connector.experimentResults({ experimentId: scored.id, pass: { score: PLAYGROUND_SCORE }, includeCost: true, since: "2026-11-01" });
    assert.equal(scoredResult.total, items.length);
    evidence.playground = {
      dataset: playground, itemIds: items.map((item) => item.id), passScore: PLAYGROUND_SCORE, experiments: summaries,
      latestFullyScored: { id: scored.id, name: scored.name, models: scored.models, passes: scoredResult.passes, total: scoredResult.total, costUsd: scoredResult.costUsd,
        items: scoredResult.items.map((item) => ({ itemId: item.itemId, traceId: item.traceId, passed: item.passed, scoreNames: Object.keys(item.scores).sort(), costUsd: item.costUsd })),
        url: await connector.experimentUrl(playground.id, scored.id) },
    };
    save();

    // Write round trip on a scratch dataset: record one pass and one fail, then read them back.
    const scratch = await connector.ensureDataset({ name: SCRATCH_DATASET, description: "OpenMerit Langfuse connector live check. Safe to ignore.", items: [{ id: "om-check-item-a", input: { question: "2+2" }, expectedOutput: "4" }, { id: "om-check-item-b", input: { question: "3+3" }, expectedOutput: "6" }] });
    assert.deepEqual((await connector.getDatasetItems(SCRATCH_DATASET)).map((item) => item.id).sort(), [...scratch.itemIds].sort());
    const experimentId = `om-check-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const model = "openrouter/example/connector-check";
    const now = Date.now();
    const recorded = await connector.recordExperimentItems({
      datasetId: scratch.datasetId, experimentId, experimentName: experimentId, metadata: { model_agent: model, stage: "screen" },
      items: [
        { itemId: "om-check-item-a", model, input: { question: "2+2" }, output: "4", startMs: now - 2000, endMs: now - 1000, usage: { input: 12, output: 1, total: 13 }, costUsd: 0.00123, metadata: { stage: "screen" }, scores: [{ name: "correct", value: true }, { name: "usd", value: 0.00123 }] },
        { itemId: "om-check-item-b", model, input: { question: "3+3" }, output: "7", startMs: now - 2000, endMs: now - 500, usage: { input: 12, output: 1, total: 13 }, costUsd: 0.00077, metadata: { stage: "screen" }, scores: [{ name: "correct", value: false, comment: "expected 6" }, { name: "usd", value: 0.00077 }] },
      ],
    });
    const started = Date.now();
    const result = await connector.waitForExperiment({ experimentId, pass: { score: "correct" }, includeCost: true, since: new Date(now - 3600_000) }, { expectItems: 2, timeoutMs: 12 * 60_000, intervalMs: 20_000 });
    const readBackSeconds = Math.round((Date.now() - started) / 1000);
    assert.deepEqual(result.items.map((item) => [item.itemId, item.passed, item.traceId]), [["om-check-item-a", true, recorded.traceIds["om-check-item-a"]], ["om-check-item-b", false, recorded.traceIds["om-check-item-b"]]]);
    assert.equal(result.datasetId, scratch.datasetId);
    const listed = (await connector.listExperiments({ datasetId: scratch.datasetId, ids: [experimentId], since: new Date(now - 3600_000) }))[0];
    assert.deepEqual(listed?.models, { agent: model });
    evidence.roundTrip = { dataset: { name: SCRATCH_DATASET, id: scratch.datasetId }, experimentId, url: recorded.url, traceIds: recorded.traceIds, readBackSeconds,
      result: { passes: result.passes, total: result.total, costUsd: result.costUsd, items: result.items.map((item) => ({ itemId: item.itemId, passed: item.passed, scores: item.scores, costUsd: item.costUsd })) }, listedModels: listed?.models };
    evidence.passed = true;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    save();
  }
});
