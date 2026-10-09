import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { reconcileActivity } from '../src/activity-merge.mjs';
import { serviceInventory } from '../client/services.mjs';
import { activityEvidence, requestCountKnown, routeKind } from '../client/routes.mjs';

const now = () => new Date().toISOString();
const line = value => JSON.stringify(value) + '\n';
async function fixture(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-evidence-'));
  await mkdir(join(root, '.openmerit')); t.after(() => rm(root, { recursive: true, force: true }));
  if (config) await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify(config));
  return root;
}
const collect = async root => createCollector(root, await loadConfig(root))();
const record = extra => ({ id: 'request-1', occurredAt: now(), model: 'test-model', ...extra });
function mockCatalog(t, models = [{ id: 'model-from-proxy' }]) {
  t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('/v1/models') ? JSON.stringify({ data: models }) : ''));
}

test('global shell services never enter a project; literal project declarations still do', async t => {
  const root = await fixture(t);
  const fields = { OPENAI_API_KEY: 'FAKE_AUDIT_SECRET', OPENAI_BASE_URL: 'https://api.openai.com/v1', GROQ_API_KEY: 'FAKE_AUDIT_SECRET' };
  const previous = Object.fromEntries(Object.keys(fields).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, fields);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No endpoint is declared'));
  let snapshot = await collect(root);
  assert.deepEqual(serviceInventory(snapshot), []);
  assert.ok(snapshot.sources.every(source => source.id !== 'environment'));
  await writeFile(join(root, '.env'), 'GROQ_API_KEY=FAKE_AUDIT_SECRET\n');
  snapshot = await collect(root);
  assert.deepEqual(serviceInventory(snapshot).map(item => item.name), ['Groq']);
  assert.equal(snapshot.inventory[0].sourceId, 'project:.env');
  assert.doesNotMatch(JSON.stringify(snapshot), /FAKE_AUDIT_SECRET/);
});

test('API-compatible loopback catalogs establish neither runtime role nor physical placement', async t => {
  const root = await fixture(t); mockCatalog(t);
  await writeFile(join(root, '.env'), 'OPENAI_BASE_URL=http://127.0.0.1:19998/v1\n');
  const snapshot = await collect(root);
  assert.equal(snapshot.models.length, 1); assert.equal(snapshot.models[0].location, 'unknown');
  assert.deepEqual(snapshot.hosts, []); assert.deepEqual(snapshot.machine.loadedModels, []);
  assert.equal(snapshot.deployments[0].hostId, null); assert.equal(snapshot.deployments[0].servingMode, 'unknown');
  assert.deepEqual(serviceInventory(snapshot)[0].types, ['unknown']);
  assert.equal(routeKind({ route: snapshot.models[0].provider }, snapshot), 'unknown');
});

test('only explicit runtime host links place resident models on this machine or an exported host', async t => {
  const root = await fixture(t, { runtimes: [{ name: 'project-runtime', type: 'ollama', url: 'http://127.0.0.1:19998', hostId: 'this-machine', servingMode: 'self-hosted' }] });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ models: [{ name: 'resident-model', size_vram: 1024 }] })));
  let snapshot = await collect(root);
  assert.equal(snapshot.hosts.length, 1); assert.equal(snapshot.hosts[0].loadedModels[0].name, 'resident-model');
  assert.equal(snapshot.models[0].location, 'local'); assert.equal(snapshot.deployments[0].hostId, 'this-machine');
  assert.equal(snapshot.deployments[0].servingMode, 'self-hosted');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ runtimes: [{ name: 'tunnel', type: 'ollama', url: 'http://127.0.0.1:19998', hostId: 'gpu-remote', location: 'private' }] }));
  await writeFile(join(root, '.openmerit/hosts.json'), JSON.stringify({ hosts: [{ id: 'gpu-remote', observedAt: now() }] }));
  snapshot = await collect(root);
  assert.deepEqual(snapshot.hosts.map(host => host.id), ['gpu-remote']);
  assert.equal(snapshot.deployments[0].hostId, 'gpu-remote'); assert.equal(snapshot.models[0].location, 'private');
  assert.deepEqual(snapshot.machine.loadedModels, []);
});

