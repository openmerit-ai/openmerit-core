import test from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseSnapshot, demoSnapshot, PRICES, tokenCost } from '../src/enterprise-sample.mjs';
import { requestCount, requestWeight } from '../client/request-count.mjs';
import { routeBreakdown, activityEvidence } from '../client/routes.mjs';
import { serviceInventory } from '../client/services.mjs';
import { buildEnvironmentMap } from '../client/map.mjs';
import { deploymentFor } from '../client/environment.mjs';
import worker from '../hosted/worker.mjs';
import { WORKLOADS, PREFERENCES, selectReplacement, assessReplacement } from '../src/demo-policy.mjs';
const now = Date.parse('2026-10-10T12:00:00Z');
const total = (items, field) => items.reduce((n, item) => n + (item[field] ?? 0), 0);

test('published token prices calculate costs without invented discounts', () => {
  assert.equal(tokenCost(PRICES[0], 1_000_000, 1_000_000), 17.5);
  assert.equal(tokenCost(PRICES[1], 1_000_000, 1_000_000), 5.25);
  assert.equal(tokenCost(null, 1000, 1000), null);
  assert.equal(tokenCost(PRICES[0], 1000, null), null);
  for (const price of PRICES) assert.match(price.source, /^https:\/\//);
});
test('enterprise sample represents 9.6M requests in bounded groups over 30 days', () => {
  const data = enterpriseSnapshot(now);
  assert.equal(data.records.length, 9600);
  assert.equal(requestCount(data.records, data), 9_600_000);
  assert.equal(data.models.length, 21);
  assert.equal(new Set(data.records.map(item => item.agentId)).size, 200);
  assert.ok(total(data.records, 'inputTokens') > 80_000_000_000);
  assert.ok(total(data.records, 'cost') > 100_000);
  assert.ok(now - Math.min(...data.records.map(item => Date.parse(item.occurredAt))) > 29 * 86400000);
  for (const item of data.records) {
    assert.equal(item.requestId, null);
    assert.equal(item.cacheReadTokens, 0);
    if (['Ollama', 'vLLM', 'LM Studio', 'Cerebras', 'Cohere'].includes(item.provider)) assert.equal(item.cost, null);
  }
});
test('sample group weights never inflate live or ordinary sample records', () => {
  const record = { sampleRequests: 1000 };
  assert.equal(requestWeight(record, { mode: 'live', simulation: { kind: 'enterprise-groups' } }), 1);
  assert.equal(requestWeight(record, { mode: 'sample' }), 1);
  for (const sampleRequests of [-1, 0, Infinity, 1.5, '1000']) assert.equal(requestWeight({sampleRequests}, {mode:'sample',simulation:{kind:'enterprise-groups'}}), 1);
});
test('comparison changes models and prices while preserving the complete workload and provider set', () => {
  const before = demoSnapshot(now), after = demoSnapshot(now, 'after');
  assert.deepEqual(before.inventory, after.inventory);
  assert.deepEqual(before.capacityPools, after.capacityPools);
  assert.equal(before.records.length, after.records.length);
  for (let i = 0; i < before.records.length; i++) {
    const a = before.records[i], b = after.records[i];
    for (const field of ['id', 'occurredAt', 'sampleRequests', 'provider', 'agentId', 'taskId', 'inputTokens', 'outputTokens', 'route', 'path', 'deploymentId']) assert.deepEqual(a[field], b[field], field);
    const pair = after.simulation.assignments[a.assignmentId];
    assert.equal(a.model !== b.model, pair.changed);
    assert.equal(a.durationMs, null); assert.equal(b.durationMs, null);
    assert.ok(a.cost >= b.cost && b.cost > 0);
    assert.equal(a.cost, a.beforeCost); assert.equal(b.cost, b.afterCost);
    assert.ok(deploymentFor(a, before)); assert.ok(deploymentFor(b, after));
    assert.equal(a.cost, tokenCost(before.simulation.assignments[a.assignmentId].before, a.inputTokens, a.outputTokens));
    assert.equal(b.cost, tokenCost(after.simulation.assignments[b.assignmentId].after, b.inputTokens, b.outputTokens));
  }
  assert.equal(new Set(before.records.map(item=>item.provider)).size, 6);
  assert.equal(before.models.length, 9); assert.equal(after.models.length, 9);
  assert.equal(total(before.records, 'inputTokens'), total(after.records, 'inputTokens'));
  assert.equal(total(before.records, 'outputTokens'), total(after.records, 'outputTokens'));
  assert.ok(total(after.records, 'cost') < total(before.records, 'cost'));
  assert.deepEqual(demoSnapshot(now, 'after'), after);
});
test('graphs, activity and service paths account for every grouped request', () => {
  const data = demoSnapshot(now);
  const count = requestCount(data.records, data);
  assert.equal(Object.values(routeBreakdown(data.records, data)).reduce((a,b)=>a+b,0), count);
  assert.equal(activityEvidence(data).count, count);
  const graph = buildEnvironmentMap(data.records, data);
  assert.equal(graph.requestCount, count);
  for (const column of graph.columns) assert.equal(column.reduce((n,item)=>n+item.count,0), count);
  assert.equal(graph.edges.reduce((n,item)=>n+item.count,0), count * 2);
  for (const service of serviceInventory(data)) assert.equal(service.paths.reduce((n,item)=>n+item.count,0), requestCount(service.records, data));
});
test('hosted seed and comparison are read-only and never fall back to a collector', async () => {
  const env = { ASSETS: { fetch() { throw new Error('Unexpected assets'); } } };
  const req = (path, method='GET') => new Request(`https://dash.openmerit.site${path}`, {method});
  const seed = await (await worker.fetch(req('/api/sample-seed'), env)).json();
  assert.equal(seed.version, 1); assert.ok(Math.abs(seed.now - Date.now()) < 16000);
  assert.ok(JSON.stringify(seed).length < 100);
  const after = await (await worker.fetch(req('/api/demo?stage=after'), env)).json();
  assert.equal(after.mode, 'sample'); assert.equal(after.simulation.stage, 'after');
  assert.equal((await worker.fetch(req('/api/demo', 'POST'), env)).status, 405);
  assert.equal((await worker.fetch(req('/api/snapshot'), env)).status, 404);
});
test('both comparison URL forms serve the comparison document', async () => {
  const env = { ASSETS: { fetch(request) { assert.equal(new URL(request.url).pathname, '/demo/'); return new Response('demo', {headers:{'Content-Type':'text/html'}}); } } };
  for (const path of ['/demo', '/demo/']) assert.equal(await (await worker.fetch(new Request(`https://dash.openmerit.site${path}`), env)).text(), 'demo');
});

test('demo identities describe a stable insurance application in every preference', () => {
  const baseline = demoSnapshot(now);
  assert.equal(baseline.project.name, 'insurance-tech-demo');
  assert.equal(new Set(baseline.records.map(r => r.agentId)).size, 200);
  assert.equal(new Set(baseline.records.map(r => r.taskId)).size, 700);
  const cost = total(baseline.records, 'cost');
  for (const { value } of PREFERENCES) {
    const data = demoSnapshot(now, 'after', value);
    assert.equal(total(data.records, 'inputTokens'), total(baseline.records, 'inputTokens'));
    assert.equal(total(data.records, 'outputTokens'), total(baseline.records, 'outputTokens'));
    assert.ok(total(data.records, 'cost') < cost);
    assert.equal(data.simulation.assignments.filter(pair => pair.changed).length, 3);
    for (const pair of data.simulation.assignments) {
      if (pair.changed) assert.ok(pair.checks.every(check => check.status === 'pass'));
      assert.equal(pair.before.provider, pair.after.provider);
    }
    if (value === 'closed') assert.equal(data.simulation.assignments.filter(pair => pair.unresolved).length, 3);
    for (let i = 0; i < data.records.length; i++) {
      for (const field of ['id','workload','agent','agentId','task','taskId','occurredAt','path']) assert.deepEqual(data.records[i][field], baseline.records[i][field]);
      assert.match(data.records[i].workload, /^services\/(claims|policy|coverage|documents|renewals|fraud|broker)\//);
    }
  }
});
test('cheaper models with weaker or missing benchmark evidence are not selected', () => {
  const workload = WORKLOADS[0], usage = { inputTokens: 1e6, outputTokens: 1e6 };
  const mini = assessReplacement(workload, workload.candidates[1], usage);
  assert.equal(mini.cheaper, true); assert.equal(mini.eligible, false);
  assert.equal(mini.checks.find(c => c.axis === 'tools').status, 'regression');
  for (const preference of PREFERENCES) {
    const chosen = selectReplacement(workload, usage, preference.value);
    assert.equal(chosen.after.id, 'gpt41');
  }
  const missing = structuredClone(workload); missing.candidates[0].benchmarks.pop(); missing.candidates = [missing.candidates[0]];
  assert.equal(selectReplacement(missing, usage).changed, false);
  const mismatch = structuredClone(workload); mismatch.candidates[0].benchmarks[0].suite += '-different-version'; mismatch.candidates = [mismatch.candidates[0]];
  assert.equal(selectReplacement(mismatch, usage).changed, false);
  const expensive = structuredClone(workload); expensive.candidates = [expensive.candidates[0]]; expensive.candidates[0].input = 100;
  assert.equal(selectReplacement(expensive, usage).changed, false);
});
test('preference ranking never relaxes quality, cost, endpoint or output-contract gates', () => {
  const workload = structuredClone(WORKLOADS[0]), usage = { inputTokens: 1e6, outputTokens: 1e6 };
  const base = workload.candidates[0];
  // Synthetic candidates exercise the ranking mechanism; these are not public model claims.
  workload.candidates = [base, { ...base, id: 'fixture-open', openWeights: true, origin: 'CN', confirmedZdr: true, input: 2.1 }];
  assert.equal(selectReplacement(workload, usage).after.id, base.id);
  for (const preference of ['open','china','zdr']) assert.equal(selectReplacement(workload, usage, preference).after.id, 'fixture-open');
  for (const preference of ['closed','usa']) assert.equal(selectReplacement(workload, usage, preference).after.id, base.id);
  workload.candidates[1].provider = 'Unconfigured service';
  assert.equal(selectReplacement(workload, usage, 'open').after.id, base.id);
  workload.candidates[1].provider = base.provider; workload.candidates[1].outputType = 'decision';
  assert.equal(selectReplacement(workload, usage, 'open').after.id, base.id);
  workload.candidates[1].outputType = base.outputType; workload.candidates[1].openWeights = null;
  workload.candidates = [workload.candidates[1]];
  assert.equal(selectReplacement(workload, usage, 'closed').changed, false);
});
test('a fourth decision gate cannot be bypassed by ordinary LLM benchmark scores', () => {
  const workload = WORKLOADS.find(item => item.id === 'claims.routing');
  const result = selectReplacement(workload, { inputTokens: 1e6, outputTokens: 1e6 });
  assert.equal(result.changed, false);
  assert.equal(result.assessments[0].checks.find(c => c.axis === 'decisionAccuracy').status, 'missing');
  const jev = result.assessments.find(item => item.candidate.id === 'jev');
  assert.equal(jev.eligible, false);
  assert.ok(jev.issues.some(issue => issue.includes('output contract')));
});
test('speed only qualifies with a matched latency measurement, never a missing value or different setup', () => {
  const workload = structuredClone(WORKLOADS[0]), usage = { inputTokens: 1e6, outputTokens: 1e6 };
  workload.candidates = [workload.candidates[0]]; const candidate = workload.candidates[0];
  candidate.input = 3; candidate.output = 12;
  workload.before.latency = { suite:'fixture-workload-config', metric:'p95-ms', value:100, source:'https://example.com/paired' };
  candidate.latency = { ...workload.before.latency, value:80 };
  assert.equal(selectReplacement(workload, usage).changed, true);
  candidate.latency.suite = 'different'; assert.equal(selectReplacement(workload, usage).changed, false);
  candidate.latency.suite = workload.before.latency.suite; candidate.latency.value = 0;
  assert.equal(selectReplacement(workload, usage).changed, false);
});
test('hosted preference is validated and reflected in the sample API', async () => {
  for (const preference of ['closed', 'unknown']) {
    const data = await (await worker.fetch(new Request(`https://dash.openmerit.site/api/demo?stage=after&preference=${preference}`), {})).json();
    assert.equal(data.simulation.preference, preference === 'closed' ? 'closed' : 'default');
  }
});

test('decision accuracy and calibration must both match or improve', () => {
  const workload = structuredClone(WORKLOADS[0]), usage = {inputTokens:1e6,outputTokens:1e6};
  workload.requiredAxes.push('decisions'); workload.candidates = [workload.candidates[0]];
  const metric = (axis, value, direction='higher') => ({axis, name:axis, suite:`fixture-${axis}`, value, direction, unit:'%', source:'https://example.com/paired'});
  workload.before.benchmarks.push(metric('decisionAccuracy',90), metric('calibration',5,'lower'));
  workload.candidates[0].benchmarks.push(metric('decisionAccuracy',95));
  assert.equal(selectReplacement(workload, usage).changed, false);
  workload.candidates[0].benchmarks.push(metric('calibration',6,'lower'));
  assert.equal(selectReplacement(workload, usage).changed, false);
  workload.candidates[0].benchmarks.at(-1).value = 4;
  assert.equal(selectReplacement(workload, usage).changed, true);
});
