import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import { decisionQuestions, interpretDecisions } from '../decisions.mjs';
import { createIndex, recommend } from '../rank.mjs';

const now = Date.parse(snapshot.checkedAt), index = createIndex(snapshot);
// Typed interpretation fixtures exercise routing; they do not simulate semantic accuracy.
const answers = (choices, confidence = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice',
  confidence: confidence[q.name] ?? .95,
  choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported', input_length: 'medium', output_length: 'short', priority: 'balanced', task_kind: 'other' }[q.name] ?? 'absent') }));

for (const c of [
  { prompt: 'Choose billing, technical or account and draft a helpful reply.', kind: 'classify', labels: 'supplied', writing: true },
  { prompt: 'Say whether this product photo is damaged and explain the visible evidence.', kind: 'judge', vision: true, writing: true },
  { prompt: 'Decide whether this receipt photo is reimbursable and extract merchant, date and total as JSON.', kind: 'extract', vision: true, json: true, documents: true },
]) test(`mixed output cannot use a decision-only endpoint or narrow calibration: ${c.prompt}`, () => {
  const task = interpretDecisions(answers({ task_kind: c.kind, result_type: 'mixed', label_space: c.labels ?? 'absent',
    writing: c.writing ? 'required' : 'absent', vision: c.vision ? 'required' : 'absent', documents: c.documents ? 'required' : 'absent', json: c.json ? 'yes' : 'no' }));
  const result = recommend(index, c.prompt, now, task);
  assert.equal(task.kind, 'other');
  assert.equal(result.ranking.mode, 'benchmarks');
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every(m => !m.endpoint.operations));
  assert.ok(result.specialists.candidates.every(m => !/classification/.test(m.pipeline)), 'Fixed-label classifiers cannot reappear through discovery');
  if (c.vision) assert.ok(result.recommendations.every(m => m.modalities.includes('image')));
});

test('a contradictory predicate plus required prose cannot grant a decision-only contract', () => {
  // Reproduces the live damage-photo interpretation before the correction.
  const task = interpretDecisions(answers({ task_kind: 'classify', result_type: 'predicate', writing: 'required', vision: 'required' },
    { task_kind: .29, result_type: .57, writing: .51 }));
  assert.equal(task.kind, 'other');
  const result = recommend(index, 'Damage judgment and explanation', now, task);
  assert.equal(result.ranking.mode, 'benchmarks');
  assert.ok(result.recommendations.every(m => !m.endpoint.operations));
});

test('weak document guesses do not require OCR evidence for ordinary photos', () => {
  const choices = { vision: 'required', documents: 'required' };
  const weak = interpretDecisions(answers(choices, { documents: .29 }));
  assert.equal(weak.weights.documents, undefined);
  assert.equal(weak.needsVision, true);
  const strong = interpretDecisions(answers(choices));
  assert.equal(strong.weights.documents, 6);
});

test('an uncertain ordinary output remains uncertain for calibration matching', () => {
  const task = interpretDecisions(answers({ task_kind: 'extract', result_type: 'absent', json: 'yes' },
    { result_type: .3 }));
  assert.equal(task.kind, 'extract');
  assert.ok(task.uncertainty.includes('result_type'));
  assert.equal(recommend(index, 'Copy the fields as JSON', now, task).ranking.mode, 'benchmarks');
});

test('supplied labels and pure rubric scores retain their native contracts', () => {
  for (const [kind, result_type, label_space] of [['classify', 'labels', 'supplied'], ['judge', 'score', 'absent']]) {
    const task = interpretDecisions(answers({ task_kind: kind, result_type, label_space }));
    const result = recommend(index, 'Return only the answer', now, task);
    assert.equal(task.kind, kind);
    assert.equal(result.ranking.mode, 'task-fit');
    assert.ok(result.recommendations.some(m => m.endpoint.protocol === 'decisions'));
  }
});

test('mixed result descriptions preserve code and dependent tool execution requirements', () => {
  for (const kind of ['code', 'sql', 'act', 'remember']) {
    const task = interpretDecisions(answers({ task_kind: kind, result_type: 'mixed', writing: 'required' }));
    assert.equal(task.kind, kind);
    assert.equal(task.needsTools, ['act', 'remember'].includes(kind));
    assert.equal(task.needsMemory, kind === 'remember');
  }
});