test('task summaries remain separate with or without request logs', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.openmerit/events.jsonl'), line({ id: 'summary-1', type: 'automation_signal_recorded', occurredAt: now(), data: { signalType: 'product_task_completed', targetId: 'job', modelId: 'summary-model', telemetry: { inputTokens: 500, cost: 5, currency: 'USD' } } }));
  let snapshot = await collect(root);
  assert.equal(snapshot.taskSummaries.length, 1); assert.equal(snapshot.taskSummaries[0].kind, 'task-summary');
  assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.models, []);
  assert.equal(requestCountKnown(snapshot), false); assert.equal(snapshot.history.first, null);
  assert.equal(snapshot.sources.find(source => source.id === 'openmerit').summaries, 1);
  await writeFile(join(root, '.openmerit/inference.jsonl'), line(record({ status: 'completed', cost: 1, currency: 'USD', costKind: 'reported' })));
  snapshot = await collect(root);
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].cost, 1); assert.equal(snapshot.taskSummaries.length, 1);
  assert.deepEqual(snapshot.models.map(model => model.name), ['test-model']);
});

test('missing or invalid status, currency and cost basis never become successful dollar claims', () => {
  for (const extra of [{}, { status: 'not-a-status', currency: 'EUR', costKind: 'not-a-basis' }]) {
    const item = normalizeRecord(record({ cost: 2, ...extra }), 'activity');
    assert.equal(item.status, 'unknown'); assert.equal(item.currency, 'unknown'); assert.equal(item.costKind, 'unknown');
    assert.equal(item.cost, 2);
  }
  const explicit = normalizeRecord(record({ status: 'failed', cost: 0, currency: 'USD', costKind: 'estimated' }), 'activity');
  assert.equal(explicit.status, 'failed'); assert.equal(explicit.cost, 0); assert.equal(explicit.currency, 'USD'); assert.equal(explicit.costKind, 'estimated');
});

test('an unknown duplicate status cannot complete a running request', () => {
  const base = normalizeRecord(record({ status: 'running' }), 'a');
  const merged = reconcileActivity([{ sourceId: 'a', records: [base] }, { sourceId: 'b', records: [{ ...base, sourceId: 'b', status: 'unknown' }] }]);
  assert.equal(merged.records[0].status, 'running');
  const finished = reconcileActivity([{ sourceId: 'a', records: [{ ...base, status: 'unknown' }] }, { sourceId: 'b', records: [{ ...base, sourceId: 'b', status: 'completed' }] }]);
  assert.equal(finished.records[0].status, 'completed');
});

test('catalog limits retain bounded inventory and expose omission counts on the source', async t => {
  const root = await fixture(t); mockCatalog(t, Array.from({ length: 125 }, (_, i) => ({ id: `model-${i}` })));
  await writeFile(join(root, '.env'), 'OPENAI_BASE_URL=http://127.0.0.1:19998/v1\n');
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.endpointInventory);
  assert.equal(snapshot.models.length, 100); assert.equal(source.state, 'partial'); assert.equal(source.truncated, true);
  assert.deepEqual(source.limits, [{ collection: 'models', limit: 100, omitted: 25 }]); assert.match(source.note, /25 models/);
});

test('Ollama residency limits remain partial and never turn omitted residents into installed-only models', async t => {
  const root = await fixture(t, { ollama: 'http://127.0.0.1:19998' });
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify({ models: url.endsWith('/api/tags') ? [{ name: 'last-loaded' }] : [...Array.from({ length: 100 }, (_, i) => ({ name: `loaded-${i}` })), { name: 'last-loaded' }] })));
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.id === 'ollama');
  assert.equal(source.state, 'partial'); assert.deepEqual(source.limits, [{ collection: 'loadedModels', limit: 100, omitted: 1 }]);
  assert.equal(snapshot.models.find(model => model.name === 'last-loaded').state, 'unknown');
});

