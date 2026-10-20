import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { providerURL } from '../provider-links.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { handleAPI } from '../http.mjs';
import { handleMCP } from '../mcp.mjs';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));

test('every indexed model links to an official provider domain over HTTPS', () => {
  const domains = ['claude.com', 'arcee.ai', 'cohere.com', 'deepseek.com', 'google.dev', 'ibm.com', 'inceptionlabs.ai',
    'inclusion-ai.org', 'longcat.ai', 'meta.ai', 'microsoft.com', 'minimax.io', 'mistral.ai', 'kimi.ai',
    'nousresearch.com', 'nvidia.com', 'openai.com', 'perplexity.ai', 'alibabacloud.com', 'reka.ai',
    'stepfun.com', 'tencent.com', 'thinkingmachines.ai', 'upstage.ai', 'x.ai', 'xiaomi.com', 'z.ai'];
  for (const model of snapshot.models) {
    const destination = providerURL(model.id);
    assert.ok(destination, `${model.id} needs a reviewed provider destination`);
    const url = new URL(destination);
    assert.equal(url.protocol, 'https:');
    assert.ok(domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), model.id);
    assert.equal(url.username + url.password, '');
  }
});

test('unknown providers and malformed IDs have no router or guessed URL fallback', () => {
  for (const id of ['new-lab/model', 'openrouter/auto', 'openai.evil/model', 'not-openai/gpt-5', '__proto__/model', 'openai', 'openai/', 'openai/model/extra', '', null, undefined]) {
    assert.equal(providerURL(id), null, String(id));
  }
});

test('Gemma and GPT-OSS lead to model documentation instead of hosted API pricing', () => {
  assert.equal(providerURL('google/gemma-4-31b-it'), 'https://ai.google.dev/gemma/docs');
  assert.equal(providerURL('openai/gpt-oss-120b'), 'https://openai.com/open-models/');
  assert.equal(providerURL('google/gemini-2.5-pro'), 'https://ai.google.dev/gemini-api/docs/pricing');
  assert.equal(providerURL('openai/gpt-4.1-mini'), 'https://developers.openai.com/api/docs/pricing');
});

test('HTTP and MCP share provider links while retaining quoted prices and benchmark provenance', async () => {
  const run=(i,p)=>recommend(i,p,Date.now(),{kind:'extract',needsVision:true,needsStructured:true,outputFormat:'json',weights:{documents:6,vision:3,structured:3},workload:{input:'medium',output:'short'}});
const index = createIndex(snapshot), prompt = 'Debug Python code';
  const post = (path, body) => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const http = await (await handleAPI(post('api/recommend', { prompt }), index, {}, run)).json();
  const mcp = (await (await handleMCP(post('mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt } } }), index, {}, run)).json()).result.structuredContent;
  assert.equal(http.recommendations.length, 5);
  assert.deepEqual(mcp.recommendations.map(m => m.pricing), http.recommendations.map(m => m.pricing));
  for (const model of http.recommendations) {
    const original = snapshot.models.find(m => m.id === model.modelId);
    assert.equal(model.pricing.url, providerURL(model.modelId));
    assert.match(model.pricing.basis, /rates|prices/);
    const quote = original.endpoints?.find(e => e.id === model.endpoint.id) ?? original;
    assert.equal(model.pricing.inputPerMillion, Number(quote.inputPrice.toFixed(4)));
    assert.equal(model.pricing.outputPerMillion, Number(quote.outputPrice.toFixed(4)));
    assert.ok(model.evidence.every(e => original.evidence.some(source => source.url === e.url)));
  }
});
