import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { normalizeHosts, retainHostHistory, hostState } from '../src/hardware.mjs';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { sampleSnapshot } from '../src/sample.mjs';
import { inventoryRouteKind } from '../client/routes.mjs';
import { brandIcon } from '../client/brands.mjs';
import { createHash } from 'node:crypto';

const now = Date.parse('2026-10-07T12:00:00Z');
const observedAt = new Date(now).toISOString();
const host = (extra = {}) => ({ id: 'node-1', name: 'Node 1', site: 'Primary', rack: 'A', observedAt, cpuPercent: 0, memoryTotal: 100, memoryUsed: 0, ...extra });
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'terminal-hardware-')); await mkdir(join(root, '.openmerit')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('host names preserve explicit labels, fall back to reported hostname then ID, and never invent placement', () => {
  const [named, system, idOnly] = normalizeHosts({ hosts: [
    { id: 'a', name: 'inference-worker', hostname: 'gpu-01.internal' },
    { id: 'b', hostname: 'gpu-02.internal', nameField: 'forged' },
    { id: 'c' },
  ] }, now);
  assert.equal(named.name, 'inference-worker'); assert.equal(named.nameField, 'name');
  assert.equal(system.name, 'gpu-02.internal'); assert.equal(system.nameField, 'hostname');
  assert.equal(idOnly.name, 'c'); assert.equal(idOnly.nameField, 'id');
  for (const item of [named, system, idOnly]) { assert.equal(item.site, ''); assert.equal(item.rack, ''); }
});

test('local machine identity comes from the operating system without shortening its hostname', async t => {
  const root = await fixture(t);
  const snapshot = await createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: null, inventory: [] })();
  assert.equal(snapshot.machine.name, hostname()); assert.equal(snapshot.machine.hostname, hostname());
  assert.equal(snapshot.machine.nameField, 'hostname'); assert.equal(snapshot.machine.site, '');
});

test('hardware projection preserves zero and distinguishes missing residency from an empty report', () => {
  const [value] = normalizeHosts({ hosts: [host({ headers: { authorization: 'secret' }, endpoint: 'https://private', accelerators: [{ id: 'a', name: 'GPU', utilization: 101, memoryUsed: 12, memoryTotal: 10 }] })] }, now);
  assert.equal(value.cpuPercent, 0); assert.equal(value.memoryUsed, 0); assert.equal(value.residencyReported, false);
  assert.equal(value.accelerators[0].utilization, null); assert.equal(value.accelerators[0].memoryUsed, null);
  assert.doesNotMatch(JSON.stringify(value), /authorization|secret|https/);
  assert.equal(normalizeHosts({ hosts: [host({ loadedModels: [] })] }, now)[0].residencyReported, true);
  assert.deepEqual(normalizeHosts({ hosts: [host(), host(), host({ id: 'this-machine' })] }, now), []);
  assert.equal(normalizeHosts({ hosts: Array.from({ length: 100 }, (_, i) => host({ id: `n${i}` })) }, now).length, 64);
});

test('host freshness uses measurement time; future and absent timestamps cannot establish residency', () => {
  const model = { id: 'm', name: 'Model', runtime: 'Runtime', memoryKind: 'other', memoryBytes: -1, prompt: 'secret' };
  const [valid] = normalizeHosts({ hosts: [host({ loadedModels: [model] })] }, now);
  assert.equal(hostState(valid, 15, now), 'sampled'); assert.equal(hostState(valid, 15, now + 45001), 'stale');
  assert.equal(valid.loadedModels[0].memoryKind, 'unknown'); assert.equal(valid.loadedModels[0].memoryBytes, null);
  assert.doesNotMatch(JSON.stringify(valid), /prompt|secret/);
  for (const at of [null, new Date(now + 1).toISOString()]) {
    const [value] = normalizeHosts({ hosts: [host({ observedAt: at, loadedModels: [model], cpuPercent: 30 })] }, now);
    assert.equal(hostState(value, 15, now), 'unknown'); assert.equal(value.cpuPercent, null); assert.deepEqual(value.loadedModels, []);
  }
});

