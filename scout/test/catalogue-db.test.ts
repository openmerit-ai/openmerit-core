import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCatalogueSchema, gatewayIdentities, importCatalogueSource, parseDeepInfra, parseOpenRouter, mergeListings, mergeModel, rebuildModels, rebuildOfferings, resolveListings, routeVoice, type Bucket, type ImportResult, type Listing, type SourceListing } from '../catalogue-db.ts';
import { d1 } from './helpers-d1.ts';

const bucket = (): Bucket & { data: Map<string, Uint8Array> } => { const data = new Map<string, Uint8Array>(); return { data, head: async (k: string) => data.has(k) ? {} : null, put: async (k: string, v: Uint8Array) => data.set(k, v) }; };
const serve = (files: Record<string, unknown>) => async (url: string) => { const f = files[url]; return f === undefined ? new Response('missing', { status: 500 }) : new Response(typeof f === 'string' ? f : JSON.stringify(f)); };
const MD = 'https://models.dev/api.json?type=all', MDM = 'https://models.dev/models.json?type=all', LL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
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
  assert.deepEqual(db.all("SELECT id,lab_id,basis,license FROM cat_models WHERE basis<>'reviewed-model' ORDER BY id").map(r => ({ ...r })), [
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

test('offering rebuild keeps a route together when its source listings cross a page boundary', async () => {
  const db = d1(), entries = Object.fromEntries(Array.from({ length: 999 }, (_, i) => { const id = `m-${String(i).padStart(4, '0')}`; return [id, { id, name: `M ${i}` }]; }));
  const fetcher = serve({
    [MD]: { openai: { models: {} }, anthropic: { models: {} }, host: { id: 'host', models: { ...entries, 'zz-shared': { id: 'zz-shared', name: 'Shared', limit: { context: 9000 } } } } }, [MDM]: {},
    [LL]: { 'gpt-4o': { mode: 'search' }, 'zz-shared': { litellm_provider: 'host', mode: 'chat', max_input_tokens: 8000, max_output_tokens: 700 } },
  });
  ok(await importCatalogueSource(db, 'modelsdev', { fetcher }));
  ok(await importCatalogueSource(db, 'litellm', { fetcher }));
  const stats = await rebuildOfferings(db);
  assert.equal(stats.offerings, 1000);
  assert.deepEqual({ ...one(db, "SELECT name,context,max_output,sources FROM cat_offerings WHERE provider_id='host' AND provider_model_id='zz-shared'") },
    { name: 'Shared', context: 9000, max_output: 700, sources: '["modelsdev","litellm"]' });
  assert.equal(one(db, "SELECT count(*) n FROM cat_offerings WHERE provider_model_id='m-0000' OR provider_model_id='m-0998'").n, 2);
  assert.deepEqual(await rebuildOfferings(db), stats, 'a repeated rebuild neither skips nor duplicates rows');
  // A timed-out step keeps running beside its retry: a whole rebuild runs between the
  // first one's staging and its swap. Neither may clear the other's rows.
  let staging = false, overlapped = false;
  const overlapping = { prepare: (sql: string) => { if (sql.startsWith('INSERT INTO cat_offering_stage')) staging = true; return db.prepare(sql); },
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      const out = await db.batch(statements);
      if (staging && !overlapped) { overlapped = true; assert.deepEqual(await rebuildOfferings(db), stats); }
      return out;
    } };
  assert.deepEqual(await rebuildOfferings(overlapping), stats);
  assert.ok(overlapped);
  assert.equal(one(db, 'SELECT count(*) n FROM cat_offerings').n, 1000, 'the outer rebuild swaps in its complete stage');
  assert.equal(one(db, 'SELECT count(*) n FROM cat_offering_stage').n, 0);
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
  const OR = 'https://openrouter.ai/api/v1/models?output_modalities=all', VC = 'https://ai-gateway.vercel.sh/v1/models', GP = 'https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json', EP = 'https://epoch.ai/data/all_ai_models.csv';
  const files: Record<string, unknown> = {
    // Models.dev leaves this Fireworks entry unlinked; its slug names one canonical model.
    [MD]: { ...api, 'fireworks-ai': { id: 'fireworks-ai', name: 'Fireworks AI', models: { 'accounts/fireworks/models/claude-y': { id: 'accounts/fireworks/models/claude-y', name: 'Claude Y' } } } }, [MDM]: models,
    [OR]: { data: [
      { id: 'openai/gpt-x', name: 'OpenAI: GPT X', hugging_face_id: '', context_length: 400000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, top_provider: { max_completion_tokens: 128000 },
        pricing: { prompt: '0.000002', completion: '0.00001', web_search: '0.01' }, supported_parameters: ['tools', 'response_format'] },
      { id: 'vendor/open-1', name: 'Open 1', hugging_face_id: 'Vendor/Open-1', context_length: 32000, pricing: { prompt: '0.0000001', completion: '0.0000002' }, supported_parameters: ['max_tokens'] },
      { id: 'vendor/open-1:free', name: 'Open 1 (free)' },
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } }] },
    [VC]: { data: [{ id: 'openai/gpt-x', name: 'GPT X', type: 'language', released: 1777593600, context_window: 400000, max_tokens: 128000, tags: ['tool-use', 'reasoning'], modalities: { input: ['text'], output: ['text'] },
      pricing: { input: '0.0000025', output: '0.00001', input_tiers: [{ cost: '0.0000025', min: 0, max: 272001 }, { cost: '0.000005', min: 272001 }], service_tiers: { priority: { input: '0.000005' } } } },
      { id: 'openai/gpt-x-batch', name: 'GPT X', type: 'language' }, { id: 'lab-w/w-1', name: 'W 1', type: 'language' }] },
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
    'openrouter|openrouter|openai/gpt-x': ['openai/gpt-x', 'modelsdev-canonical-id', null],
    // A gateway model Models.dev lacks becomes its own identity, shared by its service variants; routers never do.
    'openrouter|openrouter|vendor/open-1': ['vendor/open-1', 'openrouter-id', 'Vendor/Open-1'], 'openrouter|openrouter|vendor/open-1:free': ['vendor/open-1', 'openrouter-id', null],
    'openrouter|openrouter|openrouter/auto': [null, null, null], 'vercel|vercel|openai/gpt-x': ['openai/gpt-x', 'modelsdev-canonical-id', null],
    'vercel|vercel|openai/gpt-x-batch': ['openai/gpt-x', 'modelsdev-canonical-id', null], 'vercel|vercel|lab-w/w-1': ['lab-w/w-1', 'vercel-id', null],
    // The Hub route links through the repository the OpenRouter identity names.
    'genaiprices|openai|gpt-x': ['openai/gpt-x', 'modelsdev-route', null], 'genaiprices|huggingface:together|Vendor/Open-1': ['vendor/open-1', 'hf-repo', 'Vendor/Open-1'] });
  assert.deepEqual({ ...one(db, "SELECT model_id,model_basis FROM cat_listings WHERE provider_id='fireworks-ai'") }, { model_id: 'anthropic/claude-y', model_basis: 'slug-unique' });
  assert.deepEqual(db.all("SELECT id,lab_id,name,basis FROM cat_models WHERE basis NOT LIKE 'modelsdev-%' AND basis<>'reviewed-model' ORDER BY id").map(r => ({ ...r })), [
    { id: 'lab-w/w-1', lab_id: 'lab-w', name: 'W 1', basis: 'vercel-id' }, { id: 'vendor/open-1', lab_id: 'vendor', name: 'Open 1', basis: 'openrouter-id' }]);
  const prices = (source: string, provider: string) => db.all(`SELECT kind,tier,unit,amount FROM cat_prices WHERE source='${source}' AND provider_id='${provider}' ORDER BY kind,tier`).map(r => [r.kind, r.tier, r.unit, r.amount]);
  // Router "-1" placeholders are not prices.
  assert.deepEqual(prices('openrouter', 'openrouter'), [['input', '', 'usd_per_mtok', 2], ['input', '', 'usd_per_mtok', 0.1], ['output', '', 'usd_per_mtok', 10], ['output', '', 'usd_per_mtok', 0.2], ['web_search', '', 'usd_per_query', 0.01]]);
  assert.deepEqual(prices('vercel', 'vercel'), [['input', '', 'usd_per_mtok', 2.5], ['input', 'context>272000', 'usd_per_mtok', 5], ['input', 'priority', 'usd_per_mtok', 5], ['output', '', 'usd_per_mtok', 10]]);
  // The September variant is the whole price set: no earlier tier or cache price, no future or off-peak price.
  assert.deepEqual(prices('genaiprices', 'openai'), [['input', '', 'usd_per_mtok', 1.5], ['output', '', 'usd_per_mtok', 10]]);
  assert.deepEqual(prices('genaiprices', 'huggingface:together'), [['input', '', 'usd_per_mtok', 0.2], ['request', '', 'usd_per_request', 0.001]]);
  assert.deepEqual({ ...one(db, "SELECT release_date,reasoning,tool_call,structured_output FROM cat_listings WHERE source='vercel' AND provider_model_id='openai/gpt-x'") }, { release_date: '2026-05-01', reasoning: 1, tool_call: 1, structured_output: 0 });
  assert.deepEqual(db.all('SELECT name,organization,country,release_date,parameters,open_weights,model_id,model_basis FROM cat_source_models ORDER BY name').map(r => ({ ...r })), [
    { name: 'GPT X', organization: 'OpenAI', country: 'United States of America', release_date: '2026-05-01', parameters: null, open_weights: 0, model_id: 'openai/gpt-x', model_basis: 'name-exact-unique' },
    { name: 'Regional Z', organization: 'Lab Z', country: 'South Korea', release_date: '2026-07-31', parameters: 750000000000, open_weights: 1, model_id: null, model_basis: null }]);
  assert.equal(JSON.parse(String(one(db, "SELECT payload FROM cat_source_models WHERE name='GPT X'").payload)).Abstract, 'Says "hi", then\ncontinues');
  await rebuildOfferings(db);
  assert.deepEqual({ ...one(db, "SELECT model_id,hf_id,sources FROM cat_offerings WHERE provider_id='openrouter' AND provider_model_id='vendor/open-1'") }, { model_id: 'vendor/open-1', hf_id: 'Vendor/Open-1', sources: '["openrouter"]' });
  // A later Models.dev import withdraws only Models.dev's own models.
  ok(await importCatalogueSource(db, 'modelsdev', { fetcher, now: '2026-10-26T12:00:00Z', run: 'modelsdev-2' }));
  assert.deepEqual(db.all("SELECT id FROM cat_models WHERE withdrawn_at IS NULL AND basis<>'reviewed-model' ORDER BY id").map(r => r.id), ['anthropic/claude-y', 'lab-w/w-1', 'openai/gpt-x', 'vendor/open-1']);
  // A gateway's next import keeps the identities it introduced, with their own basis.
  for (const source of ['openrouter', 'vercel'] as const) ok(await importCatalogueSource(db, source, { fetcher, now: '2026-10-27T00:00:00Z', run: `${source}-2` }));
  assert.deepEqual(db.all("SELECT id,basis FROM cat_models WHERE withdrawn_at IS NULL AND basis<>'reviewed-model' ORDER BY id").map(r => [r.id, r.basis]),
    [['anthropic/claude-y', 'modelsdev-route'], ['lab-w/w-1', 'vercel-id'], ['openai/gpt-x', 'modelsdev-model'], ['vendor/open-1', 'openrouter-id']]);
  assert.deepEqual(db.all("SELECT model_basis FROM cat_listings WHERE provider_model_id IN ('lab-w/w-1','vendor/open-1') ORDER BY provider_model_id").map(r => r.model_basis), ['vercel-id', 'openrouter-id']);
});

