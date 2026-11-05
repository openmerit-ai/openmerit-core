import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkLeaderboard, modelRecord, searchModels, type Catalogue, type ModelRecord } from '../agent/catalogue.ts';
import { finalize, type Measurement, type Submission } from '../agent/recommendation.ts';
import { handleAgent, parseTurn, type AgentNamespace } from '../agent/routes.ts';
import { scoutTools, type Answer, type PlanState, type ToolHost } from '../agent/tools.ts';
import { turnText, type AgentState, type Channel, type TurnRequest } from '../agent/turn.ts';
import { handleMCP } from '../mcp.mjs';

const route = (provider: string, inputPrice: number, outputPrice: number, extra: Record<string, unknown> = {}) =>
  ({ id: `${provider}:m`, provider, modelId: 'm', inputPrice, outputPrice, modalities: ['text'], outputModalities: ['text'], parameters: ['tools'], ...extra });
const model = (id: string, extra: Record<string, unknown>, release: { date?: string | null; openWeights?: boolean | null } = {}) => {
  const m = modelRecord({ id, name: id.toUpperCase(), provider: id.split('/')[0], endpoints: [route('Gateway', 1, 2)], evidence: [], ...extra }, release);
  assert.ok(m); return m;
};
const models: ModelRecord[] = [
  // Two routes: the cheaper one lacks image input, so an image constraint must price the other.
  model('lab/alpha', { endpoints: [route('Cheap', 1, 4), route('Vision', 3, 10, { modalities: ['text', 'image'] })], speed: { tokensPerSecond: 100, timeToFirstAnswer: 2 }, evidence: [{ benchmark: 'b1', score: 0.9 }, { benchmark: 'b1', score: 0.7 }] }, { date: '2026-09-01', openWeights: false }),
  model('lab/beta', { endpoints: [route('Gateway', 0.5, 1, { modalities: ['text', 'pdf'] })], speed: { tokensPerSecond: 50, timeToFirstToken: 1 }, evidence: [{ benchmark: 'b1', score: 0.8 }] }, { date: '2026-10-01', openWeights: true }),
  model('lab/gamma', { evidence: [{ benchmark: 'b2', score: 70 }] }, { openWeights: true }),
  model('lab/delta', { evidence: [{ benchmark: 'b1', score: 0.95 }] }, { date: '2025-01-01' }),
  model('lab/epsilon', {}), model('lab/zeta', {}),
];
const catalogue: Catalogue = {
  version: 'test', models,
  benchmarks: [{ id: 'b1', name: 'Bench One', tags: [], source: 't', description: '', releaseDate: null, models: 3 }, { id: 'b2', name: 'Bench Two', tags: [], source: 't', description: '', releaseDate: null, models: 1 }],
  boards: [],
  semanticBenchmarks: async () => ['b1'],
  search: { bm25: async () => [], embedding: async () => [] },
};
// Bench Two measures tool calling, the evidence an agent's call needs to reach the bar.
const toolCatalogue: Catalogue = { ...catalogue, benchmarks: catalogue.benchmarks.map(b => b.id === 'b2' ? { ...b, tags: ['tools'] } : b) };
const brief = { input: { text: 'Invoices', source: 'stated' as const }, work: { text: 'Extract', source: 'stated' as const }, output: { text: 'JSON', source: 'stated' as const }, criteria: { text: '', source: 'missing' as const }, constraints: { text: '', source: 'missing' as const } };
const pick = (modelId: string, quality: number, evidence: string[] = []) => ({ modelId, quality, evidence, rationale: 'why' });
const evaluation: Submission['evaluation'] = { checks: [{ level: 'task', metric: 'fields correct', how: 'Compare with labelled invoices.' }], samples: 30, stopEarly: 'Stop after 10 if it trails the leader by 20 points.' };
const submission = (candidates: Submission['candidates'], filters?: Submission['filters']): Submission =>
  ({ task: 1, workload: { inputTokens: 2000, outputTokens: 500 }, summary: 's', qualityBar: 50, candidates, evaluation, ...(filters ? { filters } : {}) });
