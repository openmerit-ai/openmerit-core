import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenMeritCoordinator, ProjectStore } from '../../dist/core/src/index.js';
import { PI_HARNESS_DESCRIPTOR } from '../../dist/pi/src/index.js';
import { validateIntentOutputSchema } from '../../dist/protocol/src/index.js';
import { confirmedProfile, taskPolicy, tasks } from '../runtime/config.mjs';
import { taskDefinition } from '../runtime/task.mjs';
import { work, save } from '../runtime/work.mjs';

test('every prepared demo profile satisfies the current setup contract', () => {
  for (const taskId of Object.keys(tasks)) {
    const task = taskDefinition(taskId);
    const profile = confirmedProfile('2026-09-28T00:00:00.000Z', task.fixtures.length, taskId);
    const output = {
      taskProfile: profile, policy: taskPolicy(taskId),
      incumbent: { targetId: task.targetId, candidateId: 'incumbent', modelId: task.models[0].id, reasons: ['Prepared incumbent'] },
      observability: {
        targetId: task.targetId, status: 'ready', checkedAt: profile.confirmedAt,
        requiredMetricIds: profile.objectives.map(o => o.metricId),
        coveredMetricIds: profile.objectives.map(o => o.metricId), missingMetricIds: [],
      },
    };
    assert.deepEqual(validateIntentOutputSchema('establish_evals', output), [], taskId);
    assert.equal(output.policy.evaluationBudget.maximumCandidateCount, task.models.length);
  }
});

test('prepared evidence completes setup, comparison, approval and verification through the current core', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openmerit-demo-lifecycle-'));
  const previous = { DEMO_WORKSPACE: process.env.DEMO_WORKSPACE, DEMO_PROXY_TOKEN: process.env.DEMO_PROXY_TOKEN };
  process.env.DEMO_WORKSPACE = root;
  process.env.DEMO_PROXY_TOKEN = 'test-only';
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const task = taskDefinition('support');
  const cases = [task.smoke, ...task.fixtures, ...task.verification];
  let inferenceCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (!options.body) return Response.json({ data: task.models.map(model => ({
      id: model.id, pricing: { prompt: '0.0000001', completion: '0.0000001' }, supported_parameters: ['response_format'],
    })) });
    inferenceCalls++;
    const body = JSON.parse(options.body);
    const fixture = cases.find(f => f.email === body.messages[1].content);
    assert.ok(fixture, 'only prepared inputs reach the mocked provider');
    const cost = body.model === task.models[0].id ? .0004 : .0001;
    return Response.json({ choices: [{ message: { content: JSON.stringify(fixture.expected) } }], usage: { cost, prompt_tokens: 20, completion_tokens: 10 } });
  });
  const store = new ProjectStore(root);
  const coordinator = new OpenMeritCoordinator(store, {
    descriptor: PI_HARNESS_DESCRIPTOR,
    async dispatch(intent) { return { accepted: true, harnessJobId: `test-${intent.id}` }; },
  });
  await save('authorization.json', { confirmedAt: new Date().toISOString() });
  await save('application-config.json', { model: task.models[0].id });
  async function complete(kind, phase = kind) {
    const { intent } = await coordinator.issue(kind);
    const result = await work(phase);
    await coordinator.acceptResult({
      protocolVersion: '0.1', intentId: intent.id, status: 'succeeded', completedAt: new Date().toISOString(),
      summary: 'Measured prepared operation with a mocked provider.', ...result,
    });
    return result;
  }
  async function report(phase) {
    const { signal } = await work(phase);
    const { signalId, ...fields } = signal;
    return coordinator.recordAutomationSignal({ protocolVersion: '0.1', id: signalId, occurredAt: new Date().toISOString(), ...fields });
  }
  await complete('establish_evals', 'setup');
  assert.equal((await store.readState()).cycle.activeCandidateId, 'incumbent');
  await report('baseline');
  if ((await store.readState()).cycle.stage === 'collecting_baseline') await coordinator.assessBaseline();
  assert.equal((await store.readState()).cycle.stage, 'baseline_ready');
  await complete('discover_candidates');
  assert.equal((await store.readState()).candidates.length, task.models.length);
  const trials = await complete('run_challenger_trials');
  const state = await store.readState();
  assert.equal(state.assessments.length, task.models.length);
  assert.equal(state.assessments[0].candidateId, 'incumbent');
  const totalCost = trials.outputs.assessments.reduce((total, assessment) => total + assessment.metrics.find(m => m.metricId === 'total_task_cost').value, 0);
  assert.equal(state.automation.evaluationSpend, totalCost);
  const manifest = JSON.parse(await readFile(new URL(state.experimentManifest.uri), 'utf8'));
  assert.equal(manifest.baselineReused, true);
  assert.equal(manifest.randomized, false);
  assert.deepEqual(manifest.modelOrder, task.models.map(m => m.id));
  await complete('calculate_frontier');
  const proposed = await store.readState();
  assert.ok(proposed.cycle.proposedCandidateId);
  await save('approval.json', { candidateId: proposed.cycle.proposedCandidateId, at: new Date().toISOString() });
  await store.writeState({ ...proposed, cycle: { ...proposed.cycle, stage: 'swap_approved' } });
  await complete('apply_model_swap');
  await report('verification_window');
  await complete('verify_model_swap');
  assert.equal((await store.readState()).cycle.stage, 'swap_verified');
  assert.equal(inferenceCalls, 1 + task.fixtures.length * task.models.length + task.verification.length);
});
