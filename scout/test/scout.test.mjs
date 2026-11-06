import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { createIndex, indexStatus } from '../rank.mjs';
import { toRecords, toSnapshot } from '../records.mjs';
import { parseCSV, parseAnalysis, compileSnapshot, refreshSnapshot, parseOmniDoc, parseVectara, parseArena, parseVals, readVals, valsSlugs, parseSeal, readSeal, sealBoards, parseVendorScores,
  readLiveBench, readTau, parseOpenCompass, readHELM, parseBRIDGE, readSuperCLUE, superclueURL, superclueCategories, parseFireworks } from '../sources.mjs';
import { evaluationKey } from '../comparison.mjs';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);

test('stale status comes from source check time', () => {
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
  const status = indexStatus(sample);
  assert.equal(status.models, 4);
  assert.equal(status.providers, 2);
  assert.equal(indexStatus(createIndex({ ...snapshot, models: models.slice(0, 2) })).providers, 1);
});

test('CSV parsing preserves quotes, commas, newlines, zero, and blank cells', () => {
  assert.deepEqual(parseCSV('name,score,note\r\n"A, B",0,"one\n""two"""\r\nC,,x'), [
    { name: 'A, B', score: '0', note: 'one\n"two"' }, { name: 'C', score: '', note: 'x' },
  ]);
  assert.throws(() => parseCSV('a\n"bad'), /Unterminated/);
});

function fixtures() {
  const models = Array.from({ length: 12 }, (_, i) => ({ id: `lab/model-${i}`, canonical_slug: `lab/model-${i}-2026-10-01`, name: `Lab: Model ${i}`, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '.000001', completion: '.000002' }, supported_parameters: ['response_format'] }));
  const rows = models.map((m, i) => ({ slug: `model-${i}`, name: m.name.slice(5), scores: { 'gpqa-diamond': i / 12 }, outputSpeed: 100, timeToFirstToken: 1, deprecated: false }));
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
  // "+" names a different model (Command A+ is not Command A), so neither name is ambiguous.
  const plus = fixtures();
  plus.router.data.push({ ...plus.router.data[6], id: 'lab/model-6-plus', canonical_slug: 'lab/model-6-plus', name: 'Lab: Model 6+' });
  plus.epochZip = zipSync({ 'benchmark_metadata.csv': strToU8('benchmark,source_file,score_column,scale\n' + Array.from({ length: 10 }, (_, i) => `Bench${i},results.csv,Score,1`).join('\n')), 'results.csv': strToU8('Model version,Score\nModel 6,0.3\nModel 6+,0.7\n') });
  const scored = compileSnapshot(plus).models, bench0 = id => scored.find(m => m.id === id)?.evidence.find(e => e.benchmark === 'epoch:Bench0')?.score;
  assert.deepEqual([bench0('lab/model-6'), bench0('lab/model-6-plus')], [.3, .7]);
});

