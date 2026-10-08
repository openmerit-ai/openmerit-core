// Bounded metadata contracts. Never retain endpoints, credentials, or payloads.
const label = value => typeof value === 'string' ? value.slice(0, 160).replace(/[\x00-\x1f]/g, '') : '';
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit).filter(item => item && typeof item === 'object') : [];
export const poolIds = value => Array.isArray(value) ? [...new Set(value.slice(0, 16).map(label).filter(Boolean))] : [];
export function normalizePath(value) {
  // Do not turn a broken path into an apparently complete chain by dropping hops.
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(hop => !hop || !label(hop.name))) return [];
  return value.map(hop => ({ name: label(hop.name), kind: ['direct', 'local', 'router', 'gateway'].includes(hop.kind) ? hop.kind : 'unknown' }));
}
function unique(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return items.filter(item => item.id && counts.get(item.id) === 1);
}
export function normalizeDeployments(value) {
  return unique(list(value, 200).map(item => ({ id: label(item.id), name: label(item.name) || label(item.id), model: label(item.model), modelCreator: label(item.modelCreator) || null, servingMode: ['shared', 'dedicated', 'self-hosted'].includes(item.servingMode) ? item.servingMode : 'unknown', provider: label(item.provider) || 'Unattributed', location: ['local', 'private', 'cloud'].includes(item.location) ? item.location : 'unknown', poolIds: poolIds(item.poolIds), hostId: label(item.hostId) || null, sourceId: 'inventory', state: 'configured' })).filter(item => item.model && !item.id.startsWith('runtime:')));
}
export function normalizePools(value) {
  return unique(list(value, 100).map(item => ({ id: label(item.id), name: label(item.name) || label(item.id), kind: ['quota', 'runtime', 'gateway'].includes(item.kind) ? item.kind : 'unknown', windowSeconds: count(item.windowSeconds), sourceId: 'capacity', observedAt: null, metrics: {} })).filter(item => !item.id.startsWith('runtime:')));
}
export function normalizeCapacity(value, now = Date.now()) {
  return unique(list(value?.pools, 100).map(item => {
    const observedAt = timestamp(item.observedAt);
    const metrics = Object.fromEntries(['running', 'waiting', 'concurrencyLimit', 'requestsUsed', 'requestsLimit', 'tokensUsed', 'tokensLimit', 'cachePercent', 'memoryUsedBytes', 'memoryTotalBytes'].map(key => [key, count(item.metrics?.[key])]).filter(([, value]) => value !== null));
    if (metrics.cachePercent > 100) delete metrics.cachePercent;
    return { id: label(item.id), observedAt, resetAt: timestamp(item.resetAt), metrics };
  }).filter(item => item.observedAt && Date.parse(item.observedAt) <= now));
}
