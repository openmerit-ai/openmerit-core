import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import fixtures from './fixtures/format-contracts.json' with { type: 'json' };
import { decisionQuestions, interpretDecisions, classifyPrompt } from '../decisions.mjs';
import { createRecommender } from '../recommend.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { handleAPI } from '../http.mjs';

const index = createIndex(snapshot);
const answers = (choices, confidence = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice',
  confidence: confidence[q.name] ?? .95,
  choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'other' }[q.name] ?? 'absent') }));

// Real response replay verifies decoding and eligibility, not semantic accuracy.
// The opt-in provider audit independently checks the live interpretation questions.
for (const c of fixtures.cases) test(`recorded semantic format contract: ${c.id}`, async () => {
  const interpreted = await classifyPrompt(c.prompt, { apiKey: 'test', fetcher: async () => Response.json({ answers: answers(c.choices, c.confidence) }) });
  const task = interpreted.task;
  assert.equal(task.needsStructured, c.expected.structured);
  if ('structuredCapability' in c.expected) assert.equal(!!task.weights.structured, c.expected.structuredCapability);
  const result = recommend(index, c.prompt, Date.parse(snapshot.checkedAt), task);
  assert.ok(result.recommendations.length > 0);
  if (c.expected.structured) assert.ok(result.recommendations.every(m => m.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))));
});

test('format requirements and structured capability are derived from answers without reading prompt words', () => {
  const strict = interpretDecisions(answers({ json: 'yes' }));
  assert.equal(strict.needsStructured, true);
  assert.equal(strict.weights.structured, 3);
  const extraction = interpretDecisions(answers({ structured: 'required', json: 'no', task_kind: 'extract' }));
  assert.equal(extraction.needsStructured, false);
  assert.equal(extraction.weights.structured, 3);
  const prose = interpretDecisions(answers({ writing: 'required', structured: 'absent', json: 'no' }));
  assert.equal(prose.needsStructured, false);
  assert.equal(prose.weights.structured, undefined);
});

test('weak format answers stay uncertain in either direction without imposing a requirement', () => {
  for (const choice of ['yes', 'no']) {
    const task = interpretDecisions(answers({ json: choice, structured: 'required' }, { json: .39, structured: .3 }));
    assert.equal(task.needsStructured, false);
    assert.equal(task.weights.structured, undefined);
    assert.ok(task.uncertainty.includes('json'));
  }
  assert.equal(interpretDecisions(answers({ json: 'yes' }, { json: .4 })).needsStructured, true);
});

for (const c of [
  { prompt: 'Devuelve exclusivamente un objeto con las propiedades nombre y total.', strict: true },
  { prompt: 'Return rows separated by newlines, with each pair of values separated by a tab, ready for the parser.', strict: true },
  { prompt: 'Explain JSON schemas in ordinary prose.', strict: false },
  { prompt: 'Do not return structured output. Summarize these CSV records for a human.', strict: false },
]) test(`HTTP honors semantic format answers with one interpretation call: ${c.prompt}`, async () => {
  let calls = 0;
  const run = createRecommender({ apiKey: 'test', fetcher: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(JSON.parse(body.input.slice(body.input.indexOf('\n') + 1)).task, c.prompt);
    assert.equal(body.questions.length, decisionQuestions.length);
    return Response.json({ answers: answers({ json: c.strict ? 'yes' : 'no', structured: c.strict ? 'required' : 'absent', writing: c.strict ? 'absent' : 'required' }) });
  } });
  const post = (path, body) => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await (await handleAPI(post('api/recommend', { prompt: c.prompt }), index, {}, run)).json();
  assert.equal(calls, 1);
  assert.equal(result.task.needsStructured, c.strict);
  assert.ok(result.recommendations.length > 0);
  if (c.strict) assert.ok(result.recommendations.every(m => m.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))));
  else assert.equal(result.task.weights.structured, undefined);
});
