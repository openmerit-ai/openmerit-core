import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredServices, serviceFromEndpoint } from '../src/services.mjs';
import { SERVICE_REGISTRY, SERVICE_GROUPS, SERVICE_ENDPOINT_FIELDS, SERVICE_CREDENTIAL_FIELDS, registeredService } from '../src/service-registry.mjs';
import { envDeclarations, discoverProject } from '../src/discovery.mjs';
import { createCollector, loadConfig } from '../src/collect.mjs';
import { serviceInventory } from '../client/services.mjs';
import { requestCountKnown, routeKind } from '../client/routes.mjs';
import { modelIdentity } from '../client/brands.mjs';

// Independent fixtures for the documented public inference endpoints, not registry-generated URLs.
const endpoints = [
  ['OpenAI', 'https://api.openai.com/v1', 'model-api'],
  ['Anthropic', 'https://api.anthropic.com', 'model-api'],
  ['OpenRouter', 'https://openrouter.ai/api/v1', 'gateway'],
  ['Google', 'https://generativelanguage.googleapis.com/v1beta/openai', 'model-api'],
  ['Groq', 'https://api.groq.com/openai/v1', 'inference-cloud'],
  ['Cerebras', 'https://api.cerebras.ai/v1', 'inference-cloud'],
  ['Baseten', 'https://inference.baseten.co/v1', 'inference-cloud'],
  ['Hugging Face Endpoints', 'https://private-deployment.us-east-1.aws.endpoints.huggingface.cloud', 'inference-cloud'],
  ['Hugging Face Router', 'https://router.huggingface.co/v1', 'router'],
  ['Mistral', 'https://api.mistral.ai/v1', 'model-api'],
  ['DeepSeek', 'https://api.deepseek.com/anthropic', 'model-api'],
  ['Cohere', 'https://api.cohere.ai/compatibility/v1', 'model-api'],
  ['xAI', 'https://api.x.ai/v1', 'model-api'],
  ['Voyage AI', 'https://api.voyageai.com/v1/embeddings', 'model-api'],
  ['Jina AI', 'https://api.jina.ai/v1/embeddings', 'model-api'],
  ['Together AI', 'https://api.together.ai/v1', 'inference-cloud'],
  ['Fireworks AI', 'https://api.fireworks.ai/inference/v1', 'inference-cloud'],
  ['DeepInfra', 'https://api.deepinfra.com/v1/openai', 'inference-cloud'],
  ['Replicate', 'https://api.replicate.com/v1/predictions', 'inference-cloud'],
  ['NVIDIA API Catalog', 'https://integrate.api.nvidia.com/v1', 'inference-cloud'],
  ['SambaNova', 'https://api.sambanova.ai/v1', 'inference-cloud'],
  ['Novita AI', 'https://api.novita.ai/openai/v1', 'inference-cloud'],
  ['Nebius Token Factory', 'https://api.studio.nebius.com/v1', 'inference-cloud'],
  ['SiliconFlow', 'https://api.siliconflow.com/v1', 'inference-cloud'],
  ['Azure OpenAI', 'https://private-resource.openai.azure.com/openai/v1', 'inference-cloud'],
  ['Azure AI Foundry', 'https://private-resource.services.ai.azure.com/models', 'inference-cloud'],
  ['Amazon Bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'inference-cloud'],
  ['Amazon SageMaker', 'https://runtime.sagemaker.us-east-1.amazonaws.com/endpoints/private-deployment/invocations', 'inference-cloud'],
  ['Google Vertex AI', 'https://us-central1-aiplatform.googleapis.com/v1/projects/private-project/locations/us-central1/endpoints/openapi', 'inference-cloud'],
  ['Cloudflare Workers AI', 'https://api.cloudflare.com/client/v4/accounts/private-account/ai/v1', 'inference-cloud'],
  ['Cloudflare AI Gateway', 'https://gateway.ai.cloudflare.com/v1/private-account/private-gateway', 'gateway'],
  ['Portkey', 'https://api.portkey.ai/v1', 'gateway'],
  ['Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'gateway'],
  ['Alibaba Cloud Model Studio', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'inference-cloud'],
  ['MiniMax', 'https://api.minimax.io/v1', 'model-api'],
  ['Moonshot AI', 'https://api.moonshot.ai/v1', 'model-api'],
  ['Z.AI', 'https://api.z.ai/api/paas/v4', 'model-api'],
  ['Perplexity Sonar', 'https://api.perplexity.ai/chat/completions', 'model-api'],
  ['Perplexity Router', 'https://api.perplexity.ai/router/v1', 'router'],
];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-endpoint-coverage-'));
  await mkdir(join(root, 'logs')); await mkdir(join(root, '.openmerit'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('public inference URLs override SDK identity and agree with client classifications', () => {
  for (const [name, endpoint, type] of endpoints) {
    assert.equal(serviceFromEndpoint(endpoint), name, endpoint);
    const result = configuredServices(envDeclarations(`OPENAI_API_KEY=private-key\nOPENAI_BASE_URL=${endpoint}?key=private-query#private-fragment`));
    assert.equal(result.services.length, 1, endpoint);
    assert.equal(result.services[0].name, name);
    const [service] = serviceInventory({ inventory: result.services });
    assert.deepEqual(service.types, [type], name);
    assert.equal(service.configured, true); assert.equal(service.reported, false);
    assert.deepEqual(service.records, []); assert.deepEqual(service.models, []);
    assert.equal(requestCountKnown({ inventory: result.services }), false);
    assert.doesNotMatch(JSON.stringify(result), /private-|https:|key=/, name);
  }
  assert.deepEqual(endpoints.map(([name]) => name).sort(), SERVICE_REGISTRY.filter(s => s.type !== 'runtime').map(s => s.name).sort());
});

test('regional and dedicated cloud endpoints stay at the service level and redact resource IDs', () => {
  for (const [name, url, host] of [
    ['Cohere', 'https://api.cohere.com/v2/chat', 'api.cohere.com'],
    ['Together AI', 'https://api.together.xyz/v1', 'api.together.xyz'],
    ['Nebius Token Factory', 'https://api.studio.nebius.ai/v1', 'api.studio.nebius.ai'],
    ['SiliconFlow', 'https://api.siliconflow.cn/v1', 'api.siliconflow.cn'],
    ['Baseten', 'https://model-private-123.api.baseten.co/deployment/private-deployment/predict', 'model-….api.baseten.co'],
    ['Azure OpenAI', 'https://PRIVATE-RESOURCE.openai.azure.com:443/openai/v1', '….openai.azure.com'],
    ['Azure AI Foundry', 'https://private-resource.services.ai.azure.com/openai/v1', '….services.ai.azure.com'],
    ['Amazon Bedrock', 'https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com', 'bedrock-runtime-fips.us-gov-west-1.amazonaws.com'],
    ['Amazon Bedrock', 'https://bedrock-runtime.cn-north-1.amazonaws.com.cn', 'bedrock-runtime.cn-north-1.amazonaws.com.cn'],
    ['Amazon SageMaker', 'https://runtime.sagemaker.eu-west-1.amazonaws.com', 'runtime.sagemaker.eu-west-1.amazonaws.com'],
    ['Google Vertex AI', 'https://aiplatform.googleapis.com/v1/projects/private-project/locations/global/endpoints/openapi', 'aiplatform.googleapis.com'],
    ['Google Vertex AI', 'https://northamerica-northeast1-aiplatform.googleapis.com/v1', 'northamerica-northeast1-aiplatform.googleapis.com'],
    ['Alibaba Cloud Model Studio', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'dashscope-intl.aliyuncs.com'],
    ['Alibaba Cloud Model Studio', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', 'dashscope-us.aliyuncs.com'],
    ['Alibaba Cloud Model Studio', 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1', 'cn-hongkong.dashscope.aliyuncs.com'],
    ['Alibaba Cloud Model Studio', 'https://private-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', '….maas.aliyuncs.com'],
  ]) {
    const result = configuredServices({ OPENAI_BASE_URL: url });
    assert.equal(result.services[0]?.name, name, url);
    assert.equal(result.services[0].evidence[0].endpointHost, host);
    assert.doesNotMatch(JSON.stringify(result), /private-|PRIVATE-/);
  }
});

test('lookalike hosts and unsafe URLs never restore the SDK credential fallback', () => {
  for (const [, endpoint] of endpoints) {
    const url = new URL(endpoint);
    const spoof = new URL(url); spoof.hostname += '.attacker.test';
    for (const bad of [spoof.href, endpoint.replace('https:', 'http:'), endpoint.replace('https://', 'https://private-user:private-token@'), endpoint.replace(url.host, url.host + ':8443'), endpoint.replace(url.hostname, url.hostname + '\n'), '\\' + endpoint, endpoint + ' ', endpoint + '/'.repeat(2049)]) {
      const result = configuredServices({ OPENAI_API_KEY: 'private-key', OPENAI_BASE_URL: bad });
      assert.equal(serviceFromEndpoint(bad), null, bad.slice(0,150));
      assert.deepEqual(result.services, []);
      assert.deepEqual(result.unrecognizedEndpoints, ['OPENAI_BASE_URL']);
    }
  }
  for (const url of ['https://evilopenai.azure.com', 'https://x.y.openai.azure.com', 'https://-bad.openai.azure.com', 'https://bad_label.services.ai.azure.com', 'https://openai.azure.com', 'https://bedrock.us-east-1.amazonaws.com', 'https://s3.us-east-1.amazonaws.com', 'https://runtime.sagemaker.attacker.amazonaws.com', 'https://unrelated.googleapis.com', 'https://evil-aiplatform.googleapis.com', 'https://maas.aliyuncs.com', 'https://private-workspace.unsupported.maas.aliyuncs.com', 'https://api.cloudflare.com/client/v4/zones', 'https://api.cloudflare.com/client/v4/accounts/private-account/ai-search', 'https://private-resource.services.ai.azure.com/api/projects/private-project', 'https://api.perplexity.ai/search', 'https://api.perplexity.ai/router-lookalike/v1', 'https://management-api.x.ai', 'https://ngc.nvidia.com']) assert.equal(serviceFromEndpoint(url), null, url);
});

test('all supported declaration groups honor override precedence and never retain keys', () => {
  assert.equal(new Set(SERVICE_CREDENTIAL_FIELDS).size, SERVICE_CREDENTIAL_FIELDS.length);
  assert.equal(new Set(SERVICE_ENDPOINT_FIELDS).size, SERVICE_ENDPOINT_FIELDS.length);
  for (const group of SERVICE_GROUPS) {
    for (const field of group.credentials) {
      const result = configuredServices(envDeclarations(`${field}=private-key`));
      assert.deepEqual(result.services.map(s => s.name), [group.name]);
      assert.equal(result.services[0].evidence[0].basis, 'credential-name');
      assert.doesNotMatch(JSON.stringify(result), /private-key/);
    }
    for (const field of group.endpoints) {
      const declarations = group.credentials.map(c => `${c}=private-key`).join('\n');
      let result = configuredServices(envDeclarations(`${declarations}\n${field}=https://custom.internal.test/v1`));
      assert.deepEqual(result.services, [], field); assert.deepEqual(result.unrecognizedEndpoints, [field]);
      result = configuredServices(envDeclarations(`${declarations}\n${field}=https://api.fireworks.ai/inference/v1`));
      assert.deepEqual(result.services.map(s => s.name), ['Fireworks AI'], field);
    }
  }
});

test('general cloud credentials, token caches and SDK dependencies do not imply inference services', async t => {
  const root = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No account or endpoint calls'));
  await writeFile(join(root, '.env'), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_INFERENCE_CREDENTIAL', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'NGC_API_KEY', 'NVIDIA_API_KEY', 'NEBIUS_API_KEY', 'JINA_API_KEY', 'PERPLEXITY_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'].map(key => `${key}=private-key`).join('\n'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@aws-sdk/client-bedrock-runtime': '1', '@google-cloud/vertexai': '1', 'replicate': '1', 'portkey-ai': '1', '@mistralai/mistralai': '1' } }));
  const project = await discoverProject(root);
  assert.deepEqual(project.inventory, []); assert.deepEqual(project.runtimes, []);
  assert.equal(project.sources.length, 1); assert.equal(project.sources[0].state, 'detected');
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.deepEqual(serviceInventory(snapshot), []);
  assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.models, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-key|AWS_SECRET_ACCESS_KEY/);
});

test('a fresh project indexes separate cloud products; requests still require supported records', async t => {
  const root = await fixture(t), now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Passive indexing never calls a provider'));
  await writeFile(join(root, '.env'), [
    'AZURE_OPENAI_ENDPOINT=https://private-resource.openai.azure.com/openai/v1',
    'AZURE_AI_ENDPOINT=https://private-resource.services.ai.azure.com/openai/v1',
    'AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://bedrock-runtime.us-east-1.amazonaws.com',
    'VERTEX_AI_BASE_URL=https://aiplatform.googleapis.com/v1/projects/private-project/locations/global/endpoints/openapi',
    'GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta',
    'CLOUDFLARE_WORKERS_AI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/private-account/ai/v1',
    'CLOUDFLARE_AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/private-account/private-gateway',
    'PORTKEY_API_KEY=private-key',
    'OPENAI_API_KEY=private-key',
    'OPENAI_BASE_URL=https://api.fireworks.ai/inference/v1',
  ].join('\n'));
  const collect = createCollector(root, await loadConfig(root));
  let snapshot = await collect();
  assert.equal(serviceInventory(snapshot).length, 9);
  assert.equal(serviceInventory(snapshot).some(s => s.name === 'OpenAI'), false);
  for (const key of ['records', 'models', 'deployments', 'hosts']) assert.deepEqual(snapshot[key], []);
  assert.equal(requestCountKnown(snapshot), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|https:/);
  const record = { id: 'actual-record', occurredAt: '2020-01-01T00:00:00Z', provider: 'Fireworks AI', route: 'Portkey', model: 'meta-llama/Llama-3.3-70B', status: 'completed', usage: { prompt_tokens: 17, completion_tokens: 9 } };
  await writeFile(join(root, 'logs/requests.jsonl'), JSON.stringify(record) + '\n');
  snapshot = await collect();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.models.length, 1);
  assert.equal(routeKind(snapshot.records[0], snapshot), 'gateway');
  for (const name of ['Fireworks AI', 'Portkey']) assert.equal(serviceInventory(snapshot).find(s => s.name === name).records.length, 1);
  assert.equal(modelIdentity(snapshot.models[0]).key, 'meta');
  assert.equal(snapshot.models[0].modelCreator, null);
  assert.deepEqual(snapshot.deployments, []); assert.deepEqual(snapshot.hosts, []);
  await rm(join(root, '.env')); t.mock.method(Date, 'now', () => now + 61000);
  snapshot = await collect();
  assert.equal(snapshot.inventory.length, 0);
  assert.deepEqual(serviceInventory(snapshot).map(s => s.name), ['Fireworks AI', 'Portkey']);
});

test('new identities classify recorded names without needing a logo or rewriting paths', () => {
  for (const [name, , type] of endpoints) {
    const record = { id: 'r1', occurredAt: '2020-01-01T00:00:00Z', provider: name, route: 'Unattributed route', model: 'custom-model' };
    const [service] = serviceInventory({ records: [record] });
    assert.equal(service.name, name); assert.deepEqual(service.types, [type]);
    assert.equal(service.records.length, 1); assert.equal(routeKind(record), 'unknown');
    assert.equal(modelIdentity({ name: 'custom-model', provider: name }), null);
  }
  for (const name of ['NVIDIA', 'Nebius', 'Azure', 'Amazon', 'Cloudflare', 'Vercel', 'Perplexity', 'Hugging Face', 'Kimi']) assert.equal(registeredService(name), null, name);
});

test('aliases do not collapse explicitly distinct services or override reported roles', () => {
  const record = { id: 'r1', occurredAt: '2020-01-01T00:00:00Z', provider: 'Together', route: 'Unattributed route', model: 'm' };
  let items = serviceInventory({ inventory: [{ name: 'Together AI', kind: 'provider' }], records: [record] });
  assert.equal(items.length, 1); assert.deepEqual(items[0].aliases, ['Together AI', 'Together']);
  items = serviceInventory({ inventory: [{ name: 'Together AI', kind: 'provider' }, { name: 'Together', kind: 'gateway' }], records: [record] });
  assert.equal(items.length, 2);
  assert.deepEqual(items.find(s => s.name === 'Together').types, ['gateway']);
  assert.equal(items.find(s => s.name === 'Together AI').records.length, 0);
});
