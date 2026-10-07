import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCapacity, normalizeDeployments, normalizePools, normalizePath } from '../src/topology.mjs';
import { createCollector, loadConfig, normalizeRecord, parseRuntimeMetrics } from '../src/collect.mjs';
import { deploymentFor, poolsFor, poolUsage, capacityState, capacityReadings } from '../client/environment.mjs';
import { sampleSnapshot } from '../src/sample.mjs';

const now = Date.parse('2026-10-07T12:00:00Z');
const time = new Date(now).toISOString();
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'terminal-capacity-')); await mkdir(join(root, '.openmerit')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('topology projects only bounded declared identities and rejects ambiguous IDs', () => {
  const deployment = { id: 'a', model: 'model', provider: 'provider', name: 'EU', location: 'private', poolIds: ['p', 'p', null], secret: 'private payload', url: 'https://secret' };
  assert.deepEqual(normalizeDeployments([deployment])[0].poolIds, ['p']);
  assert.equal(normalizeDeployments([deployment])[0].location, 'private');
  assert.doesNotMatch(JSON.stringify(normalizeDeployments([deployment])), /secret|payload/);
  assert.deepEqual(normalizeDeployments([deployment, deployment]), []);
  assert.deepEqual(normalizeDeployments([{ ...deployment, id: 'runtime:reserved' }]), []);
  assert.equal(normalizePools([{ id: 'p', metrics: { running: 3 } }])[0].observedAt, null);
  assert.equal(normalizePath(Array.from({ length: 9 }, () => ({ name: 'hop' }))).length, 0);
  assert.deepEqual(normalizePath([{ name: 'router', kind: 'router' }, { name: null }]), []);
});

test('explicit paths preserve hop order without inventing or contradicting the entry connection', () => {
  const input = { id: 'r', model: 'model', occurredAt: time, deploymentId: 'a', path: [{ name: 'router', kind: 'router', headers: 'secret' }, { name: 'gateway', kind: 'gateway' }] };
  const record = normalizeRecord(input, 'activity');
  assert.equal(record.route, 'router'); assert.equal(record.routeKind, 'router');
  assert.deepEqual(record.path.map(hop => hop.name), ['router', 'gateway']);
  assert.doesNotMatch(JSON.stringify(record), /headers|secret/);
  assert.deepEqual(normalizeRecord({ ...input, route: 'another route' }, 'activity').path, []);
  assert.deepEqual(normalizeRecord({ ...input, routeKind: 'unknown' }, 'activity').path, []);
});

test('matching requires deployment ID, model, and provider; names never imply an instance', () => {
  const snapshot = { deployments: [{ id: 'a', model: 'm', provider: 'p' }, { id: 'b', model: 'm', provider: 'p' }] };
  assert.equal(deploymentFor({ model: 'm', provider: 'p' }, snapshot), null);
  assert.equal(deploymentFor({ deploymentId: 'b', model: 'm', provider: 'p' }, snapshot).id, 'b');
  assert.equal(deploymentFor({ deploymentId: 'b', model: 'other', provider: 'p' }, snapshot), null);
  assert.equal(deploymentFor({ deploymentId: 'b', model: 'm', provider: 'other' }, snapshot), null);
  assert.equal(deploymentFor({ deploymentId: 'b', model: 'm', provider: 'p' }, { deployments: [snapshot.deployments[1], snapshot.deployments[1]] }), null);
});

test('shared dependencies count a request once even when multiple declared links reach a pool', () => {
  const pool = { id: 'shared' };
  const snapshot = { deployments: [{ id: 'a', model: 'm', provider: 'p', poolIds: ['shared'] }, { id: 'b', model: 'm', provider: 'p', poolIds: ['shared'] }], inventory: [{ name: 'edge', kind: 'gateway', poolIds: ['shared'] }], capacityPools: [pool] };
  const records = ['a', 'b'].map((deploymentId, index) => ({ deploymentId, model: 'm', provider: 'p', agentId: `agent-${index}`, path: [{ name: 'edge', kind: 'gateway' }] }));
  assert.equal(poolsFor(records[0], snapshot).length, 1);
  const usage = poolUsage(pool, snapshot, records);
  assert.equal(usage.items.length, 2); assert.equal(usage.agents.size, 2); assert.equal(usage.deployments.length, 2);
  assert.equal(poolsFor({ ...records[0], deploymentId: null }, { ...snapshot, inventory: [...snapshot.inventory, ...snapshot.inventory] }).length, 0);
});

test('capacity freshness uses measurement time, not file-check time; zero is retained', () => {
  const [pool] = normalizeCapacity({ pools: [{ id: 'p', observedAt: time, metrics: { running: 0, waiting: -1, cachePercent: 200, tokensUsed: '12', requestsLimit: Infinity, arbitrary: 'private' } }] }, now);
  assert.deepEqual(pool.metrics, { running: 0 });
  assert.equal(capacityState(pool, 15, now), 'sampled');
  assert.equal(capacityState(pool, 15, now + 45001), 'stale');
  assert.equal(capacityState(pool, 15, now - 1), 'unknown');
  assert.equal(capacityState({ metrics: {} }, 15, now), 'unknown');
  assert.deepEqual(normalizeCapacity({ pools: [{ id: 'p', observedAt: new Date(now + 1).toISOString(), metrics: { running: 2 } }] }, now), []);
  assert.equal(capacityReadings({ metrics: { running: 2, concurrencyLimit: 0 } })[0].ratio, null);
  assert.equal(capacityReadings({ metrics: { requestsUsed: 12, requestsLimit: 10 } })[0].ratio, 1.2);
});

test('local capacity exports are bounded, project-contained, allowlisted, and discarded on failure', async t => {
  const root = await fixture(t), outside = await fixture(t), path = join(root, '.openmerit/capacity.json');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ ollama: false, capacityPools: [{ id: 'p', name: 'Shared quota', kind: 'quota' }], deployments: [{ id: 'a', model: 'm', provider: 'p', poolIds: ['p'] }] }));
  const config = await loadConfig(root), collect = createCollector(root, config);
  const observedAt = new Date(Date.now() - 180000).toISOString();
  await writeFile(path, JSON.stringify({ pools: [{ id: 'p', observedAt, metrics: { requestsUsed: 7, requestsLimit: 10, secret: 'private' } }, { id: 'undeclared', observedAt, metrics: { running: 5 } }], headers: 'secret' }));
  let snapshot = await collect();
  assert.equal(snapshot.capacityPools.length, 1); assert.equal(snapshot.deployments.length, 1);
  assert.equal(snapshot.capacityPools[0].observedAt, observedAt);
  assert.equal(capacityState(snapshot.capacityPools[0], 15), 'stale');
  assert.doesNotMatch(JSON.stringify(snapshot.capacityPools), /secret|private|undeclared/);
  assert.equal(snapshot.records.length, 0);
  await writeFile(path, 'x'.repeat(128 * 1024 + 1));
  snapshot = await collect(); assert.deepEqual(snapshot.capacityPools[0].metrics, {});
  assert.equal(snapshot.sources.find(source => source.id === 'capacity').state, 'unavailable');
  await rm(path); await writeFile(join(outside, 'capacity.json'), JSON.stringify({ pools: [] })); await symlink(join(outside, 'capacity.json'), path);
  snapshot = await collect(); assert.equal(snapshot.sources.find(source => source.id === 'capacity').state, 'unavailable');
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ capacityFile: '../outside.json' }));
  await assert.rejects(loadConfig(root), /inside this project/);
});

