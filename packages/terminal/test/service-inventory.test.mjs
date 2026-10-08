import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceInventory } from '../client/services.mjs';

const record = (extra = {}) => ({ id: 'r1', model: 'gpt-oss-120b', modelCreator: 'OpenAI', provider: 'Groq', occurredAt: '2026-10-08T10:00:00Z', sourceId: 'activity', route: 'Groq', routeKind: 'direct', ...extra });
const byName = (items, name) => items.find(item => item.name === name);

test('services represent serving and connection evidence, never just a model creator', () => {
  const items = serviceInventory({ models: [{ id: 'm1', name: 'gpt-oss-120b', provider: 'Groq', modelCreator: 'OpenAI', state: 'configured' }], inventory: [{ name: 'private-service', kind: 'provider' }], records: [] });
  assert.deepEqual(items.map(item => item.name).sort(), ['Groq', 'private-service']);
  assert.deepEqual(byName(items, 'Groq').types, ['inference-cloud']);
  assert.deepEqual(byName(items, 'private-service').types, ['unknown']);
  assert.equal(byName(items, 'Groq').configured, true);
  assert.equal(byName(items, 'Groq').reported, false);
  assert.equal(byName(items, 'Groq').lastAt, null);
});

test('explicit service roles override registry classifications without inventing hidden hops', () => {
  const items = serviceInventory({ inventory: [{ name: 'OpenAI', kind: 'provider', serviceType: 'inference-cloud' }, { name: 'Groq', kind: 'gateway' }], records: [record({ route: 'OpenAI', provider: 'OpenAI' }), record()] });
  assert.deepEqual(byName(items, 'OpenAI').types, ['inference-cloud']);
  assert.deepEqual(byName(items, 'Groq').types, ['gateway']);
  assert.deepEqual(byName(items, 'OpenAI').typeEvidence, ['Declared or reported role']);
  assert.deepEqual(byName(items, 'Groq').paths[0].path, [{ name: 'Groq', kind: 'direct' }]);
});

test('only unambiguous curated aliases merge and explicitly declared names stay separate', () => {
  const one = serviceInventory({ inventory: [{ name: 'OpenAI API', kind: 'provider' }], records: [record({ provider: 'OpenAI', route: 'OpenAI API' })] });
  assert.equal(one.length, 1); assert.deepEqual(one[0].aliases, ['OpenAI API', 'OpenAI']); assert.equal(one[0].records.length, 1);
  const distinct = serviceInventory({ inventory: [{ name: 'Groq', kind: 'provider' }, { name: 'Groq API', kind: 'provider' }], records: [record({ provider: 'GroqCloud', route: 'GroqCloud' })] });
  assert.equal(distinct.length, 3); assert.equal(byName(distinct, 'Groq').records.length, 0);
  assert.equal(byName(distinct, 'GroqCloud').records.length, 1);
});

test('repeated hops count a request once per service and shared service totals are nonadditive', () => {
  const r = record({ route: 'edge', routeKind: 'gateway', path: [{ name: 'edge', kind: 'gateway' }, { name: 'Groq', kind: 'direct' }, { name: 'edge', kind: 'gateway' }] });
  const items = serviceInventory({ records: [r] });
  assert.equal(items.length, 2);
  for (const service of items) { assert.equal(service.records.length, 1); assert.equal(service.paths[0].count, 1); assert.equal(service.models.length, 1); }
  assert.deepEqual(byName(items, 'edge').locations, []);
});

test('selected window limits usage while retained records preserve last activity and identity', () => {
  const old = record({ id: 'old', provider: 'old-provider', route: 'old-provider', occurredAt: '2026-10-07T10:00:00Z' }), recent = record();
  const items = serviceInventory({ records: [old, recent] }, [recent]);
  const outside = byName(items, 'old-provider');
  assert.equal(outside.reported, true); assert.equal(outside.records.length, 0); assert.equal(outside.paths.length, 0); assert.equal(outside.lastAt, old.occurredAt);
  assert.equal(byName(items, 'Groq').records.length, 1);
});

test('deployment and model inventories survive absent activity without request IDs replacing model IDs', () => {
  const model = { id: 'model-1', name: 'gpt-oss-120b', provider: 'Groq', modelCreator: null, creatorConflict: true };
  const deployment = { id: 'd1', name: 'dedicated-1', model: model.name, provider: 'Groq', state: 'configured' };
  const [service] = serviceInventory({ models: [model], deployments: [deployment], records: [record({ deploymentId: 'd1' })] });
  assert.equal(service.models.length, 1); assert.equal(service.models[0].id, 'model-1'); assert.equal(service.models[0].modelCreator, null); assert.equal(service.models[0].creatorConflict, true);
  assert.deepEqual(service.deployments.map(item => item.id), ['d1']);
  const [idle] = serviceInventory({ deployments: [deployment], records: [] });
  assert.equal(idle.configured, true); assert.equal(idle.models.length, 1); assert.equal(idle.deployments.length, 1); assert.equal(idle.records.length, 0);
});

test('services link only their own declared pools, not every downstream quota', () => {
  const snapshot = { inventory: [{ name: 'edge', kind: 'gateway', poolIds: ['edge-limit'] }], deployments: [{ id: 'd1', model: 'gpt-oss-120b', provider: 'Groq', poolIds: ['groq-quota'] }], capacityPools: [{ id: 'edge-limit' }, { id: 'groq-quota' }, { id: 'unrelated' }], records: [record({ route: 'edge', routeKind: 'gateway', deploymentId: 'd1' })] };
  const items = serviceInventory(snapshot);
  assert.deepEqual(byName(items, 'edge').pools.map(item => item.id), ['edge-limit']);
  assert.deepEqual(byName(items, 'Groq').pools.map(item => item.id), ['groq-quota']);
  assert.equal(byName(items, 'edge').deployments.length, 1);
});

test('endpoint identities are evidence-only and generic route labels never create services', () => {
  const items = serviceInventory({ inventory: [{ name: 'Groq', kind: 'provider', sourceId: 'environment', evidence: [{ field: 'OPENAI_BASE_URL', basis: 'endpoint-host', endpointHost: 'api.groq.com' }] }], sources: [{ id: 'local', name: 'Local server', kind: 'Local runtime', detail: 'http://127.0.0.1:1234' }, { id: 'unsafe', name: 'Unsafe description', kind: 'Local runtime', detail: 'http://private:secret@127.0.0.1:1234/path' }], records: [record({ route: 'Direct API' }), record({ route: 'Unattributed route', provider: 'Unattributed', routeKind: 'unknown' })] });
  assert.equal(items.length, 3);
  assert.deepEqual(byName(items, 'Groq').endpoints, ['api.groq.com']);
  assert.deepEqual(byName(items, 'Local server').endpoints, ['127.0.0.1:1234']);
  assert.deepEqual(byName(items, 'Unsafe description').endpoints, []);
  assert.doesNotMatch(JSON.stringify(items), /secret|private:/);
});
