import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAccess } from '../src/access.mjs';
import { discoverProject, discoveryCandidates, envDeclarations, loopbackEndpoint } from '../src/discovery.mjs';
import { createPiHistory, piUsageRecord } from '../src/pi-history.mjs';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { routeKind, routeBreakdown } from '../client/routes.mjs';

const jsonl = value => `${JSON.stringify(value)}\n`;
const message = (id = 'call-1', overrides = {}) => ({ type: 'message', id, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'example-model', provider: 'example-provider', content: [{ type: 'text', text: 'PRIVATE_CONVERSATION' }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: { total: 0.001 } }, stopReason: 'stop' }, ...overrides });
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'openmerit-discovery-')));
  const root = join(base, 'project'), home = join(base, 'home');
  await mkdir(join(root, '.openmerit'), { recursive: true }); await mkdir(home);
  const access = createAccess(root, { home, env: {} });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, home, access };
}
async function session(f, name = 'test.jsonl', entries = [message()], header = {}) {
  await mkdir(f.access.path, { recursive: true });
  const path = join(f.access.path, name);
  await writeFile(path, jsonl({ type: 'session', version: 3, id: name, cwd: f.root, ...header }) + entries.map(jsonl).join(''));
  return path;
}
function mockRuntime(t, catalog = { data: [{ id: 'fixture-model' }] }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === 'http://127.0.0.1:19991/v1/models') return new Response(JSON.stringify(catalog));
    if (url === 'http://127.0.0.1:19991/metrics') return new Response('vllm:num_requests_running 2\nvllm:prompt_tokens_total 5000\n');
    throw new Error('Fixture has no service here');
  });
  return calls;
}

test('literal project declarations never execute expressions or retain credentials', () => {
  const values = envDeclarations(`export OPENAI_API_KEY="TOP_SECRET" # comment\nANTHROPIC_API_KEY=\nGROQ_API_KEY=$(bad-command)\nCEREBRAS_API_KEY=$TOKEN\nOPENAI_BASE_URL='http://localhost:19991/v1'\nUNRELATED_PASSWORD=UNRELATED_SECRET`);
  assert.deepEqual(values, { OPENAI_API_KEY: 'present', ANTHROPIC_API_KEY: '', OPENAI_BASE_URL: 'http://localhost:19991/v1' });
  assert.doesNotMatch(JSON.stringify(values), /SECRET|bad-command|TOKEN/);
  for (const url of ['https://127.0.0.1:1234', 'http://user:pass@localhost:1234', 'http://127.0.0.1:1234/private', 'http://localhost:1234/?secret=x', 'https://api.openai.com/v1', 'http://10.0.0.1:8000']) assert.equal(loopbackEndpoint(url), null);
  assert.equal(loopbackEndpoint('http://localhost:19991/v1'), 'http://127.0.0.1:19991');
});

test('project discovery separates declarations, SDK hints, and local endpoint candidates', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), 'GROQ_API_KEY=TOP_SECRET\nOPENAI_BASE_URL=http://127.0.0.1:19991/v1\n');
  await writeFile(join(f.root, '.env.local'), 'CEREBRAS_API_KEY=ANOTHER_SECRET\n');
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '1', 'irrelevant-sdk': '1' } }));
  await writeFile(join(f.root, 'requirements.txt'), 'openai>=1\n-e https://untrusted.invalid/package\n');
  const result = await discoverProject(f.root, {});
  assert.deepEqual(result.inventory.map(item => item.name).sort(), ['Cerebras', 'Groq']);
  assert.equal(result.runtimes[0].url, 'http://127.0.0.1:19991');
  assert.equal(result.runtimes[0].discoverySource, 'project:.env');
  assert.equal(result.sources.filter(item => item.state === 'detected').length, 2);
  assert.equal(result.inventory.some(item => item.name === 'Anthropic' || item.name === 'OpenAI'), false);
  assert.equal(result.sources.find(item => item.id === 'project:.env').state, 'connected');
  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|ANOTHER_SECRET|untrusted/);
  const candidates = discoveryCandidates(result, [{ url: 'http://localhost:1234' }], 'http://127.0.0.1:11434');
  assert.equal(candidates.some(item => item.url.endsWith(':1234')), false);
  assert.equal(candidates.find(item => item.url.endsWith(':19991')).discoverySource, 'project:.env');
});

