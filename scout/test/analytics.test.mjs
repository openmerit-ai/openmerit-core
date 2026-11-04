import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchRecord } from '../analytics.mjs';
import { createRecommender } from '../recommend.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { capabilities } from '../capabilities.mjs';
import { decisionQuestions } from '../decisions.mjs';
import { handleAPI } from '../http.mjs';
import { createProductAnalytics, sendProductBatch } from '../product-analytics.mjs';
import { handleMCP } from '../mcp.mjs';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);
const answers = (choices = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .9, choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'classify', result_type: 'labels', label_space: 'supplied' }[q.name] ?? q.choices[0].value) }));
const post = body => new Request('https://example.test/scout/api/recommend', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'visitor=private', 'user-agent': 'private-device', 'cf-connecting-ip': '192.0.2.99' }, body: JSON.stringify(body) });
const secret = 'private.person@example.invalid PRIVATE_CANARY_493';
// Serialize like an analytics transport would, so stored records are detached from live results.
const record = event => JSON.parse(JSON.stringify(searchRecord(event)));
const capture = events => event => events.push(event);

test('only explicit prompt and allowlisted public evidence cross the analytics boundary', () => {
  const poison = { prompt: secret, keywords: [secret], reason: secret, name: secret, provider: secret, error: secret, headers: { authorization: secret }, selection: { modelIds: [secret] } };
  const result = { ...poison, task: { ...poison, kind: secret, capabilities: [{ id: 'vision', label: secret }, { id: secret }], needsVision: true, outputContract: secret, interpreterVersion: secret, workload: { priority: secret, input: secret, output: secret } }, ranking: { mode: secret, version: secret, workload: poison }, checkedAt: secret,
    recommendations: [{ ...poison, modelId: secret, endpoint: { id: secret }, reference: { costUsd: null, completionSeconds: null, basis: secret } }] };
  const safe = record({ result, scope: secret, index: { snapshot: { checkedAt: secret, dataVersion: secret } } });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_CANARY|example.invalid|authorization|keywords|visitor/); assert.equal(safe.task.kind, 'unknown'); assert.deepEqual(safe.task.capabilities, ['vision']);
  assert.equal(safe.top5[0].model, null); assert.equal(safe.top5[0].endpoint, null); assert.equal(safe.context.scope, 'unknown');
});

test('a record keeps the five in order, with true zeros distinct from unknowns', () => {
  const result = { ranking: { mode: 'measured', version: '5' }, task: { kind: 'extract', outputContract: 'text' }, recommendations: Array.from({ length: 6 }, (_, i) => ({ modelId: `lab/model-${i}`, endpoint: { id: `lab:chat:model-${i}` }, quality: i === 0 ? 0 : 90, reference: { costUsd: i === 0 ? 0 : null, completionSeconds: i === 0 ? 0 : null } })) };
  const { top5 } = record({ result });
  assert.deepEqual(top5.map(m => m.model), Array.from({ length: 5 }, (_, i) => `lab/model-${i}`));
  assert.deepEqual(top5.map(m => m.rank), [1, 2, 3, 4, 5]); assert.equal(top5[0].quality, 0); assert.equal(top5[0].costUsd, 0); assert.equal(top5[1].costUsd, null);
  assert.equal(top5[0].costBasis, 'calibration'); assert.equal(top5[1].costBasis, 'unknown');
  result.ranking.mode = 'task-fit'; assert.equal(record({ result }).top5[0].quality, null);
});

test('real HTTP recommendations retain exact prompts and ordered five without visitor metadata', async () => {
  const points = []; const observe = capture(points);
  const run = createRecommender({ apiKey: 'provider-secret', observe, fetcher: async () => Response.json({ answers: answers({ vision: 'required' }) }) });
  const prompt = `  Classify photos into cat or dog labels.\n${secret}  `;
  const result = await (await handleAPI(post({ prompt }), index, {}, run)).json();
  assert.equal(points.length, 1);
  for (const point of points) {
    const saved = record(point); assert.equal(saved.prompt, prompt);
    assert.doesNotMatch(JSON.stringify(saved), /192.0.2.99|private-device|provider-secret|visitor/);
    assert.doesNotMatch(JSON.stringify({ ...saved, prompt: '' }), /PRIVATE_CANARY|example.invalid/);
    assert.deepEqual(saved.top5.map(m => [m.model, m.endpoint]), result.recommendations.map(m => [m.modelId, m.endpoint.id]));
    assert.equal(point.outcome, 'ok'); assert.equal(saved.top5[0].qualityBasis, 'unmeasured');
  }
  assert.deepEqual(points.map(p => p.channel), ['api']);
  await handleAPI(new Request('https://example.test/scout/api/status'), index, {}, run);
  await handleAPI(post({ prompt: 'bad', extra: secret }), index, {}, run);
  await handleAPI(post({ prompt: '' }), index, {}, run);
  assert.equal(points.length, 1, 'status and rejected requests are not searches');
});

