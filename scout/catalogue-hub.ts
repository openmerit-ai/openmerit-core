// Hugging Face Hub organisations and every model they publish, crawled in
// bounded parts across refreshes. An organisation is admitted when the Hub
// verifies it, or when a catalogue source names it as a model's Hugging Face
// home (some major labs, such as Qwen, are not verified). Live Hub inference
// routes become `huggingface:<backend>` listings with their prices.
import {
  type Backbone, type Database, type Listing, type Parsed, type Price, type Row, type StoreStats,
  ensureCatalogueSchema, storeCatalogue, loadBackbone, resolveListings, chunked, pick, extract, updates, digest, isObject, obj, text, int, date, id, money, num,
} from './catalogue-db.ts';
import { reviewedRoutes } from './catalogue-identities.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface HubOptions { fetcher?: Fetcher; token?: string; now?: string; run?: string }

export const hubPolicy = {
  // Requests per run stay far below the Hub's 1,000 per 5 minutes and the Worker subrequest limit.
  overviewsPerRun: 400, pagesPerRun: 250, recheckDays: 7, recrawlDays: 7, concurrency: 6,
  providerPagesPerRun: 4, providerPageBytes: 4_000_000, providerRowBytes: 250_000, providerApplyBatches: 4, providerBatchModels: 50, providerApplyBytes: 1_000_000,
  // Discovery proposes organisations from the most-downloaded models; only verified ones are admitted.
  discovery: ['text-generation', 'image-text-to-text', 'text-to-image'],
};
const API = 'https://huggingface.co/api';
const admitted = 'is_org=1 AND (verified=1 OR referenced=1)';
const owner = (repo: string): string => repo.split('/')[0] ?? repo;
const daysAgo = (now: string, days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

function hub(fetcher: Fetcher, token: string | undefined) {
  return async (url: string): Promise<Response> => {
    const target = new URL(url);
    if (target.origin !== 'https://huggingface.co' || target.username || target.password) throw new Error('Untrusted Hugging Face URL.');
    const headers: Record<string, string> = { 'User-Agent': 'OpenMerit-Scout/0.1 (+https://openmerit.ai/scout)' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Workers support only follow and manual; a redirect must not forward the token.
    const response = await fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Hugging Face redirected; not followed.'); }
    if (response.status === 429) { await response.body?.cancel(); throw new RateLimited(); }
    return response;
  };
}
class RateLimited extends Error { constructor() { super('Hugging Face rate limit reached.'); } }

async function concurrent<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await task(items[i] as T); } }));
  return out;
}

async function recordRun(db: Database, source: string, run: string, now: string): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO cat_sources (id,name,url,license,role) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,license=excluded.license,role=excluded.role')
      .bind(source, 'Hugging Face Hub API', 'https://huggingface.co/api/models', 'Public API; Hugging Face terms of service. Model licences per repository.',
        'Organisations, open-weight models, licences, lineage and live inference routes'),
    db.prepare("INSERT OR REPLACE INTO cat_runs (id,source,started_at,status) VALUES (?1,?2,?3,'running')").bind(run, source, now),
  ]);
}
async function finishRun(db: Database, source: string, run: string, now: string, stats: StoreStats | null, error: string | null): Promise<void> {
  if (error) { await db.prepare("UPDATE cat_runs SET finished_at=?2,status='failed',error=?3 WHERE id=?1").bind(run, new Date().toISOString(), error.slice(0, 300)).run(); return; }
  await db.batch([
    db.prepare("UPDATE cat_runs SET finished_at=?2,status='ok',listings=?3,added=?4,changed=?5,withdrawn=?6,unresolved=?7,prices_opened=?8,prices_closed=?9 WHERE id=?1")
      .bind(run, new Date().toISOString(), stats?.listings ?? 0, stats?.added ?? 0, stats?.changed ?? 0, stats?.withdrawn ?? 0, stats?.unresolved ?? 0, stats?.prices_opened ?? 0, stats?.prices_closed ?? 0),
    db.prepare('UPDATE cat_sources SET last_success_at=?2,last_run=?3 WHERE id=?1').bind(source, now, run),
  ]);
}

