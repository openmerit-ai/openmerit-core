import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenMeritCoordinator, ProjectStore } from '../../dist/core/src/index.js';
import { DEMO_HARNESS_DESCRIPTOR } from '../runtime/descriptor.ts';
import installDemo from '../runtime/adapter.ts';
import { validateIntentOutputSchema } from '../../dist/protocol/src/index.js';
import { confirmedProfile, taskPolicy, tasks } from '../runtime/config.mjs';
import { taskDefinition } from '../runtime/task.mjs';
import { work, save } from '../runtime/work.mjs';

test('every prepared demo profile satisfies the current setup contract', () => {
  assert.equal(DEMO_HARNESS_DESCRIPTOR.version, '1.5.0');
  assert.equal(DEMO_HARNESS_DESCRIPTOR.automation.persistentScheduling, false);
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

test('prepared evidence completes setup, comparison, approval and verification through the Pi 1.5 demo transport and core', async t => {
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
  const tools = new Map(), commands = new Map(), messages = [];
  installDemo({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message, options) { messages.push({ message, options }); },
  });
  const command = args => commands.get('openmerit').handler(args, { cwd: root });
  // Pi 1.5 passes the execution context in the fifth position.
  const execute = (name, input) => tools.get(name).execute('call', input, undefined, undefined, { cwd: root });
  assert.deepEqual([...tools.keys()], ['openmerit_complete_intent', 'openmerit_report_signal']);
  await assert.rejects(command('setup'), /confirm the demo policy/);
  await save('authorization.json', { confirmedAt: new Date().toISOString() });
  await save('application-config.json', { model: task.models[0].id });
  async function complete(kind, phase = kind) {
    const { activeIntent: intent } = await store.readState();
    assert.equal(intent.kind, kind);
    const result = await work(phase);
    await assert.rejects(execute('openmerit_complete_intent', {
      intentId: intent.id, artifact: 'wrong-phase', summary: 'Wrong artifact.',
    }), /Artifact does not belong/);
    await execute('openmerit_complete_intent', {
      intentId: intent.id, artifact: phase, summary: 'Measured prepared operation with a mocked provider.',
    });
    return result;
  }
  async function report(phase) {
    await work(phase);
    return execute('openmerit_report_signal', { artifact: phase });
  }
  await command('setup');
  await assert.rejects(command('setup'), /active demo intent/);
  await complete('establish_evals', 'setup');
  assert.equal((await store.readState()).cycle.activeCandidateId, 'incumbent');
  await report('baseline');
  if ((await store.readState()).cycle.stage === 'collecting_baseline') await command('assess');
  assert.equal((await store.readState()).activeIntent.kind, 'discover_candidates');
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
  await assert.rejects(command('approve'), /approve this exact proposal/);
  await save('approval.json', { candidateId: 'wrong-candidate', at: new Date().toISOString() });
  await assert.rejects(command('approve'), /approve this exact proposal/);
  await save('approval.json', { candidateId: proposed.cycle.proposedCandidateId, at: new Date().toISOString() });
  await command('approve');
  await complete('apply_model_swap');
  await report('verification_window');
  await complete('verify_model_swap');
  assert.equal((await store.readState()).cycle.stage, 'swap_verified');
  assert.equal(inferenceCalls, 1 + task.fixtures.length * task.models.length + task.verification.length);
  // Setup, discovery, trials, frontier, apply, verify: no extra paid work.
  assert.equal(messages.length, 6);
  assert.ok(messages.every(({ options }) => options.triggerTurn && options.deliverAs === 'followUp'));
  await assert.rejects(execute('openmerit_complete_intent', {
    intentId: 'stale-intent', artifact: 'setup', summary: 'Stale completion.',
  }), /no longer active/);
  await assert.rejects(command('setup'), /already started/);
  await assert.rejects(command('pause'), /Prepared demo commands/);

  // A separately issued failing operation records a truthful terminal result,
  // without invoking the prepared helper, retrying inference, or dispatching.
  const core = new OpenMeritCoordinator(store, {
    descriptor: DEMO_HARNESS_DESCRIPTOR,
    async dispatch(intent) { return { accepted: true, harnessJobId: intent.id }; },
  });
  const { intent } = await core.issue('establish_evals');
  await execute('openmerit_complete_intent', {
    intentId: intent.id, status: 'failed', summary: 'Provider authentication failed.',
  });
  const failed = await store.readState();
  assert.equal(failed.lastResult.status, 'failed');
  assert.equal(failed.lastResult.error.retryable, false);
  assert.equal(failed.activeIntent, undefined);
  assert.equal(messages.length, 6);
  assert.equal(inferenceCalls, 1 + task.fixtures.length * task.models.length + task.verification.length);
});
