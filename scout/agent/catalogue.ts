// The data the Scout agent's tools read, all from one published catalogue
// version: model records of every kind (identity, routes with unit-aware prices,
// reference timing, benchmark observations, leaderboard results), benchmark and
// leaderboard descriptions, and free-text search over them. Everything here is
// read-only; publication stays with the refresh (publish.ts writes the tables).
import { documentTypes, ftsSearch, kindTerms, memorySearch, reciprocalRankFusion, type CatalogueDocument, type DocumentType, type SearchField, type SearchHit, type SearchOptions } from './search.ts';

// What a model does (catalogue-db.ts modelKind). Unknown kinds stay null.
export const kinds = ['chat', 'embedding', 'rerank', 'image', 'video', 'speech', 'transcription', 'decision', 'ocr', 'moderation', '3d', 'music'] as const;
export type Kind = typeof kinds[number];

// Billing units. Token and character amounts are per million; the rest per unit.
export const units = ['token', 'image', 'second', 'character', 'page', 'request'] as const;
export type Unit = typeof units[number];
export const unitLabels: Record<Unit, string> = {
  token: 'USD per 1M tokens', image: 'USD per image', second: 'USD per second', character: 'USD per 1M characters', page: 'USD per page', request: 'USD per request',
};
// The unit a kind is usually billed in, for sorting by price when none is given.
export const kindUnits: Record<Kind, Unit> = {
  chat: 'token', embedding: 'token', rerank: 'token', decision: 'token', moderation: 'token',
  image: 'image', video: 'second', speech: 'character', transcription: 'second', ocr: 'page', music: 'second', '3d': 'request',
};
export interface Rate { unit: Unit; kind: string; amount: number }

export interface Endpoint {
  id: string; provider: string; modelId: string; inputPrice: number | null; outputPrice: number | null; rates: Rate[];
  context: number | null; inputs: string[]; outputs: string[]; parameters: string[]; deployment: string; url: string | null;
}
export interface Observation { benchmark: string; score: number; metric: string | null; observedAt: string | null; url: string | null }
// A published leaderboard result: rank among every result on that board version, in the board's direction.
export interface BoardResult { board: string; score: number | null; rank: number; of: number; observedAt: string | null }
export interface Speed { tokensPerSecond: number | null; timeToFirstToken: number | null; source: string | null; url: string | null }
export interface ModelRecord {
  id: string; name: string; provider: string; kind: string | null; releaseDate: string | null; openWeights: boolean | null;
  context: number | null; inputs: string[]; outputs: string[]; parameters: string[];
  endpoints: Endpoint[]; speed: Speed | null; evidence: Observation[]; boards: BoardResult[];
}
export interface BenchmarkRecord { id: string; name: string; tags: string[]; source: string; description: string; releaseDate: string | null; models: number }
// Media, speech, embedding and decision leaderboards, and MTEB benchmarks (IDs "mteb:<name>").
export interface BoardRecord {
  id: string; title: string; kind: string; metric: string; direction: 'higher' | 'lower'; url: string; source: string;
  version: string; publishedAt: string | null; checkedAt: string | null; results: number; linked: number; description: string;
}
export interface Catalogue {
  version: string;
  models: ModelRecord[];
  benchmarks: BenchmarkRecord[];
  boards: BoardRecord[];
  // Benchmark IDs nearest to a description of the work, best first.
  semanticBenchmarks(query: string, limit: number): Promise<string[]>;
  search: {
    // Keyword (BM25) hits over model, benchmark and board documents, best first.
    bm25(query: string, options: SearchOptions): Promise<SearchHit[]>;
    // Nearest documents by embedding, best first; throws with the reason when unavailable.
    embedding(query: string, options: SearchOptions): Promise<SearchHit[]>;
  };
}