export interface OrgResult { candidates: number; checked: number; verified: number; admitted: number; rateLimited: boolean }
// Refreshes which organisations exist and are admitted. Overviews are checked
// oldest first, at most `limit` per run, and again after `recheckDays`.
export async function refreshHubOrgs(db: Database, options: HubOptions & { limit?: number } = {}): Promise<OrgResult> {
  const { fetcher = fetch, token, now = new Date().toISOString(), limit = hubPolicy.overviewsPerRun } = options, get = hub(fetcher, token);
  await ensureCatalogueSchema(db);
  // Provider discovery is not evidence for admitting an organisation's entire repository collection.
  const referenced = (await db.prepare(`SELECT DISTINCT substr(hf_id,1,instr(hf_id,'/')-1) name FROM cat_listings WHERE hf_id LIKE '_%/_%' AND withdrawn_at IS NULL AND source!='huggingface-providers'
    UNION SELECT DISTINCT hf_developer FROM cat_source_models WHERE hf_developer IS NOT NULL AND withdrawn_at IS NULL`).all<{ name: string }>()).results.map(r => r.name).filter(n => /^[\w.-]+$/.test(n));
  const discovered = new Set<string>(); let rateLimited = false;
  for (const pipeline of hubPolicy.discovery) {
    try {
      const response = await get(`${API}/models?pipeline_tag=${pipeline}&sort=downloads&direction=-1&limit=1000`);
      const rows: unknown = response.ok ? await response.json() : [];
      for (const m of Array.isArray(rows) ? rows : []) { const repo = id(obj(m).id); if (repo?.includes('/')) discovered.add(owner(repo)); }
    } catch (error) { if (error instanceof RateLimited) { rateLimited = true; break; } }
  }
  const candidates = [...new Set([...referenced, ...discovered])];
  await db.prepare('UPDATE cat_hf_orgs SET referenced=0').run();
  await chunked(db, `INSERT INTO cat_hf_orgs (name,referenced,discovered,first_seen,last_seen) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),?1,?1 FROM json_each(?2) WHERE true
    ON CONFLICT(name) DO UPDATE SET referenced=excluded.referenced,discovered=max(discovered,excluded.discovered),last_seen=excluded.last_seen`,
    candidates.map(n => [n, Number(referenced.includes(n)), Number(discovered.has(n))]), [now]);
  // Referenced organisations are checked first: they can be admitted unverified.
  const due = rateLimited ? [] : (await db.prepare('SELECT name FROM cat_hf_orgs WHERE checked_at IS NULL OR checked_at<?1 ORDER BY referenced DESC,checked_at IS NOT NULL,checked_at,name LIMIT ?2')
    .bind(daysAgo(now, hubPolicy.recheckDays), limit).all<{ name: string }>()).results.map(r => r.name);
  const checked = await concurrent(due, hubPolicy.concurrency, async name => {
    if (rateLimited) return null;
    try {
      const response = await get(`${API}/organizations/${encodeURIComponent(name)}/overview`);
      // A user account or a deleted organisation has no organisation overview.
      if (response.status === 404) return [name, null, 0, 0, null, null];
      if (!response.ok) return null;
      const o = obj(await response.json());
      return [name, text(o.fullname), 1, o.isVerified === true ? 1 : 0, text(o.plan), int(o.numModels) ?? 0];
    } catch (error) { if (error instanceof RateLimited) rateLimited = true; return null; }
  });
  const rows = checked.filter((r): r is Array<string | number | null> => r !== null);
  await chunked(db, `UPDATE cat_hf_orgs SET full_name=json_extract(v.value,'$[1]'),is_org=json_extract(v.value,'$[2]'),verified=json_extract(v.value,'$[3]'),plan=json_extract(v.value,'$[4]'),num_models=json_extract(v.value,'$[5]'),checked_at=?1
    FROM json_each(?2) v WHERE cat_hf_orgs.name=json_extract(v.value,'$[0]')`, rows, [now]);
  const counts = (await db.prepare(`SELECT count(*) candidates,sum(verified=1) verified,sum(${admitted}) admitted FROM cat_hf_orgs`)
    .all<{ candidates: number; verified: number | null; admitted: number | null }>()).results[0];
  return { candidates: counts?.candidates ?? 0, checked: rows.length, verified: counts?.verified ?? 0, admitted: counts?.admitted ?? 0, rateLimited };
}

export interface HubModel {
  id: string; author: string; pipeline_tag: string | null; library: string | null; created_at: string | null; last_modified: string | null; downloads: number | null; likes: number | null;
  license: string | null; gated: string | null; parameters: number | null; base_models: string | null; relation: string | null; arxiv: string | null; tags: string | null; routes: number;
}
const hubFields = ['pipeline_tag', 'createdAt', 'lastModified', 'downloads', 'likes', 'library_name', 'tags', 'gated', 'safetensors', 'inferenceProviderMapping'];
export const hubModelsURL = (author: string) => `${API}/models?author=${encodeURIComponent(author)}&limit=1000&${hubFields.map(f => `expand[]=${f}`).join('&')}`;
export const hubProvidersURL = `${API}/models?inference_provider=all&limit=500&${hubFields.map(f => `expand[]=${f}`).join('&')}`;
const count = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? Math.round(n) : null; };

