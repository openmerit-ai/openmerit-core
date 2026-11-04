import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverProject, discoveryCandidates, envDeclarations, loopbackEndpoint } from '../src/discovery.mjs';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { routeKind, routeBreakdown } from '../client/routes.mjs';

const jsonl = value => `${JSON.stringify(value)}\n`;
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'openmerit-discovery-')));
  const root = join(base, 'project'), home = join(base, 'home');
  await mkdir(join(root, '.openmerit'), { recursive: true }); await mkdir(home);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, home };
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

test('dash discovers runtime inventory without config, never invokes inference or cloud URLs, and remembers outages', async t => {
  const f = await fixture(t), calls = mockRuntime(t);
  await writeFile(join(f.root, '.env'), 'OPENAI_BASE_URL=http://127.0.0.1:19991/v1\nGROQ_API_KEY=PRIVATE_KEY\n');
  const config = await loadConfig(f.root); config.ollama = null;
  const collect = createCollector(f.root, config, 15);
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
  const data = await createCollector(f.root, config, 15)();
  assert.equal(data.models.length, 0); assert.equal(data.sources.some(item => item.discoverySource), false);
  calls.length = 0; config.discovery = false;
  const disabled = await createCollector(f.root, config, 15)();
  assert.equal(calls.length, 0); assert.equal(disabled.discovery.enabled, false);
});

test('sample JSON never runs collectors', async t => {
  const f = await fixture(t), cli = resolve('src/cli.mjs');
  const run = args => spawnSync(process.execPath, [cli, 'dash', f.root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(f.root, '.openmerit/terminal.json'), '{malformed');
  const result = run(['--demo', '--json']); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).mode, 'sample');
  assert.doesNotMatch(result.stdout, /Allow Pi|PRIVATE_CONVERSATION/);
});

test('application connection names resolve against evidence without treating generic serving providers as routes', () => {
  for (const [name, snapshot, expected] of [
    ['Ollama', { sources: [{ name: 'Ollama', kind: 'Local runtime', state: 'connected' }] }, 'local'],
    ['workstation-inference', { inventory: [{ name: 'workstation-inference', kind: 'runtime', location: 'local' }] }, 'local'],
    ['team-edge', { inventory: [{ name: 'team-edge', kind: 'gateway' }] }, 'gateway'],
    ['custom-provider', {}, 'unknown'],
    ['shared-name', { inventory: [{ name: 'shared-name', kind: 'runtime', location: 'local' }, { name: 'shared-name', kind: 'gateway' }] }, 'unknown'],
  ]) {
    const record = normalizeRecord({ id: 'app-request', occurredAt: new Date().toISOString(), model: 'model', route: name }, 'activity');
    assert.equal(record.route, name); assert.equal(record.routeKind, null);
    assert.equal(routeKind(record, snapshot), expected);
    assert.equal(record.deploymentId, null); assert.deepEqual(record.path, []);
  }
  const generic = normalizeRecord({ id: 'export', occurredAt: new Date().toISOString(), model: 'm', provider: 'Ollama' }, 'activity');
  assert.equal(routeKind(generic, { sources: [{ name: 'Ollama', kind: 'Local runtime' }] }), 'unknown');
});

test('a named runtime resolves application request paths through the normal collector', async t => {
  const f = await fixture(t); mockRuntime(t);
  await writeFile(join(f.root, '.openmerit/inference.jsonl'), jsonl({ id: 'local-app', occurredAt: new Date().toISOString(), model: 'fixture-model', route: 'workstation-inference', scope: 'agent' }));
  await writeFile(join(f.root, '.openmerit/terminal.json'), JSON.stringify({ ollama: false, runtimes: [{ name: 'workstation-inference', type: 'vllm', url: 'http://127.0.0.1:19991', hostId: 'this-machine', servingMode: 'self-hosted' }] }));
  const data = await createCollector(f.root, await loadConfig(f.root), 15)();
  assert.equal(data.discovery.requestSource, 'activity'); assert.equal(data.records.length, 1);
  assert.equal(data.records[0].route, 'workstation-inference');
  assert.deepEqual(routeBreakdown(data.records, data), { direct: 0, local: 1, router: 0, gateway: 0, unknown: 0 });
  assert.equal(data.records[0].deploymentId, null);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_CONVERSATION/);
});
