import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredServices, serviceFromEndpoint } from '../src/services.mjs';
import { discoverProject, envDeclarations } from '../src/discovery.mjs';
import { createCollector, loadConfig } from '../src/collect.mjs';
import { startTerminal } from '../src/server.mjs';
import { serviceInventory } from '../client/services.mjs';
import { requestCountKnown, routeKind } from '../client/routes.mjs';
import { serviceIdentity, modelIdentity, identityIcon } from '../client/brands.mjs';

const dedicated = 'https://private-deployment.us-east-1.aws.endpoints.huggingface.cloud';
const router = 'https://router.huggingface.co/v1';
const names = ['Hugging Face Endpoints', 'Hugging Face Router'];
const line = value => JSON.stringify(value) + '\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-huggingface-'));
  await mkdir(join(root, '.openmerit')); await mkdir(join(root, 'logs'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Hugging Face product identity comes from the exact HTTPS service host', () => {
  for (const url of [dedicated, `${dedicated}/private-model/predict?token=private-token#private-fragment`, 'https://abc123.endpoints.huggingface.cloud/v1', 'https://ABC123.eu-west-1.aws.endpoints.huggingface.cloud:443/v1']) assert.equal(serviceFromEndpoint(url), names[0]);
  assert.equal(serviceFromEndpoint(router), names[1]);
  for (const url of ['https://huggingface.co/models', 'https://endpoints.huggingface.cloud', 'https://endpoints.huggingface.co', 'https://router.huggingface.co.attacker.test', 'https://fakeendpoints.huggingface.cloud', 'https://x.endpoints.huggingface.cloud.attacker.test', 'https://bad_label.endpoints.huggingface.cloud', 'https://-bad.endpoints.huggingface.cloud', 'https://token@router.huggingface.co/v1', 'http://router.huggingface.co/v1', 'https://router.huggingface.co:8443/v1']) assert.equal(serviceFromEndpoint(url), null, url);
});

test('Hugging Face endpoint overrides suppress SDK-vendor attribution and redact private URL data', () => {
  for (const [url, name, kind] of [[`${dedicated}/private-model?token=private-token#private-fragment`, names[0], 'provider'], [router, names[1], 'router']]) {
    const result = configuredServices({ OPENAI_BASE_URL: url, OPENAI_API_KEY: 'private-key' });
    assert.equal(result.services.length, 1);
    assert.equal(result.services[0].name, name); assert.equal(result.services[0].kind, kind);
    assert.equal(result.services[0].state, 'configured');
    assert.equal(result.services[0].evidence[0].endpointHost, kind === 'router' ? 'router.huggingface.co' : '….endpoints.huggingface.cloud');
    assert.doesNotMatch(JSON.stringify(result), /private-|https:|us-east-1|aws|token=/);
  }
  const result = configuredServices({ OPENAI_BASE_URL: 'https://router.huggingface.co.attacker.test', OPENAI_API_KEY: 'private-key', HF_INFERENCE_ENDPOINT: 'https://custom.example.test' });
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.unrecognizedEndpoints, ['OPENAI_BASE_URL', 'HF_INFERENCE_ENDPOINT']);
});

test('documented Hugging Face endpoint variable and explicit application aliases identify configuration', () => {
  for (const field of ['HF_INFERENCE_ENDPOINT', 'HF_ENDPOINT_URL', 'HUGGINGFACE_ENDPOINT_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']) {
    const result = configuredServices(envDeclarations(`${field}='${dedicated}'\nHF_TOKEN=private-token\n`));
    assert.equal(result.services.length, 1, field);
    assert.equal(result.services[0].name, names[0]);
    assert.equal(result.services[0].serviceType, 'inference-cloud');
    assert.equal(result.services[0].evidence[0].field, field);
    assert.doesNotMatch(JSON.stringify(result), /private-token|private-deployment/);
  }
});

test('Hub credentials, SDK dependencies and model downloads cannot establish an inference service', async t => {
  const root = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Discovery must not contact the Hub'));
  await writeFile(join(root, '.env'), 'HF_TOKEN=private-token\nHUGGING_FACE_HUB_TOKEN=private-token\nHUGGINGFACEHUB_API_TOKEN=private-token\nHF_ENDPOINT=https://huggingface.co\nMODEL_ID=Qwen/Qwen3-8B\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@huggingface/inference': '1' } }));
  await writeFile(join(root, 'requirements.txt'), 'huggingface_hub>=1\nhuggingface-hub>=1\n');
  const project = await discoverProject(root);
  assert.equal(project.sources.filter(source => source.state === 'detected').length, 2);
  assert.deepEqual(project.inventory, []); assert.deepEqual(project.runtimes, []);
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.deepEqual(serviceInventory(snapshot), []);
  assert.deepEqual(snapshot.models, []); assert.deepEqual(snapshot.records, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-token|HF_TOKEN/);
  assert.ok(snapshot.repository.references.some(ref => ref.value === 'Qwen/Qwen3-8B' && ref.context === 'unlinked'));
});