// Task names establish only these modalities. A conversational route alone does
// not establish vision/audio support; an explicit pipeline tag can establish vision.
const hubTasks: Record<string, { type: string; input: string[]; output: string[] }> = {
  conversational: { type: 'chat', input: ['text'], output: ['text'] },
  'text-generation': { type: 'completion', input: ['text'], output: ['text'] },
  'image-text-to-text': { type: 'chat', input: ['text', 'image'], output: ['text'] },
  'feature-extraction': { type: 'embedding', input: ['text'], output: ['embedding'] },
  'sentence-similarity': { type: 'embedding', input: ['text'], output: ['embedding'] },
  'text-ranking': { type: 'rerank', input: ['text'], output: ['ranking'] },
  'text-to-image': { type: 'text-to-image', input: ['text'], output: ['image'] },
  'image-to-image': { type: 'image-to-image', input: ['image'], output: ['image'] },
  'text-to-video': { type: 'text-to-video', input: ['text'], output: ['video'] },
  'image-to-video': { type: 'image-to-video', input: ['image'], output: ['video'] },
  'text-to-speech': { type: 'text-to-speech', input: ['text'], output: ['audio'] },
  'text-to-audio': { type: 'text-to-audio', input: ['text'], output: ['audio'] },
  'automatic-speech-recognition': { type: 'automatic-speech-recognition', input: ['audio'], output: ['text'] },
};

// Parses one page of an organisation's models. Tags carry licence, lineage
// (base_model:<relation>:<repo>) and papers; private or disabled repos are skipped.
export function parseHubPage(rows: unknown, author?: string): { models: HubModel[]; listings: Listing[] } {
  if (!Array.isArray(rows)) throw new Error('Hugging Face models format changed.');
  const models: HubModel[] = [], listings: Listing[] = [];
  for (const value of rows) {
    const m = obj(value), repo = id(m.id);
    if (!repo || !repo.includes('/') || author !== undefined && owner(repo) !== author || m.private === true || m.disabled === true) continue;
    const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
    const lineage = tags.filter(t => t.startsWith('base_model:')).map(t => t.split(':')), relation = lineage.find(p => p.length === 3)?.[1] ?? null;
    const bases = [...new Set(lineage.map(p => p.at(-1)).filter((b): b is string => !!b && b.includes('/')))];
    const arxiv = tags.filter(t => t.startsWith('arxiv:')).map(t => t.slice(6));
    const routes = (Array.isArray(m.inferenceProviderMapping) ? m.inferenceProviderMapping : []).map(obj).filter(r => r.status === 'live' && id(r.provider));
    models.push({ id: repo, author: owner(repo), pipeline_tag: text(m.pipeline_tag), library: text(m.library_name), created_at: date(m.createdAt), last_modified: date(m.lastModified),
      downloads: count(m.downloads), likes: count(m.likes), license: tags.find(t => t.startsWith('license:'))?.slice(8) ?? null, gated: m.gated === false ? 'no' : text(m.gated),
      parameters: count(obj(m.safetensors).total), base_models: bases.length ? JSON.stringify(bases) : null, relation, arxiv: arxiv.length ? JSON.stringify(arxiv) : null,
      tags: JSON.stringify(tags.filter(t => !t.startsWith('region:')).slice(0, 60)), routes: routes.length });
    for (const r of routes) {
      const details = obj(r.providerDetails), pricing = obj(details.pricing), features = obj(r.features), prices: Price[] = [];
      const task = text(r.task), shape = hubTasks[task ?? ''];
      // The Hub's conversational/text-generation rates are USD per million
      // tokens. Media, compute and other task prices have no established unit here.
      if (task === 'conversational' || task === 'text-generation' || task === 'image-text-to-text') {
        for (const kind of ['input', 'output'] as const) { const amount = num(pricing[kind]); if (amount !== null && amount >= 0) { const usd = money(amount); if (usd !== null) prices.push({ kind, tier: '', unit: 'usd_per_mtok', amount: usd }); } }
      }
      const input = task === 'conversational' && m.pipeline_tag === 'image-text-to-text' ? ['text', 'image'] : shape?.input;
      const tool = features.toolCalling, structured = features.structuredOutput;
      listings.push({ provider_id: `huggingface:${String(r.provider)}`, provider_model_id: repo, model_id: null, model_basis: null, hf_id: repo, name: null, family: null, type: shape?.type ?? task, status: 'live',
        release_date: null, knowledge: null, deprecated_at: null, context: int(details.context_length), max_input: null, max_output: null, input_modalities: input ? JSON.stringify(input) : null, output_modalities: shape ? JSON.stringify(shape.output) : null,
        reasoning: null, tool_call: typeof tool === 'boolean' ? Number(tool) : null, structured_output: typeof structured === 'boolean' ? Number(structured) : null, attachment: null,
        open_weights: 1, prices, payload: { ...r, model: repo } });
    }
  }
  return { models, listings };
}
const nextPage = (link: string | null): string | null => link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