test('empty inventories, clarification and unsupported tasks have distinct empty-list outcomes', async () => {
  const points = [], observe = capture(points);
  for (const [choices, ids, expected] of [[{}, [], 'empty'], [{ task_kind: 'visual_unspecified', result_type: 'unspecified' }, undefined, 'clarification'], [{ output: 'unsupported' }, undefined, 'unsupported']]) {
    const run = createRecommender({ apiKey: 'test', observe, fetcher: async () => Response.json({ answers: answers(choices) }) });
    await run(index, 'Describe the task', ids);
    const p = points.at(-1); assert.equal(p.outcome, expected); assert.deepEqual(record(p).top5, []);
  }
  assert.equal(record(points[0]).context.scope, 'models');
});

test('upstream failures and admission limits are counted once without error content', async () => {
  const points = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const run = createRecommender({ apiKey: 'test', observe: capture(points), fetcher: async () => { await gate; throw new Error(secret); } });
  const pending = Array.from({ length: 32 }, () => run(index, secret).catch(e => e.status));
  await assert.rejects(run(index, secret), e => e.status === 429); release();
  assert.deepEqual(await Promise.all(pending), Array(32).fill(503)); assert.equal(points.length, 33);
  assert.equal(points.filter(p => p.outcome === 'rate_limited').length, 1); assert.equal(points.filter(p => p.outcome === 'interpretation_error').length, 32);
  assert.ok(points.every(p => record(p).prompt === secret));
  assert.doesNotMatch(JSON.stringify(points.map(p => ({ ...record(p), prompt: '' }))), /PRIVATE_CANARY|example.invalid/); assert.ok(points.every(p => record(p).top5.length === 0));
});

test('an analytics outage cannot change success or mask an interpretation failure', async () => {
  const observe = () => { throw new Error(secret); };
  const good = createRecommender({ apiKey: 'test', observe, fetcher: async () => Response.json({ answers: answers() }) });
  assert.ok((await good(index, 'Classify messages')).recommendations.length);
  const bad = createRecommender({ apiKey: 'test', observe, fetcher: async () => { throw new Error('upstream unavailable'); } });
  await assert.rejects(bad(index, 'Classify messages'), e => e.status === 503);
});

test('evidence snapshots retain benchmark, calibration, endpoint, pricing and speed sources for each rank', () => {
  const prompt = 'Write a function to parse escaped CSV fields.';
  const result = recommend(index, prompt, Date.parse(snapshot.checkedAt), {kind:'code',weights:{coding:3},workload:{input:'short',output:'medium'}});
  const saved = record({ result, prompt });
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
  assert.equal(saved.top5[0].evidence.benchmarks[0].score, originalScore);
});

test('measured evidence includes the calibration protocol and excludes arbitrary extra fields', () => {
  const result = { ranking: { mode: 'measured', profile: { id: 'fixture', protocolSha256: 'abc123', casesPerModel: 8, extra: secret } }, recommendations: [{ modelId: 'lab/model', endpoint: { id: 'lab:chat:model', protocol: 'chat', url: 'https://provider.test/model', api: secret, headers: { authorization: secret } }, measured: { cases: 8, quality: .9, meanCostUsd: .01, medianSeconds: 1, availability: { successes: 8, attempts: 8, rate: 1 }, extra: secret }, evidence: [{ benchmark: 'Test', score: 90, url: 'https://benchmark.test', observedAt: '2026-10-15', extra: secret }] }] };
  const saved = record({ prompt: 'A task', result });
  const e = saved.top5[0].evidence;
  assert.equal(e.calibration.cases, 8); assert.equal(e.calibration.protocol.protocolSha256, 'abc123');
  assert.equal(e.calibration.availability.successes, 8); assert.equal(e.benchmarks[0].score, 90);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_CANARY|authorization/);
});

