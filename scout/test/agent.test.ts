import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkLeaderboard, modelRecord, searchModels, type Catalogue, type ModelRecord } from '../agent/catalogue.ts';
import { finalize, type Submission } from '../agent/recommendation.ts';
import { handleAgent, parseTurn, type AgentNamespace } from '../agent/routes.ts';
import { scoutTools, type Answer } from '../agent/tools.ts';
import { turnText, type AgentState } from '../agent/turn.ts';

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
  semanticBenchmarks: async () => ['b1'],
};
const brief = { input: { text: 'Invoices', source: 'stated' as const }, work: { text: 'Extract', source: 'stated' as const }, output: { text: 'JSON', source: 'stated' as const }, criteria: { text: '', source: 'missing' as const }, constraints: { text: '', source: 'missing' as const } };
const pick = (modelId: string, quality: number, evidence: string[] = []) => ({ modelId, role: 'r', quality, evidence, rationale: 'why' });
const submission = (recommendations: Submission['recommendations'], filters?: Submission['filters']): Submission =>
  ({ brief, workload: { inputTokens: 2000, outputTokens: 500 }, summary: 's', assumptions: [], recommendations, ...(filters ? { filters } : {}) });
const now = Date.parse('2026-10-27T00:00:00Z');

test('a shortlist is priced on the cheapest route that meets the constraints, with timing and age from catalogue data', () => {
  // Only alpha has an image route, so one model is a complete shortlist here.
  const result = finalize(catalogue, submission([pick('lab/alpha', 90, ['b1'])], { inputs: ['image'] }), now);
  const [alpha] = result.models;
  assert.ok(alpha);
  // Vision route: (2000 × $3 + 500 × $10) / 1M tokens × 1,000 tasks = $11.
  assert.deepEqual(alpha.cost, { usdPer1kTasks: 11, inputPerMillion: 3, outputPerMillion: 10, route: 'Vision' });
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

test('clarifying questions are refused once the user skips them', async () => {
  const answers: Answer[] = [];
  let blocked: string | null = 'The user skipped clarifying questions.';
  const tools = scoutTools({ catalogue: async () => catalogue, now: () => now, clarificationBlocked: async () => blocked, answer: async a => { answers.push(a); }, progress: () => {} });
  const ask = tools.find(t => t.name === 'ask_clarifying_questions');
  assert.ok(ask);
  const args = { brief, questions: [{ component: 'criteria', question: 'What matters most?' }] };
  const refused = await ask.execute(args, {} as never, {} as never);
  assert.equal(refused.isError, true);
  assert.equal(refused.control, undefined);
  assert.equal(answers.length, 0);
  blocked = null;
  const asked = await ask.execute(args, {} as never, {} as never);
  assert.deepEqual(asked.control, { terminate: true });
  assert.equal(answers[0]?.kind, 'clarification');
});

test('turns are validated before reaching a conversation', () => {
  assert.equal(parseTurn({ skip: true }), 'Describe the work you want a model to do.');
  assert.equal(parseTurn({ message: 'x', extra: 1 }), 'Send conversationId, message, brief or skip.');
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
