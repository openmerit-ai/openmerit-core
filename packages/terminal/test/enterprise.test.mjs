import test from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseSnapshot, demoSnapshot, ASSIGNMENTS, tokenCost } from '../src/enterprise-sample.mjs';
import { requestCount, requestWeight } from '../client/request-count.mjs';
import { routeBreakdown, activityEvidence } from '../client/routes.mjs';
import { serviceInventory } from '../client/services.mjs';
import { buildEnvironmentMap } from '../client/map.mjs';
import { deploymentFor } from '../client/environment.mjs';
import worker from '../hosted/worker.mjs';
const now = Date.parse('2026-10-10T12:00:00Z');
const total = (items, field) => items.reduce((n, item) => n + (item[field] ?? 0), 0);

test('published token prices calculate costs without invented discounts', () => {
  assert.equal(tokenCost(ASSIGNMENTS[0].before, 1_000_000, 1_000_000), 17.5);
  assert.equal(tokenCost(ASSIGNMENTS[0].after, 1_000_000, 1_000_000), 5.25);
  assert.equal(tokenCost(null, 1000, 1000), null);
  assert.equal(tokenCost(ASSIGNMENTS[0].before, 1000, null), null);
  for (const pair of ASSIGNMENTS) for (const price of [pair.before, pair.after]) assert.match(price.source, /^https:\/\//);
});
test('enterprise sample represents 9.6M requests in bounded groups over 30 days', () => {
  const data = enterpriseSnapshot(now);
  assert.equal(data.records.length, 9600);
  assert.equal(requestCount(data.records, data), 9_600_000);
  assert.equal(data.models.length, 21);
  assert.equal(new Set(data.records.map(item => item.agentId)).size, 200);
  assert.ok(total(data.records, 'inputTokens') > 80_000_000_000);
  assert.ok(total(data.records, 'cost') > 100_000);
  assert.ok(now - Math.min(...data.records.map(item => Date.parse(item.occurredAt))) > 29 * 86400000);
  for (const item of data.records) {
    assert.equal(item.requestId, null);
    assert.equal(item.cacheReadTokens, 0);
    if (['Ollama', 'vLLM', 'LM Studio', 'Cerebras', 'Cohere'].includes(item.provider)) assert.equal(item.cost, null);
  }
});
test('sample group weights never inflate live or ordinary sample records', () => {
  const record = { sampleRequests: 1000 };
  assert.equal(requestWeight(record, { mode: 'live', simulation: { kind: 'enterprise-groups' } }), 1);
  assert.equal(requestWeight(record, { mode: 'sample' }), 1);
  for (const sampleRequests of [-1, 0, Infinity, 1.5, '1000']) assert.equal(requestWeight({sampleRequests}, {mode:'sample',simulation:{kind:'enterprise-groups'}}), 1);
});
test('comparison changes models and prices while preserving the complete workload and provider set', () => {
  const before = demoSnapshot(now), after = demoSnapshot(now, 'after');
  assert.deepEqual(before.inventory, after.inventory);
  assert.deepEqual(before.capacityPools, after.capacityPools);
  assert.equal(before.records.length, after.records.length);
  for (let i = 0; i < before.records.length; i++) {
    const a = before.records[i], b = after.records[i];
    for (const field of ['id', 'occurredAt', 'sampleRequests', 'provider', 'agentId', 'taskId', 'inputTokens', 'outputTokens', 'route', 'path', 'deploymentId']) assert.deepEqual(a[field], b[field], field);
    assert.notEqual(a.model, b.model);
    assert.equal(a.durationMs, null); assert.equal(b.durationMs, null);
    assert.ok(a.cost > b.cost && b.cost > 0);
    assert.equal(a.cost, a.beforeCost); assert.equal(b.cost, b.afterCost);
    assert.ok(deploymentFor(a, before)); assert.ok(deploymentFor(b, after));
    assert.equal(a.cost, tokenCost(ASSIGNMENTS[a.assignmentId].before, a.inputTokens, a.outputTokens));
    assert.equal(b.cost, tokenCost(ASSIGNMENTS[b.assignmentId].after, b.inputTokens, b.outputTokens));
  }
  assert.equal(new Set(before.records.map(item=>item.provider)).size, 6);
  assert.equal(before.models.length, 9); assert.equal(after.models.length, 9);
  assert.equal(total(before.records, 'inputTokens'), total(after.records, 'inputTokens'));
  assert.equal(total(before.records, 'outputTokens'), total(after.records, 'outputTokens'));
  assert.ok(total(after.records, 'cost') < total(before.records, 'cost'));
  assert.deepEqual(demoSnapshot(now, 'after'), after);
});
test('graphs, activity and service paths account for every grouped request', () => {
  const data = demoSnapshot(now);
  const count = requestCount(data.records, data);
  assert.equal(Object.values(routeBreakdown(data.records, data)).reduce((a,b)=>a+b,0), count);
  assert.equal(activityEvidence(data).count, count);
  const graph = buildEnvironmentMap(data.records, data);
  assert.equal(graph.requestCount, count);
  for (const column of graph.columns) assert.equal(column.reduce((n,item)=>n+item.count,0), count);
  assert.equal(graph.edges.reduce((n,item)=>n+item.count,0), count * 2);
  for (const service of serviceInventory(data)) assert.equal(service.paths.reduce((n,item)=>n+item.count,0), requestCount(service.records, data));
});
test('hosted seed and comparison are read-only and never fall back to a collector', async () => {
  const env = { ASSETS: { fetch() { throw new Error('Unexpected assets'); } } };
  const req = (path, method='GET') => new Request(`https://dash.openmerit.site${path}`, {method});
  const seed = await (await worker.fetch(req('/api/sample-seed'), env)).json();
  assert.equal(seed.version, 1); assert.ok(Math.abs(seed.now - Date.now()) < 16000);
  assert.ok(JSON.stringify(seed).length < 100);
  const after = await (await worker.fetch(req('/api/demo?stage=after'), env)).json();
  assert.equal(after.mode, 'sample'); assert.equal(after.simulation.stage, 'after');
  assert.equal((await worker.fetch(req('/api/demo', 'POST'), env)).status, 405);
  assert.equal((await worker.fetch(req('/api/snapshot'), env)).status, 404);
});
test('both comparison URL forms serve the comparison document', async () => {
  const env = { ASSETS: { fetch(request) { assert.equal(new URL(request.url).pathname, '/demo/'); return new Response('demo', {headers:{'Content-Type':'text/html'}}); } } };
  for (const path of ['/demo', '/demo/']) assert.equal(await (await worker.fetch(new Request(`https://dash.openmerit.site${path}`), env)).text(), 'demo');
});