// Hard constraints the agent applies through search and that submitted shortlists must satisfy.
export interface Filters {
  kind?: string; inputs?: string[]; outputs?: string[]; parameters?: string[]; providers?: string[]; excludeProviders?: string[];
  minContext?: number; maxInputPrice?: number; maxOutputPrice?: number; openWeights?: boolean; releasedAfter?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const day = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
const lower = (values: string[]) => values.map(v => v.toLowerCase());
// PDF and file inputs are both document inputs; providers spell them differently.
const modality = (v: string) => v === 'pdf' ? 'file' : v;
const isUnit = (v: unknown): v is Unit => typeof v === 'string' && (units as readonly string[]).includes(v);

// A catalogue price row (cat_prices unit and kind) as a rate, or null when it is
// not a model's own usage price: cache, reasoning and tool fees are left out.
const priceUnits: Record<string, Unit> = { usd_per_mtok: 'token', usd_per_image: 'image', usd_per_second: 'second', usd_per_mchar: 'character', usd_per_page: 'page', usd_per_request: 'request', usd_per_query: 'request' };
const tokenKinds = new Set(['input', 'output', 'input_audio', 'output_audio', 'input_image', 'output_image', 'input_video', 'output_video']);
export function priceRate(unit: string, kind: string, amount: number): Rate | null {
  const u = priceUnits[unit];
  if (!u || !Number.isFinite(amount) || amount < 0) return null;
  if (u === 'token' && !tokenKinds.has(kind) || unit === 'usd_per_query' && kind !== 'query' || u === 'second' && kind === 'compute') return null;
  return { unit: u, kind, amount };
}
function rate(raw: unknown): Rate | null {
  if (!isObject(raw) || !isUnit(raw.unit)) return null;
  const kind = str(raw.kind), amount = num(raw.amount);
  return kind && amount !== null && amount >= 0 ? { unit: raw.unit, kind, amount } : null;
}
const tokenRate = (rates: readonly Rate[], kind: string) => rates.find(r => r.unit === 'token' && r.kind === kind)?.amount ?? null;

function endpoint(raw: unknown): Endpoint | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id); if (!id) return null;
  const rates = (Array.isArray(raw.rates) ? raw.rates : []).map(rate).filter((r): r is Rate => r !== null);
  const listed = { input: num(raw.inputPrice), output: num(raw.outputPrice) };
  // Scout's reviewed chat routes always carry both token prices; catalogue routes carry rates.
  if (!Array.isArray(raw.rates) && (listed.input === null || listed.output === null)) return null;
  for (const kind of ['input', 'output'] as const) { const amount = listed[kind]; if (amount !== null && tokenRate(rates, kind) === null) rates.push({ unit: 'token', kind, amount }); }
  if (!rates.length) return null;
  return {
    id, provider: str(raw.provider) ?? 'unknown', modelId: str(raw.modelId) ?? id, inputPrice: tokenRate(rates, 'input'), outputPrice: tokenRate(rates, 'output'), rates, context: num(raw.context),
    inputs: lower(strings(raw.modalities)).map(modality), outputs: lower(strings(raw.outputModalities)), parameters: strings(raw.parameters),
    deployment: str(raw.deployment) ?? 'hosted', url: str(raw.url),
  };
}
function speed(raw: unknown): Speed | null {
  if (!isObject(raw)) return null;
  const tokensPerSecond = num(raw.tokensPerSecond), timeToFirstToken = num(raw.timeToFirstAnswer) ?? num(raw.timeToFirstToken);
  return tokensPerSecond === null && timeToFirstToken === null ? null : { tokensPerSecond, timeToFirstToken, source: str(raw.source), url: str(raw.url) };
}
function observation(raw: unknown): Observation | null {
  if (!isObject(raw)) return null;
  const benchmark = str(raw.benchmark), score = num(raw.score);
  return benchmark && score !== null ? { benchmark, score, metric: str(raw.metric), observedAt: day(raw.observedAt), url: str(raw.url) } : null;
}
function boardResult(raw: unknown): BoardResult | null {
  if (!isObject(raw)) return null;
  const board = str(raw.board), rank = num(raw.rank), of = num(raw.of);
  return board && rank !== null && of !== null ? { board, score: num(raw.score), rank, of, observedAt: day(raw.observedAt) } : null;
}
const unique = (values: string[]) => [...new Set(values)].sort();

// Published facts that override or extend a model record: release data, kind,
// leaderboard results and catalogue routes from the agent projection (publish.ts).
export interface RecordExtras { date?: string | null; openWeights?: boolean | null; kind?: string | null; boards?: unknown; endpoints?: unknown }

// One published model record (snapshot, D1 projection payload or agent projection payload) in the agent's shape.
export function modelRecord(raw: Json, extras: RecordExtras = {}): ModelRecord | null {
  const id = str(raw.id); if (!id) return null;
  const endpoints = (Array.isArray(raw.endpoints) ? raw.endpoints : []).map(endpoint).filter((e): e is Endpoint => e !== null);
  // Catalogue routes add unit prices to a reviewed route of the same provider and model ID, or list a new route.
  for (const extra of (Array.isArray(extras.endpoints) ? extras.endpoints : []).map(endpoint).filter((e): e is Endpoint => e !== null)) {
    const same = endpoints.find(e => e.provider.toLowerCase() === extra.provider.toLowerCase() && e.modelId === extra.modelId);
    if (same) same.rates.push(...extra.rates.filter(r => !same.rates.some(s => s.unit === r.unit && s.kind === r.kind)));
    else endpoints.push(extra);
  }
  const facts = Array.isArray(raw.facts) ? raw.facts.filter(isObject) : [];
  const fact = (field: string) => facts.find(f => f.field === field && f.value != null)?.value;
  const contexts = [num(raw.context), ...endpoints.map(e => e.context)].filter((c): c is number => c !== null);
  return {
    id, name: str(raw.name) ?? id, provider: str(raw.provider) ?? str(fact('creator')) ?? 'unknown',
    kind: extras.kind !== undefined ? extras.kind : str(raw.kind) ?? 'chat',
    releaseDate: extras.date ?? day(fact('releasedAt')), openWeights: extras.openWeights ?? null,
    context: contexts.length ? Math.max(...contexts) : null,
    inputs: unique([...lower(strings(raw.modalities)).map(modality), ...endpoints.flatMap(e => e.inputs)]),
    outputs: unique([...lower(strings(raw.outputModalities)), ...endpoints.flatMap(e => e.outputs)]),
    parameters: unique([...strings(raw.parameters), ...endpoints.flatMap(e => e.parameters)]),
    endpoints, speed: speed(raw.speed),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map(observation).filter((o): o is Observation => o !== null),
    boards: (Array.isArray(extras.boards) ? extras.boards : []).map(boardResult).filter((b): b is BoardResult => b !== null),
  };
}
export function boardRecord(raw: unknown): BoardRecord | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id), title = str(raw.title), kind = str(raw.kind), version = str(raw.version);
  if (!id || !title || !kind || !version) return null;
  return { id, title, kind, metric: str(raw.metric) ?? 'score', direction: raw.direction === 'lower' ? 'lower' : 'higher', url: str(raw.url) ?? '', source: str(raw.source) ?? '',
    version, publishedAt: day(raw.publishedAt), checkedAt: day(raw.checkedAt), results: num(raw.results) ?? 0, linked: num(raw.linked) ?? 0, description: str(raw.description) ?? '' };
}

