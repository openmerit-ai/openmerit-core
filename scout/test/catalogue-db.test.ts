import test from 'node:test';
import assert from 'node:assert/strict';
import { importCatalogueSource, rebuildOfferings, type Bucket, type ImportResult } from '../catalogue-db.ts';
import { d1 } from './helpers-d1.ts';

const bucket = (): Bucket & { data: Map<string, Uint8Array> } => { const data = new Map<string, Uint8Array>(); return { data, head: async (k: string) => data.has(k) ? {} : null, put: async (k: string, v: Uint8Array) => data.set(k, v) }; };
const serve = (files: Record<string, unknown>) => async (url: string) => { const f = files[url]; return f === undefined ? new Response('missing', { status: 500 }) : new Response(typeof f === 'string' ? f : JSON.stringify(f)); };
const MD = 'https://models.dev/api.json', MDM = 'https://models.dev/models.json', LL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const api = {
  openai: { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1', models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', family: 'gpt', canonical_model_id: 'openai/gpt-x', release_date: '2026-05-01', modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 400000, output: 128000 }, tool_call: true,
    cost: { input: 2, output: 10, context_over_200k: { input: 4, output: 15 }, tiers: [{ input: 4, output: 15, tier: { type: 'context', size: 200000 } }, { input: 5, tier: { type: 'context', size: 272000 } }] } } } },
  anthropic: { id: 'anthropic', name: 'Anthropic', models: { 'claude-y': { id: 'claude-y', name: 'Claude Y', canonical_model_id: 'anthropic/claude-y', modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15 } } } },
  'amazon-bedrock': { id: 'amazon-bedrock', name: 'Amazon Bedrock', models: { 'us.anthropic.claude-y': { id: 'us.anthropic.claude-y', name: 'Claude Y (US)', canonical_model_id: 'anthropic/claude-y', limit: { context: 200000, output: 64000 }, cost: { input: 3.3, output: 16.5 } },
    'us.vendor.unlisted': { id: 'us.vendor.unlisted', name: 'Unlisted', limit: { context: 8000, output: 2000 } } } },
};
const models = { 'openai/gpt-x': { id: 'openai/gpt-x', name: 'GPT X', family: 'gpt', license: 'proprietary', open_weights: false, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 400000, output: 128000 } } };
const litellm = (input = 2.5e-6) => ({
  'gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 2.5e-6 },
  'gpt-x': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: input, output_cost_per_token: 1e-5, input_cost_per_token_above_272k_tokens_priority: 1e-5, deprecation_date: '2027-01-31', supports_vision: true },
  'azure/gpt-x': { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 2.2e-6 },
  'bedrock/us.anthropic.claude-y': { litellm_provider: 'bedrock', mode: 'chat', input_cost_per_token: 3.3e-6, output_cost_per_token: 1.65e-5 },
  'deepinfra/vendor/open-1': { litellm_provider: 'deepinfra', mode: 'chat', input_cost_per_token: 1e-7 },
  'exa_ai/search': { litellm_provider: 'exa_ai', mode: 'search', input_cost_per_query: .005 },
});
const ok = (result: ImportResult) => { if (result.status !== 'ok') throw new Error(result.error); return result; };
const one = (db: ReturnType<typeof d1>, sql: string): Record<string, unknown> => db.all(sql)[0] ?? {};