const now = Date.parse('2026-10-27T00:00:00Z');

test('a shortlist is priced on the cheapest route that meets the constraints, with timing and age from catalogue data', () => {
  // Only alpha has an image route, so one model is a complete shortlist here.
  const result = finalize(catalogue, submission([pick('lab/alpha', 90, ['b1'])], { inputs: ['image'] }), now);
  const [alpha] = result.models;
  assert.ok(alpha);
  // Vision route: (2000 × $3 + 500 × $10) / 1M tokens × 1,000 tasks = $11.
  assert.deepEqual(alpha.cost, { usdPer1kTasks: 11, route: 'Vision', endpointId: 'Vision:m', providerModelId: 'm', inputPerMillion: 3, outputPerMillion: 10, unpriced: [],
    rates: [{ unit: 'USD per 1M tokens', kind: 'input', amount: 3 }, { unit: 'USD per 1M tokens', kind: 'output', amount: 10 }] });
  // First answer token after 2 s, then 500 tokens at 100 tokens per second.
  assert.deepEqual(alpha.latency, { seconds: 7, firstTokenSeconds: 2, tokensPerSecond: 100, source: null });
  assert.deepEqual(alpha.recency, { released: '2026-09-01', ageDays: 56 });
  // Its best b1 result (0.9) ranks behind delta's 0.95 among all measured models.
  assert.deepEqual(alpha.quality.evidence, [{ benchmark: 'b1', name: 'Bench One', score: 0.9, rank: 2, of: 3 }]);
});

test('rejected shortlists explain every problem so the agent can correct them', () => {
  assert.throws(() => finalize(catalogue, submission([pick('lab/alpha', 90, ['b2']), pick('lab/missing', 50), pick('lab/gamma', 60), pick('lab/gamma', 60)], { openWeights: true }), now), (error: Error) => {
    assert.match(error.message, /lab\/missing is not in the catalogue/);
    assert.match(error.message, /lab\/alpha breaks the hard constraints: its weights are not open/);
    assert.match(error.message, /lab\/alpha has no results on b2/);
    assert.match(error.message, /lab\/gamma is listed twice/);
    return true;
  });
  // Six models are eligible without constraints, so two assessed candidates are too few.
  assert.throws(() => finalize(catalogue, submission([pick('lab/alpha', 90), pick('lab/beta', 80)]), now), /Assess at least five candidates; 2 submitted, and 6 models meet the constraints/);
});

test('axis leaders come from known values only', () => {
  const result = finalize(catalogue, submission(['lab/alpha', 'lab/beta', 'lab/gamma', 'lab/delta', 'lab/epsilon'].map((id, i) => pick(id, i === 1 ? 95 : 70))), now);
  const best = Object.fromEntries(result.models.map(m => [m.id, m.best]));
  // Beta: highest quality estimate, cheapest ($1.50 per 1k tasks vs alpha's $4 and $3 on the other routes), newest release.
  assert.deepEqual(best['lab/beta'], ['quality', 'cost', 'recency']);
  // Alpha is faster (2 + 500/100 = 7 s against beta's 11 s), but speed never ranks or leads.
  assert.deepEqual(best['lab/alpha'], []);
  assert.deepEqual(best['lab/gamma'], []);
});

