import assert from 'node:assert/strict';
import test from 'node:test';
import { withPrimaryDomain } from '../domain-migration.mjs';

const enabled = { DOMAIN_REDIRECTS_ENABLED: 'true' };
test('upgraded connections retain the original Cloudflare WebSocket response', async () => {
  const upgrade = { status: 101, webSocket: {} };
  const worker = withPrimaryDomain({ fetch() { return upgrade; } });
  assert.equal(await worker.fetch(new Request('https://openmerit.ai/demo/api/socket'), enabled), upgrade);
});

test('the landing page, Scout, sign-in and their assets use the current serving Worker',async()=>{
  const {default:router}=await import('../domain-router.mjs');
  const env={...enabled,SCOUT:{fetch:request=>new Response(new URL(request.url).pathname)}};
  for(const path of ['/','/styles.css','/script.js','/illustrations.js','/assets/motion/hero-frame-0-transparent-v3.webp','/scout','/scout/','/scout/api/status','/scout/api/recommend','/scout/mcp','/scout/providers/openai.svg','/scout/data-policy/','/connect','/connect/','/connect/api/device','/favicon.svg','/assets/inter-latin.woff2','/assets/openmerit-og-v1.png'])assert.equal(await(await router.fetch(new Request('https://openmerit.ai'+path),env)).text(),path);
});
test('legacy pages preserve path and query while redirecting to the matching primary host', async () => {
  for (const [kind, from, to] of [
    ['site', 'openmerit.site', 'openmerit.ai'],
    ['site', 'www.openmerit.site', 'openmerit.ai'],
    ['site', 'www.openmerit.ai', 'openmerit.ai'],
    ['site', 'openmerit-site.listenlater-lazim.workers.dev', 'openmerit.ai'],
    ['terminal', 'dash.openmerit.site', 'dash.openmerit.ai'],
  ]) {
    const worker = withPrimaryDomain({ fetch() { throw new Error('Redirect reached application'); } }, kind);
    const result = await worker.fetch(new Request(`https://${from}/docs/first-trial/?q=a%20b&ref=old`), enabled);
    assert.equal(result.status, 308);
    assert.equal(result.headers.get('Location'), `https://${to}/docs/first-trial/?q=a%20b&ref=old`);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});
test('in-flight legacy API calls retain their request and strict original auth origin', async () => {
  for (const path of ['/demo/api/session', '/demo/internal/abc/infer', '/memo/auth/sign-in/email-otp']) {
    const request = new Request('https://openmerit.site' + path, { method: 'POST', headers: { Origin: 'https://openmerit.site' }, body: '{}' });
    const worker = withPrimaryDomain({ fetch(actual, env) {
      assert.equal(actual, request);
      assert.equal(env.MEMO_AUTH_ORIGIN, 'https://openmerit.site');
      assert.equal(env.MEMO_DB, 'same-database');
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    } });
    assert.equal((await worker.fetch(request, { ...enabled, MEMO_DB: 'same-database' })).status, 200);
  }
});
test('new-domain authentication retains bindings and secure session cookies', async () => {
  const worker = withPrimaryDomain({ fetch(request, env) {
    assert.equal(env.MEMO_AUTH_ORIGIN, 'https://openmerit.ai');
    assert.equal(env.MEMO_AUTH_SECRET, 'unchanged');
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__Secure-openmerit_memo.session_token=opaque; Path=/memo; Secure; HttpOnly; SameSite=Lax' } });
  } });
  const result = await worker.fetch(new Request('https://openmerit.ai/memo/auth/sign-in/email-otp'), { ...enabled, MEMO_AUTH_SECRET: 'unchanged' });
  assert.match(result.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(await result.text(), '{"ok":true}');
});
test('already-open legacy dashboards can continue fetching their same-origin APIs', async () => {
  const request = new Request('https://dash.openmerit.site/api/snapshot');
  const response = new Response('{"preview":true}', { headers: { 'Content-Type': 'application/json' } });
  const worker = withPrimaryDomain({ fetch(actual) {
    assert.equal(actual, request);
    return response;
  } }, 'terminal');
  assert.equal(await worker.fetch(request, enabled), response);
});
test('public documents use .ai metadata and mail links while protected responses retain their status', async () => {
  const worker = withPrimaryDomain({ fetch() { return new Response('<a href="mailto:invest@openmerit.site">Email</a><link rel="canonical" href="https://openmerit.site/memo/">', { status: 403, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'ETag': 'old', 'Content-Length': '123' } }); } });
  const result = await worker.fetch(new Request('https://openmerit.ai/memo/'), enabled);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(result.headers.get('ETag'), null);
  assert.equal(result.headers.get('Content-Length'), null);
  assert.match(await result.text(), /invest@openmerit.ai/);
});
test('binary assets remain byte-identical and staging leaves legacy pages available', async () => {
  const data = new Uint8Array([0, 255, 24, 4]);
  const worker = withPrimaryDomain({ fetch() { return new Response(data, { headers: { 'Content-Type': 'image/png', 'ETag': 'image' } }); } });
  for (const host of ['openmerit.ai', 'openmerit.site']) {
    const result = await worker.fetch(new Request(`https://${host}/image.png`), {});
    assert.equal(result.headers.get('ETag'), 'image');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), data);
  }
});

test('memo routes preserve the protected service request, responses and session cookies', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const cookie = '__Secure-openmerit_memo.session_token=test; Path=/memo; Secure; HttpOnly; SameSite=Lax';
  const env = { ...enabled, SITE: { async fetch(request) {
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
      let result = await router.fetch(request, env);
      if (host === 'openmerit.site' && !auth) {
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

test('the rebuild takes retired pages and APIs offline on every public host', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const env = new Proxy(enabled, { get(target, key) { if (key in target) return target[key]; assert.fail(`Retired routes must not call ${String(key)}`); } });
  for (const host of ['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']) {
    for (const path of ['/index.html', '/scouting', '/connections', '/docs', '/docs/', '/docs/scout/', '/docs/scout/source.md', '/docs/manifest.json', '/memoir', '/memo-other/', '/memo.css/extra', '/memo-access.js.map', '/demo/', '/demo/api/session', '/demo/internal/abc/infer', '/engineering/']) {
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
