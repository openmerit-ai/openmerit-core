import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import web, { type WebEnv } from '../web.ts';

const assets: WebEnv['ASSETS'] = { fetch: async request => {
  const path = new URL(request.url).pathname;
  const pages: Record<string, string> = { '/': 'Landing page', '/scout/': 'Sign in', '/playground/scout/': 'Walkthrough', '/vs-routers/': 'Comparison' };
  return new Response(pages[path] ?? 'Not found', { status: pages[path] ? 200 : 404 });
} };

// Real SDK signature verification with disposable keys, not a mocked identity.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const authEnv: WebEnv = {
  ASSETS: assets,
  CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('openmerit-auth.clerk.accounts.dev$').toString('base64')}`,
  CLERK_SECRET_KEY: 'sk_test_disposable_fixture',
  CLERK_JWT_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
function sessionToken(changes: Record<string, unknown> = {}, key: KeyObject = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000), encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { iss: 'https://openmerit-auth.clerk.accounts.dev', azp: 'https://example.test', sub: 'user_alice', sid: 'sess_alice', iat: now, nbf: now - 1, exp: now + 60, v: 2, sts: 'active', ...changes };
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'local-fixture' })}.${encode(payload)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
const session = (token: string | null, headers: Record<string, string> = {}, method = 'GET') => web.fetch(new Request('https://example.test/scout/api/session', {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
}), authEnv);

test('the landing page stays at root, and sign-in and the walkthrough keep their pages', async () => {
  const home = await web.fetch(new Request('https://example.test/?ref=home'), authEnv);
  assert.equal(home.status, 200); assert.equal(await home.text(), 'Landing page');
  const scout = await web.fetch(new Request('https://example.test/scout?ref=home'), authEnv);
  assert.equal(scout.status, 308); assert.equal(scout.headers.get('location'), 'https://example.test/scout/?ref=home');
  assert.equal(await (await web.fetch(new Request('https://example.test/scout/'), authEnv)).text(), 'Sign in');
  const playground = await web.fetch(new Request('https://example.test/playground/scout'), authEnv);
  assert.equal(playground.status, 308); assert.equal(playground.headers.get('location'), 'https://example.test/playground/scout/');
  for (const page of ['vs-routers', 'run-locally']) {
    const response = await web.fetch(new Request(`https://example.test/${page}?ref=x`), authEnv);
    assert.equal(response.status, 308); assert.equal(response.headers.get('location'), `https://example.test/${page}/?ref=x`);
  }
  assert.equal(await (await web.fetch(new Request('https://example.test/vs-routers/'), authEnv)).text(), 'Comparison');
});

test('retired pages and APIs return 404 without reading assets or secrets', async () => {
  const unavailable = new Proxy({}, { get() { assert.fail('Retired pages must not read bindings or assets'); } }) as WebEnv;
  for (const path of ['/connect', '/connect/', '/connect/api/device', '/scouting', '/playground', '/playground/other', '/index.html', '/docs/', '/memo/', '/demo/api/session']) {
    for (const method of ['GET', 'HEAD', 'POST']) assert.equal((await web.fetch(new Request(`https://example.test${path}`, { method }), unavailable)).status, 404, `${method} ${path}`);
  }
  for (const path of ['/scout/api/agent', '/scout/api/status', '/scout/api/analytics', '/scout/api/webhooks/clerk']) {
    assert.equal((await web.fetch(new Request(`https://example.test${path}`), authEnv)).status, 404, path);
  }
  assert.equal((await web.fetch(new Request('https://example.test/scout/mcp', { method: 'POST' }), authEnv)).status, 404);
});

test('auth configuration exposes only the publishable key and fails closed when incomplete', async () => {
  const response = await web.fetch(new Request('https://example.test/scout/api/auth'), authEnv);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { publishableKey: authEnv.CLERK_PUBLISHABLE_KEY, frontendApi: 'openmerit-auth.clerk.accounts.dev' });
  for (const config of [{ ASSETS: assets }, { ASSETS: assets, CLERK_PUBLISHABLE_KEY: authEnv.CLERK_PUBLISHABLE_KEY! }, { ...authEnv, CLERK_PUBLISHABLE_KEY: 'invalid' }]) {
    for (const path of ['auth', 'session']) {
      const result = await web.fetch(new Request(`https://example.test/scout/api/${path}`, { headers: { authorization: `Bearer ${sessionToken()}` } }), config);
      assert.equal(result.status, 503, `${path} ${JSON.stringify(Object.keys(config))}`);
      assert.doesNotMatch(await result.text(), /sk_test|BEGIN PUBLIC KEY|invalid/);
    }
  }
});

