import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredServices, serviceFromEndpoint, modelCreators } from '../src/services.mjs';
import { loadConfig, createCollector, normalizeRecord } from '../src/collect.mjs';
import { normalizeDeployments } from '../src/topology.mjs';
import { normalizeHosts } from '../src/hardware.mjs';
import { modelIdentity } from '../client/brands.mjs';

test('cloud services are configuration evidence only and credential values never leave detection', () => {
  const result = configuredServices({ GROQ_API_KEY: 'private-groq', CEREBRAS_API_KEY: 'private-cerebras', BASETEN_API_KEY: 'private-baseten', GEMINI_API_KEY: 'private-google', GOOGLE_GENERATIVE_AI_API_KEY: 'private-google-2', UNRELATED_API_KEY: 'private-other' });
  assert.deepEqual(result.services.map(item => item.name), ['Google', 'Groq', 'Cerebras', 'Baseten']);
  assert.equal(result.services[0].evidence.length, 2);
  for (const service of result.services) { assert.equal(service.state, 'configured'); assert.equal(service.sourceId, 'environment'); assert.equal(service.kind, 'provider'); }
  assert.doesNotMatch(JSON.stringify(result), /private-|UNRELATED|modelCreator|hardware|deployment/);
  assert.equal(configuredServices({ GROQ_API_KEY: '  ', CEREBRAS_API_KEY: null }).services.length, 0);
});

test('custom endpoint overrides identify the service rather than the SDK or credential name', () => {
  for (const [endpoint, name] of [['https://api.groq.com/openai/v1', 'Groq'], ['https://api.cerebras.ai/v1', 'Cerebras'], ['https://inference.baseten.co/v1?token=private', 'Baseten'], ['https://model-ab12.api.baseten.co/deployment/private/predict', 'Baseten']]) {
    const result = configuredServices({ OPENAI_API_KEY: 'private-key', OPENAI_BASE_URL: endpoint });
    assert.equal(result.services.length, 1); assert.equal(result.services[0].name, name);
    assert.deepEqual(result.services[0].evidence, [{ field: 'OPENAI_BASE_URL', basis: 'endpoint-host', endpointHost: new URL(endpoint).hostname.replace('model-ab12.', 'model-….') }]);
    assert.doesNotMatch(JSON.stringify(result), /private|https:|ab12|predict|token=/);
  }
  for (const endpoint of ['https://api.groq.com.attacker.test/v1', 'https://notgroq.com/v1', 'https://secret@api.groq.com', 'http://api.groq.com/v1', 'https://api.groq.com:8443', 'http://localhost:1234/v1', 'broken']) {
    assert.equal(serviceFromEndpoint(endpoint), null);
    const result = configuredServices({ OPENAI_API_KEY: 'private', OPENAI_BASE_URL: endpoint });
    assert.equal(result.services.length, 0); assert.deepEqual(result.unrecognizedEndpoints, ['OPENAI_BASE_URL']);
  }
  assert.equal(configuredServices({ OPENAI_API_KEY: 'private' }).services[0].name, 'OpenAI');
});

test('creator, serving mode, and accelerator identity require explicit bounded fields', () => {
  const record = normalizeRecord({ id: 'r', occurredAt: new Date().toISOString(), model: 'gpt-oss-120b', provider: 'Groq' }, 'activity');
  assert.equal(record.modelCreator, null);
  const [deployment] = normalizeDeployments([{ id: 'd', model: 'gpt-oss-120b', provider: 'Groq', modelCreator: 'OpenAI', servingMode: 'shared', hardware: 'invented LPU', apiKey: 'private' }]);
  assert.equal(deployment.modelCreator, 'OpenAI'); assert.equal(deployment.servingMode, 'shared'); assert.equal(deployment.hostId, null);
  assert.doesNotMatch(JSON.stringify(deployment), /private|invented|hardware/);
  assert.equal(normalizeDeployments([{ id: 'd', model: 'm', provider: 'Baseten' }])[0].servingMode, 'unknown');
  const [host] = normalizeHosts({ hosts: [{ id: 'host-1', accelerators: [{ id: 'a', name: 'reported-device', vendor: 'Cerebras', kind: 'wse' }], observedAt: new Date().toISOString() }] });
  assert.equal(host.accelerators[0].kind, 'wse'); assert.equal(host.accelerators[0].vendor, 'Cerebras'); assert.equal(host.accelerators[0].utilization, null);
});

