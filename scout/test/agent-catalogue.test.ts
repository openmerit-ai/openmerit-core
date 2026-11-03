import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueSchema } from '../catalogue-db.ts';
import { agentRows, agentSchema, stageAgentCatalogue, type Sources } from '../agent-projection.ts';
import { benchmarkLeaderboard, loadCatalogue, modelDetails, modelRecord, searchCatalogue, searchModels, type Catalogue, type CatalogueBindings, type ModelRecord } from '../agent/catalogue.ts';
import { finalize, routeCost, type Submission } from '../agent/recommendation.ts';
import { reciprocalRankFusion, type SearchHit } from '../agent/search.ts';
import { d1 } from './helpers-d1.ts';
import { digest } from '../utils.mjs';

// ---- In-memory catalogue for the query and validation rules ----

const rate = (unit: string, kind: string, amount: number) => ({ unit, kind, amount });
const route = (provider: string, rates: ReturnType<typeof rate>[], extra: Record<string, unknown> = {}) => ({ id: `${provider}:r`, provider, modelId: 'r', rates, ...extra });
const model = (id: string, kind: string | null, endpoints: unknown[], boards: unknown[] = [], extra: Record<string, unknown> = {}): ModelRecord => {
  const m = modelRecord({ id, name: id, provider: id.split('/')[0], endpoints, ...extra }, { kind, boards, date: '2026-01-01' }); assert.ok(m); return m;
};
const models: ModelRecord[] = [
  model('lab/chat-a', 'chat', [route('A', [rate('token', 'input', 2), rate('token', 'output', 6)])]),
  model('lab/chat-b', 'chat', [route('B', [rate('token', 'input', 0.5), rate('token', 'output', 1)])]),
  // Cheap per image, which must never be compared with a per-token price.
  model('lab/painter', 'image', [route('Fal', [rate('image', 'output_image', 0.01)])], [{ board: 'arena:t2i', score: 1200, rank: 2, of: 40 }]),
  model('lab/painter-pro', 'image', [route('Fal', [rate('image', 'output_image', 0.08)]), route('Gateway', [rate('token', 'input', 0.3), rate('token', 'output', 30)])], [{ board: 'arena:t2i', score: 1300, rank: 1, of: 40 }]),
  model('lab/ears', 'transcription', [route('Speechy', [rate('second', 'input', 0.0001)])], [{ board: 'asr:multilingual', score: 7.5, rank: 3, of: 20 }]),
  model('lab/ears-hd', 'transcription', [route('Speechy', [rate('second', 'input', 0.0004)])], [{ board: 'asr:multilingual', score: 5.2, rank: 1, of: 20 }]),
  model('lab/chat-c', 'chat', [route('C', [rate('token', 'input', 1), rate('token', 'output', 1)])]),
  model('lab/chat-d', 'chat', [route('D', [rate('token', 'input', 1), rate('token', 'output', 2)])]),
  model('lab/chat-e', 'chat', [route('E', [rate('token', 'input', 3), rate('token', 'output', 3)])]),
];
const boards = [
  { id: 'arena:t2i', title: 'Arena · Text to image', kind: 'image', metric: 'Elo', direction: 'higher' as const, url: 'https://arena.example', source: 'arena', version: 'v1', publishedAt: '2026-10-01', checkedAt: '2026-10-02', results: 40, linked: 2, description: '' },
  { id: 'asr:multilingual', title: 'Open ASR · Multilingual', kind: 'transcription', metric: 'WER (%)', direction: 'lower' as const, url: 'https://asr.example', source: 'open-asr', version: 'v2', publishedAt: null, checkedAt: '2026-10-02', results: 20, linked: 2, description: '' },
];
const stubSearch = (bm25: SearchHit[], embedding: SearchHit[] | Error): Catalogue['search'] => ({
  bm25: async () => bm25, embedding: async () => { if (embedding instanceof Error) throw embedding; return embedding; } });
const catalogue: Catalogue = { version: 'v-test', models, benchmarks: [], boards, semanticBenchmarks: async () => [], search: stubSearch([], []) };
const pick = (modelId: string, evidence: string[] = []) => ({ modelId, quality: 70, evidence, rationale: 'why' });
const submit = (candidates: Submission['candidates'], workload: Submission['workload'], filters?: Submission['filters']): Submission =>
  ({ task: 1, workload, summary: 's', qualityBar: 50, candidates, ...(filters ? { filters } : {}) });

