import test from 'node:test';
import assert from 'node:assert/strict';
import { modelIdentity, serviceIdentity, identityIcon, identitySvg } from '../client/brands.mjs';
import { sampleSnapshot } from '../src/sample.mjs';

test('model identity is independent of the provider, host and deployment name', () => {
  for (const provider of ['Ollama', 'vLLM', 'OpenRouter', 'Private gateway']) {
    assert.equal(modelIdentity({ model: 'Qwen3 · 8B', provider }).key, 'qwen');
    assert.equal(modelIdentity({ model: 'Llama 3.3 · 70B', provider }).key, 'meta');
    assert.equal(modelIdentity({ model: 'Claude Sonnet 4.5', provider }).key, 'anthropic');
  }
  assert.equal(modelIdentity({ model: 'Gemma3 · 27B', name: 'Atlas / LM Studio', provider: 'LM Studio' }).key, 'google');
  assert.equal(serviceIdentity('Ollama').key, 'ollama');
  assert.equal(serviceIdentity('OpenAI API').key, 'openai');
});

test('namespaced models require the family’s official namespace; unknown names stay unbranded', () => {
  for (const [name, key] of [['Qwen/Qwen3-8B', 'qwen'], ['meta-llama/Llama-3.3-70B-Instruct', 'meta'], ['deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'deepseek'], ['BAAI/bge-reranker-v2-m3', 'baai'], ['nomic-ai/nomic-embed-text-v1.5', 'nomic'], ['anthropic/claude-sonnet-4-5', 'anthropic']]) assert.equal(modelIdentity(name)?.key, key);
  for (const name of ['company/llama-3', 'team/qwen3', 'my-gpt-5', 'custom-openai-model', 'OpenAI-compatible', 'https://example.com/qwen3', 'unknown']) assert.equal(modelIdentity({ name, provider: 'OpenAI' }), null);
  for (const name of ['My OpenAI gateway', 'OpenAI-compatible', 'Company router', 'https://openai.com']) assert.equal(serviceIdentity(name), null);
});

test('every enterprise sample model keeps the same identity in inventory, records, deployments and residency', () => {
  const sample = sampleSnapshot();
  assert.equal(sample.models.length, 21);
  for (const model of sample.models) {
    const identity = modelIdentity(model);
    assert.ok(identity, model.name);
    const record = sample.records.find(item => item.model === model.name);
    const deployment = sample.deployments.find(item => item.model === model.name);
    assert.equal(modelIdentity(record), identity);
    assert.equal(modelIdentity(deployment), identity);
    for (const host of sample.hosts) for (const resident of host.loadedModels.filter(item => item.name === model.name)) assert.equal(modelIdentity(resident), identity);
  }
});

test('HTML and SVG marks come only from the registry and unknowns render no placeholder', () => {
  const identity = modelIdentity('Qwen3 · 8B');
  assert.match(identityIcon(identity), /src="\/brands\/qwen.png"/);
  assert.match(identitySvg(identity, 12, 14), /href="\/brands\/qwen.png"/);
  assert.match(identityIcon(identity), /alt="" aria-hidden="true"/);
  assert.equal(identityIcon(null), ''); assert.equal(identitySvg(null, 0, 0), '');
  assert.equal(identityIcon({ key: 'qwen', src: 'https://example.com/icon' }), '');
  assert.equal(identitySvg({ key: 'qwen', src: 'javascript:alert(1)' }, 0, 0), '');
});