test('specialist evidence retains pinned model-card and contract sources without claimed task accuracy', async () => {
  const points = [];
  const run = createRecommender({ apiKey: 'test', observe: capture(points), fetcher: async () => Response.json({ answers: answers({ vision: 'required' }) }) });
  const result = await run(index, 'Classify images into cat or dog labels');
  const saved = record(points[0]);
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

test('native web, feedback and CLI errors preserve correlation without bypassing account gates', async t => {
  const sent = [], pending = [], env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test' };
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const session_id = crypto.randomUUID(), pageview_id = crypto.randomUUID(), trace_id = crypto.randomUUID(), anonymousId = crypto.randomUUID();
  const common = { page: 'scout', page_path: '/scout/', session_id, pageview_id };
  async function ingest(event, properties, headers = {}, configuration = env) {
    const request = new Request('https://example.test/scout/api/analytics?PRIVATE', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ event, anonymousId, properties }) });
    const analytics = createProductAnalytics(request, configuration, { waitUntil: p => pending.push(p) });
    if (configuration.SCOUT_ACCOUNTS) analytics.identify('verified_account');
    const response = await analytics.handleEvent();
    while (pending.length) await Promise.all(pending.splice(0));
    return response.status;
  }
  assert.equal(await ingest('web_pageview', { ...common, referrer_channel: 'search', referrer_domain: 'google.com', browser: 'safari', os: 'ios', device: 'mobile', viewport: 'small', utm_source: 'google' }), 204);
  assert.equal(await ingest('web_pageleave', { ...common, duration_ms: 12500, scroll_depth: 63, content_depth: 79 }), 204);
  assert.equal(await ingest('web_vitals', { ...common, vital_name: 'CLS', vital_value: 0.17 }), 204);
  assert.equal(await ingest('web_interaction', { ...common, cta_id: 'search_submit' }), 204);
  assert.equal(await ingest('scout_recommendation_feedback', { rating: 'not_useful', reason: 'wrong_task', task_count: 2, candidate_count: 7, trace_id, prompt: secret }), 204);
  assert.equal(await ingest('cli_command_completed', { command: 'eval_plan', command_id: pageview_id, client_version: '0.1.7-preview.5', platform: 'darwin', runtime_major: 22, outcome: 'error', duration_ms: 43, code: 'scout_http_error', operation: 'scout_recommend', trace_id, frames: [{ filename: 'scout.mjs', lineno: 23, colno: 4, function: secret }] }), 204);
  const [view, leave, vital, click, feedback, command, exception] = sent;
  assert.deepEqual(sent.map(e => e.event), ['$pageview', '$pageleave', '$web_vitals', '$autocapture', 'scout_recommendation_feedback', 'cli_command_completed', '$exception']);
  assert.equal(view.properties.$current_url, 'https://openmerit.ai/scout/'); assert.equal(view.properties.$browser, 'Safari');
  assert.equal(leave.properties.$session_id, session_id); assert.equal(leave.properties.$prev_pageview_id, pageview_id);
  assert.equal(leave.properties.$prev_pageview_duration, 12.5); assert.equal(leave.properties.$prev_pageview_max_content_percentage, .79);
  assert.equal(vital.properties.$web_vitals_CLS_value, .17); assert.equal(vital.properties.$pageview_id, pageview_id);
  assert.equal(click.properties.cta_id, 'search_submit'); assert.equal(feedback.properties.$ai_trace_id, trace_id);
  assert.equal(command.properties.command_id, pageview_id); assert.equal(exception.properties.$exception_list[0].stacktrace.frames[0].filename, 'scout.mjs');
  assert.equal(exception.properties.trace_id, trace_id); assert.equal(exception.properties.client_version, '0.1.7-preview.5');
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE|example.invalid|function.*CANARY/);
  assert.equal(await ingest('web_interaction', { ...common, cta_id: 'search_submit', url: secret }), 400);
  assert.equal(await ingest('scout_recommendation_feedback', { rating: 'arbitrary' }), 400);
  await ingest('web_interaction', { ...common, cta_id: 'search_submit' }, { 'X-Scout-Analytics-Account': 'off', 'X-Scout-Trace-Id': trace_id, 'X-Scout-Retry-Of': trace_id });
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), new RegExp([session_id, pageview_id, trace_id, anonymousId].join('|')));
  const before = sent.length;
  await ingest('scout_recommendation_feedback', { rating: 'useful', trace_id }, { DNT: '1' });
  await ingest('scout_recommendation_feedback', { rating: 'useful', trace_id }, {}, { ...env, SCOUT_ACCOUNTS: { idFromName: v => v, get: () => ({ capture: async () => {} }) } });
  assert.equal(sent.length, before, 'opt-out and the account gate suppress every derived event');
});

