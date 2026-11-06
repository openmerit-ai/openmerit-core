import assert from 'node:assert/strict';
import test from 'node:test';
import { withPrimaryDomain } from '../domain-migration.mjs';

test('upgraded connections retain the original Cloudflare WebSocket response', async () => {
  const upgrade = { status: 101, webSocket: {} };
  const worker = withPrimaryDomain({ fetch() { return upgrade; } });
  assert.equal(await worker.fetch(new Request('https://openmerit.ai/scout/api/socket'), {}), upgrade);
});

test('the landing page, Scout, sign-in and their assets use the current serving Worker',async()=>{
  const {default:router}=await import('../domain-router.mjs');
  const env={SCOUT:{fetch:request=>new Response(new URL(request.url).pathname)}};
  for(const path of ['/','/styles.css','/scout','/scout/','/scout/api/status','/scout/api/recommend','/scout/mcp','/scout/providers/openai.svg','/scout/data-policy/','/connect','/connect/','/connect/api/device','/favicon.svg','/assets/inter-latin.woff2','/assets/openmerit-og-v1.png','/playground/scout','/playground/scout/'])assert.equal(await(await router.fetch(new Request('https://openmerit.ai'+path),env)).text(),path);
});
test('legacy hosts redirect every method and path, including memo sign-in, to openmerit.ai', async () => {
  for (const from of ['openmerit.site', 'www.openmerit.site', 'www.openmerit.ai']) {
    for (const [method, path] of [['GET', '/scout/?q=a%20b&ref=old'], ['POST', '/memo/auth/sign-in/email-otp']]) {
      const worker = withPrimaryDomain({ fetch() { throw new Error('Redirect reached application'); } });
      const result = await worker.fetch(new Request(`https://${from}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), {});
      assert.equal(result.status, 308);
      assert.equal(result.headers.get('Location'), `https://openmerit.ai${path}`);
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
    }
  }
});
test('authentication retains bindings and secure session cookies', async () => {
  const worker = withPrimaryDomain({ fetch(request, env) {
    assert.equal(env.MEMO_AUTH_SECRET, 'unchanged');
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__Secure-openmerit_memo.session_token=opaque; Path=/memo; Secure; HttpOnly; SameSite=Lax' } });
  } });
  const result = await worker.fetch(new Request('https://openmerit.ai/memo/auth/sign-in/email-otp'), { MEMO_AUTH_SECRET: 'unchanged' });
  assert.match(result.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(await result.text(), '{"ok":true}');
});
test('public documents use .ai metadata and mail links while protected responses retain their status', async () => {
  const worker = withPrimaryDomain({ fetch() { return new Response('<a href="mailto:invest@openmerit.site">Email</a><link rel="canonical" href="https://openmerit.site/memo/">', { status: 403, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'ETag': 'old', 'Content-Length': '123' } }); } });
  const result = await worker.fetch(new Request('https://openmerit.ai/memo/'), {});
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(result.headers.get('ETag'), null);
  assert.equal(result.headers.get('Content-Length'), null);
  assert.match(await result.text(), /invest@openmerit.ai/);
});
test('binary assets remain byte-identical', async () => {
  const data = new Uint8Array([0, 255, 24, 4]);
  const worker = withPrimaryDomain({ fetch() { return new Response(data, { headers: { 'Content-Type': 'image/png', 'ETag': 'image' } }); } });
  const result = await worker.fetch(new Request('https://openmerit.ai/image.png'), {});
  assert.equal(result.headers.get('ETag'), 'image');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), data);
});

test('memo routes preserve the protected service request, responses and session cookies', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const cookie = '__Secure-openmerit_memo.session_token=test; Path=/memo; Secure; HttpOnly; SameSite=Lax';
  const env = { SITE: { async fetch(request) {
    return Response.json({ url: request.url, method: request.method, origin: request.headers.get('origin'), cookie: request.headers.get('cookie'), body: await request.text() }, {
      status: 403, headers: { 'Cache-Control': 'private, no-store', 'Set-Cookie': cookie },
    });
  } } };
  for (const host of ['openmerit.ai', 'openmerit.site']) {
    for (const path of ['/memo', '/memo/', '/memo/source.md', '/memo/readers/', '/memo/readers/export.csv', '/memo/auth/sign-in/email-otp', '/memo.css', '/memo-access.css', '/memo-access.js']) {
      const auth = path.startsWith('/memo/auth/');
      const request = new Request(`https://${host}${path}?ref=restore`, {
        method: auth ? 'POST' : 'GET', headers: { Origin: `https://${host}`, Cookie: 'session=existing' }, ...(auth ? { body: '{"email":"reader@example.com","otp":"123456"}' } : {}),
      });
      const result = await router.fetch(request, env);
      if (host === 'openmerit.site') {
        assert.equal(result.status, 308);
        assert.equal(result.headers.get('location'), `https://openmerit.ai${path}?ref=restore`);
        continue;
      }
      assert.equal(result.status, 403);
      assert.equal(result.headers.get('cache-control'), 'private, no-store');
      assert.equal(result.headers.get('set-cookie'), cookie);
      assert.deepEqual(await result.json(), { url: request.url, method: request.method, origin: `https://${host}`, cookie: 'session=existing', body: auth ? '{"email":"reader@example.com","otp":"123456"}' : '' });
    }
  }
});

test('retired pages and APIs are offline on every public host', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const env = new Proxy({}, { get(target, key) { assert.fail(`Retired routes must not call ${String(key)}`); } });
  for (const host of ['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']) {
    for (const path of ['/index.html', '/scouting', '/playground', '/playground/', '/playground/other', '/playground/scout/extra', '/connections', '/docs', '/docs/', '/docs/scout/', '/docs/scout/source.md', '/docs/manifest.json', '/memoir', '/memo-other/', '/memo.css/extra', '/memo-access.js.map', '/demo/', '/demo/api/session', '/demo/internal/abc/infer', '/engineering/', '/script.js', '/illustrations.js']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        let request = new Request(`https://${host}${path}`, { method });
        let result = await router.fetch(request, env);
        if (result.status === 308) result = await router.fetch(new Request(result.headers.get('location'), { method }), env);
        assert.equal(result.status, 404, `${method} ${host}${path}`);
        assert.equal(result.headers.get('Cache-Control'), 'no-store');
      }
    }
  }
  for (const host of ['dash.openmerit.ai', 'dash.openmerit.site']) for (const path of ['/', '/api/snapshot', '/scout/']) {
    assert.equal((await router.fetch(new Request(`https://${host}${path}`), env)).status, 404);
  }
  const redirect = await router.fetch(new Request('https://www.openmerit.ai/scout/?q=hello'), env);
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), 'https://openmerit.ai/scout/?q=hello');
});
