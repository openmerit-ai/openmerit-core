import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { flowModel, browseEntities, spotlight, layoutFlow, flowEdgeId, FLOW_COLUMNS } from '../client/flow-model.mjs';
import { sampleSnapshot } from '../src/sample.mjs';
const snapshot = { inventory: [], deployments: [] };
const request = (agent, model, route = 'OpenAI', kind = 'direct') => ({ agentId: agent, agent, workload: agent, model, provider: route, route, routeKind: kind });

test('browser keeps every entity and searches names, providers, and connections within an exact stack', () => {
  const data = [request('one', 'a'), request('two', 'b'), request('three', 'c', 'OpenRouter', 'gateway')];
  const m = flowModel(data, snapshot), group = m.graph.groups.find(g => g.side === 'work');
  assert.equal(browseEntities(m, 0).rows.length, 3);
  assert.equal(browseEntities(m, 0, group.id).total, 2);
  assert.deepEqual(browseEntities(m, 0, group.id, 'TWO').rows.map(n => n.name), ['two']);
  assert.equal(browseEntities(m, 0, group.id, 'OpenAI').rows.length, 2);
  assert.equal(browseEntities(m, 0, group.id, 'three').rows.length, 0);
  assert.equal(browseEntities(m, 2, '', 'OpenRouter').rows.length, 1);
});

test('spotlight does not invent connections by joining requests that share a service', () => {
  const data = [request('one', 'a'), request('two', 'b'), request('two', 'b', 'OpenRouter', 'gateway')].map(record => ({ ...record, provider: 'Host' }));
  const m = flowModel(data, snapshot), one = m.entities[0].find(n => n.name === 'one');
  const active = spotlight(m, one.id);
  const lit = m.graph.edges.filter(e => active.edges.has(flowEdgeId(e.from, e.to)));
  assert.equal(lit.length, 2);
  assert.ok(lit.every(e => e.kind === 'direct'));
  const models = m.graph.columns[2].filter(n => active.nodes.has(n.id));
  assert.deepEqual(models.map(n => n.name), ['a']);
  assert.deepEqual(m.entities[2].filter(n => active.members.has(n.id)).map(n => n.name), ['a']);
  assert.equal(m.graph.requestCount, 3);
  assert.equal(spotlight(m, 'gone').edges.size, 0);
});

test('counts and request order do not cause a new layout', () => {
  const records = [request('b', 'b'), request('a', 'a')];
  const before = flowModel(records, snapshot), after = flowModel([...records, ...records].reverse(), snapshot);
  assert.equal(before.signature, after.signature);
  assert.equal(after.graph.requestCount, 4);
});

test('ELK lays out all enterprise nodes with fixed columns and no overlap', async () => {
  const data = sampleSnapshot(), m = flowModel(data.records, data);
  const layout = await layoutFlow(m.graph, new ELK());
  assert.equal(m.graph.requestCount, 9600);
  assert.equal(browseEntities(m, 0).rows.length, 40);
  assert.equal(browseEntities(m, 2).rows.length, 21);
  assert.equal(layout.positions.size, m.graph.columns.flat().length);
  for (const [index, column] of m.graph.columns.entries()) {
    const positions = column.map(n => layout.positions.get(n.id)).sort((a,b) => a.y - b.y);
    positions.forEach((position,i) => {
      assert.equal(position.x, FLOW_COLUMNS[index].x);
      assert.ok(Number.isFinite(position.y));
      if (i) assert.ok(position.y - positions[i-1].y >= 54);
    });
  }
  const repeated = await layoutFlow(m.graph, new ELK());
  assert.deepEqual(layout, repeated);
});

test('empty scopes are browseable without asking ELK to lay out absent nodes', async () => {
  const m = flowModel([], snapshot);
  const layout = await layoutFlow(m.graph, { layout() { throw new Error('Should not run'); } });
  assert.equal(layout.positions.size, 0);
  assert.equal(browseEntities(m, 0).total, 0);
});