test('merging prefers Models.dev field by field and needs two other sources to add a capability it denies', () => {
  const blank = { model_id: null, model_basis: null, name: null, family: null, type: null, status: null, release_date: null, deprecated_at: null, context: null, max_input: null, max_output: null,
    input_modalities: null, output_modalities: null, reasoning: null, tool_call: null, structured_output: null, attachment: null, open_weights: null, hf_id: null };
  const listing = (source: string, fields: Partial<SourceListing>, provider_id = 'host'): SourceListing => ({ ...blank, source, provider_id, provider_model_id: 'm', first_seen: `2026-10-0${source.length % 9}`, last_seen: '2026-10-27', ...fields });
  const md = listing('modelsdev', { model_id: 'lab/m', model_basis: 'modelsdev-route', name: 'M', context: 200000, input_modalities: '["text"]', tool_call: 0 });
  // One other source cannot add image input or tool calling; its gaps-only fields still fill in.
  const one = mergeListings([listing('litellm', { model_id: 'lab/other', model_basis: 'litellm-id', context: 128000, max_output: 8000, input_modalities: '["text","image"]', tool_call: 1 }), md]);
  assert.deepEqual([one.model_id, one.model_basis, one.context, one.max_output, one.input_modalities, one.tool_call], ['lab/m', 'modelsdev-route', 200000, 8000, '["text"]', 0]);
  assert.deepEqual(JSON.parse(String(one.conflicts)).context, { modelsdev: 200000, litellm: 128000 });
  assert.deepEqual(JSON.parse(one.provenance).max_output, ['litellm']);
  // Kind normalizes each source's type label: an API mode is chat, Vercel's "evaluation" and OpenRouter's "decisions" are decision models.
  assert.equal(one.kind, null);
  assert.deepEqual(['responses', 'evaluation', 'decisions', 'feature-extraction', 'unheard-of'].map(type => mergeListings([listing('litellm', { type })]).kind), ['chat', 'decision', 'decision', 'embedding', null]);
  // Two independent claims add the capability, and both are credited.
  const two = mergeListings([md, listing('litellm', { input_modalities: '["text","image"]', tool_call: 1 }), listing('vercel', { input_modalities: '["image","text"]', tool_call: 1 })]);
  assert.deepEqual([two.input_modalities, two.tool_call], ['["text","image"]', 1]);
  assert.deepEqual(JSON.parse(two.provenance).input_modalities, ['modelsdev', 'vercel', 'litellm']);
  // Models.dev wins even on a host's own routes, and its support is kept when that feed omits it.
  const own = mergeListings([listing('openrouter', { name: 'Lab: M', input_modalities: '["text"]' }, 'openrouter'), listing('modelsdev', { name: 'M', input_modalities: '["text","image"]' }, 'openrouter')]);
  assert.deepEqual([own.name, own.input_modalities, own.sources], ['M', '["text","image"]', '["modelsdev","openrouter"]']);
});

