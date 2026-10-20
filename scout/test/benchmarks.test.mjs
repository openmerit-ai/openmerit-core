import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBenchmarks, refreshBenchmarks, benchmarkVersion } from '../benchmarks.mjs';
import { parseEpochDefinitions, readEpochDefinitions, benchmarkIdentity, methodologySections } from '../benchmark-metadata.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { benchmarkFamily } from '../comparison.mjs';

const bench = (id, description = 'Test scope') => ({ id, name: id, source: 'fixture', definition: { title: id, description }, tags: ['reasoning'] });
const mock = (choose = () => 'absent', capture = () => {}) => async (_url, options) => {
  const body = JSON.parse(options.body); capture(body);
  return Response.json({ answers: body.questions.map(q => ({ type: 'choice', name: q.name, choice: q.name==='family' ? 'none' : q.name.startsWith('section_') ? 'yes' : choose(q), confidence: .99 })) });
};
const settings = fetcher => ({ apiKey: 'test', fetcher });

test('benchmark tags come only from validated Decisions answers, never old tags or name patterns', async () => {
  const [b] = await prepareBenchmarks([bench('OCR JSON memory reasoning')], [], settings(mock(q => q.name==='coding' ? 'supported' : 'absent')));
  assert.deepEqual(b.tags, ['coding']); assert.equal(b.interpretation.version, benchmarkVersion);
  assert.equal(b.family, b.id);
});

test('unknown scopes and weak positive answers remain unclassified', async () => {
  const [b] = await prepareBenchmarks([bench('Opaque')], [], settings(async (_u, o) => Response.json({ answers: JSON.parse(o.body).questions.map((q, i) => ({ type: 'choice', name: q.name, choice: i ? 'unknown' : 'supported', confidence: i ? 1 : .39 })) })));
  assert.deepEqual(b.tags, []); assert.equal(b.interpretation.status, 'ready');
});

test('unchanged metadata, score updates, timestamps and ordering reuse interpretations with zero requests', async () => {
  const before = await prepareBenchmarks([bench('a'), bench('b')], [], settings(mock()));
  let calls = 0;
  const next = await prepareBenchmarks(before.map(b => ({ ...b, score: .9, checkedAt: 'later' })).reverse(), before, settings(mock(undefined, () => calls++)));
  assert.equal(calls, 0); assert.deepEqual(next.map(b => b.interpretation), before.map(b => b.interpretation).reverse());
});

test('changed scope reinterprets only that series; methodology changes invalidate their dependents; appending a later series preserves earlier families', async () => {
  const before = await prepareBenchmarks([bench('a'), bench('b')], [], settings(mock()));
  const ids = [];
  await prepareBenchmarks([bench('a', 'Changed scope'), bench('b')], before, settings(mock(undefined, b => ids.push(...[JSON.parse(b.input.split('\n').at(-1)).benchmark.id]))));
  assert.deepEqual(ids, ['a']);
  let calls = 0;
  await prepareBenchmarks(before, before, { ...settings(mock(undefined, () => calls++)), methodologies: { fixture: { sections: [{title:'Scope',text:'new methodology'}] } } }); assert.equal(calls, 4);
  calls = 0; await prepareBenchmarks([...before, bench('c')], before, settings(mock(undefined, () => calls++))); assert.equal(calls, 1);
});

test('a failed changed batch excludes unprepared evidence without discarding unchanged cached series, and is retried', async () => {
  const before = await prepareBenchmarks([bench('a'), bench('b')], [], settings(mock(() => 'supported')));
  const next = await prepareBenchmarks([bench('a', 'changed'), bench('b')], before, settings(async () => { throw new Error('unavailable'); }));
  assert.deepEqual(next[0].tags, before[0].tags); assert.equal(next[0].refreshPending, true); assert.deepEqual(next[1].tags, before[1].tags);
  let calls = 0; const retried = await prepareBenchmarks([bench('a','changed'),next[1]], next, settings(mock(undefined, () => calls++)));
  assert.equal(calls, 1); assert.equal(retried[0].interpretation.status, 'ready');
});

