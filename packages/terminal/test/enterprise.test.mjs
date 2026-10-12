import test from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseSnapshot, demoSnapshot, PRICES, tokenCost } from '../src/enterprise-sample.mjs';
import { requestCount, requestWeight } from '../client/request-count.mjs';
import { routeBreakdown, activityEvidence } from '../client/routes.mjs';
import { serviceInventory } from '../client/services.mjs';
import { buildEnvironmentMap } from '../client/map.mjs';
import { deploymentFor } from '../client/environment.mjs';
import worker from '../hosted/worker.mjs';
import { WORKLOADS, CATALOG, CONFIGURED_SERVICES, PREFERENCES, selectReplacement, assessReplacement, matchesPreference } from '../src/demo-policy.mjs';
const candidate = id => CATALOG.find(item => item.id === id);
const fixtureWorkload = () => structuredClone({ ...WORKLOADS[0], candidates: [candidate('gpt41'), candidate('gpt41mini')] });
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
    for (const field of ['id', 'occurredAt', 'sampleRequests', 'agentId', 'taskId', 'inputTokens', 'outputTokens', 'deploymentId']) assert.deepEqual(a[field], b[field], field);
    const pair = after.simulation.assignments[a.assignmentId];
    assert.equal(a.model !== b.model, pair.modelChanged);
    assert.equal(a.provider !== b.provider, pair.serviceChanged);
    assert.ok(CONFIGURED_SERVICES.includes(b.provider));
    assert.equal(a.durationMs, null); assert.equal(b.durationMs, null);
    assert.ok(a.cost >= b.cost && b.cost > 0);
    assert.equal(a.cost, a.beforeCost); assert.equal(b.cost, b.afterCost);
    assert.ok(deploymentFor(a, before)); assert.ok(deploymentFor(b, after));
    assert.equal(a.cost, tokenCost(before.simulation.assignments[a.assignmentId].before, a.inputTokens, a.outputTokens));
    assert.equal(b.cost, tokenCost(after.simulation.assignments[b.assignmentId].after, b.inputTokens, b.outputTokens));
  }
  assert.equal(new Set(before.records.map(item=>item.provider)).size, 6);
  assert.equal(before.models.length, 10); assert.equal(after.models.length, 10);
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
  const req = (path, method='GET') => new Request(`https://dash.openmerit.ai${path}`, {method});
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
  for (const path of ['/demo', '/demo/']) assert.equal(await (await worker.fetch(new Request(`https://dash.openmerit.ai${path}`), env)).text(), 'demo');
});