test('actual computation attempts, failed stages and HTTP failures have native diagnostics', async t => {
  const sent = [], pending = [], env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test' };
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const trace = crypto.randomUUID(), retry = crypto.randomUUID(), startedAt = '2026-10-22T01:02:03.000Z';
  const analytics = createProductAnalytics(new Request('https://example.test/scout/api/recommend', { headers: { 'X-Scout-Trace-Id': trace, 'X-Scout-Retry-Of': retry, 'X-Scout-Client': 'web' } }), env, { waitUntil: p => pending.push(p) });
  const span = (stage, rest = {}) => ({ id: crypto.randomUUID(), stage, durationMs: 43, startedAt, failed: false, ...rest });
  const attempt = rest => ({ id: crypto.randomUUID(), operation: 'responses', durationMs: 19, startedAt, ...rest });
  const diagnostics = { failure: { stage: 'decisions', code: 'rate_limited', providerStatus: 429 }, pendingStages: ['decisions'],
    spans: [span('decisions', { failed: true }), span('decisions', { pending: true }), span('decisions')],
    generations: [attempt({ code: 'rate_limited', providerStatus: 429 }), attempt({ model: 'gpt-6-luna', inputTokens: 83, outputTokens: 7, cachedInputTokens: 0 }), attempt({ operation: 'embeddings', inputTokens: 11, model: 'text-embedding-3-small' })] };
  analytics.observeSearch({ prompt: secret, outcome: 'interpretation_error', durationMs: 72, error: new TypeError(secret), diagnostics });
  analytics.complete(Response.json({ error: secret }, { status: 503 }));
  while (pending.length) await Promise.all(pending.splice(0));
  const search = sent.find(e => e.event === 'scout_search_completed').properties;
  assert.equal(search.trace_id, trace); assert.equal(search.retry_of, retry); assert.equal(search.failure_stage, 'decisions'); assert.equal(search.failure_code, 'rate_limited'); assert.equal(search.provider_status, 429);
  assert.deepEqual(sent.filter(e => e.event === '$ai_span').map(e => e.properties.stage_state), ['failed', 'incomplete', 'completed']);
  const generations = sent.filter(e => e.event === '$ai_generation');
  assert.equal(generations.length, 2); assert.equal(generations[0].properties.$ai_input_tokens, undefined);
  assert.equal(generations[1].properties.$ai_input_tokens, 83); assert.equal(generations[1].properties.$ai_output_tokens, 7); assert.equal(generations[1].properties.$ai_cache_read_input_tokens, 0);
  assert.equal(generations[1].properties.$ai_total_cost_usd, undefined); assert.equal(generations[1].properties.$ai_parent_id, trace); assert.equal(generations[1].timestamp, startedAt);
  assert.equal(sent.find(e => e.event === '$ai_embedding').properties.$ai_input_tokens, 11);
  assert.equal(sent.find(e => e.event === 'scout_request_completed').properties.outcome, 'error');
  assert.equal(sent.find(e => e.event === 'scout_request_completed').properties.http_status, 503);
  assert.equal(sent.filter(e => e.event === '$exception').length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_CANARY|example.invalid/);
  for (const cache of ['hit', 'shared']) analytics.observeSearch({ result: { tasks: [] }, outcome: 'empty', durationMs: 3, diagnostics: { ...diagnostics, failure: undefined, cache } });
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(sent.filter(e => e.event === '$ai_generation').length, 2, 'cached/shared requests cannot double-count provider usage');
  assert.equal(sent.filter(e => e.event === 'scout_search_completed').length, 3, 'each request still counts as one search');
});