test('a canonical model merges its owner record with every source\'s routes under the same rules', () => {
  const record = { source: 'modelsdev', name: 'M', release_date: '2026-05-01', input_modalities: '["text"]', tool_call: null, context: null };
  // Models.dev's own routes fill its record's gaps; one route with a capability counts for its source.
  const voices = [routeVoice('modelsdev', [{ context: 128000 }, { context: 200000 }]), routeVoice('litellm', [{ input_modalities: '["text"]', tool_call: 0 }, { input_modalities: '["text","image"]', tool_call: 1 }]),
    routeVoice('epoch', [{ release_date: '2026-04-20', open_weights: 1 }])];
  const one = mergeModel('lab/m', record, voices);
  assert.deepEqual([one.name, one.context, one.release_date, one.open_weights, one.input_modalities, one.tool_call], ['M', 200000, '2026-05-01', 1, '["text"]', 1]);
  assert.deepEqual(JSON.parse(String(one.conflicts)), { release_date: { modelsdev: '2026-05-01', epoch: '2026-04-20' }, input_modalities: { modelsdev: '["text"]', litellm: '["text","image"]' } });
  assert.deepEqual(JSON.parse(one.provenance).open_weights, ['epoch']);
  // A second source claiming image input adds it to the canonical model.
  const two = mergeModel('lab/m', record, [...voices, routeVoice('openrouter', [{ input_modalities: '["image","text"]' }])]);
  assert.equal(two.input_modalities, '["text","image"]');
  assert.deepEqual(JSON.parse(two.sources), ['modelsdev', 'openrouter', 'litellm', 'epoch']);
});

