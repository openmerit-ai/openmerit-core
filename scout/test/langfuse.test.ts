import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { importLangfuse, parseLangfuse, verifyViewer, type LangfuseConfig } from '../langfuse.ts';
import { handleConnect } from '../connect.mjs';
import { handleMCP } from '../mcp.mjs';
import { scoutAccess } from '../auth.mjs';
import { LocalD1 } from './helpers-projection.mjs';
import type { EvaluationNamespace } from '../evaluation-routes.ts';

const config: LangfuseConfig = {
  region: 'us', publicKey: 'pk-lf-fictional-key', secretKey: 'sk-lf-fictional-secret', from: '2026-11-01', tagPrefix: 'experiment:',
  mappings: [{ metric: 'correct', modelKey: 'model_coding', task: 'Coding', traceName: 'review-coding', level: 'agent', kind: 'quality', higherIsBetter: true }],
  models: { 'provider/first': 'lab/first', 'provider/second': 'lab/second' },
};
const now = Date.parse('2026-11-06T00:00:00Z');

test('browser evaluation routes require a same-origin signed-in session and route only to that user', async () => {
  const owners: string[] = [];
  const env = { SCOUT_EVALUATIONS: { getByName: (user: string) => {
    owners.push(user); return { status: async () => ({ connected: false }) };
  } } };
  const call = (user: string | null, origin = 'https://openmerit.ai') => handleConnect(new Request('https://openmerit.ai/connect/api/langfuse', { headers: { origin } }), env, { session: async () => user });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('alice', 'https://attacker.test')).status, 403);
  assert.deepEqual(owners, []);
  assert.equal((await call('alice')).status, 200);
  assert.equal((await call('bob')).status, 200);
  assert.deepEqual(owners, ['alice', 'bob']);
});

