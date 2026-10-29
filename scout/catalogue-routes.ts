// Supplies Scout with hosted routes and models from the D1 catalogue. A Scout
// model links to a canonical model through an exact identity: its OpenRouter
// route, its native Models.dev route, or an identical canonical ID. Only reviewed
// inference hosts and model makers' APIs (catalogue-providers.json) with a
// text-output chat contract and positive per-token prices become endpoints.
// Canonical chat models with such routes that no Scout model links to become
// Scout models of their own, so benchmark rows naming them are kept.
import type { Database } from './catalogue-db.ts';

export interface AdmittedProvider { kind: 'host' | 'first-party'; api?: string }
export interface ScoutEndpoint {
  id: string; provider: string; modelId: string; api: string; protocol: string; inputPrice: number; outputPrice: number; modalities: string[]; outputModalities: string[];
  parameters: string[]; context: number | null; source: string; checkedAt: string; url: string; pricingBasis: string; deployment: string; configuration: string; status: string; providerKind: string;
}
interface ScoutModelLike { id: string; evidence?: readonly unknown[]; endpoints?: ReadonlyArray<{ provider?: string | null; modelId?: string; source?: string }> }
interface Fact { field: string; value: string; url: string; basis: string }
export interface CatalogueModel {
  id: string; name: string; provider: string; canonical: string; repository: string | null; modalities: string[]; outputModalities: string[]; parameters: string[]; context: number | null;
  facts: Fact[]; inputPrice: number; outputPrice: number; speed: null; evidence: never[]; endpoints: ScoutEndpoint[]; listedBy: typeof catalogueRouteSource;
}
export interface CatalogueSupply {
  // New endpoints per Scout model ID; ambiguous links get none and a provider a model already has is never added twice.
  routes(models: readonly ScoutModelLike[], checkedAt: string): Map<string, ScoutEndpoint[]>;
  // Canonical chat models with routes that none of `models` links to.
  models(models: readonly ScoutModelLike[], checkedAt: string): CatalogueModel[];
  // Exact catalogue aliases (normalized) of models Scout lists: canonical IDs and
  // names, every provider's model ID and Hugging Face repository for that model.
  aliases(models: readonly ScoutModelLike[]): Map<string, string>;
  // The model family each Scout model links to through an exact identity: its canonical ID
  // without namespace, punctuation or a dated suffix, so catalogue copies of one model agree.
  families(models: readonly ScoutModelLike[]): Map<string, string>;
  // Vercel AI Gateway decision routes as typed endpoint contracts, in endpoint-contracts.json's shape.
  decisionRoutes(): DecisionContract[];
  // Linked decision-leaderboard results per canonical model (catalogue-boards.ts).
  decisionScores(): Record<string, DecisionScore>;
}
// A model's standing on each decision board: the share of that board's other results it
// beats (ties count half), in the board's own direction. Quality is the mean over boards.
export interface DecisionScore { quality: number; results: Array<{ board: string; title: string; url: string; metric: string; model: string; score: number; percentile: number; publishedAt: string | null }> }
export interface DecisionContract {
  id: string; model: string; name: string; provider: string; modelId: string; api: string; protocol: string; operations: string[]; labelMode: 'supplied';
  modalities: string[]; parameters: string[]; context: number | null; inputPrice: number; outputPrice: number; url: string; source: string; status: string; pricingBasis: string; limits: string;
}
// Vercel's gateway answers choice, score and boolean questions for every decision model it routes.
export const decisionGateway = { source: 'vercel-decisions', provider: 'Vercel AI Gateway', api: 'https://ai-gateway.vercel.sh/v1/evaluate', protocol: 'vercel-evaluate', url: 'https://vercel.com/docs/ai-gateway/modalities/decision' };

export const catalogueRouteSource = 'catalogue';
const strings = (v: string | null): string[] => { try { const parsed: unknown = JSON.parse(v ?? 'null'); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const https = (v: string | null | undefined): string | null => { if (!v || v.includes('${')) return null; try { const u = new URL(v); return u.protocol === 'https:' && u.hostname !== 'localhost' ? u.href.replace(/\/+$/, '') : null; } catch { return null; } };
// Model types that take chat completions; embeddings, rerankers, speech and media do not.
const chatType = (t: string | null) => t === null || t === 'chat' || t === 'language';
// Where a canonical identity comes from, by its basis prefix (catalogue-db.ts).
const identitySources: Record<string, string> = { modelsdev: 'https://models.dev', openrouter: 'https://openrouter.ai/models', vercel: 'https://vercel.com/ai-gateway/models' };
// Same normalization as Scout's benchmark-row matching (sources.mjs).
const norm = (v: string) => v.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
// Dated IDs (claude-…-20250219, …-2025-02-19, Cohere's command-a-03-2025) are copies of one model.
const family = (id: string) => norm((id.split('/').pop() ?? id).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4})$/, ''));
const blended = (e: { inputPrice: number; outputPrice: number }) => e.inputPrice * 3 + e.outputPrice;
const keyOf = (e: { provider?: string | null; modelId?: string; source?: string }) =>
  e.source === 'models' && e.modelId ? `models|${e.modelId}` : e.source === 'modelsdev' && e.provider && e.modelId ? `modelsdev|${e.provider.toLowerCase()}|${e.modelId}` : null;

