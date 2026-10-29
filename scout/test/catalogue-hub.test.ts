import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCatalogueSchema, modelKind } from '../catalogue-db.ts';
import { refreshHubOrgs, crawlHubModels, refreshHubProviders, hubModelsURL, hubProvidersURL, hubPolicy } from '../catalogue-hub.ts';
import { d1 } from './helpers-d1.ts';

type Page = { status?: number; body?: unknown; next?: string };
// Serves Hub API URLs from a table; unknown URLs are 404s, like unknown organisations.
const hub = (pages: Record<string, Page>, seen: string[] = []) => async (url: string) => {
  seen.push(url);
  const p = pages[url];
  if (!p) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(p.body ?? []), { status: p.status ?? 200, headers: p.next ? { link: `<${p.next}>; rel="next"` } : {} });
};
const discovery = (p: string) => `https://huggingface.co/api/models?pipeline_tag=${p}&sort=downloads&direction=-1&limit=1000`;
const overview = (name: string, verified: boolean, numModels: number): Page => ({ body: { name, fullname: name, isVerified: verified, plan: 'team', numModels } });
const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, pipeline_tag: 'text-generation', createdAt: '2026-01-02T00:00:00Z', lastModified: '2026-02-03T00:00:00Z', downloads: 10, likes: 1, tags: ['license:apache-2.0', 'region:us'], gated: false, ...extra });

test('Hub organisations are admitted when verified or named by the catalogue, and crawled whole, scoped and resumably', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  // RefLab is unverified but a catalogue source names it as a model's home; someuser is a person, not an organisation.
  await db.prepare("INSERT INTO cat_listings (source,provider_id,provider_model_id,model_id,model_basis,hf_id,payload,payload_hash,first_seen,last_seen) VALUES ('openrouter','openrouter','reflab/chat','reflab/chat-1','x','RefLab/Chat-1','{}','h','t','t')").run();
  await db.prepare("INSERT INTO cat_source_models (source,id,name,hf_developer,payload,payload_hash,first_seen,last_seen) VALUES ('epoch','u','U','someuser','{}','h','t','t')").run();
  const big = hubModelsURL('BigCo'), page2 = `${big}&cursor=2`, ref = hubModelsURL('RefLab');
  const pages: Record<string, Page> = {
    [discovery('text-generation')]: { body: [{ id: 'BigCo/a' }, { id: 'Rando/x' }, { id: 'RefLab/Chat-1' }] },
    'https://huggingface.co/api/organizations/BigCo/overview': overview('BigCo', true, 1500),
    'https://huggingface.co/api/organizations/RefLab/overview': overview('RefLab', false, 2),
    'https://huggingface.co/api/organizations/Rando/overview': overview('Rando', false, 9),
    [big]: { body: [model('BigCo/a'), model('BigCo/a-GGUF', { tags: ['license:apache-2.0', 'base_model:BigCo/a', 'base_model:quantized:BigCo/a'] }), model('Other/sneaked-in')], next: page2 },
    [page2]: { body: [model('BigCo/b', { private: true }), model('BigCo/c', { safetensors: { total: 7000000000 } })] },
    [ref]: { body: [model('RefLab/Chat-1', { inferenceProviderMapping: [
      { provider: 'novita', status: 'live', task: 'conversational', features: { toolCalling: true, structuredOutput: false }, providerDetails: { context_length: 131072, pricing: { input: 0.42, output: 3 } } },
      { provider: 'cerebras', status: 'error', task: 'conversational' }] })] },
  };
  const orgs = await refreshHubOrgs(db, { fetcher: hub(pages), now: '2026-10-26T00:00:00.000Z' });
  assert.deepEqual([orgs.candidates, orgs.checked, orgs.verified, orgs.admitted], [4, 4, 1, 2]);
  assert.deepEqual(db.all('SELECT name,is_org,verified,referenced FROM cat_hf_orgs ORDER BY name').map(r => Object.values(r)), [
    ['BigCo', 1, 1, 0], ['Rando', 1, 0, 0], ['RefLab', 1, 0, 1], ['someuser', 0, 0, 1]]);

  const first = await crawlHubModels(db, { fetcher: hub(pages), now: '2026-10-26T00:00:00.000Z', run: 'c1' });
  assert.deepEqual([first.organisations, first.pages, first.models, first.routes], [2, 3, 4, 1], 'Link pagination; private and foreign repos are skipped; only live routes count');
  assert.deepEqual(db.all('SELECT id,author,license,parameters,relation,base_models,model_id FROM cat_hf_models ORDER BY id').map(r => Object.values(r)), [
    ['BigCo/a', 'BigCo', 'apache-2.0', null, null, null, null], ['BigCo/a-GGUF', 'BigCo', 'apache-2.0', null, 'quantized', '["BigCo/a"]', null],
    ['BigCo/c', 'BigCo', 'apache-2.0', 7000000000, null, null, null], ['RefLab/Chat-1', 'RefLab', 'apache-2.0', null, null, null, 'reflab/chat-1']]);
  assert.deepEqual({ ...db.all("SELECT provider_id,model_id,hf_id,context,tool_call,structured_output FROM cat_listings WHERE source='huggingface'")[0] },
    { provider_id: 'huggingface:novita', model_id: 'reflab/chat-1', hf_id: 'RefLab/Chat-1', context: 131072, tool_call: 1, structured_output: 0 });
  assert.deepEqual(db.all("SELECT kind,amount FROM cat_prices WHERE source='huggingface' ORDER BY kind").map(r => [r.kind, r.amount]), [['input', 0.42], ['output', 3]]);

  // A week later BigCo drops a model and RefLab's crawl fails: only BigCo's missing model is withdrawn.
  pages[big] = { body: [model('BigCo/a'), model('BigCo/a-GGUF')], next: page2 }; pages[page2] = { body: [] }; pages[ref] = { status: 500 };
  const later = await crawlHubModels(db, { fetcher: hub(pages), now: '2026-11-03T00:00:00.000Z', run: 'c2' });
  assert.deepEqual([later.organisations, later.failed], [1, 1]);
  assert.deepEqual(db.all('SELECT id FROM cat_hf_models WHERE withdrawn_at IS NOT NULL').map(r => r.id), ['BigCo/c']);
  assert.equal(db.all("SELECT count(*) n FROM cat_listings WHERE source='huggingface' AND withdrawn_at IS NULL")[0]?.n, 1);
  assert.equal(db.all("SELECT count(*) n FROM cat_prices WHERE source='huggingface' AND valid_to IS NULL")[0]?.n, 2);
  // The failed organisation stays due; the crawled one waits for its recrawl interval.
  const seen: string[] = [];
  await crawlHubModels(db, { fetcher: hub(pages, seen), now: '2026-11-03T12:00:00.000Z', run: 'c3' });
  assert.deepEqual(seen, [ref]);
});

