// The data the Scout agent's tools read: published model records (identity,
// routes, prices, reference timing, benchmark observations), release dates from
// the source-backed catalogue, and benchmark descriptions with semantic search.
// Everything here is read-only; publication stays with the hourly refresh.

export interface Endpoint {
  id: string; provider: string; modelId: string; inputPrice: number; outputPrice: number;
  context: number | null; inputs: string[]; outputs: string[]; parameters: string[]; deployment: string; url: string | null;
}
export interface Observation { benchmark: string; score: number; metric: string | null; observedAt: string | null; url: string | null }
export interface Speed { tokensPerSecond: number | null; timeToFirstToken: number | null; source: string | null; url: string | null }
export interface ModelRecord {
  id: string; name: string; provider: string; releaseDate: string | null; openWeights: boolean | null;
  context: number | null; inputs: string[]; outputs: string[]; parameters: string[];
  endpoints: Endpoint[]; speed: Speed | null; evidence: Observation[];
}
export interface BenchmarkRecord { id: string; name: string; tags: string[]; source: string; description: string; releaseDate: string | null; models: number }
export interface Catalogue {
  version: string;
  models: ModelRecord[];
  benchmarks: BenchmarkRecord[];
  // Benchmark IDs nearest to a description of the work, best first.
  semanticBenchmarks(query: string, limit: number): Promise<string[]>;
}

