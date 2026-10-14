import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIndex, recommend } from '../rank.mjs';
import { interpretPrompt } from '../capabilities.mjs';
import { questions, taskFromAnswers, interpretWithDecisions } from '../experiments/decisions.mjs';

const empty = () => questions.map(q => ({ type: 'choice', name: q.name, choice: q.choices[0].value }));
test('incomplete, refused, duplicate, or invalid decisions cannot silently become a ranking', () => {
  assert.throws(() => taskFromAnswers([]), /Incomplete/);
  for (const replacement of [{ name: 'documents', type: 'refusal' }, { name: 'documents', type: 'choice', choice: 'invented' }, { name: 'vision', type: 'choice', choice: 'required' }]) {
    const answers = empty(); answers[0] = replacement;
    assert.throws(() => taskFromAnswers(answers), /Invalid/);
  }
});
test('an interpreted task changes evidence selection without changing the baseline ranker', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
  const index = createIndex(snapshot), prompt = 'An invoice tool that extracts JSON from photos';
  const baseline = recommend(index, prompt);
  assert.deepEqual(recommend(index, prompt, Date.now(), interpretPrompt(prompt)).recommendations, baseline.recommendations);
  const task = interpretPrompt(prompt); delete task.weights.agents;
  task.capabilities = task.capabilities.filter(c => c.id !== 'agents');
  const semantic = recommend(index, prompt, Date.now(), task);
  assert.ok(semantic.recommendations.every(m => !m.evidence.some(e => /tau|τ/i.test(e.benchmark))));
  assert.ok(baseline.recommendations.some(m => m.evidence.some(e => /tau|τ/i.test(e.benchmark))));
});
test('experiment bounds requests, reports API failures without echoing secrets, and preserves unknown memory', async () => {
  await assert.rejects(interpretWithDecisions('Example'), /OPENAI_API_KEY/);
  await assert.rejects(interpretWithDecisions('Example', { apiKey: 'private', fetcher: async () => new Response('private', { status: 429 }) }), { message: 'Decisions returned HTTP 429.' });
  const answers = empty().map(a => a.name === 'memory' ? { ...a, choice: 'unspecified' } : a);
  const result = await interpretWithDecisions('Example', { apiKey: 'private', fetcher: async (_url, options) => {
    assert.ok(options.signal); assert.equal(JSON.parse(options.body).questions.length, questions.length);
    return Response.json({ model: 'gpt-6-luna', answers });
  } });
  assert.equal(result.task.requirements.memory, 'unspecified');
  assert.equal(result.task.weights.memory, undefined);
});
