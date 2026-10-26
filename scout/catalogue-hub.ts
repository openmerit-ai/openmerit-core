// Hugging Face Hub organisations and every model they publish, crawled in
// bounded parts across refreshes. An organisation is admitted when the Hub
// verifies it, or when a catalogue source names it as a model's Hugging Face
// home (some major labs, such as Qwen, are not verified). Live Hub inference
// routes become `huggingface:<backend>` listings with their prices.
import {
  type Database, type Listing, type Parsed, type Price, type Row, type Backbone, type StoreStats,
  ensureCatalogueSchema, storeCatalogue, chunked, pick, extract, updates, digest, isObject, obj, text, int, date, id, money, num,
} from './catalogue-db.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface HubOptions { fetcher?: Fetcher; token?: string; now?: string; run?: string }

export const hubPolicy = {
  // Requests per run stay far below the Hub's 1,000 per 5 minutes and the Worker subrequest limit.
  overviewsPerRun: 400, pagesPerRun: 250, recheckDays: 7, recrawlDays: 7, concurrency: 6,
  // Discovery proposes organisations from the most-downloaded models; only verified ones are admitted.
  discovery: ['text-generation', 'image-text-to-text', 'text-to-image'],
};
const API = 'https://huggingface.co/api';
const admitted = 'is_org=1 AND (verified=1 OR referenced=1)';
const owner = (repo: string): string => repo.split('/')[0] ?? repo;
const daysAgo = (now: string, days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

function hub(fetcher: Fetcher, token: string | undefined) {
  return async (url: string): Promise<Response> => {
    const headers: Record<string, string> = { 'User-Agent': 'OpenMerit-Scout/0.1 (+https://openmerit.ai/scout)' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 429) throw new RateLimited();
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
  const referenced = (await db.prepare(`SELECT DISTINCT substr(hf_id,1,instr(hf_id,'/')-1) name FROM cat_listings WHERE hf_id LIKE '_%/_%' AND withdrawn_at IS NULL
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
const count = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? Math.round(n) : null; };

// Parses one page of an organisation's models. Tags carry licence, lineage
// (base_model:<relation>:<repo>) and papers; private or disabled repos are skipped.
export function parseHubPage(rows: unknown, author: string): { models: HubModel[]; listings: Listing[] } {
  if (!Array.isArray(rows)) throw new Error('Hugging Face models format changed.');
  const models: HubModel[] = [], listings: Listing[] = [];
  for (const value of rows) {
    const m = obj(value), repo = id(m.id);
    if (!repo || owner(repo) !== author || m.private === true || m.disabled === true) continue;
    const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
    const lineage = tags.filter(t => t.startsWith('base_model:')).map(t => t.split(':')), relation = lineage.find(p => p.length === 3)?.[1] ?? null;
    const bases = [...new Set(lineage.map(p => p.at(-1)).filter((b): b is string => !!b && b.includes('/')))];
    const arxiv = tags.filter(t => t.startsWith('arxiv:')).map(t => t.slice(6));
    const routes = (Array.isArray(m.inferenceProviderMapping) ? m.inferenceProviderMapping : []).map(obj).filter(r => r.status === 'live' && id(r.provider));
    models.push({ id: repo, author, pipeline_tag: text(m.pipeline_tag), library: text(m.library_name), created_at: date(m.createdAt), last_modified: date(m.lastModified),
      downloads: count(m.downloads), likes: count(m.likes), license: tags.find(t => t.startsWith('license:'))?.slice(8) ?? null, gated: m.gated === false ? 'no' : text(m.gated),
      parameters: count(obj(m.safetensors).total), base_models: bases.length ? JSON.stringify(bases) : null, relation, arxiv: arxiv.length ? JSON.stringify(arxiv) : null,
      tags: JSON.stringify(tags.filter(t => !t.startsWith('region:')).slice(0, 60)), routes: routes.length });
    for (const r of routes) {
      const details = obj(r.providerDetails), pricing = obj(details.pricing), features = obj(r.features), prices: Price[] = [];
      for (const kind of ['input', 'output'] as const) { const amount = num(pricing[kind]); if (amount !== null && amount >= 0) { const usd = money(amount); if (usd !== null) prices.push({ kind, tier: '', unit: 'usd_per_mtok', amount: usd }); } }
      const tool = features.toolCalling, structured = features.structuredOutput;
      listings.push({ provider_id: `huggingface:${String(r.provider)}`, provider_model_id: repo, model_id: null, model_basis: null, hf_id: repo, name: null, family: null, type: text(r.task), status: 'live',
        release_date: null, knowledge: null, deprecated_at: null, context: int(details.context_length), max_input: null, max_output: null, input_modalities: null, output_modalities: null,
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
  const backbone: Backbone = { routes: (await db.prepare("SELECT provider_id,provider_model_id,model_id FROM cat_listings WHERE source='modelsdev' AND withdrawn_at IS NULL AND model_id IS NOT NULL")
    .all<{ provider_id: string; provider_model_id: string; model_id: string | null }>()).results, models: new Set((await db.prepare('SELECT id FROM cat_models WHERE withdrawn_at IS NULL').all<{ id: string }>()).results.map(r => r.id)) };
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
        result.stats = add(result.stats, await storeCatalogue(db, 'huggingface', parsed, { now, run, backbone, scope: authors }));
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
