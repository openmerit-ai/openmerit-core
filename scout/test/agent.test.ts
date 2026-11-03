import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkLeaderboard, modelRecord, searchModels, type Catalogue, type ModelRecord } from '../agent/catalogue.ts';
import { finalize, type Submission } from '../agent/recommendation.ts';
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
const brief = { input: { text: 'Invoices', source: 'stated' as const }, work: { text: 'Extract', source: 'stated' as const }, output: { text: 'JSON', source: 'stated' as const }, criteria: { text: '', source: 'missing' as const }, constraints: { text: '', source: 'missing' as const } };
const pick = (modelId: string, quality: number, evidence: string[] = []) => ({ modelId, role: 'r', quality, evidence, rationale: 'why' });
const submission = (recommendations: Submission['recommendations'], filters?: Submission['filters']): Submission =>
  ({ task: 1, workload: { inputTokens: 2000, outputTokens: 500 }, summary: 's', recommendations, ...(filters ? { filters } : {}) });
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
  // Six models are eligible without constraints, so two are not a shortlist of five.
  assert.throws(() => finalize(catalogue, submission([pick('lab/alpha', 90), pick('lab/beta', 80)]), now), /Recommend five models: 6 models meet the constraints/);
});

test('axis leaders come from known values only', () => {
  const result = finalize(catalogue, submission(['lab/alpha', 'lab/beta', 'lab/gamma', 'lab/delta', 'lab/epsilon'].map((id, i) => pick(id, i === 1 ? 95 : 70))), now);
  const best = Object.fromEntries(result.models.map(m => [m.id, m.best]));
  // Beta: highest quality estimate, cheapest ($1.50 per 1k tasks vs alpha's $4 and $3 on the other routes), newest release.
  assert.deepEqual(best['lab/beta'], ['quality', 'cost', 'recency']);
  // Alpha: 2 + 500/100 = 7 s beats beta's 1 + 500/50 = 11 s; models without timing never lead.
  assert.deepEqual(best['lab/alpha'], ['latency']);
  assert.deepEqual(best['lab/gamma'], []);
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
  assert.equal(parseTurn({ message: 'x', extra: 1 }), 'Send conversationId, message, brief, skip or endpointIds.');
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
  assert.match((await call({ prompt: 'x'.repeat(4001) })).content[0]?.text ?? '', /^prompt must be text/);
});