test('models.dev seeds canonical models, routes and dated price tiers, and LiteLLM routes resolve only to its identities', async () => {
  const db = d1(), raw = bucket();
  const backbone = ok(await importCatalogueSource(db, 'modelsdev', { fetcher: serve({ [MD]: api, [MDM]: models }), bucket: raw, now: '2026-10-25T00:00:00Z', run: 'r1' }));
  assert.equal(backbone.listings, 4); assert.equal(backbone.unresolved, 1);
  // A canonical ID referenced only by routes still becomes a model, with its lab.
  assert.deepEqual(db.all('SELECT id,lab_id,basis,license FROM cat_models ORDER BY id').map(r => ({ ...r })), [
    { id: 'anthropic/claude-y', lab_id: 'anthropic', basis: 'modelsdev-route', license: null }, { id: 'openai/gpt-x', lab_id: 'openai', basis: 'modelsdev-model', license: 'proprietary' }]);
  // The legacy context_over_200k block and an identical 200k tier are one tier, not two.
  assert.deepEqual(db.all("SELECT kind,tier,amount FROM cat_prices WHERE provider_model_id='gpt-x' ORDER BY tier,kind").map(r => ({ ...r })), [
    { kind: 'input', tier: '', amount: 2 }, { kind: 'output', tier: '', amount: 10 }, { kind: 'input', tier: 'context>200000', amount: 4 }, { kind: 'output', tier: 'context>200000', amount: 15 }, { kind: 'input', tier: 'context>272000', amount: 5 }]);
  assert.equal(raw.data.size, 2, 'both raw files are kept by content hash');

  const routes = ok(await importCatalogueSource(db, 'litellm', { fetcher: serve({ [LL]: litellm() }), bucket: raw, now: '2026-10-25T00:00:00Z', run: 'r2' }));
  assert.equal(routes.listings, 5, 'search tools are not models');
  const listed = Object.fromEntries(db.all("SELECT provider_id||'|'||provider_model_id k,model_id,model_basis FROM cat_listings WHERE source='litellm'").map(r => [r.k, [r.model_id, r.model_basis]]));
  assert.deepEqual(listed, {
    'openai|gpt-4o': [null, null], 'openai|gpt-x': ['openai/gpt-x', 'modelsdev-route'], 'litellm:azure|gpt-x': ['openai/gpt-x', 'modelsdev-same-id'],
    'amazon-bedrock|us.anthropic.claude-y': ['anthropic/claude-y', 'modelsdev-route'], 'litellm:deepinfra|vendor/open-1': [null, null] }, 'providers absent from Models.dev stay namespaced');
  // Per-token rates become exact USD per million tokens, with combined tiers.
  assert.deepEqual(db.all("SELECT kind,tier,amount FROM cat_prices WHERE source='litellm' AND provider_id='openai' AND provider_model_id='gpt-x' ORDER BY kind,tier").map(r => ({ ...r })), [
    { kind: 'input', tier: '', amount: 2.5 }, { kind: 'input', tier: 'context>272000,priority', amount: 10 }, { kind: 'output', tier: '', amount: 10 }]);

  assert.equal((await rebuildOfferings(db)).offerings, 7);
  const merged = { ...one(db, "SELECT name,model_id,deprecated_at,sources FROM cat_offerings WHERE provider_id='openai' AND provider_model_id='gpt-x'") };
  assert.deepEqual(merged, { name: 'GPT X', model_id: 'openai/gpt-x', deprecated_at: '2027-01-31', sources: '["modelsdev","litellm"]' });
});