test('a Hub rate limit stops checking and crawling without marking or withdrawing anything', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  const pages: Record<string, Page> = { [discovery('text-generation')]: { body: [{ id: 'A/x' }, { id: 'B/y' }] }, 'https://huggingface.co/api/organizations/A/overview': { status: 429 },
    'https://huggingface.co/api/organizations/B/overview': { status: 429 } };
  const orgs = await refreshHubOrgs(db, { fetcher: hub(pages), now: '2026-10-26T00:00:00.000Z' });
  assert.equal(orgs.rateLimited, true); assert.equal(orgs.checked, 0);
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_orgs WHERE checked_at IS NULL')[0]?.n, 2, 'unchecked organisations stay due');
});

const served = (repo: string, task = 'conversational', extra: Record<string, unknown> = {}) => model(repo, { inferenceProviderMapping: [
  { provider: 'novita', providerId: `backend/${repo}`, status: 'live', task, providerDetails: { pricing: { input: 0.42, output: 3 } } },
  { provider: 'staging-provider', status: 'staging', task },
], ...extra });
const providerSource = 'huggingface-providers';

test('provider discovery paginates all tasks and personal accounts without admitting organisations or creating chat identities', async () => {
  // The live Hub rewrites expand[]=field to expand=field in its cursor Links.
  const db = d1(), seen: string[] = [], page2 = `${hubProvidersURL.replaceAll('expand[]=', 'expand=')}&cursor=opaque%2Bcursor`;
  const pages: Record<string, Page> = {
    [hubProvidersURL]: { body: [served('someuser/FLUX', 'text-to-image'), served('UnverifiedOrg/voice', 'text-to-speech')], next: page2 },
    [page2]: { body: [served('someuser/embed', 'feature-extraction'), served('someuser/rank', 'text-ranking'), served('someuser/video', 'image-to-video'),
      served('someuser/asr', 'automatic-speech-recognition'), served('someuser/unknown', 'future-task'), served('someuser/chat', 'conversational', { pipeline_tag: 'image-text-to-text' }),
      served('someuser/private', 'text-to-image', { private: true })] },
  };
  const result = await refreshHubProviders(db, { fetcher: hub(pages, seen), now: '2026-10-26T00:00:00.000Z', run: 'providers1' });
  assert.equal(result.error, null);
  assert.deepEqual([result.complete, result.pages, result.models, result.routes], [true, 2, 8, 8]);
  assert.deepEqual(seen, [hubProvidersURL, page2]);
  assert.equal(new URL(seen[0] ?? '').searchParams.get('pipeline_tag'), null);
  assert.equal(new URL(seen[0] ?? '').searchParams.get('author'), null);
  assert.equal(db.all('SELECT count(*) n FROM cat_models')[0]?.n, 0, 'HF repositories never introduce canonical chat identities');
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_orgs')[0]?.n, 0);
  assert.deepEqual(db.all("SELECT id,author,license FROM cat_hf_models WHERE id='someuser/FLUX'").map(r => Object.values(r)), [['someuser/FLUX', 'someuser', 'apache-2.0']]);
  assert.deepEqual(db.all('SELECT provider_model_id,type,input_modalities,output_modalities,model_id FROM cat_listings ORDER BY provider_model_id').map(r => Object.values(r)), [
    ['UnverifiedOrg/voice', 'text-to-speech', '["text"]', '["audio"]', null],
    ['someuser/FLUX', 'text-to-image', '["text"]', '["image"]', null],
    ['someuser/asr', 'automatic-speech-recognition', '["audio"]', '["text"]', null],
    ['someuser/chat', 'chat', '["text","image"]', '["text"]', null],
    ['someuser/embed', 'embedding', '["text"]', '["embedding"]', null],
    ['someuser/rank', 'rerank', '["text"]', '["ranking"]', null],
    ['someuser/unknown', 'future-task', null, null, null],
    ['someuser/video', 'image-to-video', '["image"]', '["video"]', null],
  ]);
  assert.deepEqual(db.all('SELECT type FROM cat_listings ORDER BY provider_model_id').map(r => modelKind(r.type as string)), ['speech', 'image', 'transcription', 'chat', 'embedding', 'rerank', null, 'video']);
  assert.deepEqual(db.all('SELECT provider_model_id,kind,unit,amount FROM cat_prices ORDER BY kind').map(r => Object.values(r)), [
    ['someuser/chat', 'input', 'usd_per_mtok', 0.42], ['someuser/chat', 'output', 'usd_per_mtok', 3],
  ], 'non-token task prices stay unknown, with raw provider data retained in payloads');

  const orgs = await refreshHubOrgs(db, { now: '2026-10-26T01:00:00.000Z', fetcher: hub({
    [discovery('text-generation')]: { body: [{ id: 'UnverifiedOrg/voice' }, { id: 'someuser/FLUX' }] },
    'https://huggingface.co/api/organizations/UnverifiedOrg/overview': overview('UnverifiedOrg', false, 99),
  }) });
  assert.equal(orgs.admitted, 0, 'provider discovery must not make an unverified organisation referenced');
  assert.deepEqual(db.all('SELECT name,referenced FROM cat_hf_orgs ORDER BY name').map(r => Object.values(r)), [['UnverifiedOrg', 0], ['someuser', 0]]);
});

