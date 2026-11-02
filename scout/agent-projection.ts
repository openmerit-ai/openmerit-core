// The Scout agent's catalogue for one published version. At publication the
// refresh copies every merged model of every kind (with its catalogue routes and
// unit prices), linked leaderboard and MTEB results, and a free-text index into
// tables keyed by the version, so the agent never reads the live cat_* tables,
// which change while a refresh runs. Embeddings of the same documents go to one
// shared Vectorize namespace addressed by content, so only new or changed texts are upserted.
import { catalogueDocuments, headlineRate, manifestBenchmarks, modelRecord, priceRate, units, type BoardRecord, type ModelRecord, type Rate } from './agent/catalogue.ts';
import { embeddingText, searchSchema, searchTable, type CatalogueDocument } from './agent/search.ts';
import { embeddingDimensions, embeddingModel } from './evidence-search.mjs';
import { digest } from './utils.mjs';

type Value = string | number | null;
type Json = Record<string, unknown>;
interface Statement { bind(...values: Value[]): Statement; run(): Promise<unknown>; all<Row>(): Promise<{ results: Row[] }> }
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> }
export interface VectorIndex {
  upsert(rows: Array<{ id: string; namespace: string; values: number[]; metadata: Record<string, string> }>): Promise<{ mutationId?: string }>;
  deleteByIds?(ids: string[]): Promise<unknown>;
}
export interface StageOptions {
  vectorize?: VectorIndex;
  // Embeds texts with the evidence embedding model; absent without OPENAI_API_KEY.
  embed?: (texts: string[]) => Promise<number[][]>;
  cache?: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<unknown> };
  // Versions that must survive pruning, such as the one currently published.
  keep?: string[];
  now?: string;
}
export interface AgentCatalogueSummary { version: string; models: number; boards: number; documents: number; vectors: string | null; embedded?: number; vectorError?: string }

export const agentSchema = [
  'CREATE TABLE IF NOT EXISTS scout_agent_versions (id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, models INTEGER NOT NULL, boards INTEGER NOT NULL, documents INTEGER NOT NULL, vectors TEXT, staged_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS scout_agent_models (version TEXT NOT NULL, id TEXT NOT NULL, kind TEXT, payload TEXT NOT NULL, PRIMARY KEY(version,id))',
  'CREATE TABLE IF NOT EXISTS scout_agent_boards (version TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(version,id))',
  searchSchema,
  // The vectors each version's search uses, in the shared namespace (stageVectors).
  'CREATE TABLE IF NOT EXISTS scout_agent_vectors (version TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(version,id))',
  'CREATE INDEX IF NOT EXISTS scout_agent_vectors_id ON scout_agent_vectors(id)',
];
const tables = ['scout_agent_models', 'scout_agent_boards', searchTable, 'scout_agent_vectors'];
export const agentNamespace = 'agent';
// Published versions kept besides the one being staged and any in `keep`.
const retained = 5;
// Catalogue routes listed per model: the cheapest in each unit, then the cheapest by token price.
const routeLimit = 16;

// Rows read from the live catalogue, once, while the refresh holds its lock.
export interface Sources {
  merged: Array<{ id: string; kind: string | null; name: string | null; release_date: string | null; open_weights: number | null; input_modalities: string | null; output_modalities: string | null; context: number | null; lab: string | null }>;
  // Release facts for Scout's chat records, as the agent read them before this projection.
  release: Array<{ id: string; release_date: string | null; open_weights: number | null }>;
  offerings: Array<{ provider_id: string; provider_model_id: string; model_id: string; provider: string | null; context: number | null; input_modalities: string | null; output_modalities: string | null; tool_call: number | null; structured_output: number | null }>;
  // Current base-tier prices, Models.dev first, then by source.
  prices: Array<{ provider_id: string; provider_model_id: string; kind: string; unit: string; amount: number }>;
  boards: Array<{ id: string; source: string; title: string; kind: string; metric: string; direction: string; url: string; published_at: string | null; version: string; checked_at: string }>;
  boardResults: Array<{ board: string; model: string; score: number; model_id: string | null }>;
  mteb: Array<{ name: string; version: string; description: string | null; task_types: string | null; checked_at: string }>;
  mtebResults: Array<{ benchmark: string; model: string; rank: number | null; score: number | null; model_id: string | null }>;
  // Exact Hugging Face repositories of merged models, for MTEB rows without a model_id link.
  repos: Array<{ repo: string; model_id: string }>;
}

