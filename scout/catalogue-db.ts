// Source-backed model catalogue in D1. Models.dev is the backbone: its
// canonical model IDs (lab/model) identify models, and its provider entries are
// routes. Every other source adds its own listings of provider routes beside
// them. Each source keeps its own rows, prices are dated intervals and nothing a
// source stops listing is deleted, only marked withdrawn.

// The subset of D1 and R2 this module uses. Runtime Worker types are not
// committed yet (docs/site-typescript-migration.md), and tests pass SQLite.
import { unzipSync, strFromU8 } from 'fflate';
import { parse as parseYAML } from 'yaml';
import { reviewedModels, reviewedRoutes } from './catalogue-identities.ts';

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
export type CatalogueSource = 'modelsdev' | 'litellm' | 'openrouter' | 'vercel' | 'deepinfra' | 'genaiprices' | 'epoch' | 'portkey-deepgram' | 'portkey-elevenlabs' | 'portkey-stability-ai' | 'truefoundry' | 'edenai';

interface SourceConfig { name: string; url: string; modelsURL?: string; license: string; role: string; maxBytes: number }
// Import order matters: Models.dev first, as every later source resolves against it,
// then the gateways, whose lab/model IDs add identities the price lists resolve to.
export const catalogueSources: Record<CatalogueSource, SourceConfig> = {
  modelsdev: { name: 'Models.dev', url: 'https://models.dev/api.json?type=all', modelsURL: 'https://models.dev/models.json?type=all', license: 'MIT', role: 'Model identity, families and provider routes (backbone)', maxBytes: 20_000_000 },
  openrouter: { name: 'OpenRouter models API', url: 'https://openrouter.ai/api/v1/models?output_modalities=all', license: 'Public API; OpenRouter terms of service', role: 'Gateway routes, prices and Hugging Face IDs', maxBytes: 8_000_000 },
  vercel: { name: 'Vercel AI Gateway models API', url: 'https://ai-gateway.vercel.sh/v1/models', license: 'Public API; Vercel terms of service', role: 'Second gateway: routes, release dates and prices', maxBytes: 8_000_000 },
  litellm: { name: 'LiteLLM model prices', url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', license: 'MIT', role: 'Provider routes and prices', maxBytes: 12_000_000 },
  deepinfra: { name: 'DeepInfra models API', url: 'https://api.deepinfra.com/models/list', license: 'Public API; DeepInfra terms of service', role: "A host's own list: chat, media, audio, embedding, rerank and decision models with prices", maxBytes: 4_000_000 },
  genaiprices: { name: 'genai-prices (Pydantic)', url: 'https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json', license: 'MIT', role: 'Provider prices with tiers and dated changes', maxBytes: 8_000_000 },
  epoch: { name: 'Epoch AI models database', url: 'https://epoch.ai/data/all_ai_models.csv', license: 'CC BY 4.0', role: 'Model creators, countries, release dates, size and openness, including models no gateway lists', maxBytes: 30_000_000 },
  truefoundry: { name: 'TrueFoundry models registry', url: 'https://codeload.github.com/truefoundry/models/zip/refs/heads/main', license: 'MIT · Copyright (c) TrueFoundry · https://github.com/truefoundry/models/blob/main/LICENSE', role: 'Per-provider model configs: modes, modalities, limits and prices per region, including media, speech, rerank and decision models', maxBytes: 10_000_000 },
  'portkey-deepgram': { name: 'Portkey · Deepgram prices', url: 'https://configs.portkey.ai/pricing/deepgram.json', license: 'MIT · Copyright (c) 2025 Portkey.ai · https://github.com/Portkey-AI/models/blob/main/LICENSE', role: 'Reviewed Aura voice prices per character; not token prices', maxBytes: 1_000_000 },
  'portkey-elevenlabs': { name: 'Portkey · ElevenLabs prices', url: 'https://configs.portkey.ai/pricing/elevenlabs.json', license: 'MIT · Copyright (c) 2025 Portkey.ai · https://github.com/Portkey-AI/models/blob/main/LICENSE', role: 'Reviewed speech model prices per character or input-audio second', maxBytes: 1_000_000 },
  'portkey-stability-ai': { name: 'Portkey · Stability AI prices', url: 'https://configs.portkey.ai/pricing/stability-ai.json', license: 'MIT · Copyright (c) 2025 Portkey.ai · https://github.com/Portkey-AI/models/blob/main/LICENSE', role: 'Image prices with quality/size tiers', maxBytes: 1_000_000 },
  edenai: { name: 'Eden AI expert models', url: 'https://api.edenai.run/v3/info', license: 'Public API; licence not stated; Eden AI terms of service · https://www.edenai.co/terms', role: "A gateway's OCR, document parsing, translation, speech, moderation and AI-content detection routes with per-character, page, file, image, request and second prices, excluding its platform fee", maxBytes: 2_000_000 },
};

// One statement per entry: D1 exec splits on newlines, so schema goes through batch.
export const catalogueSchema = [
  'CREATE TABLE IF NOT EXISTS cat_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, license TEXT, role TEXT, last_success_at TEXT, last_run TEXT)',
  'CREATE TABLE IF NOT EXISTS cat_runs (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, artifact TEXT, artifact_bytes INTEGER, listings INTEGER, added INTEGER, changed INTEGER, withdrawn INTEGER, unresolved INTEGER, prices_opened INTEGER, prices_closed INTEGER, error TEXT)',
  'CREATE TABLE IF NOT EXISTS cat_providers (source TEXT NOT NULL, id TEXT NOT NULL, name TEXT, api TEXT, doc TEXT, npm TEXT, env TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(source,id))',
  'CREATE TABLE IF NOT EXISTS cat_models (id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, name TEXT, family TEXT, description TEXT, type TEXT, release_date TEXT, last_updated TEXT, knowledge TEXT, open_weights INTEGER, license TEXT, weights TEXT, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, attachment INTEGER, temperature INTEGER, context INTEGER, max_output INTEGER, basis TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT)',
  'CREATE INDEX IF NOT EXISTS cat_models_lab ON cat_models(lab_id)',
  'CREATE TABLE IF NOT EXISTS cat_listings (source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, model_id TEXT, model_basis TEXT, name TEXT, family TEXT, type TEXT, status TEXT, release_date TEXT, knowledge TEXT, deprecated_at TEXT, context INTEGER, max_input INTEGER, max_output INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, structured_output INTEGER, attachment INTEGER, open_weights INTEGER, hf_id TEXT, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT, PRIMARY KEY(source,provider_id,provider_model_id))',
  'CREATE INDEX IF NOT EXISTS cat_listings_route ON cat_listings(provider_id,provider_model_id)',
  'CREATE INDEX IF NOT EXISTS cat_listings_model ON cat_listings(model_id)',
  'CREATE TABLE IF NOT EXISTS cat_prices (source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, PRIMARY KEY(source,provider_id,provider_model_id,kind,tier,unit,valid_from))',
  'CREATE INDEX IF NOT EXISTS cat_prices_route ON cat_prices(provider_id,provider_model_id,valid_to)',
  'CREATE TABLE IF NOT EXISTS cat_price_stage (run TEXT NOT NULL, source TEXT NOT NULL, provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL)',
  'CREATE INDEX IF NOT EXISTS cat_price_stage_key ON cat_price_stage(run,provider_id,provider_model_id,kind,tier,unit)',
  'CREATE TABLE IF NOT EXISTS cat_offerings (provider_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, model_id TEXT, model_basis TEXT, sources TEXT NOT NULL, name TEXT, family TEXT, type TEXT, status TEXT, release_date TEXT, deprecated_at TEXT, context INTEGER, max_input INTEGER, max_output INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, structured_output INTEGER, attachment INTEGER, open_weights INTEGER, hf_id TEXT, provenance TEXT, conflicts TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(provider_id,provider_model_id))',
  'CREATE TABLE IF NOT EXISTS cat_offering_stage (value TEXT NOT NULL)',
  // Canonical models merged across sources (rebuildModels); cat_models keeps each owner's record.
  'CREATE TABLE IF NOT EXISTS cat_model_merged (id TEXT PRIMARY KEY, kind TEXT, name TEXT, family TEXT, type TEXT, release_date TEXT, knowledge TEXT, open_weights INTEGER, input_modalities TEXT, output_modalities TEXT, reasoning INTEGER, tool_call INTEGER, attachment INTEGER, context INTEGER, max_output INTEGER, sources TEXT NOT NULL, provenance TEXT NOT NULL, conflicts TEXT)',
  'CREATE TABLE IF NOT EXISTS cat_model_stage (value TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS cat_offerings_model ON cat_offerings(model_id)',
  // Model-level records from sources that describe models rather than routes (Epoch).
  // Each keeps its own identity; model_id links it to a canonical model when resolved.
  'CREATE TABLE IF NOT EXISTS cat_source_models (source TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, organization TEXT, country TEXT, domain TEXT, task TEXT, release_date TEXT, parameters REAL, training_compute REAL, accessibility TEXT, open_weights INTEGER, base_model TEXT, hf_developer TEXT, link TEXT, model_id TEXT, model_basis TEXT, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT, PRIMARY KEY(source,id))',
  'CREATE INDEX IF NOT EXISTS cat_source_models_model ON cat_source_models(model_id)',
  // Hugging Face Hub organisations and their models (catalogue-hub.ts).
  'CREATE TABLE IF NOT EXISTS cat_hf_orgs (name TEXT PRIMARY KEY, full_name TEXT, is_org INTEGER, verified INTEGER, plan TEXT, num_models INTEGER, referenced INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0, checked_at TEXT, crawled_at TEXT, crawl_status TEXT, crawl_error TEXT, models INTEGER, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cat_hf_models (id TEXT PRIMARY KEY, author TEXT NOT NULL, pipeline_tag TEXT, library TEXT, created_at TEXT, last_modified TEXT, downloads INTEGER, likes INTEGER, license TEXT, gated TEXT, parameters INTEGER, base_models TEXT, relation TEXT, arxiv TEXT, tags TEXT, routes INTEGER, model_id TEXT, model_basis TEXT, payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, withdrawn_at TEXT)',
  'CREATE INDEX IF NOT EXISTS cat_hf_models_author ON cat_hf_models(author)',
  'CREATE INDEX IF NOT EXISTS cat_hf_models_model ON cat_hf_models(model_id)',
];
// Columns added after a table first shipped; CREATE TABLE IF NOT EXISTS does not add them.
const addedColumns: Array<[table: string, column: string, type: string]> = [['cat_listings', 'hf_id', 'TEXT'], ['cat_offerings', 'hf_id', 'TEXT'], ['cat_offerings', 'provenance', 'TEXT'], ['cat_offerings', 'conflicts', 'TEXT'], ['cat_offerings', 'kind', 'TEXT']];

export const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
export const obj = (v: unknown): Json => isObject(v) ? v : {};
export const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : null;
const bool = (v: unknown): number | null => typeof v === 'boolean' ? Number(v) : null;
export const int = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
export const list = (v: unknown): string | null => Array.isArray(v) && v.length && v.every(x => typeof x === 'string') ? JSON.stringify(v) : null;
export const date = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?/.test(v) ? v.slice(0, 10) : null;
export const id = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 300 ? v : null;
// Rate arithmetic (per token × 1e6) must not create spurious price changes.
export const money = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Number(v.toPrecision(12)) : null;

// Content hash with sorted object keys, so key order never changes a hash.
const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v) ?? 'null';
const hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
export const digest = (value: unknown): Promise<string> => hex(new TextEncoder().encode(stable(value)));

