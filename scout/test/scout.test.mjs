import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { createIndex, recommend as rankTask, indexStatus } from '../rank.mjs';
import { toRecords, toSnapshot } from '../records.mjs';
import offlineTasks from './fixtures/offline-tasks.json' with {type:'json'};
// Explicit historical task objects test arithmetic and transports, not interpretation.
const fixtureTask = prompt => {const task=offlineTasks[prompt];if(!task)throw Error('Missing typed test fixture');return structuredClone(task);};
const recommend=(index,prompt)=>rankTask(index,prompt,Date.now(),fixtureTask(prompt));
import { parseCSV, parseAnalysis, compileSnapshot, refreshSnapshot, parseOmniDoc, parseVectara, parseArena, parseVals, readVals, valsSlugs, parseVendorScores } from '../sources.mjs';
import { handleAPI as api } from '../http.mjs';

const handleAPI=(request,index)=>api(request,index,{},recommend);
const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);
const post = body => new Request('http://localhost/scout/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('invoice recommendations require real document evidence, image input, JSON support and five distinct IDs', () => {
  const result = recommend(index, 'Upload an invoice and extract 6 fields as JSON');
  assert.equal(result.recommendations.length, 5);
  assert.equal(new Set(result.recommendations.map(m => m.id)).size, 5);
  for (const model of result.recommendations) {
    assert.ok(model.modalities.includes('image'));
    assert.ok(model.parameters.some(p => ['structured_outputs', 'response_format'].includes(p)));
    // Document evidence, or labelled general image evidence when no document result exists.
    assert.ok(model.evidence.some(e => e.capabilities.includes('documents')) || model.missingEvidence?.includes('documents') && model.evidence.some(e => e.capabilities.includes('vision')), model.id);
    if (model.missingEvidence) assert.ok(result.warnings.some(w => w.includes(model.name) && w.includes('no document-reading benchmark')));
    assert.ok(model.evidence.every(e => /^https?:/.test(e.url) && e.configurations.length));
  }
  if (result.recommendations.some(m => m.evidence.some(e => e.source === 'openvlm'))) assert.ok(result.warnings.some(w => w.includes('Newer models')));
});

test('task changes produce different rankings; writing tests does not select creative-writing evidence', () => {
  const code = recommend(index, 'Fix a bug in a TypeScript repository and write unit tests');
  const invoice = recommend(index, 'Extract invoice fields as JSON');
  assert.notDeepEqual(code.recommendations.map(m => m.id), invoice.recommendations.map(m => m.id));
  assert.ok(code.recommendations.every(m => m.evidence.some(e => /code|swe|terminal|aider|weirdml|cursor|gso/i.test(e.benchmark))));
});



test('scores are finite, quality is bounded, missing speed stays null, and increased price cannot improve rank score', () => {
  for (const prompt of ['Debug Python code', 'Research a question', 'Write a story', 'Extract invoice fields as JSON']) {
    const result = recommend(index, prompt);
    for (const m of result.recommendations) { assert.ok(Number.isFinite(m.score)); assert.ok(m.quality >= 0 && m.quality <= 100); if (!m.speed) assert.equal(m.speed, null); }
  }
  const baseline = recommend(index, 'Research a scientific question').recommendations[0];
  const modified = structuredClone(snapshot), model = modified.models.find(m => m.id === baseline.modelId);
  model.inputPrice *= 100; model.outputPrice *= 100;
  model.endpoints?.forEach(e => { e.inputPrice *= 100; e.outputPrice *= 100; });
  const result = recommend(createIndex(modified), 'Research a scientific question').recommendations.find(m => m.id === baseline.modelId);
  assert.ok(!result || result.score < baseline.score);
});

test('limited evidence never fills five slots and stale status comes from source check time', () => {
  const tiny = createIndex({ ...snapshot, models: snapshot.models.slice(0, 1) });
  assert.ok(recommend(tiny, 'Read an invoice').recommendations.length < 5);
  // Feeds refresh every twelve hours: a fresh run is never stale, a missed one is.
  assert.equal(indexStatus(index, Date.parse(snapshot.checkedAt) + 12 * 3600_000).stale, false);
  assert.ok(indexStatus(index, Date.parse(snapshot.checkedAt) + 14 * 3600_000).stale);
  assert.equal(indexStatus(index, Date.parse(snapshot.checkedAt)).stale, false);
});