test('reviewed identities link LiteLLM-only decision routes but never moving aliases', async () => {
  const db = d1(), now = '2026-10-28T00:00:00Z';
  const fetcher = serve({ [MD]: api, [MDM]: models, [LL]: { ...litellm(), 'nace/drex-v2.0': { litellm_provider: 'nace', mode: 'evaluation', input_cost_per_token: 1e-7 }, 'nace/drex-latest': { litellm_provider: 'nace', mode: 'evaluation', input_cost_per_token: 1e-7 } } });
  ok(await importCatalogueSource(db, 'modelsdev', { fetcher, now, run: 'm' }));
  ok(await importCatalogueSource(db, 'litellm', { fetcher, now, run: 'l' }));
  assert.deepEqual(db.all("SELECT provider_model_id,model_id,model_basis FROM cat_listings WHERE provider_id='litellm:nace' ORDER BY provider_model_id").map(r => [r.provider_model_id, r.model_id, r.model_basis]),
    [['drex-latest', null, null], ['drex-v2.0', 'nace/drex-v2.0', 'reviewed-route']]);
  await rebuildOfferings(db); await rebuildModels(db);
  assert.deepEqual({ ...one(db, "SELECT kind,name FROM cat_model_merged WHERE id='nace/drex-v2.0'") }, { kind: 'decision', name: 'Drex 2.0' });
  // Models.dev's own record replaces a reviewed identity it later introduces.
  const taken = { ...api, nace: { id: 'nace', name: 'Nace', models: { 'drex-v2.0': { id: 'drex-v2.0', name: 'Drex v2', canonical_model_id: 'nace/drex-v2.0' } } } };
  ok(await importCatalogueSource(db, 'modelsdev', { fetcher: serve({ [MD]: taken, [MDM]: models }), now: '2026-10-28T12:00:00Z', run: 'm2' }));
  assert.equal(one(db, "SELECT basis FROM cat_models WHERE id='nace/drex-v2.0'").basis, 'modelsdev-route');
});

test('a moving ~alias never takes an identity, and a gateway revives a model ID another source withdrew', async () => {
  const db = d1(), OR = 'https://openrouter.ai/api/v1/models?output_modalities=all', VC = 'https://ai-gateway.vercel.sh/v1/models';
  const judge = (id: string) => ({ id, name: id, architecture: { input_modalities: ['text'], output_modalities: ['decisions'] }, pricing: { prompt: '0.00000002', completion: '0' } });
  // Models.dev links OpenRouter's moving alias to a canonical model, and a reseller's route introduces lab/decider-1.2.
  const linked = { ...api, openrouter: { id: 'openrouter', name: 'OpenRouter', models: { '~lab/judge-latest': { id: '~lab/judge-latest', canonical_model_id: 'lab/judge-latest' } } },
    reseller: { id: 'reseller', name: 'Reseller', models: { 'lab/decider-1.2': { id: 'lab/decider-1.2', canonical_model_id: 'lab/decider-1.2', type: 'decision' } } } };
  const vercel = { data: [{ id: 'lab/decider-1.2', name: 'Decider 1.2', type: 'evaluation', modalities: { input: ['text'], output: ['text'] }, pricing: { input: '0.00000002', output: '0' } }] };
  const files = { [MD]: linked, [MDM]: models, [OR]: { data: [judge('~lab/judge-latest')] }, [VC]: vercel };
  for (const source of ['modelsdev', 'openrouter', 'vercel'] as const) ok(await importCatalogueSource(db, source, { fetcher: serve(files), now: '2026-11-01T00:00:00Z', run: `${source}-1` }));
  assert.deepEqual(db.all("SELECT source,model_id FROM cat_listings WHERE provider_model_id='~lab/judge-latest' ORDER BY source").map(r => [r.source, r.model_id]), [['modelsdev', null], ['openrouter', null]]);
  assert.equal(db.all("SELECT id FROM cat_models WHERE id='lab/judge-latest'").length, 0);
  assert.deepEqual({ ...one(db, "SELECT basis,withdrawn_at FROM cat_models WHERE id='lab/decider-1.2'") }, { basis: 'modelsdev-route', withdrawn_at: null });
  // The reseller drops the route: Models.dev withdraws its model, and Vercel's listing of that ID takes it over.
  const later = { ...files, [MD]: { ...linked, reseller: { id: 'reseller', name: 'Reseller', models: {} } } };
  for (const source of ['modelsdev', 'vercel'] as const) ok(await importCatalogueSource(db, source, { fetcher: serve(later), now: '2026-11-02T00:00:00Z', run: `${source}-2` }));
  assert.deepEqual({ ...one(db, "SELECT basis,withdrawn_at FROM cat_models WHERE id='lab/decider-1.2'") }, { basis: 'vercel-id', withdrawn_at: null });
  await rebuildOfferings(db); await rebuildModels(db);
  assert.deepEqual({ ...one(db, "SELECT kind FROM cat_model_merged WHERE id='lab/decider-1.2'") }, { kind: 'decision' });
});