export interface Price { kind: string; tier: string; unit: string; amount: number }
export interface Provider { id: string; name: string | null; api: string | null; doc: string | null; npm: string | null; env: string | null }
interface RouteFields {
  name: string | null; family: string | null; type: string | null; status: string | null; release_date: string | null; knowledge: string | null; deprecated_at: string | null;
  context: number | null; max_input: number | null; max_output: number | null; input_modalities: string | null; output_modalities: string | null;
  reasoning: number | null; tool_call: number | null; structured_output: number | null; attachment: number | null; open_weights: number | null;
}
export interface Listing extends RouteFields { provider_id: string; provider_model_id: string; model_id: string | null; model_basis: string | null; hf_id: string | null; prices: Price[]; payload: Json }
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
      listings.push({ provider_id: providerId, provider_model_id: modelId, model_id: canonical, model_basis: canonical ? 'modelsdev-canonical' : null, hf_id: providerId === 'huggingface' ? modelId : null, ...route(m), prices: modelsDevPrices(obj(m.cost)), payload: m });
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
    const row: Listing = { provider_id: provider, provider_model_id: modelId, model_id: null, model_basis: null, hf_id: null, name: null, family: null, type: mode, status: null, release_date: null, knowledge: null,
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

export const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
// Gateways quote USD per token as strings; negative values mean "variable" (routers).
const perToken = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? money(n * 1e6) : null; };
const flag = (on: boolean, known: boolean): number | null => known ? Number(on) : null;
const priced = (prices: Price[], kind: string, tier: string, unit: string, amount: number | null) => { if (amount !== null) prices.push({ kind, tier, unit, amount }); };
const unlisted = { family: null, status: null, max_input: null, attachment: null, model_id: null, model_basis: null } as const;

// OpenRouter names a non-chat model's output by its kind. Like Models.dev and Vercel, such a
// route outputs text or audio, and the kind becomes its type. Chat routes keep no type.
const openRouterOutputs: Record<string, { type: string; output: string }> = {
  decisions: { type: 'decisions', output: 'text' }, embeddings: { type: 'embedding', output: 'embedding' }, rerank: { type: 'rerank', output: 'ranking' },
  transcription: { type: 'transcription', output: 'text' }, speech: { type: 'speech', output: 'audio' }, video: { type: 'video', output: 'video' },
};
// Generated media is billed per unit elsewhere; OpenRouter quotes "0" per token for it, which is no price.
const mediaTypes = new Set(['image', 'video', 'speech']);