// Prepared benchmark text is JSON written during refresh (evidence-search.mjs).
function description(text: unknown): string {
  if (typeof text !== 'string') return '';
  try {
    const doc: unknown = JSON.parse(text);
    if (!isObject(doc)) return '';
    const research = isObject(doc.research) ? doc.research : {}, definition = isObject(doc.definition) ? doc.definition : {};
    return (str(research.description) ?? str(definition.description) ?? '').replace(/\s+/g, ' ').slice(0, 400);
  } catch { return ''; }
}
export function benchmarkRecords(benchmarks: unknown[], models: ModelRecord[], descriptions: ReadonlyMap<string, string>): BenchmarkRecord[] {
  const counts = new Map<string, number>();
  for (const m of models) for (const id of new Set(m.evidence.map(e => e.benchmark))) counts.set(id, (counts.get(id) ?? 0) + 1);
  return benchmarks.filter(isObject).filter(b => !b.superseded && str(b.id)).map(b => {
    const id = str(b.id) ?? '', definition = isObject(b.definition) ? b.definition : {};
    return { id, name: str(b.name) ?? id, tags: strings(b.tags), source: str(b.source) ?? 'unknown', releaseDate: day(b.releaseDate), models: counts.get(id) ?? 0,
      description: descriptions.get(id) ?? (str(definition.description) ?? '').replace(/\s+/g, ' ').slice(0, 400) };
  }).filter(b => b.models > 0);
}
// The benchmarks of a published manifest, described by its evidence index. The
// publisher indexes exactly these, so search and the other tools agree.
export function manifestBenchmarks(manifest: Json, models: ModelRecord[]): BenchmarkRecord[] {
  const evidenceIndex = isObject(manifest.evidenceIndex) ? manifest.evidenceIndex : {};
  const documents = Array.isArray(evidenceIndex.documents) ? evidenceIndex.documents.filter(isObject) : [];
  const descriptions = new Map(documents.flatMap(d => { const id = str(d.id), text = description(d.text); return id && text ? [[id, text] as [string, string]] : []; }));
  return benchmarkRecords(Array.isArray(manifest.benchmarks) ? manifest.benchmarks : [], models, descriptions);
}

// Words shared between a query and a benchmark's name, tags and description.
// The lexical side of search; it also catches exact benchmark names vectors miss.
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? []);
export function lexicalBenchmarks(benchmarks: BenchmarkRecord[], query: string, limit: number): string[] {
  const q = words(query); if (!q.size) return [];
  return benchmarks.map(b => {
    const name = words(b.name), body = words(`${b.tags.join(' ')} ${b.description}`);
    let score = 0; for (const w of q) score += name.has(w) ? 3 : body.has(w) ? 1 : 0;
    return { id: b.id, score: score + Math.min(b.models, 50) / 1000 };
  }).filter(r => r.score >= 1).sort((a, b) => b.score - a.score).slice(0, limit).map(r => r.id);
}

// The searchable text of each model, benchmark and board. Prices, counts and ranks
// are left out so a document changes only when what it describes does.
export function catalogueDocuments(models: readonly ModelRecord[], benchmarks: readonly BenchmarkRecord[], boards: readonly BoardRecord[]): CatalogueDocument[] {
  return [
    ...models.map((m): CatalogueDocument => ({ type: 'model', id: m.id, kind: m.kind, name: m.name, aliases: `${m.id} ${m.provider}`,
      description: [m.kind && kindTerms[m.kind], m.inputs.length && `Inputs: ${m.inputs.join(', ')}.`, m.outputs.length && `Outputs: ${m.outputs.join(', ')}.`, m.openWeights && 'Open weights.'].filter(Boolean).join(' ') })),
    // Chat benchmarks measure chat models; generated capability tags are not words.
    ...benchmarks.map((b): CatalogueDocument => ({ type: 'benchmark', id: b.id, kind: 'chat', name: b.name, aliases: [b.id, ...b.tags.filter(t => !t.startsWith('cap_'))].join(' '), description: b.description })),
    ...boards.map((b): CatalogueDocument => ({ type: 'board', id: b.id, kind: b.kind, name: b.title, aliases: `${b.id} ${b.metric}`, description: `${kindTerms[b.kind] ?? b.kind}. ${b.description}`.trim() })),
  ];
}

