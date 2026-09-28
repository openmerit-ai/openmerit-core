import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { task, fixtures, verification, smoke, grade, models, targetId, rubric } from './task.mjs';
import { taskPolicy, confirmedProfile, providerModels, applicationConfig } from './config.mjs';
import { classify } from './application.mjs';
import { calculateComparison } from './comparison.mjs';

export const root = () => process.env.DEMO_WORKSPACE ?? process.cwd();
export async function json(path, fallback = undefined) {
  try { return JSON.parse(await readFile(join(root(), path), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function save(path, data) {
  await mkdir(join(root(), 'evidence'), { recursive: true });
  await writeFile(join(root(), path), JSON.stringify(data, null, 2), { mode: 0o600 });
}
export async function event(message, data = {}) {
  await mkdir(join(root(), 'evidence'), { recursive: true });
  await appendFile(join(root(), 'evidence/progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), message, ...data }) + '\n');
}
export async function evidence(name, value) {
  const path = `evidence/${name}.json`;
  await save(path, value);
  return { id: name, source: 'evaluation_artifact', uri: `file://${join(root(), path)}`, mediaType: 'application/json',
    digest: createHash('sha256').update(JSON.stringify(value, null, 2)).digest('hex') };
}
const idFor = model => models.findIndex(m => m.id === model) === 0 ? 'incumbent' : `candidate-${models.findIndex(m => m.id === model)}`;
const candidateFor = model => ({ targetId, candidateId: idFor(model.id), modelId: model.id,
  reasons: [model === models[0] ? 'Configured incumbent application model or route, measured on the baseline suite.'
    : task.workflow ? `Prepared application route: ${model.steps.map(s=>s.task+' = '+s.model).join('; ')}. Constituent provider models checked against the catalogue. Performance is evaluated on the whole goal.`
    : 'Operator-prepared shortlist for this demo; refreshed catalogue availability and pricing, with measured task performance still to be established.'] });
export async function runBatch(model, cases, name, profile) {
  const existing = await json(`evidence/${name}.json`);
  if (existing) return existing;
  const runs = [], startedAt = new Date().toISOString();
  // Equal concurrency, rubric and inputs; task-specific API encodings are prepared.
  const concurrency=task.batchConcurrency ?? 3;
  for (let i = 0; i < cases.length; i += concurrency) {
    const group = await Promise.all(cases.slice(i, i + concurrency).map(async fixture => {
      const input = fixture.input ?? fixture.email;
      const result = await classify(input, model);
      return { fixtureId: fixture.id, input, expected: fixture.expected, ...result, passed: grade(result.output, fixture.expected) && Object.values(result.checks ?? {}).every(v=>v===1) };
    }));
    runs.push(...group);
    await event(`Measured ${runs.length}/${cases.length} ${task.inputPlural} with ${model}.`, { phase: name, completed: runs.length, total: cases.length });
  }
  const completedAt = new Date().toISOString();
  const ref = await evidence(`${name}-runs`, { runs, startedAt, completedAt });
  const toolRef=task.workflow?{...await evidence(`${name}-agent-trace`,{runs:runs.map(r=>({fixtureId:r.fixtureId,model:r.model,calls:r.calls,trace:r.trace,checks:r.checks}))}),source:'harness_trace'}:null;
  const values = {
    task_success: runs.filter(r => r.passed).length / runs.length,
    total_task_cost: runs.reduce((n, r) => n + r.cost, 0),
    end_to_end_task_latency: runs.reduce((n, r) => n + r.latencyMs, 0) / runs.length,
    ...Object.fromEntries(['tool_use_performance','structured_output_reliability','instruction_following','retrieval_use_quality'].map(id=>[id,runs.reduce((n,r)=>n+(r.checks?.[id] ?? 0),0)/runs.length])),
  };
  const metrics = profile.objectives.map(o => ({
    targetId, metricId: o.metricId, state: 'measured', scope: 'sample_window', method: 'derived',
    aggregation: o.metricId === 'total_task_cost' ? 'sum' : o.samplingPlan.aggregation,
    direction: ['total_task_cost','end_to_end_task_latency'].includes(o.metricId) ? 'minimize' : 'maximize', value: values[o.metricId],
    unit: o.metricId === 'total_task_cost' ? 'usd' : o.metricId === 'end_to_end_task_latency' ? 'milliseconds' : 'ratio',
    sampleCount: runs.length, evidence: o.metricId==='tool_use_performance'?[toolRef]:[ref], window: { startedAt, endedAt: completedAt },
    note: 'Observed point value on a fixed synthetic fixture suite; not an estimate of production reliability.',
  }));
  const assessment = { id: name, targetId, taskProfileId: profile.id, taskProfileRevision: profile.revision,
    candidateId: idFor(model), modelId: model, productRevision: process.env.DEMO_BUILD ?? 'local-development',
    harnessId: 'pi', startedAt, completedAt, metrics };
  const result = { assessment, runs, evidence: ref };
  await save(`evidence/${name}.json`, result);
  return result;
}

const inFlight = new Map();
export async function work(phase) {
  if (inFlight.has(phase)) return inFlight.get(phase);
  const operation = performWork(phase);
  inFlight.set(phase, operation);
  try { return await operation; } finally { inFlight.delete(phase); }
}
async function performWork(phase) {
  const authorization = await json('authorization.json');
  if (!authorization?.confirmedAt) throw new Error('The visitor must confirm the demo policy first.');
  const profile = confirmedProfile(authorization.confirmedAt, fixtures.length, task.id);
  const policy = taskPolicy(task.id);
  const state = await json('.openmerit/state.json');
  const expected = phase === 'setup' ? 'establish_evals' : phase;
  const windowPhase = phase === 'baseline' || phase === 'verification_window';
  if (!windowPhase && state?.activeIntent?.kind !== expected) throw new Error(`No authorized ${expected} intent is active.`);
  if (phase === 'baseline' && (state?.cycle.stage !== 'collecting_baseline' || state.activeIntent)) throw new Error('Baseline collection is not due.');
  if (phase === 'verification_window' && (state?.cycle.stage !== 'swap_applied' || state.activeIntent)) throw new Error('A swap verification window is not due.');
  const cached = await json(`evidence/result-${phase}.json`);
  if (cached) return cached;
  let outputs, refs = [], signal;
  if (phase === 'setup') {
    const result = await classify(smoke.input ?? smoke.email, models[0].id);
    const ref = await evidence('setup-smoke', { ...result, expected: smoke.expected, passed: grade(result.output, smoke.expected), includedInBaseline: false });
    outputs = { taskProfile: profile, incumbent: candidateFor(models[0]), policy, preliminaryModelLeads: [], observability: {
      targetId, status: 'ready', requiredMetricIds: profile.objectives.map(o => o.metricId),
      coveredMetricIds: profile.objectives.map(o => o.metricId), missingMetricIds: [], checkedAt: new Date().toISOString(),
    } };
    refs = [ref];
  } else if (phase === 'baseline') {
    const result = await runBatch(models[0].id, fixtures, 'baseline', profile);
    signal = { signalId: 'demo-baseline-window', type: 'metric_window_available', targetId, metrics: result.assessment.metrics };
    refs = [result.evidence];
  } else if (phase === 'discover_candidates') {
    const catalogUrl = task.id === 'spam' ? 'https://openrouter.ai/api/v1/models?output_modalities=decisions' : 'https://openrouter.ai/api/v1/models';
    const response = await fetch(process.env.DEMO_MODELS_URL ?? catalogUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not refresh the model catalogue.');
    const catalog = await response.json();
    const selected = providerModels({...task,models:models.slice(1)}).map(id => catalog.data.find(x => x.id === id));
    if (selected.some(m => !m || (task.id === 'spam' ? !m.architecture?.output_modalities?.includes('decisions') || !Number.isFinite(Number(m.pricing?.prompt)) || Number(m.pricing.prompt) < 0 || Number(m.pricing.prompt) > .05/1e6 || Number(m.pricing.completion) !== 0 : task.modelRequirements ? task.modelRequirements[m.id].parameters.some(p=>!m.supported_parameters?.includes(p)) || task.modelRequirements[m.id].modalities.some(p=>!m.architecture?.input_modalities?.includes(p)) : !m.supported_parameters?.includes(task.structuredOutputs?'structured_outputs':'response_format')))) throw new Error('A prepared candidate is no longer available within this task’s API and price limits.');
    refs = [await evidence('candidate-catalog', { checkedAt: new Date().toISOString(), source: catalogUrl, models: selected.map(m => ({ id: m.id, pricing: m.pricing, supported_parameters: m.supported_parameters, architecture:m.architecture })) })];
    outputs = { targetId, candidates: models.map(candidateFor) };
  } else if (phase === 'run_challenger_trials') {
    const baseline = await json('evidence/baseline.json');
    if (!baseline) throw new Error('The measured incumbent baseline is missing.');
    const results = [baseline];
    for (let i = 1; i < models.length; i++) results.push(await runBatch(models[i].id, fixtures, `trial-${i}`, profile));
    const manifest = await evidence('experiment-manifest', {
      targetId, productRevision: baseline.assessment.productRevision, profile, fixtures, rubric,
      routes: models.map(model => applicationConfig(task, model.id)),
      modelOrder: models.map(model => model.id), randomized: false, baselineReused: true,
      batchConcurrency: task.batchConcurrency ?? 3,
      assessments: results.map(result => ({ id: result.assessment.id, evidence: result.evidence })),
    });
    outputs = { targetId, assessments: results.map(r => r.assessment), experimentManifest: manifest };
    refs = [manifest, ...results.map(r => r.evidence)];
  } else if (phase === 'calculate_frontier') {
    const results = await Promise.all(models.map((_,i) => json(`evidence/${i === 0 ? 'baseline' : `trial-${i}`}.json`)));
    if (results.some(r => !r)) throw new Error('Comparable runs are incomplete.');
    const ref = await evidence('calculation-input', { profile, assessments: results.map(r => r.assessment), method: 'demo/runtime/comparison.mjs; observed point values only', preference: 'Lowest cost eligible frontier candidate cheaper than incumbent.' });
    outputs = calculateComparison(profile, results.map(r => r.assessment), ref, 'incumbent');
    await save('evidence/comparison.json', outputs);
    refs = [ref];
  } else if (phase === 'apply_model_swap') {
    const comparison = await json('evidence/comparison.json');
    const candidate = comparison?.assessments.find(a => a.candidateId === state.cycle.proposedCandidateId);
    const approved = await json('approval.json');
    if (!approved || approved.candidateId !== candidate?.candidateId) throw new Error('The visitor has not approved this exact proposal.');
    const before = await json('application-config.json');
    await save('application-config.json', applicationConfig(task,candidate.modelId));
    refs = [await evidence('configuration-diff', { before, after: await json('application-config.json'), approvedAt: approved.at, candidateId: candidate.candidateId })];
    outputs = { targetId, appliedCandidateId: candidate.candidateId, previousCandidateId: 'incumbent' };
  } else if (phase === 'verification_window') {
    const config = await json('application-config.json');
    const result = await runBatch(config.model, verification, 'verification', profile);
    signal = { signalId: 'demo-verification-window', type: 'verification_window_completed', targetId, metrics: result.assessment.metrics };
    refs = [result.evidence];
  } else if (phase === 'verify_model_swap') {
    const result = await json('evidence/verification.json');
    if (!result) throw new Error('No post-swap verification window exists.');
    const meets = result.assessment.metrics.every(m => {
      const c = profile.objectives.find(o => o.metricId === m.metricId).constraint;
      const cap=task.workflow && m.metricId==='total_task_cost'?task.maximumCostPerGoal*result.runs.length:c?.value;
      return !c || (c.operator === 'at_least' ? m.value >= c.value : m.value <= cap);
    });
    outputs = { targetId, verified: meets, regressionDetected: !meets }; refs = [result.evidence];
  } else if (phase === 'rollback_model_swap') {
    const before = await json('application-config.json');
    await save('application-config.json', applicationConfig(task,models[0].id));
    refs = [await evidence('rollback', { before, after: await json('application-config.json') })];
    outputs = { targetId, restoredCandidateId: 'incumbent' };
  } else throw new Error('Unsupported prepared operation.');
  const result = { ...(outputs ? { outputs } : {}), evidence: refs, ...(signal ? { signal } : {}) };
  await save(`evidence/result-${phase}.json`, result);
  return result;
}