test('creator conflicts remain unknown and never bleed across serving services', () => {
  const models = [{ name: 'same-model', provider: 'Groq' }, { name: 'same-model', provider: 'Baseten' }];
  const reports = [{ model: 'same-model', provider: 'Groq', modelCreator: 'OpenAI', sourceId: 'activity' }, { model: 'same-model', provider: 'Groq', modelCreator: 'Someone else', sourceId: 'inventory' }, { model: 'same-model', provider: 'Baseten', modelCreator: 'Custom lab', sourceId: 'inventory' }];
  const [conflicting, custom] = modelCreators(models, reports);
  assert.equal(conflicting.modelCreator, null); assert.equal(conflicting.creatorConflict, true); assert.equal(modelIdentity(conflicting), null);
  assert.equal(custom.modelCreator, 'Custom lab'); assert.equal(custom.creatorConflict, false); assert.deepEqual(custom.creatorSources, ['inventory']);
  assert.equal(modelIdentity({ model: 'gpt-oss-120b', provider: 'Groq', modelCreator: 'Custom lab' }), null);
  assert.equal(modelIdentity({ model: 'private-model', provider: 'Groq', modelCreator: 'OpenAI' }).key, 'openai');
});

test('collector joins explicit creator evidence and surfaces declared models without cloud calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.openmerit'));
  const before = process.env.GROQ_API_KEY, endpoint = process.env.GROQ_BASE_URL;
  process.env.GROQ_API_KEY = 'private-fixture-key'; delete process.env.GROQ_BASE_URL;
  t.after(() => { if (before === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = before; if (endpoint !== undefined) process.env.GROQ_BASE_URL = endpoint; });
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ discovery: false, ollama: false, inventory: [{ name: 'Groq', kind: 'provider', serviceType: 'inference-cloud', poolIds: ['groq-quota'] }], capacityPools: [{ id: 'groq-quota', kind: 'quota' }], deployments: [{ id: 'dedicated-1', name: 'deployment-from-config', model: 'custom-model', modelCreator: 'Our lab', provider: 'Baseten', servingMode: 'dedicated', location: 'cloud' }] }));
  await writeFile(join(root, '.openmerit/inference.jsonl'), JSON.stringify({ id: 'r', occurredAt: new Date().toISOString(), model: 'gpt-oss-120b', modelCreator: 'OpenAI', provider: 'Groq', routeKind: 'gateway', route: 'our-gateway', location: 'cloud' }) + '\n');
  const network = t.mock.method(globalThis, 'fetch', () => { assert.fail('Passive configuration detection must not make a network request.'); });
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.equal(network.mock.callCount(), 0);
  const baseten = snapshot.models.find(item => item.provider === 'Baseten');
  assert.equal(baseten.modelCreator, 'Our lab'); assert.equal(baseten.state, 'configured');
  const groq = snapshot.models.find(item => item.provider === 'Groq');
  assert.equal(groq.modelCreator, 'OpenAI'); assert.equal(groq.state, 'observed'); assert.deepEqual(groq.creatorSources, ['activity']);
  assert.equal(snapshot.records[0].routeKind, 'gateway');
  assert.equal(snapshot.deployments[0].hostId, null);
  const entries = snapshot.inventory.filter(item => item.name === 'Groq');
  assert.equal(entries.length, 1); assert.equal(entries[0].serviceType, 'inference-cloud'); assert.deepEqual(entries[0].poolIds, ['groq-quota']);
  assert.equal(entries[0].evidence[0].field, 'GROQ_API_KEY');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-fixture-key/);
  assert.equal(snapshot.hosts.length, 1); assert.equal(snapshot.hosts[0].accelerators.length, 0);
});
