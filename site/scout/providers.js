// Curated catalogue namespaces, never arbitrary names or remote favicon URLs.
// Official asset origins and hashes: scout/provider-assets.json.
const icons = new Map([
  ["anthropic", "anthropic.png"],
  ["google", "google.png"],
  ["deepseek", "deepseek.ico"],
  ["openai", "openai.png"],
  ["mistralai", "mistral.png"],
  ["qwen", "qwen.png"],
  ["meta", "meta.ico"],
  ["meta-llama", "meta.ico"],
  ["cohere", "cohere.png"],
  ["microsoft", "microsoft.ico"],
  ["z-ai", "zai.png"],
  ["moonshotai", "moonshot.ico"],
  ["minimax", "minimax.ico"],
  ["inception", "inception.png"],
  ["perplexity", "perplexity.png"],
  ["thinkingmachines", "thinkingmachines.png"],
  ["nousresearch", "nous.png"],
  ["arcee-ai", "arcee.ico"],
  ["stepfun", "stepfun.png"],
  ["tencent", "tencent.png"],
  ["meituan", "meituan.ico"],
  ["upstage", "upstage.png"],
  ["xiaomi", "xiaomi.png"],
  ["nvidia", "nvidia.ico"],
  ["x-ai", "xai.ico"],
  ["ibm-granite", "ibm.png"],
  ["rekaai", "reka.jpg"],
  ["inclusionai", "inclusionai.png"],
]);
const labels = new Map([['mistralai', 'Mistral'], ['microsoft', 'Microsoft'], ['qwen', 'Qwen'], ['rekaai', 'Reka']]);

export function providerIdentity(model) {
  const namespace = model.id.split('/')[0];
  return { label: labels.get(model.provider) ?? model.provider, file: icons.get(namespace) ?? null };
}
