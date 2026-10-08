import { routeKind } from './routes.mjs';
const indexes = new WeakMap();
function index(snapshot) {
  if (indexes.has(snapshot)) return indexes.get(snapshot);
  const deployments = new Map(), connections = new Map();
  for (const item of snapshot.deployments ?? []) deployments.set(item.id, deployments.has(item.id) ? null : item);
  for (const item of snapshot.inventory ?? []) {
    const kind = item.kind === 'runtime' ? 'local' : item.kind === 'provider' ? 'direct' : item.kind;
    const key = JSON.stringify([item.name, kind]);
    connections.set(key, connections.has(key) ? null : item);
  }
  const result = { deployments, connections, pools: new Map((snapshot.capacityPools ?? []).map(pool => [pool.id, pool])), records: new WeakMap() };
  indexes.set(snapshot, result); return result;
}

export function reportedPath(record, snapshot) {
  return record.path?.length ? record.path : [{ name: record.route || 'Unattributed route', kind: routeKind(record, snapshot) }];
}
export function deploymentFor(record, snapshot) {
  if (!record.deploymentId) return null;
  const deployment = index(snapshot).deployments.get(record.deploymentId);
  return deployment?.model === record.model && deployment.provider === record.provider ? deployment : null;
}
export function poolsFor(record, snapshot) {
  const indexed = index(snapshot);
  if (indexed.records.has(record)) return indexed.records.get(record);
  const ids = new Set(deploymentFor(record, snapshot)?.poolIds ?? []);
  for (const hop of reportedPath(record, snapshot)) {
    const match = indexed.connections.get(JSON.stringify([hop.name, hop.kind]));
    for (const id of match?.poolIds ?? []) ids.add(id);
  }
  const result = [...ids].map(id => indexed.pools.get(id)).filter(Boolean);
  indexed.records.set(record, result); return result;
}
export function capacityState(pool, interval = 15, now = Date.now()) {
  const age = now - Date.parse(pool.observedAt);
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  if (age > interval * 3000) return 'stale';
  if (!Object.values(pool.metrics ?? {}).some(value => typeof value === 'number')) return 'unknown';
  return 'sampled';
}
export function capacityReadings(pool) {
  const m = pool.metrics ?? {};
  const rows = [];
  const pair = (key, label, used, limit, unit = 'count') => {
    if (m[used] == null && m[limit] == null) return;
    rows.push({ key, label, value: m[used] ?? null, limit: m[limit] ?? null, unit, ratio: m[used] != null && m[limit] > 0 ? m[used] / m[limit] : null });
  };
  pair('requests', 'Requests in quota window', 'requestsUsed', 'requestsLimit');
  pair('tokens', 'Tokens in quota window', 'tokensUsed', 'tokensLimit');
  pair('running', 'Running / concurrency limit', 'running', 'concurrencyLimit');
  pair('memory', 'Runtime memory', 'memoryUsedBytes', 'memoryTotalBytes', 'bytes');
  if (m.cachePercent != null) rows.push({ key: 'cache', label: 'Inference cache used', value: m.cachePercent, limit: 100, unit: 'percent', ratio: m.cachePercent / 100 });
  if (m.waiting != null) rows.push({ key: 'waiting', label: 'Waiting requests', value: m.waiting, limit: null, unit: 'count', ratio: null });
  return rows;
}
export function poolUsage(pool, snapshot, records) {
  const items = records.filter(record => poolsFor(record, snapshot).some(item => item.id === pool.id));
  const agents = new Map(items.filter(item => item.agentId).map(item => [item.agentId, item.agent || item.agentId]));
  const deploymentIds = new Set(items.map(record => deploymentFor(record, snapshot)?.id));
  const deployments = (snapshot.deployments ?? []).filter(item => item.poolIds?.includes(pool.id) || deploymentIds.has(item.id));
  return { items, agents, deployments };
}

// Targets keep small environments compact, but never exclude an entry connection.
export function selectMapRecords(candidates, snapshot, { focused = false } = {}) {
  const workKey = item => item.agentId ? `agent:${item.agentId}` : `workload:${item.workload}`;
  const pathKey = item => JSON.stringify([reportedPath(item, snapshot)[0]]);
  const deployKey = item => deploymentFor(item, snapshot)?.id ?? JSON.stringify(['unknown', item.provider, item.model]);
  const rank = (items, key) => {
    const counts = new Map();
    for (const item of items) { const value = key(item); counts.set(value, (counts.get(value) ?? 0) + 1); }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
  };
  const group = (items, key) => {
    const groups = new Map();
    for (const item of items) { const value = key(item); if (!groups.has(value)) groups.set(value, []); groups.get(value).push(item); }
    return groups;
  };
  const byPath = group(candidates, pathKey);
  const selectedPaths = rank(candidates, pathKey);
  const workloadOrder = rank(candidates, workKey);
  // Reserve a real workload for every connection before filling by request volume.
  const workloadSet = new Set(selectedPaths.map(key => rank(byPath.get(key), workKey)[0]));
  for (const key of workloadOrder) { if (workloadSet.size >= 4) break; workloadSet.add(key); }
  const workloads = workloadOrder.filter(key => workloadSet.has(key));
  const workRecords = candidates.filter(item => workloadSet.has(workKey(item)));
  // Both ends need a surviving record: selecting models must not orphan a
  // low-volume connection or a workload that uses a different model on it.
  const deploymentSet = new Set();
  for (const groups of [group(workRecords, pathKey), group(workRecords, workKey)]) {
    for (const items of groups.values()) deploymentSet.add(rank(items, deployKey)[0]);
  }
  const deploymentOrder = rank(workRecords, deployKey);
  for (const key of deploymentOrder) { if (deploymentSet.size >= (focused ? 8 : 6)) break; deploymentSet.add(key); }
  const deployments = deploymentOrder.filter(key => deploymentSet.has(key));
  const scoped = workRecords.filter(item => deploymentSet.has(deployKey(item)));
  return { workloadOrder, workloads, selectedPaths, deployments, workRecords, scoped, workKey, pathKey, deployKey };
}
