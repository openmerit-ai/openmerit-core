import { MODELS } from './scenario.ts';
import type { Model, Prices } from './scenario.ts';
export const OPEN_WEIGHT_CANDIDATES: Record<string, { name: string; weightsSource: string }> = {
  'qwen/qwen3.5-9b': { name: 'Qwen 3.5 9B', weightsSource: 'https://huggingface.co/Qwen/Qwen3.5-9B' },
  'meta-llama/llama-3.1-8b-instruct': { name: 'Llama 3.1 8B', weightsSource: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct' },
  'google/gemma-3-12b-it': { name: 'Gemma 3 12B', weightsSource: 'https://huggingface.co/google/gemma-3-12b-it' },
  'mistralai/mistral-small-3.2-24b-instruct': { name: 'Mistral Small 3.2 24B', weightsSource: 'https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506' },
};
export const CATALOG_SOURCES = {
  openrouter: 'https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=structured_outputs&sort=latency-low-to-high',
  openai: 'https://api.openai.com/v1/models',
};
export const DIRECT_ADAPTERS: Record<string, { name: string; prices: Prices; reasoning?: string }> = {
  'gpt-5.4-nano': { name: 'GPT-5.4 nano', prices: { input: .2, cached: .02, output: 1.25 }, reasoning: 'none' },
  'gpt-4o-mini': { name: 'GPT-4o mini', prices: { input: .15, cached: .075, output: .6 } },
};
export const SEARCH_LIMITS = { extraRoutes: 6, catalogModels: 8, verificationCalls: 12 };
interface CatalogData { data: { id: string; name?: string; pricing?: { prompt: string; completion: string; request?: string }; expiration_date?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; supported_parameters?: string[]; context_length?: number }[] }
export function normalizeCatalog(openrouter: CatalogData | null, openai: CatalogData | null, at = new Date().toISOString()) {
  const existing = new Set(Object.values(MODELS).map(m => `${m.transport}:${m.id}`));
  const compatible = (openrouter?.data ?? []).filter(m => {
    const prompt = Number(m.pricing?.prompt), completion = Number(m.pricing?.completion), request = Number(m.pricing?.request ?? 0);
    return typeof m.id === 'string' && /^[\w.:/-]{1,180}$/.test(m.id) && !existing.has(`openrouter:${m.id}`) &&
      !/safeguard|moderation|embed|rerank|morph/i.test(m.id) && !m.expiration_date &&
      m.architecture?.input_modalities?.includes('text') && m.architecture?.output_modalities?.includes('text') &&
      m.supported_parameters?.includes('structured_outputs') && m.supported_parameters?.includes('response_format') &&
      m.supported_parameters?.includes('temperature') && Number(m.context_length) >= 8192 &&
      Number.isFinite(prompt) && prompt >= 0 && prompt <= 1e-6 && Number.isFinite(completion) && completion >= 0 && completion <= 5e-6 && request === 0;
  });
  const curated = Object.keys(OPEN_WEIGHT_CANDIDATES).flatMap(id => compatible.find(m => m.id === id) ?? []);
  const router = [...curated, ...compatible.filter(m => !Object.hasOwn(OPEN_WEIGHT_CANDIDATES, m.id))].slice(0, SEARCH_LIMITS.catalogModels).map(m => ({ key: `or:${m.id}`, id: m.id, name: String(m.name ?? m.id).slice(0, 100), provider: 'OpenRouter', transport: 'openrouter',
    ...(Object.hasOwn(OPEN_WEIGHT_CANDIDATES, m.id) ? { ...OPEN_WEIGHT_CANDIDATES[m.id], openWeights: true, hosting: 'cloud', deploymentLabel: 'Open weights · Hosted on OpenRouter' } : {}),
    ...(m.supported_parameters!.includes('reasoning') ? { reasoning: 'disabled' } : {}),
    catalog: { source: CATALOG_SOURCES.openrouter, checkedAt: at, promptPrice: Number(m.pricing!.prompt), completionPrice: Number(m.pricing!.completion), prior: 'Provider catalogue latency ordering; untested on this task.' } }));
  const ids = new Set((openai?.data ?? []).map(m => m.id));
  const direct = Object.entries(DIRECT_ADAPTERS).filter(([id]) => ids.has(id)).map(([id, adapter]) => ({ key: `oa:${id}`, id, ...adapter, provider: 'OpenAI direct', transport: 'openai', catalog: { source: CATALOG_SOURCES.openai, checkedAt: at, prior: 'Account catalogue availability; untested on this task.' } }));
  const models: (Model & { key: string })[] = [];
  for (let i = 0; i < Math.max(router.length, direct.length); i++) { if (direct[i]) models.push(direct[i]!); if (router[i]) models.push(router[i]!); }
  return { models: models.slice(0, SEARCH_LIMITS.catalogModels), checkedAt: at, sources: CATALOG_SOURCES };
}
export async function discoverCatalog({ openaiKey, openrouterKey, fetcher = fetch }: { openaiKey?: string | undefined; openrouterKey?: string | undefined; fetcher?: typeof fetch } = {}) {
  const sources = ['openrouter', 'openai'] as const;
  const results = await Promise.allSettled(sources.map(async source => {
    const key = source === 'openai' ? openaiKey : openrouterKey;
    if (!key) throw new Error('Provider is not configured.');
    const response = await fetcher(CATALOG_SOURCES[source], { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Catalogue returned HTTP ${response.status}.`);
    const data = await response.json() as CatalogData; if (!Array.isArray(data.data)) throw new Error('Catalogue returned an invalid model list.'); return data;
  }));
  const [router, direct] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  return { ...normalizeCatalog(router!, direct!), errors: results.flatMap((result, i) => result.status === 'rejected' ? [{ source: sources[i], error: (result.reason as Error).message }] : []) };
}