test('host and nested device/model caps disclose exactly what was omitted', async t => {
  const root = await fixture(t);
  const hosts = Array.from({ length: 70 }, (_, i) => ({ id: `host-${i}`, observedAt: now() }));
  hosts[0].accelerators = Array.from({ length: 17 }, (_, i) => ({ id: `device-${i}` }));
  hosts[0].loadedModels = Array.from({ length: 101 }, (_, i) => ({ id: `model-${i}`, name: `model-${i}` }));
  await writeFile(join(root, '.openmerit/hosts.json'), JSON.stringify({ hosts }));
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.id === 'hardware');
  assert.equal(snapshot.hosts.length, 64); assert.equal(source.state, 'partial');
  assert.deepEqual(source.limits.map(item => [item.collection, item.omitted]), [['hosts', 6], ['hosts[].accelerators', 1], ['hosts[].loadedModels', 1]]);
});

test('configuration and capacity export caps are visible rather than silently complete', async t => {
  const root = await fixture(t, { inventory: Array.from({ length: 105 }, (_, i) => ({ name: `m-${i}`, kind: 'model' })), deployments: Array.from({ length: 201 }, (_, i) => ({ id: `d-${i}`, model: `m-${i}` })), capacityPools: Array.from({ length: 101 }, (_, i) => ({ id: `p-${i}` })) });
  await writeFile(join(root, '.openmerit/capacity.json'), JSON.stringify({ pools: Array.from({ length: 102 }, (_, i) => ({ id: `p-${i}`, observedAt: now(), metrics: { running: 0 } })) }));
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.id === 'inventory');
  assert.equal(source.state, 'partial');
  assert.deepEqual(source.limits.map(item => [item.collection, item.omitted]), [['inventory', 5], ['deployments', 1], ['capacityPools', 1]]);
  assert.equal(snapshot.sources.find(item => item.id === 'capacity').limits[0].omitted, 2);
});

test('discovered endpoint caps disclose coverage after deduplication', async t => {
  const root = await fixture(t); mockCatalog(t);
  const fields = ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'ANTHROPIC_BASE_URL', 'GROQ_BASE_URL', 'CEREBRAS_BASE_URL', 'BASETEN_BASE_URL'];
  await writeFile(join(root, '.env'), fields.map((field, i) => `${field}=http://127.0.0.1:${19000+i}`).join('\n'));
  await writeFile(join(root, '.env.local'), fields.map((field, i) => `${field}=http://127.0.0.1:${19100+i}`).join('\n'));
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.id === 'runtime-discovery');
  assert.equal(snapshot.discovery.runtimeCandidates, 8); assert.equal(source.state, 'partial'); assert.equal(source.limits[0].omitted, 4);
});

test('activity distinguishes unknown coverage, a measured zero, and missing request statuses', () => {
  const absent = { records: [], sources: [{ id: 'openmerit', state: 'connected' }] };
  assert.deepEqual(activityEvidence(absent), { known: false, count: null, failures: null, reportedFailures: 0, unknownStatuses: 0 });
  const measured = { records: [], sources: [{ id: 'activity', state: 'connected' }] };
  assert.equal(activityEvidence(measured).count, 0); assert.equal(activityEvidence(measured).failures, 0);
  const unknownStatus = { records: [normalizeRecord(record(), 'activity')], sources: [] };
  assert.equal(activityEvidence(unknownStatus).count, 1); assert.equal(activityEvidence(unknownStatus).failures, null);
  assert.equal(activityEvidence(unknownStatus).unknownStatuses, 1);
});

test('explicit runtime and nested pool-reference limits are disclosed on configuration', async t => {
  const root = await fixture(t, { runtimes: Array.from({ length: 9 }, (_, i) => ({ type: 'openai-compatible', url: `http://127.0.0.1:${19900+i}` })), inventory: [{ name: 'edge', kind: 'gateway', poolIds: Array.from({ length: 18 }, (_, i) => `pool-${i}`) }] });
  mockCatalog(t);
  const snapshot = await collect(root), source = snapshot.sources.find(item => item.id === 'inventory');
  assert.equal(snapshot.sources.filter(item => item.endpointInventory).length, 8);
  assert.equal(snapshot.inventory.find(item => item.name === 'edge').poolIds.length, 16);
  assert.equal(source.state, 'partial');
  assert.deepEqual(source.limits, [{ collection: 'runtimes', limit: 8, omitted: 1 }, { collection: 'inventory[].poolIds', limit: 16, omitted: 2 }]);
});
