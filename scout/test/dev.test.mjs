import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('dev server retires agent routes while preserving browser assets and HTTP auth/status', { timeout: 20_000 }, async t => {
  // Exercise the actual HTTP server without rebuilding site assets, refreshing
  // the catalogue, sending analytics or inheriting developer credentials.
  const entry = new URL('../dev.mjs', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(entry)}) {
        if (specifier === '../scripts/build-web-analytics.mjs') return { url: 'data:text/javascript,', shortCircuit: true };
        if (specifier === './sources.mjs') return { url: 'data:text/javascript,export async function refreshSnapshot() { throw new Error("Offline test refresh"); }', shortCircuit: true };
      }
      return next(specifier, context);
    } });
    globalThis.fetch = () => { throw new Error('Unexpected external request'); };
    await import(${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('../../', import.meta.url),
    env: { SCOUT_PORT: '0', SCOUT_OAUTH_ENABLED: 'true', SCOUT_OAUTH_CLIENT_IDS: 'obsolete-client',
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('dev-auth.clerk.accounts.dev$').toString('base64')}`, CLERK_SECRET_KEY: 'sk_test_disposable' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Dev server exited (${code}): ${output}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Scout: (http:\/\/127\.0\.0\.1:\d+)\/scout\//);
      if (match) resolve(match[1]);
    });
  });
  for (const prefix of ['/scout', '/scout/alpha', '/scout/v1', '/scout/v2']) {
    for (const suffix of ['/mcp', '/mcp/', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/scout/mcp']) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE']) {
        const response = await fetch(`${origin}${prefix}${suffix}?agent=claude-code`, { method, redirect: 'manual', headers: { origin: 'https://foreign.test', authorization: 'Bearer obsolete' } });
        assert.equal(response.status, 404, `${method} ${prefix}${suffix}`);
        assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('www-authenticate'), null);
        assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.deepEqual(await response.json(), { error: 'Not found.' });
      }
    }
  }
  assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource/scout/mcp`)).status, 404);
  const page = await fetch(`${origin}/scout/`);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${origin}/scout/api/status`)).status, 200);
  const auth = await fetch(`${origin}/scout/api/auth`);
  assert.equal(auth.status, 200); assert.equal((await auth.json()).frontendApi, 'dev-auth.clerk.accounts.dev');
  const search = await fetch(`${origin}/scout/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"A task"}' });
  assert.equal(search.status, 401); assert.equal((await search.json()).code, 'sign_in_required');
});
