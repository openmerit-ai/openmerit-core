// Shared, dependency-free service identities for passive discovery and the UI.
// Endpoint formats checked against official API docs on 2026-10-10; see the guide.
// A match identifies configuration, never connectivity, usage, a model, or a host.
const define = (key, name, type, options = {}) => Object.freeze({ key, name, type, aliases: [], credentials: [], endpoints: [], hosts: [], ...options });
const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const subdomains = suffix => new RegExp(`^(?:${label}\\.)+${suffix.replaceAll('.', '\\.')}$`);
const resource = suffix => new RegExp(`^${label}\\.${suffix.replaceAll('.', '\\.')}$`);
const region = '[a-z]{2}(?:-[a-z]+)+-\\d+';
const hf = subdomains('endpoints.huggingface.cloud');
const azureOpenAI = resource('openai.azure.com');
const azureFoundry = resource('services.ai.azure.com');
const bedrock = new RegExp(`^bedrock-runtime(?:-fips)?\\.${region}\\.amazonaws\\.com(?:\\.cn)?$`);
const sagemaker = new RegExp(`^runtime(?:-fips)?\\.sagemaker\\.${region}\\.amazonaws\\.com(?:\\.cn)?$`);
const vertex = /^(?:[a-z]+(?:-[a-z]+)*\d+-)?aiplatform\.googleapis\.com$/;
const maas = new RegExp(`^${label}\\.(?:cn-beijing|cn-hongkong|ap-southeast-1|ap-northeast-1)\\.maas\\.aliyuncs\\.com$`);

