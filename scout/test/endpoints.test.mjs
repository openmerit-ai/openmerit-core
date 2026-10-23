import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import { parseProviderCatalogue, mergeCatalogues } from '../catalogue.mjs';
import { contractModels, endpointFit, expandEndpoints, orderTaskEndpoints, bestEndpointPerModel, hubEndpointModels } from '../endpoints.mjs';
import { referenceWork } from '../comparison.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { decisionQuestions, interpretDecisions } from '../decisions.mjs';
import { handleAPI } from '../http.mjs';
import { allowProfiles } from './helpers-specialists.mjs';
const task = (kind, vision = false) => ({ kind, labelSpace: kind === 'classify' ? 'supplied' : null, needsVision: vision, weights: vision ? { vision: 3 } : { structured: 3 }, workload: { input: 'short', output: 'short', priority: 'balanced' }, outputContract: kind === 'classify' ? 'labels' : kind === 'detect' ? 'boxes' : 'masks' });
const index = createIndex(snapshot);
const answers = choices => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .95, choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'medium', priority: 'balanced', task_kind: 'other' }[q.name] ?? 'absent') }));

test('native provider discovery works without router models; metadata is not a benchmark', () => {
  const data = { openai: { name: 'OpenAI', models: {} }, google: { name: 'Google', models: {} } };
  for (let i = 0; i < 12; i++) data.openai.models[`new-${i}`] = { id: `new-${i}`, name: `New ${i}`, modalities: { input: ['text'], output: ['text'] }, cost: { input: 1, output: 2 }, limit: { context: 4096 } };
  const models = mergeCatalogues([], parseProviderCatalogue(data, '2026-10-15T00:00:00Z'));
  assert.equal(models.length, 12); assert.ok(models.every(m => m.endpoints[0].source === 'modelsdev' && !m.evidence.length));
  assert.throws(() => parseProviderCatalogue({}, '2026-10-15'), /Invalid/);
});
test('ambiguous visual separation asks about outputs; low-confidence research is not a required capability', () => {
  const a = answers({ task_kind: 'visual_unspecified', vision: 'required', knowledge: 'required' });
  a.find(a => a.name === 'knowledge').confidence = .12;
  const t = interpretDecisions(a);
  assert.ok(t.clarification); assert.equal(t.weights.knowledge, undefined);
  const r = recommend(index, 'Separate the animals from the photo', Date.now(), t);
  assert.equal(r.ranking.mode, 'clarification'); assert.equal(r.recommendations.length, 0);
});
test('labels, boxes, masks and arbitrary extraction have distinct eligible contracts', () => {
  for (const m of contractModels()) {
    assert.ok(endpointFit(m, task('classify', true)));
    assert.equal(endpointFit(m, task('extract', true)), 0);
    assert.equal(endpointFit(m, task('segment', true)), 0);
    assert.equal(endpointFit(m, { ...task('classify'), needsTools: true }), 0);
    if (m.endpoint.detection === 'single-box') {
      assert.equal(endpointFit(m, { ...task('detect', true), outputCardinality: 'all-or-unspecified' }), 0);
      assert.ok(endpointFit(m, { ...task('detect', true), outputCardinality: 'single' }));
    }
  }
});
test('classification estimates a short label and keeps unknown charges unknown', () => {
  const r = recommend(index, 'Classify this image using my labels', Date.now(), { ...task('classify', true), specialistMatch: allowProfiles(snapshot, p => p.pipeline === 'zero-shot-image-classification' && p.subject === null) });
  assert.equal(r.ranking.mode, 'task-fit'); assert.equal(r.ranking.workload.outputTokens, 16);
  assert.ok(r.recommendations.every(m => m.quality === null && m.score === null && m.endpoint));
  assert.ok(r.recommendations.some(m => m.endpoint.protocol === 'decisions'));
  assert.ok(r.recommendations.some(m => m.endpoint.protocol === 'systemone'));
  assert.ok(r.recommendations.some(m => m.endpoint.deployment === 'self-hosted'));
  assert.equal(referenceWork({ inputPrice: .01, outputPrice: null }, { inputTokens: 100, outputTokens: 1 }).cost, null);
  assert.equal(referenceWork({ inputPrice: null, outputPrice: 0 }, { inputTokens: 100, outputTokens: 1 }).cost, null);
  assert.equal(referenceWork({ inputPrice: -1, outputPrice: -1 }, { inputTokens: 100, outputTokens: 1 }).cost, null);
});
test('changing model/provider names cannot change a non-tied task-fit order', () => {
  const models = [1, 3, 2, 4, 5, 6].map(n => ({ id: `provider/${n}`, modalities: ['text'], inputPrice: n, outputPrice: 0, endpoint: { id: `host:${n}`, operations: ['classify'], deployment: 'hosted' } }));
  const ordered = orderTaskEndpoints(models, task('classify')).selected.map(c => c.model.inputPrice);
  assert.deepEqual(ordered, [1, 2, 3, 4, 5]);
  assert.deepEqual(orderTaskEndpoints(models.toReversed().map(m => ({ ...m, id: `different/${m.inputPrice}`, provider: 'Renamed' })), task('classify')).selected.map(c => c.model.inputPrice), ordered);
});
test('one model does not gain ranking votes from extra endpoints; quality/timing do not migrate', () => {
  const m = { id: 'lab/a', modalities: ['text'], parameters: [], speed: { tokensPerSecond: 50, timeToFirstAnswer: 1 }, endpoints: [1, 2].map(n => ({ id: `route:${n}`, inputPrice: n, outputPrice: n, modalities: ['text'], parameters: [] })) };
  const expanded = expandEndpoints([m], '2026-10-15');
  // Unbound model-level timing is a labelled fallback on every route.
  assert.ok(expanded.every(m => m.speed?.scope === 'model'));
  // Timing measured on one route never migrates to another.
  const bound = expandEndpoints([{ ...m, speed: { ...m.speed, endpointId: 'route:1' } }], '2026-10-15');
  assert.deepEqual(bound.map(m => m.speed?.scope ?? null), ['endpoint', null]);
  assert.equal(bestEndpointPerModel(expanded.map(model => ({ model })), task('classify'))[0].model.endpoint.id, 'route:1');
});
test('fixed label sets and domain-specific models do not become arbitrary classifiers', () => {
  const repo = { id: 'lab/test', pipeline: 'image-classification', revision: 'a'.repeat(40), labels: ['normal', 'nsfw'], tags: [], languages: [], evaluations: [], providers: [] };
  assert.equal(hubEndpointModels({ specialists: [repo] }, task('classify', true), 'Label an image as indoor or outdoor').length, 0);
  assert.equal(hubEndpointModels({ specialists: [{ ...repo, id: 'lab/medical', pipeline: 'zero-shot-image-classification' }] }, task('classify', true), 'Label indoor or outdoor').length, 0);
  assert.equal(hubEndpointModels({ specialists: [{ ...repo, pipeline: 'zero-shot-object-detection' }] }, task('segment', true), 'Mask the object').length, 0);
});
test('HTTP endpoint selection is exact; legacy model inventory cannot grant a direct endpoint', async () => {
  const endpoint = contractModels()[0];
  const t = task('classify', true), run = (i, p, models, endpoints) => recommend(i, p, Date.now(), t, undefined, models ?? null, endpoints ?? null);
  const args = { prompt: 'Label a photo', endpointIds: [endpoint.endpoint.id] };
  const request = (path, data) => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const http = await (await handleAPI(request('api/recommend', args), index, {}, run)).json();
  assert.equal(http.recommendations.length, 1); assert.equal(http.recommendations[0].endpoint.id, endpoint.endpoint.id);
  assert.equal(run(index, args.prompt, [], undefined).recommendations.length, 0);
  assert.equal(run(index, args.prompt, undefined, []).recommendations.length, 0);
  assert.ok(run(index, args.prompt, [endpoint.id], undefined).recommendations.every(m => m.endpoint.source === 'models'));
  let calls = 0; const noCall = () => { calls++; };
  assert.equal((await handleAPI(request('api/recommend', { prompt: 'task', endpointIds: ['x', 'x'] }), index, {}, noCall)).status, 400); assert.equal(calls, 0);
});

test('router services and negative price sentinels cannot enter model candidates', () => {
  assert.ok(snapshot.catalogue.every(m => !m.id.startsWith('openrouter/')));
  for (const t of [task('classify'), task('classify', true), task('judge')]) {
    const r = recommend(index, 'Label or judge supplied content', Date.now(), t);
    assert.ok(r.recommendations.every(m => m.reference.costUsd === null || m.reference.costUsd >= 0));
    assert.equal(new Set(r.recommendations.map(m => m.modelId)).size, r.recommendations.length);
  }
});
