import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

// Execute the real browser entry and analytics module, with only DOM, Clerk,
// storage and HTTP mocked. No backend or installer implementation is replaced.
const source = buildSync({
  entryPoints: [new URL('../../site/connect/connect.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', external: ['./vendor/web-vitals.js'],
  define: { 'import.meta.url': JSON.stringify('https://example.test/scout/analytics.js') },
}).outputFiles[0].text;
const setupId = '7a75ff69-382b-4de4-80ab-0fc924c22216';
const secret = 'PRIVATE_DEVICE_KEY_OR_ERROR';
const drain = () => new Promise(resolve => setTimeout(resolve, 10));
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function node() {
  return Object.assign(new EventTarget(), { textContent: '', hidden: true, value: '', children: [],
    classList: { toggle() {}, add() {} }, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } });
}
async function fixture({ preferences, navigator = {}, loginStatuses = ['pending', 'collected'], fail = {}, authError = false, queryId = setupId, query = '' } = {}) {
  const nodes = new Map(), requests = [], events = [], preferencesSent = [], order = [];
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  const sessionStorage = storage(), localStorage = storage(preferences);
  let loginIndex = 0, observer;
  const client = {
    session: { status: 'active', id: 'private-session', getToken: async () => 'private-token' }, user: { id: 'private-user' },
    load: async () => { order.push('clerk'); if (authError) throw Error(secret); },
    addListener: fn => { observer = fn; fn({ user: client.user, session: client.session }); },
    mountUserButton() {}, openSignIn() {},
  };
  const document = Object.assign(new EventTarget(), { querySelector: $, createElement: node, visibilityState: 'visible' });
  const location = { pathname: '/connect/', search: `?code=ABCD1234&setup_id=${encodeURIComponent(queryId)}${query}`, href: 'https://example.test/connect/?code=ABCD1234' };
  const env = Object.assign(new EventTarget(), { document, location, localStorage, sessionStorage, navigator, crypto,
    URL, URLSearchParams, TextEncoder, Event, AbortSignal, setTimeout: fn => { queueMicrotask(fn); return 0; }, clearTimeout() {},
    __internal_ClerkUICtor: {}, Clerk: client, history: { replaceState() {} },
    fetch: async (url, options = {}) => {
      if (url === '/scout/api/auth') { order.push('config'); return Response.json({ analytics: { enabled: true, accountSync: true } }); }
      if (url === '/scout/api/analytics/preference') { preferencesSent.push(JSON.parse(options.body)); return Response.json({}); }
      if (url === '/scout/api/analytics') { events.push({ ...JSON.parse(options.body), headers: options.headers }); return Response.json({}); }
      requests.push({ url, ...options });
      const operation = options.method === 'DELETE' ? 'revoke' : options.method === 'POST' ? JSON.parse(options.body).decision : url.includes('/keys') ? 'devices' : loginIndex++ === 0 ? 'load' : 'poll';
      const failure = fail[operation];
      if (failure === 'network') throw Error(secret);
      if (failure) return Response.json({ error: secret }, { status: failure });
      if (operation === 'devices') return Response.json({ keys: [{ id: 'private-key-id', clientName: 'Claude Code', deviceName: secret, lastUsedAt: '2026-10-01' }] });
      if (operation === 'approve' || operation === 'deny' || operation === 'revoke') return Response.json({});
      return Response.json({ status: loginStatuses[Math.min(loginIndex - 1, loginStatuses.length - 1)], clientName: 'Claude Code', deviceName: secret, scope: 'user' });
    },
  });
  env.window = env;
  await runInNewContext(`(async () => { ${source}\n })()`, env);
  await drain();
  return { $, client, env, events, requests, preferencesSent, order, fail,
    observe: () => observer({ user: client.user, session: client.session }),
    click: async selector => { await $(selector).onclick(); await drain(); } };
}

test('connect configures privacy before Clerk and observes the account once without a Scout visit or invented pageview', async () => {
  const f = await fixture({ loginStatuses: ['pending', 'approved', 'approved', 'collected'] });
  assert.deepEqual(f.order, ['config', 'clerk']);
  assert.deepEqual(f.preferencesSent, [{ enabled: true }]);
  assert.equal(f.events.filter(row => row.event === 'scout_session_observed').length, 1);
  f.observe(); await drain();
  assert.equal(f.events.filter(row => row.event === 'scout_session_observed').length, 1);
  await f.click('#approve');
  assert.match(f.$('#connect-title').textContent, /key authorized/);
  assert.match(f.$('#connect-status').textContent, /does not verify installation/);
  assert.doesNotMatch(f.$('#connect-status').textContent, /is set up|is connected/);
  assert.ok(f.events.every(row => !['scout_visited', 'web_pageview', 'scout_client_error'].includes(row.event)));
  assert.ok(f.events.every(row => row.event_id));
  assert.ok(!f.events.some(row => row.event === 'scout_connect_client_error'), 'pending/approved polls are not errors');
  for (const request of f.requests) {
    assert.equal(request.headers['X-Scout-Setup-Id'], setupId);
    assert.equal(request.headers['X-Scout-Analytics'], 'on');
    assert.equal(request.headers['X-Scout-Analytics-Account'], 'on');
    assert.ok(request.headers['X-Scout-Anonymous-Id']);
  }
});

test('connect respects opt-out, DNT, GPC, unlink and invalid setup IDs on every API call', async () => {
  for (const options of [
    { preferences: { 'scout-analytics-opt-out': '1' } },
    { navigator: { doNotTrack: '1' } }, { navigator: { globalPrivacyControl: true } },
    { preferences: { 'scout-analytics-account-link': '0' } }, { queryId: 'PRIVATE_NOT_A_UUID' },
    { query: '&analytics=off' }, { query: '&analytics_account=off' },
  ]) {
    const f = await fixture(options);
    await f.click('#deny');
    const disabled = options.navigator || options.preferences?.['scout-analytics-opt-out'] === '1' || options.query === '&analytics=off';
    if (disabled) {
      assert.deepEqual(f.preferencesSent, options.query === '&analytics=off' ? [] : [{ enabled: false }]);
      assert.deepEqual(f.events, []);
    }
    for (const request of f.requests) {
      assert.equal(request.headers['X-Scout-Setup-Id'], undefined);
      assert.equal(request.headers['X-Scout-Analytics'], disabled ? 'off' : 'on');
      if (disabled) assert.equal(request.headers['X-Scout-Anonymous-Id'], undefined);
      if (options.preferences?.['scout-analytics-account-link'] === '0' || options.query === '&analytics_account=off') assert.equal(request.headers['X-Scout-Analytics-Account'], 'off');
    }
  }
});

// Generated UUIDs can contain the hex markers below by chance, so they are blanked before checking for leaks.
const withoutIds = value => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid');

test('connect exports only bounded browser failures at auth/load/approve/deny/devices/revoke stages', async () => {
  for (const [at, options] of [
    ['auth', { authError: true }], ['load', { fail: { load: 'network' } }],
    ['approve', { fail: { approve: 503 } }], ['deny', { fail: { deny: 403 } }],
    ['devices', { fail: { devices: 500 } }], ['revoke', { fail: { revoke: 403 } }],
  ]) {
    const f = await fixture(options);
    if (at === 'approve' || at === 'deny') await f.click(`#${at}`);
    if (at === 'revoke') {
      f.$('#device-list').children[0].children[1].dispatchEvent(new Event('click')); await drain();
    }
    const errors = f.events.filter(row => row.event === 'scout_connect_client_error');
    assert.equal(errors.length, 1, at);
    assert.equal(errors[0].properties.stage, at);
    assert.equal(errors[0].properties.code, at === 'auth' ? 'auth_unavailable' : at === 'load' ? 'network_error' : 'http_error');
    if (at !== 'auth' && at !== 'load') assert.equal(errors[0].properties.http_status, options.fail[at]);
    assert.doesNotMatch(withoutIds(f.events.map(({ headers, ...event }) => event)), /PRIVATE|private-key|private-user|private-session|ABCD|1234|https:/);
  }
});

test('polling reports one timeout, not 60 expected pending results or repeated network errors', async () => {
  for (const fail of [{}, { poll: 'network' }]) {
    const f = await fixture({ loginStatuses: ['approved'], fail });
    const errors = f.events.filter(row => row.event === 'scout_connect_client_error');
    assert.deepEqual(errors.map(row => row.properties.code), fail.poll ? ['network_error', 'approval_timeout'] : ['approval_timeout']);
    assert.ok(errors.every(row => row.properties.stage === 'poll'));
    assert.match(f.$('#connect-status').textContent, /key collection was not confirmed/);
  }
});

test('unlink during approval discards setup correlation and uncaught errors never export arbitrary details', async () => {
  const f = await fixture();
  f.env.localStorage.setItem('scout-analytics-account-link', '0');
  f.env.dispatchEvent(Object.assign(new Event('storage'), { key: 'scout-analytics-account-link' }));
  await f.click('#approve');
  assert.equal(f.requests.find(row => row.method === 'POST').headers['X-Scout-Setup-Id'], undefined);
  f.env.dispatchEvent(Object.assign(new Event('error'), { error: { message: secret, stack: secret, telemetryCode: secret, status: 900 } }));
  await drain();
  const error = f.events.find(row => row.event === 'scout_connect_client_error');
  assert.equal(error.properties.code, 'uncaught_error');
  assert.equal(error.properties.http_status, undefined);
  assert.equal(error.properties.setup_id, undefined);
  assert.doesNotMatch(withoutIds(error), /PRIVATE|900/);
});
