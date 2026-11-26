import assert from 'node:assert/strict';
import test from 'node:test';
import { withPrimaryDomain } from '../domain-migration.mjs';

test('upgraded connections retain the original Cloudflare WebSocket response', async () => {
  const upgrade = { status: 101, webSocket: {} };
  const worker = withPrimaryDomain({ fetch() { return upgrade; } });
  assert.equal(await worker.fetch(new Request('https://openmerit.ai/scout/api/socket'), {}), upgrade);
});

test('the landing page, sign-in and their assets use the web Worker; retired Scout pages do not',async()=>{
  const {default:router}=await import('../domain-router.mjs');
  const env={SCOUT:{fetch:request=>new Response(new URL(request.url).pathname)}};
  for(const path of ['/','/styles.css','/scout','/scout/','/scout/api/auth','/scout/api/session','/scout/sign-in.js','/favicon.svg','/assets/geist-sans.woff2','/assets/openmerit-og-v1.png','/playground/scout','/playground/scout/','/vs-routers','/vs-routers/','/find-a-cheaper-llm/','/evals-from-your-code/','/claude-code-and-codex/','/run-locally','/run-locally/'])assert.equal(await(await router.fetch(new Request('https://openmerit.ai'+path),env)).text(),path);
  for(const path of ['/connect','/connect/','/connect/api/device'])assert.equal((await router.fetch(new Request('https://openmerit.ai'+path),env)).status,404,path);
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
    for (const path of ['/index.html', '/scouting', '/playground', '/playground/', '/playground/other', '/playground/scout/extra', '/vs-routers/extra', '/run-locally/extra', '/run-locally.html', '/connections', '/docs', '/docs/', '/docs/scout/', '/docs/scout/source.md', '/docs/manifest.json', '/memoir', '/memo-other/', '/memo.css/extra', '/memo-access.js.map', '/demo/', '/demo/api/session', '/demo/internal/abc/infer', '/engineering/', '/script.js', '/illustrations.js']) {
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

test('MCP, its OAuth metadata and the account API go to the cloud app with the request intact', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const env = { CLOUD_APP_ORIGIN: 'https://cloud.example', SCOUT: { fetch() { assert.fail('Cloud paths must not reach the web Worker'); } } };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    seen.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie'), host: request.headers.get('x-forwarded-host'), body: await request.text() });
    return new Response('{"error":"Sign in first."}', { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer resource_metadata="https://openmerit.ai/.well-known/oauth-protected-resource/mcp"' } });
  };
  try {
    for (const [method, path] of [['POST', '/mcp'], ['GET', '/mcp'], ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-protected-resource/mcp'], ['GET', '/api/me?x=1'], ['POST', '/api/endpoints'], ['DELETE', '/api/account'], ['OPTIONS', '/api/tasks']]) {
      seen.length = 0;
      const body = method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"initialize"}' : undefined;
      const result = await router.fetch(new Request(`https://openmerit.ai${path}`, { method, body, headers: { Authorization: 'Bearer token', Cookie: '__session=site; other=1' } }), env);
      assert.equal(result.status, 401, `${method} ${path}`);
      assert.match(result.headers.get('www-authenticate'), /resource_metadata="https:\/\/openmerit\.ai\//);
      assert.deepEqual(seen, [{ url: `https://cloud.example${path}`, method, authorization: 'Bearer token', cookie: null, host: 'openmerit.ai', body: body ?? '' }]);
    }
    seen.length = 0;
    const redirect = await router.fetch(new Request('https://www.openmerit.ai/mcp', { method: 'POST', body: '{}' }), env);
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), 'https://openmerit.ai/mcp');
    for (const path of ['/mcpx', '/apis', '/api-docs', '/.well-known/oauth-protected-resources', '/scout/api/session']) {
      const scout = { ...env, SCOUT: { fetch: () => new Response('web') } };
      const result = await router.fetch(new Request(`https://openmerit.ai${path}`), scout);
      assert.notEqual(result.status, 401, path);
    }
    assert.deepEqual(seen, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cloud paths fail closed until the cloud app origin is configured', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const env = { CLOUD_APP_ORIGIN: '', SCOUT: { fetch() { assert.fail('Cloud paths must not reach the web Worker'); } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Nothing to proxy to');
  try {
    for (const path of ['/mcp', '/.well-known/oauth-protected-resource', '/api/me']) {
      const result = await router.fetch(new Request(`https://openmerit.ai${path}`, { method: 'POST', body: '{}' }), env);
      assert.equal(result.status, 503, path);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a page GET queues one cookieless $pageview; API, asset, non-GET, bot and legacy requests queue none', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const page = () => new Response('<h1>OpenMerit</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const env = {
    POSTHOG_PROJECT_TOKEN: 'phc_test', POSTHOG_HOST: 'https://posthog.example', CLOUD_APP_ORIGIN: 'https://cloud.example',
    SCOUT: { fetch: request => new URL(request.url).pathname.startsWith('/assets/') ? new Response('x', { headers: { 'Content-Type': 'font/woff2' } }) : page() },
  };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    if (request.url.startsWith('https://posthog.example/')) sent.push({ url: request.url, cookie: request.headers.get('cookie'), body: await request.json() });
    return new Response('{}', { headers: { 'Content-Type': 'text/html' } });
  };
  const headers = { 'User-Agent': 'Mozilla/5.0 Firefox/130', 'CF-Connecting-IP': '203.0.113.7', Referer: 'https://news.example/item?id=1', Cookie: 'session=secret' };
  const visit = async (url, init = {}) => {
    const waits = [];
    const result = await router.fetch(new Request(url, { headers, ...init }), env, { waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
    return result;
  };
  try {
    const result = await visit('https://openmerit.ai/?utm_source=hn&utm_medium=social&utm_campaign=launch&secret=1');
    assert.equal(await result.text(), '<h1>OpenMerit</h1>');
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(sent.length, 1);
    const [{ url, cookie, body }] = sent;
    assert.equal(url, 'https://posthog.example/i/v0/e/');
    assert.equal(cookie, null);
    assert.equal(body.api_key, 'phc_test');
    assert.equal(body.event, '$pageview');
    assert.match(body.distinct_id, /^[0-9a-f]{64}$/);
    assert.match(body.uuid, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    assert.deepEqual(body.properties, {
      interface: 'website', $process_person_profile: false, $current_url: 'https://openmerit.ai/', $pathname: '/', $host: 'openmerit.ai',
      $raw_user_agent: 'Mozilla/5.0 Firefox/130', $ip: '203.0.113.7', $referrer: 'https://news.example', utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch',
    });
    assert.doesNotMatch(JSON.stringify(body), /secret/);
    sent.length = 0;
    await visit('https://openmerit.ai/playground/scout/');
    assert.equal(sent[0]?.body.distinct_id, body.distinct_id, 'same visitor, same day, same ID');
    sent.length = 0;
    await visit('https://openmerit.ai/api/me');
    await visit('https://openmerit.ai/mcp', { method: 'POST', body: '{}' });
    await visit('https://openmerit.ai/assets/geist-sans.woff2');
    await visit('https://openmerit.ai/', { method: 'HEAD' });
    await visit('https://openmerit.ai/', { method: 'POST', body: '{}' });
    await visit('https://openmerit.ai/missing');
    await visit('https://openmerit.site/');
    await visit('https://www.openmerit.ai/');
    await visit('https://openmerit.ai/', { headers: { ...headers, 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    await visit('https://openmerit.ai/', { headers: { ...headers, 'User-Agent': 'HeadlessChrome/130' } });
    assert.deepEqual(sent, []);
    await router.fetch(new Request('https://openmerit.ai/', { headers }), { ...env, POSTHOG_PROJECT_TOKEN: '' }, { waitUntil: () => assert.fail('No token, no capture') });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failing PostHog endpoint never changes the page', async () => {
  const { default: router } = await import('../domain-router.mjs');
  const env = { POSTHOG_PROJECT_TOKEN: 'phc_test', POSTHOG_HOST: 'https://posthog.example', SCOUT: { fetch: () => new Response('<p>ok</p>', { headers: { 'Content-Type': 'text/html' } }) } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  try {
    const waits = [];
    const result = await router.fetch(new Request('https://openmerit.ai/'), env, { waitUntil: promise => waits.push(promise) });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '<p>ok</p>');
    assert.equal(waits.length, 1);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = realFetch;
  }
});