test('index coverage counts providers once across aliases and label variations', async () => {
  const model = snapshot.models[0];
  const models = [
    { ...model, id: 'meta/muse', provider: 'Meta' },
    { ...model, id: 'meta-llama/llama', provider: 'Meta' },
    { ...model, id: 'mistralai/large', provider: 'Mistral' },
    { ...model, id: 'mistralai/small', provider: 'mistralai' },
  ];
  const sample = createIndex({ ...snapshot, models });
  const status = await (await handleAPI(new Request('http://localhost/scout/api/status'), sample)).json();
  assert.equal(status.models, 4);
  assert.equal(status.providers, 2);
  assert.equal(indexStatus(createIndex({ ...snapshot, models: models.slice(0, 2) })).providers, 1);
});

test('API validates method, content type, shape, empty and oversized input; prompts are not cached', async () => {
  const valid = await handleAPI(post({ prompt: 'Debug Python code' }), index);
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.ok(valid.headers.get('server-timing').startsWith('scout;dur='));
  const result = await valid.json();
  assert.equal(result.recommendations.length, 5);
  assert.deepEqual(result.recommendations.map(m => m.id), recommend(index, 'Debug Python code').recommendations.map(m => m.id));
  for (const body of [{ prompt: '' }, { prompt: ' ' }, { prompt: 5 }, { prompt: 'x'.repeat(4001) }, { prompt: 'hello', limit: 5 }, null, []]) assert.equal((await handleAPI(post(body), index)).status, 400);
  assert.equal((await handleAPI(new Request('http://localhost/scout/api/recommend'), index)).status, 405);
  assert.equal((await handleAPI(new Request('http://localhost/scout/api/recommend', { method: 'POST', body: '{}' }), index)).status, 415);
  assert.equal((await handleAPI(post({ prompt: 'x'.repeat(20000) }), index)).status, 413);
  const malformed = new Request('http://localhost/scout/api/recommend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal((await handleAPI(malformed, index)).status, 400);
  assert.equal((await handleAPI(new Request('http://localhost/scout/api/missing'), index)).status, 404);
});

test('recommendations make no network calls and leave the shared snapshot unchanged', async t => {
  const before = JSON.stringify(snapshot);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call during ranking'); });
  const response = await handleAPI(post({ prompt: 'Read an invoice as JSON' }), index);
  assert.equal(response.status, 200); assert.equal((await response.json()).recommendations.length, 5);
  assert.equal(JSON.stringify(snapshot), before);
});

test('CSV parsing preserves quotes, commas, newlines, zero, and blank cells', () => {
  assert.deepEqual(parseCSV('name,score,note\r\n"A, B",0,"one\n""two"""\r\nC,,x'), [
    { name: 'A, B', score: '0', note: 'one\n"two"' }, { name: 'C', score: '', note: 'x' },
  ]);
  assert.throws(() => parseCSV('a\n"bad'), /Unterminated/);
});

function fixtures() {
  const models = Array.from({ length: 12 }, (_, i) => ({ id: `lab/model-${i}`, canonical_slug: `lab/model-${i}-2026-10-01`, name: `Lab: Model ${i}`, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '.000001', completion: '.000002' }, supported_parameters: ['response_format'] }));
  const rows = models.map((m, i) => ({ slug: `model-${i}`, name: m.name.slice(5), scores: { 'gpqa-diamond': i / 12 }, medianOutputTokensPerSecond: 100, medianTimeToFirstTokenSeconds: 1, deprecated: false }));
  const flight = `a:${JSON.stringify({ models: rows })}\n`;
  const analysisHTML = `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
  const metadata = 'benchmark,source_file,score_column,scale\n' + Array.from({ length: 10 }, (_, i) => `Bench${i},results.csv,Score,1`).join('\n');
  const results = 'Model version,Score\nmodel-0_high,0\nmodel-1_high,\nmodel-1_high,0.5\nmodel-2_high,2\n';
  return { router: { data: models }, epochZip: zipSync({ 'benchmark_metadata.csv': strToU8(metadata), 'results.csv': strToU8(results) }), analysisHTML, openvlm: { time: '20250917132916', results: {} }, checkedAt: '2026-10-14T00:00:00Z' };
}

test('source ingestion preserves zero, rejects out-of-range and missing scores, and retains evaluation configuration', () => {
  const data = compileSnapshot(fixtures());
  const zero = data.models.find(m => m.id === 'lab/model-0').evidence.find(e => e.benchmark === 'epoch:Bench0');
  assert.equal(zero.score, 0); assert.deepEqual(zero.configurations, ['model-0_high']);
  assert.equal(data.models.find(m => m.id === 'lab/model-1').evidence.find(e => e.benchmark === 'epoch:Bench0').score, .5);
  assert.ok(!data.models.find(m => m.id === 'lab/model-2').evidence.some(e => e.benchmark === 'epoch:Bench0'));
  assert.equal(data.sources.find(s => s.id === 'openvlm').publishedAt, '2025-09-17');
  assert.throws(() => parseAnalysis('<script>throw new Error("not data")</script>'), /format changed/);
});

test('catalogue models join before benchmark matching unless an existing model uses their name, and persist without D1', () => {
  const input = fixtures();
  const results = 'Model version,Score\nmodel-1_high,0.5\nhost-x_high,0.7\n';
  input.epochZip = zipSync({ 'benchmark_metadata.csv': strToU8('benchmark,source_file,score_column,scale\n' + Array.from({ length: 10 }, (_, i) => `Bench${i},results.csv,Score,1`).join('\n')), 'results.csv': strToU8(results) });
  const listed = (id, name) => ({ id, name, provider: 'Other', canonical: id, repository: null, modalities: ['text'], outputModalities: ['text'], parameters: [], context: null, facts: [], inputPrice: 1, outputPrice: 2, speed: null, evidence: [],
    endpoints: [{ id: `catalogue:host:chat-completions:${id}`, provider: 'Host', modelId: id, api: 'https://host.example/v1/chat/completions', protocol: 'chat-completions', inputPrice: 1, outputPrice: 2, source: 'catalogue', url: 'https://host.example' }], listedBy: 'catalogue' });
  let seen;
  const catalogueSupply = { models: models => (seen = models.length, [listed('other/host-x', 'Host X'), listed('other/model-1', 'Model 1')]), aliases: () => new Map(), families: () => new Map() };
  const data = compileSnapshot({ ...input, catalogueSupply });
  assert.equal(seen, 12, 'the supply sees every feed model, so it can leave out linked ones');
  assert.equal(data.models.find(m => m.id === 'other/host-x')?.evidence.find(e => e.benchmark === 'epoch:Bench0')?.score, .7);
  assert.equal(data.models.find(m => m.id === 'lab/model-1').evidence.find(e => e.benchmark === 'epoch:Bench0').score, .5, 'an existing model keeps its name');
  assert.ok(!data.catalogue.some(m => m.id === 'other/model-1'), 'a possible duplicate of an existing model is left out');
  const kept = compileSnapshot({ ...input, previous: toSnapshot(toRecords(data)), checkedAt: '2026-10-14T12:00:00Z' });
  assert.equal(kept.models.find(m => m.id === 'other/host-x')?.evidence.find(e => e.benchmark === 'epoch:Bench0')?.score, .7);
});

test('benchmark rows match catalogue aliases and run settings, but never move a score matched under Scout\'s own name', () => {
  const input = fixtures();
  // An older dated snapshot of model 1, a host's name for model 3, a thinking budget, and a name the catalogue cannot place.
  const results = 'Model version,Score\nmodel-1_high,0.5\nmodel-1-0919_minimal,0.9\nhost-name-3 (FC),0.4\nmodel-4_32K,0.3\nunknown-x,0.2\n';
  input.epochZip = zipSync({ 'benchmark_metadata.csv': strToU8('benchmark,source_file,score_column,scale\n' + Array.from({ length: 10 }, (_, i) => `Bench${i},results.csv,Score,1`).join('\n')), 'results.csv': strToU8(results) });
  const catalogueSupply = { models: () => [], aliases: () => new Map([['model10919', 'lab/model-1'], ['hostname3', 'lab/model-3']]), families: () => new Map() };
  const data = compileSnapshot({ ...input, catalogueSupply });
  const score = id => data.models.find(m => m.id === id)?.evidence.find(e => e.benchmark === 'epoch:Bench0');
  assert.deepEqual([score('lab/model-1').score, score('lab/model-1').configurations], [.5, ['model-1_high']]);
  assert.equal(score('lab/model-3').score, .4);
  assert.equal(score('lab/model-4').score, .3);
  assert.deepEqual(data.sources.find(s => s.id === 'epoch').matching, { models: 5, matched: 4 });
  assert.deepEqual(data.unmatchedRows.epoch, ['unknown-x']);
  // Scout lists model 5 twice (as a native copy), so the name is ambiguous to Scout; it resolves
  // only when the catalogue links both entries to one model family.
  const twice = fixtures();
  twice.router.data.push({ ...twice.router.data[5], id: 'lab/model-5-native', canonical_slug: 'lab/model-5-native' });
  twice.epochZip = zipSync({ 'benchmark_metadata.csv': strToU8('benchmark,source_file,score_column,scale\n' + Array.from({ length: 10 }, (_, i) => `Bench${i},results.csv,Score,1`).join('\n')), 'results.csv': strToU8('Model version,Score\nModel 5,0.6\n') });
  const shared = families => compileSnapshot({ ...twice, catalogueSupply: { models: () => [], aliases: () => new Map([['model5', 'lab/model-5']]), families: () => new Map(families) } })
    .models.find(m => m.id === 'lab/model-5')?.evidence.find(e => e.benchmark === 'epoch:Bench0')?.score;
  assert.equal(shared([['lab/model-5', 'model5'], ['lab/model-5-native', 'model5']]), .6);
  assert.equal(shared([['lab/model-5', 'model5'], ['lab/model-5-native', 'other']]), undefined);
});

test('reference speed preserves first-answer delay and does not mistake reasoning tokens for an answer', () => {
  const input = fixtures(), rows = parseAnalysis(input.analysisHTML);
  Object.assign(rows[0], { isReasoning: true, medianTimeToFirstTokenSeconds: .1, medianTimeToFirstAnswerTokenSeconds: 12 });
  Object.assign(rows[1], { isReasoning: true, medianTimeToFirstTokenSeconds: .2 });
  const flight = `a:${JSON.stringify({ models: rows })}\n`;
  const data = compileSnapshot({ ...input, analysisHTML: `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>` });
  assert.equal(data.models[0].speed.timeToFirstAnswer, 12);
  assert.equal(data.models[0].speed.measurements[0].timeToFirstAnswer, 12);
  assert.equal(data.models[1].speed.timeToFirstAnswer, null);
});
test('serialized leaderboard records survive component property renames without executing source scripts',()=>{
 const rows=parseAnalysis(fixtures().analysisHTML);
 const flight=`ab:${JSON.stringify(['component',{children:{renamedProperty:rows}}])}\n`;
 assert.deepEqual(parseAnalysis(`<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`),rows);
 assert.throws(()=>parseAnalysis(`<script>self.__next_f.push([1,${JSON.stringify(`ab:${JSON.stringify({renamedProperty:rows.map(({slug,...m})=>m)})}\n`)}])</script>`),/format changed/);
});
test('a fresh table retains omitted historical observations only for an unchanged series',()=>{
 const input=fixtures(),previous=compileSnapshot(input),model=previous.models.find(m=>m.id==='lab/model-0');
 const old=model.evidence.find(e=>e.benchmark==='aa:gpqa');old.historical=true;
 const rows=parseAnalysis(input.analysisHTML);delete rows[0].scores['gpqa-diamond'];
 const flight=`a:${JSON.stringify({records:rows})}\n`,analysisHTML=`<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
 const next=compileSnapshot({...input,analysisHTML,previous});assert.deepEqual(next.models.find(m=>m.id===model.id).evidence.find(e=>e.benchmark==='aa:gpqa'),old);
 previous.benchmarks.find(b=>b.id==='aa:gpqa').definition.description='Published description.';
 const carried=compileSnapshot({...input,analysisHTML,previous});
 assert.equal(carried.benchmarks.find(b=>b.id==='aa:gpqa').definition.description,'Published description.');assert.deepEqual(carried.models.find(m=>m.id===model.id).evidence.find(e=>e.benchmark==='aa:gpqa'),old);
 // A description the page publishes defines the series; without one, the published description carries over.
 const described=analysisHTML.replace('</script>',`</script><script>self.__next_f.push([1,${JSON.stringify(`b:${JSON.stringify({gpqaSubLabel:'A different version.'})}\n`)}])</script>`);
 const changed=compileSnapshot({...input,analysisHTML:described,previous});assert.ok(!changed.models.find(m=>m.id===model.id).evidence.some(e=>e.benchmark==='aa:gpqa'));
});