test('by default the five cheapest candidates that reach the quality bar are shown, cheapest first', () => {
  // Per 1k tasks: beta $1.50, the Gateway routes (gamma, delta, epsilon, zeta) $3, alpha $4.
  const all = ['lab/epsilon', 'lab/alpha', 'lab/delta', 'lab/beta', 'lab/gamma', 'lab/zeta'];
  const shown = (quality: (id: string) => number, priority?: Submission['priority']) =>
    finalize(catalogue, { ...submission(all.map(id => pick(id, quality(id)))), qualityBar: 70, ...(priority ? { priority } : {}) }, now).models.map(m => [m.rank, m.id]);
  // Six reach the bar: the costliest (alpha) is left out even though it scores highest; equal costs keep the agent's order.
  assert.deepEqual(shown(id => id === 'lab/alpha' ? 95 : 80), [[1, 'lab/beta'], [2, 'lab/epsilon'], [3, 'lab/delta'], [4, 'lab/gamma'], [5, 'lab/zeta']]);
  // Beta is cheapest but below the bar, so it is never shown and alpha fills the fifth place.
  assert.deepEqual(shown(id => id === 'lab/beta' ? 60 : 80), [[1, 'lab/epsilon'], [2, 'lab/delta'], [3, 'lab/gamma'], [4, 'lab/zeta'], [5, 'lab/alpha']]);
  // An explicit quality priority shows the five highest estimates instead.
  assert.deepEqual(shown(id => ({ 'lab/alpha': 95, 'lab/zeta': 90, 'lab/beta': 75 })[id] ?? 80, 'quality').map(([, id]) => id), ['lab/alpha', 'lab/zeta', 'lab/epsilon', 'lab/delta', 'lab/gamma']);
});

test('fewer than five may reach the bar, so the bar never drops to fill the shortlist', () => {
  const all = ['lab/epsilon', 'lab/alpha', 'lab/delta', 'lab/beta', 'lab/gamma'];
  // Five assessed, two at the bar of 70: only those two are shown, cheapest first.
  const result = finalize(catalogue, { ...submission(all.map(id => pick(id, ['lab/alpha', 'lab/beta'].includes(id) ? 85 : 60))), qualityBar: 70 }, now);
  assert.deepEqual(result.models.map(m => [m.rank, m.id]), [[1, 'lab/beta'], [2, 'lab/alpha']]);
  assert.throws(() => finalize(catalogue, { ...submission(all.map(id => pick(id, 60))), qualityBar: 70 }, now), /No candidate reaches the quality bar of 70/);
});

test('for an agent\'s call, only tool-calling evidence or a measured result puts a candidate over the bar', () => {
  const measured = { id: 'm1', level: 'agent' as const, kind: 'quality' as const, task: 'Extract', scope: 'extraction agent', model: 'lab/delta', metric: 'claims correct', value: 0.9, higherIsBetter: true, samples: 30, source: 'Langfuse' };
  const agentCall = { task: { ...task('Extract'), agent: 'Extraction agent' }, measurements: [measured] };
  const shortlist = (alphaQuality: number) => submission([pick('lab/alpha', alphaQuality, ['b1']), pick('lab/gamma', 80, ['b2']), pick('lab/delta', 80, ['measured:m1']), pick('lab/beta', 30, ['b1']), pick('lab/epsilon', 30)]);
  // Alpha leads Bench One, a domain benchmark, but that alone cannot qualify it for a call that uses tools.
  assert.throws(() => finalize(toolCatalogue, shortlist(90), now, {}, agentCall), (error: Error) => {
    assert.match(error.message, /lab\/alpha reaches the quality bar for an agent's call without evidence of tool calling/);
    assert.doesNotMatch(error.message, /lab\/(gamma|delta|beta|epsilon) reaches/);
    return true;
  });
  // Delta's measured result ranks it ahead of gamma's benchmark estimate.
  assert.deepEqual(finalize(toolCatalogue, shortlist(40), now, {}, agentCall).models.map(m => m.id), ['lab/delta', 'lab/gamma']);
  // A standalone call is not held to it.
  assert.equal(finalize(toolCatalogue, shortlist(90), now, {}, { task: task('Extract'), measurements: [measured] }).models.length, 3);
});

test('model search applies constraints, treats PDF as a document input and ranks by benchmark among measured models', () => {
  assert.deepEqual(searchModels(catalogue, { filters: { inputs: ['file'] } }).models.map(m => m.id), ['lab/beta']);
  assert.deepEqual(searchModels(catalogue, { benchmark: 'b1', filters: { openWeights: true } }).models.map(m => [m.id, m.benchmark]), [['lab/beta', { score: 0.8, rank: 3, of: 3 }]]);
  assert.deepEqual(benchmarkLeaderboard(catalogue, 'b1').results.map(r => r.model), ['lab/delta', 'lab/alpha', 'lab/beta']);
});

// An in-memory conversation for the tools: what the Durable Object stores.
function toolHost(options: { maxTasks?: number | null; endpointIds?: string[]; blocked?: () => string | null } = {}) {
  const answers: Answer[] = [];
  let plan: PlanState | null = null;
  const host: ToolHost = {
    catalogue: async () => catalogue, now: () => now,
    scope: async () => options.endpointIds ? { endpointIds: options.endpointIds } : {},
    maxTasks: async () => options.maxTasks === undefined ? 3 : options.maxTasks,
    clarificationBlocked: async () => options.blocked?.() ?? null,
    plan: async () => plan && structuredClone(plan), savePlan: async p => { plan = structuredClone(p); },
    measurements: async () => [],
    answer: async a => { answers.push(a); }, progress: () => {},
  };
  const tools = scoutTools(host);
  const call = async (name: string, args: unknown) => {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool);
    return tool.execute(args as never, {} as never, {} as never);
  };
  return { answers, call };
}
const task = (title: string) => ({ title, work: `${title} work`, input: 'text', output: 'text' });
const five = ['lab/alpha', 'lab/beta', 'lab/gamma', 'lab/delta', 'lab/epsilon'].map(id => pick(id, 70));