const hubModelColumns = ['id', 'author', 'pipeline_tag', 'library', 'created_at', 'last_modified', 'downloads', 'likes', 'license', 'gated', 'parameters', 'base_models', 'relation', 'arxiv', 'tags', 'routes',
  'model_id', 'model_basis', 'payload_hash'];
async function storeHubModels(db: Database, models: HubModel[], authors: string[], now: string, links: ReadonlyMap<string, string>): Promise<void> {
  const rows: Row[] = [];
  for (const m of models) {
    const linked = links.get(m.id) ?? null;
    // Popularity counts change every day; they are stored but do not count as a change.
    const { downloads: _d, likes: _l, ...stable } = m;
    rows.push({ ...pick(hubModelColumns, { ...m, model_id: linked, model_basis: linked ? 'catalogue-hf-id' : null }), payload_hash: await digest([stable, linked]) });
  }
  await chunked(db, `INSERT INTO cat_hf_models (${hubModelColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ${extract(hubModelColumns)},?1,?1,NULL FROM json_each(?2) WHERE true
    ON CONFLICT(id) DO UPDATE SET ${updates(hubModelColumns, ['id'])},last_seen=excluded.last_seen,withdrawn_at=NULL`, rows, [now], 100);
  await db.prepare('UPDATE cat_hf_models SET withdrawn_at=?1 WHERE last_seen<?1 AND withdrawn_at IS NULL AND author IN (SELECT value FROM json_each(?2))').bind(now, JSON.stringify(authors)).run();
}

export interface CrawlResult { organisations: number; failed: number; pages: number; models: number; routes: number; rateLimited: boolean; stats: StoreStats | null }
// Crawls admitted organisations not crawled within `recrawlDays`, oldest first,
// within a page budget. Each organisation is stored whole or not at all, so a
// failed or rate-limited crawl never withdraws its models or routes.
export async function crawlHubModels(db: Database, options: HubOptions & { pages?: number; batch?: number } = {}): Promise<CrawlResult> {
  const { fetcher = fetch, token, now = new Date().toISOString(), pages: budget = hubPolicy.pagesPerRun, batch = 12 } = options, run = options.run ?? `huggingface-${now}`, get = hub(fetcher, token);
  await ensureCatalogueSchema(db);
  await recordRun(db, 'huggingface', run, now);
  const due = (await db.prepare(`SELECT name,coalesce(num_models,0) n FROM cat_hf_orgs WHERE ${admitted} AND (crawled_at IS NULL OR crawled_at<?1) ORDER BY crawled_at IS NOT NULL,crawled_at,n,name`)
    .bind(daysAgo(now, hubPolicy.recrawlDays)).all<{ name: string; n: number }>()).results;
  const plan: string[] = []; let planned = 0;
  for (const o of due) { const cost = Math.max(1, Math.ceil(o.n / 1000)); if (planned + cost > budget && plan.length) break; plan.push(o.name); planned += cost; }
  const links = new Map((await db.prepare("SELECT hf_id,min(model_id) model_id FROM cat_listings WHERE hf_id IS NOT NULL AND model_id IS NOT NULL AND withdrawn_at IS NULL GROUP BY hf_id HAVING count(DISTINCT model_id)=1")
    .all<{ hf_id: string; model_id: string }>()).results.map(r => [r.hf_id, r.model_id]));
  const backbone = await loadBackbone(db);
  const result: CrawlResult = { organisations: 0, failed: 0, pages: 0, models: 0, routes: 0, rateLimited: false, stats: null };
  const add = (a: StoreStats | null, b: StoreStats): StoreStats => a ? { listings: a.listings + b.listings, added: a.added + b.added, changed: a.changed + b.changed, withdrawn: a.withdrawn + b.withdrawn,
    unresolved: a.unresolved + b.unresolved, prices_opened: a.prices_opened + b.prices_opened, prices_closed: a.prices_closed + b.prices_closed } : b;
  try {
    for (let i = 0; i < plan.length && !result.rateLimited; i += batch) {
      const crawled = await concurrent(plan.slice(i, i + batch), hubPolicy.concurrency, async author => {
        const pages: Array<{ models: HubModel[]; listings: Listing[] }> = [];
        try {
          for (let url: string | null = hubModelsURL(author); url && !result.rateLimited;) {
            const response = await get(url); result.pages++;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            pages.push(parseHubPage(await response.json(), author)); url = nextPage(response.headers.get('link'));
          }
          return result.rateLimited ? { author, error: 'rate limited' } : { author, models: pages.flatMap(p => p.models), listings: pages.flatMap(p => p.listings) };
        } catch (error) {
          if (error instanceof RateLimited) result.rateLimited = true;
          return { author, error: String(error instanceof Error ? error.message : error) };
        }
      });
      const done = crawled.filter((c): c is { author: string; models: HubModel[]; listings: Listing[] } => 'models' in c), authors = done.map(c => c.author);
      if (authors.length) {
        const models = done.flatMap(c => c.models), parsed: Parsed = { providers: [...new Set(done.flatMap(c => c.listings.map(l => l.provider_id)))]
          .map(p => ({ id: p, name: `${p.slice('huggingface:'.length)} via Hugging Face Inference`, api: 'https://router.huggingface.co/v1', doc: 'https://huggingface.co/docs/inference-providers', npm: null, env: null })),
          // A repository another source already links to a model starts linked; Models.dev routes still take precedence.
          listings: done.flatMap(c => c.listings).map(l => { const linked = links.get(l.provider_model_id); return linked ? { ...l, model_id: linked, model_basis: 'catalogue-hf-id' } : l; }), models: [] };
        await storeHubModels(db, models, authors, now, links);
        result.stats = add(result.stats, await storeCatalogue(db, 'huggingface', { ...parsed, listings: resolveListings(parsed.listings, backbone, { slugs: false }) }, { now, run, scope: authors }));
        result.models += models.length; result.routes += parsed.listings.length;
      }
      const marks = crawled.map(c => 'models' in c ? [c.author, 'ok', null, c.models.length] : [c.author, 'failed', c.error, null]);
      await chunked(db, `UPDATE cat_hf_orgs SET crawled_at=CASE json_extract(v.value,'$[1]') WHEN 'ok' THEN ?1 ELSE crawled_at END,crawl_status=json_extract(v.value,'$[1]'),crawl_error=json_extract(v.value,'$[2]'),
        models=coalesce(json_extract(v.value,'$[3]'),models) FROM json_each(?2) v WHERE cat_hf_orgs.name=json_extract(v.value,'$[0]')`, marks, [now]);
      result.organisations += authors.length; result.failed += crawled.length - authors.length;
    }
    await finishRun(db, 'huggingface', run, now, result.stats, null);
  } catch (error) {
    await finishRun(db, 'huggingface', run, now, null, String(error instanceof Error ? error.message : error));
    throw error;
  }
  return result;
}

