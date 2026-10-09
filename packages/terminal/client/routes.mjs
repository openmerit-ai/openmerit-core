// One palette and vocabulary for paths throughout the terminal.
export const ROUTES = {
  direct: { label: 'Direct API', short: 'Direct API', color: '#6387ff' },
  local: { label: 'Local runtime', short: 'Local', color: '#d4b185' },
  router: { label: 'Router', short: 'Router', color: '#b39bdd' },
  gateway: { label: 'Gateway', short: 'Gateway', color: '#45d3e3' },
  unknown: { label: 'Unclassified', short: 'Unclassified', color: '#8c8c8c' },
};

const nameKey = name => String(name ?? '').trim().toLowerCase();
export function inventoryRouteKind(item) {
  if (item.kind === 'gateway' || item.kind === 'router') return item.kind;
  if (item.kind === 'provider') return 'direct';
  if (item.kind === 'runtime' && ['local', 'private'].includes(item.location)) return 'local';
  return 'unknown';
}

export function routeKind(record, snapshot = {}) {
  if (Object.hasOwn(ROUTES, record.routeKind)) return record.routeKind;
  const route = nameKey(record.route);
  if (!route || route === 'unattributed route') return 'unknown';
  const declared = new Set((snapshot.inventory ?? []).filter(item => nameKey(item.name) === route).map(inventoryRouteKind).filter(kind => kind !== 'unknown'));
  if (declared.size) return declared.size === 1 ? [...declared][0] : 'unknown';
  if ((snapshot.sources ?? []).some(source => source.kind === 'Local runtime' && nameKey(source.name) === route)) return 'local';
  if (route === 'direct' || route === 'direct api') return 'direct';
  // A cloud provider or local model location alone says nothing about the path.
  return 'unknown';
}

export function routeBreakdown(records, snapshot) {
  const counts = Object.fromEntries(Object.keys(ROUTES).map(kind => [kind, 0]));
  for (const record of records) counts[routeKind(record, snapshot)]++;
  return counts;
}

// Retained requests establish a count even when a source reports partial coverage.
// A connected, empty request source establishes zero; inventory alone does not.
export function requestCountKnown(snapshot) {
  return Boolean(snapshot.records?.length) || (snapshot.sources ?? []).some(source =>
    (['activity', 'openmerit', 'sample-activity'].includes(source.id) || source.id?.startsWith('project-log:')) && source.state === 'connected');
}