test('OpenRouter non-text models get their kind as type, and per-token "0" on generated media is no price', () => {
  const row = (id: string, output: string[], pricing: Record<string, string>) => ({ id, name: id, architecture: { input_modalities: ['text'], output_modalities: output }, pricing });
  const { listings } = parseOpenRouter({ data: [row('lab/chat', ['text'], { prompt: '0.000001', completion: '0.000002' }), row('lab/clip', ['video'], { prompt: '0', completion: '0' }),
    row('lab/pic', ['image'], { prompt: '0', completion: '0', image_output: '0.00003', image_token: '0.000004' }), row('lab/judge', ['decisions'], { prompt: '0.00000002', completion: '0' }),
    row('lab/vec', ['embeddings'], { prompt: '0.0000001', completion: '0' }), row('lab/voice', ['speech'], { prompt: '0.000004', completion: '0' }), row('lab/rank:free', ['rerank'], { prompt: '0', completion: '0' })] });
  const got = Object.fromEntries(listings.map(l => [l.provider_model_id, [l.type, l.output_modalities, l.prices.map(p => `${p.kind} ${p.amount} ${p.unit}`)]]));
  assert.deepEqual(got, {
    'lab/chat': [null, '["text"]', ['input 1 usd_per_mtok', 'output 2 usd_per_mtok']],
    'lab/clip': ['video', '["video"]', []],
    // Per-image and per-image-token prices keep the distinct units OpenRouter documents.
    'lab/pic': ['image', '["image"]', ['output_image 30 usd_per_mtok', 'image_token 4 usd_per_mtok']],
    // Decisions bill input only, so their zero output rate is real; so is a free reranker's.
    'lab/judge': ['decisions', '["text"]', ['input 0.02 usd_per_mtok', 'output 0 usd_per_mtok']],
    'lab/vec': ['embedding', '["embedding"]', ['input 0.1 usd_per_mtok', 'output 0 usd_per_mtok']],
    'lab/voice': ['speech', '["audio"]', ['input 4 usd_per_mtok']],
    'lab/rank:free': ['rerank', '["ranking"]', ['input 0 usd_per_mtok', 'output 0 usd_per_mtok']] });
  // A decision model's expiration date is kept as its deprecation; a moving "~…-latest" alias gets no identity of its own.
  const judges = parseOpenRouter({ data: [{ ...row('lab/judge', ['decisions'], { prompt: '0.00000002', completion: '0' }), expiration_date: '2026-11-20' }, row('~lab/judge-latest', ['decisions'], { prompt: '0.00000002', completion: '0' })] }).listings;
  assert.deepEqual(gatewayIdentities('openrouter', judges).map(m => m.id), ['lab/judge']);
  assert.deepEqual(judges.map(l => [l.provider_model_id, l.model_id, l.deprecated_at]), [['lab/judge', 'lab/judge', '2026-11-20'], ['~lab/judge-latest', null, null]]);
});

test('hosts that spell versions or prefix the lab differently resolve, and a gateway identity moves onto the model it duplicates', () => {
  const owned = new Map([['cohere/embed-v4.0', 'modelsdev-model'], ['cohere/embed-v5.0-fast', 'modelsdev-route'], ['cohere/embed-5-fast', 'openrouter-id'], ['amazon/titan-embed-text-v2', 'vercel-id'],
    ['alibaba/qwen3-embedding-0.6b', 'modelsdev-route'], ['mistral/mistral-embed', 'modelsdev-model'], ['mistralai/mistral-embed-2312', 'openrouter-id'], ['lab/model-4', 'modelsdev-model'], ['other/model-v4.0', 'modelsdev-model']]);
  const listing = (provider_id: string, provider_model_id: string) => ({ provider_id, provider_model_id, model_id: null, model_basis: null, hf_id: null }) as unknown as Listing;
  const listings = [listing('amazon-bedrock', 'eu.cohere.embed-v4:0'), listing('azure', 'embed-v-4-0'), listing('azure', 'Cohere-Embed-V5-Fast'), listing('amazon-bedrock', 'us-gov-west-1/amazon.titan-embed-text-v2:0'),
    listing('fireworks-ai', 'accounts/fireworks/models/qwen3-embedding-0p6b'), listing('databricks', 'databricks-qwen3-embedding-0-6b'), listing('openrouter', 'cohere/embed-5-fast'), listing('openrouter', 'mistralai/mistral-embed-2312'),
    // A leading name must be the matched model's own lab: Mistral's prefix never reaches Cohere's embed-v4.0.
    listing('azure', 'Mistral-embed-v4-0'),
    // Two models share the loose slug model-4, so it resolves nothing.
    listing('azure', 'model-v-4-0')];
  resolveListings(listings, { routes: [], models: new Set(owned.keys()), owned });
  assert.deepEqual(listings.map(l => [l.provider_model_id, l.model_id, l.model_basis]), [
    ['eu.cohere.embed-v4:0', 'cohere/embed-v4.0', 'slug-loose'], ['embed-v-4-0', 'cohere/embed-v4.0', 'slug-loose'], ['Cohere-Embed-V5-Fast', 'cohere/embed-v5.0-fast', 'slug-loose'],
    ['us-gov-west-1/amazon.titan-embed-text-v2:0', 'amazon/titan-embed-text-v2', 'slug-loose'], ['accounts/fireworks/models/qwen3-embedding-0p6b', 'alibaba/qwen3-embedding-0.6b', 'slug-loose'],
    ['databricks-qwen3-embedding-0-6b', 'alibaba/qwen3-embedding-0.6b', 'slug-loose'], ['cohere/embed-5-fast', 'cohere/embed-v5.0-fast', 'slug-loose'], ['mistralai/mistral-embed-2312', 'mistral/mistral-embed', 'reviewed-route'],
    ['Mistral-embed-v4-0', null, null], ['model-v-4-0', null, null]]);
  // OpenRouter no longer keeps the duplicate identities it introduced.
  assert.deepEqual(gatewayIdentities('openrouter', listings.filter(l => l.provider_id === 'openrouter'), owned), []);
});