test('project discovery refuses outside symlinks, oversized files, nonfiles, and malformed manifests', async t => {
  const f = await fixture(t);
  await writeFile(join(f.base, 'outside'), 'OPENAI_API_KEY=PRIVATE_SECRET');
  await symlink(join(f.base, 'outside'), join(f.root, '.env'));
  await writeFile(join(f.root, '.env.local'), 'x'.repeat(128 * 1024 + 1));
  await mkdir(join(f.root, 'requirements.txt'));
  await writeFile(join(f.root, 'package.json'), '{broken');
  const result = await discoverProject(f.root, {});
  assert.equal(result.sources.length, 4); assert.ok(result.sources.every(item => item.state === 'unavailable'));
  assert.equal(result.inventory.length, 0); assert.equal(result.runtimes.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
});

test('access is opt-in, stored outside the project, exact to project and canonical history path, and revocable', async t => {
  const f = await fixture(t);
  assert.equal((await f.access.status()).state, 'not_found');
  await session(f);
  await writeFile(join(f.root, '.openmerit/terminal-access.json'), JSON.stringify({ version: 1, grants: [{ source: 'pi', project: f.root, path: f.access.path, allowed: true }] }));
  assert.equal((await f.access.status()).state, 'needs_access');
  await f.access.set(true);
  assert.equal((await createAccess(f.root, { home: f.home, env: {} }).status()).state, 'allowed');
  if (process.platform !== 'win32') assert.equal((await stat(f.access.file)).mode & 0o777, 0o600);
  const moved = f.access.path + '-moved'; await rename(f.access.path, moved); await symlink(moved, f.access.path);
  assert.equal((await f.access.status()).state, 'needs_access');
  await f.access.set(false); assert.equal((await f.access.status()).state, 'denied');
  const different = join(f.base, 'other'); await mkdir(different);
  const other = createAccess(different, { home: f.home, env: { PI_CODING_AGENT_DIR: join(f.home, '.pi/agent') } });
  assert.equal((await other.status()).state, 'not_found');
  const nestedHome = join(f.root, 'home'); await mkdir(nestedHome);
  const unsafe = createAccess(f.root, { home: nestedHome, env: {} }); await mkdir(unsafe.path, { recursive: true });
  await assert.rejects(unsafe.set(true), /outside the selected project/);
});

test('Pi usage projection preserves the recorded connection without inventing timing, hops, or identities', () => {
  const record = piUsageRecord(message(), 'session', normalizeRecord);
  assert.equal(record.id, 'pi:session:call-1'); assert.equal(record.inputTokens, 140); assert.equal(record.outputTokens, 20);
  assert.equal(record.cacheReadTokens, 30); assert.equal(record.costKind, 'estimated'); assert.equal(record.cost, 0.001);
  assert.equal(record.workload, 'Pi'); assert.equal(record.agentId, null); assert.equal(record.taskId, null);
  assert.equal(record.modelCreator, null); assert.equal(record.durationMs, null); assert.equal(record.routeKind, null);
  assert.equal(record.route, 'example-provider'); assert.deepEqual(record.path, []); assert.equal(record.deploymentId, null);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_CONVERSATION|content/);
  const pending = message(); pending.message.stopReason = 'pending'; assert.equal(piUsageRecord(pending, 'session', normalizeRecord), null);
  const incomplete = message(); delete incomplete.message.usage.cacheWrite;
  assert.equal(piUsageRecord(incomplete, 'session', normalizeRecord).inputTokens, null);
});

