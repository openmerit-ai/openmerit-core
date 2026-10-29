import { MODELS, AUTO_MODELS, SCHEMAS, PROMPTS } from './scenario.ts';
import type { Model, Prices } from './scenario.ts';
export interface PreparedCall { modelKey: string; step: number; input: string }
export const OPENAI_PRICES: Record<string, Prices> = { 'gpt-4.1-mini': { input: .4, cached: .1, output: 1.6 }, 'gpt-4.1-nano': { input: .1, cached: .025, output: .4 } };
export function prepareCall({ modelKey, step, input }: PreparedCall, models = MODELS) {
  const model = Object.hasOwn(models, modelKey) ? models[modelKey] : null;
  if (!model || !Number.isInteger(step) || step < 0 || step >= SCHEMAS.length || typeof input !== 'string' || input.length > 8000) throw new Error('Invalid prepared model call.');
  const messages = [{ role: 'system', content: PROMPTS[step] }, { role: 'user', content: input }];
  const format = { type: 'json_schema', name: `returns_${step}`, strict: true, schema: SCHEMAS[step] };
  const body = model.transport === 'openai'
    ? { model: model.id, input: messages, max_output_tokens: 384, temperature: 0, store: false, ...(model.reasoning === 'none' ? { reasoning: { effort: 'none' } } : {}), text: { format } }
    : { model: model.id, messages, max_tokens: 384, temperature: 0, stream: false,
      ...(model.reasoning === 'disabled' ? { reasoning: { enabled: false } } : {}),
      response_format: { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: format.schema } },
      provider: { require_parameters: true, max_price: { prompt: 1, completion: 5 } }, usage: { include: true },
      ...(modelKey === 'auto' ? { plugins: [{ id: 'auto-router', allowed_models: AUTO_MODELS }] } : {}) };
  const reservation = ((new TextEncoder().encode(JSON.stringify(body)).length + 4096) * 1 + 384 * 5) / 1e6;
  return { model, body, reservation, url: model.transport === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://openrouter.ai/api/v1/chat/completions' };
}
interface ProviderData {
  output?: { content?: { type: string; text: string }[] }[];
  choices?: { message?: { content?: string } }[];
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number; input_tokens_details?: { cached_tokens?: number } };
  model?: string; provider?: string; id?: string; error?: unknown;
}
export function normalizeResponse(data: ProviderData, modelKey: string, latencyMs: number, models = MODELS) {
  const model = models[modelKey]!, direct = model.transport === 'openai';
  const raw = direct ? (data.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('') : data.choices?.[0]?.message?.content ?? '';
  let output: unknown = null; try { output = JSON.parse(raw); } catch { /* Invalid output stays a failure. */ }
  const usage = data.usage ?? {}, inputTokens = direct ? usage.input_tokens : usage.prompt_tokens, outputTokens = direct ? usage.output_tokens : usage.completion_tokens;
  let cost = direct ? null : usage.cost;
  if (direct && Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    const prices = model.prices ?? OPENAI_PRICES[model.id]!, cached = usage.input_tokens_details?.cached_tokens ?? 0;
    if (Number.isFinite(cached) && cached >= 0 && cached <= inputTokens!) cost = ((inputTokens! - cached) * prices.input + cached * prices.cached + outputTokens! * prices.output) / 1e6;
  }
  return { modelKey, requestedModel: model.id, servedModel: data.model ?? null, provider: direct ? 'OpenAI direct' : data.provider ?? 'OpenRouter',
    generationId: data.id ?? null, raw, output, latencyMs, inputTokens: inputTokens ?? null, outputTokens: outputTokens ?? null,
    cost: Number.isFinite(cost) && cost! >= 0 ? cost! : null, costBasis: direct ? 'Token usage × published OpenAI rates, checked 2026-10-01; estimate, not an invoice.' : 'Provider-reported charge.',
    error: data.error ? 'Provider could not complete this call.' : null };
}
export async function callProvider(call: PreparedCall, { openaiKey, openrouterKey, fetcher = fetch, models = MODELS }: {
  openaiKey?: string | undefined; openrouterKey?: string | undefined; fetcher?: typeof fetch; models?: Record<string, Model>;
} = {}) {
  const { model, body, url } = prepareCall(call, models), key = model.transport === 'openai' ? openaiKey : openrouterKey;
  if (!key) throw new Error(`${model.provider} is not configured.`);
  const start = performance.now();
  const response = await fetcher(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(model.transport === 'openrouter' ? { 'HTTP-Referer': 'https://openmerit.ai/demo/', 'X-Title': 'OpenMerit constraints experiment' } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const data = await response.json() as ProviderData;
  if (!response.ok) throw new Error(`${model.provider} returned HTTP ${response.status}.`);
  const result = normalizeResponse(data, call.modelKey, performance.now() - start, models);
  if (result.cost === null) throw new Error('Usage or price evidence is missing; comparison stopped.');
  return result as typeof result & { cost: number };
}