test('provider routes withdraw only after complete snapshots and remain isolated from organisation coverage and repository inventories', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  await db.prepare("INSERT INTO cat_hf_orgs (name,is_org,verified,num_models,first_seen,last_seen) VALUES ('Lab',1,1,2,'t','t')").run();
  const org = hubModelsURL('Lab');
  const initial = await crawlHubModels(db, { now: '2026-10-01T00:00:00.000Z', run: 'org1', fetcher: hub({ [org]: { body: [served('Lab/chat'), model('Lab/not-served')] } }) });
  assert.equal(initial.routes, 1);
  const first = await refreshHubProviders(db, { now: '2026-10-02T00:00:00.000Z', run: 'p1', fetcher: hub({ [hubProvidersURL]: { body: [served('Lab/chat'), served('person/chat')] } }) });
  assert.equal(first.complete, true);
  assert.equal(db.all("SELECT withdrawn_at FROM cat_hf_models WHERE id='Lab/not-served'")[0]?.withdrawn_at, null, 'provider list is not an author inventory');
  const second = await crawlHubModels(db, { now: '2026-10-10T00:00:00.000Z', run: 'org2', fetcher: hub({ [org]: { body: [model('Lab/chat'), model('Lab/not-served')] } }) });
  assert.equal(second.stats?.withdrawn, 1);
  assert.equal(db.all("SELECT count(*) n FROM cat_listings WHERE source='huggingface-providers' AND withdrawn_at IS NULL")[0]?.n, 2, 'org route withdrawals cannot withdraw provider-discovery routes');
  const third = await refreshHubProviders(db, { now: '2026-10-11T00:00:00.000Z', run: 'p2', fetcher: hub({ [hubProvidersURL]: { body: [served('Lab/chat')] } }) });
  assert.equal(third.stats?.withdrawn, 1);
  assert.equal(third.stats?.prices_closed, 2);
  assert.equal(db.all("SELECT withdrawn_at FROM cat_hf_models WHERE id='person/chat'")[0]?.withdrawn_at, null, 'vanishing provider service is not evidence the repository vanished');
  assert.equal(db.all("SELECT last_seen FROM cat_listings WHERE source='huggingface'")[0]?.last_seen, '2026-10-01T00:00:00.000Z');

  // A complete empty feed may withdraw provider routes, but never the org source.
  await crawlHubModels(db, { now: '2026-10-19T00:00:00.000Z', run: 'org3', fetcher: hub({ [org]: { body: [served('Lab/chat')] } }) });
  const empty = await refreshHubProviders(db, { now: '2026-10-20T00:00:00.000Z', run: 'p3', fetcher: hub({ [hubProvidersURL]: { body: [] } }) });
  assert.equal(empty.complete, true); assert.equal(empty.stats?.withdrawn, 1);
  assert.equal(db.all("SELECT count(*) n FROM cat_listings WHERE source='huggingface' AND withdrawn_at IS NULL")[0]?.n, 1);
  assert.equal(db.all("SELECT count(*) n FROM cat_prices WHERE source='huggingface' AND valid_to IS NULL")[0]?.n, 2);
});