test('DeepInfra prices convert from cents per unit, modalities follow type and tags, and past deprecations retire the route', () => {
  const now = '2026-10-28T00:00:00.000Z', p = (type: string, fields: Record<string, number>) => ({ type, ...fields });
  const { listings } = parseDeepInfra([
    { model_name: 'lab/chat-1', type: 'text-generation', max_tokens: 131072, tags: ['multimodal', 'tools'], pricing: {
      ...p('tokens', { cents_per_input_token: 0.00003, cents_per_output_token: 0.00012, rate_per_input_token_cached: 0.2, rate_per_service_tier_priority: 1.5 }),
      rate_per_explicit_cache_write_token: { '5m': 1.25, '1h': 2 } } },
    { model_name: 'lab/old-1', type: 'text-generation', deprecated: 1790000000, tags: [], pricing: p('tokens', { cents_per_input_token: 0.00001, cents_per_output_token: 0.00002 }) },
    { model_name: 'lab/clip-1', type: 'text-to-video', pricing: p('output_length', { cents_per_output_sec: 7.5 }) },
    { model_name: 'lab/voice-1', type: 'text-to-speech', pricing: p('input_character_length', { cents_per_input_chars: 0.0015 }) },
    { model_name: 'lab/ear-1', type: 'automatic-speech-recognition', pricing: p('input_length', { cents_per_input_sec: 0.01 }) },
    { model_name: 'lab/pic-1', type: 'text-to-image', is_partner: true, pricing: p('image_units', { cents_per_image_unit: 3 }) },
    { model_name: 'lab/clip-labels-1', type: 'zero-shot-image-classification', pricing: p('input_tokens', { cents_per_input_token: 0.000001, cents_per_image_token: 0.0000035 }) },
    { model_name: 'lab/embed-1', type: 'embeddings', pricing: p('input_tokens', { cents_per_input_token: 0.000001 }) },
    { model_name: 'lab/rank-1', type: 'reranker', pricing: p('input_tokens', { cents_per_input_token: 0.000002 }) },
    { model_name: 'lab/unknown-1', type: 'image-to-3d', pricing: p('tokens', {}) }], now);
  const got = Object.fromEntries(listings.map(l => [l.provider_model_id, [l.type, l.status, l.input_modalities, l.output_modalities, l.context, l.hf_id !== null, l.prices.map(x => `${x.kind} ${x.amount} ${x.unit}`)]]));
  assert.deepEqual(got, {
    'lab/chat-1': ['chat', null, '["text","image"]', '["text"]', 131072, true, ['input 0.3 usd_per_mtok', 'output 1.2 usd_per_mtok', 'cache_read 0.06 usd_per_mtok', 'input 0.45 usd_per_mtok', 'cache_write 0.375 usd_per_mtok', 'cache_write 0.6 usd_per_mtok']],
    'lab/old-1': ['chat', 'deprecated', '["text"]', '["text"]', null, true, ['input 0.1 usd_per_mtok', 'output 0.2 usd_per_mtok']],
    'lab/clip-1': ['text-to-video', null, '["text"]', '["video"]', null, true, ['output_video 0.075 usd_per_second']],
    'lab/voice-1': ['text-to-speech', null, '["text"]', '["audio"]', null, true, ['input 15 usd_per_mchar']],
    'lab/ear-1': ['automatic-speech-recognition', null, '["audio"]', '["text"]', null, true, ['input_audio 0.0001 usd_per_second']],
    // A partner's (closed) model name is no Hugging Face repository.
    'lab/pic-1': ['text-to-image', null, '["text"]', '["image"]', null, false, ['output_image 0.03 usd_per_image_unit']],
    'lab/clip-labels-1': ['decision', null, '["image"]', '["text"]', null, true, ['input 0.01 usd_per_mtok', 'input_image 0.035 usd_per_mtok']],
    'lab/embed-1': ['embedding', null, '["text"]', '["embedding"]', null, true, ['input 0.01 usd_per_mtok']],
    'lab/rank-1': ['rerank', null, '["text"]', '["ranking"]', null, true, ['input 0.02 usd_per_mtok']] });
});