test('price sorting compares one unit at a time, so a per-image price never outranks a per-token price', () => {
  // Default unit is tokens: the image models are not billed per token (painter) or sort by their token route (painter-pro, blended 7.725).
  const byToken = searchModels(catalogue, { sortBy: 'price' });
  assert.deepEqual(byToken.models.slice(0, 3).map(m => m.id), ['lab/chat-b', 'lab/chat-c', 'lab/chat-d']);
  assert.equal(byToken.priceUnit, 'USD per 1M tokens');
  assert.ok(byToken.models.findIndex(m => m.id === 'lab/painter') > byToken.models.findIndex(m => m.id === 'lab/painter-pro'));
  assert.equal(byToken.notBilledInUnit, 3);
  // An image filter sorts per image by default.
  const byImage = searchModels(catalogue, { sortBy: 'price', filters: { kind: 'image' } });
  assert.deepEqual(byImage.models.map(m => [m.id, m.prices['USD per image']]), [['lab/painter', { output_image: 0.01, route: 'Fal' }], ['lab/painter-pro', { output_image: 0.08, route: 'Fal' }]]);
  assert.equal(byImage.priceUnit, 'USD per image');
});

test('the kind filter restricts search, leaderboards and the number of models a shortlist must contain', () => {
  assert.deepEqual(searchModels(catalogue, { filters: { kind: 'transcription' } }).models.map(m => m.id), ['lab/ears', 'lab/ears-hd']);
  // Two transcription models exist, so two are a complete shortlist once the kind is stated...
  const ok = finalize(catalogue, submit([pick('lab/ears-hd', ['asr:multilingual']), pick('lab/ears')], { audioSeconds: 600 }, { kind: 'transcription' }), Date.parse('2026-10-29'));
  assert.equal(ok.models.length, 2);
  // ...but not without it, and a chat model breaks the constraint.
  assert.throws(() => finalize(catalogue, submit([pick('lab/ears-hd'), pick('lab/ears')], { audioSeconds: 600 }), 0), /Five candidates must reach the quality bar of 50; 2 do, and 9 models meet the constraints \(set filters.kind/);
  assert.throws(() => finalize(catalogue, submit([pick('lab/ears'), pick('lab/chat-a')], { audioSeconds: 600 }, { kind: 'transcription' }), 0), /lab\/chat-a breaks the hard constraints: it is a chat model, not transcription/);
});

test('a citation must be the model\'s own benchmark or leaderboard result', () => {
  // The ASR board exists, but painter has no result on it.
  assert.throws(() => finalize(catalogue, submit([pick('lab/painter', ['asr:multilingual']), pick('lab/painter-pro', ['arena:t2i'])], { images: 4 }, { kind: 'image' }), 0),
    (error: Error) => /lab\/painter has no results on asr:multilingual/.test(error.message) && !/painter-pro has no results/.test(error.message));
  const accepted = finalize(catalogue, submit([pick('lab/painter-pro', ['arena:t2i']), pick('lab/painter', ['arena:t2i'])], { images: 4 }, { kind: 'image' }), 0);
  assert.deepEqual(accepted.models.find(m => m.id === 'lab/painter-pro')?.quality.evidence, [{ benchmark: 'arena:t2i', name: 'Arena · Text to image', score: 1300, rank: 1, of: 40 }]);
});

test('cost is computed from catalogue rates in the workload\'s units on the route that prices most of it', () => {
  const result = finalize(catalogue, submit([pick('lab/ears'), pick('lab/ears-hd')], { audioSeconds: 600, outputTokens: 2000 }, { kind: 'transcription' }), 0);
  // 600 s × $0.0001 = $0.06 per task, $60 per 1,000; output tokens are not billed on this route and are reported.
  assert.deepEqual(result.models[0]?.cost, { usdPer1kTasks: 60, route: 'Speechy', endpointId: 'Speechy:r', providerModelId: 'r', inputPerMillion: null, outputPerMillion: null, rates: [{ unit: 'USD per second', kind: 'input', amount: 0.0001 }], unpriced: ['outputTokens'] });
  // Only fully priced costs can lead on cost.
  assert.deepEqual(result.models.map(m => m.best.includes('cost')), [false, false]);
  // Painter-pro: the per-image route prices the whole workload ($0.32 per task); its token route prices none of it.
  // Per-image costs rank cheapest first, whatever order they were submitted in.
  const images = finalize(catalogue, submit([pick('lab/painter-pro'), pick('lab/painter')], { images: 4 }, { kind: 'image' }), 0);
  assert.deepEqual(images.models.map(m => [m.id, m.cost?.route, m.cost?.usdPer1kTasks]), [['lab/painter', 'Fal', 40], ['lab/painter-pro', 'Fal', 320]]);
  assert.deepEqual(images.models.map(m => m.best.includes('cost')), [true, false]);
  // With a prompt in the workload, each route prices one quantity; the image price wins over the far cheaper prompt price.
  const prompted = finalize(catalogue, submit([pick('lab/painter-pro'), pick('lab/painter')], { images: 4, inputTokens: 150 }, { kind: 'image' }), 0);
  assert.deepEqual(prompted.models[0]?.cost && [prompted.models[0].cost.route, prompted.models[0].cost.usdPer1kTasks, prompted.models[0].cost.unpriced], ['Fal', 320, ['inputTokens']]);
  assert.throws(() => finalize(catalogue, submit([pick('lab/ears')], {}, { kind: 'transcription' }), 0), /workload is empty/);
  // A token-billed image route prices images by their output tokens at the image-token rate, never the text output rate.
  const [tokens] = model('lab/painter-tokens', 'image', [route('Gemini', [rate('token', 'input', 0.5), rate('token', 'output', 3), rate('token', 'output_image', 30)])], []).endpoints;
  const [perImage] = catalogue.models.find(m => m.id === 'lab/painter')?.endpoints ?? [];
  assert.ok(tokens && perImage);
  const priced = routeCost(tokens, 'image', { inputTokens: 100, images: 2, imageOutputTokens: 1300 });
  assert.deepEqual([Number(priced.usd.toFixed(6)), priced.unpriced], [0.07805, []]);
  assert.deepEqual(routeCost(tokens, 'image', { images: 2 }).unpriced, ['images'], 'without an image-token estimate the images stay unpriced');
  assert.equal(routeCost(perImage, 'image', { images: 2, imageOutputTokens: 1300 }).usd, 0.02, 'a per-image price ignores image tokens');
});

test('leaderboard IDs work wherever benchmark IDs do, with the board\'s own rank and direction', () => {
  const board = benchmarkLeaderboard(catalogue, 'asr:multilingual');
  assert.deepEqual(board.results.map(r => [r.model, r.rank, r.of]), [['lab/ears-hd', 1, 20], ['lab/ears', 3, 20]]);
  assert.equal(board.benchmark.higherIsBetter, false);
  assert.deepEqual(searchModels(catalogue, { benchmark: 'arena:t2i' }).models.map(m => m.id), ['lab/painter-pro', 'lab/painter']);
  const [details] = modelDetails(catalogue, ['lab/ears']);
  assert.deepEqual(details && 'leaderboards' in details ? details.leaderboards : null, [{ id: 'asr:multilingual', name: 'Open ASR · Multilingual', metric: 'WER (%)', higherIsBetter: false, score: 7.5, rank: 3, of: 20, version: 'v2', date: null, source: 'https://asr.example' }]);
});

const hit = (id: string, score: number, fields: SearchHit['fields']): SearchHit => ({ type: 'model', id, kind: null, score, fields });
test('hybrid search fuses keyword and embedding ranks with reciprocal rank fusion, not raw scores', async () => {
  // BM25 scores dwarf cosine similarities; adding them would return A, B, C, D.
  const bm25 = [hit('lab/chat-a', 100, ['name']), hit('lab/chat-b', 90, ['description']), hit('lab/chat-c', 80, ['aliases'])];
  const vectors = [hit('lab/chat-c', 0.9, ['meaning']), hit('lab/chat-b', 0.8, ['meaning']), hit('lab/chat-d', 0.7, ['meaning'])];
  // C: 1/63 + 1/61 = 0.032266 beats B: 2/62 = 0.032258, then A: 1/61, then D: 1/63.
  assert.deepEqual(reciprocalRankFusion([bm25, vectors]).map(h => h.id), ['lab/chat-c', 'lab/chat-b', 'lab/chat-a', 'lab/chat-d']);
  const result = await searchCatalogue({ ...catalogue, search: stubSearch(bm25, vectors) }, { query: 'anything' });
  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.results.map(r => [r.id, r.matched]), [['lab/chat-c', ['aliases', 'meaning']], ['lab/chat-b', ['description', 'meaning']], ['lab/chat-a', ['name']], ['lab/chat-d', ['meaning']]]);
  // Without embeddings the tool says so and returns the keyword list.
  const fallback = await searchCatalogue({ ...catalogue, search: stubSearch(bm25, new Error('OPENAI_API_KEY is not configured')) }, { query: 'anything', mode: 'embedding' });
  assert.equal(fallback.mode, 'bm25');
  assert.match(fallback.note ?? '', /Embedding search unavailable \(OPENAI_API_KEY is not configured\); these are keyword \(BM25\) results only/);
  assert.deepEqual(fallback.results.map(r => r.id), ['lab/chat-a', 'lab/chat-b', 'lab/chat-c']);
});

