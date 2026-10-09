import { serviceIdentity } from './brands.mjs';
import { reportedPath, deploymentFor, poolsFor } from './environment.mjs';

export const SERVICE_TYPES = {
  'model-api': { label: 'Model API', plural: 'Model APIs', path: 'direct' },
  'inference-cloud': { label: 'Inference cloud', plural: 'Inference clouds', path: 'direct' },
  router: { label: 'Router', plural: 'Routers', path: 'router' },
  gateway: { label: 'Gateway', plural: 'Gateways', path: 'gateway' },
  runtime: { label: 'Runtime', plural: 'Runtimes', path: 'local' },
  unknown: { label: 'Unclassified', plural: 'Unclassified', path: 'unknown' },
};
const endpointSource = source => source.endpointInventory || source.kind === 'Local runtime';
const key = name => String(name ?? '').trim().toLowerCase();
const valid = name => key(name) && !['unattributed', 'unattributed route', 'direct', 'direct api'].includes(key(name));
const knownTypes = { openai: 'model-api', anthropic: 'model-api', google: 'model-api', mistral: 'model-api', deepseek: 'model-api', cohere: 'model-api', baseten: 'inference-cloud', groq: 'inference-cloud', cerebras: 'inference-cloud', openrouter: 'gateway', ollama: 'runtime', vllm: 'runtime', 'lm-studio': 'runtime' };
function typeOf(item) {
  if (['router', 'gateway', 'runtime'].includes(item.kind)) return item.kind;
  if (item.kind === 'provider' && ['model-api', 'inference-cloud'].includes(item.serviceType)) return item.serviceType;
  return knownTypes[serviceIdentity(item.name)?.key] ?? 'unknown';
}

