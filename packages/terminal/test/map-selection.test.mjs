import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMapRecords, reportedPath } from '../client/environment.mjs';
import { sampleSnapshot } from '../src/sample.mjs';

const snapshot = { inventory: [], deployments: [] };
const request = (agentId, route, routeKind, model = 'model') => ({ agentId, workload: agentId || 'Pi', route, routeKind, model, provider: route });
function assertConnected(selection, candidates) {
  const { workloads, selectedPaths, deployments, scoped, workKey, pathKey, deployKey } = selection;
  assert.deepEqual(new Set(selectedPaths), new Set(candidates.map(pathKey)));
  for (const key of workloads) assert.ok(scoped.some(item => workKey(item) === key), `orphan workload: ${key}`);
  for (const key of selectedPaths) assert.ok(scoped.some(item => pathKey(item) === key), `orphan connection: ${key}`);
  for (const key of deployments) assert.ok(scoped.some(item => deployKey(item) === key), `orphan deployment: ${key}`);
  for (const item of scoped) {
    assert.ok(candidates.includes(item));
    assert.ok(workloads.includes(workKey(item)));
    assert.ok(selectedPaths.includes(pathKey(item)));
    assert.ok(deployments.includes(deployKey(item)));
  }
}

test('adding direct API workers cannot hide the existing gateway or local runtime', () => {
  const records = [
    ...Array.from({ length: 36 }, () => request(null, 'Ollama', 'local')),
    ...Array.from({ length: 24 }, (_, i) => Array.from({ length: 6 }, () => request(`or-${i}`, 'OpenRouter', 'gateway'))).flat(),
    ...Array.from({ length: 16 }, (_, i) => Array.from({ length: 6 }, () => request(`oa-${i}`, 'OpenAI', 'direct'))).flat(),
  ];
  const result = selectMapRecords(records, snapshot);
  assert.equal(records.length, 276);
  assert.equal(result.workloadOrder.length, 41);
  assert.equal(result.workloads.length, 4);
  assert.deepEqual(new Set(result.selectedPaths.map(key => JSON.parse(key)[0].name)), new Set(['Ollama', 'OpenRouter', 'OpenAI']));
  assertConnected(result, records);
  const reversed = selectMapRecords([...records].reverse(), snapshot);
  for (const key of ['workloads', 'selectedPaths', 'deployments']) assert.deepEqual(result[key], reversed[key]);
});

test('low-volume connections of the same type survive all former layout caps', () => {
  const records = [...Array.from({ length: 100 }, () => request('busy', 'Busy API', 'direct')),
    ...Array.from({ length: 12 }, (_, i) => request(`worker-${i}`, `API-${i}`, 'direct', `model-${i}`)),
    request('unknown', 'Unattributed route', 'unknown')];
  const result = selectMapRecords(records, snapshot);
  assert.equal(result.selectedPaths.length, 14);
  assert.equal(result.workloads.length, 14);
  assert.equal(result.deployments.length, 14);
  assertConnected(result, records);
});

test('model selection retains a recorded edge for each displayed workload', () => {
  const records = [
    ...Array.from({ length: 50 }, () => request('busy', 'Shared API', 'direct', 'common')),
    ...Array.from({ length: 10 }, (_, i) => request('busy', 'Shared API', 'direct', `alternate-${i}`)),
    request('quiet', 'Shared API', 'direct', 'quiet-only'),
  ];
  const result = selectMapRecords(records, snapshot);
  assert.ok(result.scoped.some(item => item.agentId === 'quiet' && item.model === 'quiet-only'));
  assert.equal(result.workloads.length, 2);
  assertConnected(result, records);
});

test('agent focus covers that agent’s connections and never borrows other agents', () => {
  const records = [...Array.from({ length: 10 }, (_, i) => request('selected', `connection-${i}`, 'gateway', `model-${i}`)), request('other', 'Other API', 'direct')];
  const focused = records.filter(item => item.agentId === 'selected');
  const result = selectMapRecords(focused, snapshot, { focused: true });
  assert.equal(result.workloads.length, 1);
  assert.equal(result.selectedPaths.length, 10);
  assert.equal(result.deployments.length, 10);
  assertConnected(result, focused);
});

test('reported entry hops and distinct deployment identities are preserved', () => {
  const deployments = ['east', 'west'].map(id => ({ id, model: 'model', provider: 'Host' }));
  const records = deployments.map(deployment => ({ ...request(deployment.id, 'Gateway', 'gateway'), provider: 'Host', deploymentId: deployment.id, path: [{ name: 'Gateway', kind: 'gateway' }, { name: 'Host', kind: 'direct' }] }));
  const result = selectMapRecords(records, { ...snapshot, deployments });
  assert.deepEqual(result.deployments, ['east', 'west']);
  assert.equal(result.selectedPaths.length, 1);
  assert.equal(JSON.parse(result.selectedPaths[0])[0].name, 'Gateway');
  assert.equal(reportedPath(result.scoped[0], snapshot).length, 2);
  assertConnected(result, records);
});

test('empty activity and the enterprise sample preserve honest map coverage', () => {
  const empty = selectMapRecords([], snapshot);
  assertConnected(empty, []);
  assert.equal(empty.workloads.length, 0);
  assert.equal(empty.deployments.length, 0);
  const sample = sampleSnapshot(Date.parse('2026-10-09T00:00:00Z'));
  assertConnected(selectMapRecords(sample.records, sample), sample.records);
});