// List responses (unlike individual model-info responses) expose provider
// mappings as arrays. Verified against the live Hub API, including its absolute
// Link rel="next" cursor URLs; no task or author filter belongs on this feed.
function providerNextPage(link: string | null): string | null {
  if (!link) return null;
  let next: string | null = null;
  for (const part of link.split(/,(?=\s*<)/)) {
    const match = part.trim().match(/^<([^>]+)>\s*;(.*)$/);
    const rel = match?.[2]?.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if (!match || !rel) throw new Error('Invalid Hugging Face pagination Link.');
    if (!(rel[1] ?? rel[2] ?? '').split(/\s+/).includes('next')) continue;
    if (next) throw new Error('Ambiguous Hugging Face pagination Link.');
    const url = new URL(match[1] ?? '');
    if (url.origin !== 'https://huggingface.co' || url.pathname !== '/api/models' || url.username || url.password || url.hash || url.searchParams.get('inference_provider') !== 'all'
      || url.searchParams.getAll('inference_provider').length !== 1
      || [...url.searchParams.keys()].some(key => !['inference_provider', 'limit', 'cursor', 'expand', 'expand[]'].includes(key))) throw new Error('Untrusted Hugging Face provider pagination URL.');
    next = url.href;
  }
  return next;
}

async function providerPage(response: Response, maxBytes: number): Promise<{ rows: unknown[]; bytes: number }> {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Hugging Face provider response too large.'); }
  if (!response.body) throw new Error('Empty Hugging Face provider response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Hugging Face provider response too large.');
      body += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const rows: unknown = JSON.parse(body + decoder.decode());
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Hugging Face provider models format changed.');
  for (const value of rows) {
    const row = obj(value), repo = id(row.id), mappings = row.inferenceProviderMapping;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Array.isArray(mappings)
      || mappings.some(r => !isObject(r) || !id(r.provider) || !text(r.status))) throw new Error('Hugging Face provider mapping format changed.');
    if (new TextEncoder().encode(JSON.stringify(row)).byteLength > hubPolicy.providerRowBytes) throw new Error('Hugging Face provider repository metadata too large.');
  }
  return { rows, bytes };
}

type ProviderPhase = 'collect' | 'apply' | 'done';
interface ProviderCrawl { started_at: string; run: string; next_url: string | null; phase: ProviderPhase; cursor: string; pages: number; models: number; routes: number; stats: string }
const emptyStats = (): StoreStats => ({ listings: 0, added: 0, changed: 0, withdrawn: 0, unresolved: 0, prices_opened: 0, prices_closed: 0 });
const addStats = (a: StoreStats, b: StoreStats): StoreStats => ({ listings: a.listings + b.listings, added: a.added + b.added, changed: a.changed + b.changed,
  withdrawn: a.withdrawn + b.withdrawn, unresolved: a.unresolved + b.unresolved, prices_opened: a.prices_opened + b.prices_opened, prices_closed: a.prices_closed + b.prices_closed });