// ---- Publication from catalogue tables ----

const empty: Sources = { merged: [], release: [], offerings: [], prices: [], boards: [], boardResults: [], mteb: [], mtebResults: [], repos: [] };
test('leaderboard ranks follow the board direction and MTEB rows link only through an exact, unambiguous identity', () => {
  const embedding = (id: string) => ({ id, kind: 'embedding', name: id, release_date: null, open_weights: 1, input_modalities: null, output_modalities: null, context: null, lab: null });
  const { payloads, boards: published } = agentRows({ ...empty,
    merged: [embedding('qwen/qwen3-embedding-8b'), embedding('acme/embed-a'), embedding('acme/embed-b'), { ...embedding('lab/ears'), kind: 'transcription' }],
    repos: [{ repo: 'qwen/qwen3-embedding-8b-hf', model_id: 'qwen/qwen3-embedding-8b' }, { repo: 'shared/embed', model_id: 'acme/embed-a' }, { repo: 'shared/embed', model_id: 'acme/embed-b' }],
    boards: [{ id: 'asr:en', source: 'open-asr', title: 'Open ASR', kind: 'transcription', metric: 'WER', direction: 'lower', url: 'u', published_at: null, version: 'v', checked_at: '2026-10-01T00:00:00Z' }],
    boardResults: [{ board: 'asr:en', model: 'Other', score: 3, model_id: null }, { board: 'asr:en', model: 'Ears', score: 5, model_id: 'lab/ears' }, { board: 'asr:en', model: 'Best', score: 2, model_id: null }],
    mteb: [{ name: 'MTEB(eng)', version: 'm1', description: 'English retrieval.', task_types: '["Retrieval"]', checked_at: '2026-10-02T00:00:00Z' }],
    mtebResults: [{ benchmark: 'MTEB(eng)', model: 'Qwen/Qwen3-Embedding-8B-HF', rank: 4, score: 70.1, model_id: null }, { benchmark: 'MTEB(eng)', model: 'shared/embed', rank: 1, score: 75, model_id: null },
      { benchmark: 'MTEB(eng)', model: 'acme/embed-a', rank: 9, score: null, model_id: null }] }, []);
  const results = Object.fromEntries(payloads.map(p => [p.id, p.boards]));
  // WER: lower is better, so 5 ranks third of three.
  assert.deepEqual(results['lab/ears'], [{ board: 'asr:en', score: 5, rank: 3, of: 3, observedAt: '2026-10-01T00:00:00Z' }]);
  // The repository matches case-insensitively; a repository two models share links neither; a model ID links directly.
  assert.deepEqual(results['qwen/qwen3-embedding-8b'], [{ board: 'mteb:MTEB(eng)', score: 70.1, rank: 4, of: 3, observedAt: '2026-10-02' }]);
  assert.deepEqual(results['acme/embed-a'], [{ board: 'mteb:MTEB(eng)', score: null, rank: 9, of: 3, observedAt: '2026-10-02' }]);
  assert.deepEqual(results['acme/embed-b'], []);
  assert.deepEqual(published.map(b => [b.id, b.direction, b.results, b.linked]), [['asr:en', 'lower', 3, 1], ['mteb:MTEB(eng)', 'higher', 3, 2]]);
});

