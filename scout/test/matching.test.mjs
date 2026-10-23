import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import { parseProviderCatalogue } from '../catalogue.mjs';
import { compileSnapshot } from '../sources.mjs';
import { createIndex, recommend, selectSnapshot } from '../rank.mjs';
import { handleAPI } from '../http.mjs';
import { allowProfiles } from './helpers-specialists.mjs';

const now = Date.parse(snapshot.checkedAt);
const task = (kind = 'extract', priority = 'balanced') => ({ kind, labelSpace: kind === 'classify' ? 'supplied' : null, weights: { structured: 3 }, needsStructured: true,
  workload: { input: 'short', output: 'short', priority }, outputContract: kind === 'classify' ? 'labels' : 'text' });
function model(id, overrides = {}) {
  const m = { id, name: id, provider: 'Test', modalities: ['text', 'image'], outputModalities: ['text'], parameters: ['structured_outputs'],
    inputPrice: 1, outputPrice: 2, context: 32768, speed: null,
    evidence: [{ benchmark: 'fixture', score: .8, url: 'https://example.com/evaluation', configurations: ['default'] }], ...overrides };
  m.endpoints ??= [{ id: `test:chat:${id}`, modelId: id, protocol: 'chat-completions', source: 'modelsdev', deployment: 'hosted',
    modalities: m.modalities, outputModalities: m.outputModalities, parameters: m.parameters, inputPrice: m.inputPrice, outputPrice: m.outputPrice }];
  return m;
}
const indexFor = models => createIndex({ version: 1, dataVersion: 5, checkedAt: snapshot.checkedAt, sources: [], availableModels: models.length,
  benchmarks: [{ id: 'fixture', name: 'Fixture', source: 'test', tags: ['structured', 'vision'] }], models, catalogue: models });
const run = (index, t, args) => recommend(index, args.prompt, now, t, { version: 1, profiles: [] }, args.modelIds ?? null, args.endpointIds ?? null);
test('verified classification evidence outranks unmeasured native contracts in the evidence engine',()=>{
 const index=indexFor([model('lab/evaluated')]);
 const t={...task('classify'),servingEngine:'evidence',needsVision:true,evidenceMatch:{ids:['fixture'],assessments:[]}};
 const result=run(index,t,{prompt:'Return the category for a supplied photo.'});
 assert.equal(result.ranking.mode,'benchmarks');assert.deepEqual(result.recommendations.map(m=>m.modelId),['lab/evaluated']);assert.equal(result.recommendations[0].evidence.length,1);
 const empty=run(index,{...t,evidenceMatch:{ids:[],assessments:[]}},{prompt:'Return the category for a supplied photo.'});
 assert.equal(empty.ranking.mode,'task-fit');assert.ok(empty.recommendations.every(m=>m.quality===null));
});
async function throughTransports(index, t, args) {
  const invoke = (i, prompt, modelIds, endpointIds) => run(i, t, { prompt, modelIds, endpointIds });
  const post = (path, body) => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const api = await handleAPI(post('api/recommend', args), index, {}, invoke);
  assert.equal(api.status, 200);
  return [await api.json()];
}

test('classification, judgments and benchmark tasks share endpoint capability requirements over HTTP', async () => {
  const valid = model('lab/valid');
  const invalid = [model('lab/plain', { parameters: [] }), model('lab/text-only-input', { modalities: ['text'] }),
    model('lab/mixed-output', { outputModalities: ['text', 'audio'] }), model('lab/unknown-output', { outputModalities: undefined })];
  const index = indexFor([...invalid, valid]);
  for (const kind of ['classify', 'judge', 'extract']) {
    const t = { ...task(kind), needsVision: true };
    for (const response of await throughTransports(index, t, { prompt: 'Read the image and return strict JSON', endpointIds: [...invalid, valid].map(m => m.endpoints[0].id) })) {
      assert.deepEqual(response.recommendations.map(m => m.modelId), [valid.id]);
    }
  }
  // Declaring tools is also required in the benchmark/measured path.
  assert.deepEqual(run(indexFor([valid]), { ...task(), needsTools: true }, { prompt: 'Use a function' }).recommendations, []);
});

test('catalogue refresh admits text-output contracts, not text accompanying media', () => {
  const data = { openai: { name: 'OpenAI', models: {} }, google: { models: {} } };
  for (let i = 0; i < 12; i++) data.openai.models[`valid-${i}`] = { id: `valid-${i}`, modalities: { input: ['text', 'image'], output: ['text'] } };
  for (const [id, output] of [['audio', ['text', 'audio']], ['image', ['image', 'text']], ['video', ['text', 'video']], ['unknown', undefined]]) {
    data.openai.models[id] = { id, modalities: { input: ['text'], output }, structured_output: true };
  }
  const parsed = parseProviderCatalogue(data, snapshot.checkedAt);
  assert.equal(parsed.length, 12);
  assert.ok(parsed.every(m => m.endpoints[0].outputModalities.length === 1 && m.endpoints[0].outputModalities[0] === 'text'));

  const router = { data: snapshot.models.slice(0, 20).map(m => ({ id: m.id, name: m.name, canonical_slug: m.canonical,
    architecture: { input_modalities: m.modalities, output_modalities: ['text'] }, supported_parameters: m.parameters,
    pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: m.context })) };
  router.data.push({ ...router.data[0], id: 'lab/song', architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } });
  const prepared = compileSnapshot({ router, previous: snapshot, checkedAt: snapshot.checkedAt });
  assert.equal(prepared.dataVersion, 7);
  assert.ok(!prepared.catalogue.some(m => m.id === 'lab/song'));
  assert.ok(prepared.catalogue.flatMap(m => m.endpoints).every(e => e.outputModalities?.join() === 'text'));
  const legacy = { ...snapshot, dataVersion: 4, checkedAt: new Date(now + 3600_000).toISOString() };
  assert.equal(selectSnapshot(prepared, legacy), prepared, 'A newer legacy cache cannot restore unchecked output contracts');
});