test('refresh reads bounded benchmark methodology and catalogue feeds; total outage needs a previous index', async () => {
  const f = fixtures(); const calls = [];
  const fetcher = async url => { calls.push(url); return new Response(url.endsWith('.zip') ? f.epochZip : url.includes('artificialanalysis') ? f.analysisHTML : JSON.stringify(url.includes('OpenVLM') ? f.openvlm : f.router)); };
  const refreshed = await refreshSnapshot(fetcher); assert.equal(calls.length, 59, 'feeds, plus one page per Vals AI benchmark'); assert.equal(refreshed.models.length, 12);
  assert.equal(refreshed.sources.find(s => s.id === 'huggingface').status, 'failed');
  await assert.rejects(refreshSnapshot(async () => new Response('Unavailable', { status: 503 })), /Invalid model catalogue/);
});

test('snapshot coverage is real and every recorded benchmark and model reference resolves', () => {
  assert.ok(indexStatus(index).benchmarks >= 100);
  for (const model of snapshot.models) for (const e of model.evidence) {
    assert.ok(index.benchmarks.has(e.benchmark)); assert.ok(e.score >= 0 && e.score <= 1); assert.ok(e.configurations.length);
  }
});

const omniFixture = `<table><caption>Comprehensive evaluation of document parsing on OmniDocBench (v1.6_full)</caption><thead>Overall&#x2191;</thead><tbody>${[80, 70, 60].map((score, i) => `<tr><td>Model ${i}</td><td>General VLMs</td><td>-</td><td>${score}</td><td>0.1</td><td>90</td><td>90</td><td>90</td><td>0.1</td></tr>`).join('')}</tbody></table>`;