test('Pi reader gates reads, validates source version and project, follows appended records, and clears on revoke', async t => {
  const f = await fixture(t), file = await session(f), read = createPiHistory(f.access, normalizeRecord);
  assert.equal((await read()).records.length, 0);
  await f.access.set(true);
  await session(f, 'other.jsonl', [message('wrong')], { cwd: f.home });
  await session(f, 'future-version.jsonl', [message('wrong-version')], { version: 4 });
  await symlink(file, join(f.access.path, 'copy.jsonl'));
  let result = await read(); assert.equal(result.records.length, 1); assert.equal(result.source.state, 'partial');
  const update = message(); update.message.usage.output = 50;
  const line = jsonl(update); await appendFile(file, line.slice(0, -2));
  assert.equal((await read()).records[0].outputTokens, 20);
  await appendFile(file, line.slice(-2)); result = await read();
  assert.equal(result.records.length, 1); assert.equal(result.records[0].outputTokens, 50);
  await appendFile(file, jsonl(message('old', { timestamp: new Date(Date.now() - 90000000).toISOString() })) + jsonl(message('future', { timestamp: new Date(Date.now() + 90000000).toISOString() })));
  assert.equal((await read()).records.length, 1);
  await f.access.set(false); result = await read(); assert.equal(result.records.length, 0); assert.equal(result.source.state, 'disabled');
  await f.access.set(true); await rm(file); assert.equal((await read()).records.length, 0);
});

test('Pi tail limits remain disclosed across polls and replaced files reset cached records', async t => {
  const f = await fixture(t), file = await session(f, 'large.jsonl', []);
  await appendFile(file, jsonl({ type: 'message', padding: 'x'.repeat(600 * 1024) }) + jsonl(message()));
  await f.access.set(true); const read = createPiHistory(f.access, normalizeRecord);
  let result = await read(); assert.equal(result.source.state, 'partial'); assert.equal(result.records.length, 1);
  assert.equal((await read()).source.state, 'partial');
  await session(f, 'replacement.tmp', [message('replacement')]); await rename(join(f.access.path, 'replacement.tmp'), file);
  result = await read(); assert.equal(result.records.length, 1); assert.equal(result.records[0].id, 'pi:replacement.tmp:replacement'); assert.equal(result.source.state, 'connected');
});

test('dash discovers runtime inventory without config, never invokes inference or cloud URLs, and remembers outages', async t => {
  const f = await fixture(t), calls = mockRuntime(t);
  await writeFile(join(f.root, '.env'), 'OPENAI_BASE_URL=http://127.0.0.1:19991/v1\nGROQ_API_KEY=PRIVATE_KEY\n');
  const config = await loadConfig(f.root); config.ollama = null;
  const collect = createCollector(f.root, config, 15, { access: f.access });
  let data = await collect();
  assert.equal(data.discovery.enabled, true); assert.equal(data.records.length, 0);
  assert.equal(data.models.find(item => item.name === 'fixture-model').provider, 'vLLM · 127.0.0.1:19991');
  assert.equal(data.runtimeStats[0].inputTokens, 5000); assert.equal(data.inventory.some(item => item.name === 'Groq'), true);
  assert.ok(calls.every(item => /^http:\/\/127\.0\.0\.1:\d+\/(v1\/models|metrics)$/.test(item.url)));
  assert.ok(calls.every(item => item.options.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_KEY/);
  const before = calls.length; await collect(); assert.equal(calls.length - before, 2, 'only a responding discovered runtime is polled between discovery passes');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
  data = await collect(); assert.equal(data.models.length, 0); assert.equal(data.sources.find(item => item.id.includes('19991')).state, 'unavailable');
});

test('unsupported local responses do not create services and disabled discovery makes no extra calls', async t => {
  const f = await fixture(t); const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return new Response(JSON.stringify({ hello: 'world' })); });
  const config = await loadConfig(f.root); config.ollama = null;
  const data = await createCollector(f.root, config, 15, { access: f.access })();
  assert.equal(data.models.length, 0); assert.equal(data.sources.some(item => item.discoverySource), false);
  calls.length = 0; config.discovery = false;
  const disabled = await createCollector(f.root, config, 15, { access: f.access })();
  assert.equal(calls.length, 0); assert.equal(disabled.discovery.enabled, false);
});