export async function readSources(db: Database): Promise<Sources> {
  const all = async <T>(sql: string) => (await db.prepare(sql).all<T>()).results;
  const present = new Set((await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name));
  const mtebLinked = present.has('cat_mteb_results') && (await all<{ name: string }>("SELECT name FROM pragma_table_info('cat_mteb_results')")).some(c => c.name === 'model_id');
  const live = "(o.status IS NULL OR o.status<>'deprecated') AND o.model_id IN (SELECT id FROM cat_model_merged)";
  const [merged, release, offerings, prices, boards, boardResults, mteb, mtebResults, repos] = await Promise.all([
    all<Sources['merged'][number]>(`SELECT g.id,g.kind,g.name,coalesce(g.release_date,c.release_date) release_date,coalesce(g.open_weights,c.open_weights) open_weights,g.input_modalities,g.output_modalities,g.context,
      coalesce(p.name,c.lab_id) lab FROM cat_model_merged g LEFT JOIN cat_models c ON c.id=g.id LEFT JOIN cat_providers p ON p.source='modelsdev' AND p.id=c.lab_id ORDER BY g.id`),
    all<Sources['release'][number]>('SELECT c.id,coalesce(g.release_date,c.release_date) release_date,coalesce(g.open_weights,c.open_weights) open_weights FROM cat_models c LEFT JOIN cat_model_merged g ON g.id=c.id WHERE c.withdrawn_at IS NULL'),
    all<Sources['offerings'][number]>(`SELECT o.provider_id,o.provider_model_id,o.model_id,p.name provider,o.context,o.input_modalities,o.output_modalities,o.tool_call,o.structured_output
      FROM cat_offerings o LEFT JOIN cat_providers p ON p.source='modelsdev' AND p.id=o.provider_id WHERE ${live} ORDER BY o.model_id,o.provider_id,o.provider_model_id`),
    all<Sources['prices'][number]>(`SELECT x.provider_id,x.provider_model_id,x.kind,x.unit,x.amount FROM cat_prices x JOIN cat_offerings o ON o.provider_id=x.provider_id AND o.provider_model_id=x.provider_model_id
      WHERE x.valid_to IS NULL AND x.tier='' AND ${live} ORDER BY CASE x.source WHEN 'modelsdev' THEN 0 ELSE 1 END,x.source`),
    present.has('cat_boards') ? all<Sources['boards'][number]>('SELECT id,source,title,kind,metric,direction,url,published_at,version,checked_at FROM cat_boards ORDER BY id') : [],
    present.has('cat_boards') && present.has('cat_board_results') ? all<Sources['boardResults'][number]>('SELECT r.board,r.model,r.score,r.model_id FROM cat_board_results r JOIN cat_boards b ON b.id=r.board AND b.version=r.version') : [],
    present.has('cat_mteb_benchmarks') ? all<Sources['mteb'][number]>("SELECT name,version,json_extract(metadata,'$.description') description,json_extract(summary,'$.taskTypes') task_types,checked_at FROM cat_mteb_benchmarks ORDER BY name") : [],
    present.has('cat_mteb_benchmarks') && present.has('cat_mteb_results') ? all<Sources['mtebResults'][number]>(`SELECT r.benchmark,r.model,json_extract(r.payload,'$.rank') rank,json_extract(r.payload,'$.meanTask') score,${mtebLinked ? 'r.model_id' : 'NULL'} model_id
      FROM cat_mteb_results r JOIN cat_mteb_benchmarks b ON b.name=r.benchmark AND b.version=r.version`) : [],
    all<Sources['repos'][number]>("SELECT DISTINCT lower(o.hf_id) repo,o.model_id FROM cat_offerings o WHERE o.hf_id IS NOT NULL AND o.model_id IN (SELECT id FROM cat_model_merged)"),
  ]);
  // MTEB rows carry an explicit link once catalogue-mteb.ts records one; until then only exact identities link.
  return { merged, release, offerings, prices, boards, boardResults, mteb, mtebResults: mtebLinked ? mtebResults : mtebResults.map(r => ({ ...r, model_id: null })), repos };
}