// Live catalogue tables in an in-memory D1, the same SQL the refresh writes.
function liveCatalogue() {
  const db = d1();
  for (const sql of [...catalogueSchema,
    'CREATE TABLE cat_boards (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, metric TEXT NOT NULL, direction TEXT NOT NULL, url TEXT NOT NULL, license TEXT NOT NULL, published_at TEXT, version TEXT NOT NULL, artifact TEXT NOT NULL, results INTEGER NOT NULL, linked INTEGER NOT NULL, checked_at TEXT NOT NULL)',
    'CREATE TABLE cat_board_results (board TEXT NOT NULL, version TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, creator TEXT, score REAL NOT NULL, ci_lower REAL, ci_upper REAL, samples INTEGER, released TEXT, model_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(board,version,model,variant))',
    'CREATE TABLE scout_models (version TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(version,id))']) db.all(sql);
  const merged = (id: string, kind: string | null, name: string, inputs: string[], outputs: string[]) =>
    db.all("INSERT INTO cat_model_merged (id,kind,name,release_date,open_weights,input_modalities,output_modalities,sources,provenance) VALUES (?,?,?,'2026-05-01',0,?,?,'[]','{}')", id, kind, name, JSON.stringify(inputs), JSON.stringify(outputs));
  const offering = (provider: string, providerModel: string, modelId: string, prices: Array<[string, string, number]>) => {
    db.all("INSERT INTO cat_offerings (provider_id,provider_model_id,model_id,sources,first_seen,last_seen) VALUES (?,?,?,'[]','t','t')", provider, providerModel, modelId);
    for (const [kind, unit, amount] of prices) db.all("INSERT INTO cat_prices (source,provider_id,provider_model_id,kind,tier,unit,amount,valid_from) VALUES ('modelsdev',?,?,?,'',?,?,'t')", provider, providerModel, kind, unit, amount);
  };
  merged('lab/chat', 'chat', 'Lab Chat', ['text'], ['text']);
  merged('acme/scribe', 'transcription', 'Acme Scribe', ['audio'], ['text']);
  merged('acme/canvas', 'image', 'Acme Canvas', ['text'], ['image']);
  offering('speechco', 'scribe-v2', 'acme/scribe', [['input', 'usd_per_second', 0.0002], ['cache_read', 'usd_per_mtok', 1]]);
  offering('pixels', 'canvas-1', 'acme/canvas', [['output_image', 'usd_per_image', 0.03], ['web_search', 'usd_per_query', 0.01]]);
  db.all("INSERT INTO cat_boards VALUES ('asr:en','open-asr','Open ASR · English','transcription','WER (%)','lower','https://asr.example','none',NULL,'b1','a',2,1,'2026-10-01')");
  db.all("INSERT INTO cat_board_results (board,version,model,variant,score,model_id,payload) VALUES ('asr:en','b1','Acme Scribe','',4.1,'acme/scribe','{}'),('asr:en','b1','Other','',3.2,NULL,'{}')");
  // Scout's reviewed chat record for the same version; the agent keeps it unchanged.
  db.all("INSERT INTO scout_models VALUES ('v1','lab/chat',?)", JSON.stringify({ id: 'lab/chat', name: 'Lab Chat', provider: 'Lab', endpoints: [{ id: 'gw:chat', provider: 'Gateway', modelId: 'chat', inputPrice: 1, outputPrice: 4, modalities: ['text'], outputModalities: ['text'] }], evidence: [{ benchmark: 'b1', score: 0.8 }] }));
  return db;
}
const bindings = (db: ReturnType<typeof d1>, vectors?: CatalogueBindings['SCOUT_EVIDENCE']): CatalogueBindings => ({
  SCOUT_CATALOGUE: { get: async (key: string) => { const value = key === 'active.json' ? { key: 'manifests/v1.json' } : key === 'manifests/v1.json' ? { publication: { id: 'v1' }, benchmarks: [{ id: 'b1', name: 'Bench One' }], evidenceIndex: { documents: [] } } : null; return value ? { json: async <T>() => value as T } : null; } },
  SCOUT_INDEX: db, SCOUT_EVIDENCE: vectors ?? { query: async () => ({ matches: [] }) },
});