// OpenRouter lists its own routes. Ambiguous price fields (time-of-day overrides)
// stay in the payload rather than being guessed.
export function parseOpenRouter(data: unknown): Parsed {
  const rows = isObject(data) && Array.isArray(data.data) ? data.data : [];
  if (!rows.length) throw new Error('OpenRouter models format changed.');
  const listings: Listing[] = [];
  for (const value of rows) {
    const m = obj(value), modelId = id(m.id);
    if (!modelId) continue;
    const arch = obj(m.architecture), top = obj(m.top_provider), pricing = obj(m.pricing), prices: Price[] = [];
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [], known = params.length > 0;
    const raw = Array.isArray(arch.output_modalities) ? arch.output_modalities.filter((x): x is string => typeof x === 'string') : [];
    const special = raw.length === 1 ? openRouterOutputs[raw[0] ?? ''] : undefined;
    const type = special?.type ?? (raw.length === 1 && raw[0] === 'image' ? 'image' : null), outputs = special ? list([special.output]) : list(raw);
    const rate = (v: unknown) => { const n = perToken(v); return n === 0 && type && mediaTypes.has(type) ? null : n; };
    for (const [field, kind] of [['prompt', 'input'], ['completion', 'output'], ['input_cache_read', 'cache_read'], ['input_cache_write', 'cache_write'], ['internal_reasoning', 'reasoning'],
      ['audio', 'input_audio'], ['audio_output', 'output_audio'], ['input_audio_cache', 'cache_read_audio']] as const)
      priced(prices, kind, '', 'usd_per_mtok', rate(pricing[field]));
    priced(prices, 'cache_write', 'cache-ttl>1hr', 'usd_per_mtok', perToken(pricing.input_cache_write_1h));
    const search = num(pricing.web_search), image = num(pricing.image), imageOutput = num(pricing.image_output), imageToken = num(pricing.image_token);
    priced(prices, 'web_search', '', 'usd_per_query', search !== null && search >= 0 ? money(search) : null);
    priced(prices, 'input_image', '', 'usd_per_image', image !== null && image > 0 ? money(image) : null);
    priced(prices, 'output_image', '', 'usd_per_image', imageOutput !== null && imageOutput > 0 ? money(imageOutput) : null);
    // OpenRouter does not say whether an image token is input or output, so preserve its
    // official unit without inventing a direction. The raw payload retains every override.
    priced(prices, 'image_token', '', 'usd_per_mtok', imageToken !== null && imageToken > 0 ? money(imageToken * 1e6) : null);
    listings.push({ ...unlisted, provider_id: 'openrouter', provider_model_id: modelId, hf_id: text(m.hugging_face_id), name: text(m.name), type, release_date: null, knowledge: date(m.knowledge_cutoff),
      deprecated_at: date(m.expiration_date), context: int(m.context_length), max_output: int(top.max_completion_tokens), input_modalities: list(arch.input_modalities), output_modalities: outputs,
      reasoning: isObject(m.reasoning) ? 1 : flag(params.includes('reasoning'), known), tool_call: flag(params.includes('tools'), known),
      structured_output: flag(params.includes('structured_outputs') || params.includes('response_format'), known), open_weights: null, prices, payload: m });
  }
  return { providers: [{ id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1', doc: 'https://openrouter.ai/models', npm: null, env: null }], listings, models: [] };
}

// DeepInfra's own model list: every model it serves, including media, audio, embedding,
// rerank and decision models. Prices are in US cents; the listed rate already includes a discount.
// The list has no modality fields, so they follow from the model type and DeepInfra's tags.
const deepInfraTypes: Record<string, { type: string; input: string[]; output: string[] }> = {
  'text-generation': { type: 'chat', input: ['text'], output: ['text'] }, embeddings: { type: 'embedding', input: ['text'], output: ['embedding'] },
  reranker: { type: 'rerank', input: ['text'], output: ['ranking'] }, decision: { type: 'decision', input: ['text'], output: ['text'] },
  'text-to-image': { type: 'text-to-image', input: ['text'], output: ['image'] }, 'text-to-video': { type: 'text-to-video', input: ['text'], output: ['video'] },
  'text-to-speech': { type: 'text-to-speech', input: ['text'], output: ['audio'] }, 'text-to-music': { type: 'text-to-music', input: ['text'], output: ['audio'] },
  'automatic-speech-recognition': { type: 'automatic-speech-recognition', input: ['audio'], output: ['text'] },
  'zero-shot-image-classification': { type: 'decision', input: ['image'], output: ['text'] },
};
export function parseDeepInfra(data: unknown, now: string): Parsed {
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) throw new Error('DeepInfra models format changed.');
  const listings: Listing[] = [], usd = (cents: unknown, scale: number) => { const n = num(cents); return n !== null && n >= 0 ? money(n / 100 * scale) : null; };
  for (const value of rows) {
    const m = obj(value), modelId = id(m.model_name), shape = deepInfraTypes[text(m.type) ?? ''];
    if (!modelId || !shape || m.private === true || m.private === 1) continue;
    const pricing = obj(m.pricing), prices: Price[] = [], tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
    const extra = (tag: string, modality: string) => tags.includes(tag) && !shape.input.includes(modality) ? [modality] : [];
    const input = [...shape.input, ...(shape.input.includes('text') ? [...extra('multimodal', 'image'), ...extra('input-audio', 'audio'), ...extra('input-video', 'video')] : [])];
    switch (text(pricing.type)) {
      case 'tokens': {
        const baseInput = usd(pricing.cents_per_input_token, 1e6), baseOutput = usd(pricing.cents_per_output_token, 1e6);
        priced(prices, 'input', '', 'usd_per_mtok', baseInput); priced(prices, 'output', '', 'usd_per_mtok', baseOutput);
        for (const [field, kind, tier] of [['rate_per_input_token_cached', 'cache_read', ''], ['rate_per_input_token_cache_write', 'cache_write', ''],
          ['rate_per_service_tier_priority', 'input', 'priority'], ['rate_per_service_tier_flex', 'input', 'flex']] as const) {
          const multiplier = num(pricing[field]);
          priced(prices, kind, tier, 'usd_per_mtok', baseInput !== null && multiplier !== null && multiplier >= 0 ? money(baseInput * multiplier) : null);
        }
        for (const [ttl, value] of Object.entries(obj(pricing.rate_per_explicit_cache_write_token))) {
          const multiplier = num(value);
          priced(prices, 'cache_write', ttl, 'usd_per_mtok', baseInput !== null && multiplier !== null && multiplier >= 0 ? money(baseInput * multiplier) : null);
        }
        break;
      }
      case 'input_tokens':
        priced(prices, 'input', '', 'usd_per_mtok', usd(pricing.cents_per_input_token, 1e6));
        priced(prices, 'input_image', '', 'usd_per_mtok', usd(pricing.cents_per_image_token, 1e6));
        break;
      case 'input_character_length': priced(prices, 'input', '', 'usd_per_mchar', usd(pricing.cents_per_input_chars, 1e6)); break;
      case 'input_length': priced(prices, 'input_audio', '', 'usd_per_second', usd(pricing.cents_per_input_sec, 1)); break;
      case 'output_length': priced(prices, shape.output[0] === 'video' ? 'output_video' : 'output_audio', '', 'usd_per_second', usd(pricing.cents_per_output_sec, 1)); break;
      case 'image_units': priced(prices, 'output_image', '', 'usd_per_image_unit', usd(pricing.cents_per_image_unit, 1)); break;
      case 'frame_units': priced(prices, 'output_video', '', 'usd_per_frame_unit', usd(pricing.cents_per_frame_unit, 1)); break;
      // Billed by compute time, not by the input or output.
      case 'time': priced(prices, 'compute', '', 'usd_per_second', usd(pricing.cents_per_sec, 1)); break;
    }
    const deprecated = num(m.deprecated), retired = deprecated !== null && deprecated > 0 ? new Date(deprecated * 1000).toISOString() : null, chat = shape.type === 'chat';
    listings.push({ ...unlisted, provider_id: 'deepinfra', provider_model_id: modelId, hf_id: m.is_partner === true ? null : modelId, name: null, type: shape.type,
      status: retired && retired <= now ? 'deprecated' : null, release_date: null, knowledge: null, deprecated_at: retired?.slice(0, 10) ?? null,
      context: chat || shape.type === 'embedding' || shape.type === 'rerank' || shape.type === 'decision' ? int(m.max_tokens) : null, max_output: null,
      input_modalities: list(input), output_modalities: list(shape.output),
      reasoning: chat ? flag(tags.includes('reasoning'), tags.length > 0) : null, tool_call: chat ? flag(tags.includes('tools'), tags.length > 0) : null,
      structured_output: chat ? flag(tags.includes('structured-output') || tags.includes('json'), tags.length > 0) : null, open_weights: null, prices, payload: m });
  }
  return { providers: [{ id: 'deepinfra', name: 'Deep Infra', api: 'https://api.deepinfra.com/v1/openai', doc: 'https://deepinfra.com/models', npm: null, env: null }], listings, models: [] };
}

// TrueFoundry's registry: one YAML file per provider route. Directories map to the
// catalogue's provider IDs; OpenRouter and DeepInfra are read from their own feeds,
// and TrueFoundry's managed hosting is not a public provider. Microsoft Foundry and
// Azure AI Foundry list the same Azure deployments; the first listed wins.
const trueFoundryProviders: Record<string, string | null> = {
  ai21: 'ai21', anthropic: 'anthropic', 'aws-bedrock': 'amazon-bedrock', 'aws-bedrock-mantle': 'truefoundry:aws-bedrock-mantle', 'microsoft-foundry': 'azure', 'azure-ai-foundry': 'azure',
  'azure-open-ai': 'azure', cerebras: 'cerebras', cohere: 'cohere', databricks: 'databricks', deepgram: 'litellm:deepgram', elevenlabs: 'litellm:elevenlabs', 'fireworks-ai': 'fireworks-ai',
  'google-gemini': 'google', 'google-vertex': 'google-vertex', groq: 'groq', 'mistral-ai': 'mistral', openai: 'openai', 'perplexity-ai': 'perplexity', sambanova: 'sambanova',
  'together-ai': 'togetherai', typesafe: 'litellm:typesafe', wafer: 'truefoundry:wafer', xai: 'xai', openrouter: null, deepinfra: null, 'truefoundry-managed': null,
};
// Price fields with one documented unit. Batch, priority, flex and ultrafast rates are
// tiers. Context tiers (tiered_pricing) are left out: "cumulative" does not say
// whether the whole request or only the excess pays the higher rate. Per-hour cache
// storage is left out: it means storage on Google and a 1-hour write on Anthropic.
const trueFoundryRates: Record<string, readonly [string, string, number]> = {
  input_cost_per_token: ['input', 'usd_per_mtok', 1e6], output_cost_per_token: ['output', 'usd_per_mtok', 1e6],
  cache_read_input_token_cost: ['cache_read', 'usd_per_mtok', 1e6], cache_creation_input_token_cost: ['cache_write', 'usd_per_mtok', 1e6],
  input_cost_per_audio_token: ['input_audio', 'usd_per_mtok', 1e6], output_cost_per_audio_token: ['output_audio', 'usd_per_mtok', 1e6],
  cache_read_input_audio_token_cost: ['cache_read_audio', 'usd_per_mtok', 1e6], cache_creation_input_audio_token_cost: ['cache_write_audio', 'usd_per_mtok', 1e6],
  input_cost_per_image_token: ['input_image', 'usd_per_mtok', 1e6], output_cost_per_image_token: ['output_image', 'usd_per_mtok', 1e6],
  cache_read_input_image_token_cost: ['cache_read_image', 'usd_per_mtok', 1e6], input_cost_per_video_token: ['input_video', 'usd_per_mtok', 1e6], output_cost_per_video_token: ['output_video', 'usd_per_mtok', 1e6],
  input_cost_per_image: ['input_image', 'usd_per_image', 1], output_cost_per_image: ['output_image', 'usd_per_image', 1], input_cost_per_character: ['input', 'usd_per_mchar', 1e6],
  input_cost_per_request: ['request', 'usd_per_request', 1], input_cost_per_query: ['query', 'usd_per_query', 1], input_cost_per_page: ['ocr', 'usd_per_page', 1],
};
const trueFoundryModes: Record<string, string> = {
  chat: 'chat', completion: 'completion', responses: 'responses', realtime: 'realtime', embedding: 'embedding', rerank: 'rerank', decision: 'decision', moderation: 'moderation', ocr: 'ocr',
  image: 'image', video: 'video', text_to_speech: 'text_to_speech', audio_transcription: 'audio_transcription', audio_translation: 'audio_translation',
};
// The region a provider-wide price applies to, else the most common US default.
const baseRegions = ['*', 'global', 'us-east-1', 'eastus2', 'eastus', 'us-central1', 'us'];
function trueFoundryPrices(cost: Json, mode: string, tier: string): Price[] {
  const prices: Price[] = [], add = (kind: string, unit: string, amount: number | null, extra = '') => priced(prices, kind, [tier, extra].filter(Boolean).join(','), unit, amount);
  const rate = (v: unknown, scale: number) => { const n = num(v); return n !== null && n >= 0 ? money(n * scale) : null; };
  for (const [field, value] of Object.entries(cost)) {
    const known = trueFoundryRates[field.replace(/_batches$/, '')], batch = field.endsWith('_batches');
    if (known) { add(known[0], known[1], rate(value, known[2]), batch ? 'batch' : ''); continue; }
    const seconds = /^(input|output)_cost_per_second(?:_(\d+p|4k)(_noaudio)?)?$/.exec(field), images = /^output_cost_per_image_(\dk)$/.exec(field);
    // Seconds are of the generated video or audio, or of the transcribed input audio.
    if (seconds?.[1] === 'output' && (mode === 'video' || mode === 'text_to_speech')) add(mode === 'video' ? 'output_video' : 'output_audio', 'usd_per_second', rate(value, 1), [seconds[2] && `resolution=${seconds[2]}`, seconds[3] && 'audio=none'].filter(Boolean).join(','));
    else if (seconds?.[1] === 'input' && !seconds[2] && (mode === 'audio_transcription' || mode === 'audio_translation')) add('input_audio', 'usd_per_second', rate(value, 1));
    else if (images) add('output_image', 'usd_per_image', rate(value, 1), `size=${images[1]}`);
    else if (field === 'input_cost_per_annotated_page') add('ocr', 'usd_per_page', rate(value, 1), 'annotated');
    else if (isObject(value) && /^(priority|flex|ultrafast)_pricing$/.test(field)) prices.push(...trueFoundryPrices(value, mode, [tier, field.slice(0, -8)].filter(Boolean).join(',')));
  }
  return prices;
}
export function parseTrueFoundry(zip: Uint8Array): Parsed {
  const files = unzipSync(zip, { filter: f => /^[^/]+\/providers\/[^/]+\/[^/]+\.yaml$/.test(f.name) && !f.name.endsWith('/default.yaml') });
  const listings = new Map<string, Listing>();
  for (const name of Object.keys(files).sort((a, b) => {
    // Directory order of trueFoundryProviders decides which duplicate route wins.
    const order = Object.keys(trueFoundryProviders), d = (f: string) => order.indexOf(f.split('/')[2] ?? '');
    return d(a) - d(b) || a.localeCompare(b);
  })) {
    const dir = name.split('/')[2] ?? '', provider = trueFoundryProviders[dir], bytes = files[name];
    if (!provider || !bytes) continue;
    let doc: unknown;
    try { doc = parseYAML(strFromU8(bytes)); } catch { continue; }
    const m = obj(doc), modelId = id(m.model), mode = trueFoundryModes[text(m.mode) ?? ''];
    if (!modelId || !mode || m.status === 'retired' || listings.has(`${provider}|${modelId}`)) continue;
    // One base region's prices, and each other region's base input/output where they differ.
    const costs = (Array.isArray(m.costs) ? m.costs : []).map(obj), regions = costs.map(c => text(c.region) ?? '');
    const baseIndex = Math.max(0, baseRegions.map(r => regions.indexOf(r)).find(i => i >= 0) ?? 0), base = costs[baseIndex];
    const prices = base ? trueFoundryPrices(base, mode, '') : [];
    for (const [i, cost] of costs.entries()) {
      if (i === baseIndex) continue;
      for (const p of trueFoundryPrices(cost, mode, `region=${regions[i]}`)) if (p.tier === `region=${regions[i]}` && (p.kind === 'input' || p.kind === 'output') && !prices.some(b => b.tier === '' && b.kind === p.kind && b.unit === p.unit && b.amount === p.amount)) prices.push(p);
    }
    const limits = obj(m.limits), modalities = obj(m.modalities), features = Array.isArray(m.features) ? m.features : [], chat = ['chat', 'completion', 'responses', 'realtime'].includes(mode);
    const deprecated = m.status === 'deprecated' || m.isDeprecated === true;
    listings.set(`${provider}|${modelId}`, { ...unlisted, provider_id: provider, provider_model_id: modelId, hf_id: null, name: null, type: mode, status: deprecated ? 'deprecated' : m.status === 'preview' ? 'preview' : null,
      release_date: null, knowledge: null, deprecated_at: date(m.retirementDate) ?? date(m.deprecationDate), context: int(limits.max_input_tokens ?? limits.max_tokens), max_input: int(limits.max_input_tokens), max_output: int(limits.max_output_tokens),
      input_modalities: list(modalities.input), output_modalities: list(modalities.output),
      reasoning: chat && isObject(m.thinking) ? 1 : null, tool_call: chat ? flag(features.includes('function_calling') || features.includes('tool_choice'), features.length > 0) : null,
      structured_output: chat ? flag(features.includes('structured_output'), features.length > 0) : null, open_weights: null, prices, payload: { ...m, directory: dir } });
  }
  if (listings.size < 1000) throw new Error('TrueFoundry registry format changed.');
  const providers = [...new Set([...listings.values()].map(l => l.provider_id))].map(p => ({ id: p, name: p.startsWith('truefoundry:') ? p.slice(12) : p, api: null, doc: 'https://github.com/truefoundry/models/tree/main/providers', npm: null, env: null }));
  return { providers, listings: [...listings.values()], models: [] };
}

// Eden AI's expert models: a gateway's own routes, one per model string it bills
// ("ocr/financial_parser/mindee", "audio/tts/openai/tts-1"). Only OCR,
// translation, speech, moderation and AI-content detection are read; its LLMs come
// from the providers' own feeds. Each model has one USD price per quantity of a
// unit. A "token" price does not say whether it is input or output, so it is no
// price; free and execution-time quotes, and zero placeholders, are none either.
// Prices exclude Eden AI's platform fee, charged when credits are bought.
const edenSubfeatures: Record<string, { type: string; input: string[] | null; output: string[] | null }> = {
  'translation/automatic_translation': { type: 'translation', input: ['text'], output: ['text'] }, 'translation/document_translation': { type: 'translation', input: null, output: null },
  'audio/tts': { type: 'speech', input: ['text'], output: ['audio'] }, 'audio/speech_to_text_async': { type: 'transcription', input: ['audio'], output: ['text'] },
  'text/moderation': { type: 'moderation', input: ['text'], output: ['text'] }, 'image/explicit_content': { type: 'moderation', input: ['image'], output: ['text'] },
  'text/ai_detection': { type: 'detection', input: ['text'], output: ['text'] }, 'image/ai_detection': { type: 'detection', input: ['image'], output: ['text'] },
  'image/deepfake_detection': { type: 'detection', input: ['image'], output: ['text'] }, 'video/deepfake_detection_async': { type: 'detection', input: ['video'], output: ['text'] },
};
function edenPrice(pricing: Json, feature: string, type: string): Price | null {
  const price = num(pricing.price), quantity = num(pricing.price_unit_quantity), unit = text(pricing.price_unit_type);
  if (pricing.currency !== 'USD' || price === null || price <= 0 || quantity === null || quantity <= 0) return null;
  // The quote is for `quantity` units; amounts are per one unit (per million characters).
  const each = price / quantity, media = type === 'speech' ? 'output_audio' : feature === 'video' ? 'input_video' : 'input_audio';
  const make = (kind: string, unit: string, amount: number | null): Price | null => amount === null ? null : { kind, tier: '', unit, amount };
  switch (unit) {
    case 'character': return make('input', 'usd_per_mchar', money(each * 1e6));
    case 'second': return make(media, 'usd_per_second', money(each));
    case 'minute': return make(media, 'usd_per_second', money(each / 60));
    case 'page': return make(feature === 'ocr' ? 'ocr' : 'input', 'usd_per_page', money(each));
    // A file is an image for image models and a whole document for document parsers.
    case 'file': return feature === 'image' ? make('input_image', 'usd_per_image', money(each)) : make(feature === 'ocr' ? 'ocr' : 'input', 'usd_per_file', money(each));
    case 'image': return make('input_image', 'usd_per_image', money(each));
    case 'request': return make('request', 'usd_per_request', money(each));
    default: return null;
  }
}
export function parseEdenAI(data: unknown): Parsed {
  const features = isObject(data) && Array.isArray(data.features) ? data.features.map(obj) : [], listings: Listing[] = [];
  for (const f of features) for (const s of Array.isArray(f.subfeatures) ? f.subfeatures.map(obj) : []) {
    const feature = text(f.name) ?? '', path = `${feature}/${text(s.name) ?? ''}`, shape = feature === 'ocr' ? { type: 'ocr', input: null, output: ['text'] } : edenSubfeatures[path];
    if (!shape) continue;
    for (const value of Array.isArray(s.models) ? s.models : []) {
      const m = obj(value), modelId = id(m.model), [, , vendor, ...rest] = modelId?.split('/') ?? [], model = rest.join('/');
      if (!modelId || !modelId.startsWith(`${path}/`) || !vendor) continue;
      const price = edenPrice(obj(m.pricing), feature, shape.type);
      // A speech or OCR model may be a lab's canonical model; the importer keeps only IDs
      // that exist. Parsers, translators and moderators that name an LLM are tasks built on it, not its routes.
      const link = model && (feature === 'audio' || path === 'ocr/ocr' || path === 'ocr/ocr_async') ? `${vendor}/${model}` : null;
      listings.push({ ...unlisted, ...route({}), provider_id: 'edenai', provider_model_id: modelId, hf_id: null, model_id: link, model_basis: link ? 'edenai-model' : null,
        name: `${model ? `${vendor}/${model}` : vendor} · ${text(s.fullname) ?? path}`, type: shape.type, input_modalities: list(shape.input), output_modalities: list(shape.output), prices: price ? [price] : [], payload: m });
    }
  }
  // About 140 such models in October 2026; a collapsed or reshaped list stores nothing.
  if (listings.length < 80 || listings.filter(l => l.prices.length).length < 60) throw new Error('Eden AI model list format changed.');
  return { providers: [{ id: 'edenai', name: 'Eden AI', api: 'https://api.edenai.run/v3', doc: 'https://www.edenai.co/docs/v3/expert-models/listing-models', npm: null, env: null }], listings, models: [] };
}

// Portkey's request/response "token" fields sometimes count characters or
// seconds. Only reviewed model families and image trees have known units.
// Unit evidence: Portkey models PR #898 (ElevenLabs), Deepgram's character
// billing table, and Stability's rates.image calculation. No default/fallback
// configs, generic service aliases or zero media placeholders become prices.
export function parsePortkey(data: unknown, vendor: string, knownProviders: ReadonlySet<string> = new Set()): Parsed {
  if (!isObject(data) || !Object.values(data).some(v => isObject(obj(v).pricing_config))) throw new Error('Portkey pricing format changed.');
  const name = vendor === 'stability-ai' ? 'stability' : vendor, provider = knownProviders.has(name) ? name : `litellm:${name}`, listings: Listing[] = [];
  for (const [model, value] of Object.entries(data)) {
    if (model === 'default' || model === 'text-to-speech' || model === 'speech-to-text') continue;
    const config = obj(obj(value).pricing_config), rates = obj(config.pay_as_you_go), prices: Price[] = [];
    if (config.currency !== undefined && config.currency !== 'USD' || config.calculate !== undefined) continue;
    const cents = (value: unknown, scale: number) => { const n = num(value); return n !== null && n > 0 ? money(n / 100 * scale) : null; };
    let type: string, input: string[], output: string[];
    if (vendor === 'deepgram' && /^aura-(?:2-)?[a-z]+-[a-z]{2}$/.test(model) || vendor === 'elevenlabs' && /^eleven_(?:multilingual_v2|v3|flash_v2_5|turbo_v2_5)$/.test(model)) {
      type = 'speech'; input = ['text']; output = ['audio'];
      priced(prices, 'input', '', 'usd_per_mchar', cents(obj(rates.request_token).price, 1e6));
    } else if (vendor === 'elevenlabs' && model === 'scribe_v1') {
      type = 'transcription'; input = ['audio']; output = ['text'];
      // The response_token field bills seconds of INPUT audio, not text output.
      priced(prices, 'input_audio', '', 'usd_per_second', cents(obj(rates.response_token).price, 1));
    } else if (vendor === 'stability-ai' && isObject(rates.image)) {
      type = 'image'; input = ['text']; output = ['image'];
      for (const [quality, sizes] of Object.entries(rates.image)) for (const [size, rate] of Object.entries(obj(sizes)))
        priced(prices, 'output_image', [quality !== 'default' ? `quality=${quality}` : '', size !== 'default' ? `size=${size}` : ''].filter(Boolean).join(','), 'usd_per_image', cents(obj(rate).price, 1));
    } else continue;
    if (!prices.length) continue;
    listings.push({ ...unlisted, ...route({}), hf_id: null, provider_id: provider, provider_model_id: model, name: model, type, input_modalities: list(input), output_modalities: list(output), prices, payload: obj(value) });
  }
  if (!listings.length) throw new Error('No reviewed Portkey prices found; previous rows retained.');
  return { providers: [{ id: provider, name: vendor, api: null, doc: `https://github.com/Portkey-AI/models/blob/main/pricing/${vendor}.json`, npm: null, env: null }], listings, models: [] };
}

// Vercel AI Gateway: context tiers become context>N, service tiers keep their name.
export function parseVercel(data: unknown): Parsed {
  const rows = isObject(data) && Array.isArray(data.data) ? data.data : [];
  if (!rows.length) throw new Error('Vercel AI Gateway models format changed.');
  const listings: Listing[] = [], kinds = { input: 'input', output: 'output', input_cache_read: 'cache_read', input_cache_write: 'cache_write' } as const;
  for (const value of rows) {
    const m = obj(value), modelId = id(m.id);
    if (!modelId) continue;
    const pricing = obj(m.pricing), prices: Price[] = [], tags = Array.isArray(m.tags) ? m.tags : [], type = text(m.type), modalities = obj(m.modalities);
    for (const [field, kind] of Object.entries(kinds)) {
      priced(prices, kind, '', 'usd_per_mtok', perToken(pricing[field]));
      for (const t of Array.isArray(pricing[`${field}_tiers`]) ? pricing[`${field}_tiers`] as unknown[] : []) {
        const tier = obj(t), min = int(tier.min);
        if (min) priced(prices, kind, `context>${min - 1}`, 'usd_per_mtok', perToken(tier.cost));
      }
      for (const [name, service] of Object.entries(obj(pricing.service_tiers))) priced(prices, kind, name, 'usd_per_mtok', perToken(obj(service)[field]));
    }
    if (type === 'image') { const each = num(pricing.image); priced(prices, 'output_image', '', 'usd_per_image', each !== null && each >= 0 ? money(each) : null); }
    const released = num(m.released);
    listings.push({ ...unlisted, provider_id: 'vercel', provider_model_id: modelId, hf_id: null, name: text(m.name), type, release_date: released ? new Date(released * 1000).toISOString().slice(0, 10) : null,
      knowledge: date(m.knowledge), deprecated_at: null, context: int(m.context_window), max_output: int(m.max_tokens), input_modalities: list(modalities.input), output_modalities: list(modalities.output),
      reasoning: flag(tags.includes('reasoning'), tags.length > 0), tool_call: flag(tags.includes('tool-use'), tags.length > 0), structured_output: flag(tags.includes('structured-output'), tags.length > 0),
      open_weights: tags.includes('open-weights') ? 1 : null, prices, payload: m });
  }
  return { providers: [{ id: 'vercel', name: 'Vercel AI Gateway', api: 'https://ai-gateway.vercel.sh/v1', doc: 'https://vercel.com/ai-gateway/models', npm: null, env: null }], listings, models: [] };
}

// genai-prices provider IDs that differ from Models.dev's. Hugging Face
// inference routes are priced per backend, so each backend stays separate.
export const genaiProviders: Record<string, string> = { aws: 'amazon-bedrock', fireworks: 'fireworks-ai', together: 'togetherai', 'x-ai': 'xai' };
const genaiKinds: Record<string, string> = { input_mtok: 'input', output_mtok: 'output', cache_read_mtok: 'cache_read', cache_write_mtok: 'cache_write', input_audio_mtok: 'input_audio',
  output_audio_mtok: 'output_audio', cache_audio_read_mtok: 'cache_read_audio' };
// Prices may be a list of dated variants. As in genai-prices itself, the last
// variant in force on `day` is the whole price set. Time-of-day variants stay
// in the payload.
function genaiPrices(value: unknown, day: string): Price[] {
  let current: Json = {};
  if (Array.isArray(value)) for (const v of value) {
    const entry = obj(v), c = obj(entry.constraint), from = date(c.start_date), to = date(c.end_date);
    if (c.start_time !== undefined || c.end_time !== undefined || (from && from > day) || (to && to <= day)) continue;
    current = obj(entry.prices);
  } else current = obj(value);
  const prices: Price[] = [];
  for (const [field, v] of Object.entries(current)) {
    if (field === 'requests_kcount') { const n = num(v); priced(prices, 'request', '', 'usd_per_request', n !== null && n >= 0 ? money(n / 1000) : null); continue; }
    const kind = genaiKinds[field];
    if (!kind) continue;
    const base = isObject(v) ? v.base : v, amount = num(base);
    priced(prices, kind, '', 'usd_per_mtok', amount !== null && amount >= 0 ? money(amount) : null);
    for (const t of isObject(v) && Array.isArray(v.tiers) ? v.tiers : []) {
      const tier = obj(t), start = int(tier.start), price = num(tier.price);
      if (start && price !== null && price >= 0) priced(prices, kind, `context>${start}`, 'usd_per_mtok', money(price));
    }
  }
  return prices;
}
export function parseGenaiPrices(data: unknown, knownProviders: ReadonlySet<string> = new Set(), now = new Date().toISOString()): Parsed {
  if (!Array.isArray(data) || !data.some(p => obj(p).id === 'openai')) throw new Error('genai-prices format changed.');
  const providers: Provider[] = [], listings: Listing[] = [], day = now.slice(0, 10);
  for (const raw of data) {
    const p = obj(raw), source = id(p.id);
    if (!source) continue;
    const backend = source.startsWith('huggingface_') ? source.slice('huggingface_'.length) : null;
    const providerId = genaiProviders[source] ?? (backend ? `huggingface:${backend}` : knownProviders.has(source) ? source : `genai-prices:${source}`);
    providers.push({ id: providerId, name: text(p.name), api: null, doc: Array.isArray(p.pricing_urls) ? text(p.pricing_urls[0]) : null, npm: null, env: null });
    for (const value of Array.isArray(p.models) ? p.models : []) {
      const m = obj(value), modelId = id(m.id);
      if (!modelId) continue;
      listings.push({ ...unlisted, provider_id: providerId, provider_model_id: modelId, hf_id: backend ? modelId : null, name: text(m.name), type: null, release_date: null, knowledge: null, deprecated_at: null,
        context: int(m.context_window), max_output: null, input_modalities: null, output_modalities: null, reasoning: null, tool_call: null, structured_output: null, open_weights: null,
        prices: genaiPrices(m.prices, day), payload: m });
    }
  }
  return { providers, listings, models: [] };
}

// RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines.
// Fields are sliced whole: growing strings by character builds V8 ropes that
// need many times the input's size.
export function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], i = 0;
  while (i < input.length) {
    let field: string;
    if (input[i] === '"') {
      let end = i + 1;
      for (;;) { end = input.indexOf('"', end); if (end < 0) { end = input.length; break; } if (input[end + 1] === '"') end += 2; else break; }
      field = input.slice(i + 1, end).replaceAll('""', '"'); i = end + 1;
    } else {
      let end = i;
      while (end < input.length && input[end] !== ',' && input[end] !== '\n' && input[end] !== '\r') end++;
      field = input.slice(i, end); i = end;
    }
    row.push(field);
    if (input[i] === ',') { i++; if (i === input.length) row.push(''); continue; }
    if (input[i] === '\r') i++;
    if (input[i] === '\n') i++;
    rows.push(row); row = [];
  }
  return rows;
}

