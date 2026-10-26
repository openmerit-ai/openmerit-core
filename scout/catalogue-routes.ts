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
}

export const catalogueRouteSource = 'catalogue';
const strings = (v: string | null): string[] => { try { const parsed: unknown = JSON.parse(v ?? 'null'); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const https = (v: string | null | undefined): string | null => { if (!v || v.includes('${')) return null; try { const u = new URL(v); return u.protocol === 'https:' && u.hostname !== 'localhost' ? u.href.replace(/\/+$/, '') : null; } catch { return null; } };
// Model types that take chat completions; embeddings, rerankers, speech and media do not.
const chatType = (t: string | null) => t === null || t === 'chat' || t === 'language';
// Where a canonical identity comes from, by its basis prefix (catalogue-db.ts).
const identitySources: Record<string, string> = { modelsdev: 'https://models.dev', openrouter: 'https://openrouter.ai/models', vercel: 'https://vercel.com/ai-gateway/models' };
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
  const canonical = new Map((await db.prepare('SELECT id,lab_id,name,type,release_date,input_modalities,output_modalities,context,weights,basis FROM cat_models WHERE withdrawn_at IS NULL')
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
  const linksOf = (models: readonly ScoutModelLike[]) => {
    const links = new Map<string, string>();
    for (const m of models) {
      const found = new Set<string>();
      if (canonical.has(m.id)) found.add(m.id);
      for (const e of m.endpoints ?? []) { const hit = keys.get(keyOf(e) ?? ''); if (hit) found.add(hit); }
      if (found.size === 1) links.set(m.id, [...found][0] ?? '');
    }
    return links;
  };
  return {
    routes(models, checkedAt) {
      const links = linksOf(models);
      // Scout can list one canonical model under several IDs (an OpenRouter ID and a
      // native ID). Its routes go to one of them: measured first, then the most routes.
      const owner = new Map<string, ScoutModelLike>(), rank = (m: ScoutModelLike) => [m.evidence?.length ? 1 : 0, m.endpoints?.length ?? 0];
      for (const m of models) {
        const target = links.get(m.id), old = target ? owner.get(target) : undefined;
        if (!target) continue;
        const [a1 = 0, a2 = 0] = rank(m), [b1 = 0, b2 = 0] = old ? rank(old) : [-1, -1];
        if (!old || a1 > b1 || a1 === b1 && (a2 > b2 || a2 === b2 && m.id < old.id)) owner.set(target, m);
      }
      const out = new Map<string, ScoutEndpoint[]>();
      for (const m of models) {
        const target = links.get(m.id);
        if (!target || owner.get(target)?.id !== m.id) continue;
        const add = best(target, new Set((m.endpoints ?? []).map(e => String(e.provider ?? '').toLowerCase())), checkedAt);
        if (add.length) out.set(m.id, add);
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
  };
}

export async function catalogueRoutes(db: Database, models: readonly ScoutModelLike[], admitted: Readonly<Record<string, AdmittedProvider>>, checkedAt: string): Promise<Map<string, ScoutEndpoint[]>> {
  return (await loadCatalogue(db, admitted)).routes(models, checkedAt);
}
