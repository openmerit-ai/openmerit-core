import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductAnalytics, sendProductBatch } from '../product-analytics.mjs';
import { handleMCP } from '../mcp.mjs';

const secret = 'private.person@example.invalid PRIVATE_CANARY_493';

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
