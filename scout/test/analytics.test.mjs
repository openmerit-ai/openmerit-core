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
import { createProductAnalytics } from '../product-analytics.mjs';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);
const answers = (choices = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .9, choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'classify', result_type: 'labels', label_space: 'supplied' }[q.name] ?? q.choices[0].value) }));
const post = body => new Request('https://example.test/scout/api/recommend', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'visitor=private', 'user-agent': 'private-device', 'cf-connecting-ip': '192.0.2.99' }, body: JSON.stringify(body) });
const secret = 'private.person@example.invalid PRIVATE_CANARY_493';
const decode = point => decodeSearchRecord({ schemaVersion: point.blobs[0], payload: point.blobs[11], payloadEncoding: point.blobs[12] });

test('multi-task analytics retains each role separately instead of reporting an empty global shortlist',()=>{
 const points=[],observer=createSearchObserver({writeDataPoint:p=>points.push(p)});
 const slots=['first','second'].map(name=>({task:{kind:'code'},recommendations:[{modelId:`lab/${name}`}],ranking:{mode:'benchmarks'}}));
 observer({prompt:'Two model roles.',result:{tasks:[{slots}],recommendations:[]},outcome:'ok'});
 assert.equal(points.length,2);assert.deepEqual(points.map(p=>decode(p).top5[0].model),['lab/first','lab/second']);
 assert.deepEqual(points.map(p=>decode(p).context.position),[{task:1,slot:1,tasks:1,slots:2},{task:1,slot:2,tasks:1,slots:2}]);
});

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

test('browser analytics links an OAuth return, rotates on account switches, and respects opt-outs without leaking stale events', async t => {
  const storage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
  for (const [key, value] of Object.entries({ navigator: {}, sessionStorage: storage(), localStorage: storage() })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const sent = [], controls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { (url.endsWith('/preference') ? controls : sent).push(JSON.parse(options.body)); return new Response(null, { status: 204 }); });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  async function until(check) { for (let i = 0; i < 100 && !check(); i++) await settle(); assert.ok(check()); }
  const { analytics } = await import(`../../site/scout/analytics.js?first=${crypto.randomUUID()}`);
  analytics.track('scout_visited'); await settle(); assert.equal(sent.length, 0);
  analytics.configure(true); analytics.account(null, null); await until(() => sent.length === 1);
  const anonymous = sent[0].anonymousId;
  const alice = { id: 'private_session_a', getToken: async () => 'private_bearer_a' };
  analytics.account('private_user_a', alice, { status: 'complete', createdSessionId: alice.id, firstFactorVerification: { status: 'verified', strategy: 'oauth_google' } });
  await until(() => sent.some(e => e.event === 'scout_session_observed'));
  assert.equal(sent.find(e => e.event === 'scout_session_observed').anonymousId, anonymous);
  assert.equal(sent.find(e => e.event === 'scout_session_observed').properties.auth_provider, 'google');

  let release;
  alice.getToken = () => new Promise(resolve => { release = resolve; });
  analytics.track('scout_model_id_copied', { rank: 2, task_index: 1 }); await until(() => !!release);
  analytics.account('private_user_a', alice); release('private_bearer_a');
  await until(() => sent.some(e => e.event === 'scout_model_id_copied'));
  assert.equal(sent.filter(e => e.event === 'scout_session_observed').length, 1, 'ordinary Clerk refresh is not another session');

  release = undefined; analytics.track('scout_provider_opened', { rank: 3, task_index: 2 }); await until(() => !!release);
  const bob = { id: 'private_session_b', getToken: async () => 'private_bearer_b' };
  analytics.account('private_user_b', bob, { status: 'complete', createdSessionId: alice.id, firstFactorVerification: { status: 'verified', strategy: 'oauth_github' } }); release('private_bearer_a');
  await until(() => sent.filter(e => e.event === 'scout_session_observed').length === 2);
  assert.equal(sent.filter(e => e.event === 'scout_provider_opened').length, 0, 'a pending old-account event must be dropped');
  const bobEvent = sent.filter(e => e.event === 'scout_session_observed').at(-1), bobId = bobEvent.anonymousId;
  assert.equal(bobEvent.properties.auth_provider, 'unknown', 'a different session cannot establish this provider');
  assert.notEqual(bobId, anonymous);
  const { analytics: reloaded } = await import(`../../site/scout/analytics.js?return=${crypto.randomUUID()}`);
  reloaded.configure(true); reloaded.account('private_user_b', bob);
  await until(() => sent.filter(e => e.event === 'scout_visited').length === 2);
  assert.equal(sent.at(-1).anonymousId, bobId); assert.equal(sent.filter(e => e.event === 'scout_session_observed').length, 2);
  assert.doesNotMatch(JSON.stringify(sent), /private_user|private_session|private_bearer/);

  const before = sent.length;
  for (const preference of ['dnt', 'gpc', 'local', 'disabled']) {
    navigator.doNotTrack = preference === 'dnt' ? '1' : '0'; navigator.globalPrivacyControl = preference === 'gpc';
    localStorage.setItem('scout-analytics-opt-out', preference === 'local' ? '1' : '0');
    reloaded.configure(preference !== 'disabled'); reloaded.account('private_user_b', bob); reloaded.track('scout_visited');
    assert.equal(reloaded.headers()['X-Scout-Analytics'], 'off'); await settle(); assert.equal(sent.length, before);
  }
  navigator.doNotTrack = '0'; navigator.globalPrivacyControl = false; localStorage.removeItem('scout-analytics-opt-out');
  reloaded.configure(true, true); reloaded.account('private_user_b', bob);
  await until(() => sent.length > before && controls.length === 1);
  assert.deepEqual(controls, [{ enabled: true }]);
  const enabledEvents = sent.length;
  for (const preference of ['dnt', 'gpc', 'local', 'disabled']) {
    navigator.doNotTrack = preference === 'dnt' ? '1' : '0'; navigator.globalPrivacyControl = preference === 'gpc';
    localStorage.setItem('scout-analytics-opt-out', preference === 'local' ? '1' : '0');
    reloaded.configure(preference !== 'disabled', true); reloaded.account('private_user_b', bob);
    await until(() => controls.length === ['dnt', 'gpc', 'local', 'disabled'].indexOf(preference) + 2);
    reloaded.track('scout_visited'); await settle();
    assert.deepEqual(controls.at(-1), { enabled: false }, 'privacy controls contain no event, profile or anonymous ID');
    assert.equal(sent.length, enabledEvents);
  }
});

