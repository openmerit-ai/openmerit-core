import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1 } from './helpers-projection.mjs';
import { handleConnect, deviceKeyUser } from '../connect.mjs';
import { scoutAccess } from '../auth.mjs';
import { createProductAnalytics } from '../product-analytics.mjs';

const origin = 'https://example.test';
function setup() {
  const env = { SCOUT_INDEX: new LocalD1() };
  let clock = Date.now();
  const as = user => ({ session: async () => user, now: clock });
  const call = (path, { method = 'POST', body, user = null, key, headers = {} } = {}) => handleConnect(new Request(`${origin}/connect/api/${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, as(user));
  return { env, call, tick: ms => { clock += ms; }, now: () => clock };
}
async function start(call, device_name = 'laptop') {
  const response = await call('device', { body: { client: 'claude-code', scope: 'user', device_name } });
  assert.equal(response.status, 200); return response.json();
}
const poll = (call, code) => call('token', { body: { device_code: code } }).then(async r => ({ status: r.status, ...(await r.json()) }));

test('device login: pending, approval by the signed-in user, single key collection', async () => {
  const { call, tick, env } = setup();
  const login = await start(call);
  assert.match(login.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(login.verification_uri_complete, `${origin}/connect?code=${login.user_code}`);
  assert.equal((await poll(call, login.device_code)).error, 'authorization_pending');
  tick(1000); assert.equal((await poll(call, login.device_code)).error, 'slow_down');

  // The approval page requires a session; anonymous callers see nothing.
  assert.equal((await call(`login?code=${login.user_code}`, { method: 'GET' })).status, 401);
  const details = await (await call(`login?code=${login.user_code.toLowerCase().replace('-', '')}`, { method: 'GET', user: 'user_alice' })).json();
  assert.deepEqual([details.clientName, details.deviceName, details.scope, details.status], ['Claude Code', 'laptop', 'user', 'pending']);
  assert.equal((await call('login', { body: { code: login.user_code, decision: 'approve' }, user: 'user_alice' })).status, 200);
  // A second decision cannot flip an approved request.
  assert.equal((await call('login', { body: { code: login.user_code, decision: 'deny' }, user: 'user_mallory' })).status, 409);
  assert.equal((await call(`login?code=${login.user_code}`, { method: 'GET', user: 'user_mallory' })).status, 404);

  tick(6000);
  const [first, second] = await Promise.all([poll(call, login.device_code), poll(call, login.device_code)]);
  const issued = [first, second].filter(r => r.access_token);
  assert.equal(issued.length, 1, 'concurrent polls mint exactly one key');
  assert.match(issued[0].access_token, /^om_[A-Za-z0-9_-]{43}$/);
  assert.equal([first, second].find(r => !r.access_token).error, 'invalid_grant');
  assert.equal((await poll(call, login.device_code)).error, 'invalid_grant');
  assert.equal((await deviceKeyUser(env, issued[0].access_token)).userId, 'user_alice');
  // Only hashes are stored.
  assert.doesNotMatch(JSON.stringify(env.SCOUT_INDEX.db.prepare('SELECT * FROM openmerit_device_keys').all()), /om_/);
  assert.doesNotMatch(JSON.stringify(env.SCOUT_INDEX.db.prepare('SELECT * FROM openmerit_device_logins').all()), new RegExp(login.device_code));
});

test('device login: denial and expiry never issue a key', async () => {
  const { call, tick } = setup();
  const denied = await start(call);
  await call('login', { body: { code: denied.user_code, decision: 'deny' }, user: 'user_alice' });
  assert.equal((await poll(call, denied.device_code)).error, 'access_denied');
  const expired = await start(call);
  tick(601_000);
  assert.equal((await call('login', { body: { code: expired.user_code, decision: 'approve' }, user: 'user_alice' })).status, 409);
  assert.equal((await poll(call, expired.device_code)).error, 'expired_token');
  assert.equal((await poll(call, 'unknown')).error, 'invalid_grant');
  assert.equal((await call('device', { body: { client: 'cursor', scope: 'user', device_name: 'x' } })).status, 400);
});

async function issue(ctx, user = 'user_alice') {
  const login = await start(ctx.call);
  await ctx.call('login', { body: { code: login.user_code, decision: 'approve' }, user });
  return (await poll(ctx.call, login.device_code)).access_token;
}
const mcp = (env, token) => scoutAccess(new Request(`${origin}/scout/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }), env);