test('Portkey reviewed media quotes retain character, input-audio and image units, never placeholder token prices', async () => {
  const db = d1(), raw = bucket(), config = (rates: Record<string, unknown>) => ({ pricing_config: { pay_as_you_go: rates } });
  const files = {
    'https://configs.portkey.ai/pricing/deepgram.json': {
      default: config({ request_token: { price: 0 } }), 'nova-3': config({ request_audio_token: { price: .43 } }),
      'aura-2-thalia-en': config({ request_token: { price: .003 }, response_token: { price: 0 } }),
      'aura-luna-en': config({ request_token: { price: .0015 } }),
    },
    'https://configs.portkey.ai/pricing/elevenlabs.json': {
      eleven_multilingual_v2: config({ request_token: { price: .01 }, response_token: { price: 0 } }),
      eleven_flash_v2_5: config({ request_token: { price: .005 } }), scribe_v1: config({ request_token: { price: 0 }, response_token: { price: .00611111 } }),
      'text-to-speech': config({ request_token: { price: .01 } }), unknown: config({ request_token: { price: 9 } }),
    },
    'https://configs.portkey.ai/pricing/stability-ai.json': {
      default: config({ image: { default: { default: { price: 0 } } } }),
      ultra: config({ image: { default: { default: { price: 8 } }, hd: { '1024x1024': { price: 12 }, '1536x1024': { price: 16 } } } }),
      core: config({ image: { default: { default: { price: 0 } } } }),
    },
  };
  for (const source of ['portkey-deepgram', 'portkey-elevenlabs', 'portkey-stability-ai'] as const)
    assert.equal((await importCatalogueSource(db, source, { fetcher: serve(files), bucket: raw })).status, 'ok');
  assert.deepEqual(db.all('SELECT provider_model_id,kind,tier,unit,amount FROM cat_prices ORDER BY provider_model_id,tier').map(r => Object.values(r)), [
    ['aura-2-thalia-en', 'input', '', 'usd_per_mchar', 30], ['aura-luna-en', 'input', '', 'usd_per_mchar', 15],
    ['eleven_flash_v2_5', 'input', '', 'usd_per_mchar', 50], ['eleven_multilingual_v2', 'input', '', 'usd_per_mchar', 100],
    ['scribe_v1', 'input_audio', '', 'usd_per_second', .0000611111],
    ['ultra', 'output_image', '', 'usd_per_image', .08], ['ultra', 'output_image', 'quality=hd,size=1024x1024', 'usd_per_image', .12], ['ultra', 'output_image', 'quality=hd,size=1536x1024', 'usd_per_image', .16],
  ]);
  assert.equal(raw.data.size, 3);
  assert.equal((await rebuildOfferings(db)).offerings, 6);
  assert.deepEqual(db.all("SELECT provider_id,kind,input_modalities,output_modalities FROM cat_offerings WHERE provider_model_id='scribe_v1'").map(r => Object.values(r)), [['litellm:elevenlabs', 'transcription', '["audio"]', '["text"]']]);
  assert.equal(db.all('SELECT count(*) n FROM cat_models WHERE basis<>\'reviewed-model\'')[0]?.n, 0, 'price aliases do not manufacture canonical model identities');
});

test('a retired source\'s routes and prices are withdrawn and stop reaching offerings', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  const listing = (source: string, route: string) => db.prepare("INSERT INTO cat_listings (source,provider_id,provider_model_id,payload,payload_hash,first_seen,last_seen) VALUES (?1,'azure',?2,'{}','h','t','t')").bind(source, route).run();
  const price = (source: string, route: string) => db.prepare("INSERT INTO cat_prices (source,provider_id,provider_model_id,kind,tier,unit,amount,valid_from) VALUES (?1,'azure',?2,'input','','usd_per_mtok',1,'t')").bind(source, route).run();
  for (const [source, route] of [['truefoundry', 'shared'], ['litellm', 'shared'], ['truefoundry', 'only-retired'], ['litellm', 'only-kept']] as const) { await listing(source, route); await price(source, route); }
  await rebuildOfferings(db);
  assert.deepEqual(db.all('SELECT provider_model_id,sources FROM cat_offerings ORDER BY 1').map(r => Object.values(r)), [['only-kept', '["litellm"]'], ['shared', '["litellm"]']]);
  assert.deepEqual(db.all('SELECT source,count(*) n FROM cat_listings WHERE withdrawn_at IS NULL GROUP BY 1').map(r => Object.values(r)), [['litellm', 2]]);
  assert.deepEqual(db.all('SELECT source,count(*) n FROM cat_prices WHERE valid_to IS NULL GROUP BY 1').map(r => Object.values(r)), [['litellm', 2]]);
});