test('provider collection failures retain active coverage and reject unsafe pagination before forwarding credentials', async t => {
  const next = `${hubProvidersURL}&cursor=2`;
  const cases: Array<{ name: string; second?: Page; next?: string }> = [
    { name: 'HTTP failure', second: { status: 503 } }, { name: 'rate limit', second: { status: 429 } },
    { name: 'malformed mapping', second: { body: [served('person/new', 'conversational', { inferenceProviderMapping: [{}] })] } },
    { name: 'off-origin', next: 'https://evil.example/api/models?inference_provider=all' },
    { name: 'task-filtered continuation', next: `${next}&pipeline_tag=text-to-image` },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const db = d1();
    const seed = await refreshHubProviders(db, { now: '2026-10-01T00:00:00.000Z', run: 'seed', fetcher: hub({ [hubProvidersURL]: { body: [served('person/old')] } }) });
    assert.equal(seed.complete, true);
    const before = ['cat_listings', 'cat_prices', 'cat_hf_models'].map(table => db.all(`SELECT * FROM ${table}`));
    const seen: string[] = [], fetcher = hub({ [hubProvidersURL]: { body: [served('person/new')], next: c.next ?? next }, [next]: c.second ?? { body: [] } }, seen);
    const result = await refreshHubProviders(db, { now: '2026-10-02T00:00:00.000Z', run: 'failed', token: 'test-secret', fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://huggingface.co', 'never forward credentials off-origin');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-secret');
      assert.equal(init.redirect, 'manual', 'redirects cannot forward credentials');
      return fetcher(url);
    } });
    assert.equal(result.complete, false); assert.equal(result.stats, null); assert.ok(result.error);
    assert.equal(result.rateLimited, c.name === 'rate limit');
    assert.deepEqual(['cat_listings', 'cat_prices', 'cat_hf_models'].map(table => db.all(`SELECT * FROM ${table}`)), before);
    assert.equal(db.all("SELECT last_run FROM cat_sources WHERE id='huggingface-providers'")[0]?.last_run, 'seed');
    assert.equal(db.all("SELECT status FROM cat_runs WHERE id='failed'")[0]?.status, 'failed');
    if (c.next) assert.equal(seen.length, 1);
  });
});

