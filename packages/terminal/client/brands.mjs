// One curated identity registry for HTML, SVG, search, and inspectors.
// Names never become remote asset URLs. A model's runtime is not its maker.
const definitions = [
  ['openai', 'OpenAI', 'openai.png', ['openai', 'openai api']],
  ['anthropic', 'Anthropic', 'anthropic.png', ['anthropic', 'anthropic api']],
  ['google', 'Google', 'google.png', ['google', 'google ai', 'google api']],
  ['mistral', 'Mistral', 'mistral.png', ['mistral', 'mistral ai', 'mistral api']],
  ['deepseek', 'DeepSeek', 'deepseek.ico', ['deepseek', 'deepseek api']],
  ['cohere', 'Cohere', 'cohere.png', ['cohere', 'cohere api']],
  ['qwen', 'Qwen', 'qwen.png', ['qwen']],
  ['meta', 'Meta', 'meta.ico', ['meta', 'meta ai']],
  ['nomic', 'Nomic', 'nomic.png', ['nomic', 'nomic ai']],
  ['baai', 'BAAI', 'baai.png', ['baai']],
  ['ollama', 'Ollama', 'ollama.png', ['ollama']],
  ['vllm', 'vLLM', 'vllm.png', ['vllm']],
  ['lm-studio', 'LM Studio', 'lm-studio.png', ['lm studio']],
  ['openrouter', 'OpenRouter', 'openrouter.png', ['openrouter']],
  ['openmerit', 'OpenMerit', null, ['openmerit']],
];
const identities = new Map(definitions.map(([key, label, file]) => [key, Object.freeze({ key, label, src: file ? `/brands/${file}` : '/favicon.svg' })]));
const aliases = new Map(definitions.flatMap(([key, , , names]) => names.map(name => [name, key])));
const normalized = name => String(name ?? '').trim().toLowerCase();
export function serviceIdentity(name) { return identities.get(aliases.get(normalized(name))) ?? null; }

// Anchored model families and their official namespaces. Do not strip arbitrary
// namespaces, search substrings, or fall back to the hosting provider's mark.
const families = [
  ['openai', ['openai'], /^(?:gpt-(?:oss-)?\d|o[134](?:-|$)|text-embedding-(?:3|ada)(?:-|$))/],
  ['anthropic', ['anthropic'], /^claude-(?:\d|sonnet(?:-|$)|opus(?:-|$)|haiku(?:-|$))/],
  ['google', ['google'], /^(?:gemini-\d|gemma-?\d)/],
  ['deepseek', ['deepseek', 'deepseek-ai'], /^deepseek-(?:r\d|v\d|coder(?:-|$)|llm(?:-|$))/],
  ['mistral', ['mistralai', 'mistral'], /^(?:mistral|mixtral|ministral|codestral|devstral|magistral)(?:-|\d)/],
  ['cohere', ['cohere', 'cohereforai'], /^(?:command-(?:a|r)(?:-|$)|embed-(?:v\d|english(?:-|$)|multilingual(?:-|$)))/],
  ['qwen', ['qwen'], /^qwen(?:\d|-(?:coder|vl)(?:-|$))/],
  ['meta', ['meta', 'meta-llama'], /^llama-?\d/],
  ['nomic', ['nomic-ai'], /^nomic-embed-(?:text|vision)(?:-|:|$)/],
  ['baai', ['baai'], /^bge-(?:reranker|m3|large|base|small)(?:-|:|$)/],
];
export function modelIdentity(model) {
  const raw = normalized(typeof model === 'string' ? model : model?.model ?? model?.name).replace(/\s*·\s*|\s+/g, '-');
  const parts = raw.split('/');
  if (parts.length > 2) return null;
  const [namespace, name] = parts.length === 2 ? parts : [null, raw];
  const family = families.find(([, namespaces, pattern]) => (!namespace || namespaces.includes(namespace)) && pattern.test(name));
  return family ? identities.get(family[0]) : null;
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export function identityIcon(identity, size = 18) {
  if (!identity || identities.get(identity.key) !== identity) return '';
  return `<img class="brand-icon" data-brand="${identity.key}" src="${identity.src}" width="${size}" height="${size}" style="--brand-size:${size}px" alt="" aria-hidden="true" title="${escape(identity.label)}" decoding="async">`;
}
export function identitySvg(identity, x, y, size = 18) {
  if (!identity || identities.get(identity.key) !== identity) return '';
  return `<image class="map-brand-icon" data-brand="${identity.key}" href="${identity.src}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"/>`;
}
export const brandIcon = name => identityIcon(serviceIdentity(name), 20);