export interface SourceModel {
  id: string; name: string; organization: string | null; country: string | null; domain: string | null; task: string | null; release_date: string | null; parameters: number | null;
  training_compute: number | null; accessibility: string | null; open_weights: number | null; base_model: string | null; hf_developer: string | null; link: string | null; payload: Json;
}
const commaSet = (v: string | undefined): string | null => { const items = [...new Set((v ?? '').split(',').map(s => s.trim()).filter(Boolean))]; return items.length ? items.join(', ') : null; };
export function parseEpoch(csv: string): SourceModel[] {
  const [header = [], ...rows] = parseCSV(csv), at = (name: string) => header.indexOf(name);
  if (at('Model') < 0 || at('Organization') < 0 || at('Publication date') < 0) throw new Error('Epoch models format changed.');
  const out = new Map<string, SourceModel>();
  for (const r of rows) {
    const cell = (name: string): string | undefined => { const i = at(name); return i < 0 ? undefined : r[i]?.trim() || undefined; };
    const name = cell('Model');
    if (!name || out.has(name)) continue;
    const weights = cell('Open model weights?'), positive = (v: string | undefined) => { const n = num(v); return n !== null && n > 0 ? n : null; };
    out.set(name, { id: name, name, organization: commaSet(cell('Organization')), country: commaSet(cell('Country (of organization)')), domain: commaSet(cell('Domain')), task: commaSet(cell('Task')),
      release_date: date(cell('Publication date')), parameters: positive(cell('Parameters')), training_compute: positive(cell('Training compute (FLOP)')), accessibility: cell('Model accessibility') ?? null,
      open_weights: weights === 'Yes' ? 1 : weights === 'No' ? 0 : null, base_model: cell('Base model') ?? null, hf_developer: cell('Hugging Face developer id') ?? null, link: cell('Link') ?? null,
      payload: Object.fromEntries(header.map((h, i) => [h, r[i]?.trim() ?? '']).filter(([, v]) => v)) });
  }
  return [...out.values()];
}

