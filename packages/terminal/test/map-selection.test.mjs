import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvironmentMap } from '../client/map.mjs';
import { reportedPath } from '../client/environment.mjs';
import { sampleSnapshot } from '../src/sample.mjs';

const snapshot = { inventory: [], deployments: [] };
const request = (agentId, route, routeKind, model = 'model') => ({ agentId, agent: agentId, workload: agentId || 'Pi', route, routeKind, model, provider: route });
const workKey = item => item.agentId ? `agent:${item.agentId}` : `workload:${item.workload}`;
const modelKey = item => JSON.stringify([item.provider, item.model]);
const members = column => column.flatMap(node => node.type === 'group' ? node.expanded ? [] : node.members : [node]);
function assertCoverage(graph, records, data = snapshot) {
  const expectedWorks = new Set(records.map(workKey)), expectedModels = new Set(records.map(modelKey));
  assert.equal(graph.requestCount, records.length);
  assert.equal(graph.workloadCount, expectedWorks.size);
  assert.equal(graph.modelCount, expectedModels.size);
  assert.deepEqual(new Set(members(graph.columns[0]).map(node => node.key)), expectedWorks);
  assert.deepEqual(new Set(members(graph.columns[2]).map(node => node.key)), expectedModels);
  assert.equal(members(graph.columns[0]).reduce((sum, node) => sum + node.count, 0), records.length);
  assert.equal(members(graph.columns[2]).reduce((sum, node) => sum + node.count, 0), records.length);
  assert.deepEqual(new Set(graph.columns[1].map(node => node.key)), new Set(records.map(item => JSON.stringify([reportedPath(item, data)[0]]))));
  for (const segment of ['work', 'model']) assert.equal(graph.edges.filter(edge => edge.segment === segment).reduce((sum, edge) => sum + edge.count, 0), records.length);
  const visible = new Map(graph.columns.flat().map(node => [node.id, node]));
  for (const edge of graph.edges) {
    assert.ok(visible.has(edge.from)); assert.ok(visible.has(edge.to));
    const entity = visible.get(edge.segment === 'work' ? edge.from : edge.to);
    const path = visible.get(edge.segment === 'work' ? edge.to : edge.from);
    const keys = new Set((entity.type === 'group' ? entity.members : [entity]).map(item => item.key));
    const actual = records.filter(item => JSON.stringify([reportedPath(item, data)[0]]) === path.key && keys.has(edge.segment === 'work' ? workKey(item) : modelKey(item)));
    assert.equal(edge.count, actual.length, 'Every visible edge is backed by precisely its recorded requests');
  }
}
const lab = [
  ...Array.from({ length: 36 }, (_, i) => request(null, 'Ollama', 'local', `local-${i % 3}`)),
  ...Array.from({ length: 24 }, (_, i) => Array.from({ length: 6 }, () => request(`or-${i}`, 'OpenRouter', 'gateway', `remote-${i % 12}`))).flat(),
  ...Array.from({ length: 16 }, (_, i) => Array.from({ length: 6 }, () => request(`oa-${i}`, 'OpenAI', 'direct', `openai-${i % 8}`))).flat(),
];

test('all means all: 41 workloads and every model remain represented when collapsed', () => {
  const graph = buildEnvironmentMap(lab, snapshot);
  assert.equal(graph.workloadCount, 41);
  assert.equal(graph.requestCount, 276);
  assert.equal(graph.modelCount, 23);
  assert.equal(graph.columns[0].length, 3);
  assert.equal(graph.columns[2].length, 3);
  assertCoverage(graph, lab);
});

test('expanding one group and expanding all preserve counts and reveal every leaf', () => {
  const collapsed = buildEnvironmentMap(lab, snapshot);
  const group = collapsed.groups.find(group => group.side === 'work' && group.names.includes('OpenRouter'));
  const one = buildEnvironmentMap(lab, snapshot, { expansion: new Map([[group.id, true]]) });
  assert.equal(one.columns[0].filter(node => node.groupId === group.id).length, 24);
  assertCoverage(one, lab);
  const all = buildEnvironmentMap(lab, snapshot, { expandAll: true });
  assert.equal(all.columns[0].filter(node => node.type !== 'group').length, 41);
  assert.equal(all.columns[2].filter(node => node.type !== 'group').length, 23);
  assertCoverage(all, lab);
  const recollapsed = buildEnvironmentMap(lab, snapshot, { expandAll: true, expansion: new Map([[group.id, false]]) });
  assertCoverage(recollapsed, lab);
});