// Local catalogue from a refresh snapshot (scout/snapshot.json): tests and offline use.
export function catalogueFromSnapshot(snapshot: Json, semantic?: Catalogue['semanticBenchmarks']): Catalogue {
  const measured = new Map((Array.isArray(snapshot.models) ? snapshot.models : []).filter(isObject).map(m => [m.id, m]));
  const identities = Array.isArray(snapshot.catalogue) ? snapshot.catalogue.filter(isObject) : [...measured.values()];
  const models = identities.map(m => { const x = measured.get(m.id); return modelRecord({ ...m, speed: m.speed ?? x?.speed, evidence: x?.evidence ?? [] }); }).filter((m): m is ModelRecord => m !== null);
  const descriptions = new Map(Object.entries(isObject(snapshot.benchmarkDescriptions) ? snapshot.benchmarkDescriptions : {}).flatMap(([k, v]) => isObject(v) && str(v.description) ? [[k, (str(v.description) ?? '').replace(/\s+/g, ' ').slice(0, 400)] as [string, string]] : []));
  const benchmarks = benchmarkRecords(Array.isArray(snapshot.benchmarks) ? snapshot.benchmarks : [], models, descriptions);
  const bm25 = memorySearch(catalogueDocuments(models, benchmarks, []));
  return { version: `snapshot-${str(snapshot.checkedAt) ?? 'local'}`, models, benchmarks, boards: [],
    semanticBenchmarks: semantic ?? (async (query, limit) => lexicalBenchmarks(benchmarks, query, limit)),
    search: { bm25: async (query, options) => bm25(query, options), embedding: async () => { throw new Error('Embedding search needs a published catalogue.'); } } };
}

// The subset of Worker bindings the hosted catalogue reads.
interface Statement { bind(...values: unknown[]): Statement; all<T>(): Promise<{ results: T[] }> }
export interface CatalogueBindings {
  SCOUT_CATALOGUE: { get(key: string): Promise<{ json<T>(): Promise<T> } | null> };
  SCOUT_INDEX: { prepare(sql: string): Statement };
  SCOUT_EVIDENCE: { query(vector: number[], options: { namespace?: string; topK: number; returnMetadata: 'all' }): Promise<{ matches: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }> }> };
  OPENAI_API_KEY?: string;
}
export type Embedder = (texts: string[], apiKey: string) => Promise<number[][]>;

// The agent projection a version was published with (publish.ts), or null for
// versions published before it, which fall back to the chat records alone.
async function agentProjection(env: CatalogueBindings, version: string) {
  let row: { vectors: string | null } | undefined;
  try { row = (await env.SCOUT_INDEX.prepare('SELECT vectors FROM scout_agent_versions WHERE id = ? AND ready = 1').bind(version).all<{ vectors: string | null }>()).results[0]; }
  catch { return null; }
  if (!row) return null;
  const [models, boards, vectors] = await Promise.all([
    env.SCOUT_INDEX.prepare('SELECT payload FROM scout_agent_models WHERE version = ?').bind(version).all<{ payload: string }>(),
    env.SCOUT_INDEX.prepare('SELECT payload FROM scout_agent_boards WHERE version = ?').bind(version).all<{ payload: string }>(),
    // The version's vectors in the shared namespace; versions with their own namespace have none listed.
    env.SCOUT_INDEX.prepare('SELECT id FROM scout_agent_vectors WHERE version = ?').bind(version).all<{ id: string }>().catch(() => ({ results: [] })),
  ]);
  const parse = (rows: Array<{ payload: string }>) => rows.map(r => JSON.parse(r.payload) as unknown).filter(isObject);
  return { namespace: row.vectors, vectorIds: new Set(vectors.results.map(r => r.id)), models: parse(models.results), boards: parse(boards.results).map(boardRecord).filter((b): b is BoardRecord => b !== null) };
}

