import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { startMemoRuntime } from '../memo/local-runtime.ts';

const origin = 'https://openmerit.ai';
let runtime: Awaited<ReturnType<typeof startMemoRuntime>>;
let serial = 1;
before(async () => { runtime = await startMemoRuntime(); });
after(async () => { await runtime?.mf.dispose(); });

function request(path: string, { method = 'GET', body, cookie, ip = '203.0.113.1', headers = {} }: {
  method?: string; body?: unknown; cookie?: string | undefined; ip?: string; headers?: Record<string, string>;
} = {}) {
  return runtime.mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie && { Cookie: cookie }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
const send = (email: string, ip: string) => request('/memo/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' }, ip });
const verify = (email: string, otp: string, ip: string) => request('/memo/auth/sign-in/email-otp', { method: 'POST', body: { email, otp }, ip });
async function login(email: string) {
  const ip = `203.0.113.${++serial}`;
  const sent = await send(email, ip);
  assert.equal(sent.status, 200, await sent.text());
  const otp = runtime.mailbox.get(email.toLowerCase())!;
  assert.match(otp, /^\d{6}$/);
  const response = await verify(email, otp, ip);
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  assert.ok(cookie);
  assert.match(response.headers.get('Set-Cookie')!, /HttpOnly/i);
  assert.match(response.headers.get('Set-Cookie')!, /Secure/i);
  assert.match(response.headers.get('Set-Cookie')!, /Path=\/memo/i);
  assert.deepEqual(await response.json(), { ok: true });
  return { cookie, otp, ip };
}

test('anonymous, forged and encoded requests never receive private content or reader data', async () => {
  for (const path of ['/memo/', '/memo/source.md', '/%6demo/source.md', '/memo//source.md', '/memo/readers/', '/memo/readers/export.csv']) {
    const response = await request(path, { cookie: '__Secure-openmerit_memo.session_token=forged' });
    const body = await response.text();
    assert.match(body, /data-memo-login/, path);
    assert.ok(!body.includes('A choice made once'), path);
    assert.match(response.headers.get('Cache-Control')!, /no-store/);
  }
  const preview = await request('/memo/', { headers: { 'User-Agent': 'Twitterbot/1.0' } });
  assert.match(await preview.text(), /https:\/\/openmerit.ai\/assets\/openmerit-og-v1.png/);
  assert.equal((await runtime.db.prepare('SELECT COUNT(*) AS total FROM memo_readers').first<{ total: number }>())!.total, 0);
  assert.deepEqual(await readdir(new URL('../../site/memo/', import.meta.url)), ['index.html']);
});

test('verified readers retain access across reloads, only actual article visits count, and sign-out revokes access', async () => {
  const { cookie, otp, ip } = await login('reader@example.test');
  for (let i = 0; i < 2; i++) assert.match(await (await request('/memo/', { cookie })).text(), /A choice made once/);
  const source = await request('/memo/source.md', { cookie });
  assert.equal(await source.text(), await readFile(new URL('../../docs/memo-published.md', import.meta.url), 'utf8'));
  await request('/memo/', { cookie, method: 'HEAD' });
  await request('/memo/', { cookie, headers: { 'Sec-Purpose': 'prefetch' } });
  const row = await runtime.db.prepare('SELECT visits FROM memo_readers WHERE email = ?').bind('reader@example.test').first<{ visits: number }>();
  assert.equal(row!.visits, 2);
  for (const path of ['/memo/readers/', '/memo/readers/export.csv']) assert.equal((await request(path, { cookie })).status, 403);
  assert.notEqual((await verify('reader@example.test', otp, ip)).status, 200);
  assert.equal((await request('/memo/auth/sign-out', { method: 'POST', body: {}, cookie })).status, 200);
  assert.match(await (await request('/memo/', { cookie })).text(), /data-memo-login/);
  const { cookie: admin } = await login('admin@example.test');
  assert.match(await (await request('/memo/readers/', { cookie: admin })).text(), /reader@example.test/);
  const csv = await request('/memo/readers/export.csv', { cookie: admin });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /reader@example.test/);
});

test('wrong, exhausted, expired and concurrently reused codes cannot create extra sessions', async () => {
  const email = 'attempts@example.test', ip = '203.0.113.30';
  assert.equal((await send(email, ip)).status, 200);
  const otp = runtime.mailbox.get(email)!;
  for (let i = 0; i < 5; i++) assert.notEqual((await verify(email, otp === '000000' ? '111111' : '000000', ip)).status, 200);
  assert.notEqual((await verify(email, otp, ip)).status, 200);
  const expired = 'expired@example.test';
  assert.equal((await send(expired, '203.0.113.31')).status, 200);
  await runtime.db.prepare('UPDATE verification SET expiresAt = ? WHERE identifier LIKE ?').bind(Date.now() - 1000, '%' + expired + '%').run();
  assert.notEqual((await verify(expired, runtime.mailbox.get(expired)!, '203.0.113.31')).status, 200);
  const { cookie } = await login('session@example.test');
  await runtime.db.prepare('UPDATE session SET expiresAt = ? WHERE userId = (SELECT id FROM user WHERE email = ?)').bind(Date.now() - 1000, 'session@example.test').run();
  assert.match(await (await request('/memo/', { cookie })).text(), /data-memo-login/);
  const concurrent = 'concurrent@example.test';
  assert.equal((await send(concurrent, '203.0.113.50')).status, 200);
  const responses = await Promise.all(Array.from({ length: 4 }, () => verify(concurrent, runtime.mailbox.get(concurrent)!, '203.0.113.50')));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
});

test('origins, auth endpoints, redirects and atomic resend limits preserve the protected boundary', async () => {
  assert.equal((await request('/memo/auth/sign-out', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await request('/memo/auth/sign-up/email', { method: 'POST', body: {} })).status, 404);
  for (const host of ['www.openmerit.ai', 'openmerit-site.example.workers.dev']) {
    const response = await runtime.mf.dispatchFetch(`https://${host}/memo/source.md`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), origin + '/memo/source.md');
    assert.equal(await response.text(), '');
  }
  const moved = await request('/memo/v3/source.md?download=1');
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get('Location'), '/memo/source.md?download=1');
  assert.equal((await request('/memo/v2/source.md')).status, 410);
  const email = 'cooldown@example.test';
  const responses = await Promise.all([51, 52, 53, 54].map(i => send(email, `203.0.113.${i}`)));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 429).length, 3);
  const verification = await runtime.db.prepare('SELECT value FROM verification WHERE identifier LIKE ?').bind('%' + email + '%').first<{ value: string }>();
  assert.ok(!verification!.value.includes(runtime.mailbox.get(email)!));
});