test('unknown and partial prices survive HTTP formatting while genuine zero remains zero', async () => {
  for (const [inputPrice, outputPrice] of [[null, null], [null, 2], [1, null], [undefined, 0], [0, 0]]) {
    const index = indexFor([model('lab/pricing', { inputPrice, outputPrice })]);
    for (const t of [task(), task('classify')]) {
      for (const response of await throughTransports(index, t, { prompt: 'Return JSON', endpointIds: ['test:chat:lab/pricing'] })) {
        const [m] = response.recommendations;
        assert.equal(m.pricing.inputPerMillion, inputPrice ?? null);
        assert.equal(m.pricing.outputPerMillion, outputPrice ?? null);
        assert.equal(m.reference.costUsd, inputPrice == null || outputPrice == null ? null : 0);
        if (response.ranking.mode === 'benchmarks') assert.equal(m.pricing.blendedPerMillion, inputPrice == null || outputPrice == null ? null : 0);
      }
    }
  }
});

test('all endpoint inventories suppress separate specialist discovery without affecting unscoped discovery', async () => {
  const index = createIndex(snapshot), t = { ...task(), needsVision: true, weights: { documents: 3, vision: 3, structured: 3 }, workload: { input: 'medium', output: 'short', priority: 'balanced' } };
  t.specialistMatch = allowProfiles(snapshot, p => p.operation === 'documents');
  const prompt = 'Read an invoice image and extract vendor, date and total as JSON';
  const unscoped = run(index, t, { prompt });
  assert.ok(unscoped.specialists.candidates.length > 0);
  const endpointId = unscoped.recommendations[0].endpoint.id;
  for (const endpointIds of [[], ['unknown:missing'], [endpointId]]) {
    for (const response of await throughTransports(index, t, { prompt, endpointIds })) {
      assert.deepEqual(response.specialists.candidates, []);
      assert.deepEqual(response.selection.endpointIds, endpointIds);
      assert.ok(response.recommendations.every(m => endpointIds.includes(m.endpoint.id)));
      assert.equal(response.recommendations.length, endpointIds[0] === endpointId ? 1 : 0);
    }
  }
  const intersected = run(index, t, { prompt, modelIds: [], endpointIds: [endpointId] });
  assert.deepEqual(intersected.recommendations, []);
  assert.deepEqual(intersected.specialists.candidates, []);
});

test('latency preference selects the measured faster route in both task-fit and benchmark modes', async () => {
  const m = model('lab/routes');
  const base = m.endpoints[0];
  m.endpoints = [{ ...base, id: 'test:cheap', inputPrice: .1, outputPrice: .1 }, { ...base, id: 'test:fast', inputPrice: 1, outputPrice: 1 }];
  m.speed = { endpointId: 'test:fast', timeToFirstAnswer: .1, tokensPerSecond: 100 };
  for (const endpoints of [m.endpoints, m.endpoints.toReversed()]) {
    const index = indexFor([{ ...m, endpoints }]);
    for (const kind of ['classify', 'extract']) for (const priority of ['balanced', 'cost', 'quality', 'latency']) {
      for (const response of await throughTransports(index, task(kind, priority), { prompt: 'Return JSON', endpointIds: endpoints.map(e => e.id) })) {
        assert.equal(response.recommendations.length, 1);
        const [chosen] = response.recommendations;
        assert.equal(chosen.endpoint.id, priority === 'latency' ? 'test:fast' : 'test:cheap');
        assert.equal(chosen.reference.completionSeconds, priority === 'latency' ? (kind === 'classify' ? .26 : 1.38) : null);
      }
    }
  }
  // With no endpoint-bound timings, latency priority falls back to known cost.
  m.speed = { timeToFirstAnswer: .1, tokensPerSecond: 100 };
  assert.equal(run(indexFor([m]), task('extract', 'latency'), { prompt: 'Return JSON' }).recommendations[0].endpoint.id, 'test:cheap');
});
test('agentic evaluations are left out when a non-coding task calls no tools, unless nothing else was accepted',()=>{
 const index=createIndex({ version: 1, dataVersion: 5, checkedAt: snapshot.checkedAt, sources: [], availableModels: 3,
   benchmarks: [{ id: 'prose', name: 'Prose', source: 'test', tags: ['analysis'] }, { id: 'loop', name: 'Loop', source: 'test', tags: ['analysis', 'agents', 'tools'] }],
   models: ['lab/a', 'lab/b', 'lab/c'].map((id, i) => model(id, { evidence: [{ benchmark: 'prose', score: .6 + i / 20, url: 'https://example.com/p', configurations: ['default'] }, { benchmark: 'loop', score: .9 - i / 5, url: 'https://example.com/l', configurations: ['default'] }] })) });
 const t={...task('other'),weights:{analysis:3},needsStructured:false,servingEngine:'evidence',evidenceMatch:{ids:['prose','loop'],assessments:[]}};
 const result=run(index,t,{prompt:'Prioritize these fixes.'});
 assert.ok(result.recommendations.every(m=>m.evidence.every(e=>e.benchmark==='Prose')));
 assert.ok(result.warnings.some(w=>w.includes('Loop')&&w.includes('does not call tools')));
 const only=run(index,{...t,evidenceMatch:{ids:['loop'],assessments:[]}},{prompt:'Prioritize these fixes.'});
 assert.ok(only.recommendations.length&&only.recommendations.every(m=>m.evidence.some(e=>e.benchmark==='Loop')));
});