test('the web page splits work into at most three tasks; coding agents have no limit', async () => {
  const tasks = ['Transcribe', 'Extract', 'Classify', 'Draft'].map(task);
  const web = toolHost({ maxTasks: 3 });
  const refused = await web.call('plan_tasks', { brief, assumptions: [], tasks });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.output), /at most 3 tasks/);
  assert.equal((await web.call('submit_recommendation', submission(five))).isError, true, 'a refused plan records nothing to submit against');
  const agent = toolHost({ maxTasks: null });
  assert.equal((await agent.call('plan_tasks', { brief, assumptions: [], tasks })).isError, undefined);
  assert.equal((await agent.call('plan_tasks', { brief, assumptions: [], tasks: [task('Extract'), task('extract')] })).isError, true, 'task titles must differ');
});

test('the user\'s measured results outrank benchmarks: a measured candidate must cite them, and agent runs are priced', () => {
  const measured = (id: string, model: string, value: number, task: string | null = 'Extract') =>
    ({ id, level: 'agent' as const, kind: 'quality' as const, task, scope: 'extraction agent', model, metric: 'fields correct', value, higherIsBetter: true, samples: 40, source: 'Langfuse experiment invoices-1' });
  // Alpha's result is reported by one of its endpoint IDs, beta's by its model ID; m3 is for another task.
  const measurements = [measured('m1', 'lab/beta', 0.97), measured('m2', 'Vision:m', 0.81), measured('m3', 'lab/gamma', 0.5, 'Summarize')];
  const context = { task: { ...task('Extract'), agent: 'Extraction agent', callsPerRun: 4 }, measurements };
  const candidates = (cite: (id: string) => string[], quality = (_id: string) => 70) => ['lab/alpha', 'lab/beta', 'lab/gamma', 'lab/delta', 'lab/epsilon'].map(id => pick(id, quality(id), cite(id)));
  assert.throws(() => finalize(catalogue, submission(candidates(() => [])), now, {}, context), (error: Error) => {
    assert.match(error.message, /The user measured lab\/alpha on this task \(measured:m2\)/);
    assert.match(error.message, /The user measured lab\/beta on this task \(measured:m1\)/);
    // Gamma's result is for another task, so it need not cite it.
    assert.doesNotMatch(error.message, /lab\/gamma on this task/);
    return true;
  });
  // A model cannot cite another model's result.
  assert.throws(() => finalize(catalogue, submission(candidates(id => id === 'lab/alpha' ? ['measured:m2', 'measured:m1'] : id === 'lab/beta' ? ['measured:m1'] : [])), now, {}, context), /lab\/alpha has no results on measured:m1/);
  // Gamma reaches the bar of this agent's call on a tool-calling benchmark; delta and epsilon have no evidence and stay below it.
  const result = finalize(toolCatalogue, submission(candidates(id => ({ 'lab/alpha': ['measured:m2', 'b1'], 'lab/beta': ['measured:m1'], 'lab/gamma': ['b2'] })[id] ?? [], id => ['lab/delta', 'lab/epsilon'].includes(id) ? 40 : 70)), now, {}, context);
  const byId = Object.fromEntries(result.models.map(m => [m.id, m]));
  assert.deepEqual(byId['lab/beta']?.quality, { score: 70, measured: true, evidence: [{ benchmark: 'measured:m1', name: 'Your eval: fields correct (agent level, 40 samples, Langfuse experiment invoices-1)', score: 0.97, rank: 1, of: 2 }] });
  assert.equal(byId['lab/alpha']?.quality.evidence[0]?.rank, 2);
  assert.equal(byId['lab/gamma']?.quality.measured, false);
  // Measured models lead even though gamma ($1/$2 Gateway, $3 per 1k) is cheaper than alpha ($4 on Cheap): cheapest first within each group.
  assert.deepEqual(result.models.map(m => m.id), ['lab/beta', 'lab/alpha', 'lab/gamma']);
  // Beta's Gateway route: (2000 × $0.50 + 500 × $1) / 1M × 1,000 = $1.50 per 1k calls; four calls per agent run.
  assert.equal(byId['lab/beta']?.cost?.usdPer1kTasks, 1.5);
  assert.equal(byId['lab/beta']?.cost?.usdPer1kAgentRuns, 6);
  assert.deepEqual(result.evaluation, evaluation);
});