test('only entities with identical recorded connection sets share a group', () => {
  const records = [request('a', 'One', 'direct'), request('b', 'One', 'direct'), request('b', 'Two', 'gateway'), request('c', 'One', 'direct'), request('c', 'Two', 'gateway')];
  const graph = buildEnvironmentMap(records, snapshot);
  const group = graph.groups.find(group => group.side === 'work');
  assert.deepEqual(new Set(group.members.map(item => item.name)), new Set(['b', 'c']));
  assert.deepEqual(new Set(group.names), new Set(['One', 'Two']));
  assert.equal(graph.columns[0].find(node => node.name === 'a').type, 'agent');
  assertCoverage(graph, records);
});

test('low-volume connections and models survive without layout caps', () => {
  const records = [...Array.from({ length: 100 }, () => request('busy', 'Busy', 'direct')),
    ...Array.from({ length: 70 }, (_, i) => request(`quiet-${i}`, `API-${i}`, 'direct', `model-${i}`)),
    request(null, 'Unattributed route', 'unknown')];
  assertCoverage(buildEnvironmentMap(records, snapshot), records);
  assertCoverage(buildEnvironmentMap(records, snapshot, { expandAll: true }), records);
});

test('filtering an agent changes scope without borrowing other requests', () => {
  const selected = lab.filter(item => item.agentId === 'or-7');
  const graph = buildEnvironmentMap(selected, snapshot);
  assert.equal(graph.requestCount, 6); assert.equal(graph.workloadCount, 1);
  assert.equal(graph.columns[1][0].name, 'OpenRouter');
  assertCoverage(graph, selected);
});

test('serving services stay distinct and only matched explicit deployments are attached', () => {
  const data = { ...snapshot, deployments: ['east', 'west'].map(id => ({ id, name: id, model: 'model', provider: 'Host' })) };
  const records = data.deployments.map(d => ({ ...request(d.id, 'Gateway', 'gateway'), provider: 'Host', deploymentId: d.id }));
  records.push({ ...records[0], deploymentId: 'missing' }, { ...records[0], provider: 'Other host' });
  const graph = buildEnvironmentMap(records, data, { expandAll: true });
  const models = members(graph.columns[2]);
  assert.equal(models.length, 2);
  assert.deepEqual([...models.find(model => model.provider === 'Host').deployments.keys()], ['east', 'west']);
  assert.equal(models.find(model => model.provider === 'Other host').deployments.size, 0);
  assertCoverage(graph, records, data);
});

test('group identity, order, and expansion remain stable on polling and reordered input', () => {
  const graph = buildEnvironmentMap(lab, snapshot), reversed = buildEnvironmentMap([...lab].reverse(), snapshot);
  assert.deepEqual(graph.columns.map(column => column.map(node => node.id)), reversed.columns.map(column => column.map(node => node.id)));
  const group = graph.groups.find(group => group.side === 'work' && group.names.includes('OpenAI'));
  const updated = buildEnvironmentMap([...lab, request('oa-new', 'OpenAI', 'direct', 'new-model')], snapshot, { expansion: new Map([[group.id, true]]) });
  assert.equal(updated.groups.find(item => item.id === group.id).expanded, true);
  assert.equal(updated.columns[0].filter(node => node.groupId === group.id).length, 17);
});

test('empty activity and the enterprise sample keep full coverage', () => {
  assertCoverage(buildEnvironmentMap([], snapshot), []);
  const sample = sampleSnapshot(Date.parse('2026-10-09T00:00:00Z'));
  assertCoverage(buildEnvironmentMap(sample.records, sample), sample.records, sample);
  assertCoverage(buildEnvironmentMap(sample.records, sample, { expandAll: true }), sample.records, sample);
});