test('re-imports keep unchanged prices open, date changes, withdraw missing routes and restore them', async () => {
  const db = d1(), files: Record<string, unknown> = { [MD]: api, [MDM]: models, [LL]: litellm() }, fetcher = async (url: string) => serve(files)(url);
  await importCatalogueSource(db, 'modelsdev', { fetcher, now: '2026-10-25T00:00:00Z', run: 'm1' });
  await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-25T00:00:00Z', run: 'l1' });
  const same = ok(await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-25T12:00:00Z', run: 'l2' }));
  assert.deepEqual([same.added, same.changed, same.withdrawn, same.prices_opened, same.prices_closed], [0, 0, 0, 0, 0]);

  const next: Record<string, unknown> = litellm(3e-6); delete next['deepinfra/vendor/open-1']; files[LL] = next;
  const changed = ok(await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-26T00:00:00Z', run: 'l3' }));
  assert.deepEqual([changed.changed, changed.withdrawn, changed.prices_opened, changed.prices_closed], [1, 1, 1, 2]);
  assert.deepEqual(db.all("SELECT amount,valid_from,valid_to FROM cat_prices WHERE source='litellm' AND provider_id='openai' AND provider_model_id='gpt-x' AND kind='input' AND tier='' ORDER BY valid_from").map(r => ({ ...r })), [
    { amount: 2.5, valid_from: '2026-10-25T00:00:00Z', valid_to: '2026-10-26T00:00:00Z' }, { amount: 3, valid_from: '2026-10-26T00:00:00Z', valid_to: null }]);
  assert.equal(one(db, "SELECT withdrawn_at FROM cat_listings WHERE provider_model_id='vendor/open-1'").withdrawn_at, '2026-10-26T00:00:00Z');
  await rebuildOfferings(db);
  assert.equal(one(db, "SELECT count(*) n FROM cat_offerings WHERE provider_model_id='vendor/open-1'").n, 0);

  files[LL] = litellm(3e-6);
  const restored = ok(await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-27T00:00:00Z', run: 'l4' }));
  assert.deepEqual([restored.changed, restored.prices_opened], [1, 1]);
  assert.deepEqual({ ...one(db, "SELECT first_seen,withdrawn_at FROM cat_listings WHERE provider_model_id='vendor/open-1'") }, { first_seen: '2026-10-25T00:00:00Z', withdrawn_at: null });
});

test('an unavailable or collapsed source records a failed run and keeps every previous row', async () => {
  const db = d1(), big: Record<string, unknown> = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`m-${i}`, { litellm_provider: 'groq', mode: 'chat', input_cost_per_token: 1e-6 }]));
  const files: Record<string, unknown> = { [LL]: { 'gpt-4o': { litellm_provider: 'openai', mode: 'chat' }, ...big } }, fetcher = async (url: string) => serve(files)(url);
  assert.equal(ok(await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-25T00:00:00Z', run: 'a' })).listings, 81);
  files[LL] = { 'gpt-4o': { litellm_provider: 'openai', mode: 'chat' }, 'm-1': big['m-1'] };
  const collapsed = await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-26T00:00:00Z', run: 'b' });
  assert.equal(collapsed.status, 'failed'); assert.match(collapsed.error, /dropped from 81 to 2/);
  delete files[LL];
  assert.equal((await importCatalogueSource(db, 'litellm', { fetcher, now: '2026-10-27T00:00:00Z', run: 'c' })).status, 'failed');
  assert.equal(one(db, 'SELECT count(*) n FROM cat_listings WHERE withdrawn_at IS NULL').n, 81);
  assert.equal(one(db, 'SELECT count(*) n FROM cat_prices WHERE valid_to IS NULL').n, 80);
  assert.deepEqual(db.all('SELECT id,status FROM cat_runs ORDER BY id').map(r => [r.id, r.status]), [['a', 'ok'], ['b', 'failed'], ['c', 'failed']]);
  assert.equal(one(db, "SELECT last_run FROM cat_sources WHERE id='litellm'").last_run, 'a');
});

test('gateways, genai-prices and Epoch add routes, Hugging Face IDs, tiers, dated prices and source models', async () => {
  const db = d1();
  // A database created before hf_id existed gains the column on the next import.
  await db.prepare('CREATE TABLE cat_listings (source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, model_id TEXT, model_basis TEXT, name TEXT, family TEXT, type TEXT, status TEXT, release_date TEXT, knowledge TEXT, deprecated_at TEXT, context INTEGER, max_input INTEGER, max_output INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, structured_output INTEGER, attachment INTEGER, open_weights INTEGER, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT, PRIMARY KEY(source,provider_id,provider_model_id))').run();
  const OR = 'https://openrouter.ai/api/v1/models', VC = 'https://ai-gateway.vercel.sh/v1/models', GP = 'https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json', EP = 'https://epoch.ai/data/all_ai_models.csv';
  const files: Record<string, unknown> = {
    [MD]: api, [MDM]: models,
    [OR]: { data: [
      { id: 'openai/gpt-x', name: 'OpenAI: GPT X', hugging_face_id: '', context_length: 400000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, top_provider: { max_completion_tokens: 128000 },
        pricing: { prompt: '0.000002', completion: '0.00001', web_search: '0.01' }, supported_parameters: ['tools', 'response_format'] },
      { id: 'vendor/open-1', name: 'Open 1', hugging_face_id: 'Vendor/Open-1', context_length: 32000, pricing: { prompt: '0.0000001', completion: '0.0000002' }, supported_parameters: ['max_tokens'] },
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } }] },
    [VC]: { data: [{ id: 'openai/gpt-x', name: 'GPT X', type: 'language', released: 1777593600, context_window: 400000, max_tokens: 128000, tags: ['tool-use', 'reasoning'], modalities: { input: ['text'], output: ['text'] },
      pricing: { input: '0.0000025', output: '0.00001', input_tiers: [{ cost: '0.0000025', min: 0, max: 272001 }, { cost: '0.000005', min: 272001 }], service_tiers: { priority: { input: '0.000005' } } } }] },
    [GP]: [
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-x', name: 'GPT X', context_window: 400000, prices: [
        { prices: { input_mtok: { base: 2, tiers: [{ start: 272000, price: 4 }] }, output_mtok: 10, cache_read_mtok: 0.2 } },
        { constraint: { start_date: '2026-09-01' }, prices: { input_mtok: 1.5, output_mtok: 10 } },
        { constraint: { start_date: '2027-01-01' }, prices: { input_mtok: 1, output_mtok: 8 } },
        { constraint: { start_time: '16:30:00', end_time: '00:30:00' }, prices: { input_mtok: 0.5, output_mtok: 4 } }] }] },
      { id: 'huggingface_together', name: 'Together (Hugging Face)', models: [{ id: 'Vendor/Open-1', prices: { input_mtok: 0.2, requests_kcount: 1 } }] }],
    [EP]: 'Model,Organization,Country (of organization),Publication date,Parameters,Open model weights?,Abstract\r\n'
      + 'GPT X,OpenAI,"United States of America,United States of America",2026-05-01,,No,"Says ""hi"", then\ncontinues"\r\n'
      + 'Regional Z,Lab Z,South Korea,2026-07-31,750000000000.0,Yes,\r\n',
  };
  const fetcher = async (url: string) => serve(files)(url), now = '2026-10-26T00:00:00Z';
  for (const source of ['modelsdev', 'openrouter', 'vercel', 'genaiprices', 'epoch'] as const) ok(await importCatalogueSource(db, source, { fetcher, now, run: source }));
  const routes = Object.fromEntries(db.all("SELECT source||'|'||provider_id||'|'||provider_model_id k,model_id,model_basis,hf_id FROM cat_listings WHERE source<>'modelsdev'").map(r => [r.k, [r.model_id, r.model_basis, r.hf_id]]));
  assert.deepEqual(routes, {
    // Gateway IDs that are canonical lab/model IDs resolve even where Models.dev lists no such route.
    'openrouter|openrouter|openai/gpt-x': ['openai/gpt-x', 'modelsdev-canonical-id', null], 'openrouter|openrouter|vendor/open-1': [null, null, 'Vendor/Open-1'],
    'openrouter|openrouter|openrouter/auto': [null, null, null], 'vercel|vercel|openai/gpt-x': ['openai/gpt-x', 'modelsdev-canonical-id', null],
    'genaiprices|openai|gpt-x': ['openai/gpt-x', 'modelsdev-route', null], 'genaiprices|huggingface:together|Vendor/Open-1': [null, null, 'Vendor/Open-1'] });
  const prices = (source: string, provider: string) => db.all(`SELECT kind,tier,unit,amount FROM cat_prices WHERE source='${source}' AND provider_id='${provider}' ORDER BY kind,tier`).map(r => [r.kind, r.tier, r.unit, r.amount]);
  // Router "-1" placeholders are not prices.
  assert.deepEqual(prices('openrouter', 'openrouter'), [['input', '', 'usd_per_mtok', 2], ['input', '', 'usd_per_mtok', 0.1], ['output', '', 'usd_per_mtok', 10], ['output', '', 'usd_per_mtok', 0.2], ['web_search', '', 'usd_per_query', 0.01]]);
  assert.deepEqual(prices('vercel', 'vercel'), [['input', '', 'usd_per_mtok', 2.5], ['input', 'context>272000', 'usd_per_mtok', 5], ['input', 'priority', 'usd_per_mtok', 5], ['output', '', 'usd_per_mtok', 10]]);
  // The September variant is the whole price set: no earlier tier or cache price, no future or off-peak price.
  assert.deepEqual(prices('genaiprices', 'openai'), [['input', '', 'usd_per_mtok', 1.5], ['output', '', 'usd_per_mtok', 10]]);
  assert.deepEqual(prices('genaiprices', 'huggingface:together'), [['input', '', 'usd_per_mtok', 0.2], ['request', '', 'usd_per_request', 0.001]]);
  assert.deepEqual({ ...one(db, "SELECT release_date,reasoning,tool_call,structured_output FROM cat_listings WHERE source='vercel'") }, { release_date: '2026-05-01', reasoning: 1, tool_call: 1, structured_output: 0 });
  assert.deepEqual(db.all('SELECT name,organization,country,release_date,parameters,open_weights,model_id,model_basis FROM cat_source_models ORDER BY name').map(r => ({ ...r })), [
    { name: 'GPT X', organization: 'OpenAI', country: 'United States of America', release_date: '2026-05-01', parameters: null, open_weights: 0, model_id: 'openai/gpt-x', model_basis: 'name-exact-unique' },
    { name: 'Regional Z', organization: 'Lab Z', country: 'South Korea', release_date: '2026-07-31', parameters: 750000000000, open_weights: 1, model_id: null, model_basis: null }]);
  assert.equal(JSON.parse(String(one(db, "SELECT payload FROM cat_source_models WHERE name='GPT X'").payload)).Abstract, 'Says "hi", then\ncontinues');
  await rebuildOfferings(db);
  assert.deepEqual({ ...one(db, "SELECT model_id,hf_id,sources FROM cat_offerings WHERE provider_id='openrouter' AND provider_model_id='vendor/open-1'") }, { model_id: null, hf_id: 'Vendor/Open-1', sources: '["openrouter"]' });
});