// A row is an identified service, not a company inferred from a model creator.
// Explicitly declared names remain separate; curated aliases merge only when
// there is exactly one existing match and no declaration for the alias itself.
export function serviceInventory(snapshot, selectedRecords = snapshot.records ?? []) {
  const services = new Map(), declarations = new Set();
  const selected = new Set(selectedRecords);
  const ensure = (name, exact = false) => {
    if (!valid(name)) return null;
    const id = key(name);
    if (services.has(id)) return services.get(id);
    const identity = serviceIdentity(name);
    if (!exact && !declarations.has(id) && identity) {
      const candidates = [...services.values()].filter(item => serviceIdentity(item.name)?.key === identity.key);
      if (candidates.length === 1) { candidates[0].aliases.add(name); return candidates[0]; }
    }
    const service = { id, name, aliases: new Set([name]), explicitTypes: new Set(), registryTypes: new Set(), locations: new Set(), endpoints: new Set(), evidence: new Map(), models: new Map(), deployments: new Map(), poolIds: new Set(), records: new Set(), paths: new Map(), lastAt: null, configured: false, reported: false };
    services.set(id, service); return service;
  };
  const evidence = (service, sourceId, field, detail) => {
    if (!service) return;
    const item = { sourceId: sourceId || 'inventory', field, detail };
    service.evidence.set(JSON.stringify(item), item);
  };
  const classify = (service, item) => {
    if (!service) return;
    const type = typeOf(item);
    const explicit = ['router', 'gateway', 'runtime'].includes(item.kind) || ['model-api', 'inference-cloud'].includes(item.serviceType);
    (explicit ? service.explicitTypes : service.registryTypes).add(type);
    if (item.location && item.location !== 'unknown') service.locations.add(item.location);
  };
  const addModel = (service, item) => {
    if (!service) return;
    const name = item.model ?? item.name;
    const id = JSON.stringify([item.provider, name]);
    // Inventory is authoritative for model identity; a request ID must not
    // replace a model ID or overwrite unresolved creator metadata.
    if (name && !service.models.has(id)) service.models.set(id, { ...item, name });
  };
  const inventory = (snapshot.inventory ?? []).filter(item => item.kind !== 'model');
  for (const item of inventory) if (valid(item.name)) declarations.add(key(item.name));
  for (const source of snapshot.sources ?? []) if (endpointSource(source) && source.state !== 'disabled') declarations.add(key(source.name));
  for (const item of inventory) {
    const service = ensure(item.name, true); if (!service) continue;
    classify(service, item); service.configured = true;
    for (const id of item.poolIds ?? []) service.poolIds.add(id);
    for (const entry of item.evidence ?? []) {
      evidence(service, entry.sourceId || 'environment', entry.field, entry.basis === 'endpoint-host' ? 'Recognized endpoint host' : 'Credential variable present');
      if (entry.endpointHost) service.endpoints.add(entry.endpointHost);
    }
    if (item.sourceId !== 'environment' && !item.sourceId?.startsWith('project:')) evidence(service, item.sourceId || 'inventory', 'inventory.name', 'Declared service');
  }
  for (const source of snapshot.sources ?? []) {
    if (!endpointSource(source) || source.state === 'disabled') continue;
    const service = ensure(source.name, true); if (!service) continue;
    classify(service, { name: source.name, kind: source.kind === 'Model endpoint' ? 'unknown' : 'runtime', location: source.location ?? (source.kind === 'Local runtime' ? 'local' : 'unknown') }); service.configured = true;
    // Runtime details are validated loopback origins by the collector; never
    // promote an arbitrary source description to an endpoint or external link.
    try { const url = new URL(source.detail); if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') service.endpoints.add(url.host); } catch { /* no endpoint supplied */ }
    evidence(service, source.id, 'runtime', 'Project endpoint inventory; placement is separate');
    if (source.discoverySource) evidence(service, source.discoverySource, source.discoveryField || 'endpoint', 'Project endpoint declaration');
    const pool = (snapshot.capacityPools ?? []).find(pool => pool.id === `runtime:${source.id}`);
    if (pool) service.poolIds.add(pool.id);
  }
  for (const model of snapshot.models ?? []) {
    const service = ensure(model.provider); if (!service) continue;
    classify(service, { name: model.provider, kind: 'provider', location: model.location }); addModel(service, model);
    evidence(service, model.sourceId, 'provider', 'Model inventory');
    if (model.state === 'configured') service.configured = true;
  }
  for (const deployment of snapshot.deployments ?? []) {
    const service = ensure(deployment.provider); if (!service) continue;
    classify(service, { name: deployment.provider, kind: 'provider', location: deployment.location });
    service.deployments.set(deployment.id, deployment); addModel(service, deployment);
    for (const id of deployment.poolIds ?? []) service.poolIds.add(id);
    evidence(service, deployment.sourceId, 'deployments.provider', 'Deployment inventory');
    if (deployment.state === 'configured') service.configured = true;
  }
  for (const record of snapshot.records ?? []) {
    const touched = new Set(), path = reportedPath(record, snapshot);
    const serving = ensure(record.provider);
    if (serving) { classify(serving, { name: record.provider, kind: 'provider', location: record.location }); evidence(serving, record.sourceId, 'provider', 'Recorded serving service'); touched.add(serving); }
    for (const hop of path) {
      const service = ensure(hop.name); if (!service) continue;
      // A request's model location does not establish where a gateway runs.
      classify(service, { name: hop.name, kind: hop.kind === 'local' ? 'runtime' : hop.kind });
      evidence(service, record.sourceId, record.path?.length ? 'path[].name' : 'route', 'Recorded connection'); touched.add(service);
    }
    for (const service of touched) {
      service.reported = true;
      if (!service.lastAt || Date.parse(record.occurredAt) > Date.parse(service.lastAt)) service.lastAt = record.occurredAt;
      if (!selected.has(record)) continue;
      service.records.add(record); addModel(service, record);
      const sequence = JSON.stringify(path), entry = service.paths.get(sequence) ?? { path, count: 0 };
      entry.count++; service.paths.set(sequence, entry);
      const deployment = deploymentFor(record, snapshot);
      if (deployment) service.deployments.set(deployment.id, deployment);
      // Include only explicitly associated service/deployment pools; a router
      // does not own every quota encountered downstream in its request path.
      if (service === serving && deployment) for (const pool of poolsFor(record, snapshot).filter(pool => deployment.poolIds?.includes(pool.id))) service.poolIds.add(pool.id);
    }
  }
  return [...services.values()].map(service => {
    const types = service.explicitTypes.size ? service.explicitTypes : service.registryTypes;
    if (types.size > 1) types.delete('unknown');
    const typeEvidence = [service.explicitTypes.size ? 'Declared or reported role' : types.has('unknown') ? 'Role not supplied' : 'Known service registry'];
    const { explicitTypes, registryTypes, poolIds, ...fields } = service;
    return { ...fields, aliases: [...service.aliases], types: [...types], typeEvidence, locations: [...service.locations], endpoints: [...service.endpoints], evidence: [...service.evidence.values()], models: [...service.models.values()], deployments: [...service.deployments.values()], pools: (snapshot.capacityPools ?? []).filter(pool => service.poolIds.has(pool.id)), records: [...service.records], paths: [...service.paths.values()] };
  }).sort((a, b) => b.records.length - a.records.length || a.name.localeCompare(b.name));
}