test('page and apply budgets resume durable cursors; interrupted collection and partial application never withdraw other batches', async () => {
  const db = d1(), seen: string[] = [], next = `${hubProvidersURL}&cursor=2`;
  await refreshHubProviders(db, { now: '2026-10-01T00:00:00.000Z', run: 'seed', fetcher: hub({ [hubProvidersURL]: { body: [served('person/a'), served('person/b')] } }) });
  const active = () => db.all("SELECT provider_model_id FROM cat_listings WHERE source='huggingface-providers' AND withdrawn_at IS NULL ORDER BY provider_model_id").map(r => r.provider_model_id);
  const prices = () => db.all("SELECT provider_model_id FROM cat_prices WHERE source='huggingface-providers' AND valid_to IS NULL ORDER BY provider_model_id,kind").map(r => r.provider_model_id);
  // person/a changed since the seed, so this crawl applies it again.
  const pages: Record<string, Page> = { [hubProvidersURL]: { body: [served('person/a', 'conversational', { lastModified: '2026-10-01T12:00:00Z' })], next }, [next]: { status: 429 } };
  const fetcher = hub(pages, seen), started = '2026-10-02T00:00:00.000Z';
  const collect = await refreshHubProviders(db, { fetcher, now: started, run: 'resumable', pages: 1, applyBatches: 1, batchModels: 1 });
  assert.deepEqual([collect.complete, collect.phase, collect.collectedPages, collect.stagedModels, collect.models, collect.error], [false, 'collect', 1, 1, 0, null]);
  assert.deepEqual(active(), ['person/a', 'person/b']);
  assert.deepEqual(prices(), ['person/a', 'person/a', 'person/b', 'person/b']);
  assert.equal(db.all('SELECT next_url FROM cat_hf_provider_crawl')[0]?.next_url, next);
  assert.equal(db.all("SELECT status FROM cat_runs WHERE id='resumable'")[0]?.status, 'running');

  const limited = await refreshHubProviders(db, { fetcher, now: '2026-10-03T00:00:00.000Z', pages: 1 });
  assert.equal(limited.rateLimited, true); assert.equal(limited.stagedModels, 1);
  assert.deepEqual(active(), ['person/a', 'person/b']);
  assert.equal(db.all('SELECT next_url FROM cat_hf_provider_crawl')[0]?.next_url, next);
  pages[next] = { body: [served('person/c')] };

  const apply1 = await refreshHubProviders(db, { fetcher, now: '2026-10-04T00:00:00.000Z', pages: 1, applyBatches: 1, batchModels: 1 });
  assert.deepEqual([apply1.complete, apply1.phase, apply1.collectedPages, apply1.appliedModels], [false, 'apply', 2, 1]);
  assert.equal(apply1.startedAt, started); assert.equal(apply1.run, 'resumable');
  assert.deepEqual(active(), ['person/a', 'person/b'], 'applying a must not withdraw another repository of the same author');
  assert.equal(db.all("SELECT payload FROM cat_hf_provider_stage WHERE id='person/a'")[0]?.payload, null, 'large applied payloads are released');
  const apply2 = await refreshHubProviders(db, { fetcher, now: '2026-10-05T00:00:00.000Z', pages: 1, applyBatches: 1, batchModels: 1 });
  assert.equal(apply2.complete, false); assert.equal(apply2.appliedModels, 2);
  assert.deepEqual(active(), ['person/a', 'person/b', 'person/c']);
  assert.equal(db.all("SELECT last_run FROM cat_sources WHERE id='huggingface-providers'")[0]?.last_run, 'seed', 'partial application is not a successful full refresh');
  const finish = await refreshHubProviders(db, { fetcher, now: '2026-10-06T00:00:00.000Z', applyBatches: 1, batchModels: 1 });
  assert.equal(finish.complete, true); assert.equal(finish.stats?.withdrawn, 1); assert.equal(finish.stats?.prices_closed, 2);
  assert.deepEqual(active(), ['person/a', 'person/c']);
  assert.deepEqual(prices(), ['person/a', 'person/a', 'person/c', 'person/c']);
  assert.deepEqual(seen, [hubProvidersURL, next, next], 'never refetch the start, and never fetch while applying');
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_provider_stage')[0]?.n, 0);
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_provider_crawl')[0]?.n, 0);
  assert.equal(db.all("SELECT last_seen FROM cat_listings WHERE provider_model_id='person/c'")[0]?.last_seen, started);
  assert.equal(db.all("SELECT withdrawn_at FROM cat_listings WHERE provider_model_id='person/b'")[0]?.withdrawn_at, started);
  assert.deepEqual(db.all("SELECT status,listings,withdrawn FROM cat_runs WHERE id='resumable'").map(r => Object.values(r)), [['ok', 2, 1]]);
});