test('an environment miss does not drop a model whose own results match, and measured cost replaces the estimate', () => {
  const result = (id: string, model: string, value: number, extra: Partial<Measurement> = {}): Measurement =>
    ({ id, level: 'agent', kind: 'quality', task: 'Extract', scope: 'extraction agent swapped, others fixed', model, metric: 'fields correct', value, higherIsBetter: true, samples: 14, source: 'Langfuse', ...extra });
  const context = (measurements: Measurement[]) => ({ task: { ...task('Extract'), agent: 'Extraction agent', callsPerRun: 4 }, measurements });
  const shortlist = (alpha: number, alphaCites: string[]) => submission([pick('lab/beta', 70, ['measured:q1']), pick('lab/alpha', alpha, alphaCites), pick('lab/gamma', 70, ['b2']), pick('lab/delta', 40), pick('lab/epsilon', 40)]);
  // Alpha ties beta on its own agent checks; its 13/14 end-to-end result also measures the agents that were not swapped.
  const tied = [result('q1', 'lab/beta', 1), result('q2', 'lab/alpha', 1), result('e1', 'lab/alpha', 0.93, { level: 'environment', metric: 'claims correct' })];
  assert.throws(() => finalize(toolCatalogue, shortlist(40, ['measured:q2', 'measured:e1']), now, {}, context(tied)), /lab\/alpha is below the bar, but its task- and agent-level results on this task \(measured:q2\) match a candidate at or above it/);
  // When its own agent checks are worse, dropping it stands.
  const worse = [result('q1', 'lab/beta', 1), result('q2', 'lab/alpha', 0.9)];
  assert.deepEqual(finalize(toolCatalogue, shortlist(40, ['measured:q2']), now, {}, context(worse)).models.map(m => m.id), ['lab/beta', 'lab/gamma']);
  // Estimates put beta ($1.50 per 1k calls) ahead of alpha ($4); measured cost per agent run reverses it: alpha $0.005 (four calls, $1.25 per 1k calls), beta $0.02.
  const costs = [...tied.slice(0, 2), result('c1', 'lab/beta', 0.02, { kind: 'usd', metric: 'usd per run', higherIsBetter: false }), result('c2', 'lab/alpha', 0.005, { kind: 'usd', metric: 'usd per run', higherIsBetter: false })];
  const ranked = finalize(toolCatalogue, shortlist(70, ['measured:q2']), now, {}, context(costs));
  assert.deepEqual(ranked.models.map(m => m.id), ['lab/alpha', 'lab/beta', 'lab/gamma']);
  assert.deepEqual(ranked.models[0]?.cost?.measured, { usdPer1kTasks: 1.25, usdPer1kAgentRuns: 5, result: 'measured:c2' });
  // Measured over estimated per call: alpha $1.25 / $4 = 0.3125, beta $5 / $1.50 = 3.3333; the median of the two scales every estimate,
  // so unmeasured gamma's $3 becomes 3 × 1.822917 = $5.4688 per 1k calls and alpha's own estimate $7.2917.
  assert.deepEqual(ranked.models.map(m => m.cost?.usdPer1kTasks), [7.2917, 2.7344, 5.4688]);
  // Only the cheapest measured cost is labelled cheapest, not gamma's lower (calibrated) estimate.
  assert.deepEqual(ranked.models.map(m => m.best.includes('cost')), [true, false, false]);
  assert.deepEqual(ranked.models[2]?.cost?.calibration, { factor: 1.8229, results: ['measured:c1', 'measured:c2'] });
  // Under the quality priority, equal measured quality is broken by measured cost, not the agent's (benchmark) order; a higher estimate still leads.
  const byQuality = (alpha: number) => finalize(toolCatalogue, { ...shortlist(alpha, ['measured:q2']), priority: 'quality' }, now, {}, context(costs)).models.map(m => m.id);
  assert.deepEqual(byQuality(70), ['lab/alpha', 'lab/beta', 'lab/gamma']);
  assert.deepEqual(byQuality(60), ['lab/beta', 'lab/alpha', 'lab/gamma']);
});