test('device keys authorize MCP only, and revocation and idle expiry take effect', async () => {
  const ctx = setup(), key = await issue(ctx);
  const env = Object.assign(ctx.env, { CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('scout-auth.clerk.accounts.dev$').toString('base64')}`, CLERK_SECRET_KEY: 'sk_test_fixture' });
  assert.equal(await mcp(env, key), null);
  // The JSON API stays session-only.
  const api = await scoutAccess(new Request(`${origin}/scout/api/agent`, { method: 'POST', headers: { authorization: `Bearer ${key}` } }), env);
  assert.equal(api.status, 401);
  assert.equal((await (await mcp(env, 'om_' + 'a'.repeat(43))).json()).code, 'device_key_required');

  const { keys } = await (await ctx.call('keys', { method: 'GET', user: 'user_alice' })).json();
  assert.equal(keys.length, 1); assert.equal(keys[0].deviceName, 'laptop');
  assert.equal((await (await ctx.call('keys', { method: 'GET', user: 'user_bob' })).json()).keys.length, 0);
  assert.equal((await ctx.call(`keys/${keys[0].id}`, { method: 'DELETE', user: 'user_bob' })).status, 404);
  assert.equal((await ctx.call(`keys/${keys[0].id}`, { method: 'DELETE', user: 'user_alice' })).status, 200);
  assert.equal((await mcp(env, key)).status, 401);

  const second = await issue(ctx);
  assert.equal((await ctx.call('keys/self', { method: 'DELETE', key: second })).status, 200);
  assert.equal(await deviceKeyUser(env, second, undefined, ctx.now()), null);

  const idle = await issue(ctx);
  assert.ok(await deviceKeyUser(env, idle, undefined, ctx.now() + 89 * 86400_000), 'use within 90 days extends the key');
  assert.ok(await deviceKeyUser(env, idle, undefined, ctx.now() + 170 * 86400_000));
  assert.equal(await deviceKeyUser(env, idle, undefined, ctx.now() + 300 * 86400_000), null);
});

test('device lifecycle telemetry distinguishes pending, approval, collection, denial, expiry and revocation without secrets', async t => {
  const sent = [], pending = [], setup_id = crypto.randomUUID();
  t.mock.method(globalThis, 'fetch', async (_, options) => { sent.push(...JSON.parse(options.body).batch); return new Response(null, { status: 200 }); });
  const env = { SCOUT_INDEX: new LocalD1(), POSTHOG_PROJECT_TOKEN: 'phc_fixture', POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_ENVIRONMENT: 'test' };
  let now = Date.now();
  async function call(path, body, user = null, method = 'POST', headers = {}) {
    const request = new Request(`${origin}/connect/api/${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Scout-Setup-Id': setup_id, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const analytics = createProductAnalytics(request, env, { waitUntil: p => pending.push(p) });
    const response = await handleConnect(request, env, { session: async () => user, now, analytics });
    while (pending.length) await Promise.all(pending.splice(0));
    return response.json();
  }
  const login = await call('device', { client: 'claude-code', scope: 'user', device_name: 'PRIVATE_DEVICE' });
  await call('token', { device_code: login.device_code });
  assert.equal(sent.filter(e => e.event === '$exception').length, 0, 'expected approval polling is not a failure');
  await call('login', { code: login.user_code, decision: 'approve' }, 'PRIVATE_USER');
  const key = await call('token', { device_code: login.device_code });
  await call('keys/self', undefined, null, 'DELETE', { Authorization: `Bearer ${key.access_token}` });
  const denied = await call('device', { client: 'claude-code', scope: 'user', device_name: 'PRIVATE_DEVICE' });
  await call('login', { code: denied.user_code, decision: 'deny' }, 'PRIVATE_USER');
  await call('token', { device_code: denied.device_code });
  const expired = await call('device', { client: 'claude-code', scope: 'user', device_name: 'PRIVATE_DEVICE' });
  now += 601000;
  await call('token', { device_code: expired.device_code });
  const states = sent.filter(e => e.event === 'scout_connect_step').map(e => [e.properties.stage, e.properties.status, e.properties.outcome]);
  assert.deepEqual(states, [['device', undefined, 'ok'], ['token', 'pending', 'pending'], ['login', 'approved', 'ok'], ['token', 'collected', 'ok'], ['revoke', 'revoked', 'ok'], ['device', undefined, 'ok'], ['login', 'denied', 'denied'], ['token', 'denied', 'denied'], ['device', undefined, 'ok'], ['token', 'expired', 'error']]);
  assert.ok(sent.every(e => e.properties.setup_id === setup_id));
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(`PRIVATE_|${login.device_code}|${login.user_code}|${key.access_token}|${key.key_id}`));
  const count = sent.length;
  await call('device', { client: 'claude-code', scope: 'user', device_name: 'PRIVATE_DEVICE' }, null, 'POST', { DNT: '1' });
  assert.equal(sent.length, count);
});