test('headless management is separately approved, user-isolated, revocable and cannot widen recommendation access', async () => {
  const states = new Map<string, { connected: boolean; results: number }>();
  const evaluations: EvaluationNamespace = { getByName(user) {
    const state = states.get(user) ?? { connected: false, results: 0 }; states.set(user, state);
    return {
      status: async () => ({ ...state }),
      configure: async input => { parseLangfuse(input); state.connected = true; return { ...state }; },
      sync: async () => { state.results = state.connected ? 3 : 0; return { ...state }; },
      disconnect: async () => { state.connected = false; state.results = 0; return { ...state }; },
      clear: async () => { state.connected = false; state.results = 0; return { ...state }; },
      measurements: async () => [], report: async () => [],
    };
  } };
  const env = { SCOUT_INDEX: new LocalD1(), SCOUT_EVALUATIONS: evaluations,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`, CLERK_SECRET_KEY: 'fictional' };
  const call = (path: string, key?: string, body?: unknown, method = body ? 'POST' : 'GET', user: string | null = null) => handleConnect(new Request(`https://openmerit.ai/connect/api/${path}`, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { session: async () => user });
  async function issue(client: string, user: string) {
    const login = await (await call('device', undefined, { client, scope: 'user', device_name: 'test laptop' })).json();
    const approval = await (await call(`login?code=${login.user_code}`, undefined, undefined, 'GET', user)).json();
    assert.deepEqual(approval.permissions, [client === 'connector' ? 'scout:connections' : 'scout:recommend']);
    await call('login', undefined, { code: login.user_code, decision: 'approve' }, 'POST', user);
    const issued = await (await call('token', undefined, { device_code: login.device_code })).json();
    assert.equal(issued.scope, approval.permissions[0]);
    return String(issued.access_token);
  }
  const recommend = await issue('claude-code', 'alice'), manager = await issue('connector', 'alice'), bob = await issue('connector', 'bob');
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await call('langfuse', recommend, method === 'POST' ? config : undefined, method)).status, 401);
  for (const path of ['keys', 'login?code=ABCD-EFGH']) assert.equal((await call(path, manager)).status, 401);
  assert.equal((await call('login', manager, { code: 'ABCD-EFGH', decision: 'approve' })).status, 401);
  assert.equal((await call('langfuse', manager, config)).status, 200);
  assert.equal((await (await call('langfuse', manager)).json()).connected, true);
  assert.equal((await (await call('langfuse', bob)).json()).connected, false);
  const mcp = async (key: string, method: string, args?: unknown, extraHeaders = {}) => {
    const request = new Request('https://openmerit.ai/scout/mcp', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(args ? { params: { name: 'scout_connection', arguments: args } } : {}) }) });
    let owner = '', grants: string[] = [];
    const denied = await scoutAccess(request, env, (id: string, permissions: string[]) => { owner = id; grants = permissions; });
    if (denied) return { denied: denied.status };
    return (await handleMCP(request, undefined, owner, undefined, evaluations, grants)).json();
  };
  assert.deepEqual((await mcp(recommend, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name), ['scout_models']);
  assert.deepEqual((await mcp(manager, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name), ['scout_connection']);
  assert.match((await mcp(recommend, 'tools/call', { action: 'clear', confirm: true })).error.message, /separate scout:connections approval/);
  const request = new Request('https://openmerit.ai/scout/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt: 'Should not run' } } }) });
  assert.match((await (await handleMCP(request, undefined, 'alice', undefined, evaluations, ['scout:connections'])).json()).error.message, /manages connections only/);
  assert.equal((await mcp(manager, 'tools/call', { action: 'sync' })).result.structuredContent.results, 3);
  assert.equal((await mcp(manager, 'tools/call', { action: 'disconnect' })).result.isError, true);
  assert.equal((await (await call('langfuse', manager)).json()).connected, true);
  const { publicKey, secretKey, ...settings } = config;
  assert.equal((await mcp(manager, 'tools/call', { action: 'configure', config: settings })).result.isError, true);
  assert.equal((await mcp(manager, 'tools/call', { action: 'configure', config })).result.isError, true, 'keys are rejected in model-visible arguments');
  const configured = await mcp(manager, 'tools/call', { action: 'configure', config: settings }, { 'X-Langfuse-Public-Key': publicKey, 'X-Langfuse-Secret-Key': secretKey });
  assert.equal(configured.result.structuredContent.connected, true);
  assert.doesNotMatch(JSON.stringify(configured), /pk-lf|sk-lf|model_coding/);
  assert.equal((await mcp(manager, 'tools/call', { action: 'disconnect', confirm: true })).result.structuredContent.connected, false);
  assert.equal((await call('keys/self', manager, undefined, 'DELETE')).status, 200);
  assert.equal((await call('langfuse', manager)).status, 401);
  assert.deepEqual(await mcp(manager, 'tools/list'), { denied: 401 });
  assert.equal((await call('langfuse', bob)).status, 200, 'revocation is isolated');
});

test('the connector verifies a read and refuses every non-Viewer probe outcome without a valid write', async () => {
  for (const status of [200, 302, 400, 401, 403, 404, 429, 500]) {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://us.cloud.langfuse.com');
      assert.equal(init?.redirect, 'manual');
      if (url.pathname === '/api/public/experiments') return Response.json({ data: [], meta: {} });
      assert.equal(url.pathname, '/api/public/v2/datasets');
      assert.equal(init?.method, 'POST'); assert.equal(init.body, '{}');
      return new Response(null, { status });
    };
    if (status === 403) await verifyViewer(config, fetcher);
    else await assert.rejects(verifyViewer(config, fetcher), /Viewer key/);
  }
  await assert.rejects(verifyViewer(config, async () => new Response(null, { status: 401 })), /HTTP 401/);
  assert.throws(() => parseLangfuse({ ...config, region: 'https://attacker.test' }));
});

test('MCP sync without a connection gives the browser connection action, not an opaque agent failure', async () => {
  const response = await handleMCP(new Request('https://openmerit.ai/scout/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt: 'Review coding', sync: 'langfuse' } } }),
  }), { getByName: () => ({ turn: () => assert.fail('A failed sync must not start inference') }) }, 'alice', undefined,
  { getByName: () => ({ sync: async () => { throw new Error('Connect Langfuse at https://openmerit.ai/connect/?integration=langfuse first.'); } }) });
  const body = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]?.text ?? '', /Connect Langfuse at https:\/\/openmerit.ai\/connect/);
});