test('application bounds raw metadata bytes as well as repository count without skipping the remaining staged rows', async () => {
  const db = d1(), rows = Array.from({ length: 6 }, (_, i) => served(`person/model-${i}`, 'conversational', { extraMetadata: 'x'.repeat(200_000) }));
  const first = await refreshHubProviders(db, { run: 'bytes', applyBatches: 1, fetcher: hub({ [hubProvidersURL]: { body: rows } }) });
  assert.equal(first.complete, false); assert.equal(first.phase, 'apply'); assert.equal(first.stagedModels, 6);
  assert.equal(first.appliedModels, 4, 'the 1 MB byte budget limits this batch before the 50-repository bound');
  const second = await refreshHubProviders(db, { applyBatches: 2, fetcher: async () => { throw new Error('must not refetch while applying'); } });
  assert.equal(second.complete, true); assert.equal(second.appliedModels, 6);
  assert.equal(db.all("SELECT count(*) n FROM cat_listings WHERE source='huggingface-providers' AND withdrawn_at IS NULL")[0]?.n, 6);
});

test('a globally collapsed completed feed is rejected before any bounded apply and a later healthy crawl can recover', async () => {
  const db = d1(), seed = Array.from({ length: 60 }, (_, i) => served(`person/model-${i}`));
  assert.equal((await refreshHubProviders(db, { now: '2026-10-01T00:00:00.000Z', run: 'healthy', fetcher: hub({ [hubProvidersURL]: { body: seed } }) })).complete, true);
  const before = ['cat_listings', 'cat_prices', 'cat_hf_models'].map(table => db.all(`SELECT * FROM ${table} ORDER BY 1,2,3`));
  const failed = await refreshHubProviders(db, { now: '2026-10-02T00:00:00.000Z', run: 'collapsed', applyBatches: 1, batchModels: 1,
    fetcher: hub({ [hubProvidersURL]: { body: [served('person/new')] } }) });
  assert.equal(failed.complete, false); assert.match(failed.error ?? '', /listings dropped from 60 to 1/); assert.equal(failed.appliedModels, 0);
  assert.deepEqual(['cat_listings', 'cat_prices', 'cat_hf_models'].map(table => db.all(`SELECT * FROM ${table} ORDER BY 1,2,3`)), before);
  assert.equal(db.all("SELECT last_run FROM cat_sources WHERE id='huggingface-providers'")[0]?.last_run, 'healthy');
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_provider_crawl')[0]?.n, 0, 'a rejected complete generation must not trap future refreshes');
  const recovered = await refreshHubProviders(db, { now: '2026-10-03T00:00:00.000Z', run: 'recovered', fetcher: hub({ [hubProvidersURL]: { body: seed } }) });
  assert.deepEqual([recovered.complete, recovered.stagedModels, recovered.appliedModels], [true, 60, 0], 'the recovered feed matches what was applied, so nothing is rewritten');
});