test('preferences preserve all usage while separating overrides from qualified selections', () => {
  const baseline = demoSnapshot(now);
  assert.equal(baseline.project.name, 'insurance-tech-demo');
  assert.equal(new Set(baseline.records.map(r => r.agentId)).size, 280);
  assert.equal(new Set(baseline.records.map(r => r.taskId)).size, 980);
  for (const { value } of PREFERENCES) {
    const data = demoSnapshot(now, 'after', value), sim = data.simulation;
    assert.deepEqual(data.inventory, baseline.inventory);
    assert.deepEqual(data.capacityPools, baseline.capacityPools);
    assert.equal(sim.catalogSize, 26);
    assert.equal(sim.feasible, true);
    assert.equal(data.records.length, 9600);
    assert.equal(data.deployments.length, 14);
    const overrides = sim.assignments.filter(pair => pair.override);
    assert.equal(overrides.length, {default:0,zdr:8,open:7,closed:3,usa:2,china:9}[value]);
    for (const pair of sim.assignments) {
      assert.ok(pair.after);
      assert.ok(CONFIGURED_SERVICES.includes(pair.after.provider));
      assert.equal(pair.after.outputType, pair.before.outputType);
      assert.equal(pair.preferenceMatched, true);
      assert.equal(matchesPreference(pair.after, value), true);
      if (!pair.changed) { assert.equal(pair.override, false); continue; }
      const assessment = pair.assessments.find(item => item.candidate.id === pair.after.id);
      assert.equal(pair.override, !assessment.eligible);
      assert.deepEqual(pair.overrideReasons, pair.override ? assessment.issues : []);
      if (!pair.override) assert.ok(pair.checks.every(check => check.status === 'pass'));
    }
    for (let i = 0; i < data.records.length; i++) {
      for (const field of ['id','workload','agent','agentId','task','taskId','occurredAt','routeKind','inputTokens','outputTokens']) assert.deepEqual(data.records[i][field], baseline.records[i][field]);
      assert.equal(data.records[i].cost, data.records[i].afterCost);
      assert.ok(deploymentFor(data.records[i], data));
    }
    for (const [hours, totals] of Object.entries(sim.windows)) {
      const records = data.records.filter(r => !Number(hours) || Date.parse(r.occurredAt) >= now - Number(hours) * 3600000);
      assert.equal(totals.requests, records.length * 1000);
      assert.equal(totals.assignedRequests, totals.requests);
      assert.equal(totals.overrideRequests, records.filter(r => sim.assignments[r.assignmentId].override).length * 1000);
      assert.equal(totals.qualifiedRequests + totals.overrideRequests, totals.assignedRequests);
      assert.equal(totals.afterCost, total(records, 'cost'));
    }
    assert.equal(buildEnvironmentMap(data.records, data).requestCount, 9600000);
    assert.equal(Object.values(routeBreakdown(data.records, data)).reduce((a,b)=>a+b,0), 9600000);
  }
});
test('cheaper models with weaker or missing benchmark evidence are not selected', () => {
  const workload = fixtureWorkload(), usage = { inputTokens: 1e6, outputTokens: 1e6 };
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
test('qualified preferred candidates win while service and output-contract constraints remain required', () => {
  const workload = fixtureWorkload(), usage = { inputTokens: 1e6, outputTokens: 1e6 };
  const base = workload.candidates[0];
  // Synthetic candidates exercise the ranking mechanism; these are not public model claims.
  workload.candidates = [base, { ...base, id: 'fixture-open', openWeights: true, origin: 'CN', confirmedZdr: true, input: 2.1 }];
  assert.equal(selectReplacement(workload, usage).after.id, base.id);
  for (const preference of ['open','china','zdr']) assert.equal(selectReplacement(workload, usage, preference).after.id, 'fixture-open');
  for (const preference of ['closed','usa']) assert.equal(selectReplacement(workload, usage, preference).after.id, base.id);
  workload.candidates[1].provider = 'Unconfigured service';
  assert.equal(selectReplacement(workload, usage, 'open').after.id, base.id);
  workload.candidates[1].provider = 'Baseten';
  assert.equal(selectReplacement(workload, usage, 'open').after.id, 'fixture-open');
  workload.candidates[1].outputType = 'decision';
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
  const workload = fixtureWorkload(), usage = { inputTokens: 1e6, outputTokens: 1e6 };
  workload.candidates = [workload.candidates[0]]; const candidate = workload.candidates[0];
  candidate.input = 3; candidate.output = 12;
  workload.before.latency = { suite:'fixture-workload-config', metric:'p95-ms', value:100, source:'https://example.com/paired' };
  candidate.latency = { ...workload.before.latency, value:80 };
  assert.equal(selectReplacement(workload, usage).changed, true);
  candidate.latency.suite = 'different'; assert.equal(selectReplacement(workload, usage).changed, false);
  candidate.latency.suite = workload.before.latency.suite;
  candidate.input = null; assert.equal(selectReplacement(workload, usage).changed, false);
  candidate.input = 3; candidate.latency.value = 0;
  assert.equal(selectReplacement(workload, usage).changed, false);
});
test('hosted preference is validated and reflected in the sample API', async () => {
  for (const preference of ['closed', 'unknown']) {
    const data = await (await worker.fetch(new Request(`https://dash.openmerit.ai/api/demo?stage=after&preference=${preference}`), {})).json();
    assert.equal(data.simulation.preference, preference === 'closed' ? 'closed' : 'default');
  }
});

test('decision accuracy and calibration must both match or improve', () => {
  const workload = fixtureWorkload(), usage = {inputTokens:1e6,outputTokens:1e6};
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

test('published offer identities, configured set and actual preference outcomes are explicit', () => {
  const baseline = demoSnapshot(now), after = demoSnapshot(now, 'after');
  const assignment = after.simulation.assignments.find(item => item.id === 'claims.tagging');
  assert.equal(assignment.before.modelId, assignment.after.modelId);
  assert.equal(assignment.after.provider, 'Baseten');
  assert.equal(assignment.after.confirmedZdr, true);
  assert.ok(assignment.after.input < assignment.before.input);
  assert.deepEqual(baseline.inventory, after.inventory);
  // Preference effects come from the real reviewed catalog.
  for (const preference of ['zdr','open','usa','china']) {
    const data = demoSnapshot(now, 'after', preference);
    for (const pair of data.simulation.assignments) assert.equal(pair.preferenceChanged, pair.after.id !== pair.defaultChoice);
  }
  for (const model of CATALOG) {
    assert.match(model.source, /^https:\/\//);
    assert.ok(Number.isFinite(model.input) && Number.isFinite(model.output));
    if (model.confirmedZdr) assert.match(model.policySource, /^https:\/\//);
  }
  assert.equal(matchesPreference({openWeights:null}, 'closed'), false);
  assert.equal(matchesPreference({confirmedZdr:null}, 'zdr'), false);
  assert.equal(matchesPreference({origin:null}, 'china'), false);
});
test('multiple evidence cohorts find matched benchmarks and never skip a matched regression', () => {
  const workload = WORKLOADS.find(item => item.id === 'coverage.review');
  const qwen = assessReplacement(workload, candidate('qwen36'), {inputTokens:1e6,outputTokens:1e6});
  assert.equal(qwen.checks.length, 4);
  assert.equal(qwen.checks.filter(check => check.status === 'regression').length, 1);
  assert.equal(qwen.eligible, false);
  assert.ok(qwen.checks.some(check => check.before?.name === 'ClawEval · pass³' && check.status === 'pass'));
});
test('closed preference includes all workloads and honestly reports the three exceptions', () => {
  const before = demoSnapshot(now, 'before', 'closed'), after = demoSnapshot(now, 'after', 'closed');
  assert.deepEqual(before.records.map(r=>r.model), demoSnapshot(now).records.map(r=>r.model));
  assert.equal(before.records.filter(record => record.afterCost === null).length, 0);
  assert.deepEqual(before.simulation.windows, after.simulation.windows);
  const pairs = after.simulation.assignments.filter(pair => pair.override);
  assert.deepEqual(pairs.map(pair=>pair.id), ['claims.tagging','fraud.review','broker.translation']);
  assert.ok(pairs.every(pair=>pair.after.openWeights === false));
  assert.ok(pairs.every(pair=>pair.checks.every(check=>check.status === 'missing')));
  const tagging = pairs[0].assessments.find(item=>item.candidate.id === pairs[0].after.id);
  assert.ok(tagging.afterCost > tagging.beforeCost);
  assert.equal(tagging.faster, false);
  assert.ok(pairs[0].overrideReasons.includes('No verified cost or latency improvement'));
});

test('preference overrides preserve missing evidence, regressions, efficiency and decision criteria', () => {
  const workload = fixtureWorkload(), usage = {inputTokens:1e6, outputTokens:1e6};
  workload.candidates = [workload.candidates[1]];
  const model = workload.candidates[0];
  model.openWeights = true;
  model.input = 100;
  workload.requiredAxes.push('decisions');
  assert.equal(selectReplacement(workload, usage).after.id, workload.before.id);
  const chosen = selectReplacement(workload, usage, 'open');
  assert.equal(chosen.after.id, model.id);
  assert.equal(chosen.override, true);
  assert.deepEqual(chosen.overrideReasons, ['Comparable benchmark evidence is incomplete','A required benchmark regresses','No verified cost or latency improvement']);
  assert.equal(chosen.checks.find(c=>c.axis==='decisionAccuracy').status, 'missing');
  assert.equal(chosen.checks.find(c=>c.axis==='calibration').status, 'missing');
  assert.equal(chosen.checks.find(c=>c.axis==='tools').status, 'regression');
  // A baseline that already meets a preference is retained without a spurious exception.
  workload.before.openWeights = true;
  assert.equal(selectReplacement(workload, usage, 'open').changed, false);
});

test('overrides cannot invent a compatible endpoint, output contract, known price or preference match', () => {
  const usage = {inputTokens:1e6,outputTokens:1e6};
  for (const patch of [{provider:'Unconfigured'}, {outputType:'decision'}, {input:null}, {openWeights:null}]) {
    const workload = fixtureWorkload();
    workload.before.openWeights = true;
    workload.candidates = [{...workload.candidates[1], ...patch}];
    const chosen = selectReplacement(workload, usage, 'closed');
    assert.equal(chosen.unresolved, true);
    assert.equal(chosen.after, null);
    assert.equal(chosen.override, false);
    assert.deepEqual(chosen.overrideReasons, []);
  }
});

test('override ranking prioritizes fewer regressions then evidence gaps and efficiency before cost', () => {
  const workload = fixtureWorkload(), usage = {inputTokens:1e6,outputTokens:1e6};
  const strong = structuredClone(workload.candidates[0]);
  const weak = structuredClone(workload.candidates[1]);
  strong.id='preferred-strong'; weak.id='preferred-weak';
  strong.openWeights=weak.openWeights=true;
  strong.input=100; // fails efficiency, while the cheaper choice regresses on benchmarks.
  workload.candidates=[weak,strong];
  let result=selectReplacement(workload,usage,'open');
  assert.equal(result.after.id,strong.id);
  assert.equal(result.override,true);
  assert.deepEqual(result.overrideReasons,['No verified cost or latency improvement']);
  strong.input=2;
  result=selectReplacement(workload,usage,'open');
  assert.equal(result.after.id,strong.id);
  assert.equal(result.override,false);
});

test('expanded application workloads make actual preference selections and recalculate prices', () => {
  const plans = Object.fromEntries(PREFERENCES.map(({value}) => [value, demoSnapshot(now, 'after', value)]));
  const pick = (preference, id) => plans[preference].simulation.assignments.find(pair => pair.id === id);
  assert.equal(pick('default', 'actuarial.queries').after.id, 'gemini3flash');
  assert.equal(pick('default', 'claims.reconciliation').after.id, 'glm47');
  for (const preference of ['zdr', 'open', 'china']) {
    assert.equal(pick(preference, 'actuarial.queries').after.id, 'glm47');
    assert.notEqual(plans[preference].simulation.windows[0].afterCost, plans.default.simulation.windows[0].afterCost);
  }
  assert.equal(pick('usa', 'claims.reconciliation').after.id, 'gemini3flash');
  assert.equal(pick('closed', 'claims.reconciliation').after.id, 'gemini3flash');
  assert.notEqual(plans.usa.simulation.windows[0].afterCost, plans.default.simulation.windows[0].afterCost);
  assert.deepEqual(plans.zdr.simulation.equivalentPreferences, []);
  assert.deepEqual(plans.default.simulation.equivalentPreferences, []);
  for (const [preference, data] of Object.entries(plans)) {
    const baseline = demoSnapshot(now, 'before', preference);
    for (const pair of data.simulation.assignments.filter(pair => pair.tokenProfile)) {
      const qualified = pair.assessments.filter(item => item.eligible);
      assert.deepEqual(qualified.map(item => item.candidate.id).sort(), ['gemini3flash','glm47']);
      for (const item of qualified) {
        assert.equal(item.checks.length, 3);
        assert.ok(item.checks.every(check => check.status === 'pass'));
        assert.equal(item.cheaper, true);
      }
    }
    const original = new Map(baseline.records.map(record => [record.id, record]));
    for (const record of data.records) {
      const pair = data.simulation.assignments[record.assignmentId];
      assert.equal(record.inputTokens, original.get(record.id).inputTokens);
      assert.equal(record.outputTokens, original.get(record.id).outputTokens);
      // Independent arithmetic, not the implementation's cost helper.
      const expected = (record.inputTokens * pair.after.input + record.outputTokens * pair.after.output) / 1e6;
      assert.equal(record.cost, expected);
    }
    if (data.simulation.feasible) assert.equal(data.simulation.windows[0].afterCost, total(data.records, 'cost'));
    else assert.equal(data.simulation.windows[0].afterCost, null);
  }
});