test('measured results are validated, labelled for the model and passed to the conversation', () => {
  const id = '6cbb63c0-e848-4d65-9231-171c95756cf1';
  const result = { level: 'environment', scope: 'claims pipeline', model: 'lab/beta', metric: 'claims correct', value: 0.98, higherIsBetter: true, samples: 42, source: 'Langfuse dataset run' };
  assert.deepEqual(parseTurn({ conversationId: id, results: [result] }), { conversationId: id, turn: { skip: false, results: [{ ...result, kind: 'quality', task: null }] } });
  // A cost result keeps its kind and reads as a cost, never as quality.
  assert.deepEqual(parseTurn({ conversationId: id, results: [{ ...result, kind: 'usd', level: 'agent' }] }), { conversationId: id, turn: { skip: false, results: [{ ...result, kind: 'usd', level: 'agent', task: null }] } });
  for (const bad of [[], [{ ...result, value: Number.NaN }], [{ ...result, samples: 0 }], [{ ...result, level: 'org' }], [{ ...result, kind: 'tokens' }], [{ ...result, input: 'raw claim text' }], [{ ...result, source: '' }], Array(51).fill(result)])
    assert.match(String(parseTurn({ conversationId: id, results: bad })), /^results is a list/);
  assert.equal(turnText({}, [{ id: 'm1', task: 'Extract', ...result, kind: 'quality', level: 'task' }, { id: 'm2', task: 'Extract', ...result, kind: 'usd', metric: 'cost', value: 0.01, higherIsBetter: false, level: 'agent' }]),
    'I measured these results with my own evals (aggregates only). Use them as evidence ahead of public benchmarks, cite them as measured:<id>, and recommend again:\n- measured:m1 · lab/beta · task level, task "Extract" (claims pipeline) · claims correct = 0.98 (higher is better) · 42 samples · Langfuse dataset run\n- measured:m2 · lab/beta · agent level, cost in USD per agent run, task "Extract" (claims pipeline) · cost = 0.01 (lower is better) · 42 samples · Langfuse dataset run');
});