for (const bad of ['missing', 'duplicate', 'wrong-choice', 'bad-confidence', 'refusal']) test(`malformed ${bad} response cannot grant benchmark evidence`, async () => {
  const next = await prepareBenchmarks([bench('a')], [], settings(async (_u, o) => {
    let answers = JSON.parse(o.body).questions.map(q => ({ name: q.name, type: 'choice', choice: 'supported', confidence: .99 }));
    if (bad === 'missing') answers.pop();
    if (bad === 'duplicate') answers[1].name = answers[0].name;
    if (bad === 'wrong-choice') answers[0].choice = 'invented';
    if (bad === 'bad-confidence') answers[0].confidence = 2;
    if (bad === 'refusal') answers[0].type = 'refusal';
    return Response.json({ answers });
  }));
  assert.deepEqual(next[0].tags, []); assert.equal(next[0].interpretation.status, 'unavailable');
});

test('family links are validated, deterministic and resolved during preparation', async () => {
  const next = await prepareBenchmarks([bench('c'), bench('a'), bench('b')].map(b=>({...b,name:'Shared evaluation '+b.name})), [], settings(async (_u, o) => Response.json({ answers: JSON.parse(o.body).questions.map(q => ({ name: q.name, type: 'choice', choice: q.name==='family' ? 'a' : 'absent', confidence: 1 })) })));
  assert.deepEqual(next.map(b => b.family), ['a', 'a', 'a']);
  assert.equal(benchmarkFamily({ id: 'gpqa-v1', name: 'GPQA' }), 'gpqa-v1');
  assert.equal(benchmarkFamily({ id: 'gpqa-v2', name: 'GPQA' }), 'gpqa-v2');
});

test('large inventories use bounded batches and bounded choice lists', async () => {
  let calls = 0;
  await prepareBenchmarks(Array.from({ length: 205 }, (_, i) => bench(String(i).padStart(3, '0'))), [], settings(mock(undefined, b => {
    calls++; assert.ok(b.questions.length <= 180); assert.ok(b.questions.every(q => q.choices.length <= 201));
  })));
  assert.ok(calls > 1);
});

test('refresh marks interpretation failure while preserving collected prices, results and source state', async () => {
  const snapshot = { benchmarks: [bench('a')], models: [{ inputPrice: .4, evidence: [] }], sources: [{ id: 'fixture', status: 'ok', checkedAt: 'today' }] };
  const next = await refreshBenchmarks(snapshot, null, settings(async () => { throw new Error(); }));
  assert.deepEqual(next.models, snapshot.models); assert.equal(next.sources[0].status, 'failed'); assert.match(next.sources[0].error, /semantic/);
  assert.deepEqual(next.benchmarks[0].tags, []);
});

test('ranking consumes prepared tags and families synchronously, excluding unknown-only evidence', async () => {
  const benchmarks = await prepareBenchmarks([bench('a'), bench('b')], [], settings(async(u,o)=>{const b=JSON.parse(o.body),id=JSON.parse(b.input.split('\n').at(-1)).benchmark.id;return mock(q=>id==='a'&&q.name==='coding'?'supported':'unknown')(u,o);}));
  const model = (id, benchmark) => ({ id, name: id, provider: 'fixture', inputPrice: 1, outputPrice: 1, modalities: ['text'], outputModalities: ['text'], evidence: [{ benchmark, score: .8, configurations: ['test'] }] });
  const index = createIndex({ version: 1, checkedAt: new Date().toISOString(), models: [model('lab/known', 'a'), model('lab/unknown', 'b')], benchmarks, sources: [] });
  const task = { kind: 'code', weights: { coding: 3 }, capabilities: [{ id: 'coding', label: 'Code' }], workload: { input: 'short', output: 'medium', priority: 'balanced' } };
  const result = recommend(index, 'Implement a function', Date.now(), task, { version: 1, profiles: [] });
  assert.deepEqual(result.recommendations.map(m => m.modelId), ['lab/known']); assert.equal(typeof result.then, 'undefined');
});