export const SERVICE_REGISTRY = Object.freeze([
  define('openai', 'OpenAI', 'model-api', { aliases: ['openai api'], credentials: ['OPENAI_API_KEY'], endpoints: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'], hosts: ['api.openai.com'] }),
  define('anthropic', 'Anthropic', 'model-api', { aliases: ['anthropic api'], credentials: ['ANTHROPIC_API_KEY'], endpoints: ['ANTHROPIC_BASE_URL'], hosts: ['api.anthropic.com'] }),
  define('openrouter', 'OpenRouter', 'gateway', { credentials: ['OPENROUTER_API_KEY'], endpoints: ['OPENROUTER_BASE_URL'], hosts: ['openrouter.ai'] }),
  define('google', 'Google', 'model-api', { aliases: ['google ai', 'google api', 'gemini api'], credentials: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'], endpoints: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'], hosts: ['generativelanguage.googleapis.com'] }),
  define('groq', 'Groq', 'inference-cloud', { aliases: ['groq api', 'groqcloud'], credentials: ['GROQ_API_KEY'], endpoints: ['GROQ_BASE_URL'], hosts: ['api.groq.com'] }),
  define('cerebras', 'Cerebras', 'inference-cloud', { aliases: ['cerebras api'], credentials: ['CEREBRAS_API_KEY'], endpoints: ['CEREBRAS_BASE_URL'], hosts: ['api.cerebras.ai'] }),
  define('baseten', 'Baseten', 'inference-cloud', { aliases: ['baseten api'], credentials: ['BASETEN_API_KEY'], endpoints: ['BASETEN_BASE_URL'], hosts: ['inference.baseten.co'], match: url => /^model-[a-z0-9-]+\.api\.baseten\.co$/.test(url.hostname), redact: host => host.replace(/^model-[a-z0-9-]+(?=\.api\.baseten\.co$)/, 'model-…') }),
  // Hub and general cloud tokens can authorize unrelated products or downloads.
  define('huggingface-endpoints', 'Hugging Face Endpoints', 'inference-cloud', { aliases: ['hugging face inference endpoints'], endpoints: ['HF_INFERENCE_ENDPOINT', 'HF_ENDPOINT_URL', 'HUGGINGFACE_ENDPOINT_URL'], match: url => hf.test(url.hostname), redact: () => '….endpoints.huggingface.cloud' }),
  define('huggingface-router', 'Hugging Face Router', 'router', { aliases: ['hugging face inference providers'], hosts: ['router.huggingface.co'] }),
  define('mistral', 'Mistral', 'model-api', { aliases: ['mistral ai', 'mistral api'], credentials: ['MISTRAL_API_KEY'], endpoints: ['MISTRAL_BASE_URL', 'MISTRAL_SERVER_URL'], hosts: ['api.mistral.ai'] }),
  define('deepseek', 'DeepSeek', 'model-api', { aliases: ['deepseek api'], credentials: ['DEEPSEEK_API_KEY'], endpoints: ['DEEPSEEK_BASE_URL'], hosts: ['api.deepseek.com'] }),
  define('cohere', 'Cohere', 'model-api', { aliases: ['cohere api'], credentials: ['COHERE_API_KEY', 'CO_API_KEY'], endpoints: ['COHERE_BASE_URL'], hosts: ['api.cohere.ai', 'api.cohere.com'] }),
  define('xai', 'xAI', 'model-api', { aliases: ['xai api'], credentials: ['XAI_API_KEY'], endpoints: ['XAI_BASE_URL'], hosts: ['api.x.ai'] }),
  define('voyage', 'Voyage AI', 'model-api', { aliases: ['voyage', 'voyageai'], credentials: ['VOYAGE_API_KEY'], endpoints: ['VOYAGE_BASE_URL'], hosts: ['api.voyageai.com'] }),
  define('jina', 'Jina AI', 'model-api', { aliases: ['jina'], endpoints: ['JINA_BASE_URL'], hosts: ['api.jina.ai'] }),
  define('together', 'Together AI', 'inference-cloud', { aliases: ['together'], credentials: ['TOGETHER_API_KEY'], endpoints: ['TOGETHER_BASE_URL'], hosts: ['api.together.ai', 'api.together.xyz'] }),
  define('fireworks', 'Fireworks AI', 'inference-cloud', { aliases: ['fireworks'], credentials: ['FIREWORKS_API_KEY'], endpoints: ['FIREWORKS_BASE_URL'], hosts: ['api.fireworks.ai'] }),
  define('deepinfra', 'DeepInfra', 'inference-cloud', { credentials: ['DEEPINFRA_API_KEY', 'DEEPINFRA_API_TOKEN'], endpoints: ['DEEPINFRA_BASE_URL'], hosts: ['api.deepinfra.com'] }),
  define('replicate', 'Replicate', 'inference-cloud', { credentials: ['REPLICATE_API_TOKEN'], endpoints: ['REPLICATE_BASE_URL'], hosts: ['api.replicate.com'] }),
  define('nvidia-api', 'NVIDIA API Catalog', 'inference-cloud', { endpoints: ['NVIDIA_BASE_URL', 'NVIDIA_NIM_BASE_URL'], hosts: ['integrate.api.nvidia.com'] }),
  define('sambanova', 'SambaNova', 'inference-cloud', { credentials: ['SAMBANOVA_API_KEY'], endpoints: ['SAMBANOVA_BASE_URL'], hosts: ['api.sambanova.ai'] }),
  define('novita', 'Novita AI', 'inference-cloud', { aliases: ['novita'], credentials: ['NOVITA_API_KEY'], endpoints: ['NOVITA_BASE_URL'], hosts: ['api.novita.ai'] }),
  define('nebius', 'Nebius Token Factory', 'inference-cloud', { aliases: ['nebius ai studio'], endpoints: ['NEBIUS_BASE_URL'], hosts: ['api.studio.nebius.ai', 'api.studio.nebius.com'] }),
  define('siliconflow', 'SiliconFlow', 'inference-cloud', { credentials: ['SILICONFLOW_API_KEY'], endpoints: ['SILICONFLOW_BASE_URL'], hosts: ['api.siliconflow.com', 'api.siliconflow.cn'] }),
  define('azure-openai', 'Azure OpenAI', 'inference-cloud', { endpoints: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_API_BASE'], match: url => azureOpenAI.test(url.hostname), redact: () => '….openai.azure.com' }),
  define('azure-foundry', 'Azure AI Foundry', 'inference-cloud', { aliases: ['microsoft foundry'], endpoints: ['AZURE_AI_ENDPOINT', 'AZURE_AI_INFERENCE_ENDPOINT', 'AZURE_INFERENCE_ENDPOINT'], match: url => azureFoundry.test(url.hostname) && /^\/(?:$|(?:openai|models)(?:\/|$))/.test(url.pathname), redact: () => '….services.ai.azure.com' }),
  define('bedrock', 'Amazon Bedrock', 'inference-cloud', { aliases: ['aws bedrock', 'bedrock'], credentials: ['AWS_BEARER_TOKEN_BEDROCK'], endpoints: ['AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'BEDROCK_ENDPOINT_URL', 'BEDROCK_BASE_URL'], match: url => bedrock.test(url.hostname) }),
  define('sagemaker', 'Amazon SageMaker', 'inference-cloud', { aliases: ['aws sagemaker', 'sagemaker'], endpoints: ['AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME', 'SAGEMAKER_ENDPOINT_URL', 'SAGEMAKER_BASE_URL'], match: url => sagemaker.test(url.hostname) }),
  define('vertex', 'Google Vertex AI', 'inference-cloud', { aliases: ['vertex ai', 'vertex'], endpoints: ['VERTEX_AI_ENDPOINT', 'VERTEX_AI_BASE_URL'], match: url => vertex.test(url.hostname) }),
  define('cloudflare-workers-ai', 'Cloudflare Workers AI', 'inference-cloud', { aliases: ['workers ai'], endpoints: ['CLOUDFLARE_WORKERS_AI_BASE_URL'], match: url => url.hostname === 'api.cloudflare.com' && /^\/client\/v4\/accounts\/[a-zA-Z0-9_-]+\/ai(?:\/|$)/.test(url.pathname) }),
  define('cloudflare-ai-gateway', 'Cloudflare AI Gateway', 'gateway', { endpoints: ['CLOUDFLARE_AI_GATEWAY_URL'], hosts: ['gateway.ai.cloudflare.com'] }),
  define('portkey', 'Portkey', 'gateway', { credentials: ['PORTKEY_API_KEY'], endpoints: ['PORTKEY_BASE_URL', 'PORTKEY_GATEWAY_URL'], hosts: ['api.portkey.ai'] }),
  // The generic AI_GATEWAY_API_KEY name is shared by applications; require the URL.
  define('vercel-ai-gateway', 'Vercel AI Gateway', 'gateway', { endpoints: ['AI_GATEWAY_BASE_URL', 'VERCEL_AI_GATEWAY_BASE_URL'], hosts: ['ai-gateway.vercel.sh'] }),
  define('dashscope', 'Alibaba Cloud Model Studio', 'inference-cloud', { aliases: ['dashscope', 'alibaba model studio'], credentials: ['DASHSCOPE_API_KEY'], endpoints: ['DASHSCOPE_BASE_URL', 'DASHSCOPE_API_BASE'], hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com'], match: url => maas.test(url.hostname), redact: host => maas.test(host) ? '….maas.aliyuncs.com' : host }),
  define('minimax', 'MiniMax', 'model-api', { credentials: ['MINIMAX_API_KEY'], endpoints: ['MINIMAX_BASE_URL'], hosts: ['api.minimax.io'] }),
  define('moonshot', 'Moonshot AI', 'model-api', { aliases: ['moonshot', 'kimi api'], credentials: ['MOONSHOT_API_KEY'], endpoints: ['MOONSHOT_BASE_URL'], hosts: ['api.moonshot.ai'] }),
  define('zai', 'Z.AI', 'model-api', { aliases: ['zai'], credentials: ['ZAI_API_KEY'], endpoints: ['ZAI_BASE_URL'], hosts: ['api.z.ai'] }),
  // Perplexity shares a host across products. Never turn a Search URL into Sonar.
  define('perplexity-sonar', 'Perplexity Sonar', 'model-api', { endpoints: ['PERPLEXITY_BASE_URL'], match: url => url.hostname === 'api.perplexity.ai' && /^(?:\/?|\/chat\/completions\/?|\/v1\/?)$/.test(url.pathname) }),
  define('perplexity-router', 'Perplexity Router', 'router', { match: url => url.hostname === 'api.perplexity.ai' && /^\/router(?:\/|$)/.test(url.pathname) }),
  define('ollama', 'Ollama', 'runtime'),
  define('vllm', 'vLLM', 'runtime'),
  define('lm-studio', 'LM Studio', 'runtime'),
]);
const names = new Map(SERVICE_REGISTRY.flatMap(service => [service.name, ...service.aliases].map(name => [name.toLowerCase(), service])));
export const registeredService = name => names.get(String(name ?? '').trim().toLowerCase()) ?? null;
export const SERVICE_GROUPS = Object.freeze(SERVICE_REGISTRY.filter(service => service.credentials.length || service.endpoints.length));
export const SERVICE_CREDENTIAL_FIELDS = Object.freeze(SERVICE_GROUPS.flatMap(service => service.credentials));
export const SERVICE_ENDPOINT_FIELDS = Object.freeze(SERVICE_GROUPS.flatMap(service => service.endpoints));

export function endpointService(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const service = SERVICE_REGISTRY.find(service => service.hosts.includes(url.hostname) || service.match?.(url));
    return service ? { service, endpointHost: service.redact?.(url.hostname) ?? url.hostname } : null;
  } catch { return null; }
}
