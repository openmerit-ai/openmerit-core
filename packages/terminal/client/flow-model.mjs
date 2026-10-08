import { buildEnvironmentMap } from './map.mjs';

export const FLOW_COLUMNS = [{ x: 14, width: 196 }, { x: 310, width: 222 }, { x: 642, width: 244 }];
export const flowEdgeId = (from, to) => JSON.stringify([from, to]);

export function flowModel(records, snapshot) {
  const graph = buildEnvironmentMap(records, snapshot);
  const expanded = buildEnvironmentMap(records, snapshot, { expandAll: true });
  const entities = expanded.columns.map(column => column.filter(node => node.type !== 'group'));
  const owners = new Map();
  graph.columns.flat().forEach(node => (node.type === 'group' ? node.members : [node]).forEach(member => owners.set(member.id, node.id)));
  // Only topology changes trigger layout. Polling counts must not move the map.
  const signature = JSON.stringify([graph.columns.map(col => col.map(node => node.id)), graph.edges.map(edge => [edge.from, edge.to]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  return { graph, entities, owners, expanded, signature };
}

export function spotlight(model, selectedId) {
  const edges = new Set(), nodes = new Set(), members = new Set();
  if (!selectedId || !model.owners.has(selectedId)) return { edges, nodes, members };
  for (const edge of model.expanded.edges) {
    if (!edge.related.has(selectedId)) continue;
    const from = model.owners.get(edge.from), to = model.owners.get(edge.to);
    edges.add(flowEdgeId(from, to)); nodes.add(from); nodes.add(to); members.add(edge.from); members.add(edge.to);
  }
  return { edges, nodes, members };
}

export function browseEntities(model, column, groupId = '', query = '') {
  const group = model.graph.groups.find(group => group.id === groupId);
  const members = group ? new Set(group.members.map(member => member.id)) : null;
  const names = new Map(model.graph.columns[1].map(path => [path.key, path.name]));
  const scoped = model.entities[column].filter(entity => !members || members.has(entity.id));
  const needle = query.trim().toLocaleLowerCase();
  const rows = scoped.filter(entity => [entity.name, entity.provider, ...(entity.connections ?? []).values()].map(value => names.get(value) ?? value).join(' ').toLocaleLowerCase().includes(needle));
  return { rows, total: scoped.length, group };
}

export async function layoutFlow(graph, elk) {
  if (!graph.requestCount) return { positions: new Map(), height: 300 };
  const children = graph.columns.flatMap((column, i) => column.map(node => ({ id: node.id, width: FLOW_COLUMNS[i].width, height: 54, layoutOptions: { 'elk.partitioning.partition': String(i) } })));
  const result = await elk.layout({ id: 'environment', layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.partitioning.activate': 'true',
    'elk.spacing.nodeNode': '38', 'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  }, children, edges: graph.edges.map(edge => ({ id: flowEdgeId(edge.from, edge.to), sources: [edge.from], targets: [edge.to] })).sort((a, b) => a.id.localeCompare(b.id)) });
  const cols = new Map(graph.columns.flatMap((column, i) => column.map(node => [node.id, i])));
  const top = Math.min(...result.children.map(node => node.y));
  const positions = new Map(result.children.map(node => [node.id, { x: FLOW_COLUMNS[cols.get(node.id)].x, y: node.y - top + 34 }]));
  const bottom = Math.max(...[...positions.values()].map(p => p.y + 66));
  return { positions, height: Math.max(300, bottom + 12) };
}