const catalogue = () => 'var entries={' + Array.from({ length: 10 }, (_, i) => `b${i}:{id: \`Bench_${i}\`,title:"Title ${i}",short_description:'Reads \\'quoted\\' text',methodology:\`Line 1\nLine 2\`,domains:["Reasoning"]}`).join(',') + '};globalThis.untrustedMetadataExecuted=true;';

test('publisher data parser reads escaped literals without executing scripts or interpolations', () => {
  const defs = parseEpochDefinitions(catalogue());
  assert.equal(Object.keys(defs).length, 10); assert.equal(defs.bench0.description, "Reads 'quoted' text"); assert.equal(defs.bench0.methodology, 'Line 1\nLine 2');
  assert.equal(globalThis.untrustedMetadataExecuted, undefined);
  assert.equal(benchmarkIdentity('ARC_AGI-2'), benchmarkIdentity('ARC-AGI 2'));
  assert.throws(() => parseEpochDefinitions('var x={id:`${attack()}`,title:"t",description:"d"}'), /format/);
});

test('description loader follows only bounded publisher data links', async () => {
  const seen = [];
  const defs = await readEpochDefinitions(async url => {
    seen.push(url);
    if (url.endsWith('/benchmarks')) return '<astro-island component-url="/_astro/OverviewSearch.test.js">';
    if (url.includes('OverviewSearch')) return 'import {x} from "./benchmarks.wrapper.js"; import y from "https://attacker.invalid/data.js";';
    if (url.includes('wrapper')) return 'import {x} from "./benchmarks.data.js";';
    return catalogue();
  });
  assert.equal(Object.keys(defs).length, 10); assert.equal(seen.length, 4); assert.ok(seen.every(u => u.startsWith('https://epoch.ai/')));
});

test('methodology extraction retains section boundaries and excludes scripts', () => {
  const sections = methodologySections('<script>attack()</script><h1>Guide</h1>Scope<h2>First</h2>Images &amp; text<h2>Second</h2>Tool use');
  assert.deepEqual(sections, [{ title: 'Guide', text: 'Scope' }, { title: 'First', text: 'Images & text' }, { title: 'Second', text: 'Tool use' }]);
});

test('shared methodology is narrowed before capability interpretation; sibling sections cannot lend evidence', async () => {
  let calls = 0;
  const methodologies = { fixture: { url: 'https://example.org/method', sections: [{ title: 'Sibling', text: 'Persistent memory with tools' }, { title: 'Exact subset', text: 'Plain text spelling accuracy' }] } };
  const fetcher = async (_u, o) => {
    const body = JSON.parse(o.body); calls++;
    if (body.questions[0].name.startsWith('section_')) return Response.json({answers:body.questions.map((q,i)=>({name:q.name,type:'choice',choice:i===1?'yes':'no',confidence:.99}))});
    const input = JSON.parse(body.input.split('\n').at(-1));
    assert.deepEqual(input.methodology, [methodologies.fixture.sections[1]]);
    assert.ok(!body.input.includes('Persistent memory'));
    return mock()(_u, o);
  };
  const prepared = await prepareBenchmarks([bench('exact')], [], { ...settings(fetcher), methodologies });
  assert.equal(calls, 2); assert.deepEqual(prepared[0].methodologySelection.sections.map(s=>s.title), ['Exact subset']);
  await prepareBenchmarks(prepared, prepared, { ...settings(fetcher), methodologies }); assert.equal(calls, 2);
});

test('publisher-declared suite identity groups metrics without benchmark-name rules', async () => {
  const entries = [bench('a'), bench('b'), bench('c')];
  for (const b of entries.slice(0, 2)) b.definition.suite = 'Publisher-declared suite v9';
  const prepared = await prepareBenchmarks(entries, [], settings(mock()));
  assert.equal(prepared[0].family,prepared[1].family);assert.match(prepared[0].family,/^suite:/);assert.equal(prepared[2].family,'c');
});
