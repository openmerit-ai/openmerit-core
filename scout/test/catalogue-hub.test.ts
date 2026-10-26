import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCatalogueSchema } from '../catalogue-db.ts';
import { refreshHubOrgs, crawlHubModels, hubModelsURL } from '../catalogue-hub.ts';
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
