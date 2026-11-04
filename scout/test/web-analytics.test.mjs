import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebAnalytics, publicPage, validateWebProperties, uuidV4 } from '../../site/scout/web-analytics.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function fixture(shared = {}) {
  const env = Object.assign(new EventTarget(), {
    navigator: { userAgent: 'Mozilla Chrome/123 Windows', doNotTrack: '0' }, crypto,
    localStorage: shared.localStorage || storage(), sessionStorage: shared.sessionStorage || storage(),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: 'https://www.google.com/search?q=SECRET', documentElement: { scrollHeight: 2000 } }),
    location: { pathname: '/', search: '?utm_source=google&utm_medium=cpc&utm_campaign=PRIVATE&utm_content=SECRET#PRIVATE' },
    innerWidth: 1400, innerHeight: 1000, scrollY: 0,
  });
  const sent = []; let time = 100000;
  const collector = createWebAnalytics({ env, permitted: () => true, now: () => time, send: (event, properties, anonymousId) => sent.push({ event, properties, anonymousId }) });
  return { env, sent, collector, tick: ms => { time += ms; } };
}
test('public page contract matches every published guide and excludes private/arbitrary routes', () => {
  assert.equal(publicPage('/scout/')?.page, 'scout');
  for (const path of ['/memo/', '/docs/demo/', '/docs/demo/private/', '/scout/auth/callback/', '/auth/callback', '/docs/private/', '/docs/scout/?token=secret', '/#secret', '/scout/prompt']) assert.equal(publicPage(path), null, path);
});
test('emits bounded context and explicit interactions, never arbitrary content or URLs', () => {
  const f = fixture();
  const view = f.sent[0];
  assert.equal(view.event, 'web_pageview');
  assert.equal(view.properties.referrer_domain, 'google.com');
  assert.equal(view.properties.referrer_channel, 'search');
  assert.equal(view.properties.utm_source, 'google');
  assert.equal(view.properties.utm_campaign, undefined);
  assert.ok(uuidV4(view.anonymousId)); assert.ok(uuidV4(view.properties.session_id));
  assert.notEqual(view.anonymousId, view.properties.session_id);
  f.collector.interaction('PRIVATE prompt');
  f.collector.interaction('open_scout');
  f.collector.vital({ name: 'LCP', value: 2300, id: 'PRIVATE', entries: [{ url: 'SECRET' }] });
  for (const [name, value] of [['CLS', 0.1], ['INP', 42], ['FCP', 800], ['TTFB', 90]]) f.collector.vital({ name, value });
  f.collector.vital({ name: 'LCP', value: Infinity });
  f.collector.vital({ name: 'CLS', value: 11 });
  f.collector.vital({ name: 'secret', value: 10 });
  assert.equal(f.sent.length, 7);
  for (const row of f.sent) assert.equal(validateWebProperties(row.event, row.properties), true);
  assert.doesNotMatch(JSON.stringify(f.sent), /SECRET|PRIVATE|https:|utm_content|entries/);
  assert.equal(validateWebProperties('web_pageview', { ...view.properties, prompt: 'secret' }), false);
  assert.equal(validateWebProperties('web_pageview', { ...view.properties, utm_campaign: 'private' }), false);
  assert.equal(validateWebProperties('web_pageview', { ...view.properties, page_path: '/docs/private/' }), false);
  f.collector.stop();
});
test('navigation and lifecycle pair views/leaves without duplicate pagehide or same-route views', () => {
  const f = fixture(); f.collector.navigate();
  f.env.scrollY = 500; f.env.dispatchEvent(new Event('scroll')); f.tick(4000);
  f.env.location.pathname = '/docs/scout/'; f.collector.navigate();
  assert.deepEqual(f.sent.map(e => e.event), ['web_pageview', 'web_pageleave', 'web_pageview']);
  assert.equal(f.sent[1].properties.duration_ms, 4000); assert.equal(f.sent[1].properties.scroll_depth, 50);
  assert.equal(f.sent[1].properties.content_depth, 75);
  assert.equal(f.sent[0].properties.pageview_id, f.sent[1].properties.pageview_id);
  assert.notEqual(f.sent[2].properties.pageview_id, f.sent[1].properties.pageview_id);
  assert.equal(f.sent[1].properties.page_path, '/');
  f.env.document.visibilityState = 'hidden'; f.env.document.dispatchEvent(new Event('visibilitychange'));
  f.env.document.visibilityState = 'visible'; f.env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.sent.length, 3, 'tab switch is not another navigation');
  f.env.dispatchEvent(new Event('pagehide'));
  assert.equal(f.sent.length, 4);
  f.env.document.visibilityState = 'visible'; f.env.document.dispatchEvent(new Event('visibilitychange'));
  f.env.dispatchEvent(new Event('pageshow')); assert.equal(f.sent.length, 5);
  f.env.location.pathname = '/memo/'; f.env.dispatchEvent(new Event('popstate')); assert.equal(f.sent.length, 6);
  f.collector.interaction('open_docs'); assert.equal(f.sent.length, 6);
  f.collector.stop();
});
test('opt-outs, DNT/GPC and unreadable preference storage fail closed and erase shared identity', () => {
  for (const refuse of [
    env => env.localStorage.setItem('scout-analytics-opt-out', '1'),
    env => { env.navigator.doNotTrack = '1'; }, env => { env.doNotTrack = '1'; },
    env => { env.navigator.globalPrivacyControl = true; },
    env => { env.localStorage.getItem = () => { throw Error('denied'); }; },
  ]) {
    const f = fixture(); refuse(f.env); f.collector.interaction('open_scout'); f.collector.leave();
    assert.equal(f.sent.length, 1);
    assert.equal(f.env.sessionStorage.getItem('openmerit-web-tab'), null);
    f.collector.stop();
  }
});
test('shared same-tab web identity is independent from request IDs, and unlink rotates it', () => {
  const first = fixture();
  const second = fixture(first.env);
  assert.equal(first.sent[0].anonymousId, second.sent[0].anonymousId);
  assert.equal(first.sent[0].properties.session_id, second.sent[0].properties.session_id);
  first.env.localStorage.setItem('scout-analytics-account-link', '0');
  first.env.dispatchEvent(new Event('scout-analytics-change'));
  assert.notEqual(first.sent.at(-1).anonymousId, first.sent[0].anonymousId);
  const third = fixture(first.env);
  assert.notEqual(third.sent[0].anonymousId, first.sent.at(-1).anonymousId);
  assert.equal(first.env.sessionStorage.getItem('scout-product-analytics'), null);
  first.collector.stop(); second.collector.stop(); third.collector.stop();
});
test('session rotates after 30m inactivity or 24h lifetime, visitor does not', () => {
  const f = fixture(); const first = f.sent[0];
  f.tick(1800000); f.collector.interaction('open_docs');
  assert.deepEqual(f.sent.slice(1).map(e => e.event), ['web_pageleave', 'web_pageview', 'web_interaction']);
  assert.equal(f.sent[1].properties.session_id, first.properties.session_id);
  assert.equal(f.sent[2].properties.session_id, f.sent[3].properties.session_id);
  assert.notEqual(f.sent.at(-1).properties.session_id, first.properties.session_id);
  assert.equal(f.sent.at(-1).anonymousId, first.anonymousId);
  const second = f.sent.at(-1).properties.session_id;
  for (let i = 0; i < 48; i++) { f.tick(1799999); f.collector.interaction('open_docs'); }
  assert.equal(f.sent.at(-1).properties.session_id, second);
  f.tick(1000); f.collector.interaction('open_docs');
  assert.notEqual(f.sent.at(-1).properties.session_id, second);
  f.collector.stop();
});
test('unknown external referrers remain referral without retaining their domain', () => {
  const f = fixture(); f.env.document.referrer = 'https://private-company.example/private?secret';
  f.env.location.pathname = '/docs/scout/'; f.collector.navigate();
  assert.equal(f.sent.at(-1).properties.referrer_channel, 'referral');
  assert.equal(f.sent.at(-1).properties.referrer_domain, 'none');
  assert.doesNotMatch(JSON.stringify(f.sent), /private-company|secret/);
  f.collector.stop();
});
test('authenticated acquisition uses one linked ID, unlink headers and epoch gates prevent account joins', async t => {
  const website = fixture(); website.collector.stop();
  const env = website.env; env.location.pathname = '/scout/';
  const sent = []; let responseOK = true;
  const globals = { navigator: env.navigator, document: env.document, location: env.location,
    localStorage: env.localStorage, sessionStorage: env.sessionStorage,
    addEventListener: env.addEventListener.bind(env), removeEventListener: env.removeEventListener.bind(env), dispatchEvent: env.dispatchEvent.bind(env),
    fetch: async (url, options) => { sent.push({ ...JSON.parse(options.body), headers: options.headers }); return { ok: responseOK }; } };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const { analytics } = await import(`../../site/scout/analytics.js?web=${crypto.randomUUID()}`);
  analytics.configure(true);
  const alice = { id: 'private-session-a', getToken: async () => 'private-token-a' };
  analytics.account('private-user-a', alice);
  assert.equal(await analytics.track('scout_search_started'), true);
  const acquisitionId = website.sent[0].anonymousId;
  for (const row of sent) {
    assert.equal(row.anonymousId, acquisitionId, row.event);
    assert.equal(row.headers['X-Scout-Analytics-Account'], 'on');
    assert.ok(uuidV4(row.headers['X-Scout-Session-Id']));
    assert.equal(row.properties.session_id, row.headers['X-Scout-Session-Id']);
    assert.equal(row.headers.Authorization, 'Bearer private-token-a');
  }
  assert.ok(sent.some(row => row.event === 'web_pageview'));
  assert.ok(sent.some(row => row.event === 'scout_session_observed'));
  assert.doesNotMatch(JSON.stringify(sent.map(({ headers, ...row }) => row)), /private-user|private-token|private-session/);
  let release;
  alice.getToken = () => new Promise(resolve => { release = resolve; });
  const stale = analytics.track('scout_provider_opened');
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  analytics.account(null, null); release('private-token-a');
  assert.equal(await stale, false);
  const signedOutId = analytics.headers()['X-Scout-Anonymous-Id'];
  assert.notEqual(signedOutId, acquisitionId);
  assert.equal(await analytics.track('scout_search_started'), true);
  const bob = { id: 'private-session-b', getToken: async () => 'private-token-b' };
  analytics.account('private-user-b', bob);
  assert.equal(await analytics.track('scout_search_started'), true);
  const bobId = analytics.headers()['X-Scout-Anonymous-Id'];
  const bobSession = analytics.headers()['X-Scout-Session-Id'];
  analytics.account('private-user-c', { id: 'private-session-c', getToken: async () => 'private-token-c' });
  assert.equal(await analytics.track('scout_search_started'), true);
  assert.notEqual(analytics.headers()['X-Scout-Anonymous-Id'], bobId);
  assert.notEqual(analytics.headers()['X-Scout-Session-Id'], bobSession);
  const switchedView = sent.filter(row => row.event === 'web_pageview').at(-1);
  assert.equal(switchedView.anonymousId, analytics.headers()['X-Scout-Anonymous-Id']);
  assert.equal(switchedView.headers.Authorization, 'Bearer private-token-c');
  analytics.setPreferences(true, false, false);
  assert.equal(await analytics.track('scout_search_started'), true);
  analytics.webInteraction('search_submit');
  await new Promise(resolve => setTimeout(resolve, 5));
  const unlinked = sent.filter(row => row.headers['X-Scout-Analytics-Account'] === 'off');
  assert.ok(unlinked.some(row => row.event === 'web_interaction'));
  assert.ok(unlinked.some(row => row.event === 'scout_search_started'));
  assert.ok(unlinked.every(row => row.anonymousId !== acquisitionId));
  const productId = unlinked.find(row => row.event === 'scout_search_started').anonymousId;
  assert.notEqual(unlinked.find(row => row.event === 'web_interaction').anonymousId, productId);
  // A different tab's saved choice must override this tab's in-memory choice.
  analytics.setPreferences(true, false, true);
  env.localStorage.setItem('scout-analytics-account-link', '0');
  env.dispatchEvent(Object.assign(new Event('storage'), { key: 'scout-analytics-account-link' }));
  assert.equal(await analytics.track('scout_provider_opened'), true);
  assert.equal(sent.at(-1).headers['X-Scout-Analytics-Account'], 'off');
  responseOK = false; assert.equal(await analytics.track('scout_search_started'), false);
  globalThis.fetch = async () => { throw Error('offline'); };
  assert.equal(await analytics.track('scout_search_started'), false);
  analytics.setPreferences(false, false, false);
  assert.equal(await analytics.track('scout_search_started'), false);
});
test('connect observation has no Scout visit/pageview and retries only transient failures with one event identity', async t => {
  const f = fixture(); f.collector.stop(); f.env.location.pathname = '/connect/';
  const sent = []; let respond = async () => ({ ok: true, status: 200 });
  const globals = { navigator: f.env.navigator, document: f.env.document, location: f.env.location,
    localStorage: f.env.localStorage, sessionStorage: f.env.sessionStorage,
    addEventListener: f.env.addEventListener.bind(f.env), dispatchEvent: f.env.dispatchEvent.bind(f.env),
    fetch: async (url, options) => { sent.push(JSON.parse(options.body)); return respond(); } };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const { analytics } = await import(`../../site/scout/analytics.js?retry=${crypto.randomUUID()}`);
  analytics.configure(true, false, false, false, { page: 'connect' });
  analytics.account(null, null);
  assert.equal(await analytics.track('scout_agent_setup_started', { agent: 'claude-code' }), true);
  assert.deepEqual(sent.map(row => row.event), ['scout_agent_setup_started']);
  for (const failure of [429, 500, 503, 599, 'network', 400, 401, 403, 408, 422]) {
    sent.length = 0; let calls = 0;
    respond = async () => {
      if (calls++ > 0) return { ok: true, status: 200 };
      if (failure === 'network') throw Error('PRIVATE network details');
      return { ok: false, status: failure };
    };
    const retry = failure === 'network' || failure === 429 || failure >= 500;
    assert.equal(await analytics.track('scout_agent_setup_started', { agent: 'claude-code' }), retry, `${failure}`);
    assert.equal(sent.length, retry ? 2 : 1, `${failure}`);
    assert.ok(uuidV4(sent[0].event_id));
    if (retry) assert.deepEqual(sent[0], sent[1], 'retry must reuse the entire payload');
  }
  sent.length = 0;
  respond = async () => { throw Error('offline'); };
  assert.equal(await analytics.track('scout_agent_setup_started'), false);
  assert.equal(sent.length, 2, 'persistent network failure is bounded');
  for (const change of [
    () => analytics.setPreferences(false, false, true),
    () => analytics.setPreferences(true, false, false),
    () => { f.env.navigator.globalPrivacyControl = true; },
    () => { f.env.localStorage.setItem('scout-analytics-account-link', '0'); },
    () => analytics.account('different-user', null),
  ]) {
    f.env.navigator.globalPrivacyControl = false; analytics.setPreferences(true, false, true);
    sent.length = 0;
    respond = async () => { change(); return { ok: false, status: 503 }; };
    assert.equal(await analytics.track('scout_agent_setup_started'), false);
    assert.equal(sent.filter(row => row.event === 'scout_agent_setup_started').length, 1, 'privacy/account changes suppress retry');
  }
});