// Hard constraints the agent applies through search and that submitted shortlists must satisfy.
export interface Filters {
  inputs?: string[]; outputs?: string[]; parameters?: string[]; providers?: string[]; excludeProviders?: string[];
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

function endpoint(raw: unknown): Endpoint | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id), inputPrice = num(raw.inputPrice), outputPrice = num(raw.outputPrice);
  if (!id || inputPrice === null || outputPrice === null) return null;
  return {
    id, provider: str(raw.provider) ?? 'unknown', modelId: str(raw.modelId) ?? id, inputPrice, outputPrice, context: num(raw.context),
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
const unique = (values: string[]) => [...new Set(values)].sort();

// One published model record (snapshot or D1 projection payload) in the agent's shape.
export function modelRecord(raw: Json, release: { date?: string | null; openWeights?: boolean | null } = {}): ModelRecord | null {
  const id = str(raw.id); if (!id) return null;
  const endpoints = (Array.isArray(raw.endpoints) ? raw.endpoints : []).map(endpoint).filter((e): e is Endpoint => e !== null);
  const facts = Array.isArray(raw.facts) ? raw.facts.filter(isObject) : [];
  const fact = (field: string) => facts.find(f => f.field === field && f.value != null)?.value;
  const contexts = [num(raw.context), ...endpoints.map(e => e.context)].filter((c): c is number => c !== null);
  return {
    id, name: str(raw.name) ?? id, provider: str(raw.provider) ?? str(fact('creator')) ?? 'unknown',
    releaseDate: release.date ?? day(fact('releasedAt')), openWeights: release.openWeights ?? null,
    context: contexts.length ? Math.max(...contexts) : null,
    inputs: unique([...lower(strings(raw.modalities)).map(modality), ...endpoints.flatMap(e => e.inputs)]),
    outputs: unique([...lower(strings(raw.outputModalities)), ...endpoints.flatMap(e => e.outputs)]),
    parameters: unique([...strings(raw.parameters), ...endpoints.flatMap(e => e.parameters)]),
    endpoints, speed: speed(raw.speed),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map(observation).filter((o): o is Observation => o !== null),
  };
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

// Local catalogue from a refresh snapshot (scout/snapshot.json): tests and offline use.
export function catalogueFromSnapshot(snapshot: Json, semantic?: Catalogue['semanticBenchmarks']): Catalogue {
  const measured = new Map((Array.isArray(snapshot.models) ? snapshot.models : []).filter(isObject).map(m => [m.id, m]));
  const identities = Array.isArray(snapshot.catalogue) ? snapshot.catalogue.filter(isObject) : [...measured.values()];
  const models = identities.map(m => { const x = measured.get(m.id); return modelRecord({ ...m, speed: m.speed ?? x?.speed, evidence: x?.evidence ?? [] }); }).filter((m): m is ModelRecord => m !== null);
  const descriptions = new Map(Object.entries(isObject(snapshot.benchmarkDescriptions) ? snapshot.benchmarkDescriptions : {}).flatMap(([k, v]) => isObject(v) && str(v.description) ? [[k, (str(v.description) ?? '').replace(/\s+/g, ' ').slice(0, 400)] as [string, string]] : []));
  const benchmarks = benchmarkRecords(Array.isArray(snapshot.benchmarks) ? snapshot.benchmarks : [], models, descriptions);
  return { version: `snapshot-${str(snapshot.checkedAt) ?? 'local'}`, models, benchmarks,
    semanticBenchmarks: semantic ?? (async (query, limit) => lexicalBenchmarks(benchmarks, query, limit)) };
}

// The subset of Worker bindings the hosted catalogue reads.
interface Statement { bind(...values: unknown[]): Statement; all<T>(): Promise<{ results: T[] }> }
export interface CatalogueBindings {
  SCOUT_CATALOGUE: { get(key: string): Promise<{ json<T>(): Promise<T> } | null> };
  SCOUT_INDEX: { prepare(sql: string): Statement };
  SCOUT_EVIDENCE: { query(vector: number[], options: { namespace?: string; topK: number; returnMetadata: 'all' }): Promise<{ matches: Array<{ metadata?: Record<string, unknown> }> }> };
  OPENAI_API_KEY?: string;
}
export type Embedder = (texts: string[], apiKey: string) => Promise<number[][]>;

// The published generation: active pointer → manifest in R2, model records in D1,
// release dates from the source-backed catalogue in the same D1 database.
export async function loadCatalogue(env: CatalogueBindings, embed: Embedder): Promise<Catalogue> {
  const read = async <T>(key: string) => { const object = await env.SCOUT_CATALOGUE.get(key); return object ? object.json<T>() : null; };
  const pointer = await read<{ key: string }>('active.json');
  const manifest = pointer ? await read<Json>(pointer.key) : null;
  const publication = isObject(manifest?.publication) ? manifest.publication : {};
  const version = str(publication.id);
  if (!manifest || !version) throw new Error('No published Scout catalogue is available.');
  const rows = (await env.SCOUT_INDEX.prepare(`SELECT s.payload, c.release_date, c.open_weights FROM scout_models s LEFT JOIN cat_models c ON c.id = s.id AND c.withdrawn_at IS NULL WHERE s.version = ?`)
    .bind(version).all<{ payload: string; release_date: string | null; open_weights: number | null }>()).results;
  const models = rows.flatMap(r => {
    const raw: unknown = JSON.parse(r.payload);
    const m = isObject(raw) ? modelRecord(raw, { date: day(r.release_date), openWeights: r.open_weights === null ? null : r.open_weights === 1 }) : null;
    return m ? [m] : [];
  });
  const evidenceIndex = isObject(manifest.evidenceIndex) ? manifest.evidenceIndex : {};
  const documents = Array.isArray(evidenceIndex.documents) ? evidenceIndex.documents.filter(isObject) : [];
  const descriptions = new Map(documents.flatMap(d => { const id = str(d.id), text = description(d.text); return id && text ? [[id, text] as [string, string]] : []; }));
  const benchmarks = benchmarkRecords(Array.isArray(manifest.benchmarks) ? manifest.benchmarks : [], models, descriptions);
  const known = new Set(benchmarks.map(b => b.id)), namespace = str(evidenceIndex.version) ?? version;
  return {
    version, models, benchmarks,
    async semanticBenchmarks(query, limit) {
      const lexical = lexicalBenchmarks(benchmarks, query, limit);
      if (!env.OPENAI_API_KEY) return lexical;
      const [vector] = await embed([query], env.OPENAI_API_KEY);
      if (!vector) return lexical;
      const result = await env.SCOUT_EVIDENCE.query(vector, { namespace, topK: Math.min(50, limit * 2), returnMetadata: 'all' });
      const semantic = result.matches.map(m => str(m.metadata?.benchmark)).filter((id): id is string => !!id && known.has(id));
      // Exact names first (a user who names a benchmark means it), then nearest methodologies.
      return [...new Set([...lexical.slice(0, 3), ...semantic, ...lexical])].slice(0, limit);
    },
  };
}

// ---- Queries the tools expose ----

export const blendedPrice = (e: { inputPrice: number; outputPrice: number }) => (3 * e.inputPrice + e.outputPrice) / 4;
const includesAll = (have: string[], want: string[] = []) => want.every(w => have.includes(w.toLowerCase()));
const nameMatch = (value: string, wanted: string[]) => wanted.some(w => value.toLowerCase().includes(w.toLowerCase()));

// Routes of a model that meet the route-level constraints; a model is eligible when one remains.
export function eligibleEndpoints(model: ModelRecord, f: Filters = {}): Endpoint[] {
  return model.endpoints.filter(e =>
    includesAll(e.inputs.length ? e.inputs : model.inputs, (f.inputs ?? []).map(modality)) && includesAll(e.outputs.length ? e.outputs : model.outputs, f.outputs)
    && (f.parameters ?? []).every(p => (e.parameters.length ? e.parameters : model.parameters).includes(p))
    && (!f.providers?.length || nameMatch(e.provider, f.providers) || nameMatch(model.provider, f.providers))
    && (!f.excludeProviders?.length || !(nameMatch(e.provider, f.excludeProviders) || nameMatch(model.provider, f.excludeProviders)))
    && (f.minContext === undefined || (e.context ?? model.context ?? 0) >= f.minContext)
    && (f.maxInputPrice === undefined || e.inputPrice <= f.maxInputPrice)
    && (f.maxOutputPrice === undefined || e.outputPrice <= f.maxOutputPrice));
}
// Why a model fails the constraints, or null when it satisfies them.
export function violation(model: ModelRecord, f: Filters = {}): string | null {
  if (f.openWeights !== undefined && model.openWeights !== f.openWeights) return model.openWeights === null ? 'its weight availability is unknown' : f.openWeights ? 'its weights are not open' : 'it is an open-weights model';
  if (f.releasedAfter && !(model.releaseDate && model.releaseDate > f.releasedAfter)) return model.releaseDate ? `it was released on ${model.releaseDate}` : 'its release date is unknown';
  return eligibleEndpoints(model, f).length ? null : 'no listed route meets the input, output, parameter, provider, context or price constraints';
}

// Each model's position on one benchmark: 1 is the best score among measured models.
// Observations are immutable per catalogue, so leaderboards are computed once.
interface Standing { model: ModelRecord; observation: Observation; rank: number; of: number }
const leaderboards = new WeakMap<Catalogue, Map<string, Standing[]>>();
export function standings(catalogue: Catalogue, benchmark: string): Standing[] {
  let boards = leaderboards.get(catalogue);
  if (!boards) {
    const best = new Map<string, Array<{ model: ModelRecord; observation: Observation }>>();
    for (const model of catalogue.models) {
      const top = new Map<string, Observation>();
      for (const e of model.evidence) if ((top.get(e.benchmark)?.score ?? -Infinity) < e.score) top.set(e.benchmark, e);
      for (const [id, observation] of top) { const rows = best.get(id) ?? []; rows.push({ model, observation }); best.set(id, rows); }
    }
    boards = new Map([...best].map(([id, rows]) => [id, rows.sort((a, b) => b.observation.score - a.observation.score).map((s, i) => ({ ...s, rank: i + 1, of: rows.length }))]));
    leaderboards.set(catalogue, boards);
  }
  return boards.get(benchmark) ?? [];
}

export function modelSummary(m: ModelRecord, f: Filters = {}) {
  const routes = eligibleEndpoints(m, f), cheapest = [...(routes.length ? routes : m.endpoints)].sort((a, b) => blendedPrice(a) - blendedPrice(b))[0];
  return {
    id: m.id, name: m.name, provider: m.provider, released: m.releaseDate, openWeights: m.openWeights, context: m.context,
    inputs: m.inputs, outputs: m.outputs,
    price: cheapest ? { input: cheapest.inputPrice, output: cheapest.outputPrice, unit: 'USD per 1M tokens', route: cheapest.provider } : null,
    speed: m.speed ? { tokensPerSecond: m.speed.tokensPerSecond && Math.round(m.speed.tokensPerSecond), secondsToFirstAnswerToken: m.speed.timeToFirstToken && Math.round(m.speed.timeToFirstToken * 10) / 10 } : null,
    benchmarkResults: m.evidence.length,
  };
}

export interface ModelQuery { query?: string; filters?: Filters; sortBy?: 'benchmark' | 'price' | 'speed' | 'recency'; benchmark?: string; limit?: number }
export function searchModels(catalogue: Catalogue, q: ModelQuery) {
  const f = q.filters ?? {}, terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  let rows = catalogue.models.filter(m => violation(m, f) === null && terms.every(t => `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(t)));
  const ranked = q.benchmark ? new Map(standings(catalogue, q.benchmark).map(s => [s.model.id, s])) : null;
  if (q.sortBy === 'benchmark' || (q.benchmark && !q.sortBy)) {
    if (!ranked) throw new Error('Sorting by benchmark needs a benchmark ID from search_benchmarks.');
    rows = rows.filter(m => ranked.has(m.id)).sort((a, b) => (ranked.get(a.id)?.rank ?? 0) - (ranked.get(b.id)?.rank ?? 0));
  }
  const price = (m: ModelRecord) => { const p = modelSummary(m, f).price; return p ? blendedPrice({ inputPrice: p.input, outputPrice: p.output }) : Infinity; };
  const latency = (m: ModelRecord) => m.speed?.tokensPerSecond ? -m.speed.tokensPerSecond : Infinity;
  if (q.sortBy === 'price') rows.sort((a, b) => price(a) - price(b));
  if (q.sortBy === 'speed') rows.sort((a, b) => latency(a) - latency(b));
  if (q.sortBy === 'recency') rows.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  const limit = Math.min(Math.max(q.limit ?? 15, 1), 40);
  return {
    matched: rows.length,
    models: rows.slice(0, limit).map(m => {
      const s = ranked?.get(m.id);
      return { ...modelSummary(m, f), ...(s ? { benchmark: { score: s.observation.score, rank: s.rank, of: s.of } } : {}) };
    }),
  };
}

export function searchBenchmarks(catalogue: Catalogue, ids: string[]) {
  const byId = new Map(catalogue.benchmarks.map(b => [b.id, b]));
  return ids.flatMap(id => { const b = byId.get(id); return b ? [{ id: b.id, name: b.name, tags: b.tags, source: b.source, modelsMeasured: b.models, released: b.releaseDate, description: b.description }] : []; });
}

export function benchmarkLeaderboard(catalogue: Catalogue, benchmark: string, f: Filters = {}, limit = 20) {
  const b = catalogue.benchmarks.find(x => x.id === benchmark);
  if (!b) throw new Error(`Unknown benchmark ${JSON.stringify(benchmark)}. Use an ID returned by search_benchmarks.`);
  const all = standings(catalogue, benchmark);
  const rows = all.filter(s => violation(s.model, f) === null);
  return {
    benchmark: { id: b.id, name: b.name, metric: all[0]?.observation.metric ?? null, modelsMeasured: all.length },
    eligibleMeasured: rows.length,
    results: rows.slice(0, Math.min(Math.max(limit, 1), 50)).map(s => ({ model: s.model.id, name: s.model.name, score: s.observation.score, rank: s.rank, observedAt: s.observation.observedAt })),
  };
}

export function modelDetails(catalogue: Catalogue, ids: string[], f: Filters = {}) {
  const byId = new Map(catalogue.models.map(m => [m.id, m])), names = new Map(catalogue.benchmarks.map(b => [b.id, b.name]));
  return ids.map(id => {
    const m = byId.get(id);
    if (!m) return { id, error: 'Not in the catalogue. Check the ID with search_models.' };
    const best = new Map<string, Observation>();
    for (const e of m.evidence) if ((best.get(e.benchmark)?.score ?? -Infinity) < e.score) best.set(e.benchmark, e);
    return {
      ...modelSummary(m, f), parameters: m.parameters, constraintViolation: violation(m, f),
      routes: m.endpoints.slice(0, 8).map(e => ({ provider: e.provider, modelId: e.modelId, input: e.inputPrice, output: e.outputPrice, context: e.context, deployment: e.deployment })),
      // Strongest standings first; a rank is only meaningful within its own benchmark.
      benchmarks: [...best.values()].map(e => {
        const s = standings(catalogue, e.benchmark).find(x => x.model.id === m.id);
        return { id: e.benchmark, name: names.get(e.benchmark) ?? e.benchmark, score: e.score, rank: s?.rank ?? null, of: s?.of ?? null, observedAt: e.observedAt };
      }).sort((a, b) => (a.rank ?? 1e9) / (a.of ?? 1) - (b.rank ?? 1e9) / (b.of ?? 1)).slice(0, 40),
    };
  });
}