test('reference speed preserves first-answer delay and does not mistake reasoning tokens for an answer', () => {
  const input = fixtures(), rows = parseAnalysis(input.analysisHTML);
  Object.assign(rows[0], { isReasoning: true, timeToFirstToken: .1, timeToFirstAnswerToken: 12 });
  Object.assign(rows[1], { isReasoning: true, timeToFirstToken: .2 });
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
  const refreshed = await refreshSnapshot(fetcher); assert.equal(calls.length, 83, 'feeds, plus one page per Vals AI benchmark and per Scale SEAL board, the first file of LiveBench, τ-bench, OpenCompass, HELM and BRIDGE (each stops when it is not their data), six SuperCLUE months and the Fireworks index'); assert.equal(refreshed.models.length, 12);
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
  // A benchmark that drops out of the feed keeps its last published definition and scores; one still listed is refreshed.
  const dropped = { ...data, benchmarks: data.benchmarks.filter(b => b.benchmark_id !== 'gpqa'), models: models.map(m => ({ ...m, benchmark_scores: { ...m.benchmark_scores, pct: score(5) } })) };
  const next = compileSnapshot({ ...fixtures(), vendorScores: dropped, previous: snap });
  assert.deepEqual(next.benchmarks.find(b => b.id === 'vendor:gpqa')?.definition, snap.benchmarks.find(b => b.id === 'vendor:gpqa').definition);
  assert.equal(next.models.find(m => m.id === 'lab/model-2')?.evidence.find(e => e.benchmark === 'vendor:gpqa')?.score, .2);
  assert.equal(next.models.find(m => m.id === 'lab/model-2')?.evidence.filter(e => e.benchmark === 'vendor:pct').map(e => e.score).join(), '0.05');
  assert.throws(() => parseVendorScores({ benchmarks: [], models: [] }), /Too few/);
});
test('Scale SEAL boards drop contaminated and deprecated rows, read harness efforts as run settings and keep a failed board\'s evidence', async () => {
  const entry = (model, score, extra = {}) => ({ model, version: '', rank: 1, score, confidenceInterval_upper: 1, contaminationMessage: '', company: 'lab', createdAt: '2026-10-20T00:00:00.000Z', deprecated: false, ...extra });
  const line = rows => `1b:${JSON.stringify(['$', 'div', null, { children: ['$', '$L1d', null, { entries: rows }] }])}\n`;
  const page = rows => `<meta property="og:title" content="Legal &amp; Tax"/><meta name="description" content="Legal reasoning."/><script>self.__next_f.push([1,${JSON.stringify(line(rows))}])</script>`;
  const rows = [entry('model-0 (Codex) max', 40), entry('model-1', 50, { createdAt: '2026-10-27T01:00:00.000Z' }), entry('model-2', 99, { contaminationMessage: 'Evaluated after public release.' }),
    entry('model-3', 98, { deprecated: true }), ...Array.from({ length: 9 }, (_, i) => entry(`other-${i}`, 10 + i))];
  const read = async url => url.endsWith('/rli') ? Promise.reject(new Error('down')) : page(rows);
  const seal = await readSeal(read);
  assert.deepEqual(seal.missing, ['rli']);
  const board = seal.boards[0];
  assert.deepEqual([board.name, board.updated, board.rows.length, board.rows[0]], ['Legal & Tax', '2026-10-27', 11, { model: 'model-0 (Codex) (max)', score: .4, observedAt: '2026-10-20' }]);
  assert.ok(!board.rows.some(r => ['model-2', 'model-3'].includes(r.model)));
  assert.throws(() => parseSeal('x', '<html></html>'), /format changed/);
  const previous = { benchmarks: [{ id: 'seal:rli', name: 'RLI · SEAL', source: 'seal', tags: [], definition: {} }], models: [{ id: 'lab/model-0', evidence: [{ benchmark: 'seal:rli', score: .2 }] }], sources: [] };
  const snap = compileSnapshot({ ...fixtures(), seal, previous });
  const score = (id, b) => snap.models.find(m => m.id === id)?.evidence.find(e => e.benchmark === b)?.score;
  assert.deepEqual([score('lab/model-0', 'seal:prbench-legal'), score('lab/model-1', 'seal:prbench-legal'), score('lab/model-2', 'seal:prbench-legal'), score('lab/model-0', 'seal:rli')], [.4, .5, undefined, .2]);
  assert.equal(sealBoards.length, new Set(sealBoards).size);
  // Unrelated boards are separate families; legal and finance PRBench are one.
  const family = id => snap.benchmarks.find(b => b.id === id)?.family;
  assert.equal(family('seal:prbench-legal'), 'seal:prbench');
  assert.deepEqual(new Set(sealBoards.map(b => `seal:${b.split('-')[0]}`)).size, 8);
});