test('the agent reads the published version, not live catalogue tables that change during a refresh', async () => {
  const db = liveCatalogue(), payloads = db.all("SELECT payload FROM scout_models WHERE version='v1'").map(r => JSON.parse(String(r.payload)) as Record<string, unknown>);
  const manifest = { benchmarks: [{ id: 'b1', name: 'Bench One' }], evidenceIndex: { documents: [] } };
  const staged = await stageAgentCatalogue(db, 'v1', manifest, payloads, { now: '2026-10-29T00:00:00Z' });
  assert.deepEqual(staged, { version: 'v1', models: 3, boards: 1, documents: 5, vectors: null });
  // The next refresh changes the live tables before it publishes.
  db.all("UPDATE cat_prices SET amount=0.9 WHERE provider_model_id='scribe-v2'");
  db.all("INSERT INTO cat_model_merged (id,kind,name,sources,provenance) VALUES ('acme/newscribe','transcription','Acme Newscribe Transcription','[]','{}')");
  db.all("UPDATE cat_model_merged SET kind='chat' WHERE id='acme/canvas'");
  const catalogue = await loadCatalogue(bindings(db), async () => [[]]);
  assert.deepEqual(catalogue.models.map(m => [m.id, m.kind]).sort(), [['acme/canvas', 'image'], ['acme/scribe', 'transcription'], ['lab/chat', 'chat']]);
  const scribe = catalogue.models.find(m => m.id === 'acme/scribe');
  assert.deepEqual(scribe?.endpoints.map(e => e.rates), [[{ unit: 'second', kind: 'input', amount: 0.0002 }]]);
  // The reviewed chat record keeps its route and benchmark evidence.
  const chat = catalogue.models.find(m => m.id === 'lab/chat');
  assert.deepEqual([chat?.endpoints.map(e => [e.provider, e.inputPrice, e.outputPrice]), chat?.evidence.map(e => e.benchmark), chat?.releaseDate], [[['Gateway', 1, 4]], ['b1'], '2026-05-01']);
  assert.deepEqual(catalogue.boards.map(b => b.id), ['asr:en']);
  // BM25 runs on the published FTS5 index: the new live model is absent, and the field that matched is reported.
  const found = await searchCatalogue(catalogue, { query: 'transcribe call audio', mode: 'bm25' });
  assert.deepEqual(found.results.map(r => [r.type, r.id, r.matched]), [['model', 'acme/scribe', ['description']], ['board', 'asr:en', ['description']]]);
  const named = await searchCatalogue(catalogue, { query: 'canvas', types: ['model'], kind: 'image' });
  assert.equal(named.mode, 'bm25');
  assert.match(named.note ?? '', /published without catalogue embeddings/);
  assert.deepEqual(named.results.map(r => [r.id, r.matched]), [['acme/canvas', ['name', 'aliases']]]);
  // Staging again is a no-op for a ready version.
  assert.deepEqual(await stageAgentCatalogue(db, 'v1', manifest, payloads), { version: 'v1', models: 3, boards: 1, documents: 5, vectors: null });
});

