import { reportedPath, deploymentFor } from './environment.mjs';
import { ROUTES } from './routes.mjs';

const modelKey = item => JSON.stringify([item.provider, item.model]);
const workKey = item => item.agentId ? `agent:${item.agentId}` : `workload:${item.workload}`;
const sortedEntities = values => [...values].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

// Every retained request belongs to one workload, one entry connection, and one
// model/service pair. Collapsing changes only the endpoints used to draw edges.
export function buildEnvironmentMap(records, snapshot, { expandAll = false, expansion = new Map() } = {}) {
  const works = new Map(), paths = new Map(), models = new Map(), links = [];
  const addEntity = (index, key, values, connection) => {
    if (!index.has(key)) index.set(key, { key, ...values, count: 0, connections: new Set(), deployments: new Map() });
    const entity = index.get(key); entity.count++; entity.connections.add(connection); return entity;
  };
  for (const record of records) {
    const path = reportedPath(record, snapshot), entry = path[0], pk = JSON.stringify([entry]);
    if (!paths.has(pk)) paths.set(pk, { key: pk, id: `path:${pk}`, type: 'path', name: entry.name, kind: entry.kind, count: 0, variants: new Set() });
    const connection = paths.get(pk); connection.count++; connection.variants.add(JSON.stringify(path));
    const wk = workKey(record), mk = modelKey(record);
    addEntity(works, wk, { id: `work:${wk}`, type: record.agentId ? 'agent' : 'workload', name: record.agent || record.agentId || record.workload, inspectKey: record.agentId || record.workload }, pk);
    const model = addEntity(models, mk, { id: `model:${mk}`, type: 'model', name: record.model, provider: record.provider, example: record }, pk);
    const deployment = deploymentFor(record, snapshot); if (deployment) model.deployments.set(deployment.id, deployment);
    links.push({ work: wk, path: pk, model: mk });
  }
  const kinds = Object.keys(ROUTES);
  const connections = [...paths.values()].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const pathOrder = new Map(connections.map((item, i) => [item.key, i]));
  const groups = [];
  const groupColumn = (entities, side) => {
    const buckets = new Map();
    for (const entity of sortedEntities(entities.values())) {
      const keys = [...entity.connections].sort((a, b) => pathOrder.get(a) - pathOrder.get(b));
      const key = JSON.stringify(keys);
      if (!buckets.has(key)) buckets.set(key, { id: `${side}-group:${key}`, side, keys, members: [], count: 0 });
      const group = buckets.get(key); group.members.push(entity); group.count += entity.count;
    }
    const ordered = [...buckets.values()].sort((a, b) => pathOrder.get(a.keys[0]) - pathOrder.get(b.keys[0]) || a.id.localeCompare(b.id));
    const nodes = [], owners = new Map();
    for (const group of ordered) {
      group.names = group.keys.map(key => paths.get(key).name);
      group.label = side === 'model' ? 'models' : group.members.every(item => item.type === 'agent') ? 'agents' : 'workloads';
      group.expanded = expansion.get(group.id) ?? expandAll;
      if (group.members.length > 1) {
        groups.push(group);
        nodes.push({ ...group, type: 'group', name: `${group.members.length} ${group.label}` });
      }
      for (const member of group.members) {
        const grouped = group.members.length > 1;
        if (!grouped || group.expanded) nodes.push({ ...member, groupId: grouped ? group.id : null });
        owners.set(member.key, { id: !grouped || group.expanded ? member.id : group.id, groupId: grouped ? group.id : null });
      }
    }
    return { nodes, owners };
  };
  const workColumn = groupColumn(works, 'work'), modelColumn = groupColumn(models, 'model');
  const edges = new Map();
  for (const link of links) {
    const work = workColumn.owners.get(link.work), model = modelColumn.owners.get(link.model), path = paths.get(link.path);
    const related = [work.id, model.id, path.id, work.groupId, model.groupId].filter(Boolean);
    for (const [from, to, segment] of [[work.id, path.id, 'work'], [path.id, model.id, 'model']]) {
      const key = JSON.stringify([from, to]);
      if (!edges.has(key)) edges.set(key, { from, to, segment, kind: path.kind, count: 0, related: new Set() });
      const edge = edges.get(key); edge.count++; related.forEach(id => edge.related.add(id));
    }
  }
  return { columns: [workColumn.nodes, connections, modelColumn.nodes], groups, edges: [...edges.values()], workloadCount: works.size, connectionCount: paths.size, modelCount: models.size, requestCount: records.length };
}
