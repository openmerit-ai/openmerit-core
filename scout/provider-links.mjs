// Official destinations checked 2026-10-14. These are navigation links, not the
// source of Scout's quoted rates. Never derive a destination from feed URLs or
// fall back to a router when a new provider enters the index.
const providers = new Map([
  ['anthropic', 'https://platform.claude.com/docs/en/about-claude/pricing'],
  ['arcee-ai', 'https://www.arcee.ai/'],
  ['cohere', 'https://cohere.com/'],
  ['deepseek', 'https://api-docs.deepseek.com/quick_start/pricing/'],
  ['google', 'https://ai.google.dev/gemini-api/docs/pricing'],
  ['ibm-granite', 'https://www.ibm.com/granite'],
  ['inception', 'https://www.inceptionlabs.ai/models#pricing'],
  ['inclusionai', 'https://www.inclusion-ai.org/'],
  ['meituan', 'https://longcat.ai/'],
  ['meta', 'https://dev.meta.ai/'],
  ['meta-llama', 'https://dev.meta.ai/'],
  ['microsoft', 'https://www.microsoft.com/en-us/research/'],
  ['minimax', 'https://www.minimax.io/'],
  ['mistralai', 'https://mistral.ai/pricing/'],
  ['moonshotai', 'https://platform.kimi.ai/docs/pricing/chat'],
  ['nousresearch', 'https://nousresearch.com/'],
  ['nvidia', 'https://www.nvidia.com/en-us/ai-data-science/foundation-models/nemotron/'],
  ['openai', 'https://developers.openai.com/api/docs/pricing'],
  ['perplexity', 'https://docs.perplexity.ai/docs/getting-started/pricing'],
  ['qwen', 'https://www.alibabacloud.com/help/en/model-studio/models'],
  ['rekaai', 'https://reka.ai/'],
  ['stepfun', 'https://www.stepfun.com/'],
  ['tencent', 'https://hunyuan.tencent.com/'],
  ['thinkingmachines', 'https://thinkingmachines.ai/'],
  ['upstage', 'https://www.upstage.ai/pricing/api'],
  ['x-ai', 'https://docs.x.ai/developers/models'],
  ['xiaomi', 'https://mimo.xiaomi.com/'],
  ['z-ai', 'https://docs.z.ai/guides/overview/pricing'],
]);

export function providerURL(id) {
  if (typeof id !== 'string') return null;
  const [provider, model, extra] = id.split('/');
  if (!model || extra !== undefined) return null;
  // These families have model documentation, not a direct hosted API price.
  if (provider === 'google' && model.startsWith('gemma-')) return 'https://ai.google.dev/gemma/docs';
  if (provider === 'openai' && model.startsWith('gpt-oss-')) return 'https://openai.com/open-models/';
  return providers.get(provider) ?? null;
}