const list = (v: string | null): string[] => { try { const x: unknown = JSON.parse(v ?? 'null'); return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []; } catch { return []; } };
const flag = (v: number | null) => v === null ? null : v === 1;
export const mtebURL = (name: string) => `https://mteb-leaderboard-backend.hf.space/v1/benchmarks/${encodeURIComponent(name)}/scores`;

// Every model of every kind with its published facts, plus leaderboard records. Pure: tests feed it rows.
export function agentRows(src: Sources, scoutPayloads: readonly Json[]): { payloads: Json[]; boards: BoardRecord[]; records: ModelRecord[] } {
  // One rate per route, unit and price kind; the first source in preference order wins.
  const rates = new Map<string, Rate[]>();
  for (const p of src.prices) {
    const r = priceRate(p.unit, p.kind, p.amount), key = `${p.provider_id}|${p.provider_model_id}`, have = rates.get(key) ?? [];
    if (r && !have.some(x => x.unit === r.unit && x.kind === r.kind)) { have.push(r); rates.set(key, have); }
  }
  const routes = new Map<string, Json[]>();
  for (const o of src.offerings) {
    // A route listing only zero prices (a local runtime or a free tier) is not a price.
    const own = rates.get(`${o.provider_id}|${o.provider_model_id}`); if (!own?.length || own.every(r => r.amount === 0)) continue;
    const list_ = routes.get(o.model_id) ?? [];
    list_.push({ id: `catalogue:${o.provider_id}:${o.provider_model_id}`, provider: o.provider ?? o.provider_id, modelId: o.provider_model_id, rates: own, context: o.context,
      modalities: list(o.input_modalities), outputModalities: list(o.output_modalities), parameters: [o.tool_call === 1 && 'tools', o.structured_output === 1 && 'structured_outputs'].filter(Boolean) });
    routes.set(o.model_id, list_);
  }
  const routesOf = (id: string) => {
    const all = routes.get(id) ?? [], token = (r: Json) => headlineRate(r.rates as Rate[], 'token') ?? Infinity;
    const picked = new Set<Json>();
    for (const u of units) { let best: Json | null = null; for (const r of all) { const v = headlineRate(r.rates as Rate[], u); if (v !== null && (!best || v < (headlineRate(best.rates as Rate[], u) ?? Infinity))) best = r; } if (best) picked.add(best); }
    for (const r of [...all].sort((a, b) => token(a) - token(b))) { if (picked.size >= routeLimit) break; picked.add(r); }
    return [...picked].sort((a, b) => token(a) - token(b) || String(a.id).localeCompare(String(b.id)));
  };

  const merged = new Map(src.merged.map(m => [m.id, m]));
  // Leaderboard ranks are among every result on the board version, ties sharing a rank.
  const results = new Map<string, Array<{ board: string; score: number | null; rank: number; of: number; observedAt: string | null }>>();
  const add = (model: string, r: { board: string; score: number | null; rank: number; of: number; observedAt: string | null }) => {
    const own = results.get(model) ?? [], old = own.find(x => x.board === r.board);
    if (!old) own.push(r); else if (r.rank < old.rank) Object.assign(old, r);
    results.set(model, own);
  };
  const linked = new Map<string, Set<string>>();
  const link = (board: string, model: string) => linked.set(board, (linked.get(board) ?? new Set()).add(model));
  const boardMeta = new Map(src.boards.map(b => [b.id, b]));
  const byBoard = new Map<string, Sources['boardResults']>();
  for (const r of src.boardResults) byBoard.set(r.board, [...byBoard.get(r.board) ?? [], r]);
  for (const [board, rows] of byBoard) {
    const lower = boardMeta.get(board)?.direction === 'lower', date = boardMeta.get(board)?.published_at ?? boardMeta.get(board)?.checked_at ?? null;
    for (const r of rows) {
      if (!r.model_id || !merged.has(r.model_id)) continue;
      const rank = 1 + rows.filter(o => lower ? o.score < r.score : o.score > r.score).length;
      add(r.model_id, { board, score: r.score, rank, of: rows.length, observedAt: date }); link(board, r.model_id);
    }
  }
  // MTEB: an explicit model_id, else a model name that is exactly one embedding model's ID or Hugging Face repository.
  const identities = new Map<string, Set<string>>();
  const identity = (key: string, id: string) => { const m = merged.get(id); if (m && (m.kind === 'embedding' || m.kind === null)) identities.set(key, (identities.get(key) ?? new Set()).add(id)); };
  for (const m of src.merged) identity(m.id.toLowerCase(), m.id);
  for (const r of src.repos) identity(r.repo, r.model_id);
  const mtebMeta = new Map(src.mteb.map(b => [b.name, b])), counts = new Map<string, number>();
  for (const r of src.mtebResults) counts.set(r.benchmark, (counts.get(r.benchmark) ?? 0) + 1);
  for (const r of src.mtebResults) {
    const hits = r.model_id ? new Set([r.model_id]) : identities.get(r.model.toLowerCase()), [id] = hits?.size === 1 ? [...hits] : [];
    if (!id || !merged.has(id) || typeof r.rank !== 'number') continue;
    const board = `mteb:${r.benchmark}`;
    add(id, { board, score: typeof r.score === 'number' ? r.score : null, rank: r.rank, of: counts.get(r.benchmark) ?? 0, observedAt: mtebMeta.get(r.benchmark)?.checked_at.slice(0, 10) ?? null }); link(board, id);
  }
  const boards: BoardRecord[] = [
    ...src.boards.map(b => ({ id: b.id, title: b.title, kind: b.kind, metric: b.metric, direction: b.direction === 'lower' ? 'lower' as const : 'higher' as const, url: b.url, source: b.source,
      version: b.version, publishedAt: b.published_at?.slice(0, 10) ?? null, checkedAt: b.checked_at.slice(0, 10), results: byBoard.get(b.id)?.length ?? 0, linked: linked.get(b.id)?.size ?? 0, description: '' })),
    ...src.mteb.map(b => ({ id: `mteb:${b.name}`, title: `MTEB · ${b.name}`, kind: 'embedding', metric: 'Mean (Task)', direction: 'higher' as const, url: mtebURL(b.name), source: `mteb:${b.name}`,
      version: b.version, publishedAt: null, checkedAt: b.checked_at.slice(0, 10), results: counts.get(b.name) ?? 0, linked: linked.get(`mteb:${b.name}`)?.size ?? 0,
      description: [b.description, list(b.task_types).length ? `Task types: ${list(b.task_types).join(', ')}.` : ''].filter(Boolean).join(' ').slice(0, 600) })),
  ];

  const release = new Map(src.release.map(r => [r.id, r])), payloads: Json[] = [], records: ModelRecord[] = [], scoutIds = new Set<string>();
  for (const raw of scoutPayloads) {
    const id = typeof raw.id === 'string' ? raw.id : null; if (!id || scoutIds.has(id)) continue;
    scoutIds.add(id);
    // Scout's records are chat models unless the merged catalogue says otherwise; other kinds also list their catalogue routes.
    const kind = merged.get(id)?.kind ?? 'chat', r = release.get(id) ?? merged.get(id);
    const payload: Json = { id, kind, releaseDate: r?.release_date ?? null, openWeights: flag(r?.open_weights ?? null), boards: results.get(id) ?? [], ...(kind !== 'chat' ? { endpoints: routesOf(id) } : {}) };
    const record = modelRecord(raw, { date: r?.release_date?.slice(0, 10) ?? null, openWeights: flag(r?.open_weights ?? null), kind, boards: payload.boards, endpoints: payload.endpoints });
    if (record) { payloads.push(payload); records.push(record); }
  }
  for (const m of src.merged) {
    if (scoutIds.has(m.id)) continue;
    const payload: Json = { id: m.id, name: m.name ?? m.id, provider: m.lab ?? m.id.split('/')[0] ?? m.id, kind: m.kind, releaseDate: m.release_date, openWeights: flag(m.open_weights), context: m.context,
      modalities: list(m.input_modalities), outputModalities: list(m.output_modalities), endpoints: routesOf(m.id), boards: results.get(m.id) ?? [] };
    const record = modelRecord(payload, { date: m.release_date?.slice(0, 10) ?? null, openWeights: flag(m.open_weights), kind: m.kind, boards: payload.boards });
    if (record) { payloads.push(payload); records.push(record); }
  }
  return { payloads, boards, records };
}

