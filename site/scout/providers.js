// Curated catalogue namespaces, never arbitrary names or remote favicon URLs.
import { hubIcons } from './hub-provider-icons.js';
// Official asset origins and hashes: scout/provider-assets.json.
const icons = new Map([
  ["liquid", "liquid.png"],
  ["fireworks", "fireworks.png"],
  ["sakana", "sakana.png"],
  ["poolside", "poolside.png"],
  ["writer", "writer.png"],
  ["amazon", "amazon.png"],
  ["bytedance-seed", "bytedance-seed.png"],
  ["morph", "morph.png"],
  ["inference-net", "inference-net.png"],

  ["typesafe", "typesafe.png"],
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
const darkMarks = new Set(["inception.png", "hf-bdrc.png", "hf-cidas.png", "hf-freepik.png", "hf-impira.png", "hf-wayu-ai.png"]);
const aliases = new Map([['liquidai', 'liquid'], ['bytedance', 'bytedance-seed'], ['facebook', 'meta'], ['meta-llama', 'meta'], ['deepseek-ai', 'deepseek']]);
const labels = new Map([['mistralai', 'Mistral'], ['microsoft', 'Microsoft'], ['qwen', 'Qwen'], ['rekaai', 'Reka'], ['meta', 'Meta'], ['google', 'Google'], ['openai', 'OpenAI'], ['nvidia', 'NVIDIA'], ['deepseek', 'DeepSeek'], ['typesafe', 'TypeSafe']]);

export function providerIdentity(model) {
  const hub = model.endpoint?.source === 'huggingface' || model.source === 'huggingface' || model.id?.startsWith('huggingface/');
  const identity = hub ? (model.endpoint?.modelId ?? model.id?.replace(/^huggingface\//, '')) : (model.modelId ?? model.id);
  const owner = (identity ?? '').split('/')[0].toLowerCase(), namespace = aliases.get(owner) ?? owner;
  const label = labels.get(namespace) ?? model.provider ?? owner;
  const file = icons.get(namespace) ?? hubIcons.get(owner) ?? (hub ? 'huggingface.svg' : null);
  return { label, file, invertOnDark: darkMarks.has(file), title: file === 'huggingface.svg' ? 'Hugging Face repository' : `${label} publisher` };
}