test('vLLM cache usage reports highest valid series rather than summing percentages', () => {
  assert.deepEqual(parseRuntimeMetrics('vllm:kv_cache_usage_perc{model_name="a"} 0.6\nvllm:kv_cache_usage_perc{model_name="b"} 0.9\nvllm:kv_cache_usage_perc 1.2\nvllm:num_requests_running 2'), { cachePercent: 90, running: 2 });
});

test('enterprise topology has distinct deployments, shared pools, explicit paths, and honest gaps', () => {
  const snapshot = sampleSnapshot(now);
  assert.equal(snapshot.deployments.length, 27); assert.equal(snapshot.capacityPools.length, 12);
  assert.equal(new Set(snapshot.deployments.map(item => item.id)).size, 27);
  assert.equal(snapshot.records.filter(record => deploymentFor(record, snapshot)).length, 9479);
  assert.equal(snapshot.capacityPools.filter(pool => capacityState(pool, 15, now) === 'sampled').length, 10);
  assert.equal(snapshot.capacityPools.filter(pool => capacityState(pool, 15, now) === 'stale').length, 1);
  assert.equal(snapshot.capacityPools.filter(pool => capacityState(pool, 15, now) === 'unknown').length, 1);
  for (const record of snapshot.records) {
    if (record.path.length) { assert.equal(record.path[0].name, record.route); assert.equal(record.path[0].kind, record.routeKind); }
    for (const pool of poolsFor(record, snapshot)) assert.ok(snapshot.capacityPools.includes(pool));
  }
  assert.equal(poolUsage(snapshot.capacityPools.find(pool => pool.name === 'llm-gateway'), snapshot, snapshot.records).agents.size, 40);
});
