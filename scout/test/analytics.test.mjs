import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchDataPoint, createSearchObserver, decodeSearchRecord } from '../analytics.mjs';
import { createRecommender } from '../recommend.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { capabilities } from '../capabilities.mjs';
import { decisionQuestions } from '../decisions.mjs';
import { handleAPI } from '../http.mjs';
import { handleMCP } from '../mcp.mjs';
import { gzipSync, strToU8 } from 'fflate';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);
const answers = (choices = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .9, choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'classify', result_type: 'labels', label_space: 'supplied' }[q.name] ?? q.choices[0].value) }));
const post = body => new Request('https://example.test/scout/api/recommend', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'visitor=private', 'user-agent': 'private-device', 'cf-connecting-ip': '192.0.2.99' }, body: JSON.stringify(body) });
const secret = 'private.person@example.invalid PRIVATE_CANARY_493';
const decode = point => decodeSearchRecord({ schemaVersion: point.blobs[0], payload: point.blobs[11], payloadEncoding: point.blobs[12] });

test('only explicit prompt and allowlisted public evidence cross the analytics boundary', () => {
  const poison = { prompt: secret, keywords: [secret], reason: secret, name: secret, provider: secret, error: secret, headers: { authorization: secret }, selection: { modelIds: [secret] } };
  const result = { ...poison, task: { ...poison, kind: secret, capabilities: [{ id: 'vision', label: secret }, { id: secret }], needsVision: true, outputContract: secret, interpreterVersion: secret, workload: { priority: secret, input: secret, output: secret } }, ranking: { mode: secret, version: secret, workload: poison }, checkedAt: secret,
    recommendations: [{ ...poison, modelId: secret, endpoint: { id: secret }, reference: { costUsd: null, completionSeconds: null, basis: secret } }] };
  const point = searchDataPoint({ result, channel: secret, outcome: secret, scope: secret, index: { snapshot: { checkedAt: secret, dataVersion: secret } } });
  assert.doesNotMatch(JSON.stringify(point), /PRIVATE_CANARY|example.invalid|authorization|keywords|visitor/);
  const safe = decode(point); assert.equal(safe.task.kind, 'unknown'); assert.deepEqual(safe.task.capabilities, ['vision']);
  assert.equal(safe.top5[0].model, null); assert.equal(safe.top5[0].endpoint, null); assert.equal(safe.context.scope, 'unknown');
});

test('a data point keeps the five in order, with true zeros distinct from unknowns', () => {
  const result = { ranking: { mode: 'measured', version: '5' }, task: { kind: 'extract', outputContract: 'text' }, recommendations: Array.from({ length: 6 }, (_, i) => ({ modelId: `lab/model-${i}`, endpoint: { id: `lab:chat:model-${i}` }, quality: i === 0 ? 0 : 90, reference: { costUsd: i === 0 ? 0 : null, completionSeconds: i === 0 ? 0 : null } })) };
  const p = searchDataPoint({ result, outcome: 'ok', durationMs: 25 }); const { top5 } = decode(p);
  assert.deepEqual(top5.map(m => m.model), Array.from({ length: 5 }, (_, i) => `lab/model-${i}`));
  assert.deepEqual(top5.map(m => m.rank), [1, 2, 3, 4, 5]); assert.equal(top5[0].quality, 0); assert.equal(top5[0].costUsd, 0); assert.equal(top5[1].costUsd, null);
  assert.equal(top5[0].costBasis, 'calibration'); assert.equal(top5[1].costBasis, 'unknown'); assert.equal(p.doubles[1], 5);
  assert.ok(Buffer.byteLength(p.blobs.join('')) < 16_384); assert.ok(p.blobs.length <= 20); assert.equal(p.indexes.length, 1);
  result.ranking.mode = 'task-fit'; assert.equal(decode(searchDataPoint({ result })).top5[0].quality, null);
});