// The published generation: active pointer → manifest in R2; chat records,
// every other model, leaderboards and the search index in D1, all for that version.
export async function loadCatalogue(env: CatalogueBindings, embed: Embedder): Promise<Catalogue> {
  const read = async <T>(key: string) => { const object = await env.SCOUT_CATALOGUE.get(key); return object ? object.json<T>() : null; };
  const pointer = await read<{ key: string }>('active.json');
  const manifest = pointer ? await read<Json>(pointer.key) : null;
  const publication = isObject(manifest?.publication) ? manifest.publication : {};
  const version = str(publication.id);
  if (!manifest || !version) throw new Error('No published Scout catalogue is available.');
  const [projection, scout] = await Promise.all([
    agentProjection(env, version),
    env.SCOUT_INDEX.prepare('SELECT id, payload FROM scout_models WHERE version = ?').bind(version).all<{ id: string; payload: string }>(),
  ]);
  const chat = new Map(scout.results.map(r => [r.id, JSON.parse(r.payload) as unknown]));
  let models: ModelRecord[];
  if (projection) {
    models = projection.models.flatMap(p => {
      const base = chat.get(str(p.id) ?? ''), m = modelRecord(isObject(base) ? base : p, { date: day(p.releaseDate), openWeights: typeof p.openWeights === 'boolean' ? p.openWeights : null,
        kind: str(p.kind), boards: p.boards, ...(isObject(base) ? { endpoints: p.endpoints } : {}) });
      return m ? [m] : [];
    });
  } else {
    // Before the agent projection: release dates from the source-backed catalogue in the same database.
    const release = new Map((await env.SCOUT_INDEX.prepare(`SELECT c.id, coalesce(g.release_date, c.release_date) release_date, coalesce(g.open_weights, c.open_weights) open_weights FROM cat_models c LEFT JOIN cat_model_merged g ON g.id = c.id
      WHERE c.withdrawn_at IS NULL AND c.id IN (SELECT id FROM scout_models WHERE version = ?)`).bind(version).all<{ id: string; release_date: string | null; open_weights: number | null }>()).results.map(r => [r.id, r]));
    models = [...chat].flatMap(([id, raw]) => {
      const r = release.get(id), m = isObject(raw) ? modelRecord(raw, { date: day(r?.release_date), openWeights: r?.open_weights == null ? null : r.open_weights === 1 }) : null;
      return m ? [m] : [];
    });
  }
  const benchmarks = manifestBenchmarks(manifest, models), boards = projection?.boards ?? [];
  const evidenceIndex = isObject(manifest.evidenceIndex) ? manifest.evidenceIndex : {};
  const known = new Set(benchmarks.map(b => b.id)), namespace = str(evidenceIndex.namespace) ?? str(evidenceIndex.version) ?? version;
  // A shared namespace also holds other versions' vectors; only this version's count.
  const evidenceVectors = new Set((Array.isArray(evidenceIndex.documents) ? evidenceIndex.documents : []).flatMap(d => isObject(d) && typeof d.vectorId === 'string' ? [d.vectorId] : []));
  const memory = projection ? null : memorySearch(catalogueDocuments(models, benchmarks, boards));
  const documents = new Map<string, string | null>([...models.map(m => [`model:${m.id}`, m.kind] as const), ...benchmarks.map(b => [`benchmark:${b.id}`, 'chat'] as const), ...boards.map(b => [`board:${b.id}`, b.kind] as const)]);
  return {
    version, models, benchmarks, boards,
    async semanticBenchmarks(query, limit) {
      const lexical = lexicalBenchmarks(benchmarks, query, limit);
      if (!env.OPENAI_API_KEY) return lexical;
      const [vector] = await embed([query], env.OPENAI_API_KEY);
      if (!vector) return lexical;
      const result = await env.SCOUT_EVIDENCE.query(vector, { namespace, topK: Math.min(50, limit * 2), returnMetadata: 'all' });
      const semantic = result.matches.flatMap(m => !evidenceVectors.size || evidenceVectors.has(m.id) ? [str(m.metadata?.benchmark)] : []).filter((id): id is string => !!id && known.has(id));
      // Exact names first (a user who names a benchmark means it), then nearest methodologies.
      return [...new Set([...lexical.slice(0, 3), ...semantic, ...lexical])].slice(0, limit);
    },
    search: {
      bm25: async (query, options) => memory ? memory(query, options) : ftsSearch(env.SCOUT_INDEX, version, query, options),
      async embedding(query, { types, kind, limit }) {
        if (!projection?.namespace) throw new Error('this catalogue version was published without catalogue embeddings');
        if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
        const [vector] = await embed([query], env.OPENAI_API_KEY);
        if (!vector) throw new Error('the embedding service returned no vector');
        const result = await env.SCOUT_EVIDENCE.query(vector, { namespace: projection.namespace, topK: 50, returnMetadata: 'all' });
        return result.matches.flatMap((m): SearchHit[] => {
          if (projection.vectorIds.size && !projection.vectorIds.has(m.id)) return [];
          const type = m.metadata?.type, id = str(m.metadata?.id);
          if (!id || !(documentTypes as readonly unknown[]).includes(type) || !documents.has(`${String(type)}:${id}`)) return [];
          const hitKind = documents.get(`${String(type)}:${id}`) ?? null;
          if (types?.length && !types.includes(type as DocumentType) || kind && hitKind !== kind) return [];
          return [{ type: type as DocumentType, id, kind: hitKind, score: m.score ?? 0, fields: ['meaning'] }];
        }).slice(0, limit);
      },
    },
  };
}

// ---- Prices ----