// A source model links to a canonical model only when its full name equals
// exactly one canonical model's name or ID suffix; anything else stays unlinked.
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export function resolveSourceModels(rows: SourceModel[], canonical: ReadonlyArray<{ id: string; name: string | null }>): Array<SourceModel & { model_id: string | null; model_basis: string | null }> {
  const byName = new Map<string, Set<string>>();
  const add = (key: string, modelId: string) => { if (!key) return; const set = byName.get(key) ?? new Set<string>(); set.add(modelId); byName.set(key, set); };
  for (const m of canonical) { if (m.name) add(loose(m.name), m.id); add(loose(m.id.split('/').slice(1).join('/')), m.id); }
  return rows.map(r => { const hit = byName.get(loose(r.name)); return hit?.size === 1 ? { ...r, model_id: [...hit][0] ?? null, model_basis: 'name-exact-unique' } : { ...r, model_id: null, model_basis: null }; });
}

interface BackboneRoute { provider_id: string; provider_model_id: string; model_id: string | null }
// repos: Hugging Face repositories (lowercase) named for canonical models by
// Models.dev weights or by an already-resolved route's hf_id.
// owned: canonical IDs a gateway introduced, by basis (`openrouter-id`, `vercel-id`).
export interface Backbone { routes: BackboneRoute[]; models: ReadonlySet<string>; repos?: ReadonlyArray<{ repo: string; model_id: string }>; owned?: ReadonlyMap<string, string> }
export async function loadBackbone(db: Database): Promise<Backbone> {
  const routes = (await db.prepare("SELECT provider_id,provider_model_id,model_id FROM cat_listings WHERE source='modelsdev' AND withdrawn_at IS NULL AND model_id IS NOT NULL").all<BackboneRoute>()).results;
  const models = (await db.prepare('SELECT id,weights,basis FROM cat_models WHERE withdrawn_at IS NULL').all<{ id: string; weights: string | null; basis: string }>()).results;
  const repos = (await db.prepare('SELECT DISTINCT lower(hf_id) repo,model_id FROM cat_listings WHERE hf_id IS NOT NULL AND model_id IS NOT NULL AND withdrawn_at IS NULL').all<{ repo: string; model_id: string }>()).results;
  return { routes, models: new Set(models.map(m => m.id)), repos: [...repos, ...weightRepos(models)], owned: new Map(models.map(m => [m.id, m.basis])) };
}
const weightRepos = (models: ReadonlyArray<{ id: string; weights: string | null }>) =>
  models.flatMap(m => [...(m.weights ?? '').matchAll(/https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/g)].map(([, repo]) => ({ repo: (repo ?? '').toLowerCase(), model_id: m.id })));