test('document leaderboard parser selects the named version and preserves published scores', () => {
  assert.equal(parseOmniDoc(omniFixture)[0].score, 80);
  assert.throws(() => parseOmniDoc(omniFixture.replace('v1.6_full', 'v2')), /format changed/);
  const data = compileSnapshot({ ...fixtures(), omnidocHTML: omniFixture });
  assert.equal(data.models[0].evidence.find(e => e.benchmark === 'omnidoc:v1.6_full').score, .8);
  assert.equal(data.models[0].evidence.find(e => e.benchmark === 'omnidoc:v1.6_full').observedAt, null);
});

test('partial refresh preserves only failed sources with original timestamps while refreshing prices', () => {
  const input = { ...fixtures(), omnidocHTML: omniFixture, hubRows: [{ id: 'lab/specialist', pipeline_tag: 'document-question-answering', sha: 'a'.repeat(40) }] };
  const previous = compileSnapshot(input);
  input.router.data[0].pricing.prompt = '.000003';
  input.router.data[0].expiration_date = '2026-12-01';
  const next = compileSnapshot({ ...input, previous, hubRows: null, analysisHTML: 'broken', checkedAt: '2026-10-14T03:00:00Z' });
  assert.deepEqual(next.models[0].endpoints[0].facts.map(f=>[f.field,f.value]),[['expiresAt','2026-12-01T00:00:00.000Z']]);
  assert.ok(!next.models[0].facts.some(f=>f.field==='expiresAt'), 'Route expiry must not apply to every host');
  assert.deepEqual(next.specialists, previous.specialists);
  assert.equal(next.sources.find(s => s.id === 'huggingface').status, 'failed');
  assert.equal(next.sources.find(s => s.id === 'huggingface').checkedAt, previous.checkedAt);
  const larger = { ...previous, specialists: Array.from({ length: 20 }, (_, i) => ({ ...previous.specialists[0], id: `lab/specialist-${i}` })) };
  const emptyHub = compileSnapshot({ ...input, previous: larger, hubRows: [] });
  assert.deepEqual(emptyHub.specialists, larger.specialists);
  assert.equal(emptyHub.sources.find(s => s.id === 'huggingface').status, 'failed');
  assert.equal(next.models[0].inputPrice, 3);
  assert.equal(next.sources.find(s => s.id === 'analysis').status, 'failed');
  assert.equal(next.sources.find(s => s.id === 'analysis').checkedAt, previous.checkedAt);
  assert.equal(next.sources.find(s => s.id === 'models').checkedAt, next.checkedAt);
  assert.deepEqual(next.models[0].evidence.filter(e => e.benchmark.startsWith('aa:')), previous.models[0].evidence.filter(e => e.benchmark.startsWith('aa:')));
  assert.ok(indexStatus(createIndex(next), Date.parse(next.checkedAt)).stale);
  assert.ok(indexStatus(createIndex(next)).degraded);
  const removed = compileSnapshot({ ...input, previous, router: { data: input.router.data.slice(1) } });
  assert.ok(!removed.models.some(m => m.id === 'lab/model-0'));
  const expired = compileSnapshot({...input,previous,checkedAt:'2026-12-01T00:00:00Z'});
  assert.ok(!expired.catalogue.some(m=>m.id==='lab/model-0'));
  const noCatalogue = compileSnapshot({ ...input, previous, router: null });
  assert.equal(noCatalogue.models[0].inputPrice, previous.models[0].inputPrice);
  assert.equal(noCatalogue.sources.find(s => s.id === 'models').status, 'failed');
});