export const blendedPrice = (e: { inputPrice: number; outputPrice: number }) => (3 * e.inputPrice + e.outputPrice) / 4;
// One number per unit for comparing routes: tokens blend input and output 3:1;
// other units add the route's rates in that unit (most list one).
export function headlineRate(rates: readonly Rate[], unit: Unit): number | null {
  const own = rates.filter(r => r.unit === unit); if (!own.length) return null;
  if (unit === 'token') {
    const input = tokenRate(own, 'input'), output = tokenRate(own, 'output');
    if (input !== null || output !== null) return input !== null && output !== null ? blendedPrice({ inputPrice: input, outputPrice: output }) : input ?? output;
    return Math.min(...own.map(r => r.amount));
  }
  return own.reduce((n, r) => n + r.amount, 0);
}
export function cheapestRoute(routes: readonly Endpoint[], unit: Unit): Endpoint | null {
  let best: Endpoint | null = null, at = Infinity;
  for (const e of routes) { const v = headlineRate(e.rates, unit); if (v !== null && v < at) { best = e; at = v; } }
  return best;
}
// A route's rates grouped by unit, e.g. {"USD per 1M tokens": {input: 1, output: 2}}.
export function ratesByUnit(rates: readonly Rate[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const u of units) for (const r of rates.filter(x => x.unit === u)) (out[unitLabels[u]] ??= {})[r.kind] = r.amount;
  return out;
}
// The cheapest eligible route in each unit the model is billed in.
export function pricesByUnit(routes: readonly Endpoint[]): Record<string, Record<string, number | string>> {
  const out: Record<string, Record<string, number | string>> = {};
  for (const u of units) {
    const e = cheapestRoute(routes, u); if (!e) continue;
    out[unitLabels[u]] = { ...ratesByUnit(e.rates.filter(r => r.unit === u))[unitLabels[u]], route: e.provider };
  }
  return out;
}

// ---- Queries the tools expose ----

const includesAll = (have: string[], want: string[] = []) => want.every(w => have.includes(w.toLowerCase()));
const nameMatch = (value: string, wanted: string[]) => wanted.some(w => value.toLowerCase().includes(w.toLowerCase()));

// Routes of a model that meet the route-level constraints; a model is eligible when one remains.
// A model without listed routes (for example open weights to host yourself) is judged on its own record.
export function eligibleEndpoints(model: ModelRecord, f: Filters = {}): Endpoint[] {
  const routes = model.endpoints.length ? model.endpoints
    : [{ id: `${model.id}:unlisted`, provider: model.provider, modelId: model.id, inputPrice: null, outputPrice: null, rates: [], context: null, inputs: [], outputs: [], parameters: [], deployment: 'unlisted', url: null }];
  return routes.filter(e =>
    includesAll(e.inputs.length ? e.inputs : model.inputs, (f.inputs ?? []).map(modality)) && includesAll(e.outputs.length ? e.outputs : model.outputs, f.outputs)
    && (f.parameters ?? []).every(p => (e.parameters.length ? e.parameters : model.parameters).includes(p))
    && (!f.providers?.length || nameMatch(e.provider, f.providers) || nameMatch(model.provider, f.providers))
    && (!f.excludeProviders?.length || !(nameMatch(e.provider, f.excludeProviders) || nameMatch(model.provider, f.excludeProviders)))
    && (f.minContext === undefined || (e.context ?? model.context ?? 0) >= f.minContext)
    && (f.maxInputPrice === undefined || e.inputPrice !== null && e.inputPrice <= f.maxInputPrice)
    && (f.maxOutputPrice === undefined || e.outputPrice !== null && e.outputPrice <= f.maxOutputPrice));
}
const priced = (routes: Endpoint[]) => routes.filter(e => e.rates.length);
// Why a model fails the constraints, or null when it satisfies them.
export function violation(model: ModelRecord, f: Filters = {}): string | null {
  if (f.kind && model.kind !== f.kind) return model.kind ? `it is a ${model.kind} model, not ${f.kind}` : 'its kind is unknown';
  if (f.openWeights !== undefined && model.openWeights !== f.openWeights) return model.openWeights === null ? 'its weight availability is unknown' : f.openWeights ? 'its weights are not open' : 'it is an open-weights model';
  if (f.releasedAfter && !(model.releaseDate && model.releaseDate > f.releasedAfter)) return model.releaseDate ? `it was released on ${model.releaseDate}` : 'its release date is unknown';
  return eligibleEndpoints(model, f).length ? null : 'no listed route meets the input, output, parameter, provider, context or price constraints';
}

// Each model's position on one benchmark or leaderboard. Benchmark ranks are among
// catalogued models (1 is the best score); leaderboard ranks are the board's own,
// among all its results in its direction. Computed once per catalogue.
export interface Standing { model: ModelRecord; score: number | null; rank: number; of: number; observedAt: string | null; metric: string | null }
const leaderboards = new WeakMap<Catalogue, Map<string, Standing[]>>();
export function standings(catalogue: Catalogue, id: string): Standing[] {
  let boards = leaderboards.get(catalogue);
  if (!boards) {
    const best = new Map<string, Array<{ model: ModelRecord; observation: Observation }>>(), ranked = new Map<string, Standing[]>();
    for (const model of catalogue.models) {
      const top = new Map<string, Observation>();
      for (const e of model.evidence) if ((top.get(e.benchmark)?.score ?? -Infinity) < e.score) top.set(e.benchmark, e);
      for (const [benchmark, observation] of top) { const rows = best.get(benchmark) ?? []; rows.push({ model, observation }); best.set(benchmark, rows); }
      for (const b of model.boards) { const rows = ranked.get(b.board) ?? []; rows.push({ model, score: b.score, rank: b.rank, of: b.of, observedAt: b.observedAt, metric: null }); ranked.set(b.board, rows); }
    }
    boards = new Map([...best].map(([benchmark, rows]) => [benchmark, rows.sort((a, b) => b.observation.score - a.observation.score)
      .map((s, i): Standing => ({ model: s.model, score: s.observation.score, rank: i + 1, of: rows.length, observedAt: s.observation.observedAt, metric: s.observation.metric }))]));
    const metrics = new Map(catalogue.boards.map(b => [b.id, b.metric]));
    for (const [board, rows] of ranked) boards.set(board, rows.sort((a, b) => a.rank - b.rank).map(s => ({ ...s, metric: metrics.get(board) ?? null })));
    leaderboards.set(catalogue, boards);
  }
  return boards.get(id) ?? [];
}