// A route's model slug: the last path segment without a :variant suffix, so
// accounts/fireworks/models/qwen3-8b and Qwen/Qwen3-8B:free both give qwen3-8b.
export const modelSlug = (id: string): string => (baseID(id).split('/').pop() ?? id).toLowerCase();
// Service variants of one model: OpenRouter's :free or :batch, Vercel's -batch.
const baseID = (id: string): string => id.replace(/(:[^/]*|-batch)$/, '');
const index = (pairs: Iterable<readonly [string, string]>) => {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of pairs) { const set = out.get(k) ?? new Set<string>(); set.add(v); out.set(k, set); }
  return (k: string | null | undefined): string | null => { const set = k ? out.get(k) : undefined; return set?.size === 1 ? [...set][0] ?? null : null; };
};
// Identity resolves through exact keys only, in order: the same Models.dev
// route, a canonical model ID (gateways use lab/model, also as a service
// variant), the identical provider model ID mapped to one model elsewhere, a
// Hugging Face repository named for one model, and a model slug equal to one
// canonical model's slug. Ambiguous keys resolve nothing. The Hub keeps
// slugs off: a repository named like a lab's model may be anyone's fine-tune.
export function resolveListings(listings: Listing[], backbone: Backbone, { slugs = true }: { slugs?: boolean } = {}): Listing[] {
  const routes = new Map<string, string>();
  for (const r of backbone.routes) if (r.model_id) routes.set(`${r.provider_id}|${r.provider_model_id}`, r.model_id);
  const same = index(backbone.routes.flatMap(r => r.model_id ? [[r.provider_model_id, r.model_id] as const] : []));
  const repo = index((backbone.repos ?? []).map(r => [r.repo, r.model_id] as const)), slug = index([...backbone.models].map(m => [modelSlug(m), m] as const));
  const canonical = (id: string) => [id, baseID(id)].find(x => backbone.models.has(x)) ?? null;
  const reviewed = new Map(reviewedRoutes.filter(r => backbone.models.has(r.model)).map(r => [`${r.provider}|${r.route}`, r.model]));
  for (const l of listings) {
    // A link the source itself gives ranks after Models.dev's routes and IDs.
    const id = l.provider_model_id, exact = routes.get(`${l.provider_id}|${id}`), lower = id.toLowerCase();
    const found: Array<[string | null | undefined, string | null]> = [[exact, 'modelsdev-route'], [reviewed.get(`${l.provider_id}|${id}`), 'reviewed-route'], [canonical(id), 'modelsdev-canonical-id'], [same(id), 'modelsdev-same-id'], [l.model_id, l.model_basis],
      [repo(lower.includes('/') ? lower : null) ?? repo(l.hf_id?.toLowerCase()), 'hf-repo'], [slugs ? slug(modelSlug(id)) : null, 'slug-unique']];
    const [model_id, model_basis] = found.find(([m]) => m) ?? [null, null];
    Object.assign(l, { model_id: model_id ?? null, model_basis: model_id ? model_basis : null });
  }
  return listings;
}

// A gateway lab/model ID that no tier resolves becomes a canonical model of its
// own (basis `<source>-id`), so models Models.dev lacks still have one identity.
// Service variants share their base ID; routers and aliases do not count. A
// listing that resolved to the identity this gateway introduced on an earlier
// run keeps it: otherwise the model is not stored again and is withdrawn.
export function gatewayIdentities(source: 'openrouter' | 'vercel', listings: Listing[], owned: ReadonlyMap<string, string> = new Map()): Model[] {
  const models = new Map<string, Model>();
  for (const l of listings) {
    const id = baseID(l.provider_model_id), [lab = '', name = ''] = id.split('/');
    const own = l.model_id === id && owned.get(id) === `${source}-id`;
    if (l.model_id && !own || !/^[a-z0-9][\w.-]*\/[\w.-]+$/.test(id) || id !== id.toLowerCase() || ['openrouter', 'auto'].includes(lab)) continue;
    Object.assign(l, { model_id: id, model_basis: `${source}-id` });
    if (models.has(id) || !name) continue;
    models.set(id, { id, lab_id: lab, name: l.name?.replace(/^[^:]+:\s*/, '').replace(/\s*\((free|batch)\)$/i, '') ?? name, family: null, description: null, type: l.type, release_date: l.release_date, last_updated: null,
      knowledge: l.knowledge, open_weights: l.open_weights, license: null, weights: l.hf_id ? JSON.stringify([{ label: 'Hugging Face', url: `https://huggingface.co/${l.hf_id}` }]) : null,
      input_modalities: l.input_modalities, output_modalities: l.output_modalities, reasoning: l.reasoning, tool_call: l.tool_call, attachment: null, temperature: null, context: l.context, max_output: l.max_output,
      basis: `${source}-id`, payload: { source, provider_model_id: l.provider_model_id } });
  }
  return [...models.values()];
}

const listingColumns = ['provider_id', 'provider_model_id', 'model_id', 'model_basis', 'name', 'family', 'type', 'status', 'release_date', 'knowledge', 'deprecated_at', 'context', 'max_input', 'max_output',
  'input_modalities', 'output_modalities', 'reasoning', 'tool_call', 'structured_output', 'attachment', 'open_weights', 'hf_id', 'payload', 'payload_hash'];
const modelColumns = ['id', 'lab_id', 'name', 'family', 'description', 'type', 'release_date', 'last_updated', 'knowledge', 'open_weights', 'license', 'weights', 'input_modalities', 'output_modalities',
  'reasoning', 'tool_call', 'attachment', 'temperature', 'context', 'max_output', 'basis', 'payload', 'payload_hash'];
export type Row = Record<string, Value>;
export const pick = (columns: string[], row: Record<string, unknown>): Row => Object.fromEntries(columns.map(c => { const v = row[c]; return [c, typeof v === 'string' || typeof v === 'number' ? v : null]; }));
export const extract = (columns: string[]) => columns.map(c => `json_extract(value,'$.${c}')`).join(',');
export const updates = (columns: string[], skip: string[]) => columns.filter(c => !skip.includes(c)).map(c => `${c}=excluded.${c}`).join(',');

// Rows go to D1 as JSON arrays expanded by json_each, bounded per statement.
export async function chunked(db: Database, sql: string, rows: readonly object[], bindings: Value[], size = 150): Promise<void> {
  for (let i = 0; i < rows.length; i += size * 8) {
    const statements: Statement[] = [];
    for (let j = i; j < Math.min(rows.length, i + size * 8); j += size) statements.push(db.prepare(sql).bind(...bindings, JSON.stringify(rows.slice(j, j + size))));
    await db.batch(statements);
  }
}