test('real HTTP/MCP recommendations retain exact prompts and ordered five without visitor metadata', async () => {
  const points = []; const observe = createSearchObserver({ writeDataPoint: p => points.push(p) });
  const run = createRecommender({ apiKey: 'provider-secret', observe, fetcher: async () => Response.json({ answers: answers({ vision: 'required' }) }) });
  const prompt = `  Classify photos into cat or dog labels.\n${secret}  `;
  const result = await (await handleAPI(post({ prompt }), index, {}, run)).json();
  const request = new Request('https://example.test/scout/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: secret, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt } } }) });
  const mcp = await (await handleMCP(request, index, {}, (...args) => run(...args, 'mcp'))).json();
  assert.equal(points.length, 2); assert.equal(mcp.result.isError, false);
  for (const point of points) {
    assert.equal(point.blobs[0], '3'); assert.equal(decode(point).prompt, prompt);
    assert.doesNotMatch(JSON.stringify(point), /192.0.2.99|private-device|provider-secret|visitor/);
    assert.doesNotMatch(JSON.stringify({ ...decode(point), prompt: '' }), /PRIVATE_CANARY|example.invalid/);
    assert.deepEqual(decode(point).top5.map(m => [m.model, m.endpoint]), result.recommendations.map(m => [m.modelId, m.endpoint.id]));
    assert.equal(point.blobs[2], 'ok'); assert.equal(point.blobs[4], 'task-fit');
  }
  assert.deepEqual(points.map(p => p.blobs[1]), ['api', 'mcp']);
  await handleAPI(new Request('https://example.test/scout/api/status'), index, {}, run);
  await handleAPI(post({ prompt: 'bad', extra: secret }), index, {}, run);
  await handleAPI(post({ prompt: '' }), index, {}, run);
  assert.equal(points.length, 2, 'status and rejected requests are not searches');
});

test('empty inventories, clarification and unsupported tasks have distinct empty-list outcomes', async () => {
  const points = [], observe = createSearchObserver({ writeDataPoint: p => points.push(p) });
  for (const [choices, ids, expected] of [[{}, [], 'empty'], [{ task_kind: 'visual_unspecified', result_type: 'unspecified' }, undefined, 'clarification'], [{ output: 'unsupported' }, undefined, 'unsupported']]) {
    const run = createRecommender({ apiKey: 'test', observe, fetcher: async () => Response.json({ answers: answers(choices) }) });
    await run(index, 'Describe the task', ids);
    const p = points.at(-1); assert.equal(p.blobs[2], expected); assert.deepEqual(decode(p).top5, []);
  }
  assert.equal(decode(points[0]).context.scope, 'models');
});

test('upstream failures and admission limits are counted once without error content', async () => {
  const points = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const run = createRecommender({ apiKey: 'test', observe: createSearchObserver({ writeDataPoint: p => points.push(p) }), fetcher: async () => { await gate; throw new Error(secret); } });
  const pending = Array.from({ length: 32 }, () => run(index, secret).catch(e => e.status));
  await assert.rejects(run(index, secret), e => e.status === 429); release();
  assert.deepEqual(await Promise.all(pending), Array(32).fill(503)); assert.equal(points.length, 33);
  assert.equal(points.filter(p => p.blobs[2] === 'rate_limited').length, 1); assert.equal(points.filter(p => p.blobs[2] === 'interpretation_error').length, 32);
  assert.ok(points.every(p => decode(p).prompt === secret));
  assert.doesNotMatch(JSON.stringify(points.map(p => ({ ...decode(p), prompt: '' }))), /PRIVATE_CANARY|example.invalid/); assert.ok(points.every(p => decode(p).top5.length === 0)); assert.ok(points.every(p => p.doubles[4] === -1));
});

test('an analytics outage cannot change success or mask an interpretation failure', async () => {
  const observe = createSearchObserver({ writeDataPoint() { throw new Error(secret); } });
  const good = createRecommender({ apiKey: 'test', observe, fetcher: async () => Response.json({ answers: answers() }) });
  assert.ok((await good(index, 'Classify messages')).recommendations.length);
  const bad = createRecommender({ apiKey: 'test', observe, fetcher: async () => { throw new Error('upstream unavailable'); } });
  await assert.rejects(bad(index, 'Classify messages'), e => e.status === 503);
});

test('full 4,000-character multibyte prompts fit one event without losing endpoints or metrics', () => {
  const result = { ranking: { mode: 'measured', version: '99999', workload: { inputTokens: 99999999, outputTokens: 99999999 }, weights: { quality: 0.6, cost: 0.2, latency: 0.2 } }, checkedAt: new Date().toISOString(), eligibleModels: 99999, task: { kind: 'visual_unspecified', outputContract: 'unspecified', capabilities: Object.keys(capabilities).map(id => ({ id })), interpreterVersion: '99999', workload: { priority: 'balanced', input: 'medium', output: 'medium' } }, recommendations: Array.from({ length: 5 }, (_, i) => ({ modelId: `${i}`.repeat(300), endpoint: { id: 'e'.repeat(300) }, quality: 99.999999, reference: { costUsd: 0.000000123456789, completionSeconds: 123.456789 } })) };
  // The maximal stored identities and a long CJK prompt exceed 16 KiB unencoded.
  let seed = 17;
  const prompt = Array.from({ length: 4000 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return String.fromCharCode(0x4e00 + seed % 20000); }).join('');
  const point = searchDataPoint({ prompt, result, outcome: 'ok' });
  assert.equal(point.blobs[12], 'gzip-binary');
  assert.deepEqual(decodeSearchRecord({ schemaVersion: '3', payloadHex: Buffer.from(point.blobs[11]).toString('hex'), payloadEncoding: point.blobs[12] }), decode(point));
  assert.ok(point.blobs.reduce((n, b) => n + Buffer.byteLength(b), 0) <= 16384);
  assert.equal(decode(point).prompt, prompt);
  assert.deepEqual(decode(point).top5.map(m => m.model), result.recommendations.map(m => m.modelId));
  assert.equal(decode(point).top5[0].costUsd, result.recommendations[0].reference.costUsd);
});

test('on-demand decoding preserves older events without inventing missing prompts or evidence', () => {
  const old = { schemaVersion: '1', task: '{}', context: '{}', top5: '[{"rank":1,"model":"lab/model"}]' };
  assert.equal(decodeSearchRecord(old).prompt, null);
  assert.equal(decodeSearchRecord(old).top5[0].evidence, undefined);
  assert.equal(decodeSearchRecord({ ...old, schemaVersion: '2', prompt: 'Original task', promptEncoding: 'text' }).prompt, 'Original task');
});

test('hex SQL transport decodes both legacy JSON/base64 and current binary records losslessly', () => {
  const record = { prompt: 'مرحبا 世界 🐦', task: {}, top5: [], context: {} }, json = JSON.stringify(record);
  const compressed = gzipSync(strToU8(json));
  for (const [encoding, value] of [['json', Buffer.from(json)], ['gzip-base64', Buffer.from(Buffer.from(compressed).toString('base64'))], ['gzip-binary', Buffer.from(compressed)]]) {
    assert.deepEqual(decodeSearchRecord({ schemaVersion: '3', payloadEncoding: encoding, payloadHex: value.toString('hex') }), record);
  }
  assert.deepEqual(decodeSearchRecord({ schemaVersion: '3', payloadEncoding: 'gzip-base64', payload: Buffer.from(compressed).toString('base64') }), record);
});

test('long prompts retain real source evidence; oversized records never become partial records', () => {
  let seed = 17;
  const prompt = Array.from({ length: 4000 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return String.fromCharCode(0x4e00 + seed % 20000); }).join('');
  for (const [promptText,task] of [['Write a function to parse escaped CSV fields.',{kind:'code',weights:{coding:3},workload:{input:'short',output:'medium'}}],['Extract vendor, date and total from invoice text as JSON.',{kind:'extract',needsStructured:true,outputFormat:'json',weights:{structured:3},workload:{input:'short',output:'short'}}]]) {
    const result = recommend(index, promptText, Date.parse(snapshot.checkedAt), task);
    const point = searchDataPoint({ prompt, result, outcome: 'ok' });
    const saved = decode(point);
    assert.equal(saved.prompt, prompt);
    saved.top5.forEach((m, i) => assert.deepEqual(m.evidence.benchmarks, JSON.parse(JSON.stringify(result.recommendations[i].evidence))));
    assert.ok(point.blobs.reduce((n, b) => n + Buffer.byteLength(b), 0) <= 16384);
  }
  const result = { recommendations: [{ modelId: 'lab/model', evidence: [{ benchmark: prompt.repeat(100) }] }] };
  // An unusually large source record cannot create a misleading truncated unit.
  const points = [];
  // Distinct, incompressible source values exercise the limit deterministically.
  result.recommendations[0].evidence[0].benchmark = Array.from({ length: 40000 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return String.fromCharCode(0x4e00 + seed % 20000); }).join('');
  assert.throws(() => searchDataPoint({ prompt, result }), /event limit/);
  assert.doesNotThrow(() => createSearchObserver({ writeDataPoint: p => points.push(p) })({ prompt, result }));
  assert.equal(points.length, 0);
});

test('evidence snapshots retain benchmark, calibration, endpoint, pricing and speed sources for each rank', () => {
  const prompt = 'Write a function to parse escaped CSV fields.';
  const result = recommend(index, prompt, Date.parse(snapshot.checkedAt), {kind:'code',weights:{coding:3},workload:{input:'short',output:'medium'}});
  const point = searchDataPoint({ result, prompt, outcome: 'ok' });
  const saved = decode(point);
  assert.equal(saved.top5.length, 5);
  saved.top5.forEach((m, i) => {
    const original = result.recommendations[i];
    assert.deepEqual(m.evidence.benchmarks, JSON.parse(JSON.stringify(original.evidence)));
    assert.equal(m.evidence.endpoint.url, original.endpoint.url);
    assert.equal(m.evidence.pricing.inputPerMillion, original.pricing.inputPerMillion);
    assert.equal(m.evidence.pricing.url, original.pricing.url);
    assert.equal(m.evidence.speed?.url, original.speed?.url);
  });
  // Source records refresh later; this stored search must remain unchanged.
  const originalScore = saved.top5[0].evidence.benchmarks[0].score;
  result.recommendations[0].evidence[0].score = -999;
  assert.equal(decode(point).top5[0].evidence.benchmarks[0].score, originalScore);
});

test('measured evidence includes the calibration protocol and excludes arbitrary extra fields', () => {
  const result = { ranking: { mode: 'measured', profile: { id: 'fixture', protocolSha256: 'abc123', casesPerModel: 8, extra: secret } }, recommendations: [{ modelId: 'lab/model', endpoint: { id: 'lab:chat:model', protocol: 'chat', url: 'https://provider.test/model', api: secret, headers: { authorization: secret } }, measured: { cases: 8, quality: .9, meanCostUsd: .01, medianSeconds: 1, availability: { successes: 8, attempts: 8, rate: 1 }, extra: secret }, evidence: [{ benchmark: 'Test', score: 90, url: 'https://benchmark.test', observedAt: '2026-10-15', extra: secret }] }] };
  const point = searchDataPoint({ prompt: 'A task', result });
  const e = decode(point).top5[0].evidence;
  assert.equal(e.calibration.cases, 8); assert.equal(e.calibration.protocol.protocolSha256, 'abc123');
  assert.equal(e.calibration.availability.successes, 8); assert.equal(e.benchmarks[0].score, 90);
  assert.doesNotMatch(JSON.stringify(decode(point)), /PRIVATE_CANARY|authorization/);
});

test('specialist evidence retains pinned model-card and contract sources without claimed task accuracy', async () => {
  const points = [];
  const run = createRecommender({ apiKey: 'test', observe: createSearchObserver({ writeDataPoint: p => points.push(p) }), fetcher: async () => Response.json({ answers: answers({ vision: 'required' }) }) });
  const result = await run(index, 'Classify images into cat or dog labels');
  const saved = decode(points[0]);
  saved.top5.forEach((m, i) => {
    const original = result.recommendations[i];
    assert.equal(m.quality, null); assert.equal(m.evidence.calibration, null);
    assert.deepEqual(m.evidence.taskFit, original.taskFit);
    assert.equal(m.evidence.endpoint.configuration, original.endpoint.configuration);
    assert.equal(m.evidence.endpoint.cardURL, original.endpoint.cardURL);
    assert.deepEqual(m.evidence.reportedEvaluations, original.endpoint.reportedEvaluations ?? []);
  });
});