test('PostHog content obeys rollout and privacy gates, stays in expiring AI fields, and preserves every rank', async t => {
  const sent = [], pending = [], flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const base = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test',
    POSTHOG_CAPTURE_CONTENT: 'true', CLERK_SECRET_KEY: 'fixture', CLERK_WEBHOOK_SIGNING_SECRET: 'fixture', POSTHOG_PERSONAL_API_KEY: 'fixture', POSTHOG_PROJECT_ID: '123',
    SCOUT_ACCOUNTS: { idFromName: x => x, get: () => ({ capture: async batch => sent.push(...batch), preference: async () => {} }) } };
  const prompt = 'Classify invoices for person@example.invalid with API_KEY=private-canary at https://private.invalid/?secret=yes';
  const result = { tasks: [{ sourceText: prompt, layers: { input: { origin: 'explicit', text: prompt } }, slots: [{
    task: { kind: 'classify' }, ranking: { mode: 'benchmarks' }, recommendations: Array.from({ length: 5 }, (_, i) => ({
      modelId: `lab/model-${i}`, quality: i === 0 ? 0 : 95, reference: { costUsd: i === 0 ? 0 : null, completionSeconds: i + 1 },
      endpoint: { id: `route:${i}`, semanticMatch: { reason: 'PRIVATE_DERIVED_TEXT' }, url: 'https://public.test/model?private-key=bad#private' },
      evidence: Array.from({ length: 50 }, () => ({ benchmark: 'A'.repeat(2000), score: 80, url: 'https://public.test/eval?secret=bad' })),
    })) }] }] };
  for (const [headers, changes, expectedContent, expectedCount] of [
    [{}, {}, false, 3], [{ 'X-Scout-Analytics-Content': 'on' }, {}, true, 3],
    [{ 'X-Scout-Client': 'web' }, {}, false, 3],
    [{ 'X-Scout-Client': 'web' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, true, 3],
    [{ 'X-Scout-Client': 'web', 'X-Scout-Analytics-Content': 'off' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 3],
    [{ 'X-Scout-Client': 'web', 'X-Scout-Analytics-Content': 'invalid' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 3],
    [{ 'X-Scout-Client': 'cli' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 3],
    [{ 'X-Scout-Client': 'agent' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 3],
    [{}, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 3],
    [{ 'X-Scout-Client': 'web' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true', POSTHOG_CAPTURE_CONTENT: 'false' }, false, 3],
    [{ 'X-Scout-Client': 'web' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true', POSTHOG_PERSONAL_API_KEY: '' }, false, 3],
    [{ 'X-Scout-Client': 'web', DNT: '1' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 0],
    [{ 'X-Scout-Client': 'web', 'Sec-GPC': '1' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 0],
    [{ 'X-Scout-Client': 'web', 'X-Scout-Analytics': 'off' }, { SCOUT_BETA_EVALUATION_LOGGING: 'true' }, false, 0],
    [{ 'X-Scout-Analytics-Content': 'on' }, { POSTHOG_CAPTURE_CONTENT: 'false' }, false, 3],
    [{ 'X-Scout-Analytics-Content': 'on' }, { POSTHOG_PERSONAL_API_KEY: '' }, false, 3],
    [{ 'X-Scout-Analytics-Content': 'on', 'X-Scout-Analytics': 'off' }, {}, false, 0],
    [{ 'X-Scout-Analytics-Content': 'on', DNT: '1' }, {}, false, 0],
    [{ 'X-Scout-Analytics-Content': 'on', 'Sec-GPC': '1' }, {}, false, 0],
  ]) {
    sent.length = 0;
    const analytics = createProductAnalytics(new Request('https://example.test/scout/api/recommend', { headers }), { ...base, ...changes }, { waitUntil: p => pending.push(p) });
    analytics.identify('user_fixture');
    const credentials = JSON.stringify({ token: 'CANARY_JSON_TOKEN', password: 'CANARY_ESCAPED"QUOTE', 'api-key': 'CANARY_JSON_KEY' });
    analytics.observeSearch({ prompt: `${prompt} ${credentials}`, result, outcome: 'ok', durationMs: 23 }); await flush();
    assert.equal(sent.length, expectedCount);
    if (!expectedCount) continue;
    const trace = sent.find(e => e.event === '$ai_trace').properties, details = sent.find(e => e.event === 'scout_search_details').properties;
    assert.equal(trace.content_captured, expectedContent);
    assert.equal(trace.$ai_input_state !== undefined, expectedContent);
    assert.equal(details.layers, undefined);
    if (expectedContent) { assert.match(trace.$ai_input_state.prompt, /Classify invoices/); assert.match(trace.$ai_input_state.tasks[0].layers.input.text, /\[EMAIL\]/); }
    // Model PostHog's documented split: no user prose may survive in ordinary
    // event properties after the expiring AI input/output fields are removed.
    const retained = sent.map(e => ({ ...e, properties: Object.fromEntries(Object.entries(e.properties).filter(([key]) => !e.event.startsWith('$ai_') || !['$ai_input_state', '$ai_output_state'].includes(key))) }));
    assert.doesNotMatch(JSON.stringify(retained), /Classify invoices/);
    assert.doesNotMatch(JSON.stringify(sent), /CANARY_JSON|CANARY_ESCAPED|QUOTE/);
    assert.doesNotMatch(JSON.stringify(sent), /person@example|private-canary|private.invalid|private-key|PRIVATE_DERIVED|secret=bad/);
    assert.equal(details.evidence_truncated, true);
    assert.deepEqual(details.top5.map(m => m.model), ['lab/model-0', 'lab/model-1', 'lab/model-2', 'lab/model-3', 'lab/model-4']);
    assert.equal(details.top5[0].costUsd, 0); assert.equal(details.top5[1].costUsd, null); assert.equal(details.top5[0].quality, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(details)) < 250000);
    assert.equal(analytics.response(new Response('ok')).headers.get('x-scout-trace-id'), trace.trace_id);
  }
});

test('sanitized errors and terminal/website events reach the same account-aware ingestion boundary', async t => {
  const sent = [], pending = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test' };
  const trace = crypto.randomUUID();
  for (const [event, properties] of [
    ['scout_client_error', { code: 'render_error', error_type: 'TypeError', trace_id: trace, frames: [{ filename: 'scout.js', lineno: 74, colno: 9, function: secret }, { filename: '/Users/private/file.js', lineno: 1, colno: 2 }], message: secret, stack: secret }],
    ['terminal_snapshot', { mode: 'live', model_count: 9, record_count: 42, source_count: 2, host_count: 0, deployment_count: 4, agent_count: 3, model: secret }],
    ['website_link_opened', { page: 'home', destination: 'scout', url: secret }],
    ['terminal_error', { code: 'collection_error', error_type: secret }],
  ]) {
    const request = new Request('https://example.test/scout/api/analytics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, anonymousId: crypto.randomUUID(), properties }) });
    const analytics = createProductAnalytics(request, env, { waitUntil: p => pending.push(p) });
    assert.equal((await analytics.handleEvent()).status, 204);
  }
  while (pending.length) await Promise.all(pending.splice(0));
  const errors = sent.filter(e => e.event === '$exception'); assert.equal(errors.length, 2);
  assert.equal(errors[0].properties.trace_id, trace); assert.equal(errors[0].properties.$exception_list[0].stacktrace.frames.length, 1);
  assert.equal(errors[0].properties.$exception_list[0].stacktrace.frames[0].lineno, 74);
  assert.equal(errors[1].properties.$exception_list[0].type, 'Error');
  assert.equal(sent.find(e => e.event === 'terminal_snapshot').properties.model_count, 9);
  assert.equal(sent.find(e => e.event === 'website_link_opened').properties.product, 'website');
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_CANARY|private\/file|example.invalid|\$set|\"message\"/);
});

test('browser beta defaults preserve saved refusals and privacy signals; unlinking rotates IDs across reloads', async t => {
  const data = new Map(), sessionData = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  for (const [key, value] of Object.entries({ navigator: {}, localStorage: storage(data), sessionStorage: storage(sessionData) })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent.push({ url, ...options, body: JSON.parse(options.body) }); return new Response(null, { status: 204 }); });
  async function until(check) { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check()); }
  const { analytics } = await import(`../../site/scout/analytics.js?beta=${crypto.randomUUID()}`);
  analytics.configure(true, true, true);
  assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'off');
  analytics.configure(true, true, true, true);
  assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'on');
  for (const saved of ['0', 'invalid']) {
    data.set('scout-analytics-content', saved);
    assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'off');
  }
  data.set('scout-analytics-content', '1');
  assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'on');
  for (const signal of ['dnt', 'gpc', 'opt-out']) {
    navigator.doNotTrack = signal === 'dnt' ? '1' : '0'; navigator.globalPrivacyControl = signal === 'gpc';
    data.set('scout-analytics-opt-out', signal === 'opt-out' ? '1' : '0');
    assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'off');
  }
  navigator.doNotTrack = '0'; navigator.globalPrivacyControl = false; data.clear();
  const get = localStorage.getItem;
  localStorage.getItem = () => { throw new Error('Storage denied'); };
  assert.equal(analytics.headers()['X-Scout-Analytics-Content'], 'off');
  assert.equal(analytics.headers()['X-Scout-Analytics-Account'], 'off');
  localStorage.getItem = get;

  const active = { id: 'session_test', getToken: async () => 'test-bearer' };
  analytics.account('user_test', active);
  await until(() => sent.some(e => e.body.event === 'scout_session_observed'));
  const linkedId = analytics.headers()['X-Scout-Anonymous-Id'];
  let release;
  active.getToken = () => new Promise(resolve => { release = resolve; });
  analytics.track('scout_provider_opened', { rank: 1, task_index: 1 });
  await until(() => !!release);
  active.getToken = async () => 'test-bearer';
  analytics.setPreferences(true, true, false);
  release('test-bearer');
  analytics.track('scout_model_id_copied', { rank: 2, task_index: 1 });
  await until(() => sent.some(e => e.body.event === 'scout_model_id_copied'));
  assert.equal(sent.filter(e => e.body.event === 'scout_provider_opened').length, 0);
  const unlinkedId = analytics.headers()['X-Scout-Anonymous-Id'];
  assert.notEqual(unlinkedId, linkedId);
  assert.equal(sent.find(e => e.body.event === 'scout_model_id_copied').headers['X-Scout-Analytics-Account'], 'off');
  assert.equal(sent.filter(e => e.body.event === 'scout_session_observed').length, 1);
  const { analytics: reloaded } = await import(`../../site/scout/analytics.js?betaReload=${crypto.randomUUID()}`);
  reloaded.configure(true, true, true, true); reloaded.account('user_test', active);
  await until(() => sent.filter(e => e.body.event === 'scout_visited').length === 2);
  assert.equal(reloaded.headers()['X-Scout-Analytics-Account'], 'off');
  reloaded.setPreferences(true, false, true);
  await until(() => sent.filter(e => e.body.event === 'scout_session_observed').length === 2);
  assert.notEqual(reloaded.headers()['X-Scout-Anonymous-Id'], unlinkedId);
  assert.equal(reloaded.headers()['X-Scout-Analytics-Content'], 'off');
});