test('aggregate reads isolate each run and trace role, paginate and drop arbitrary metadata and record names', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.method, 'GET');
    const url = new URL(String(input));
    if (url.pathname === '/api/public/experiments') {
      assert.equal(url.searchParams.get('fields'), 'core,metadata');
      return Response.json(url.searchParams.has('cursor') ? { data: [{ id: 'second', metadata: { model_coding: 'provider/second' } }, { id: 'unknown', metadata: { model_coding: 'provider/unknown' } }], meta: {} }
        : { data: [{ id: 'first', name: 'PATIENT_PRIVATE', description: 'PRIVATE', metadata: { model_coding: 'provider/first', input: 'PRIVATE' } }], meta: { cursor: 'next' } });
    }
    assert.equal(url.pathname, '/api/public/v2/metrics');
    const query = JSON.parse(url.searchParams.get('query') ?? '{}');
    assert.deepEqual(query.dimensions, []);
    assert.deepEqual(query.filters.slice(1), [{ column: 'traceName', type: 'string', operator: '=', value: 'review-coding' }, { column: 'name', type: 'string', operator: '=', value: 'correct' }]);
    const first = query.filters[0].value[0] === 'experiment:first';
    return Response.json({ data: [{ avg_value: first ? 0.75 : 1, count_count: first ? 12 : 31, input: 'PRIVATE', comment: 'PRIVATE' }] });
  };
  const imported = await importLangfuse(config, fetcher, now);
  assert.deepEqual(imported.results.map(r => [r.model, r.value, r.samples]), [['lab/first', 0.75, 12], ['lab/second', 1, 31]]);
  assert.equal(imported.unmapped, 1);
  assert.doesNotMatch(JSON.stringify(imported), /PRIVATE|provider\/|"input"|"comment"/);
  await assert.rejects(importLangfuse(config, async () => Response.json({ data: [], meta: { cursor: 'loop' } }), now), /repeated/);
});

test('per-user storage persists only encrypted credentials, isolates users, and disconnect wins an in-flight sync', async () => {
  let release: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  let hold = false;
  const bundle = await build({ stdin: { contents: `
    import { ScoutEvaluations } from './scout/agent/evaluations.ts';
    export class TestEvaluations extends ScoutEvaluations {
      async inspect() { return Object.fromEntries(await this.ctx.storage.list()); }
    }
    export default { async fetch(request, env) {
      const u = new URL(request.url), s = env.EVALS.getByName(u.searchParams.get('user') || 'a');
      const action = u.pathname.slice(1);
      const result = action === 'connect' ? await s.configure(await request.json())
        : action === 'report' ? await s.report(await request.json())
        : action === 'sync' ? await s.sync() : action === 'disconnect' ? await s.disconnect()
        : action === 'inspect' ? await s.inspect()
        : action === 'clear' ? await s.clear() : action === 'status' ? await s.status() : await s.measurements();
      return Response.json(result);
    }};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  // The repository's pinned Miniflare binary supports dates through 2026-09-28.
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-09-28',
    durableObjects: { EVALS: { className: 'TestEvaluations', useSQLite: true } }, bindings: { SCOUT_CONNECTOR_KEY: 'fictional-encryption-secret-for-test' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (request.method === 'POST') return new Response(null, { status: 403 });
      if (url.pathname === '/api/public/experiments') return Response.json({ data: [{ id: 'first', metadata: { model_coding: 'provider/first' } }], meta: {} });
      if (hold) { waiting?.(); await new Promise<void>(resolve => { release = resolve; }); }
      return Response.json({ data: [{ avg_value: 0.75, count_count: 12 }] });
    } }));
  const call = async (path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://local/${path}`, { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200, r.status === 200 ? undefined : await r.text()); return r.json();
  };
  try {
    await call('connect', config);
    assert.doesNotMatch(JSON.stringify(await call('inspect')), /pk-lf|sk-lf|provider\/first/);
    const reported = { level: 'agent', kind: 'quality', task: 'Coding', scope: 'Coding', model: 'lab/second', metric: 'correct', value: 1, samples: 31, source: 'Customer eval', higherIsBetter: true };
    await call('report', [reported]);
    await call('report', [{ ...reported, value: 0.9 }]);
    await call('sync');
    assert.equal((await call('measurements') as unknown[]).length, 2);
    assert.deepEqual(await call('measurements?user=b'), []);
    await call('disconnect');
    assert.equal((await call('measurements') as unknown[]).length, 1);
    assert.equal((await call('inspect') as Record<string, unknown>).credentials, undefined);
    await call('connect', config);
    hold = true;
    const syncing = mf.dispatchFetch('http://local/sync');
    await started;
    await call('disconnect'); release?.();
    const cancelled = await syncing;
    assert.equal(cancelled.status, 500);
    assert.equal((await call('measurements') as unknown[]).length, 1);
    assert.equal((await call('inspect') as Record<string, unknown>).credentials, undefined);
    await call('clear'); assert.deepEqual(await call('measurements'), []);
  } finally { release?.(); await mf.dispose(); }
});