test('a frozen runtime clock never reports a fabricated zero-millisecond computation', async t => {
  t.mock.method(performance, 'now', () => 0);
  const response = await handleAPI(post({ prompt: 'Debug Python code' }), index);
  assert.equal((await response.json()).elapsedMs, null);
  assert.equal(response.headers.get('server-timing'), null);
});
test('summary and human-preference parsers keep comparable rows and reject format changes', () => {
  const table = Array.from({ length: 22 }, (_, i) => `|lab/model-${i}-2026-03-17|${(2 + i / 10).toFixed(1)} %|${(98 - i / 10).toFixed(1)} %|${i === 3 ? '74.3' : '99.5'} %|120.0|`);
  const vectara = parseVectara(['Last updated on October 16, 2026', '', '|Model|Hallucination Rate|Factual Consistency Rate|Answer Rate|Average Summary Length (Words)|', '|----|----:|----:|----:|----:|', ...table, '', 'Notes'].join('\n'));
  // A model that declines a quarter of the documents is scored only on easy ones.
  assert.equal(vectara.rows.length, 21); assert.ok(!vectara.rows.some(r => r.name === 'lab/model-3-2026-03-17'));
  assert.equal(vectara.rows[0].consistency, 98); assert.equal(vectara.publishedAt, '2026-10-16');
  assert.throws(() => parseVectara('|Model|Rate|\n|--|--|'), /format changed/);
  const rows = Array.from({ length: 21 }, (_, i) => ({ model_name: `Model ${i}`, rating: 1300 + 10 * i, rating_lower: 1295 + 10 * i, rating_upper: 1305 + 10 * i + (i === 0 ? 80 : 0), category: 'expert', leaderboard_publish_date: '2026-10-20' }));
  const arena = parseArena(rows, ['expert']);
  // The median-rated model scores one half; a model 400 points above it, 10/11.
  assert.equal(arena.categories.expert.find(r => r.name === 'Model 10').score, .5);
  assert.ok(!arena.categories.expert.some(r => r.name === 'Model 0'));
  assert.throws(() => parseArena(rows.map((r, i) => ({ ...r, leaderboard_publish_date: i ? r.leaderboard_publish_date : '2026-09-01' })), ['expert']), /format changed/);
  assert.throws(() => parseArena(rows, ['missing']), /missing/);
  // Categories of one board can be published on different dates; each keeps its own, and an unused stale one is ignored.
  const vision = parseArena([...rows.map(r => ({ ...r, category: 'ocr' })), ...rows.map(r => ({ ...r, category: 'overall', leaderboard_publish_date: '2026-10-22' })),
    ...rows.map(r => ({ ...r, category: 'creative_writing', leaderboard_publish_date: '2026-01-09' }))], ['overall', 'ocr']);
  assert.deepEqual([vision.dates, vision.publishedAt], [{ overall: '2026-10-22', ocr: '2026-10-20' }, '2026-10-22']);
});
test('Vals AI benchmarks keep overall accuracy, read model keys and keep a failed page\'s previous evidence', async () => {
  const result = (id, accuracy) => [id, { accuracy, stderr: .5, provider: 'Host' }];
  const data = { metadata: { benchmark: 'MedCode', family: 'medcode', industry: 'healthcare', description: 'Medical coding.', updated: '2026-10-13', dataset_type: 'private' },
    tasks: { overall: Object.fromEntries([result('lab/model-0', 40), result('fireworks/lab/model-1', 50), result('lab/model-2-thinking', 60), result('lab/model-3-thinking', 70), result('lab/model-4', 101), result('lab/model-5', 30)]), other: {} } };
  const page = slug => `<meta name="description" content="${slug} benchmarks AI models on ICD-10-CM &amp; billing."><a href="/_astro/benchmark_view_${slug}.Ab1-2.json">`;
  const read = async url => url.endsWith('.json') ? data : url.endsWith('/medscribe') ? Promise.reject(new Error('down')) : page(url.split('/').pop());
  const vals = await readVals(read);
  assert.deepEqual(vals.missing, ['medscribe']);
  const medcode = vals.benchmarks.find(v => v.slug === 'medcode');
  // Out-of-range accuracy is dropped; the page summary joins the short description.
  assert.deepEqual([medcode.rows.length, medcode.description], [5, 'medcode benchmarks AI models on ICD-10-CM & billing. Medical coding.']);
  assert.throws(() => parseVals('x', { metadata: {}, tasks: {} }), /format changed/);
  const input = fixtures();
  // Model 3's own ID ends in "-thinking"; model 2's suffix is Vals' thinking setting.
  input.router.data[3] = { ...input.router.data[3], id: 'lab/model-3-thinking', canonical_slug: 'lab/model-3-thinking' };
  const previous = { benchmarks: [{ id: 'vals:medscribe', name: 'MedScribe · Vals AI', source: 'vals', tags: [], definition: {} }], models: [{ id: 'lab/model-0', evidence: [{ benchmark: 'vals:medscribe', score: .8 }] }], sources: [] };
  const snap = compileSnapshot({ ...input, vals, previous });
  const score = (id, b) => snap.models.find(m => m.id === id)?.evidence.find(e => e.benchmark === b)?.score;
  assert.deepEqual([score('lab/model-0', 'vals:medcode'), score('lab/model-1', 'vals:medcode'), score('lab/model-2', 'vals:medcode'), score('lab/model-3-thinking', 'vals:medcode')], [.4, .5, .6, .7]);
  assert.equal(score('lab/model-0', 'vals:medscribe'), .8);
  assert.equal(snap.benchmarks.find(b => b.id === 'vals:medcode').definition.suite, 'Vals AI · medcode');
  assert.equal(valsSlugs.length, new Set(valsSlugs).size);
});