test('both Hugging Face products index passively and usage appears only from supported project logs', async t => {
  const root = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Cloud configuration must not make a request'));
  await writeFile(join(root, '.env'), `HF_INFERENCE_ENDPOINT=${dedicated}/private-model?key=private-token\nHF_TOKEN=private-token\n`);
  await writeFile(join(root, '.env.local'), `OPENAI_BASE_URL=${router}\nOPENAI_API_KEY=private-key\n`);
  const collect = createCollector(root, await loadConfig(root));
  let snapshot = await collect(), services = serviceInventory(snapshot);
  assert.deepEqual(services.map(service => service.name), names);
  assert.deepEqual(services.map(service => service.types), [['inference-cloud'], ['router']]);
  assert.ok(services.every(service => service.configured && !service.reported && service.records.length === 0));
  assert.equal(requestCountKnown(snapshot), false);
  for (const field of ['models', 'records', 'deployments', 'hosts']) assert.deepEqual(snapshot[field], []);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|us-east-1|aws|https:/);
  const usage = { prompt_tokens: 20, completion_tokens: 3 };
  await writeFile(join(root, 'logs/requests.jsonl'), line({ id: 'hf-dedicated', requestId: 'api-1', occurredAt: '2020-01-01T00:00:00Z', model: 'Qwen/Qwen3-8B', provider: names[0], route: names[0], status: 'completed', usage }) + line({ id: 'hf-router', requestId: 'api-2', occurredAt: '2020-01-01T00:00:01Z', model: 'openai/gpt-oss-120b', provider: 'Groq', route: names[1], status: 'completed', usage }));
  snapshot = await collect(); services = serviceInventory(snapshot);
  assert.equal(snapshot.records.length, 2); assert.equal(snapshot.models.length, 2);
  assert.equal(services.find(service => service.name === names[0]).records.length, 1);
  assert.equal(services.find(service => service.name === names[1]).records.length, 1);
  assert.equal(services.find(service => service.name === 'Groq').records.length, 1);
  assert.equal(routeKind(snapshot.records.find(record => record.id === 'hf-router'), snapshot), 'router');
  assert.equal(routeKind(snapshot.records.find(record => record.id === 'hf-dedicated'), snapshot), 'direct');
  assert.ok(snapshot.models.every(model => model.modelCreator === null));
  assert.equal(modelIdentity(snapshot.models.find(model => model.name.startsWith('Qwen/'))).key, 'qwen');
  assert.deepEqual(snapshot.hosts, []); assert.deepEqual(snapshot.deployments, []);
});

test('generic Hugging Face records stay separate from product-specific service aliases', () => {
  const records = [names[0], names[1], 'Hugging Face'].map((provider, i) => ({ id: String(i), model: 'custom-model', provider, route: 'Unattributed route', sourceId: 'activity', occurredAt: '2020-01-01T00:00:00Z' }));
  const services = serviceInventory({ records });
  assert.equal(services.length, 3);
  assert.deepEqual(services.find(service => service.name === 'Hugging Face').types, ['unknown']);
  assert.deepEqual(services.find(service => service.name === names[0]).types, ['inference-cloud']);
  assert.deepEqual(services.find(service => service.name === names[1]).types, ['router']);
  const explicit = serviceInventory({ inventory: [{ name: names[1], kind: 'gateway' }], records: [records[1]] });
  assert.deepEqual(explicit[0].types, ['gateway']);
});

test('removing an endpoint declaration removes configuration inventory on the next discovery pass', async t => {
  const root = await fixture(t), realNow = Date.now();
  t.mock.method(globalThis, 'fetch', () => assert.fail('No cloud polling'));
  t.mock.method(Date, 'now', () => realNow);
  await writeFile(join(root, '.env'), `HF_ENDPOINT_URL=${dedicated}\n`);
  const collect = createCollector(root, await loadConfig(root));
  assert.equal(serviceInventory(await collect()).length, 1);
  await rm(join(root, '.env'));
  t.mock.method(Date, 'now', () => realNow + 61000);
  assert.deepEqual(serviceInventory(await collect()), []);
});

test('Hugging Face assets are official local marks and product identities do not merge', async t => {
  assert.notEqual(serviceIdentity(names[0]).key, serviceIdentity(names[1]).key);
  for (const name of names) assert.match(identityIcon(serviceIdentity(name)), /src="\/brands\/huggingface.svg"/);
  assert.equal(modelIdentity({ name: 'custom-model', provider: names[0] }), null);
  const bytes = await readFile(new URL('../public/brands/huggingface.svg', import.meta.url));
  assert.match(bytes.toString(), /^<svg /);
  assert.doesNotMatch(bytes.toString(), /<script|<foreignObject|\bon\w+=|\bhref=/i);
  const terminal = await startTerminal({ port: 0, collect: async () => ({ mode: 'live' }) });
  t.after(() => terminal.close());
  const response = await fetch(`${terminal.url}/brands/huggingface.svg`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
