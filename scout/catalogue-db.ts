// Source-backed model catalogue in D1. Models.dev is the backbone: its
// canonical model IDs (lab/model) identify models, and its provider entries are
// routes. Every other source adds its own listings of provider routes beside
// them. Each source keeps its own rows, prices are dated intervals and nothing a
// source stops listing is deleted, only marked withdrawn.

// The subset of D1 and R2 this module uses. Runtime Worker types are not
// committed yet (docs/site-typescript-migration.md), and tests pass SQLite.
type Value = string | number | null;
export interface Statement {
  bind(...values: Value[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  all<Row = Record<string, Value>>(): Promise<{ results: Row[] }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Array<{ meta: { changes: number } }>>;
}
export interface Bucket {
  head(key: string): Promise<unknown>;
  put(key: string, value: Uint8Array, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export type CatalogueSource = 'modelsdev' | 'litellm';

interface SourceConfig { name: string; url: string; modelsURL?: string; license: string; role: string; maxBytes: number }
export const catalogueSources: Record<CatalogueSource, SourceConfig> = {
  modelsdev: { name: 'Models.dev', url: 'https://models.dev/api.json', modelsURL: 'https://models.dev/models.json', license: 'MIT', role: 'Model identity, families and provider routes (backbone)', maxBytes: 20_000_000 },
  litellm: { name: 'LiteLLM model prices', url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', license: 'MIT', role: 'Provider routes and prices', maxBytes: 12_000_000 },
};

// One statement per entry: D1 exec splits on newlines, so schema goes through batch.
export const catalogueSchema = [
  'CREATE TABLE IF NOT EXISTS cat_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, license TEXT, role TEXT, last_success_at TEXT, last_run TEXT)',
  'CREATE TABLE IF NOT EXISTS cat_runs (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, artifact TEXT, artifact_bytes INTEGER, listings INTEGER, added INTEGER, changed INTEGER, withdrawn INTEGER, unresolved INTEGER, prices_opened INTEGER, prices_closed INTEGER, error TEXT)',
  'CREATE TABLE IF NOT EXISTS cat_providers (source TEXT NOT NULL, id TEXT NOT NULL, name TEXT, api TEXT, doc TEXT, npm TEXT, env TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(source,id))',
  'CREATE TABLE IF NOT EXISTS cat_models (id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, name TEXT, family TEXT, description TEXT, type TEXT, release_date TEXT, last_updated TEXT, knowledge TEXT, open_weights INTEGER, license TEXT, weights TEXT, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, attachment INTEGER, temperature INTEGER, context INTEGER, max_output INTEGER, basis TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT)',
  'CREATE INDEX IF NOT EXISTS cat_models_lab ON cat_models(lab_id)',
  'CREATE TABLE IF NOT EXISTS cat_listings (source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, model_id TEXT, model_basis TEXT, name TEXT, family TEXT, type TEXT, status TEXT, release_date TEXT, knowledge TEXT, deprecated_at TEXT, context INTEGER, max_input INTEGER, max_output INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, structured_output INTEGER, attachment INTEGER, open_weights INTEGER, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT, PRIMARY KEY(source,provider_id,provider_model_id))',
  'CREATE INDEX IF NOT EXISTS cat_listings_route ON cat_listings(provider_id,provider_model_id)',
  'CREATE INDEX IF NOT EXISTS cat_listings_model ON cat_listings(model_id)',
  'CREATE TABLE IF NOT EXISTS cat_prices (source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, PRIMARY KEY(source,provider_id,provider_model_id,kind,tier,unit,valid_from))',
  'CREATE INDEX IF NOT EXISTS cat_prices_route ON cat_prices(provider_id,provider_model_id,valid_to)',
  'CREATE TABLE IF NOT EXISTS cat_price_stage (run TEXT NOT NULL, source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL)',
  'CREATE INDEX IF NOT EXISTS cat_price_stage_key ON cat_price_stage(run,provider_id,provider_model_id,kind,tier,unit)',
  'CREATE TABLE IF NOT EXISTS cat_offerings (provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, model_id TEXT, model_basis TEXT, sources TEXT NOT NULL, name TEXT, family TEXT, type TEXT, status TEXT, release_date TEXT, deprecated_at TEXT, context INTEGER, max_input INTEGER, max_output INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, structured_output INTEGER, attachment INTEGER, open_weights INTEGER, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(provider_id,provider_model_id))',
  'CREATE INDEX IF NOT EXISTS cat_offerings_model ON cat_offerings(model_id)',
];

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Json => isObject(v) ? v : {};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : null;
const bool = (v: unknown): number | null => typeof v === 'boolean' ? Number(v) : null;
const int = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
const list = (v: unknown): string | null => Array.isArray(v) && v.length && v.every(x => typeof x === 'string') ? JSON.stringify(v) : null;
const date = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?/.test(v) ? v.slice(0, 10) : null;
const id = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 300 ? v : null;
// Rate arithmetic (per token × 1e6) must not create spurious price changes.
const money = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Number(v.toPrecision(12)) : null;

// Content hash with sorted object keys, so key order never changes a hash.
const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v) ?? 'null';
const hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const digest = (value: unknown): Promise<string> => hex(new TextEncoder().encode(stable(value)));

export interface Price { kind: string; tier: string; unit: string; amount: number }
export interface Provider { id: string; name: string | null; api: string | null; doc: string | null; npm: string | null; env: string | null }
interface RouteFields {
  name: string | null; family: string | null; type: string | null; status: string | null; release_date: string | null; knowledge: string | null; deprecated_at: string | null;
  context: number | null; max_input: number | null; max_output: number | null; input_modalities: string | null; output_modalities: string | null;
  reasoning: number | null; tool_call: number | null; structured_output: number | null; attachment: number | null; open_weights: number | null;
}
export interface Listing extends RouteFields { provider_id: string; provider_model_id: string; model_id: string | null; model_basis: string | null; prices: Price[]; payload: Json }
export interface Model {
  id: string; lab_id: string; name: string | null; family: string | null; description: string | null; type: string | null; release_date: string | null; last_updated: string | null;
  knowledge: string | null; open_weights: number | null; license: string | null; weights: string | null; input_modalities: string | null; output_modalities: string | null;
  reasoning: number | null; tool_call: number | null; attachment: number | null; temperature: number | null; context: number | null; max_output: number | null; basis: string; payload: Json;
}
export interface Parsed { providers: Provider[]; listings: Listing[]; models: Model[] }

// Models.dev cost fields are USD per million tokens; tiers become a tier label.
function modelsDevPrices(cost: Json): Price[] {
  const out = new Map<string, Price>();
  const flat = (c: Json, tier: string) => { for (const [kind, v] of Object.entries(c)) { const amount = money(v); if (amount !== null) out.set(`${kind}|${tier}`, { kind, tier, unit: 'usd_per_mtok', amount }); } };
  flat(cost, '');
  if (isObject(cost.context_over_200k)) flat(cost.context_over_200k, 'context>200000');
  for (const t of Array.isArray(cost.tiers) ? cost.tiers : []) {
    const entry = obj(t), tier = obj(entry.tier), size = int(tier.size);
    const label = tier.type === 'context' && size ? `context>${size}` : text(tier.type);
    if (label) flat(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'tier')), label);
  }
  return [...out.values()];
}

const route = (m: Json): RouteFields => {
  const limit = obj(m.limit), modalities = obj(m.modalities);
  return { name: text(m.name), family: text(m.family), type: text(m.type), status: text(m.status), release_date: date(m.release_date), knowledge: date(m.knowledge), deprecated_at: null,
    context: int(limit.context), max_input: int(limit.input), max_output: int(limit.output), input_modalities: list(modalities.input), output_modalities: list(modalities.output),
    reasoning: bool(m.reasoning), tool_call: bool(m.tool_call), structured_output: bool(m.structured_output), attachment: bool(m.attachment), open_weights: bool(m.open_weights) };
};

export function parseModelsDev(api: unknown, models: unknown): Parsed {
  if (!isObject(api) || !isObject(obj(api.openai).models) || !isObject(obj(api.anthropic).models)) throw new Error('Models.dev provider catalogue format changed.');
  const providers: Provider[] = [], listings: Listing[] = [], catalogue = new Map<string, Json & { basis: string }>(), referenced = new Map<string, Json>();
  for (const raw of Object.values(api)) {
    const p = obj(raw), providerId = id(p.id);
    if (!providerId) continue;
    providers.push({ id: providerId, name: text(p.name), api: text(p.api), doc: text(p.doc), npm: text(p.npm), env: list(p.env) });
    for (const value of Object.values(obj(p.models))) {
      const m = obj(value), modelId = id(m.id);
      if (!modelId) continue;
      const canonical = id(m.canonical_model_id);
      listings.push({ provider_id: providerId, provider_model_id: modelId, model_id: canonical, model_basis: canonical ? 'modelsdev-canonical' : null, ...route(m), prices: modelsDevPrices(obj(m.cost)), payload: m });
      if (canonical && !referenced.has(canonical)) referenced.set(canonical, m);
    }
  }
  for (const value of Object.values(obj(models))) { const m = obj(value), modelId = id(m.id); if (modelId?.includes('/')) catalogue.set(modelId, { ...m, basis: 'modelsdev-model' }); }
  // Canonical IDs that providers reference but models.json lacks still become
  // models, described by the first provider entry rather than dropped.
  for (const [canonical, m] of referenced) if (!catalogue.has(canonical) && canonical.includes('/')) catalogue.set(canonical, { ...m, id: canonical, basis: 'modelsdev-route' });
  const rows = [...catalogue].map(([modelId, m]): Model => {
    const limit = obj(m.limit), modalities = obj(m.modalities);
    return { id: modelId, lab_id: modelId.split('/')[0] ?? modelId, name: text(m.name), family: text(m.family), description: text(m.description), type: text(m.type),
      release_date: date(m.release_date), last_updated: date(m.last_updated), knowledge: date(m.knowledge), open_weights: bool(m.open_weights), license: text(m.license),
      weights: typeof m.weights === 'string' ? text(m.weights) : m.weights ? JSON.stringify(m.weights) : null, input_modalities: list(modalities.input), output_modalities: list(modalities.output),
      reasoning: bool(m.reasoning), tool_call: bool(m.tool_call), attachment: bool(m.attachment), temperature: bool(m.temperature), context: int(limit.context), max_output: int(limit.output), basis: m.basis, payload: m };
  });
  return { providers, listings, models: rows };
}

// LiteLLM provider names that differ from Models.dev provider IDs. Names equal
// to a known Models.dev provider ID map directly; others stay namespaced
// (litellm:<name>) instead of being guessed.
export const litellmProviders: Record<string, string> = {
  bedrock: 'amazon-bedrock', bedrock_converse: 'amazon-bedrock', bedrock_mantle: 'amazon-bedrock', azure_ai: 'azure', azure_text: 'azure', 'text-completion-openai': 'openai',
  cloudflare: 'cloudflare-workers-ai', codestral: 'mistral', 'text-completion-codestral': 'mistral', cohere_chat: 'cohere', dashscope: 'alibaba', gemini: 'google',
  vertex_ai: 'google-vertex', 'vertex_ai-language-models': 'google-vertex', 'vertex_ai-embedding-models': 'google-vertex', 'vertex_ai-text-models': 'google-vertex', 'vertex_ai-video-models': 'google-vertex',
  'vertex_ai-mistral_models': 'google-vertex', 'vertex_ai-deepseek_models': 'google-vertex', 'vertex_ai-ai21_models': 'google-vertex', 'vertex_ai-llama_models': 'google-vertex', 'vertex_ai-minimax_models': 'google-vertex',
  'vertex_ai-moonshot_models': 'google-vertex', 'vertex_ai-zai_models': 'google-vertex', 'vertex_ai-openai_models': 'google-vertex', 'vertex_ai-qwen_models': 'google-vertex', 'vertex_ai-anthropic_models': 'google-vertex-anthropic',
  fireworks_ai: 'fireworks-ai', 'fireworks_ai-embedding-models': 'fireworks-ai', friendliai: 'friendli', 'text-completion-inception': 'inception', moonshot: 'moonshotai', nvidia_nim: 'nvidia',
  snowflake: 'snowflake-cortex', together_ai: 'togetherai', vercel_ai_gateway: 'vercel', novita: 'novita-ai', xiaomi_mimo: 'xiaomi', github_copilot: 'github-copilot', opencode_go: 'opencode-go',
};
const tokenKinds: Record<string, string> = { input_cost_per_token: 'input', output_cost_per_token: 'output', cache_read_input_token_cost: 'cache_read', cache_creation_input_token_cost: 'cache_write',
  output_cost_per_reasoning_token: 'reasoning', input_cost_per_audio_token: 'input_audio', output_cost_per_audio_token: 'output_audio', input_cost_per_image_token: 'input_image',
  output_cost_per_image_token: 'output_image', input_cost_per_video_token: 'input_video', output_cost_per_video_token: 'output_video', cache_read_input_audio_token_cost: 'cache_read_audio',
  cache_creation_input_audio_token_cost: 'cache_write_audio', cache_read_input_image_token_cost: 'cache_read_image' };
const tokenPrice = new RegExp(`^(${Object.keys(tokenKinds).join('|')})(?:_above_(1hr|12hr))?(?:_above_(\\d+)k_tokens)?(?:_(batches|priority|flex|ultrafast|balanced))?$`);
const unitPrices: Record<string, [kind: string, unit: string, scale: number]> = { input_cost_per_image: ['input_image', 'usd_per_image', 1], output_cost_per_image: ['output_image', 'usd_per_image', 1],
  input_cost_per_second: ['input', 'usd_per_second', 1], output_cost_per_second: ['output', 'usd_per_second', 1], input_cost_per_character: ['input', 'usd_per_mchar', 1e6], output_cost_per_character: ['output', 'usd_per_mchar', 1e6],
  input_cost_per_video_per_second: ['input_video', 'usd_per_second', 1], input_cost_per_audio_per_second: ['input_audio', 'usd_per_second', 1], input_cost_per_query: ['query', 'usd_per_query', 1],
  input_cost_per_request: ['request', 'usd_per_request', 1], ocr_cost_per_page: ['ocr', 'usd_per_page', 1] };
// Fields not recognized here remain in the stored payload.
function litellmPrices(entry: Json): Price[] {
  const out = new Map<string, Price>();
  for (const [field, value] of Object.entries(entry)) {
    if (typeof value !== 'number') continue;
    const t = tokenPrice.exec(field), u = unitPrices[field];
    let price: Price | null = null;
    if (t?.[1]) {
      const tier = [t[3] && `context>${Number(t[3]) * 1000}`, t[2] && `cache-ttl>${t[2]}`, t[4]].filter(Boolean).join(','), amount = money(value * 1e6), kind = tokenKinds[t[1]];
      if (amount !== null && kind) price = { kind, tier, unit: 'usd_per_mtok', amount };
    } else if (u) {
      const amount = money(value * u[2]);
      if (amount !== null) price = { kind: u[0], tier: '', unit: u[1], amount };
    }
    if (price) out.set(`${price.kind}|${price.tier}|${price.unit}`, price);
  }
  return [...out.values()];
}
const outputs: Record<string, string[]> = { chat: ['text'], completion: ['text'], responses: ['text'], realtime: ['text', 'audio'], embedding: ['embedding'], image_generation: ['image'], image_edit: ['image'],
  audio_transcription: ['text'], audio_speech: ['audio'], video_generation: ['video'], ocr: ['text'], rerank: ['ranking'] };
// Search tools and vector stores are priced services, not models.
const notModels = new Set(['search', 'vector_store']);

export function parseLiteLLM(data: unknown, knownProviders: ReadonlySet<string> = new Set()): Parsed {
  if (!isObject(data) || !isObject(data['gpt-4o'])) throw new Error('LiteLLM price catalogue format changed.');
  const providers = new Map<string, Provider>(), listings = new Map<string, Listing>();
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, '');
  for (const [key, value] of Object.entries(data)) {
    const e = obj(value), name = id(e.litellm_provider), mode = text(e.mode);
    if (key === 'sample_spec' || !name || (mode && notModels.has(mode))) continue;
    const hyphenated = name.replace(/_/g, '-');
    const provider = litellmProviders[name] ?? (knownProviders.has(name) ? name : knownProviders.has(hyphenated) ? hyphenated : `litellm:${name}`);
    providers.set(provider, { id: provider, name, api: null, doc: null, npm: null, env: null });
    // Keys carry LiteLLM's routing prefix (azure/…, vertex_ai/…); the provider's own ID follows it.
    const [head = '', ...rest] = key.split('/'), p = norm(name), h = norm(head);
    const modelId = id(rest.length && (p.startsWith(h) || p.endsWith(h)) ? rest.join('/') : key);
    if (!modelId) continue;
    const input = ['text', e.supports_vision && 'image', e.supports_audio_input && 'audio', e.supports_pdf_input && 'pdf'].filter((x): x is string => typeof x === 'string');
    const output = mode ? outputs[mode] : undefined;
    const row: Listing = { provider_id: provider, provider_model_id: modelId, model_id: null, model_basis: null, name: null, family: null, type: mode, status: null, release_date: null, knowledge: null,
      deprecated_at: date(e.deprecation_date), context: int(e.max_input_tokens ?? e.max_tokens), max_input: int(e.max_input_tokens), max_output: int(e.max_output_tokens),
      input_modalities: mode && ['chat', 'completion', 'responses'].includes(mode) ? JSON.stringify(input) : null, output_modalities: output ? JSON.stringify(output) : null,
      reasoning: bool(e.supports_reasoning), tool_call: bool(e.supports_function_calling), structured_output: bool(e.supports_response_schema), attachment: null, open_weights: null,
      prices: litellmPrices(e), payload: { key, ...e } };
    // Two LiteLLM keys can name one route (for example with and without a prefix); keep the first.
    const k = `${provider}|${modelId}`;
    if (!listings.has(k)) listings.set(k, row);
  }
  return { providers: [...providers.values()], listings: [...listings.values()], models: [] };
}

interface BackboneRoute { provider_id: string; provider_model_id: string; model_id: string | null }
// Identity comes only from Models.dev: the same route, or the identical
// provider model ID mapped to exactly one canonical model elsewhere.
export function resolveListings(listings: Listing[], backbone: BackboneRoute[]): Listing[] {
  const routes = new Map<string, string>(), byId = new Map<string, Set<string>>();
  for (const r of backbone) {
    if (!r.model_id) continue;
    routes.set(`${r.provider_id}|${r.provider_model_id}`, r.model_id);
    const set = byId.get(r.provider_model_id) ?? new Set<string>(); set.add(r.model_id); byId.set(r.provider_model_id, set);
  }
  for (const l of listings) {
    const exact = routes.get(`${l.provider_id}|${l.provider_model_id}`), same = byId.get(l.provider_model_id);
    if (exact) Object.assign(l, { model_id: exact, model_basis: 'modelsdev-route' });
    else if (same?.size === 1) Object.assign(l, { model_id: [...same][0] ?? null, model_basis: 'modelsdev-same-id' });
  }
  return listings;
}

const listingColumns = ['provider_id', 'provider_model_id', 'model_id', 'model_basis', 'name', 'family', 'type', 'status', 'release_date', 'knowledge', 'deprecated_at', 'context', 'max_input', 'max_output',
  'input_modalities', 'output_modalities', 'reasoning', 'tool_call', 'structured_output', 'attachment', 'open_weights', 'payload', 'payload_hash'];
const modelColumns = ['id', 'lab_id', 'name', 'family', 'description', 'type', 'release_date', 'last_updated', 'knowledge', 'open_weights', 'license', 'weights', 'input_modalities', 'output_modalities',
  'reasoning', 'tool_call', 'attachment', 'temperature', 'context', 'max_output', 'basis', 'payload', 'payload_hash'];
type Row = Record<string, Value>;
const pick = (columns: string[], row: Record<string, unknown>): Row => Object.fromEntries(columns.map(c => { const v = row[c]; return [c, typeof v === 'string' || typeof v === 'number' ? v : null]; }));
const extract = (columns: string[]) => columns.map(c => `json_extract(value,'$.${c}')`).join(',');
const updates = (columns: string[], skip: string[]) => columns.filter(c => !skip.includes(c)).map(c => `${c}=excluded.${c}`).join(',');

// Rows go to D1 as JSON arrays expanded by json_each, bounded per statement.
async function chunked(db: Database, sql: string, rows: readonly object[], bindings: Value[], size = 150): Promise<void> {
  for (let i = 0; i < rows.length; i += size * 8) {
    const statements: Statement[] = [];
    for (let j = i; j < Math.min(rows.length, i + size * 8); j += size) statements.push(db.prepare(sql).bind(...bindings, JSON.stringify(rows.slice(j, j + size))));
    await db.batch(statements);
  }
}

export async function ensureCatalogueSchema(db: Database): Promise<void> { await db.batch(catalogueSchema.map(s => db.prepare(s))); }

export interface StoreStats { listings: number; added: number; changed: number; withdrawn: number; unresolved: number; prices_opened: number; prices_closed: number }
export async function storeCatalogue(db: Database, source: string, parsed: Parsed, { now, run, backbone }: { now: string; run: string; backbone: BackboneRoute[] | null }): Promise<StoreStats> {
  const listings = backbone ? resolveListings(parsed.listings, backbone) : parsed.listings;
  const existing = await db.prepare('SELECT provider_id,provider_model_id,payload_hash,withdrawn_at FROM cat_listings WHERE source=?').bind(source)
    .all<{ provider_id: string; provider_model_id: string; payload_hash: string; withdrawn_at: string | null }>();
  const prior = new Map(existing.results.map(r => [`${r.provider_id}|${r.provider_model_id}`, r]));
  const active = [...prior.values()].filter(r => !r.withdrawn_at).length;
  // A broken or truncated feed must not withdraw most of the catalogue.
  if (active > 50 && listings.length < active * .5) throw new Error(`${source} listings dropped from ${active} to ${listings.length}; previous rows retained.`);
  const rows: Row[] = []; let added = 0, changed = 0;
  for (const l of listings) {
    const row = pick(listingColumns, { ...l, payload: JSON.stringify(l.payload) });
    row.payload_hash = await digest([row.model_id, row.model_basis, l.payload]);
    const old = prior.get(`${l.provider_id}|${l.provider_model_id}`);
    if (!old) added++; else if (old.payload_hash !== row.payload_hash || old.withdrawn_at) changed++;
    rows.push(row);
  }
  await chunked(db, `INSERT INTO cat_listings (source,${listingColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ?1,${extract(listingColumns)},?2,?2,NULL FROM json_each(?3) WHERE true
    ON CONFLICT(source,provider_id,provider_model_id) DO UPDATE SET ${updates(listingColumns, ['provider_id', 'provider_model_id'])},last_seen=excluded.last_seen,withdrawn_at=NULL`, rows, [source, now]);
  const withdrawn = (await db.prepare('UPDATE cat_listings SET withdrawn_at=?1 WHERE source=?2 AND last_seen<?1 AND withdrawn_at IS NULL').bind(now, source).run()).meta.changes;
  await chunked(db, `INSERT INTO cat_providers (source,id,name,api,doc,npm,env,first_seen,last_seen) SELECT ?1,${extract(['id', 'name', 'api', 'doc', 'npm', 'env'])},?2,?2 FROM json_each(?3) WHERE true
    ON CONFLICT(source,id) DO UPDATE SET name=excluded.name,api=excluded.api,doc=excluded.doc,npm=excluded.npm,env=excluded.env,last_seen=excluded.last_seen`, parsed.providers, [source, now]);
  if (parsed.models.length) {
    const models: Row[] = [];
    for (const m of parsed.models) models.push({ ...pick(modelColumns, { ...m, payload: JSON.stringify(m.payload) }), payload_hash: await digest(m.payload) });
    await chunked(db, `INSERT INTO cat_models (${modelColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ${extract(modelColumns)},?1,?1,NULL FROM json_each(?2) WHERE true
      ON CONFLICT(id) DO UPDATE SET ${updates(modelColumns, ['id'])},last_seen=excluded.last_seen,withdrawn_at=NULL`, models, [now]);
    await db.prepare('UPDATE cat_models SET withdrawn_at=?1 WHERE last_seen<?1 AND withdrawn_at IS NULL').bind(now).run();
  }
  // Prices are intervals: an unchanged price stays open, a changed or removed one
  // closes now, and a new amount opens now. Staging keeps each statement bounded.
  const prices = listings.flatMap(l => l.prices.map(p => ({ provider_id: l.provider_id, provider_model_id: l.provider_model_id, ...p })));
  await db.prepare('DELETE FROM cat_price_stage WHERE source=?').bind(source).run();
  await chunked(db, `INSERT INTO cat_price_stage SELECT ?1,?2,${extract(['provider_id', 'provider_model_id', 'kind', 'tier', 'unit', 'amount'])} FROM json_each(?3)`, prices, [run, source], 400);
  const same = 's.run=?3 AND s.provider_id=p.provider_id AND s.provider_model_id=p.provider_model_id AND s.kind=p.kind AND s.tier=p.tier AND s.unit=p.unit AND s.amount=p.amount';
  const [closed, opened] = await db.batch([
    db.prepare(`UPDATE cat_prices AS p SET valid_to=?1 WHERE p.source=?2 AND p.valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM cat_price_stage s WHERE ${same})`).bind(now, source, run),
    db.prepare(`INSERT INTO cat_prices SELECT s.source,s.provider_id,s.provider_model_id,s.kind,s.tier,s.unit,s.amount,?1,NULL FROM cat_price_stage s WHERE s.run=?3 AND s.source=?2
      AND NOT EXISTS (SELECT 1 FROM cat_prices p WHERE p.source=?2 AND p.valid_to IS NULL AND ${same})`).bind(now, source, run),
    db.prepare('DELETE FROM cat_price_stage WHERE run=?').bind(run),
  ]);
  return { listings: listings.length, added, changed, withdrawn, unresolved: listings.filter(l => !l.model_id).length, prices_opened: opened?.meta.changes ?? 0, prices_closed: closed?.meta.changes ?? 0 };
}

// Offerings merge every source's listing of one provider route. Each field takes
// the first known value in source order, with Models.dev first.
const offeringFields = ['model_id', 'model_basis', 'name', 'family', 'type', 'status', 'release_date', 'deprecated_at', 'context', 'max_input', 'max_output', 'input_modalities', 'output_modalities',
  'reasoning', 'tool_call', 'structured_output', 'attachment', 'open_weights'];
export async function rebuildOfferings(db: Database): Promise<{ offerings: number }> {
  const live = 'l.provider_id=k.provider_id AND l.provider_model_id=k.provider_model_id AND l.withdrawn_at IS NULL';
  const order = "CASE l.source WHEN 'modelsdev' THEN 0 ELSE 1 END,l.source";
  const fields = offeringFields.map(f => `(SELECT l.${f} FROM cat_listings l WHERE ${live} AND l.${f} IS NOT NULL ORDER BY ${order} LIMIT 1)`).join(',');
  const [, inserted] = await db.batch([db.prepare('DELETE FROM cat_offerings'), db.prepare(`INSERT INTO cat_offerings (provider_id,provider_model_id,${offeringFields.join(',')},sources,first_seen,last_seen)
    SELECT k.provider_id,k.provider_model_id,${fields},(SELECT json_group_array(l.source) FROM cat_listings l WHERE ${live}),k.first_seen,k.last_seen
    FROM (SELECT provider_id,provider_model_id,min(first_seen) first_seen,max(last_seen) last_seen FROM cat_listings WHERE withdrawn_at IS NULL GROUP BY provider_id,provider_model_id) k`)]);
  return { offerings: inserted?.meta.changes ?? 0 };
}

async function readSource(fetcher: Fetcher, url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'OpenMerit-Scout/0.1 (+https://openmerit.ai/scout)' } });
  if (!response.ok || !response.body) throw new Error(`${new URL(url).hostname} returned ${response.status}.`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('Source exceeded size limit.'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return bytes;
}

export type ImportResult = ({ status: 'ok' } & StoreStats) | { status: 'failed'; error: string };
// Fetches one source, keeps its raw bytes content-addressed in R2, and stores
// its listings. Every attempt leaves a cat_runs row, including failures.
export async function importCatalogueSource(db: Database, source: CatalogueSource, options: { fetcher?: Fetcher; bucket?: Bucket; now?: string; run?: string } = {}): Promise<ImportResult> {
  const { fetcher = fetch, bucket, now = new Date().toISOString() } = options, run = options.run ?? `${source}-${now}`;
  const config = catalogueSources[source];
  await ensureCatalogueSchema(db);
  await db.batch([
    db.prepare('INSERT INTO cat_sources (id,name,url,license,role) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,license=excluded.license,role=excluded.role').bind(source, config.name, config.url, config.license, config.role),
    // A retried workflow step reuses its run ID.
    db.prepare("INSERT OR REPLACE INTO cat_runs (id,source,started_at,status) VALUES (?1,?2,?3,'running')").bind(run, source, now),
  ]);
  try {
    const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
    const files = [await readSource(fetcher, config.url, config.maxBytes), ...(config.modelsURL ? [await readSource(fetcher, config.modelsURL, config.maxBytes)] : [])];
    const hashes: string[] = [];
    for (const bytes of files) {
      const hash = await hex(bytes); hashes.push(hash);
      const key = `catalogue-raw/${source}/${hash}.json`;
      if (bucket && !await bucket.head(key)) await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json' } });
    }
    const [first, second] = files;
    if (!first) throw new Error('Source returned no data.');
    let parsed: Parsed, backbone: BackboneRoute[] | null = null;
    if (source === 'modelsdev') parsed = parseModelsDev(decode(first), second ? decode(second) : {});
    else {
      const known = new Set((await db.prepare("SELECT id FROM cat_providers WHERE source='modelsdev'").all<{ id: string }>()).results.map(r => r.id));
      parsed = parseLiteLLM(decode(first), known);
      backbone = (await db.prepare("SELECT provider_id,provider_model_id,model_id FROM cat_listings WHERE source='modelsdev' AND withdrawn_at IS NULL AND model_id IS NOT NULL").all<BackboneRoute>()).results;
    }
    files.length = 0;
    const stats = await storeCatalogue(db, source, parsed, { now, run, backbone });
    await db.batch([
      db.prepare("UPDATE cat_runs SET finished_at=?2,status='ok',artifact=?3,listings=?4,added=?5,changed=?6,withdrawn=?7,unresolved=?8,prices_opened=?9,prices_closed=?10 WHERE id=?1")
        .bind(run, new Date().toISOString(), hashes.join(','), stats.listings, stats.added, stats.changed, stats.withdrawn, stats.unresolved, stats.prices_opened, stats.prices_closed),
      db.prepare('UPDATE cat_sources SET last_success_at=?2,last_run=?3 WHERE id=?1').bind(source, now, run),
    ]);
    return { status: 'ok', ...stats };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    await db.prepare("UPDATE cat_runs SET finished_at=?2,status='failed',error=?3 WHERE id=?1").bind(run, new Date().toISOString(), message).run();
    return { status: 'failed', error: message };
  }
}
