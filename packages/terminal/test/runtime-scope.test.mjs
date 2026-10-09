import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, loadConfig } from '../src/collect.mjs';
import { discoverProject } from '../src/discovery.mjs';
import { serviceInventory } from '../client/services.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-runtime-')));
  await mkdir(join(root, '.openmerit'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function runtime(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/api/ps') ? { models: [{ name: 'resident', size_vram: 1024 }] } : { models: [{ name: 'resident' }, { name: 'installed' }], data: [{ id: 'compatible-model' }] }));
  });
  return calls;
}

test('cloud-only projects never probe unrelated local servers or add their models and compute', async t => {
  const root = await fixture(t), calls = runtime(t);
  await writeFile(join(root, '.env.local'), 'OPENAI_API_KEY=TEST_VALUE\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { openai: '1', ollama: '1' } }));
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.equal(calls.length, 0);
  assert.equal(snapshot.models.length, 0);
  assert.equal(snapshot.hosts.length, 0);
  assert.equal(snapshot.machine.projectLinked, false);
  assert.ok(snapshot.sources.every(source => source.kind !== 'Local runtime' && source.id !== 'machine'));
  assert.ok(serviceInventory(snapshot).every(service => !service.types.includes('runtime')));
  assert.ok(snapshot.inventory.some(item => item.name === 'OpenAI'));
  assert.doesNotMatch(JSON.stringify(snapshot), /TEST_VALUE/);
});

test('inherited loopback settings and SDK hints do not establish a project runtime', async t => {
  const root = await fixture(t);
  const endpoints = { OLLAMA_HOST: '127.0.0.1:11434', OPENAI_BASE_URL: 'http://127.0.0.1:8000' };
  const previous = Object.fromEntries(Object.keys(endpoints).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, endpoints);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { ollama: '1', '@lmstudio/sdk': '1' } }));
  const found = await discoverProject(root);
  assert.deepEqual(found.runtimes, []);
});

test('a project Ollama endpoint exposes actual inventory and residency, with declaration evidence', async t => {
  const root = await fixture(t), calls = runtime(t);
  await writeFile(join(root, '.env'), 'OLLAMA_HOST=127.0.0.1:19995\n');
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.deepEqual(calls.map(call => call.url).sort(), ['http://127.0.0.1:19995/api/ps', 'http://127.0.0.1:19995/api/tags']);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.deepEqual(snapshot.models.map(model => model.name).sort(), ['installed', 'resident']);
  assert.equal(snapshot.models.find(model => model.name === 'resident').state, 'loaded');
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.hosts.length, 0, 'an endpoint does not identify the physical host');
  assert.equal(snapshot.deployments[0].hostId, null);
  assert.equal(snapshot.models[0].location, 'unknown');
  const service = serviceInventory(snapshot).find(item => item.name.startsWith('Ollama'));
  assert.ok(service.evidence.some(item => item.sourceId === 'project:.env' && item.field === 'OLLAMA_HOST'));
});

test('removing the declaration removes local models, pools and host on the next discovery pass', async t => {
  const root = await fixture(t), calls = runtime(t);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await writeFile(join(root, '.env.local'), 'OLLAMA_BASE_URL=http://127.0.0.1:19995\n');
  const collect = createCollector(root, await loadConfig(root));
  assert.equal((await collect()).models.length, 2);
  await rm(join(root, '.env.local')); now += 60001; calls.length = 0;
  const snapshot = await collect();
  assert.equal(calls.length, 0); assert.deepEqual(snapshot.models, []); assert.deepEqual(snapshot.hosts, []);
  assert.deepEqual(snapshot.capacityPools, []); assert.deepEqual(snapshot.deployments, []);
});

test('explicit Ollama configuration works with discovery disabled and is not probed twice', async t => {
  const root = await fixture(t), calls = runtime(t);
  await writeFile(join(root, '.env'), 'OLLAMA_BASE_URL=http://localhost:19995\n');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ ollama: 'http://127.0.0.1:19995' }));
  const config = await loadConfig(root);
  let snapshot = await createCollector(root, config)();
  assert.equal(calls.length, 2); assert.equal(snapshot.models.length, 2);
  calls.length = 0; config.discovery = false;
  snapshot = await createCollector(root, config)();
  assert.equal(calls.length, 2); assert.equal(snapshot.hosts.length, 0);
});

test('discovery and Ollama opt-outs suppress declared Ollama endpoints', async t => {
  const root = await fixture(t), calls = runtime(t);
  await writeFile(join(root, '.env'), 'OLLAMA_BASE_URL=http://127.0.0.1:19995\n');
  for (const settings of [{ ollama: false }, { discovery: false }]) {
    await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify(settings));
    const snapshot = await createCollector(root, await loadConfig(root))();
    assert.equal(calls.length, 0); assert.deepEqual(snapshot.models, []); assert.deepEqual(snapshot.hosts, []);
  }
});

test('recorded Ollama requests remain visible without guessing an endpoint or adding unrelated models', async t => {
  const root = await fixture(t), calls = runtime(t);
  await writeFile(join(root, '.openmerit/inference.jsonl'), JSON.stringify({ id: 'actual-request', occurredAt: new Date().toISOString(), model: 'recorded-model', provider: 'Ollama', route: 'Ollama', routeKind: 'local', location: 'local', status: 'completed' }) + '\n');
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.equal(calls.length, 0); assert.equal(snapshot.models.length, 1); assert.equal(snapshot.records.length, 1);
  assert.ok(serviceInventory(snapshot).some(service => service.name === 'Ollama' && service.records.length === 1));
  assert.equal(snapshot.hosts.length, 0, 'a local request does not identify which host ran it');
});