test('passive file polls do not synthesize samples; histories are bounded, independent and cleared on loss', () => {
  const histories = new Map();
  const normalize = (at, id = 'node-1') => normalizeHosts({ hosts: [host({ id, observedAt: new Date(at).toISOString() })] }, at);
  for (let i = 0; i < 300; i++) retainHostHistory(normalize(now + i * 15000), histories);
  assert.equal(histories.get('node-1').length, 240);
  let result = retainHostHistory(normalize(now + 299 * 15000), histories);
  assert.equal(result[0].history.length, 240);
  result = retainHostHistory(normalize(now), histories); assert.equal(result[0].history.length, 1);
  result = retainHostHistory(normalize(now, 'other'), histories); assert.equal(histories.has('node-1'), false); assert.equal(result[0].history.length, 1);
  retainHostHistory([], histories); assert.equal(histories.size, 0);
});

test('hardware exports remain project-contained and discard oversized, deleted and invalid data', async t => {
  const root = await fixture(t), outside = await fixture(t), path = join(root, '.openmerit/hosts.json');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ ollama: false }));
  const collect = createCollector(root, await loadConfig(root));
  await writeFile(path, JSON.stringify({ hosts: [host({ loadedModels: [{ id: 'm', name: 'Test model', provider: 'Example', runtime: 'Example' }] })] }));
  let snapshot = await collect(); assert.equal(snapshot.hosts.length, 1); assert.equal(snapshot.hosts[0].id, 'node-1');
  assert.equal(snapshot.hosts[0].observedAt, observedAt); assert.equal(snapshot.hosts[0].history.length, 1);
  snapshot = await collect(); assert.equal(snapshot.hosts[0].history.length, 1);
  assert.equal(snapshot.models.find(model => model.name === 'Test model').location, 'private');
  await writeFile(path, 'x'.repeat(256 * 1024 + 1));
  snapshot = await collect(); assert.equal(snapshot.hosts.length, 0); assert.equal(snapshot.sources.find(source => source.id === 'hardware').state, 'unavailable');
  await rm(path); await writeFile(join(outside, 'hosts.json'), JSON.stringify({ hosts: [host()] })); await symlink(join(outside, 'hosts.json'), path);
  snapshot = await collect(); assert.equal(snapshot.hosts.length, 0);
  await rm(path); snapshot = await collect(); assert.equal(snapshot.sources.find(source => source.id === 'hardware').state, 'not_found');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ hardwareFile: '../hosts.json' }));
  await assert.rejects(loadConfig(root), /inside this project/);
});

test('private location remains explicit without changing the runtime path category', () => {
  assert.equal(inventoryRouteKind({ kind: 'runtime', location: 'private' }), 'local');
  assert.equal(normalizeRecord({ id: 'r', model: 'm', occurredAt: observedAt, location: 'private' }, 'activity').location, 'private');
});

test('sample fleet separates host readings, rack placement, model residency and deployment identity', () => {
  const sample = sampleSnapshot(now);
  assert.equal(sample.hosts.length, 6); assert.equal(sample.machine, sample.hosts[0]);
  assert.equal(sample.hosts.filter(host => hostState(host, 15, now) === 'sampled').length, 4);
  assert.equal(sample.hosts.filter(host => hostState(host, 15, now) === 'stale').length, 1);
  assert.equal(sample.hosts.filter(host => hostState(host, 15, now) === 'unknown').length, 1);
  assert.equal(new Set(sample.hosts.map(host => host.rack).filter(Boolean)).size, 2);
  assert.equal(sample.hosts.reduce((total, host) => total + host.accelerators.length, 0), 11);
  const loaded = sample.hosts.flatMap(host => host.loadedModels.map(model => ({ ...model, hostId: host.id })));
  assert.equal(loaded.length, 7);
  for (const model of loaded) assert.equal(sample.deployments.find(item => item.id === model.deploymentId).hostId, model.hostId);
  assert.equal(sample.runtimeStats[0].hostId, 'gpu-02');
  assert.ok(sample.records.filter(item => item.location === 'private').every(item => item.cost === null));
});

test('brand lookup is exact, local and backed by recorded official asset hashes', async () => {
  assert.match(brandIcon(' OpenAI API '), /\/brands\/openai.png/);
  assert.equal(brandIcon('OpenAI-compatible company gateway'), '');
  assert.equal(brandIcon('https://example.com/icon.png'), '');
  const manifest = JSON.parse(await readFile(new URL('../brand-assets.json', import.meta.url), 'utf8'));
  for (const asset of manifest.assets) {
    const contents = await readFile(new URL(`../public/brands/${asset.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(contents).digest('hex'), asset.sha256);
    assert.ok(asset.source.startsWith('https://'));
  }
});