test('LiveBench, τ-bench, OpenCompass, HELM Arabic, BRIDGE and SuperCLUE keep the right score, scale and rows, each as its own family', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `model-${i}`);
  // LiveBench: the newest release in the bundle's literal list; each category column, never the overall.
  const lbPages = { 'https://livebench.ai/': '<script defer src="./static/js/main.ab12.js"></script>', 'https://livebench.ai/static/js/main.ab12.js': 'Yt=["20261025","20261014"],en=["2024-06-24"]',
    'https://livebench.ai/data/20261025/table.csv': `model,overall,coding,reasoning,design\n${names.map((n, i) => `${n},99,${i === 1 ? '' : 10 * i},50,40`).join('\n')}\n`,
    'https://livebench.ai/data/20261025/categories.json': { Coding: ['coding'], Reasoning: ['reasoning'], Design: ['design'], _overall_weights: { Coding: 1.5 } } };
  const livebench = await readLiveBench(async url => url.endsWith('breakdown.json') ? Promise.reject(new Error('down')) : lbPages[url] ?? Promise.reject(new Error(`unexpected ${url}`)));
  assert.deepEqual([livebench.release, livebench.publishedAt, livebench.categories.map(c => c.column)], ['20261025', '2026-10-25', ['coding', 'reasoning', 'design']]);
  // τ-bench: Sierra's standard text runs on harness 1.x, pass^1; banking only with AllTools retrieval.
  const sub = (i, extra = {}) => ({ model_name: `Model ${i}`, submitting_organization: 'Sierra', submission_type: 'standard', modality: 'text', reasoning_effort: 'high', submission_date: '2026-08-04',
    methodology: { tau2_bench_version: '1.0.1', evaluation_date: '2026-08-03' }, results: { airline: { pass_1: 10 * i, pass_4: 1 }, banking_knowledge: { pass_1: 5 * i, retrieval_config: i === 2 ? 'terminal' : 'alltools' } }, ...extra });
  const subs = { 'm0_sierra_2026-08-04': sub(0), 'm1_sierra_2026-08-04': sub(1), 'm2_sierra_2026-08-04': sub(2), 'm3_sierra_2026-08-04': sub(3), 'm4_sierra_2026-08-04': sub(4), 'm5_sierra_2026-08-04': sub(5),
    'm6_sierra_2026-08-04': sub(6, { submission_type: 'custom' }), 'm7_sierra_2026-08-04': sub(7, { methodology: { tau2_bench_version: '0.1.3' } }), 'm8_sierra_2026-08-04': sub(8, { submitting_organization: 'Lab' }) };
  const tauBase = 'https://sierra-tau-bench-public.s3.us-west-2.amazonaws.com/submissions';
  const tauRead = async url => url === `${tauBase}/manifest.json` ? { submissions: [...Object.keys(subs), 'm9_lab_2026-08-04'] } : subs[url.slice(tauBase.length + 1, -'/submission.json'.length)] ?? Promise.reject(new Error(`unexpected ${url}`));
  const tau = await readTau(tauRead);
  assert.deepEqual(tau.domains.map(d => [d.id, d.rows.length]), [['airline', 6], ['banking_knowledge', 5]]);
  assert.deepEqual(tau.domains[0].rows[1], { model: 'Model 1 (high)', score: .1, observedAt: '2026-08-03' });
  // OpenCompass: each ability table's own average (not the overall table); safety is not read.
  const ability = (n, offset) => names.map((key, i) => ({ key, Average: offset + i, Part: 1 })).reverse();
  const opencompass = { modelBase: Object.fromEntries(names.map((key, i) => [key, { model: `Model ${i} (max)`, date: '2026/10/23' }])), OverallTable: ability(0, 90),
    KnowledgeTable: ability(0, 10), AbstractionTable: ability(0, 20), ReasoningTable: ability(0, 30), InteractionTable: ability(0, 40), AgentTable: ability(0, 50), SafetyTable: ability(0, 60) };
  assert.ok(!parseOpenCompass(opencompass).abilities.some(a => a.id === 'safety'));
  // HELM Arabic: the newest release by version number (v10 after v9), the mean column, and only models with every scenario.
  const helmBase = 'https://storage.googleapis.com/crfm-helm-public/arabic/benchmark_output/releases';
  const cell = value => ({ value });
  const helmRows = names.map((n, i) => [cell(`Model ${i} (2026-01-02)`), cell(i / 20), cell(.9), cell(i === 4 ? undefined : .9), cell(.9)]);
  const helmFiles = { [`${helmBase}/v10.0.0/summary.json`]: { date: '2026-06-25' }, [`${helmBase}/v10.0.0/schema.json`]: { models: names.map((n, i) => ({ name: i === 7 ? 'lab/large-2411' : `lab/${n}-2026-01-02`, display_name: `Model ${i} (2026-01-02)` })) },
    [`${helmBase}/v10.0.0/groups/json/arabic_scenarios_accuracy.json`]: { header: ['Model', 'Mean score', 'A - EM', 'B - EM', 'C - Score'].map(value => ({ value })), rows: helmRows } };
  const helm = await readHELM(async url => url.includes('storage/v1/b/') ? { prefixes: ['arabic/benchmark_output/releases/v9.0.0/', 'arabic/benchmark_output/releases/v10.0.0/'] } : helmFiles[url] ?? Promise.reject(new Error(`unexpected ${url}`)));
  assert.deepEqual([helm.release, helm.rows.length, helm.scenarios], ['v10.0.0', 11, ['A', 'B', 'C']]);
  // BRIDGE: HTML stripped from names, 0–100 averages, a thinking mode read as a run setting.
  const bridge = { Model: Object.fromEntries(names.map((n, i) => [i, i === 3 ? `<a href="x">${n}-Thinking</a>` : n]).concat(names.map((n, i) => [12 + i, `other-${i}`]))), 'Average Performance': Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i, String(i === 5 ? 140 : i)])) };
  assert.equal(parseBRIDGE(bridge).length, 23);
  // SuperCLUE: the newest month that is not a 404, read by header label, not column position.
  const sheet = rows => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" ${typeof v === 'number' ? `t="n"><v>${v}</v>` : `t="inlineStr"><is><t>${v.replace(/[^\x00-\x7f]/g, c => `&#${c.codePointAt(0)};`)}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const labels = superclueCategories.map(c => c[0]).reverse();
  const xlsx = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet([['排名', '模型名称', '总分', ...labels], ...names.map((n, i) => [String(i), `${n}(max)`, 99, 10 * i, ...labels.slice(1).map(() => 50)])])), 'docProps/core.xml': strToU8('<dcterms:created xsi:type="dcterms:W3CDTF">2023-05-12T19:15:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-10T09:55:33Z</dcterms:modified>') });
  const now = new Date('2026-10-29T00:00:00Z'), notFound = Promise.reject(new Error('Source returned 404: www.superclueai.com')); notFound.catch(() => {});
  const superclue = await readSuperCLUE(async url => url === superclueURL(2026, 9) ? xlsx : url === superclueURL(2026, 7) ? Promise.reject(new Error('stale')) : notFound, now);
  assert.deepEqual([superclue.month, superclue.publishedAt, superclue.rows[2].scores[superclueCategories.at(-1)[1]]], ['2026-09', '2026-09-10', 20]);
  // A timeout on the newest month must not fall back to an older board.
  await assert.rejects(readSuperCLUE(async url => url === superclueURL(2026, 10) ? Promise.reject(new Error('timeout')) : xlsx, now), /timeout/);
  const snap = compileSnapshot({ ...fixtures(), livebench, tau, opencompass, helm, bridge, superclue });
  const score = (id, b) => snap.models.find(m => m.id === `lab/${id}`)?.evidence.find(e => e.benchmark === b)?.score;
  assert.deepEqual([score('model-2', 'livebench:coding'), score('model-1', 'livebench:coding'), score('model-0', 'livebench:coding')], [.2, undefined, 0]);
  assert.deepEqual([score('model-3', 'tau:airline'), score('model-2', 'tau:banking_knowledge'), score('model-8', 'tau:airline'), score('model-6', 'tau:airline')], [.3, undefined, undefined, undefined]);
  assert.deepEqual([score('model-3', 'opencompass:knowledge'), score('model-3', 'opencompass:agent')], [.13, .53]);
  // Model 7's display name strips to "Model 7", but its ID names another model.
  assert.deepEqual([score('model-6', 'helm:arabic'), score('model-4', 'helm:arabic'), score('model-7', 'helm:arabic')], [.3, undefined, undefined]);
  assert.deepEqual([score('model-3', 'bridge:zero-shot'), score('model-5', 'bridge:zero-shot')], [.03, undefined]);
  assert.equal(score('model-2', 'superclue:long-context'), .2);
  // A category the board retires keeps its last definition and scores, so the publish guard accepts the refresh.
  const retired = { ...snap.benchmarks.find(b => b.id === 'superclue:math-science'), id: 'superclue:math', name: 'SuperCLUE · Mathematical reasoning' };
  const before = { ...snap, benchmarks: [...snap.benchmarks, retired],
    models: snap.models.map(m => m.id === 'lab/model-2' ? { ...m, evidence: [...m.evidence, { ...m.evidence.find(e => e.benchmark === 'superclue:math-science'), benchmark: 'superclue:math', score: .42 }] } : m) };
  const after = compileSnapshot({ ...fixtures(), livebench, tau, opencompass, helm, bridge, superclue, previous: before });
  assert.deepEqual([after.benchmarks.find(b => b.id === 'superclue:math')?.name, after.models.find(m => m.id === 'lab/model-2')?.evidence.find(e => e.benchmark === 'superclue:math')?.score], ['SuperCLUE · Mathematical reasoning', .42]);
  const ids = ['livebench:coding', 'livebench:reasoning', 'tau:airline', 'tau:banking_knowledge', 'opencompass:knowledge', 'opencompass:agent', 'helm:arabic', 'bridge:zero-shot', 'superclue:math-science', 'superclue:long-context'];
  const families = ids.map(id => snap.benchmarks.find(b => b.id === id)?.family);
  assert.deepEqual([families.includes(undefined), new Set(families).size, snap.benchmarks.filter(b => ids.includes(b.id) && b.definition.suite).length], [false, ids.length, 0]);
  // Sierra's banking run is the same evaluation Artificial Analysis publishes; its other names stay distinct.
  assert.equal(evaluationKey(snap.benchmarks.find(b => b.id === 'tau:banking_knowledge').name), evaluationKey('τ-Bench Banking · AA'));
  assert.notEqual(evaluationKey('OpenCompass · Reasoning'), evaluationKey('LiveBench 2.0 · Reasoning'));
});