test('distinct explicit activity combines with native history; revocation removes native data on next poll', async t => {
  const f = await fixture(t); mockRuntime(t); await session(f); await f.access.set(true);
  const config = await loadConfig(f.root); config.ollama = null;
  const collect = createCollector(f.root, config, 15, { access: f.access });
  let data = await collect(); assert.equal(data.records.length, 1); assert.equal(data.discovery.requestSource, 'pi-history');
  const file = join(f.root, '.openmerit/inference.jsonl');
  await writeFile(file, jsonl({ id: 'explicit', model: 'export-model', occurredAt: new Date().toISOString() }));
  data = await collect(); assert.equal(data.records.length, 2); assert.ok(data.records.some(record => record.id === 'explicit')); assert.equal(data.discovery.requestSource, 'combined');
  await rm(file); await f.access.set(false); data = await collect();
  assert.equal(data.records.length, 0); assert.equal(data.models.some(item => item.name === 'example-model'), false);
});

test('noninteractive access review fails clearly and sample JSON never runs collectors', async t => {
  const f = await fixture(t), cli = resolve('src/cli.mjs');
  const run = args => spawnSync(process.execPath, [cli, 'dash', f.root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  let result = run(['--access']); assert.equal(result.status, 1); assert.match(result.stderr, /interactive terminal/);
  result = run(['--revoke-access', '--json']); assert.equal(result.status, 1); assert.match(result.stderr, /without --json/);
  await writeFile(join(f.root, '.openmerit/terminal.json'), '{malformed');
  result = run(['--demo', '--json']); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).mode, 'sample');
  assert.doesNotMatch(result.stdout, /Allow Pi|PRIVATE_CONVERSATION/);
});

test('changing canonical access during a read cannot expose the previous directory metadata', async t => {
  const f = await fixture(t); await session(f); await f.access.set(true);
  const permission = await f.access.status(); let checks = 0;
  const access = { status: async () => ++checks === 1 ? permission : { ...permission, path: permission.path + '-changed' } };
  const result = await createPiHistory(access, normalizeRecord)();
  assert.equal(result.records.length, 0); assert.equal(result.source.state, 'partial');
});


test('Pi connection names resolve against evidence without treating generic serving providers as routes', () => {
  for (const [name, snapshot, expected] of [
    ['Ollama', { sources: [{ name: 'Ollama', kind: 'Local runtime', state: 'connected' }] }, 'local'],
    ['workstation-inference', { inventory: [{ name: 'workstation-inference', kind: 'runtime', location: 'local' }] }, 'local'],
    ['team-edge', { inventory: [{ name: 'team-edge', kind: 'gateway' }] }, 'gateway'],
    ['custom-provider', {}, 'unknown'],
    ['shared-name', { inventory: [{ name: 'shared-name', kind: 'runtime', location: 'local' }, { name: 'shared-name', kind: 'gateway' }] }, 'unknown'],
  ]) {
    const entry = message(); entry.message.provider = name;
    const record = piUsageRecord(entry, 'session', normalizeRecord);
    assert.equal(record.route, name); assert.equal(record.routeKind, null);
    assert.equal(routeKind(record, snapshot), expected);
    assert.equal(record.deploymentId, null); assert.deepEqual(record.path, []);
  }
  const generic = normalizeRecord({ id: 'export', occurredAt: new Date().toISOString(), model: 'm', provider: 'Ollama' }, 'activity');
  assert.equal(routeKind(generic, { sources: [{ name: 'Ollama', kind: 'Local runtime' }] }), 'unknown');
});

test('a named runtime resolves approved Pi history through the normal collector and path totals', async t => {
  const f = await fixture(t); mockRuntime(t);
  const entry = message(); entry.message.provider = 'workstation-inference'; entry.message.model = 'fixture-model';
  await session(f, 'named-runtime.jsonl', [entry]); await f.access.set(true);
  await writeFile(join(f.root, '.openmerit/terminal.json'), JSON.stringify({ ollama: false, runtimes: [{ name: 'workstation-inference', type: 'openai-compatible', url: 'http://127.0.0.1:19991' }] }));
  const data = await createCollector(f.root, await loadConfig(f.root), 15, { access: f.access })();
  assert.equal(data.discovery.requestSource, 'pi-history'); assert.equal(data.records.length, 1);
  assert.equal(data.records[0].route, 'workstation-inference');
  assert.deepEqual(routeBreakdown(data.records, data), { direct: 0, local: 1, router: 0, gateway: 0, unknown: 0 });
  assert.equal(data.records[0].deploymentId, null);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_CONVERSATION/);
});