export function modelSummary(m: ModelRecord, f: Filters = {}) {
  const routes = priced(eligibleEndpoints(m, f));
  return {
    id: m.id, name: m.name, kind: m.kind, provider: m.provider, released: m.releaseDate, openWeights: m.openWeights, context: m.context,
    inputs: m.inputs, outputs: m.outputs,
    prices: pricesByUnit(routes.length ? routes : m.endpoints),
    speed: m.speed ? { tokensPerSecond: m.speed.tokensPerSecond && Math.round(m.speed.tokensPerSecond), secondsToFirstAnswerToken: m.speed.timeToFirstToken && Math.round(m.speed.timeToFirstToken * 10) / 10 } : null,
    benchmarkResults: m.evidence.length, leaderboardResults: m.boards.length,
  };
}

export interface ModelQuery { query?: string; filters?: Filters; sortBy?: 'benchmark' | 'price' | 'speed' | 'recency'; priceUnit?: Unit; benchmark?: string; limit?: number }
export function searchModels(catalogue: Catalogue, q: ModelQuery) {
  const f = q.filters ?? {}, terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  let rows = catalogue.models.filter(m => violation(m, f) === null && terms.every(t => `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(t)));
  const ranked = q.benchmark ? new Map(standings(catalogue, q.benchmark).map(s => [s.model.id, s])) : null;
  if (q.sortBy === 'benchmark' || (q.benchmark && !q.sortBy)) {
    if (!ranked) throw new Error('Sorting by benchmark needs a benchmark or leaderboard ID from search_benchmarks or search_catalogue.');
    rows = rows.filter(m => ranked.has(m.id)).sort((a, b) => (ranked.get(a.id)?.rank ?? 0) - (ranked.get(b.id)?.rank ?? 0));
  }
  // Prices are compared within one unit only; models not billed in it follow, unsorted.
  const unit: Unit = q.priceUnit ?? (f.kind && (kinds as readonly string[]).includes(f.kind) ? kindUnits[f.kind as Kind] : 'token');
  const price = (m: ModelRecord) => { const routes = priced(eligibleEndpoints(m, f)), e = cheapestRoute(routes, unit); return e ? headlineRate(e.rates, unit) ?? Infinity : Infinity; };
  const latency = (m: ModelRecord) => m.speed?.tokensPerSecond ? -m.speed.tokensPerSecond : Infinity;
  if (q.sortBy === 'price') rows.sort((a, b) => price(a) - price(b));
  if (q.sortBy === 'speed') rows.sort((a, b) => latency(a) - latency(b));
  if (q.sortBy === 'recency') rows.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  const limit = Math.min(Math.max(q.limit ?? 15, 1), 40);
  return {
    matched: rows.length,
    ...(q.sortBy === 'price' ? { priceUnit: unitLabels[unit], notBilledInUnit: rows.filter(m => price(m) === Infinity).length } : {}),
    models: rows.slice(0, limit).map(m => {
      const s = ranked?.get(m.id);
      return { ...modelSummary(m, f), ...(s ? { benchmark: { score: s.score, rank: s.rank, of: s.of } } : {}) };
    }),
  };
}

export function searchBenchmarks(catalogue: Catalogue, ids: string[]) {
  const byId = new Map(catalogue.benchmarks.map(b => [b.id, b]));
  return ids.flatMap(id => { const b = byId.get(id); return b ? [{ id: b.id, name: b.name, tags: b.tags, source: b.source, modelsMeasured: b.models, released: b.releaseDate, description: b.description }] : []; });
}

export function benchmarkLeaderboard(catalogue: Catalogue, id: string, f: Filters = {}, limit = 20) {
  const b = catalogue.benchmarks.find(x => x.id === id), board = b ? null : catalogue.boards.find(x => x.id === id);
  if (!b && !board) throw new Error(`Unknown benchmark ${JSON.stringify(id)}. Use a benchmark ID from search_benchmarks or a leaderboard ID from search_catalogue.`);
  const all = standings(catalogue, id), rows = all.filter(s => violation(s.model, f) === null);
  return {
    benchmark: b ? { id: b.id, name: b.name, metric: all[0]?.metric ?? null, higherIsBetter: true, modelsMeasured: all.length, rankAmong: 'catalogued models' }
      : { id, name: board?.title ?? id, metric: board?.metric ?? null, higherIsBetter: board?.direction !== 'lower', modelsMeasured: board?.results ?? 0, catalogued: all.length, rankAmong: 'every result on the leaderboard', version: board?.version ?? null, source: board?.url ?? null },
    eligibleMeasured: rows.length,
    results: rows.slice(0, Math.min(Math.max(limit, 1), 50)).map(s => ({ model: s.model.id, name: s.model.name, kind: s.model.kind, score: s.score, rank: s.rank, of: s.of, observedAt: s.observedAt })),
  };
}

export function modelDetails(catalogue: Catalogue, ids: string[], f: Filters = {}) {
  const byId = new Map(catalogue.models.map(m => [m.id, m])), names = new Map(catalogue.benchmarks.map(b => [b.id, b.name])), boards = new Map(catalogue.boards.map(b => [b.id, b]));
  return ids.map(id => {
    const m = byId.get(id);
    if (!m) return { id, error: 'Not in the catalogue. Check the ID with search_models or search_catalogue.' };
    const best = new Map<string, Observation>();
    for (const e of m.evidence) if ((best.get(e.benchmark)?.score ?? -Infinity) < e.score) best.set(e.benchmark, e);
    const own = new Map<string, BoardResult>();
    for (const r of m.boards) if ((own.get(r.board)?.rank ?? Infinity) > r.rank) own.set(r.board, r);
    return {
      ...modelSummary(m, f), parameters: m.parameters, constraintViolation: violation(m, f),
      routes: [...m.endpoints].sort((a, b) => (headlineRate(a.rates, 'token') ?? Infinity) - (headlineRate(b.rates, 'token') ?? Infinity)).slice(0, 8)
        .map(e => ({ provider: e.provider, modelId: e.modelId, prices: ratesByUnit(e.rates), context: e.context, deployment: e.deployment })),
      // Strongest standings first; a rank is only meaningful within its own benchmark.
      benchmarks: [...best.values()].map(e => {
        const s = standings(catalogue, e.benchmark).find(x => x.model.id === m.id);
        return { id: e.benchmark, name: names.get(e.benchmark) ?? e.benchmark, score: e.score, rank: s?.rank ?? null, of: s?.of ?? null, observedAt: e.observedAt };
      }).sort((a, b) => (a.rank ?? 1e9) / (a.of ?? 1) - (b.rank ?? 1e9) / (b.of ?? 1)).slice(0, 40),
      // Leaderboard results rank among every result on that board, in its own direction.
      leaderboards: [...own.values()].map(r => {
        const b = boards.get(r.board);
        return { id: r.board, name: b?.title ?? r.board, metric: b?.metric ?? null, higherIsBetter: b?.direction !== 'lower', score: r.score, rank: r.rank, of: r.of, version: b?.version ?? null, date: r.observedAt, source: b?.url ?? null };
      }).sort((a, b) => a.rank / a.of - b.rank / b.of).slice(0, 30),
    };
  });
}

export type SearchMode = 'hybrid' | 'bm25' | 'embedding';
export interface CatalogueQuery { query: string; mode?: SearchMode; types?: DocumentType[]; kind?: string; limit?: number }
interface CatalogueResult {
  type: DocumentType; id: string; name: string; kind: string | null; matched: SearchField[];
  provider?: string; released?: string | null; modelsMeasured?: number; metric?: string; higherIsBetter?: boolean; catalogued?: number;
}
// Free-text retrieval for the search_catalogue tool: keyword and embedding lists,
// merged by reciprocal rank fusion (k = 60) in hybrid mode.
export async function searchCatalogue(catalogue: Catalogue, q: CatalogueQuery) {
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 25), options: SearchOptions = { limit: Math.max(limit, 30), ...(q.types?.length ? { types: q.types } : {}), ...(q.kind ? { kind: q.kind } : {}) };
  const requested = q.mode ?? 'hybrid';
  let mode: SearchMode = requested, note: string | undefined, vectors: SearchHit[] = [];
  if (requested !== 'bm25') {
    try { vectors = await catalogue.search.embedding(q.query, options); }
    catch (error) { mode = 'bm25'; note = `Embedding search unavailable (${(error as Error).message}); these are keyword (BM25) results only.`; }
  }
  const keyword = mode === 'embedding' ? [] : await catalogue.search.bm25(q.query, options);
  const hits = mode === 'hybrid' ? reciprocalRankFusion([keyword, vectors]) : mode === 'embedding' ? vectors : keyword;
  const models = new Map(catalogue.models.map(m => [m.id, m])), benchmarks = new Map(catalogue.benchmarks.map(b => [b.id, b])), boards = new Map(catalogue.boards.map(b => [b.id, b]));
  return {
    mode, ...(note ? { note } : {}),
    results: hits.slice(0, limit).flatMap((h): CatalogueResult[] => {
      const matched = h.fields;
      if (h.type === 'model') { const m = models.get(h.id); return m ? [{ type: h.type, id: m.id, name: m.name, kind: m.kind, provider: m.provider, released: m.releaseDate, matched }] : []; }
      if (h.type === 'benchmark') { const b = benchmarks.get(h.id); return b ? [{ type: h.type, id: b.id, name: b.name, kind: 'chat', modelsMeasured: b.models, matched }] : []; }
      const b = boards.get(h.id);
      return b ? [{ type: h.type, id: b.id, name: b.title, kind: b.kind, metric: b.metric, higherIsBetter: b.direction !== 'lower', catalogued: b.linked, matched }] : [];
    }),
  };
}