test('MCP invocations preserve installation correlation and classify logical failures, not just HTTP status', async t => {
  const sent = [], pending = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test' };
  const setup_id = crypto.randomUUID(), installation_id = crypto.randomUUID();
  for (const [method, params, failed, code] of [
    ['unknown_private_method', {}, true, -32601],
    ['tools/call', { name: secret }, true, -32602],
    ['tools/call', { name: 'scout_models', arguments: { prompt: secret } }, true, undefined],
    ['tools/call', { name: 'scout_models', arguments: { prompt: 'Classify messages' } }, false, undefined],
    ['initialize', { clientInfo: { name: 'claude-code', version: '2.1.19' } }, false, undefined],
    ['ping', {}, false, undefined],
  ]) {
    sent.length = 0;
    const request = new Request('https://example.test/scout/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'agent', 'X-Scout-Agent': 'claude-code', 'X-Scout-Client-Version': '0.1.8', 'X-Scout-Setup-Id': setup_id, 'X-Scout-Installation-Id': installation_id }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const analytics = createProductAnalytics(request, env, { waitUntil: p => pending.push(p) });
    // A Scout agent conversation that fails on the secret prompt and otherwise answers.
    const conversation = { state: async () => ({ busy: false, turns: 1, skipped: false, progress: [], answer: null }), turn: async ({ message }) => message === secret ? { busy: false, turns: 1, skipped: false, progress: [], answer: { kind: 'error', message: 'Scout could not finish this turn.' } } : { busy: false, turns: 1, skipped: false, progress: [], answer: { kind: 'message', text: 'ok' } } };
    const response = await handleMCP(request, { getByName: () => conversation }, 'user_1', analytics.observeMCP);
    assert.equal(response.status, 200);
    await analytics.complete(response);
    while (pending.length) await Promise.all(pending.splice(0));
    const completed = sent.find(e => e.event === 'scout_request_completed').properties;
    assert.equal(completed.outcome, failed ? 'error' : 'ok');
    assert.equal(completed.protocol_error, code);
    assert.equal(completed.setup_id, setup_id); assert.equal(completed.installation_id, installation_id);
    assert.equal(completed.client, 'agent'); assert.equal(completed.agent, 'claude-code'); assert.equal(completed.client_version, '0.1.8');
    if (method === 'initialize') { assert.equal(completed.harness, 'claude-code'); assert.equal(completed.harness_version, '2.1.19'); }
    assert.equal(sent.filter(e => e.event === '$exception').length, failed ? 1 : 0);
    if (method === 'tools/call') {
      assert.equal(sent.filter(e => e.event === 'scout_tool_invocation_started').length, 1);
      const invocation = sent.find(e => e.event === 'scout_tool_invocation_completed').properties;
      assert.equal(invocation.outcome, failed ? 'error' : 'ok');
      if (!failed) assert.equal(new Set(sent.map(e => e.properties.trace_id)).size, 1);
    }
    assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_CANARY|example.invalid|unknown_private_method/);
  }
});

test('setup event retries deduplicate and unlinked or opted-out requests cannot retain installation identities', async t => {
  const sent = [], pending = [], preferences = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test', SCOUT_ACCOUNTS: { idFromName: v => v, get: () => ({ capture: async batch => sent.push(...batch), preference: async (...args) => preferences.push(args) }) } };
  const setup_id = crypto.randomUUID(), installation_id = crypto.randomUUID(), event_id = crypto.randomUUID();
  for (const headers of [{}, {}, { 'X-Scout-Analytics-Account': 'off' }, { DNT: '1' }]) {
    const request = new Request('https://example.test/scout/api/analytics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Setup-Id': setup_id, 'X-Scout-Installation-Id': installation_id, ...headers }, body: JSON.stringify({ event: 'scout_installation_step', event_id, anonymousId: crypto.randomUUID(), properties: { stage: 'verification', outcome: 'error', connection: 'failed', applied: true, setup_id, installation_id, path: secret } }) });
    const analytics = createProductAnalytics(request, env, { waitUntil: p => pending.push(p) });
    analytics.identify('private_user');
    assert.equal((await analytics.handleEvent()).status, 204);
    while (pending.length) await Promise.all(pending.splice(0));
  }
  assert.equal(sent.length, 6);
  assert.equal(sent[0].uuid, event_id); assert.equal(sent[2].uuid, event_id);
  assert.equal(sent[1].uuid, sent[3].uuid, 'derived exceptions also deduplicate');
  assert.doesNotMatch(JSON.stringify(sent.slice(4)), new RegExp(`${setup_id}|${installation_id}|private_user`));
  assert.equal(preferences.length, 0, 'a request-only refusal must not permanently disable account analytics');
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_CANARY|example.invalid/);
});

test('analytics retries transient failures with identical event UUIDs and exposes terminal delivery failure', async t => {
  const bodies = [], statuses = [503, 429, 200, 400];
  t.mock.method(globalThis, 'fetch', async (_, options) => { bodies.push(options.body); return new Response(null, { status: statuses.shift() }); });
  const env = { POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com' };
  const batch = [{ uuid: crypto.randomUUID(), event: 'scout_installation_step', timestamp: new Date().toISOString(), properties: { stage: 'completed' } }];
  await sendProductBatch(env, batch);
  assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
  await assert.rejects(sendProductBatch(env, batch), /Analytics delivery unavailable/);
  assert.equal(bodies.length, 4, 'permanent 4xx errors must not retry');
});