test('the Fireworks index keeps 0–100 headline scores of plain ranked model runs, each benchmark its own family', () => {
  const names = Array.from({ length: 12 }, (_, i) => `model-${i}`), result = (model, value, extra = {}) => ({ rank: 1, ranked: true, model, provider: 'Lab', metrics: { score: { value }, cost_per_task: { value: 99 } }, ...extra });
  const board = (id, label, rows, unit = 'percent') => ({ id: `domain/${id}`, name: id.toUpperCase(), url: `https://fireworks.ai/specialized-intelligence-index/benchmarks/domain/${id}`, domain: 'Legal', contributor: 'Firm', description: 'Contract review.',
    headline_metric: { label, unit, direction: 'desc' }, reproducibility: { level: 'provider' }, last_updated: '2026-10-28', results: rows });
  const plain = names.flatMap((n, i) => n === 'model-5' ? [] : [result(n, 5 * i)]);
  const data = { status: 'published', url: 'https://fireworks.ai/specialized-intelligence-index', last_updated: '2026-10-30', benchmarks: [
    // A run inside another product (†), a rejected-tasks run (*) and an unranked row are not plain model runs; "· high" is a run setting.
    board('contracts', 'Score (pass@1)', [...plain, result('model-1†', 99), result('model-2*', 98), result('model-4', 97, { ranked: false }), result('model-3 · high', 95), result('model-5 · high', 80)]),
    // Elo, dollars and a relative score above 100 are not shares of tasks.
    board('elo', 'Score (Elo)', names.map((n, i) => result(n, 1200 + i))), board('cash', 'Score (current cash, USD)', names.map((n, i) => result(n, i))),
    board('relative', 'Score (quality)', names.map((n, i) => result(n, 95 + i))), board('diagnosis', 'Score (Diagnosis Elo)', names.map((n, i) => result(n, i)), 'Elo points'),
    ...Array.from({ length: 19 }, (_, i) => board(`b${i}`, 'Score', plain)),
  ] };
  const index = parseFireworks(data);
  assert.deepEqual([index.publishedAt, index.boards.length, index.boards.some(b => ['elo', 'cash', 'relative', 'diagnosis'].includes(b.id))], ['2026-10-30', 20, false]);
  assert.throws(() => parseFireworks({ ...data, benchmarks: data.benchmarks.slice(0, 10) }), /format changed/);
  const snap = compileSnapshot({ ...fixtures(), fireworks: data });
  const score = id => snap.models.find(m => m.id === `lab/${id}`)?.evidence.find(e => e.benchmark === 'fireworks:contracts')?.score;
  // "· high" is a run setting of the same model, as "(high)" is elsewhere: model 3's two runs share a median.
  assert.deepEqual(['model-1', 'model-2', 'model-3', 'model-4', 'model-5'].map(id => Math.round(score(id) * 100) / 100), [.05, .1, .55, .2, .8]);
  assert.deepEqual(snap.models.find(m => m.id === 'lab/model-3').evidence.find(e => e.benchmark === 'fireworks:contracts').configurations, ['model-3', 'model-3 (high)']);
  const contracts = snap.benchmarks.find(b => b.id === 'fireworks:contracts');
  assert.deepEqual([contracts.family, contracts.publishedAt, contracts.definition.metric], ['fireworks:contracts', '2026-10-28', 'pass@1 / 100']);
  assert.equal(evaluationKey(contracts.name), evaluationKey('CONTRACTS · vendor-reported'));
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