test('Eden AI expert models price per one unit of the quoted quantity, keep undirected token quotes unpriced and link only speech and OCR models that exist', async () => {
  const EDEN = 'https://api.edenai.run/v3/info', usd = (price: number, price_unit_quantity: number, price_unit_type: string, currency = 'USD') => ({ price, price_unit_quantity, price_unit_type, currency });
  const sub = (name: string, models: Array<[string, ReturnType<typeof usd>]>) => ({ name, fullname: name, models: models.map(([model, pricing]) => ({ model, pricing, regions: [] })) });
  const info = (fillers: number) => ({ features: [
    { name: 'ocr', subfeatures: [sub('financial_parser', [['ocr/financial_parser/mindee', usd(0.1, 1, 'page')], ['ocr/financial_parser/veryfi', usd(0.08, 1, 'file')], ['ocr/financial_parser/openai/gpt-4o', usd(0.04, 1, 'page')]]),
      sub('ocr', [['ocr/ocr/mistral/mistral-ocr-9', usd(2, 1000, 'page')], ...Array.from({ length: fillers }, (_, i): [string, ReturnType<typeof usd>] => [`ocr/ocr/filler-${i}`, usd(1, 1000, 'page')])])] },
    { name: 'translation', subfeatures: [sub('automatic_translation', [['translation/automatic_translation/deepl', usd(20, 1000000, 'character')], ['translation/automatic_translation/openai/gpt-4o', usd(20, 1000000, 'token')], ['translation/automatic_translation/eurolab', usd(9, 1000000, 'character', 'EUR')]]),
      sub('document_translation', [['translation/document_translation/deepl', usd(2, 20, 'page')]])] },
    { name: 'audio', subfeatures: [sub('tts', [['audio/tts/openai/tts-1', usd(15, 1000000, 'character')], ['audio/tts/openai/gpt-4o-mini-tts', usd(0.015, 1, 'minute')], ['audio/tts/ovhcloud/nvr-tts-en-us', usd(0, 1, 'free')]]),
      sub('speech_to_text_async', [['audio/speech_to_text_async/gladia', usd(0.0102, 60, 'second')]])] },
    { name: 'image', subfeatures: [sub('explicit_content', [['image/explicit_content/google', usd(1.5, 1000, 'file')]]), sub('generation', [['image/generation/lab/pic-1', usd(0.04, 1, 'image')]])] },
    { name: 'text', subfeatures: [sub('moderation', [['text/moderation/microsoft', usd(1, 1000, 'request')], ['text/moderation/ovhcloud/guard-1', usd(0, 1, 'request')]])] },
  ] });
  const md = { openai: { id: 'openai', models: { 'tts-1': { id: 'tts-1', canonical_model_id: 'openai/tts-1', type: 'speech' }, 'gpt-4o': { id: 'gpt-4o', canonical_model_id: 'openai/gpt-4o' } } }, anthropic: { id: 'anthropic', models: {} } };
  const files: Record<string, unknown> = { [MD]: md, [MDM]: {}, [EDEN]: info(10) }, fetcher = async (url: string) => serve(files)(url), db = d1();
  ok(await importCatalogueSource(db, 'modelsdev', { fetcher, now: '2026-10-29T00:00:00Z', run: 'm' }));
  const collapsed = await importCatalogueSource(db, 'edenai', { fetcher, now: '2026-10-29T00:00:00Z', run: 'e0' });
  assert.equal(collapsed.status, 'failed', 'a list with too few expert models stores nothing');
  assert.equal(one(db, "SELECT count(*) n FROM cat_listings WHERE source='edenai'").n, 0);
  files[EDEN] = info(70);
  const stored = ok(await importCatalogueSource(db, 'edenai', { fetcher, now: '2026-10-29T00:00:00Z', run: 'e1' }));
  assert.equal(stored.listings, 85, 'image generation is out of scope; unpriced routes are kept');
  assert.deepEqual(db.all("SELECT provider_model_id,kind,tier,unit,amount FROM cat_prices WHERE source='edenai' AND provider_model_id NOT LIKE 'ocr/ocr/filler-%' ORDER BY provider_model_id").map(r => Object.values(r)), [
    // Minutes become seconds of the generated audio; the 60-second quote is per one second of input audio.
    ['audio/speech_to_text_async/gladia', 'input_audio', '', 'usd_per_second', .00017],
    ['audio/tts/openai/gpt-4o-mini-tts', 'output_audio', '', 'usd_per_second', .00025],
    ['audio/tts/openai/tts-1', 'input', '', 'usd_per_mchar', 15],
    // An image model's file is an image; a document parser's file is a document.
    ['image/explicit_content/google', 'input_image', '', 'usd_per_image', .0015],
    ['ocr/financial_parser/mindee', 'ocr', '', 'usd_per_page', .1], ['ocr/financial_parser/openai/gpt-4o', 'ocr', '', 'usd_per_page', .04], ['ocr/financial_parser/veryfi', 'ocr', '', 'usd_per_file', .08],
    ['ocr/ocr/mistral/mistral-ocr-9', 'ocr', '', 'usd_per_page', .002],
    ['text/moderation/microsoft', 'request', '', 'usd_per_request', .001],
    ['translation/automatic_translation/deepl', 'input', '', 'usd_per_mchar', 20],
    // $2 per 20 pages (a 20-page minimum) is $0.10 per page.
    ['translation/document_translation/deepl', 'input', '', 'usd_per_page', .1]]);
  // Only a speech or OCR model with an existing canonical ID links; a parser built on an LLM does not.
  assert.deepEqual(db.all("SELECT provider_model_id,model_id,model_basis FROM cat_listings WHERE source='edenai' AND (model_id IS NOT NULL OR provider_model_id LIKE '%gpt-4o%') ORDER BY provider_model_id").map(r => Object.values(r)), [
    ['audio/tts/openai/gpt-4o-mini-tts', null, null], ['audio/tts/openai/tts-1', 'openai/tts-1', 'edenai-model'],
    ['ocr/financial_parser/openai/gpt-4o', null, null], ['translation/automatic_translation/openai/gpt-4o', null, null]]);
  await rebuildOfferings(db);
  assert.deepEqual(db.all("SELECT provider_model_id,kind,input_modalities,output_modalities FROM cat_offerings WHERE provider_id='edenai' AND provider_model_id IN ('audio/speech_to_text_async/gladia','ocr/financial_parser/mindee','text/moderation/microsoft')").map(r => Object.values(r)), [
    ['audio/speech_to_text_async/gladia', 'transcription', '["audio"]', '["text"]'], ['ocr/financial_parser/mindee', 'ocr', null, '["text"]'], ['text/moderation/microsoft', 'moderation', '["text"]', '["text"]']]);
});
