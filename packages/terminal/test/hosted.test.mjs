import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../hosted/worker.mjs';

const request = (path, options) => new Request(`https://dash.openmerit.ai${path}`, options);
const noAssets = { ASSETS: { fetch() { throw new Error('API must not use an asset fallback'); } } };

test('hosted preview defaults to sample and has no live snapshot or mutation endpoint', async () => {
  const info = await worker.fetch(request('/api/info'), noAssets);
  assert.deepEqual(await info.json(), { version: 1, defaultMode: 'sample', hostedSample: true, interval: 15 });
  for (const path of ['/api/snapshot', '/api/generate', '/api/config']) assert.equal((await worker.fetch(request(path), noAssets)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await worker.fetch(request('/api/sample', { method }), noAssets)).status, 405);
});

test('hosted preview contains the fictional enterprise sample and refreshed timestamps', async () => {
  const response = await worker.fetch(request('/api/sample?sample=0'), noAssets);
  const data = await response.json();
  assert.equal(data.mode, 'sample');
  assert.equal(data.project.name, 'enterprise-sample');
  assert.equal(data.records.length, 9600);
  assert.equal(data.models.length, 21);
  assert.equal(new Set(data.records.map(record => record.agentId)).size, 200);
  assert.equal(new Set(data.records.map(record => record.taskId)).size, 699);
  assert.ok(Math.abs(Date.now() - Date.parse(data.observedAt)) < 16000);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('hosted assets retain content types and restrict indexing, framing, and network access', async () => {
  const env = { ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) } };
  const response = await worker.fetch(request('/'), env);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(response.headers.get('cache-control'), /no-transform/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(await response.text(), '<!doctype html>');
  assert.equal(await (await worker.fetch(request('/', { method: 'HEAD' }), env)).text(), '');
  assert.match(await (await worker.fetch(request('/robots.txt'), noAssets)).text(), /Disallow: \/$/m);
});


test('hosted scripts and styles allow compression while preserving asset content and security headers', async () => {
  for (const [path, contentType, body] of [
    ['/app.js', 'text/javascript; charset=utf-8', 'console.log("sample")'],
    ['/flow.js', 'application/javascript', 'export const ready = true;'],
    ['/styles.css', 'text/css; charset=utf-8', 'body { color: white; }'],
  ]) {
    const env = { ASSETS: { fetch: async () => new Response(body, { headers: { 'Content-Type': contentType, ETag: '"asset-version"' } }) } };
    const response = await worker.fetch(request(path), env);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(response.headers.get('etag'), '"asset-version"');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(await response.text(), body);
  }
});
