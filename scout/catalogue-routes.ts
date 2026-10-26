// Adds hosted routes from the D1 catalogue to Scout's own models. A Scout model
// links to a canonical model through an exact identity: its OpenRouter route,
// its native Models.dev route, or an identical canonical ID. Only reviewed
// inference hosts and model makers' APIs (catalogue-providers.json) with a
// text-output chat contract and positive per-token prices become endpoints.
import type { Database } from './catalogue-db.ts';

export interface AdmittedProvider { kind: 'host' | 'first-party'; api?: string }
export interface ScoutEndpoint {
  id: string; provider: string; modelId: string; api: string; protocol: string; inputPrice: number; outputPrice: number; modalities: string[]; outputModalities: string[];
  parameters: string[]; context: number | null; source: string; checkedAt: string; url: string; pricingBasis: string; deployment: string; configuration: string; status: string; providerKind: string;
}
interface ScoutModelLike { id: string; evidence?: readonly unknown[]; endpoints?: ReadonlyArray<{ provider?: string | null; modelId?: string; source?: string }> }

export const catalogueRouteSource = 'catalogue';
const strings = (v: string | null): string[] => { try { const parsed: unknown = JSON.parse(v ?? 'null'); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const https = (v: string | null | undefined): string | null => { if (!v || v.includes('${')) return null; try { const u = new URL(v); return u.protocol === 'https:' && u.hostname !== 'localhost' ? u.href.replace(/\/+$/, '') : null; } catch { return null; } };

// Returns new endpoints per Scout model ID. Models whose identity links are
// ambiguous get none; a provider the model already has is never added twice.
export async function catalogueRoutes(db: Database, models: readonly ScoutModelLike[], admitted: Readonly<Record<string, AdmittedProvider>>, checkedAt: string): Promise<Map<string, ScoutEndpoint[]>> {
  const providerRows = (await db.prepare("SELECT id,name,api,doc FROM cat_providers WHERE source='modelsdev'").all<{ id: string; name: string | null; api: string | null; doc: string | null }>()).results;
  const byName = new Map(providerRows.map(p => [(p.name ?? p.id).toLowerCase(), p.id]));
  const router = new Map((await db.prepare("SELECT provider_model_id,model_id FROM cat_listings WHERE provider_id='openrouter' AND source='openrouter' AND model_id IS NOT NULL AND withdrawn_at IS NULL")
    .all<{ provider_model_id: string; model_id: string }>()).results.map(r => [r.provider_model_id, r.model_id]));
  // Native endpoints name their Models.dev provider; look up exactly those routes.
  const native = models.flatMap(m => (m.endpoints ?? []).filter(e => e.source === 'modelsdev' && e.provider && e.modelId).map(e => [byName.get(String(e.provider).toLowerCase()) ?? '', e.modelId ?? '']));
  const nativeLinks = new Map((await db.prepare("SELECT provider_id,provider_model_id,model_id FROM cat_listings WHERE source='modelsdev' AND model_id IS NOT NULL AND withdrawn_at IS NULL AND provider_id||'|'||provider_model_id IN (SELECT json_extract(value,'$[0]')||'|'||json_extract(value,'$[1]') FROM json_each(?1))")
    .bind(JSON.stringify(native)).all<{ provider_id: string; provider_model_id: string; model_id: string }>()).results.map(r => [`${r.provider_id}|${r.provider_model_id}`, r.model_id]));
  const canonical = new Set((await db.prepare('SELECT id FROM cat_models WHERE withdrawn_at IS NULL AND id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(models.map(m => m.id))).all<{ id: string }>()).results.map(r => r.id));

  const links = new Map<string, string>();
  for (const m of models) {
    const found = new Set<string>();
    if (canonical.has(m.id)) found.add(m.id);
    for (const e of m.endpoints ?? []) {
      if (e.source === 'models' && e.modelId && router.has(e.modelId)) found.add(router.get(e.modelId) ?? '');
      if (e.source === 'modelsdev' && e.provider && e.modelId) { const hit = nativeLinks.get(`${byName.get(e.provider.toLowerCase()) ?? ''}|${e.modelId}`); if (hit) found.add(hit); }
    }
    found.delete('');
    if (found.size === 1) links.set(m.id, [...found][0] ?? '');
  }
  // Scout can list one canonical model under several IDs (an OpenRouter ID and a
  // native ID). Its routes go to one of them: measured first, then the most routes.
  const owner = new Map<string, ScoutModelLike>(), rank = (m: ScoutModelLike) => [m.evidence?.length ? 1 : 0, m.endpoints?.length ?? 0];
  for (const m of models) {
    const target = links.get(m.id), old = target ? owner.get(target) : undefined;
    if (!target) continue;
    const [a1 = 0, a2 = 0] = rank(m), [b1 = 0, b2 = 0] = old ? rank(old) : [-1, -1];
    if (!old || a1 > b1 || a1 === b1 && (a2 > b2 || a2 === b2 && m.id < old.id)) owner.set(target, m);
  }
  for (const [id, target] of links) if (owner.get(target)?.id !== id) links.delete(id);
  const ids = Object.keys(admitted), targets = [...new Set(links.values())];
  if (!ids.length || !targets.length) return new Map();
  const offerings = (await db.prepare(`SELECT provider_id,provider_model_id,model_id,status,context,input_modalities,output_modalities,tool_call,structured_output,sources FROM cat_offerings
    WHERE provider_id IN (SELECT value FROM json_each(?1)) AND model_id IN (SELECT value FROM json_each(?2))`).bind(JSON.stringify(ids), JSON.stringify(targets))
    .all<{ provider_id: string; provider_model_id: string; model_id: string; status: string | null; context: number | null; input_modalities: string | null; output_modalities: string | null;
      tool_call: number | null; structured_output: number | null; sources: string }>()).results;
  // Base per-token prices currently in force; Models.dev's own figure first.
  const prices = new Map<string, { input?: number; output?: number; sources: Set<string> }>();
  const priceRows = (await db.prepare(`SELECT source,provider_id,provider_model_id,kind,amount FROM cat_prices WHERE provider_id IN (SELECT value FROM json_each(?1)) AND valid_to IS NULL AND tier='' AND unit='usd_per_mtok' AND kind IN ('input','output')
    ORDER BY CASE source WHEN 'modelsdev' THEN 0 ELSE 1 END,source`).bind(JSON.stringify(ids)).all<{ source: string; provider_id: string; provider_model_id: string; kind: 'input' | 'output'; amount: number }>()).results;
  for (const p of priceRows) {
    const key = `${p.provider_id}|${p.provider_model_id}`, entry = prices.get(key) ?? { sources: new Set<string>() };
    if (entry[p.kind] === undefined) { entry[p.kind] = p.amount; entry.sources.add(p.source); }
    prices.set(key, entry);
  }
  const providers = new Map(providerRows.map(p => [p.id, p]));
  const byCanonical = new Map<string, ScoutEndpoint[]>();
  for (const o of offerings) {
    const config = admitted[o.provider_id], provider = providers.get(o.provider_id), price = prices.get(`${o.provider_id}|${o.provider_model_id}`);
    const base = https(config?.api ?? provider?.api), inputs = strings(o.input_modalities), outputs = strings(o.output_modalities);
    if (!config || !base || o.status === 'deprecated' || !inputs.includes('text') || outputs.length !== 1 || outputs[0] !== 'text') continue;
    if (!price?.input || !price.output || price.input <= 0 || price.output <= 0) continue;
    const name = provider?.name ?? o.provider_id, sources = [...price.sources].join(', ');
    const list = byCanonical.get(o.model_id) ?? [];
    list.push({ id: `${catalogueRouteSource}:${o.provider_id}:chat-completions:${o.provider_model_id}`, provider: name, modelId: o.provider_model_id, api: `${base}/chat/completions`, protocol: 'chat-completions',
      inputPrice: price.input, outputPrice: price.output, modalities: inputs, outputModalities: outputs, parameters: [o.tool_call && 'tools', o.structured_output && 'structured_outputs'].filter((x): x is string => typeof x === 'string'),
      context: o.context, source: catalogueRouteSource, checkedAt, url: https(provider?.doc) ?? base, pricingBasis: `Provider token rates reported by ${sources}; verify current tiers with the provider.`,
      deployment: 'hosted', configuration: 'provider default', status: o.status ?? 'listed', providerKind: config.kind });
    byCanonical.set(o.model_id, list);
  }
  const out = new Map<string, ScoutEndpoint[]>();
  for (const m of models) {
    const target = links.get(m.id), have = new Set((m.endpoints ?? []).map(e => String(e.provider ?? '').toLowerCase()));
    // One route per provider: the cheapest when a provider lists the model under several IDs.
    const blended = (e: ScoutEndpoint) => e.inputPrice * 3 + e.outputPrice;
    const best = new Map<string, ScoutEndpoint>();
    for (const e of target ? byCanonical.get(target) ?? [] : []) { const k = e.provider.toLowerCase(), old = best.get(k); if (!have.has(k) && (!old || blended(e) < blended(old) || blended(e) === blended(old) && e.id < old.id)) best.set(k, e); }
    const add = [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (add.length) out.set(m.id, add);
  }
  return out;
}