test('a turn ends only once every planned task has an accepted shortlist, answered in plan order', async () => {
  const { answers, call } = toolHost();
  await call('plan_tasks', { brief, assumptions: ['English only'], tasks: [task('Extract'), task('Summarize')] });
  // Task 2 first: accepted, but the turn continues and nothing reaches the user.
  const second = await call('submit_recommendation', { ...submission(five), task: 2, summary: 'second' });
  assert.equal(second.control, undefined);
  assert.match(JSON.stringify(second.output), /Still to submit:\\n1. Extract/);
  assert.equal((await call('submit_recommendation', { ...submission(five), task: 3 })).isError, true);
  // A rejected shortlist for task 1 leaves the turn open too.
  assert.equal((await call('submit_recommendation', submission([pick('lab/missing', 50)]))).isError, true);
  assert.equal(answers.length, 0);
  const first = await call('submit_recommendation', { ...submission(five), summary: 'first' });
  assert.deepEqual(first.control, { terminate: true });
  const [answer] = answers;
  assert.ok(answer?.kind === 'recommendation');
  assert.deepEqual(answer.tasks.map(t => [t.title, t.summary, t.models.length]), [['Extract', 'first', 5], ['Summarize', 'second', 5]]);
  assert.deepEqual(answer.assumptions, ['English only']);
});