test('vendor-reported scores keep only self-reported results on comparable scales and never match base checkpoints', () => {
  const bench = (id, max_score) => ({ benchmark_id: id, name: id.toUpperCase(), description: `${id} test.`, max_score, modality: 'text' });
  const score = (s, self_reported = true) => ({ score: s, self_reported, verified: false });
  // Model 1 reports a dated ID with an effort suffix; a Base row must not land on model 2's instruct entry.
  const models = Array.from({ length: 6 }, (_, i) => ({ model_id: `model-${i}`, name: `Model ${i}`, benchmark_scores: { gpqa: score(.1 * i), pct: score(10 * i), elo: score(1200 + i) } }));
  models[1].model_id = 'model-1-high-2026-01-02';
  models.push({ model_id: 'model-2-base', name: 'Model 2 (Base)', benchmark_scores: { gpqa: score(.99) } }, { model_id: 'model-3', name: 'Model 3', benchmark_scores: {} });
  models[4].benchmark_scores.gpqa = score(.95, false);
  const data = { benchmarks: [bench('gpqa', 1), bench('pct', 100), bench('elo', 3000), ...Array.from({ length: 20 }, (_, i) => bench(`b${i}`, 1))], models };
  for (let i = 0; i < 20; i++) for (const m of models.slice(0, 5)) m.benchmark_scores[`b${i}`] = score(.5);
  const parsed = parseVendorScores(data);
  assert.ok(!parsed.some(b => b.id === 'elo'), 'Elo-style scales are not comparable');
  assert.equal(parsed.find(b => b.id === 'pct').rows.find(r => r.id === 'model-3').score, .3);
  assert.ok(!parsed.find(b => b.id === 'gpqa').rows.some(r => r.id === 'model-4'), 'a third-party score is not vendor-reported');
  const snap = compileSnapshot({ ...fixtures(), vendorScores: data });
  const ev = (id, b) => snap.models.find(m => m.id === id)?.evidence.find(e => e.benchmark === b);
  assert.equal(ev('lab/model-1', 'vendor:gpqa').score, .1);
  assert.equal(ev('lab/model-2', 'vendor:gpqa').score, .2);
  assert.equal(ev('lab/model-2', 'vendor:gpqa').url, 'https://llm-stats.com/models/model-2');
  assert.equal(snap.benchmarks.find(b => b.id === 'vendor:gpqa').definition.reportedBy, 'vendor');
  assert.deepEqual(snap.unmatchedRows.vendor, ['model-2-base']);
  assert.throws(() => parseVendorScores({ benchmarks: [], models: [] }), /Too few/);
});