const chunks = <T>(rows: readonly T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
async function pool<T, R>(rows: readonly T[], count: number, fn: (row: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(rows.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, rows.length) }, async () => { while (next < rows.length) { const i = next++; out[i] = await fn(rows[i] as T); } }));
  return out;
}

// Embeds and upserts each document once per content. A vector's ID hashes the document's
// type, ID and embedded text (which names its kind), so a vector some version already
// references is reused as is; only the rest are embedded (cached in R2 by a hash of model,
// dimensions and text, the evidence index's scheme) and upserted. Returns how many texts
// were embedded and how many vectors upserted.
export async function stageVectors(vectorize: VectorIndex, db: Database, version: string, documents: readonly CatalogueDocument[], options: Required<Pick<StageOptions, 'embed'>> & Pick<StageOptions, 'cache'>) {
  const namespace = agentNamespace;
  const texts = documents.map(embeddingText), hashes = await Promise.all(texts.map(t => digest([embeddingModel, embeddingDimensions, t]) as Promise<string>));
  const ids = await Promise.all(documents.map((d, i) => digest([namespace, d.type, d.id, hashes[i]]) as Promise<string>));
  const present = new Set<string>();
  for (const batch of chunks(ids, 500)) for (const r of (await db.prepare('SELECT DISTINCT id FROM scout_agent_vectors WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(batch)).all<{ id: string }>()).results) present.add(r.id);
  const todo = ids.flatMap((id, i) => present.has(id) ? [] : [i]);
  const key = (hash: string) => `semantic/embeddings/${hash}.json`;
  const values = new Map<number, number[]>();
  await pool(todo, 12, async i => { const v = await options.cache?.get(key(hashes[i] ?? '')); if (Array.isArray(v) && v.length === embeddingDimensions) values.set(i, v as number[]); });
  const missing = todo.filter(i => !values.has(i));
  for (const batch of chunks(missing, 64)) {
    const vectors = await options.embed(batch.map(i => texts[i] ?? ''));
    await pool(batch, 12, async i => { const v = vectors[batch.indexOf(i)]; if (!v) throw new Error('Incomplete embeddings.'); values.set(i, v); await options.cache?.put(key(hashes[i] ?? ''), v); });
  }
  const rows = todo.map(i => { const d = documents[i] as CatalogueDocument; return { id: ids[i] ?? '', namespace, values: values.get(i) ?? [], metadata: { type: d.type, id: d.id, ...(d.kind ? { kind: d.kind } : {}) } }; });
  let mutationId: string | undefined;
  for (const batch of chunks(rows, 500)) mutationId = (await vectorize.upsert(batch)).mutationId ?? mutationId;
  // References are written after the upsert, so a version never claims a vector that was not sent.
  const refs = documents.map((d, i) => ({ id: ids[i], type: d.type, doc: d.id }));
  await db.batch(chunks(refs, 200).map(batch => db.prepare("INSERT OR IGNORE INTO scout_agent_vectors (version,id,type,doc) SELECT ?1,json_extract(value,'$.id'),json_extract(value,'$.type'),json_extract(value,'$.doc') FROM json_each(?2)").bind(version, JSON.stringify(batch))));
  return { namespace, embedded: missing.length, upserted: rows.length, mutationId };
}

// Stages the agent catalogue for `version`. Idempotent: a ready version is
// returned as is, and a retried partial stage starts over.
export async function stageAgentCatalogue(db: Database, version: string, manifest: Json, scoutPayloads: readonly Json[], options: StageOptions = {}): Promise<AgentCatalogueSummary> {
  await db.batch(agentSchema.map(sql => db.prepare(sql)));
  const done = (await db.prepare('SELECT models,boards,documents,vectors FROM scout_agent_versions WHERE id=?1 AND ready=1').bind(version).all<{ models: number; boards: number; documents: number; vectors: string | null }>()).results[0];
  if (done) return { version, ...done };
  const { payloads, boards, records } = agentRows(await readSources(db), scoutPayloads);
  const documents = catalogueDocuments(records, manifestBenchmarks(manifest, records), boards);
  await db.batch([...tables.map(t => db.prepare(`DELETE FROM ${t} WHERE version=?1`).bind(version)),
    db.prepare('INSERT OR REPLACE INTO scout_agent_versions (id,ready,models,boards,documents,vectors,staged_at) VALUES (?1,0,?2,?3,?4,NULL,?5)').bind(version, payloads.length, boards.length, documents.length, options.now ?? new Date().toISOString())]);
  const writes = [
    ...chunks(payloads, 40).map(rows => db.prepare("INSERT INTO scout_agent_models (version,id,kind,payload) SELECT ?1,json_extract(value,'$.id'),json_extract(value,'$.kind'),value FROM json_each(?2)").bind(version, JSON.stringify(rows))),
    ...chunks(boards, 40).map(rows => db.prepare("INSERT INTO scout_agent_boards (version,id,payload) SELECT ?1,json_extract(value,'$.id'),value FROM json_each(?2)").bind(version, JSON.stringify(rows))),
    ...chunks(documents, 100).map(rows => db.prepare(`INSERT INTO ${searchTable} (version,type,id,kind,name,aliases,description) SELECT ?1,json_extract(value,'$.type'),json_extract(value,'$.id'),json_extract(value,'$.kind'),
      json_extract(value,'$.name'),json_extract(value,'$.aliases'),json_extract(value,'$.description') FROM json_each(?2)`).bind(version, JSON.stringify(rows))),
  ];
  for (const batch of chunks(writes, 20)) await db.batch(batch);
  const count = (await db.prepare(`SELECT (SELECT count(*) FROM scout_agent_models WHERE version=?1) models,(SELECT count(*) FROM scout_agent_boards WHERE version=?1) boards,(SELECT count(*) FROM ${searchTable} WHERE version=?1) documents`).bind(version)
    .all<{ models: number; boards: number; documents: number }>()).results[0];
  if (count?.models !== payloads.length || count.boards !== boards.length || count.documents !== documents.length) throw new Error('Incomplete agent catalogue projection.');
  // Vectors are optional: without them search_catalogue says so and uses keywords only.
  let vectors: string | null = null, embedded: number | undefined, vectorError: string | undefined;
  if (options.vectorize && options.embed) {
    try { const staged = await stageVectors(options.vectorize, db, version, documents, { embed: options.embed, ...(options.cache ? { cache: options.cache } : {}) }); vectors = staged.namespace; embedded = staged.embedded; }
    catch (error) { vectorError = String((error as Error).message).slice(0, 200); }
  }
  // Older generations go; their rows are derived and rebuilt by any later publication.
  const keep = [version, ...options.keep ?? []];
  const old = (await db.prepare(`SELECT id FROM scout_agent_versions WHERE id NOT IN (SELECT value FROM json_each(?1)) ORDER BY staged_at DESC LIMIT -1 OFFSET ${retained}`).bind(JSON.stringify(keep)).all<{ id: string }>()).results.map(r => r.id);
  // Their vectors go too: shared vectors no remaining version references, and the whole
  // namespace of a version staged before the shared one (agent-<version>, by the IDs it was given).
  // If deletion fails the versions stay, so the next publication tries again.
  let pruned = old;
  if (old.length && options.vectorize?.deleteByIds) try {
    const list = JSON.stringify(old);
    const shared = (await db.prepare('SELECT DISTINCT id FROM scout_agent_vectors WHERE version IN (SELECT value FROM json_each(?1)) AND id NOT IN (SELECT id FROM scout_agent_vectors WHERE version NOT IN (SELECT value FROM json_each(?1)))').bind(list).all<{ id: string }>()).results.map(r => r.id);
    const docs = (await db.prepare(`SELECT s.version,s.type,s.id FROM ${searchTable} s JOIN scout_agent_versions v ON v.id=s.version AND v.vectors LIKE 'agent-%' WHERE s.version IN (SELECT value FROM json_each(?1))`).bind(list)
      .all<{ version: string; type: string; id: string }>()).results;
    const ids = [...shared, ...await Promise.all(docs.map(d => digest([`agent-${d.version}`, d.type, d.id]) as Promise<string>))];
    for (const batch of chunks(ids, 500)) await options.vectorize.deleteByIds(batch);
  } catch { pruned = []; }
  if (pruned.length) await db.batch([...tables.map(t => db.prepare(`DELETE FROM ${t} WHERE version IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(pruned))),
    db.prepare('DELETE FROM scout_agent_versions WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(pruned))]);
  await db.prepare('UPDATE scout_agent_versions SET ready=1,vectors=?2 WHERE id=?1').bind(version, vectors).run();
  return { version, models: payloads.length, boards: boards.length, documents: documents.length, vectors, ...(embedded !== undefined ? { embedded } : {}), ...(vectorError ? { vectorError } : {}) };
}