export async function ensureCatalogueSchema(db: Database): Promise<void> {
  await db.batch(catalogueSchema.map(s => db.prepare(s)));
  for (const [table, column, type] of addedColumns) {
    const { results } = await db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name=?1`).bind(column).all();
    if (!results.length) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

export interface StoreStats { listings: number; added: number; changed: number; withdrawn: number; unresolved: number; prices_opened: number; prices_closed: number }
// A scoped store covers only routes whose provider model ID starts with one of
// the given owners ("owner/..."): a source crawled in parts, such as the Hub,
// withdraws and closes prices only for the owners it crawled this run. A staged
// provider-wide crawl applies exact repository batches instead of whole owners.
const scoped = (column: string, n: number, kind: 'owners' | 'models') => `(?${n} IS NULL OR ${kind === 'models' ? column : `substr(${column},1,instr(${column},'/')-1)`} IN (SELECT value FROM json_each(?${n})))`;
// Listings arrive resolved (resolveListings); storing never changes identity.
export async function storeCatalogue(db: Database, source: string, parsed: Parsed, { now, run, scope = null, scopeKind = 'owners' }: { now: string; run: string; scope?: string[] | null; scopeKind?: 'owners' | 'models' }): Promise<StoreStats> {
  const listings = parsed.listings, owners = scope ? JSON.stringify(scope) : null;
  const existing = await db.prepare(`SELECT provider_id,provider_model_id,payload_hash,withdrawn_at FROM cat_listings WHERE source=?1 AND ${scoped('provider_model_id', 2, scopeKind)}`).bind(source, owners)
    .all<{ provider_id: string; provider_model_id: string; payload_hash: string; withdrawn_at: string | null }>();
  const prior = new Map(existing.results.map(r => [`${r.provider_id}|${r.provider_model_id}`, r]));
  const active = [...prior.values()].filter(r => !r.withdrawn_at).length;
  // A broken or truncated feed must not withdraw most of the catalogue.
  // Exact-model application batches belong to a crawl validated source-wide.
  if (scopeKind !== 'models' && active > 50 && listings.length < active * .5) throw new Error(`${source} listings dropped from ${active} to ${listings.length}; previous rows retained.`);
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
  const withdrawn = (await db.prepare(`UPDATE cat_listings SET withdrawn_at=?1 WHERE source=?2 AND last_seen<?1 AND withdrawn_at IS NULL AND ${scoped('provider_model_id', 3, scopeKind)}`).bind(now, source, owners).run()).meta.changes;
  await chunked(db, `INSERT INTO cat_providers (source,id,name,api,doc,npm,env,first_seen,last_seen) SELECT ?1,${extract(['id', 'name', 'api', 'doc', 'npm', 'env'])},?2,?2 FROM json_each(?3) WHERE true
    ON CONFLICT(source,id) DO UPDATE SET name=excluded.name,api=excluded.api,doc=excluded.doc,npm=excluded.npm,env=excluded.env,last_seen=excluded.last_seen`, parsed.providers, [source, now]);
  // Each source keeps and withdraws only its own models (basis prefix). Models.dev
  // takes over an ID a gateway introduced; a gateway never overwrites another's.
  if (parsed.models.length || ['openrouter', 'vercel'].includes(source)) {
    const models: Row[] = [];
    for (const m of parsed.models) models.push({ ...pick(modelColumns, { ...m, payload: JSON.stringify(m.payload) }), payload_hash: await digest(m.payload) });
    await chunked(db, `INSERT INTO cat_models (${modelColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ${extract(modelColumns)},?1,?1,NULL FROM json_each(?3) WHERE true
      ON CONFLICT(id) DO UPDATE SET ${updates(modelColumns, ['id'])},last_seen=excluded.last_seen,withdrawn_at=NULL WHERE ?2='modelsdev' OR cat_models.basis=excluded.basis`, models, [now, source]);
    await db.prepare("UPDATE cat_models SET withdrawn_at=?1 WHERE last_seen<?1 AND withdrawn_at IS NULL AND substr(basis,1,instr(basis,'-')-1)=?2").bind(now, source).run();
  }
  // Prices are intervals: an unchanged price stays open, a changed or removed one
  // closes now, and a new amount opens now. Staging keeps each statement bounded.
  const prices = listings.flatMap(l => l.prices.map(p => ({ provider_id: l.provider_id, provider_model_id: l.provider_model_id, ...p })));
  await db.prepare('DELETE FROM cat_price_stage WHERE source=?').bind(source).run();
  await chunked(db, `INSERT INTO cat_price_stage SELECT ?1,?2,${extract(['provider_id', 'provider_model_id', 'kind', 'tier', 'unit', 'amount'])} FROM json_each(?3)`, prices, [run, source], 400);
  const same = 's.run=?3 AND s.provider_id=p.provider_id AND s.provider_model_id=p.provider_model_id AND s.kind=p.kind AND s.tier=p.tier AND s.unit=p.unit AND s.amount=p.amount';
  const [closed, opened] = await db.batch([
    db.prepare(`UPDATE cat_prices AS p SET valid_to=?1 WHERE p.source=?2 AND p.valid_to IS NULL AND ${scoped('p.provider_model_id', 4, scopeKind)} AND NOT EXISTS (SELECT 1 FROM cat_price_stage s WHERE ${same})`).bind(now, source, run, owners),
    db.prepare(`INSERT INTO cat_prices SELECT s.source,s.provider_id,s.provider_model_id,s.kind,s.tier,s.unit,s.amount,?1,NULL FROM cat_price_stage s WHERE s.run=?3 AND s.source=?2
      AND NOT EXISTS (SELECT 1 FROM cat_prices p WHERE p.source=?2 AND p.valid_to IS NULL AND ${same})`).bind(now, source, run),
    db.prepare('DELETE FROM cat_price_stage WHERE run=?').bind(run),
  ]);
  return { listings: listings.length, added, changed, withdrawn, unresolved: listings.filter(l => !l.model_id).length, prices_opened: opened?.meta.changes ?? 0, prices_closed: closed?.meta.changes ?? 0 };
}

const sourceModelColumns = ['id', 'name', 'organization', 'country', 'domain', 'task', 'release_date', 'parameters', 'training_compute', 'accessibility', 'open_weights', 'base_model', 'hf_developer', 'link',
  'model_id', 'model_basis', 'payload', 'payload_hash'];
export async function storeSourceModels(db: Database, source: string, models: SourceModel[], now: string): Promise<StoreStats> {
  const canonical = (await db.prepare('SELECT id,name FROM cat_models WHERE withdrawn_at IS NULL').all<{ id: string; name: string | null }>()).results;
  const existing = await db.prepare('SELECT id,payload_hash,withdrawn_at FROM cat_source_models WHERE source=?').bind(source).all<{ id: string; payload_hash: string; withdrawn_at: string | null }>();
  const prior = new Map(existing.results.map(r => [r.id, r])), active = existing.results.filter(r => !r.withdrawn_at).length;
  if (active > 50 && models.length < active * .5) throw new Error(`${source} models dropped from ${active} to ${models.length}; previous rows retained.`);
  const rows: Row[] = []; let added = 0, changed = 0;
  for (const m of resolveSourceModels(models, canonical)) {
    const row = pick(sourceModelColumns, { ...m, payload: JSON.stringify(m.payload) });
    row.payload_hash = await digest([m.model_id, m.payload]);
    const old = prior.get(m.id);
    if (!old) added++; else if (old.payload_hash !== row.payload_hash || old.withdrawn_at) changed++;
    rows.push(row);
  }
  await chunked(db, `INSERT INTO cat_source_models (source,${sourceModelColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ?1,${extract(sourceModelColumns)},?2,?2,NULL FROM json_each(?3) WHERE true
    ON CONFLICT(source,id) DO UPDATE SET ${updates(sourceModelColumns, ['id'])},last_seen=excluded.last_seen,withdrawn_at=NULL`, rows, [source, now], 60);
  const withdrawn = (await db.prepare('UPDATE cat_source_models SET withdrawn_at=?1 WHERE source=?2 AND last_seen<?1 AND withdrawn_at IS NULL').bind(now, source).run()).meta.changes;
  return { listings: rows.length, added, changed, withdrawn, unresolved: rows.filter(r => !r.model_id).length, prices_opened: 0, prices_closed: 0 };
}

// Offerings merge every source's listing of one provider route, field by field;
// canonical models merge every source's view of one model the same way.
// Sources are ranked by sourcePreference, Models.dev first. Plain fields take
// the first known value. Capability claims (input modalities and the flags
// below) start from the preferred value; a capability it denies or omits is
// added only when two other sources claim it, so one stale or optimistic feed
// cannot add support. Each row records which sources supplied each field and
// any disagreement.
export const sourcePreference = ['modelsdev', 'reviewed', 'openrouter', 'vercel', 'deepinfra', 'litellm', 'genaiprices', 'portkey-deepgram', 'portkey-elevenlabs', 'portkey-stability-ai', 'truefoundry', 'edenai', 'huggingface', 'epoch'];
const offeringFields = ['model_id', 'model_basis', 'name', 'family', 'type', 'status', 'release_date', 'deprecated_at', 'context', 'max_input', 'max_output', 'input_modalities', 'output_modalities',
  'reasoning', 'tool_call', 'structured_output', 'attachment', 'open_weights', 'hf_id'] as const;
const capabilityFlags = new Set(['reasoning', 'tool_call', 'structured_output', 'attachment']), corroboration = 2;
type OfferingField = typeof offeringFields[number];
export type SourceListing = { source: string; provider_id: string; provider_model_id: string; first_seen: string; last_seen: string } & Record<OfferingField, Value>;
export type Offering = Record<OfferingField, Value> & { kind: string | null; provider_id: string; provider_model_id: string; sources: string; provenance: string; conflicts: string | null; first_seen: string; last_seen: string };
type Voice = { source: string } & Partial<Record<string, Value>>;

const rank = (source: string) => (i => i < 0 ? sourcePreference.length : i)(sourcePreference.indexOf(source));
const modalities = (v: Value | undefined): string[] => { try { const x: unknown = typeof v === 'string' ? JSON.parse(v) : null; return Array.isArray(x) ? x.filter((m): m is string => typeof m === 'string') : []; } catch { return []; } };
const listField = (field: string) => field === 'input_modalities' || field === 'output_modalities';
// OpenRouter calls PDF input "file"; that naming difference is not a disagreement.
const comparable = (field: string, v: Value | undefined) => listField(field) ? JSON.stringify([...new Set(modalities(v).map(m => m === 'file' ? 'pdf' : m))].sort()) : v;

// One value per field from voices already in preference order.
function mergeVoices(voices: readonly Voice[], fields: readonly string[]) {
  const values: Record<string, Value> = {}, provenance: Record<string, string[]> = {}, conflicts: Record<string, Record<string, Value>> = {};
  for (const field of fields) {
    const known = voices.filter(v => v[field] !== null && v[field] !== undefined), [first] = known;
    values[field] = first?.[field] ?? null;
    if (!first) continue;
    provenance[field] = [first.source];
    if (field === 'input_modalities') {
      const base = modalities(first[field]), added: string[] = [], claims = new Map<string, string[]>();
      for (const v of known) for (const m of new Set(modalities(v[field]))) claims.set(m, [...claims.get(m) ?? [], v.source]);
      for (const [m, by] of claims) if (!base.includes(m) && by.length >= corroboration) { added.push(m); provenance[field] = [...new Set([...provenance[field] ?? [], ...by])]; }
      if (added.length) values[field] = JSON.stringify([...base, ...added]);
    } else if (capabilityFlags.has(field) && first[field] === 0) {
      const by = known.filter(v => v[field] === 1).map(v => v.source);
      if (by.length >= corroboration) { values[field] = 1; provenance[field] = by; }
    }
    if (new Set(known.map(v => comparable(field, v[field]))).size > 1) conflicts[field] = Object.fromEntries(known.map(v => [v.source, v[field] ?? null]));
  }
  return { values, provenance: JSON.stringify(provenance), conflicts: Object.keys(conflicts).length ? JSON.stringify(conflicts) : null };
}

// What a model does, from the type labels sources use for a route or model.
// API modes (responses, conversational) are chat; Vercel calls decision models
// "evaluation". Unknown labels stay unknown.
const kinds: Record<string, string> = {
  chat: 'chat', language: 'chat', conversational: 'chat', responses: 'chat', completion: 'chat', realtime: 'chat',
  embedding: 'embedding', 'feature-extraction': 'embedding', 'sentence-similarity': 'embedding',
  rerank: 'rerank', reranking: 'rerank', 'text-ranking': 'rerank',
  evaluation: 'decision', decisions: 'decision',
  moderation: 'moderation', guardrail: 'moderation',
  image: 'image', image_generation: 'image', image_edit: 'image', 'text-to-image': 'image', 'image-to-image': 'image',
  video: 'video', video_generation: 'video', 'text-to-video': 'video', 'image-to-video': 'video', 'image-text-to-video': 'video',
  speech: 'speech', audio_speech: 'speech', 'text-to-speech': 'speech', 'text-to-audio': 'speech',
  'text-to-music': 'music', text_to_speech: 'speech', audio_translation: 'transcription',
  decision: 'decision', transcription: 'transcription', audio_transcription: 'transcription', 'automatic-speech-recognition': 'transcription', ocr: 'ocr',
};
export const modelKind = (type: Value | undefined): string | null => typeof type === 'string' ? kinds[type] ?? null : null;

// Listings of one route, any order.
export function mergeListings(listings: readonly SourceListing[]): Offering {
  const ordered = [...listings].sort((a, b) => rank(a.source) - rank(b.source) || a.source.localeCompare(b.source)), [head] = ordered;
  if (!head) throw new Error('A route needs at least one listing.');
  const { values, provenance, conflicts } = mergeVoices(ordered, offeringFields.filter(f => f !== 'model_basis'));
  // The match basis belongs to the listing that supplied the model ID.
  const basis = ordered.find(l => l.model_id !== null)?.model_basis ?? null;
  const kind = ordered.map(l => modelKind(l.type)).find(k => k !== null) ?? null;
  return { ...values as Record<OfferingField, Value>, kind, model_basis: basis, provider_id: head.provider_id, provider_model_id: head.provider_model_id, sources: JSON.stringify(ordered.map(l => l.source)),
    provenance, conflicts, first_seen: ordered.map(l => l.first_seen).sort()[0] ?? head.first_seen, last_seen: ordered.map(l => l.last_seen).sort().at(-1) ?? head.last_seen };
}

// A source's routes for one model as one voice: a capability any route has, the
// largest limits, and the first known value otherwise.
const modelFields = ['kind', 'name', 'family', 'type', 'release_date', 'knowledge', 'open_weights', 'input_modalities', 'output_modalities', 'reasoning', 'tool_call', 'attachment', 'context', 'max_output'] as const;
type ModelField = typeof modelFields[number];
export type ModelVoice = { source: string } & Partial<Record<ModelField, Value>>;
export function routeVoice(source: string, routes: readonly Partial<Record<ModelField, Value>>[]): ModelVoice {
  const voice: ModelVoice = { source };
  // A route's type is its API mode ("responses", "conversational"), not the model's kind.
  for (const field of modelFields) {
    if (field === 'type') continue;
    if (field === 'kind') { const kind = routes.map(r => modelKind(r.type)).find(k => k !== null); if (kind) voice.kind = kind; continue; }
    const known = routes.map(r => r[field]).filter((v): v is string | number => v !== null && v !== undefined);
    if (!known.length) continue;
    voice[field] = listField(field) ? JSON.stringify([...new Set(known.flatMap(v => modalities(v)))])
      : capabilityFlags.has(field) || field === 'context' || field === 'max_output' ? Math.max(...known.map(Number)) : known[0] ?? null;
  }
  return voice;
}
// One canonical model: the owner's record first in its source's voice, filled
// from that source's routes; every other source contributes its routes.
export function mergeModel(id: string, record: { source: string } & Partial<Record<ModelField, Value>> | null, voices: readonly ModelVoice[]) {
  const bySource = new Map(voices.map(v => [v.source, v]));
  if (record) bySource.set(record.source, { ...bySource.get(record.source), ...Object.fromEntries(Object.entries(record).filter(([, v]) => v !== null && v !== undefined)), source: record.source });
  const ordered = [...bySource.values()].sort((a, b) => rank(a.source) - rank(b.source) || a.source.localeCompare(b.source));
  const { values, provenance, conflicts } = mergeVoices(ordered, modelFields);
  const merged: Record<ModelField, Value> & { id: string; sources: string; provenance: string; conflicts: string | null } = { ...values as Record<ModelField, Value>, id, sources: JSON.stringify(ordered.map(v => v.source)), provenance, conflicts };
  return merged;
}

// Merged rows are staged, then swapped in with one batch, so a failed rebuild
// leaves the previous offerings in place.
export async function rebuildOfferings(db: Database): Promise<{ offerings: number; conflicts: number; corroborated: number }> {
  await ensureCatalogueSchema(db);
  const columns = ['provider_id', 'provider_model_id', ...offeringFields, 'kind', 'sources', 'provenance', 'conflicts', 'first_seen', 'last_seen'];
  await db.prepare('DELETE FROM cat_offering_stage').run();
  const stats = { offerings: 0, conflicts: 0, corroborated: 0 };
  let cursor = ['', '', ''], group: SourceListing[] = [];
  for (;;) {
    const { results } = await db.prepare(`SELECT source,provider_id,provider_model_id,first_seen,last_seen,${offeringFields.join(',')} FROM cat_listings
      WHERE withdrawn_at IS NULL AND (provider_id,provider_model_id,source)>(?1,?2,?3) ORDER BY provider_id,provider_model_id,source LIMIT 1000`).bind(...cursor).all<SourceListing>();
    const rows: Offering[] = [];
    for (const l of results) {
      if (group.length && (group[0]?.provider_id !== l.provider_id || group[0]?.provider_model_id !== l.provider_model_id)) { rows.push(mergeListings(group)); group = []; }
      group.push(l);
    }
    // Carry the unfinished route across pages: its other sources may follow.
    if (results.length < 1000 && group.length) { rows.push(mergeListings(group)); group = []; }
    await chunked(db, 'INSERT INTO cat_offering_stage (value) SELECT value FROM json_each(?1)', rows, []);
    stats.offerings += rows.length;
    stats.conflicts += rows.filter(r => r.conflicts).length;
    stats.corroborated += rows.filter(r => Object.values(JSON.parse(r.provenance) as Record<string, string[]>).some(by => by.length > 1)).length;
    const last = results.at(-1);
    if (results.length < 1000 || !last) break;
    cursor = [last.provider_id, last.provider_model_id, last.source];
  }
  await db.batch([db.prepare('DELETE FROM cat_offerings'), db.prepare(`INSERT INTO cat_offerings (${columns.join(',')}) SELECT ${extract(columns)} FROM cat_offering_stage`), db.prepare('DELETE FROM cat_offering_stage')]);
  return stats;
}

export async function rebuildModels(db: Database): Promise<{ models: number; conflicts: number; corroborated: number }> {
  await ensureCatalogueSchema(db);
  const fields = modelFields.filter(f => f !== 'kind').join(',');
  const records = (await db.prepare(`SELECT id,basis,${fields} FROM cat_models WHERE withdrawn_at IS NULL`).all<{ id: string; basis: string } & Record<ModelField, Value>>()).results;
  // Routes and Epoch rows linked to a live canonical model, one voice per source.
  const routes = (await db.prepare(`SELECT source,model_id,${fields} FROM cat_listings WHERE withdrawn_at IS NULL AND model_id IS NOT NULL ORDER BY model_id,source,provider_id,provider_model_id`).all<{ source: string; model_id: string } & Record<ModelField, Value>>()).results;
  const epoch = (await db.prepare("SELECT 'epoch' source,model_id,release_date,open_weights FROM cat_source_models WHERE withdrawn_at IS NULL AND model_id IS NOT NULL ORDER BY model_id,id").all<{ source: string; model_id: string; release_date: Value; open_weights: Value }>()).results;
  const linked = new Map<string, Map<string, Partial<Record<ModelField, Value>>[]>>();
  for (const r of [...routes, ...epoch]) { const sources = linked.get(r.model_id) ?? new Map(); sources.set(r.source, [...sources.get(r.source) ?? [], r]); linked.set(r.model_id, sources); }
  const rows = records.map(({ id, basis, ...record }) => mergeModel(id, { ...record, kind: modelKind(record.type), source: basis.slice(0, basis.indexOf('-')) }, [...linked.get(id) ?? []].map(([source, list]) => routeVoice(source, list))));
  const columns = ['id', ...modelFields, 'sources', 'provenance', 'conflicts'];
  await db.prepare('DELETE FROM cat_model_stage').run();
  await chunked(db, 'INSERT INTO cat_model_stage (value) SELECT value FROM json_each(?1)', rows, []);
  await db.batch([db.prepare('DELETE FROM cat_model_merged'), db.prepare(`INSERT INTO cat_model_merged (${columns.join(',')}) SELECT ${extract(columns)} FROM cat_model_stage`), db.prepare('DELETE FROM cat_model_stage')]);
  const corroborated = rows.filter(r => Object.values(JSON.parse(r.provenance) as Record<string, string[]>).some(by => by.length > 1)).length;
  return { models: rows.length, conflicts: rows.filter(r => r.conflicts).length, corroborated };
}

// Reviewed identities (catalogue-identities.ts) are stored before every import so
// routes can resolve to them. They never replace another source's record, and
// one removed from the review is withdrawn.
export async function storeReviewedModels(db: Database, now: string): Promise<void> {
  const rows: Row[] = [];
  for (const m of reviewedModels) {
    const payload = { reviewed: m };
    rows.push({ ...pick(modelColumns, { id: m.id, lab_id: m.lab, name: m.name, type: m.kind, basis: 'reviewed-model', payload: JSON.stringify(payload) }), payload_hash: await digest(payload) });
  }
  await chunked(db, `INSERT INTO cat_models (${modelColumns.join(',')},first_seen,last_seen,withdrawn_at) SELECT ${extract(modelColumns)},?1,?1,NULL FROM json_each(?2) WHERE true
    ON CONFLICT(id) DO UPDATE SET ${updates(modelColumns, ['id'])},last_seen=excluded.last_seen,withdrawn_at=NULL WHERE cat_models.basis=excluded.basis`, rows, [now]);
  await db.prepare("UPDATE cat_models SET withdrawn_at=?1 WHERE basis='reviewed-model' AND withdrawn_at IS NULL AND id NOT IN (SELECT value FROM json_each(?2))").bind(now, JSON.stringify(reviewedModels.map(m => m.id))).run();
}

export async function readSource(fetcher: Fetcher, url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
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
  await storeReviewedModels(db, now);
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
      const ext = config.url.endsWith('.csv') ? 'csv' : source === 'truefoundry' ? 'zip' : 'json', key = `catalogue-raw/${source}/${hash}.${ext}`;
      if (bucket && !await bucket.head(key)) await bucket.put(key, bytes, { httpMetadata: { contentType: ext === 'csv' ? 'text/csv' : ext === 'zip' ? 'application/zip' : 'application/json' } });
    }
    const [first, second] = files;
    if (!first) throw new Error('Source returned no data.');
    let stats: StoreStats;
    if (source === 'epoch') {
      const rows = parseEpoch(new TextDecoder().decode(first));
      files.length = 0;
      stats = await storeSourceModels(db, source, rows, now);
    } else {
      let parsed: Parsed;
      if (source === 'modelsdev') {
        // Models.dev leaves some provider entries unlinked; resolve them against its own models and links.
        parsed = parseModelsDev(decode(first), second ? decode(second) : {});
        const linked = parsed.listings.filter(l => l.model_id);
        resolveListings(parsed.listings.filter(l => !l.model_id), { routes: linked, models: new Set(parsed.models.map(m => m.id)),
          repos: [...linked.flatMap(l => l.hf_id && l.model_id ? [{ repo: l.hf_id.toLowerCase(), model_id: l.model_id }] : []), ...weightRepos(parsed.models)] });
      } else {
        const known = new Set((await db.prepare("SELECT id FROM cat_providers WHERE source='modelsdev'").all<{ id: string }>()).results.map(r => r.id));
        const data = source === 'truefoundry' ? null : decode(first);
        parsed = source === 'truefoundry' ? parseTrueFoundry(first) : source === 'litellm' ? parseLiteLLM(data, known) : source === 'openrouter' ? parseOpenRouter(data) : source === 'vercel' ? parseVercel(data) : source === 'deepinfra' ? parseDeepInfra(data, now) : source.startsWith('portkey-') ? parsePortkey(data, source.slice('portkey-'.length), known) : source === 'edenai' ? parseEdenAI(data) : parseGenaiPrices(data, known, now);
        const backbone = await loadBackbone(db);
        // Eden AI's vendor/model links only an existing canonical model; its paths have no meaningful slug.
        if (source === 'edenai') for (const l of parsed.listings) if (l.model_id && !backbone.models.has(l.model_id)) Object.assign(l, { model_id: null, model_basis: null });
        resolveListings(parsed.listings, backbone, { slugs: !source.startsWith('portkey-') && source !== 'edenai' });
        if (source === 'openrouter' || source === 'vercel') parsed.models = gatewayIdentities(source, parsed.listings, backbone.owned);
      }
      files.length = 0;
      stats = await storeCatalogue(db, source, parsed, { now, run });
    }
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