const providerCrawl = async (db: Database): Promise<ProviderCrawl | undefined> => (await db.prepare('SELECT * FROM cat_hf_provider_crawl WHERE id=1').all<ProviderCrawl>()).results[0];

// Restrict identity lookup to this repository batch. loadBackbone's global HF
// repository index is deliberately NOT used: it grows with the entire feed.
async function providerBackbone(db: Database, repositories: string[]): Promise<Backbone> {
  const repos = JSON.stringify(repositories), lower = JSON.stringify(repositories.map(r => r.toLowerCase()));
  const routes = (await db.prepare("SELECT provider_id,provider_model_id,model_id FROM cat_listings WHERE source='modelsdev' AND withdrawn_at IS NULL AND provider_model_id IN (SELECT value FROM json_each(?1))")
    .bind(repos).all<{ provider_id: string; provider_model_id: string; model_id: string | null }>()).results;
  const links = (await db.prepare('SELECT DISTINCT lower(hf_id) repo,model_id FROM cat_listings WHERE withdrawn_at IS NULL AND model_id IS NOT NULL AND lower(hf_id) IN (SELECT value FROM json_each(?1))')
    .bind(lower).all<{ repo: string; model_id: string }>()).results;
  const reviewed = reviewedRoutes.filter(r => repositories.includes(r.route)).map(r => r.model);
  const models = (await db.prepare(`SELECT id,weights FROM cat_models WHERE withdrawn_at IS NULL AND (id IN (SELECT value FROM json_each(?1))
    OR EXISTS (SELECT 1 FROM json_each(?2) r WHERE instr(lower(coalesce(weights,'')),'https://huggingface.co/'||r.value)>0))`)
    .bind(JSON.stringify([...repositories, ...reviewed, ...routes.flatMap(r => r.model_id ? [r.model_id] : [])]), lower).all<{ id: string; weights: string | null }>()).results;
  const weights = models.flatMap(m => [...(m.weights ?? '').matchAll(/https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/g)].map(([, repo]) => ({ repo: (repo ?? '').toLowerCase(), model_id: m.id })));
  return { routes, models: new Set(models.map(m => m.id)), repos: [...links, ...weights] };
}