test('a globally healthy feed can shrink a greater-than-50-route exact repository batch below half', async () => {
  const db = d1(), many = (repo: string, n: number) => model(repo, { inferenceProviderMapping: Array.from({ length: n }, (_, i) => ({
    provider: `backend-${i}`, status: 'live', task: 'conversational', providerDetails: { pricing: { input: 0.42, output: 3 } },
  })) });
  const first = await refreshHubProviders(db, { now: '2026-10-01T00:00:00.000Z', run: 'many', batchModels: 1,
    fetcher: hub({ [hubProvidersURL]: { body: [many('person/a', 60), many('person/z', 60)] } }) });
  assert.equal(first.complete, true); assert.equal(first.appliedRoutes, 120);
  const second = await refreshHubProviders(db, { now: '2026-10-02T00:00:00.000Z', run: 'healthy-decline', batchModels: 1,
    fetcher: hub({ [hubProvidersURL]: { body: [many('person/a', 10), many('person/z', 60)] } }) });
  assert.equal(second.error, null, 'the global feed retains 70/120 routes, although the first exact batch retains only 10/60');
  assert.equal(second.complete, true); assert.equal(second.appliedRoutes, 10, 'unchanged person/z is not applied again');
  assert.equal(second.stats?.withdrawn, 50); assert.equal(second.stats?.prices_closed, 100);
  assert.deepEqual(db.all("SELECT provider_model_id,count(*) n FROM cat_listings WHERE source='huggingface-providers' AND withdrawn_at IS NULL GROUP BY provider_model_id ORDER BY provider_model_id").map(r => Object.values(r)), [['person/a', 10], ['person/z', 60]]);
});

test('a later crawl applies only new, changed, returning or long-unapplied repositories', async () => {
  const db = d1(), crawl = (now: string, body: unknown[]) => refreshHubProviders(db, { now, run: now, fetcher: hub({ [hubProvidersURL]: { body } }) });
  const row = (repo: string) => db.all(`SELECT * FROM cat_listings WHERE provider_model_id='${repo}'`);
  const changed = { lastModified: '2026-10-01T12:00:00Z' };
  await crawl('2026-10-01T00:00:00.000Z', [served('person/a'), served('person/b'), served('person/c')]);
  const a = row('person/a');
  const second = await crawl('2026-10-02T00:00:00.000Z', [served('person/a', 'conversational', { downloads: 999, likes: 50 }), served('person/b', 'conversational', changed), served('person/d')]);
  assert.deepEqual([second.complete, second.stagedModels, second.appliedModels], [true, 3, 2], 'only changed b and new d are applied');
  assert.deepEqual(row('person/a'), a, 'a popularity-only change rewrites nothing');
  assert.equal(row('person/b')[0]?.last_seen, '2026-10-02T00:00:00.000Z');
  assert.equal(row('person/c')[0]?.withdrawn_at, '2026-10-02T00:00:00.000Z');
  assert.equal(row('person/d')[0]?.withdrawn_at, null);
  const third = await crawl('2026-10-03T00:00:00.000Z', [served('person/a'), served('person/b', 'conversational', changed), served('person/c'), served('person/d')]);
  assert.equal(third.appliedModels, 1, 'only c, which returned unchanged, is applied');
  assert.equal(row('person/c')[0]?.withdrawn_at, null, 'a returning repository is restored even though its metadata is unchanged');
  const weekly = await crawl('2026-10-09T00:00:00.000Z', [served('person/a'), served('person/b', 'conversational', changed), served('person/c'), served('person/d')]);
  assert.equal(weekly.appliedModels, 1, `only a was last applied more than ${hubPolicy.providerReapplyDays} days ago; b exactly that long ago is still skipped`);
  assert.equal(row('person/a')[0]?.last_seen, '2026-10-09T00:00:00.000Z');
});