test('vectors are upserted once per content in a shared namespace and pruned once no retained version uses them', async () => {
  const db = liveCatalogue(), payloads: Array<Record<string, unknown>> = [], cache = new Map<string, unknown>();
  let upserts: Array<{ id: string; namespace: string; metadata: Record<string, string> }> = [];
  let embedded = 0, failDeletes = false; const deleted: string[] = [], staged: Record<string, typeof upserts> = {};
  const options = (now: string) => ({ now, keep: ['v1'], cache: { get: async (k: string) => cache.get(k), put: async (k: string, v: unknown) => { cache.set(k, v); } },
    embed: async (texts: string[]) => { embedded += texts.length; return texts.map(() => Array.from({ length: 256 }, () => 0.1)); },
    vectorize: { upsert: async (rows: typeof upserts) => { upserts.push(...rows); return { mutationId: 'm' }; }, deleteByIds: async (ids: string[]) => { if (failDeletes) throw new Error('Vectorize busy'); assert.ok(ids.length <= 20, 'Vectorize takes at most 20 IDs per call'); deleted.push(...ids); } } });
  const stage = async (v: string, day: number) => { upserts = []; const r = await stageAgentCatalogue(db, v, { benchmarks: [] }, payloads, options(`2026-10-0${day}T00:00:00Z`)); staged[v] = upserts; return r; };
  // A version staged before the shared namespace, with its own namespace and vector IDs.
  for (const sql of agentSchema) db.all(sql);
  db.all("INSERT INTO scout_agent_versions (id,ready,models,boards,documents,vectors,staged_at) VALUES ('v0',1,1,0,1,'agent-v0','2026-09-01T00:00:00Z')");
  db.all("INSERT INTO scout_agent_search (version,type,id,kind,name,aliases,description) VALUES ('v0','model','acme/old','image','Old','','')");
  const first = await stage('v1', 1);
  assert.deepEqual([first.vectors, first.embedded, embedded], ['agent', 4, 4]);
  assert.deepEqual(staged.v1?.map(u => [u.namespace, u.metadata.type, u.metadata.id]).sort(), [['agent', 'board', 'asr:en'], ['agent', 'model', 'acme/canvas'], ['agent', 'model', 'acme/scribe'], ['agent', 'model', 'lab/chat']]);
  // Each later version upserts only the document whose text changed: v2 and v3 rename Canvas.
  db.all("UPDATE cat_model_merged SET name='Acme Canvas 2' WHERE id='acme/canvas'");
  await stage('v2', 2);
  db.all("UPDATE cat_model_merged SET name='Acme Canvas 3' WHERE id='acme/canvas'");
  for (let i = 3; i <= 8; i++) await stage(`v${i}`, i);
  assert.deepEqual([embedded, staged.v2?.length, staged.v3?.length, staged.v4?.length, staged.v8?.length], [6, 1, 1, 0, 0]);
  // Five recent versions survive besides the one staged, plus v1, which is published.
  assert.deepEqual(db.all('SELECT id FROM scout_agent_versions ORDER BY id').map(r => r.id), ['v1', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']);
  assert.equal(db.all("SELECT count(*) n FROM scout_agent_search WHERE version='v2'")[0]?.n, 0);
  // Deleted: v0's own vector and v2's Canvas 2, which no retained version uses. Shared vectors v2 used stay.
  assert.deepEqual(deleted.sort(), [String(await digest(['agent-v0', 'model', 'acme/old'])), staged.v2?.[0]?.id ?? ''].sort());
  // A failed delete is reported and keeps the version (v3) for the next publication, which resumes it.
  db.all("INSERT INTO scout_agent_vectors (version,id,type,doc) VALUES ('v3','only-v3','model','acme/gone')");
  failDeletes = true;
  assert.deepEqual((await stage('v9', 9)).pruned, { versions: 0, deleted: 0, remaining: 1, error: 'Vectorize busy' });
  assert.equal(db.all("SELECT count(*) n FROM scout_agent_versions WHERE id='v3'")[0]?.n, 1);
  failDeletes = false;
  db.all("UPDATE scout_agent_versions SET staged_at='2026-10-10T00:00:00Z' WHERE id='v9'");
  assert.deepEqual((await stageAgentCatalogue(db, 'v10', { benchmarks: [] }, payloads, options('2026-10-11T00:00:00Z'))).pruned, { versions: 2, deleted: 1, remaining: 0 });
  assert.equal(deleted.at(-1), 'only-v3');
  assert.deepEqual(db.all('SELECT id FROM scout_agent_versions ORDER BY id').map(r => r.id), ['v1', 'v10', 'v5', 'v6', 'v7', 'v8', 'v9']);
  // The published version's vectors are what the agent counts; Canvas 2's vector (another version's) is dropped.
  const queried: string[] = [], scribe = staged.v1?.find(u => u.metadata.id === 'acme/scribe')?.id ?? '';
  const query = async (_v: number[], o: { namespace?: string }) => { queried.push(o.namespace ?? ''); return { matches: [{ id: scribe, score: 0.9, metadata: { type: 'model', id: 'acme/scribe' } }, { id: staged.v2?.[0]?.id ?? '', score: 0.85, metadata: { type: 'model', id: 'acme/canvas' } }, { id: 'x', score: 0.8, metadata: { type: 'model', id: 'acme/elsewhere' } }] }; };
  const catalogue = await loadCatalogue(bindings(db, { query }), async texts => texts.map(() => [0.1]));
  assert.equal(await catalogue.search.embedding('speech to text', { limit: 5 }).catch((e: Error) => e.message), 'OPENAI_API_KEY is not configured');
  const keyed = await loadCatalogue({ ...bindings(db, { query }), OPENAI_API_KEY: 'k' }, async texts => texts.map(() => [0.1]));
  assert.deepEqual((await keyed.search.embedding('speech to text', { limit: 5 })).map(h => h.id), ['acme/scribe']);
  const hybrid = await searchCatalogue(keyed, { query: 'speech to text' });
  assert.equal(hybrid.mode, 'hybrid');
  assert.deepEqual(queried, ['agent', 'agent']);
  // Scribe leads both lists; "text" also matches the other models' modalities.
  assert.deepEqual(hybrid.results.map(r => [r.id, r.matched]), [['acme/scribe', ['description', 'meaning']], ['asr:en', ['description']], ['lab/chat', ['description']], ['acme/canvas', ['description']]]);
});