test('the session check accepts only current, local Clerk session tokens', async () => {
  const verified = await session(sessionToken());
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.deepEqual(await verified.json(), { userId: 'user_alice' });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, now = Math.floor(Date.now() / 1000);
  const invalid = [null, 'malformed', sessionToken({}, otherKey), sessionToken({ exp: now - 60 }), sessionToken({ nbf: now + 120 }), sessionToken({ iss: 'https://other.clerk.accounts.dev' }), sessionToken({ azp: 'https://untrusted.example' }), sessionToken({ sts: 'pending' }), sessionToken({ sid: '' }), sessionToken({ sub: '' })];
  for (const token of invalid) {
    const response = await session(token);
    assert.equal(response.status, 401, token?.slice(0, 20) ?? 'anonymous');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="OpenMerit"');
    assert.equal(((await response.json()) as { code: string }).code, 'sign_in_required');
  }
  assert.equal((await session(null, { cookie: `__session=${sessionToken()}` })).status, 401);
  assert.equal((await session(sessionToken(), { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await session(sessionToken(), {}, 'POST')).status, 405);
});

test('the contact-sales form emails a valid request to OpenMerit with Reply-To set to the sender', async () => {
  const sent: unknown[] = [];
  let allowed = true, failSend = false;
  const env: WebEnv = {
    ASSETS: assets, CONTACT_TO: 'lazim@openmerit.ai', CONTACT_FROM: 'memo@openmerit.ai',
    CONTACT_EMAIL: { send: async message => { if (failSend) throw new Error('down'); sent.push(message); } },
    CONTACT_RATE: { limit: async () => ({ success: allowed }) },
  };
  const submit = (fields: Record<string, string>, method = 'POST') => web.fetch(new Request('https://example.test/contact-sales/api', {
    method, ...(method === 'POST' ? { body: new URLSearchParams(fields) } : {}),
  }), env);
  const valid = { name: 'Ada\r\nBcc: x@evil.test', email: 'ada@acme.test', company: 'Acme', size: '11–50', spend: '$50K–$100K', use: 'Support replies', heard: '' };

  const ok = await submit(valid);
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), 'https://example.test/contact-sales/thanks/');
  assert.equal(sent.length, 1);
  const message = sent[0] as { to: string[]; from: { email: string }; replyTo: { name: string; email: string }; subject: string; text: string };
  assert.deepEqual(message.to, ['lazim@openmerit.ai']); assert.equal(message.from.email, 'memo@openmerit.ai');
  assert.deepEqual(message.replyTo, { name: 'Ada Bcc: x@evil.test', email: 'ada@acme.test' });
  assert.equal(message.subject, 'Hosted OpenMerit enquiry: Acme');
  assert.match(message.text, /Company size: 11–50/); assert.match(message.text, /Monthly LLM spend: \$50K–\$100K/); assert.match(message.text, /Support replies/); assert.match(message.text, /\(not given\)/);

  // A bot filling the hidden field sees success, but nothing is sent.
  assert.equal((await submit({ ...valid, website: 'http://spam.test' })).status, 303);
  for (const broken of [{ ...valid, size: '5' }, { ...valid, spend: '' }, { ...valid, spend: '$25–$50' }, { ...valid, email: 'not-an-email' }, { ...valid, company: ' ' }, { ...valid, use: 'x'.repeat(4001) }]) {
    assert.equal((await submit(broken)).status, 400);
  }
  allowed = false; assert.equal((await submit(valid)).status, 429); allowed = true;
  failSend = true; const failed = await submit(valid); failSend = false;
  assert.equal(failed.status, 502); assert.match(await failed.text(), /mailto:lazim@openmerit\.ai/);
  assert.equal((await submit({}, 'GET')).status, 404);
  assert.equal(sent.length, 1);
});