test('failed final cleanup cannot advance source freshness, and retry preserves final withdrawal counters', async () => {
  const db = d1();
  await refreshHubProviders(db, { now: '2026-10-01T00:00:00.000Z', run: 'seed', fetcher: hub({ [hubProvidersURL]: { body: [served('person/old')] } }) });
  let fail = true;
  const flaky = { batch: db.batch, prepare: (sql: string) => {
    const statement = db.prepare(sql);
    return sql === 'DELETE FROM cat_hf_provider_crawl' ? { ...statement, run: async () => {
      if (fail) { fail = false; throw new Error('final cleanup interrupted'); }
      return statement.run();
    } } : statement;
  } };
  const interrupted = await refreshHubProviders(flaky, { now: '2026-10-02T00:00:00.000Z', run: 'finalize', fetcher: hub({ [hubProvidersURL]: { body: [served('person/new')] } }) });
  assert.equal(interrupted.complete, false); assert.match(interrupted.error ?? '', /cleanup interrupted/);
  assert.equal(db.all("SELECT last_run FROM cat_sources WHERE id='huggingface-providers'")[0]?.last_run, 'seed');
  assert.equal(db.all('SELECT phase FROM cat_hf_provider_crawl')[0]?.phase, 'done');
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_provider_stage')[0]?.n, 1, 'transaction rollback retains finalization membership');
  const resumed = await refreshHubProviders(db, { now: '2026-10-03T00:00:00.000Z', fetcher: async () => { throw new Error('must not fetch during finalization'); } });
  assert.equal(resumed.complete, true); assert.equal(resumed.run, 'finalize'); assert.equal(resumed.appliedRoutes, 1);
  assert.deepEqual(db.all("SELECT status,listings,withdrawn,prices_closed FROM cat_runs WHERE id='finalize'").map(r => Object.values(r)), [['ok', 1, 1, 2]]);
  assert.equal(db.all("SELECT last_run FROM cat_sources WHERE id='huggingface-providers'")[0]?.last_run, 'finalize');
  assert.equal(db.all('SELECT count(*) n FROM cat_hf_provider_crawl')[0]?.n, 0);
});

test('oversized provider bodies are rejected with or without a Content-Length header', async t => {
  for (const declared of [true, false]) await t.test(declared ? 'declared size' : 'streamed size', async () => {
    const db = d1();
    const result = await refreshHubProviders(db, { fetcher: async () => new Response(' '.repeat(hubPolicy.providerPageBytes + 1), {
      headers: declared ? { 'content-length': String(hubPolicy.providerPageBytes + 1) } : {},
    }) });
    assert.equal(result.complete, false); assert.match(result.error ?? '', /too large/);
    assert.equal(db.all('SELECT count(*) n FROM cat_listings')[0]?.n, 0);
  });
});

test('provider repositories retain exact canonical links but never infer identities from matching slugs', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  await db.prepare("INSERT INTO cat_models (id,lab_id,name,type,basis,payload,payload_hash,first_seen,last_seen) VALUES ('reviewed/chat','reviewed','Chat','chat','reviewed-model','{}','h','t','t')").run();
  await db.prepare("INSERT INTO cat_listings (source,provider_id,provider_model_id,model_id,model_basis,hf_id,payload,payload_hash,first_seen,last_seen) VALUES ('reviewed','reviewed','chat','reviewed/chat','reviewed-route','person/reviewed-repo','{}','h','t','t')").run();
  const result = await refreshHubProviders(db, { fetcher: hub({ [hubProvidersURL]: { body: [served('person/reviewed-repo'), served('person/chat')] } }) });
  assert.equal(result.complete, true);
  assert.deepEqual(db.all("SELECT provider_model_id,model_id FROM cat_listings WHERE source='huggingface-providers' ORDER BY provider_model_id").map(r => Object.values(r)), [
    ['person/chat', null], ['person/reviewed-repo', 'reviewed/chat'],
  ]);
  assert.deepEqual(db.all('SELECT id,model_id FROM cat_hf_models ORDER BY id').map(r => Object.values(r)), [['person/chat', null], ['person/reviewed-repo', 'reviewed/chat']]);
  assert.deepEqual(db.all('SELECT id,basis FROM cat_models').map(r => Object.values(r)), [['reviewed/chat', 'reviewed-model']]);
  assert.equal(db.all('SELECT count(*) n FROM cat_listings WHERE source=?', providerSource)[0]?.n, 2);
});