test('the IDP Leaderboard parser reads component scores from the rendered table and rejects format changes', async () => {
  const { parseIDP } = await import('../sources.mjs');
  const cell = v => `<td data-slot="table-cell"><span class="tabular-nums">${v}</span></td>`;
  const row = (name, ...scores) => `<tr data-slot="table-row">${cell(1)}<td data-slot="table-cell"><a class="font-medium" href="/models/x">${name}</a><span class="ml-2">Lab</span></td>${scores.map(cell).join('')}</tr>`;
  const head = '<thead><tr><th>#</th><th>Model</th><th>Overall</th><th>OlmOCR</th><th>OmniDoc</th><th>IDP</th></tr></thead>';
  const html = `<table>${head}<tbody>${['A', 'B', 'C', 'D', 'E'].map((n, i) => row(`Model ${n}`, 80 - i, 70 - i, 90 - i, 60 + i)).join('')}</tbody></table>`;
  const rows = parseIDP(html);
  // The publisher's Overall column is an average and is not imported.
  assert.deepEqual(rows[1], { name: 'Model B', scores: { olmocr: 69, omnidoc: 89, core: 61 } });
  assert.throws(() => parseIDP(html.replace('<th>IDP</th>', '<th>KIE</th>')), /format changed/);
  assert.throws(() => parseIDP(html.replace('>60<', '>n/a<')), /Invalid IDP/);
});
