// Configuration evidence only. Never call services or return credentials or raw URLs.
import { SERVICE_GROUPS, endpointService } from './service-registry.mjs';

export const serviceFromEndpoint = value => endpointService(value)?.service.name ?? null;
export function configuredServices(env = {}) {
  const found = new Map(), unrecognizedEndpoints = [];
  const present = key => typeof env[key] === 'string' && env[key].trim().length > 0;
  const add = (service, field, basis, endpointHost) => {
    const { name, type } = service;
    const kind = ['router', 'gateway'].includes(type) ? type : 'provider';
    const item = found.get(name) ?? { name, kind, ...(['model-api', 'inference-cloud'].includes(type) ? { serviceType: type } : {}), location: 'cloud', state: 'configured', sourceId: 'environment', evidence: [] };
    item.evidence.push({ field, basis, ...(endpointHost ? { endpointHost } : {}) }); found.set(name, item);
  };
  for (const group of SERVICE_GROUPS) {
    const overrides = group.endpoints.filter(present);
    if (overrides.length) {
      for (const field of overrides) {
        const match = endpointService(env[field]);
        if (match) add(match.service, field, 'endpoint-host', match.endpointHost);
        else unrecognizedEndpoints.push(field);
      }
      // An override can repurpose the SDK credential. Unknown/local overrides
      // must suppress the vendor fallback too; the key name is not enough.
    } else for (const field of group.credentials.filter(present)) add(group, field, 'credential-name');
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