export interface HubProvidersResult {
  complete: boolean; phase: ProviderPhase; run: string; startedAt: string;
  // Per-invocation work, followed by durable crawl-wide progress.
  pages: number; models: number; routes: number; collectedPages: number; stagedModels: number; appliedModels: number; appliedRoutes: number;
  rateLimited: boolean; error: string | null; stats: StoreStats | null;
}
// Collection and application have separate durable cursors. No active coverage
// changes during collection; after collection, exact repository batches can be
// replaced independently. Only the final transaction withdraws missing repos.
// The pipeline's publication lock must serialize calls sharing this database.
export async function refreshHubProviders(db: Database, options: HubOptions & { pages?: number; applyBatches?: number; batchModels?: number } = {}): Promise<HubProvidersResult> {
  const { fetcher = fetch, token, now = new Date().toISOString() } = options, source = 'huggingface-providers', get = hub(fetcher, token);
  const bound = (n: number, max: number) => Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0;
  const pages = bound(options.pages ?? hubPolicy.providerPagesPerRun, 100), batches = bound(options.applyBatches ?? hubPolicy.providerApplyBatches, 20);
  const batchModels = Math.max(1, bound(options.batchModels ?? hubPolicy.providerBatchModels, hubPolicy.providerBatchModels));
  await ensureCatalogueSchema(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS cat_hf_provider_crawl (id INTEGER PRIMARY KEY CHECK(id=1),started_at TEXT NOT NULL,run TEXT NOT NULL,next_url TEXT,phase TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',pages INTEGER NOT NULL DEFAULT 0,models INTEGER NOT NULL DEFAULT 0,routes INTEGER NOT NULL DEFAULT 0,stats TEXT NOT NULL)"),
    db.prepare('CREATE TABLE IF NOT EXISTS cat_hf_provider_stage (id TEXT PRIMARY KEY,payload TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS cat_hf_provider_pages (url TEXT PRIMARY KEY)'),
  ]);
  let crawl = await providerCrawl(db);
  if (!crawl) {
    const run = options.run ?? `huggingface-providers-${now}`;
    await recordRun(db, source, run, now);
    await db.prepare("INSERT INTO cat_hf_provider_crawl (id,started_at,run,next_url,phase,stats) VALUES (1,?1,?2,?3,'collect',?4)").bind(now, run, hubProvidersURL, JSON.stringify(emptyStats())).run();
    crawl = await providerCrawl(db);
  }
  if (!crawl) throw new Error('Missing Hugging Face provider crawl state.');
  const result: HubProvidersResult = { complete: false, phase: crawl.phase, run: crawl.run, startedAt: crawl.started_at, pages: 0, models: 0, routes: 0,
    collectedPages: crawl.pages, stagedModels: 0, appliedModels: crawl.models, appliedRoutes: crawl.routes, rateLimited: false, error: null, stats: null };
  try {
    await db.prepare("UPDATE cat_runs SET status='running',error=NULL,finished_at=NULL WHERE id=?1").bind(crawl.run).run();
    while (crawl.phase === 'collect' && result.pages < pages) {
      const url = crawl.next_url;
      if (!url) throw new Error('Missing Hugging Face provider cursor.');
      // Validate persisted cursors as well as freshly received Links.
      providerNextPage(`<${url}>; rel="next"`);
      const response = await get(url); result.pages++;
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Hugging Face provider HTTP ${response.status}.`); }
      const page = await providerPage(response, hubPolicy.providerPageBytes), next = providerNextPage(response.headers.get('link'));
      if (next === url || next && (await db.prepare('SELECT url FROM cat_hf_provider_pages WHERE url=?1').bind(next).all()).results.length) throw new Error('Hugging Face provider pagination cycle.');
      // A page and its continuation commit together. Retrying an interrupted
      // request cannot skip a repository or leave a cursor ahead of its data.
      await db.batch([
        ...page.rows.map(row => db.prepare('INSERT INTO cat_hf_provider_stage (id,payload) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(String(obj(row).id), JSON.stringify(row))),
        db.prepare('INSERT INTO cat_hf_provider_pages (url) VALUES (?1)').bind(url),
        db.prepare('UPDATE cat_hf_provider_crawl SET next_url=?1,phase=?2,pages=pages+1 WHERE id=1').bind(next, next ? 'collect' : 'apply'),
      ]);
      crawl.next_url = next; crawl.phase = next ? 'collect' : 'apply'; crawl.pages++;
    }
    if (crawl.phase === 'apply' && !crawl.cursor) {
      // Check the WHOLE completed feed before any repository replacement. An
      // exact-model store cannot detect source-wide collapse from one batch.
      const active = (await db.prepare("SELECT count(*) n FROM cat_listings WHERE source='huggingface-providers' AND withdrawn_at IS NULL").all<{ n: number }>()).results[0]?.n ?? 0;
      const staged = (await db.prepare(`SELECT count(*) n FROM (SELECT s.id,json_extract(r.value,'$.provider') provider FROM cat_hf_provider_stage s,json_each(s.payload,'$.inferenceProviderMapping') r
        WHERE json_extract(r.value,'$.status')='live' AND coalesce(json_extract(s.payload,'$.private'),0)!=1 AND coalesce(json_extract(s.payload,'$.disabled'),0)!=1 GROUP BY s.id,provider)`)
        .all<{ n: number }>()).results[0]?.n ?? 0;
      if (active > 50 && staged < active * .5) {
        // Discard only the rejected staging generation. The next invocation
        // can fetch a repaired feed instead of retrying a frozen bad snapshot.
        await db.batch([db.prepare('DELETE FROM cat_hf_provider_stage'), db.prepare('DELETE FROM cat_hf_provider_pages'), db.prepare('DELETE FROM cat_hf_provider_crawl')]);
        throw new Error(`${source} listings dropped from ${active} to ${staged}; previous rows retained.`);
      }
    }
    for (let i = 0; crawl.phase === 'apply' && i < batches; i++) {
      const rows = (await db.prepare(`WITH candidates AS (SELECT id,payload FROM cat_hf_provider_stage WHERE id>?1 ORDER BY id LIMIT ?2)
        SELECT id,payload FROM (SELECT id,payload,sum(length(CAST(payload AS BLOB))) OVER (ORDER BY id) bytes FROM candidates) WHERE bytes<=?3 ORDER BY id`)
        .bind(crawl.cursor, batchModels, hubPolicy.providerApplyBytes).all<{ id: string; payload: string }>()).results;
      if (!rows.length) { crawl.phase = 'done'; await db.prepare("UPDATE cat_hf_provider_crawl SET phase='done' WHERE id=1").run(); break; }
      const repos = rows.map(r => r.id), parsedPage = parseHubPage(rows.map(r => JSON.parse(r.payload) as unknown));
      const listings = resolveListings(parsedPage.listings, await providerBackbone(db, repos), { slugs: false });
      const parsed: Parsed = { models: [], listings, providers: [...new Set(listings.map(l => l.provider_id))].map(p => ({
        id: p, name: `${p.slice('huggingface:'.length)} via Hugging Face Inference`, api: 'https://router.huggingface.co/v1', doc: 'https://huggingface.co/docs/inference-providers', npm: null, env: null,
      })) };
      const stats = await storeCatalogue(db, source, parsed, { now: crawl.started_at, run: crawl.run, scope: repos, scopeKind: 'models' });
      const identities = new Map<string, Set<string>>();
      for (const l of listings) if (l.model_id) { const ids = identities.get(l.provider_model_id) ?? new Set<string>(); ids.add(l.model_id); identities.set(l.provider_model_id, ids); }
      const links = new Map<string, string>();
      for (const [repo, ids] of identities) { const [model] = ids; if (ids.size === 1 && model) links.set(repo, model); }
      await storeHubModels(db, parsedPage.models, [], crawl.started_at, links);
      const total = addStats(JSON.parse(crawl.stats) as StoreStats, stats), cursor = repos.at(-1) ?? crawl.cursor;
      await db.batch([
        // Release large raw payloads as each batch is applied, retaining only
        // repository membership for final cleanup. A crashed batch is replayable.
        db.prepare('UPDATE cat_hf_provider_stage SET payload=NULL WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(repos)),
        db.prepare('UPDATE cat_hf_provider_crawl SET cursor=?1,models=models+?2,routes=routes+?3,stats=?4 WHERE id=1').bind(cursor, parsedPage.models.length, listings.length, JSON.stringify(total)),
      ]);
      crawl.cursor = cursor; crawl.models += parsedPage.models.length; crawl.routes += listings.length; crawl.stats = JSON.stringify(total);
      result.models += parsedPage.models.length; result.routes += listings.length; result.stats = addStats(result.stats ?? emptyStats(), stats);
    }
    if (crawl.phase === 'done') {
      const missing = "source='huggingface-providers' AND withdrawn_at IS NULL AND NOT EXISTS (SELECT 1 FROM cat_hf_provider_stage s WHERE s.id=cat_listings.provider_model_id)";
      const unpriced = "source='huggingface-providers' AND valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM cat_hf_provider_stage s WHERE s.id=cat_prices.provider_model_id)";
      // Persist final counters and withdrawals atomically, so finalization can
      // be repeated after interruption without losing or duplicating counts.
      await db.batch([
        db.prepare(`UPDATE cat_hf_provider_crawl SET stats=json_set(stats,'$.withdrawn',json_extract(stats,'$.withdrawn')+(SELECT count(*) FROM cat_listings WHERE ${missing}),
          '$.prices_closed',json_extract(stats,'$.prices_closed')+(SELECT count(*) FROM cat_prices WHERE ${unpriced})) WHERE id=1`),
        db.prepare(`UPDATE cat_listings SET withdrawn_at=?1 WHERE ${missing}`).bind(crawl.started_at),
        db.prepare(`UPDATE cat_prices SET valid_to=?1 WHERE ${unpriced}`).bind(crawl.started_at),
      ]);
      const finished = await providerCrawl(db);
      if (!finished) throw new Error('Missing completed provider crawl.');
      const total = JSON.parse(finished.stats) as StoreStats, prior = JSON.parse(crawl.stats) as StoreStats;
      result.stats = addStats(result.stats ?? emptyStats(), { ...emptyStats(), withdrawn: total.withdrawn - prior.withdrawn, prices_closed: total.prices_closed - prior.prices_closed });
      result.stagedModels = (await db.prepare('SELECT count(*) n FROM cat_hf_provider_stage').all<{ n: number }>()).results[0]?.n ?? 0;
      // Success publication and disposal of the resumable state must commit
      // together. Failed cleanup cannot advance source freshness or lose the
      // durable final counters; retrying phase=done is safe.
      await db.batch([
        db.prepare("UPDATE cat_runs SET finished_at=?2,status='ok',error=NULL,listings=?3,added=?4,changed=?5,withdrawn=?6,unresolved=?7,prices_opened=?8,prices_closed=?9 WHERE id=?1")
          .bind(crawl.run, new Date().toISOString(), total.listings, total.added, total.changed, total.withdrawn, total.unresolved, total.prices_opened, total.prices_closed),
        db.prepare('UPDATE cat_sources SET last_success_at=?2,last_run=?3 WHERE id=?1').bind(source, crawl.started_at, crawl.run),
        db.prepare('DELETE FROM cat_hf_provider_stage'), db.prepare('DELETE FROM cat_hf_provider_pages'), db.prepare('DELETE FROM cat_hf_provider_crawl'),
      ]);
      result.complete = true;
    }
  } catch (error) {
    result.rateLimited = error instanceof RateLimited;
    result.error = error instanceof Error ? error.message : String(error);
    await finishRun(db, source, crawl.run, crawl.started_at, null, result.error);
  }
  if (!result.complete) result.stagedModels = (await db.prepare('SELECT count(*) n FROM cat_hf_provider_stage').all<{ n: number }>()).results[0]?.n ?? 0;
  result.phase = crawl.phase; result.collectedPages = crawl.pages; result.appliedModels = crawl.models; result.appliedRoutes = crawl.routes;
  return result;
}
