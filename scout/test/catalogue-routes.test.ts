import test from 'node:test';
import assert from 'node:assert/strict';
import { importCatalogueSource, rebuildOfferings } from '../catalogue-db.ts';
import { catalogueRoutes, loadCatalogue } from '../catalogue-routes.ts';
import { d1 } from './helpers-d1.ts';

const MD = 'https://models.dev/api.json', MDM = 'https://models.dev/models.json', OR = 'https://openrouter.ai/api/v1/models';
const route = (id: string, canonical: string, cost: Record<string, number>, output = ['text']) => ({ id, name: id, canonical_model_id: canonical, modalities: { input: ['text'], output }, limit: { context: 128000, output: 8000 }, tool_call: true, cost });
const api = {
  openai: { id: 'openai', name: 'OpenAI', models: { 'gpt-x': route('gpt-x', 'openai/gpt-x', { input: 2, output: 8 }) } },
  anthropic: { id: 'anthropic', name: 'Anthropic', models: {} },
  // Models.dev lists OpenRouter's own route IDs; this is how Scout's OpenRouter IDs reach canonical models.
  openrouter: { id: 'openrouter', name: 'OpenRouter', npm: '@openrouter/ai-sdk-provider', api: 'https://openrouter.ai/api/v1', models: { 'z-ai/glm-x': route('z-ai/glm-x', 'zai/glm-x', { input: 1, output: 3 }) } },
  zai: { id: 'zai', name: 'Z.AI', npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4', models: { 'glm-x': route('glm-x', 'zai/glm-x', { input: 1.4, output: 4.4 }) } },
  // Admitted host with an SDK-specific entry: its base URL comes from the reviewed override.
  togetherai: { id: 'togetherai', name: 'Together AI', npm: '@ai-sdk/togetherai', models: { 'zai-org/GLM-X': route('zai-org/GLM-X', 'zai/glm-x', { input: 1, output: 3 }), 'zai-org/GLM-X-alt': route('zai-org/GLM-X-alt', 'zai/glm-x', { input: 0.9, output: 3 }),
    // Hosted models Scout has no entry for: a chat model becomes a Scout model, an embedding model does not.
    'deepseek-ai/DS-1': route('deepseek-ai/DS-1', 'deepseek/ds-1', { input: 0.5, output: 2 }), 'BAAI/emb-1': { ...route('BAAI/emb-1', 'baai/emb-1', { input: 0.1, output: 0.1 }), type: 'embedding' } } },
  deepseek: { id: 'deepseek', name: 'DeepSeek', models: {} },
  fireworks: { id: 'fireworks-ai', name: 'Fireworks AI', npm: '@ai-sdk/openai-compatible', api: 'https://api.fireworks.ai/inference/v1/', models: {
    'glm-x': route('glm-x', 'zai/glm-x', { input: 0, output: 0 }), 'gpt-x': route('gpt-x', 'openai/gpt-x', { input: 1, output: 4 }), 'img-x': route('img-x', 'zai/glm-x', { input: 1, output: 1 }, ['image']) } },
  nanogpt: { id: 'nano-gpt', name: 'NanoGPT', npm: '@ai-sdk/openai-compatible', api: 'https://nano-gpt.com/api/v1', models: { 'glm-x': route('glm-x', 'zai/glm-x', { input: 0.5, output: 1 }) } },
};
const admitted = { togetherai: { kind: 'host' as const, api: 'https://api.together.xyz/v1' }, 'fireworks-ai': { kind: 'host' as const }, zai: { kind: 'first-party' as const } };

test('catalogue routes reach Scout models only through exact identities and only for reviewed, priced, text-output hosts', async () => {
  const db = d1(), now = '2026-10-26T00:00:00.000Z';
  const files: Record<string, unknown> = { [MD]: api, [MDM]: {}, [OR]: { data: [{ id: 'z-ai/glm-x', name: 'GLM X', pricing: { prompt: '0.000001', completion: '0.000003' } }] } };
  const fetcher = async (url: string) => new Response(JSON.stringify(files[url]));
  for (const source of ['modelsdev', 'openrouter'] as const) assert.equal((await importCatalogueSource(db, source, { fetcher, now, run: source })).status, 'ok');
  await rebuildOfferings(db);
  const models = [
    // Scout lists GLM X twice: the measured OpenRouter ID owns its routes, the unmeasured duplicate gets none.
    { id: 'z-ai/glm-x', evidence: [{}], endpoints: [{ provider: 'OpenRouter', modelId: 'z-ai/glm-x', source: 'models' }] },
    { id: 'zai/glm-x-native', evidence: [], endpoints: [{ provider: 'Z.AI', modelId: 'glm-x', source: 'modelsdev' }] },
    // A native OpenAI model already has its provider; Fireworks is added through the native route's identity.
    { id: 'openai/gpt-x', evidence: [{}], endpoints: [{ provider: 'OpenAI', modelId: 'gpt-x', source: 'modelsdev' }] },
    { id: 'lab/unknown', evidence: [{}], endpoints: [{ provider: 'OpenRouter', modelId: 'lab/unknown', source: 'models' }] },
  ];
  const routes = await catalogueRoutes(db, models, admitted, now);
  assert.deepEqual([...routes.keys()].sort(), ['openai/gpt-x', 'z-ai/glm-x']);
  // Z.AI (first-party, admitted) and Together are added; NanoGPT is a reseller, Fireworks' GLM route is free and its image model is not a chat contract.
  assert.deepEqual(routes.get('z-ai/glm-x')?.map(e => [e.provider, e.modelId, e.api, e.inputPrice, e.outputPrice, e.providerKind]), [
    ['Together AI', 'zai-org/GLM-X-alt', 'https://api.together.xyz/v1/chat/completions', 0.9, 3, 'host'],
    ['Z.AI', 'glm-x', 'https://api.z.ai/api/paas/v4/chat/completions', 1.4, 4.4, 'first-party']]);
  assert.deepEqual(routes.get('openai/gpt-x')?.map(e => [e.id, e.api, e.parameters]), [['catalogue:fireworks-ai:chat-completions:gpt-x', 'https://api.fireworks.ai/inference/v1/chat/completions', ['tools']]]);

  // GLM X and GPT X are linked by Scout models above, so only DS-1 becomes a catalogue model.
  const listed = (await loadCatalogue(db, admitted)).models(models, now);
  assert.deepEqual(listed.map(m => [m.id, m.name, m.provider, m.inputPrice, m.outputPrice, m.endpoints.map(e => e.id), m.listedBy]), [
    ['deepseek/ds-1', 'deepseek-ai/DS-1', 'DeepSeek', 0.5, 2, ['catalogue:togetherai:chat-completions:deepseek-ai/DS-1'], 'catalogue']]);

  // Every host's name for a linked model points at the Scout model that owns it; models Scout does not list have no alias.
  const aliases = (await loadCatalogue(db, admitted)).aliases(models);
  assert.deepEqual([aliases.get('glmx'), aliases.get('glmxalt'), aliases.get('gptx'), aliases.get('ds1')], ['z-ai/glm-x', 'z-ai/glm-x', 'openai/gpt-x', undefined]);
  // Both Scout entries for GLM X belong to one family; an unlinked model has none.
  const families = (await loadCatalogue(db, admitted)).families(models);
  assert.deepEqual([families.get('z-ai/glm-x'), families.get('zai/glm-x-native'), families.get('lab/unknown')], ['glmx', 'glmx', undefined]);
});

test('a Scout model reaching a canonical model and its dated copy owns both: their hosts and names', async () => {
  const db = d1(), now = '2026-10-26T00:00:00.000Z';
  // Cohere lists the dated ID; OpenRouter lists the undated one; Together hosts the dated one.
  const copies = {
    openai: api.openai, anthropic: api.anthropic,
    cohere: { id: 'cohere', name: 'Cohere', models: { 'cmd-03-2025': route('cmd-03-2025', 'cohere/cmd-03-2025', { input: 2.5, output: 10 }) } },
    openrouter: { id: 'openrouter', name: 'OpenRouter', npm: '@openrouter/ai-sdk-provider', api: 'https://openrouter.ai/api/v1', models: { 'cohere/cmd': route('cohere/cmd', 'cohere/cmd', { input: 2.5, output: 10 }) } },
    togetherai: { id: 'togetherai', name: 'Together AI', npm: '@ai-sdk/togetherai', models: { 'CohereLabs/cmd-host': route('CohereLabs/cmd-host', 'cohere/cmd-03-2025', { input: 2, output: 8 }) } },
  };
  const files: Record<string, unknown> = { [MD]: copies, [MDM]: {}, [OR]: { data: [{ id: 'cohere/cmd', name: 'Cmd', pricing: { prompt: '0.0000025', completion: '0.00001' } }] } };
  const fetcher = async (url: string) => new Response(JSON.stringify(files[url]));
  for (const source of ['modelsdev', 'openrouter'] as const) assert.equal((await importCatalogueSource(db, source, { fetcher, now, run: source })).status, 'ok');
  await rebuildOfferings(db);
  const models = [{ id: 'cohere/cmd', evidence: [{}], endpoints: [{ provider: 'OpenRouter', modelId: 'cohere/cmd', source: 'models' }, { provider: 'Cohere', modelId: 'cmd-03-2025', source: 'modelsdev' }] }];
  const catalogue = await loadCatalogue(db, admitted);
  assert.deepEqual(catalogue.routes(models, now).get('cohere/cmd')?.map(e => [e.provider, e.modelId]), [['Together AI', 'CohereLabs/cmd-host']]);
  assert.equal(catalogue.aliases(models).get('cmdhost'), 'cohere/cmd');
  assert.deepEqual(catalogue.models(models, now), []);
});
