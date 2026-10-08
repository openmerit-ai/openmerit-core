// Configuration evidence only. Never call these services or return credentials,
// endpoint paths, queries, or user-supplied URLs to the browser.
const groups = [
  ['OpenAI', ['OPENAI_API_KEY'], ['OPENAI_BASE_URL', 'OPENAI_API_BASE']],
  ['Anthropic', ['ANTHROPIC_API_KEY'], ['ANTHROPIC_BASE_URL']],
  ['OpenRouter', ['OPENROUTER_API_KEY'], []],
  ['Google', ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'], []],
  ['Groq', ['GROQ_API_KEY'], ['GROQ_BASE_URL']],
  ['Cerebras', ['CEREBRAS_API_KEY'], ['CEREBRAS_BASE_URL']],
  ['Baseten', ['BASETEN_API_KEY'], ['BASETEN_BASE_URL']],
];
const hosts = new Map([
  ['api.openai.com', 'OpenAI'], ['api.anthropic.com', 'Anthropic'],
  ['openrouter.ai', 'OpenRouter'], ['api.groq.com', 'Groq'],
  ['api.cerebras.ai', 'Cerebras'], ['inference.baseten.co', 'Baseten'],
]);
export function serviceFromEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return hosts.get(url.hostname) ?? (/^model-[a-z0-9-]+\.api\.baseten\.co$/.test(url.hostname) ? 'Baseten' : null);
  } catch { return null; }
}
export function configuredServices(env = process.env) {
  const found = new Map(), unrecognizedEndpoints = [];
  const present = key => typeof env[key] === 'string' && env[key].trim().length > 0;
  const add = (name, field, basis) => {
    const item = found.get(name) ?? { name, kind: name === 'OpenRouter' ? 'gateway' : 'provider', location: 'cloud', state: 'configured', sourceId: 'environment', evidence: [] };
    item.evidence.push({ field, basis }); found.set(name, item);
  };
  for (const [name, credentials, endpoints] of groups) {
    const overrides = endpoints.filter(present);
    if (overrides.length) {
      for (const field of overrides) {
        const service = serviceFromEndpoint(env[field]);
        if (service) add(service, field, 'endpoint-host');
        else unrecognizedEndpoints.push(field);
      }
      // A custom base URL can repurpose the SDK's credential variable. Its name
      // alone must not establish the SDK vendor as a configured service.
    } else for (const field of credentials.filter(present)) add(name, field, 'credential-name');
  }
  return { services: [...found.values()], unrecognizedEndpoints };
}

// Multiple reports for one model/service may disagree. Preserve the gap rather
// than choosing whichever file or record happened to be processed first.
export function modelCreators(models, reports) {
  const evidence = new Map();
  for (const item of [...models, ...reports]) {
    if (!item.modelCreator) continue;
    const key = JSON.stringify([item.provider, item.model ?? item.name]);
    const entry = evidence.get(key) ?? { names: new Set(), sources: new Set() };
    entry.names.add(item.modelCreator); if (item.sourceId) entry.sources.add(item.sourceId);
    evidence.set(key, entry);
  }
  return models.map(model => {
    const entry = evidence.get(JSON.stringify([model.provider, model.name]));
    return { ...model, modelCreator: entry?.names.size === 1 ? [...entry.names][0] : null, creatorConflict: (entry?.names.size ?? 0) > 1, creatorSources: [...(entry?.sources ?? [])] };
  });
}