test('the endpoint inventory limits every search and shortlist, whatever filters the model sends', async () => {
  // Only beta's route is in the inventory.
  const { answers, call } = toolHost({ endpointIds: ['Gateway:m'] });
  const found = await call('search_models', { filters: { providers: ['lab'] } });
  assert.deepEqual(JSON.parse((found.output?.[0] as { text: string }).text).models.map((m: { id: string }) => m.id), ['lab/beta', 'lab/gamma', 'lab/delta', 'lab/epsilon', 'lab/zeta']);
  await call('plan_tasks', { brief, assumptions: [], tasks: [task('Extract')] });
  const rejected = await call('submit_recommendation', submission([pick('lab/alpha', 90)]));
  assert.match(JSON.stringify(rejected.output), /lab\/alpha breaks the hard constraints: none of its routes is in the project's endpoint inventory/);
  // An empty inventory allows nothing, so an empty shortlist is the valid answer.
  const empty = toolHost({ endpointIds: [] });
  await empty.call('plan_tasks', { brief, assumptions: [], tasks: [task('Extract')] });
  assert.match(JSON.stringify((await empty.call('submit_recommendation', submission([pick('lab/beta', 80)]))).output), /not accepted/);
  assert.deepEqual((await empty.call('submit_recommendation', submission([]))).control, { terminate: true });
  assert.equal(answers.length, 0);
});

test('clarifying questions are refused once the user skips them', async () => {
  let blocked: string | null = 'The user skipped clarifying questions.';
  const { answers, call } = toolHost({ blocked: () => blocked });
  const args = { brief, questions: [{ component: 'criteria', question: 'What matters most?' }] };
  const refused = await call('ask_clarifying_questions', args);
  assert.equal(refused.isError, true);
  assert.equal(refused.control, undefined);
  assert.equal(answers.length, 0);
  blocked = null;
  const asked = await call('ask_clarifying_questions', args);
  assert.deepEqual(asked.control, { terminate: true });
  assert.equal(answers[0]?.kind, 'clarification');
});

test('turns are validated before reaching a conversation', () => {
  assert.equal(parseTurn({ skip: true }), 'Describe the work you want a model to do.');
  assert.equal(parseTurn({ message: 'x', extra: 1 }), 'Send conversationId, message, brief, skip, endpointIds, results or sync.');
  assert.match(String(parseTurn({ message: 'x', endpointIds: ['a', 'a'] })), /unique list/);
  assert.equal(parseTurn({ conversationId: 'not-a-uuid', skip: true }), 'Invalid conversationId.');
  assert.match(String(parseTurn({ message: 'x', brief: { budget: '$5' } })), /brief maps/);
  assert.match(String(parseTurn({ message: 'x', brief: { input: 7 } })), /brief maps/);
  const id = '6cbb63c0-e848-4d65-9231-171c95756cf1';
  assert.deepEqual(parseTurn({ conversationId: id, brief: { output: 'JSON' }, skip: true }), { conversationId: id, turn: { brief: { output: 'JSON' }, skip: true } });
  // Edits follow the brief's order, whatever order they arrive in, and a cleared component is reported as none.
  assert.equal(turnText({ brief: { constraints: ' ', input: 'Scanned PDFs ' }, skip: true }),
    'I edited your task brief. Treat these components as stated by me:\n- input: Scanned PDFs\n- constraints: none\n\nSkip the remaining clarifying questions. Recommend now, and list the assumptions you made.');
});

test('a client can name a new conversation, but continue only one that exists and is its own', async () => {
  const started = new Set<string>();
  const state = (name: string): AgentState => ({ busy: false, turns: started.has(name) ? 1 : 0, skipped: false, progress: [], answer: null });
  const namespace: AgentNamespace = { getByName: name => ({ state: async () => state(name), turn: async () => { started.add(name); return state(name); } }) };
  const post = (user: string, body: unknown) => handleAgent(new Request('https://openmerit.ai/scout/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), namespace, user);
  const id = '6cbb63c0-e848-4d65-9231-171c95756cf1';
  assert.equal((await post('alice', { conversationId: id, brief: { output: 'JSON' } })).status, 404);
  const first = await post('alice', { conversationId: id, message: 'Summarize tickets' });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { conversationId: string }).conversationId, id);
  assert.equal((await post('alice', { conversationId: id, skip: true })).status, 200);
  assert.equal((await post('bob', { conversationId: id, skip: true })).status, 404);
  assert.equal((await handleAgent(new Request(`https://openmerit.ai/scout/api/agent/${id}`), namespace, 'bob')).status, 404);
});

test('coding agents reach the same conversations through MCP, relaying questions and continuing them', async () => {
  const turns: Array<{ name: string; request: TurnRequest; channel: Channel | undefined }> = [];
  const clarification: AgentState = { busy: false, turns: 1, skipped: false, progress: ['Reading'], answer: { kind: 'clarification', brief, questions: [{ component: 'criteria', question: 'What matters most?' }] } };
  const namespace: AgentNamespace = { getByName: name => ({ state: async () => clarification, turn: async (request, channel) => { turns.push({ name, request, channel }); return clarification; } }) };
  const call = async (args: unknown) => {
    const response = await handleMCP(new Request('https://openmerit.ai/scout/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: args } }) }), namespace, 'alice');
    return (await response.json() as { result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } }).result;
  };
  const first = await call({ prompt: 'Summarize tickets', endpointIds: ['Gateway:m'] });
  assert.equal(first.structuredContent?.status, 'needs_answers');
  assert.deepEqual(first.structuredContent?.questions, [{ component: 'criteria', question: 'What matters most?' }]);
  const id = first.structuredContent?.conversationId as string;
  assert.deepEqual(turns[0], { name: `alice:${id}`, request: { skip: false, message: 'Summarize tickets', endpointIds: ['Gateway:m'] }, channel: 'agent' });
  await call({ conversationId: id, brief: { criteria: 'Accuracy first' } });
  assert.deepEqual(turns[1], { name: `alice:${id}`, request: { skip: false, brief: { criteria: 'Accuracy first' } }, channel: 'agent' });
  // The conversation ID alone reads the outcome without starting a turn.
  assert.equal((await call({ conversationId: id })).structuredContent?.status, 'needs_answers');
  assert.equal(turns.length, 2);
  // Measured results continue the same conversation as a turn.
  const result = { level: 'agent', task: 'Summarize', scope: 'summary agent', model: 'lab/beta', metric: 'summaries accepted', value: 0.9, higherIsBetter: true, samples: 30, source: 'own eval' };
  await call({ conversationId: id, results: [result] });
  assert.deepEqual(turns[2]?.request, { skip: false, results: [{ ...result, kind: 'quality' }] });
  const warned = await call({ conversationId: id, results: [{ ...result, scope: 'FICT-CLM-123' }] });
  assert.match(String(warned.structuredContent?.warnings), /record ID or email/);
  assert.match((await call({ conversationId: id, results: [{ ...result, output: 'raw text' }] })).content[0]?.text ?? '', /^results is a list/);
  assert.match((await call({ prompt: 'x'.repeat(4001) })).content[0]?.text ?? '', /^prompt must be text/);
});
