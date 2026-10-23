import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import { decisionQuestions, interpretDecisions } from '../decisions.mjs';
import { createRecommender } from '../recommend.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { contractModels, endpointSupports, hubEndpointModels } from '../endpoints.mjs';
import { measuredCandidates } from '../task-evidence.mjs';
import { workloadFor } from '../comparison.mjs';
import { handleAPI } from '../http.mjs';
import { semanticAnswers } from './helpers-specialists.mjs';

const now = Date.parse(snapshot.checkedAt), index = createIndex(snapshot);
const answers = (choices = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .95,
  choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'other' }[q.name] ?? 'absent') }));
const cases = [
  { name: 'bird identification', prompt: "users's upload photos of birds and we need to find the name of it and arrange it in the alphabetic order", labelSpace: 'open', vision: true },
  { name: 'plant identification', prompt: 'Identify the plant species in an uploaded photo and return its common and scientific names.', labelSpace: 'open', vision: true },
  { name: 'supplied visual labels', prompt: 'Classify each photo using only these supplied labels: indoor or outdoor.', labelSpace: 'supplied', vision: true },
  { name: 'supplied ticket labels with JSON', prompt: 'Classify support tickets into billing, technical or account. Return strict JSON with category and confidence.', labelSpace: 'supplied', vision: false, json: true },
];

for (const c of cases) test(`${c.name}: HTTP preserves label contracts and batch specialist compatibility`, async () => {
  let calls = 0;
  const invoke = createRecommender({ apiKey: 'test-only', now: () => now, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/decisions');
    const request = JSON.parse(options.body);
    assert.equal(JSON.parse(request.input.slice(request.input.indexOf('\n') + 1)).task, c.prompt);
    if (request.questions[0].name.startsWith('match_')) return Response.json({ answers: semanticAnswers(request.questions) });
    assert.ok(request.questions.some(q => q.name === 'label_space'));
    return Response.json({ answers: answers({ task_kind: 'classify', result_type: 'labels', label_space: c.labelSpace,
      vision: c.vision ? 'required' : 'absent', knowledge: c.labelSpace === 'open' ? 'required' : 'absent', json: c.json ? 'yes' : 'no' }) });
  } });
  const post = (path, body) => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const api = await handleAPI(post('api/recommend', { prompt: c.prompt }), index, {}, invoke);
  assert.equal(api.status, 200);
  assert.equal(calls, c.vision && c.labelSpace === 'supplied' ? 2 : 1);
  const result = await api.json();
  assert.equal(result.task.labelSpace, c.labelSpace);
  assert.equal(result.recommendations.length, 5);
  assert.equal(result.ranking.mode, c.labelSpace === 'open' ? 'benchmarks' : 'task-fit');
  if (c.labelSpace === 'open') {
    assert.ok(result.recommendations.every(m => !m.endpoint.operations && m.modalities.includes('image')));
    assert.ok(result.recommendations.every(m => m.evidence.length > 0));
    assert.deepEqual(result.specialists.candidates, [], 'Label-dependent classifiers cannot reappear through discovery');
    assert.ok(result.warnings.some(w => /specific identities/.test(w)));
  } else {
    assert.ok(result.recommendations.some(m => m.endpoint.protocol === 'decisions'));
    if (c.vision) assert.ok(result.recommendations.some(m => m.endpoint.protocol === 'zero-shot-image-classification'));
  }
  if (c.json) assert.ok(result.recommendations.every(m => m.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))));
});

test('missing, uncertain and low-confidence label sets cannot grant fixed-choice eligibility', () => {
  for (const labelSpace of [undefined, null, 'open', 'unspecified']) {
    const task = { kind: 'classify', labelSpace, needsVision: true, weights: { vision: 3 }, workload: { input: 'medium', output: 'short', priority: 'balanced' } };
    for (const model of contractModels()) {
      assert.equal(endpointSupports(model, task), false);
      const scoped = recommend(index, 'Name the bird', now, task, undefined, null, [model.endpoint.id]);
      assert.deepEqual(scoped.recommendations, []);
    }
    assert.deepEqual(hubEndpointModels(snapshot, task, 'Name the bird'), []);
    assert.deepEqual(recommend(index, 'Name the bird', now, task).specialists.candidates, []);
  }
  for (const label_space of ['absent', 'unspecified', 'supplied']) {
    const a = answers({ task_kind: 'classify', result_type: 'labels', label_space });
    if (label_space === 'supplied') a.find(a => a.name === 'label_space').confidence = .2;
    assert.equal(interpretDecisions(a).labelSpace, 'unspecified');
  }
  const unrelated = interpretDecisions(answers({ task_kind: 'code', label_space: 'unspecified' }));
  assert.equal(unrelated.labelSpace, null); assert.ok(!unrelated.uncertainty.includes('label_space'));
  assert.ok(contractModels().every(m => endpointSupports(m, { kind: 'judge', needsVision: true })));
});

test('open visual identification cannot rank a model on text-only benchmarks', () => {
  const prepared = structuredClone(snapshot);
  const vision = new Set(prepared.benchmarks.filter(b => b.tags.includes('vision')).map(b => b.id));
  for (const model of prepared.models) model.evidence = model.evidence.filter(e => !vision.has(e.benchmark));
  const task = interpretDecisions(answers({ task_kind: 'classify', result_type: 'labels', label_space: 'open', vision: 'required', knowledge: 'required' }));
  const result = recommend(createIndex(prepared), 'Identify a bird from a photo', now, task);
  assert.deepEqual(result.recommendations, []);
  assert.equal(workloadFor(task).outputTokens, 128, 'Naming entities is not priced as one fixed 16-token choice');
});

test('fixed-choice calibration is not reused for open identification', () => {
  const task = { kind: 'classify', labelSpace: 'open', weights: { vision: 3 }, needsVision: true, workload: { input: 'medium', output: 'short', priority: 'balanced' } };
  const models = Array.from({ length: 5 }, (_, i) => ({ id: `test/${i}`, cases: 6, quality: .8, medianSeconds: 1, meanCostUsd: .001 }));
  const candidates = models.map(m => ({ model: { id: m.id } }));
  const profile = { scope: { kind: 'classify', vision: true, tools: false, structured: false, input: 'medium', output: 'short', capabilities: ['vision'] }, split: 'calibration', measuredAt: snapshot.checkedAt, models };
  for (const labelSpace of [undefined, 'supplied', 'unspecified']) {
    assert.equal(measuredCandidates(candidates, task, now, { version: 1, profiles: [{ ...profile, scope: { ...profile.scope, labelSpace } }] }), null);
  }
  assert.equal(measuredCandidates(candidates, task, now, { version: 1, profiles: [{ ...profile, scope: { ...profile.scope, labelSpace: 'open' } }] }).candidates.length, 5);
});