// Reads everything once, so collection makes one bounded set of D1 queries.
export async function loadCatalogue(db: Database, admitted: Readonly<Record<string, AdmittedProvider>>): Promise<CatalogueSupply> {
  const providerRows = (await db.prepare("SELECT id,name,api,doc FROM cat_providers WHERE source='modelsdev'").all<{ id: string; name: string | null; api: string | null; doc: string | null }>()).results;
  const providers = new Map(providerRows.map(p => [p.id, p])), ids = Object.keys(admitted);
  // Identity keys of Scout's own endpoints: OpenRouter route IDs and native Models.dev routes (by provider name).
  const keys = new Map((await db.prepare(`SELECT 'models|'||l.provider_model_id k,l.model_id FROM cat_listings l WHERE l.source='openrouter' AND l.provider_id='openrouter' AND l.model_id IS NOT NULL AND l.withdrawn_at IS NULL
    UNION ALL SELECT 'modelsdev|'||lower(coalesce(p.name,p.id))||'|'||l.provider_model_id,l.model_id FROM cat_listings l JOIN cat_providers p ON p.source='modelsdev' AND p.id=l.provider_id
    WHERE l.source='modelsdev' AND l.model_id IS NOT NULL AND l.withdrawn_at IS NULL`).all<{ k: string; model_id: string }>()).results.map(r => [r.k, r.model_id]));
  const canonical = new Map((await db.prepare(`SELECT m.id,m.lab_id,${['name', 'type', 'release_date', 'input_modalities', 'output_modalities', 'context'].map(f => `coalesce(g.${f},m.${f}) ${f}`).join(',')},m.weights,m.basis
    FROM cat_models m LEFT JOIN cat_model_merged g ON g.id=m.id WHERE m.withdrawn_at IS NULL`)
    .all<{ id: string; lab_id: string; name: string | null; type: string | null; release_date: string | null; input_modalities: string | null; output_modalities: string | null; context: number | null; weights: string | null; basis: string }>()).results.map(m => [m.id, m]));
  const offerings = ids.length ? (await db.prepare(`SELECT provider_id,provider_model_id,model_id,type,status,context,input_modalities,output_modalities,tool_call,structured_output FROM cat_offerings
    WHERE provider_id IN (SELECT value FROM json_each(?1)) AND model_id IS NOT NULL`).bind(JSON.stringify(ids))
    .all<{ provider_id: string; provider_model_id: string; model_id: string; type: string | null; status: string | null; context: number | null; input_modalities: string | null; output_modalities: string | null;
      tool_call: number | null; structured_output: number | null }>()).results : [];
  // Base per-token prices currently in force; Models.dev's own figure first.
  const prices = new Map<string, { input?: number; output?: number; sources: Set<string> }>();
  const priceRows = ids.length ? (await db.prepare(`SELECT source,provider_id,provider_model_id,kind,amount FROM cat_prices WHERE provider_id IN (SELECT value FROM json_each(?1)) AND valid_to IS NULL AND tier='' AND unit='usd_per_mtok' AND kind IN ('input','output')
    ORDER BY CASE source WHEN 'modelsdev' THEN 0 ELSE 1 END,source`).bind(JSON.stringify(ids)).all<{ source: string; provider_id: string; provider_model_id: string; kind: 'input' | 'output'; amount: number }>()).results : [];
  for (const p of priceRows) {
    const key = `${p.provider_id}|${p.provider_model_id}`, entry = prices.get(key) ?? { sources: new Set<string>() };
    if (entry[p.kind] === undefined) { entry[p.kind] = p.amount; entry.sources.add(p.source); }
    prices.set(key, entry);
  }
  // Routes per canonical model, without the run's checkedAt.
  const byCanonical = new Map<string, Array<Omit<ScoutEndpoint, 'checkedAt'>>>();
  for (const o of offerings) {
    const config = admitted[o.provider_id], provider = providers.get(o.provider_id), price = prices.get(`${o.provider_id}|${o.provider_model_id}`);
    const base = https(config?.api ?? provider?.api), inputs = strings(o.input_modalities), outputs = strings(o.output_modalities);
    if (!config || !base || o.status === 'deprecated' || !chatType(o.type) || !inputs.includes('text') || outputs.length !== 1 || outputs[0] !== 'text') continue;
    if (!price?.input || !price.output || price.input <= 0 || price.output <= 0) continue;
    const name = provider?.name ?? o.provider_id, sources = [...price.sources].join(', ');
    const list = byCanonical.get(o.model_id) ?? [];
    list.push({ id: `${catalogueRouteSource}:${o.provider_id}:chat-completions:${o.provider_model_id}`, provider: name, modelId: o.provider_model_id, api: `${base}/chat/completions`, protocol: 'chat-completions',
      inputPrice: price.input, outputPrice: price.output, modalities: inputs, outputModalities: outputs, parameters: [o.tool_call && 'tools', o.structured_output && 'structured_outputs'].filter((x): x is string => typeof x === 'string'),
      context: o.context, source: catalogueRouteSource, url: https(provider?.doc) ?? base, pricingBasis: `Provider token rates reported by ${sources}; verify current tiers with the provider.`,
      deployment: 'hosted', configuration: 'provider default', status: o.status ?? 'listed', providerKind: config.kind });
    byCanonical.set(o.model_id, list);
  }
  // One route per provider: the cheapest when a provider lists the model under several IDs.
  const best = (target: string, have: ReadonlySet<string>, checkedAt: string): ScoutEndpoint[] => {
    const out = new Map<string, ScoutEndpoint>();
    for (const e of byCanonical.get(target) ?? []) { const k = e.provider.toLowerCase(), old = out.get(k); if (!have.has(k) && (!old || blended(e) < blended(old) || blended(e) === blended(old) && e.id < old.id)) out.set(k, { ...e, checkedAt }); }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  // Canonical models a Scout model reaches through its ID or its endpoints' exact identities.
  const found = (m: ScoutModelLike) => {
    const out = new Set<string>();
    if (canonical.has(m.id)) out.add(m.id);
    for (const e of m.endpoints ?? []) { const hit = keys.get(keyOf(e) ?? ''); if (hit) out.add(hit); }
    return out;
  };
  // A Scout model links to the canonical models it reaches when they are copies
  // of one model (cohere/command-a and its dated ID command-a-03-2025).
  const linksOf = (models: readonly ScoutModelLike[]) => {
    const links = new Map<string, string[]>();
    for (const m of models) { const targets = [...found(m)]; if (targets.length && new Set(targets.map(family)).size === 1) links.set(m.id, targets); }
    return links;
  };
  // Scout can list one canonical model under several IDs (an OpenRouter ID and a
  // native ID). Its routes and aliases go to one of them: measured first, then the most routes.
  const rank = (m: ScoutModelLike) => [m.evidence?.length ? 1 : 0, m.endpoints?.length ?? 0];
  const better = (m: ScoutModelLike, old: ScoutModelLike | undefined) => {
    const [a1 = 0, a2 = 0] = rank(m), [b1 = 0, b2 = 0] = old ? rank(old) : [-1, -1];
    return !old || a1 > b1 || a1 === b1 && (a2 > b2 || a2 === b2 && m.id < old.id);
  };
  const ownersOf = (models: readonly ScoutModelLike[]) => {
    const links = linksOf(models), owner = new Map<string, ScoutModelLike>();
    for (const m of models) for (const target of links.get(m.id) ?? []) if (better(m, owner.get(target))) owner.set(target, m);
    return owner;
  };
  // Names each canonical model goes by across the catalogue: its ID and name, every
  // listing's model ID (without a namespace or version tag) and name (without a
  // "Lab:" prefix), Hugging Face repositories, and names benchmark-tracking sources use.
  const names = new Map<string, Set<string>>();
  const named = (key: string | null | undefined, model: string) => { const k = norm(key ?? ''); if (k.length < 3) return; const set = names.get(k) ?? new Set<string>(); set.add(model); names.set(k, set); };
  for (const [id, m] of canonical) { named(id.split('/').slice(1).join('/'), id); named(m.name, id); }
  for (const l of (await db.prepare(`SELECT provider_model_id id,name,model_id FROM cat_listings WHERE model_id IS NOT NULL AND withdrawn_at IS NULL
    UNION ALL SELECT hf_id,NULL,model_id FROM cat_listings WHERE hf_id IS NOT NULL AND model_id IS NOT NULL AND withdrawn_at IS NULL
    UNION ALL SELECT id,name,model_id FROM cat_source_models WHERE model_id IS NOT NULL AND withdrawn_at IS NULL
    UNION ALL SELECT id,NULL,model_id FROM cat_hf_models WHERE model_id IS NOT NULL AND withdrawn_at IS NULL`).all<{ id: string; name: string | null; model_id: string }>()).results) {
    if (!canonical.has(l.model_id)) continue;
    named(l.id.split('/').pop()?.replace(/:[^:]*$/, ''), l.model_id); named(l.name?.replace(/^[^:]+:\s*/, ''), l.model_id);
  }
  // Hosts shorten names ("Qwen 2.5 Coder 32B" for the Instruct model). A model maker's
  // other repository by that name, such as the base model, makes the name ambiguous.
  for (const r of (await db.prepare(`SELECT id FROM cat_hf_models WHERE model_id IS NULL AND withdrawn_at IS NULL
    AND author IN (SELECT author FROM cat_hf_models WHERE model_id IS NOT NULL AND withdrawn_at IS NULL)`).all<{ id: string }>()).results) named(r.id.split('/').pop(), `huggingface:${r.id}`);
  // Decision routes need a current input rate; Vercel bills decisions on input tokens only.
  const decisionRows = (await db.prepare(`SELECT o.provider_model_id,o.model_id,o.name,o.status,o.context,o.input_modalities,p.amount input FROM cat_offerings o
    JOIN cat_prices p ON p.provider_id=o.provider_id AND p.provider_model_id=o.provider_model_id AND p.valid_to IS NULL AND p.tier='' AND p.unit='usd_per_mtok' AND p.kind='input'
    WHERE o.provider_id='vercel' AND o.kind='decision' AND o.model_id IS NOT NULL AND (o.status IS NULL OR o.status<>'deprecated') ORDER BY o.provider_model_id,CASE p.source WHEN 'vercel' THEN 0 ELSE 1 END`)
    .all<{ provider_model_id: string; model_id: string; name: string | null; status: string | null; context: number | null; input_modalities: string | null; input: number }>()).results;
  // The board tables exist only once a refresh has imported a leaderboard.
  const boardRows = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cat_board_results'").all()).results.length ? (await db.prepare(`SELECT b.id board,b.title,b.url,b.metric,b.direction,b.published_at,r.model,r.score,r.model_id
    FROM cat_board_results r JOIN cat_boards b ON b.id=r.board AND b.version=r.version WHERE b.kind='decision'`)
    .all<{ board: string; title: string; url: string; metric: string; direction: string; published_at: string | null; model: string; score: number; model_id: string | null }>()).results : [];
  return {
    decisionScores() {
      const boards = new Map<string, typeof boardRows>(), best = new Map<string, Map<string, DecisionScore['results'][number]>>();
      for (const r of boardRows) boards.set(r.board, [...(boards.get(r.board) ?? []), r]);
      for (const rows of boards.values()) for (const r of rows) {
        if (!r.model_id || rows.length < 2) continue;
        const sign = r.direction === 'lower' ? -1 : 1, beaten = rows.reduce((n, o) => n + (o === r ? 0 : sign * (r.score - o.score) > 0 ? 1 : r.score === o.score ? .5 : 0), 0);
        const result = { board: r.board, title: r.title, url: r.url, metric: r.metric, model: r.model, score: r.score, percentile: beaten / (rows.length - 1), publishedAt: r.published_at };
        const mine = best.get(r.model_id) ?? new Map<string, DecisionScore['results'][number]>();
        if ((mine.get(r.board)?.percentile ?? -1) < result.percentile) mine.set(r.board, result);
        best.set(r.model_id, mine);
      }
      return Object.fromEntries([...best].map(([id, m]) => { const results = [...m.values()]; return [id, { quality: results.reduce((n, x) => n + x.percentile, 0) / results.length, results }]; }));
    },
    decisionRoutes() {
      // Vercel can list one model under a paid and a free-tier ID with the same name; the first ID stands for both.
      const out = new Map<string, DecisionContract>(), seen = new Set<string>();
      for (const r of decisionRows) {
        const model = canonical.get(r.model_id), inputs = strings(r.input_modalities), name = model?.name ?? r.name ?? r.provider_model_id;
        const same = `${r.provider_model_id.split('/')[0]}|${norm(name)}`;
        if (out.has(r.provider_model_id) || !(r.input >= 0) || !inputs.includes('text') || seen.has(same)) continue;
        seen.add(same);
        out.set(r.provider_model_id, { id: `${decisionGateway.source}:${decisionGateway.protocol}:${r.provider_model_id}`, model: r.model_id, name,
          provider: decisionGateway.provider, modelId: r.provider_model_id, api: decisionGateway.api, protocol: decisionGateway.protocol, operations: ['classify', 'judge'], labelMode: 'supplied',
          modalities: inputs, parameters: ['structured_outputs'], context: r.context ?? model?.context ?? null, inputPrice: r.input, outputPrice: 0, url: decisionGateway.url, source: decisionGateway.source,
          status: r.status ?? 'listed', pricingBasis: 'Vercel AI Gateway decision rate: input tokens only. Promotional and free-tier rates can end; image tokenization affects the actual bill.',
          limits: 'Supplied choices, ordered rubric scores and boolean probabilities. No arbitrary field extraction, free-form answers, tool execution, boxes or masks.' });
      }
      return [...out.values()];
    },
    routes(models, checkedAt) {
      const out = new Map<string, ScoutEndpoint[]>();
      for (const [target, m] of ownersOf(models)) {
        // A model owning several copies takes each host once, from the first copy offering it.
        const prior = out.get(m.id) ?? [], add = best(target, new Set([...(m.endpoints ?? []), ...prior].map(e => String(e.provider ?? '').toLowerCase())), checkedAt);
        if (add.length) out.set(m.id, [...prior, ...add]);
      }
      return out;
    },
    models(models, checkedAt) {
      // Any link counts here, ambiguous ones included: those models are already in Scout.
      const linked = new Set(models.flatMap(m => [m.id, ...(m.endpoints ?? []).map(e => keys.get(keyOf(e) ?? '') ?? '')]));
      const out: CatalogueModel[] = [];
      for (const [id, model] of canonical) {
        const outputs = strings(model.output_modalities);
        if (linked.has(id) || !byCanonical.has(id) || !chatType(model.type) || outputs.length && (outputs.length !== 1 || outputs[0] !== 'text')) continue;
        const endpoints = best(id, new Set(), checkedAt), cheapest = [...endpoints].sort((a, b) => blended(a) - blended(b))[0];
        if (!cheapest) continue;
        const lab = providers.get(model.lab_id)?.name ?? model.lab_id, url = identitySources[model.basis.split('-')[0] ?? ''] ?? 'https://models.dev';
        const repository = /https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/.exec(model.weights ?? '')?.[1] ?? null;
        out.push({ id, name: model.name ?? id, provider: lab, canonical: id, repository, modalities: strings(model.input_modalities).length ? strings(model.input_modalities) : cheapest.modalities, outputModalities: ['text'],
          parameters: [...new Set(endpoints.flatMap(e => e.parameters))], context: model.context ?? (Math.max(0, ...endpoints.map(e => e.context ?? 0)) || null),
          facts: [{ field: 'creator', value: lab, url, basis: 'Creator from the canonical model identity in the OpenMerit catalogue.' },
            ...(model.release_date ? [{ field: 'releasedAt', value: model.release_date, url, basis: 'Release date reported by the model catalogue; not its last update.' }] : [])],
          inputPrice: cheapest.inputPrice, outputPrice: cheapest.outputPrice, speed: null, evidence: [], endpoints, listedBy: catalogueRouteSource });
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    families(models) {
      // Several catalogue copies of one model still name one family; routes stay with exact links only.
      const out = new Map<string, string>();
      for (const m of models) { const set = new Set([...found(m)].map(family)), [only] = set; if (only && set.size === 1) out.set(m.id, only); }
      return out;
    },
    aliases(models) {
      const owners = ownersOf(models), out = new Map<string, string>();
      for (const [key, targets] of names) {
        // A name several distinct canonical models share is no identity. Copies of one
        // model (dotted vs dashed versions, or a dated snapshot of an alias) count as one,
        // and when Scout lists several copies the name goes to the best-ranked one.
        if (new Set([...targets].map(family)).size !== 1) continue;
        let best: ScoutModelLike | undefined;
        for (const t of targets) { const m = owners.get(t); if (m && better(m, best)) best = m; }
        if (best) out.set(key, best.id);
      }
      return out;
    },
  };
}

export async function catalogueRoutes(db: Database, models: readonly ScoutModelLike[], admitted: Readonly<Record<string, AdmittedProvider>>, checkedAt: string): Promise<Map<string, ScoutEndpoint[]>> {
  return (await loadCatalogue(db, admitted)).routes(models, checkedAt);
}
