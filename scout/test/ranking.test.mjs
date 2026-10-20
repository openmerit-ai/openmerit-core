import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshot } from '../rank.mjs';
import { compareQuality, orderCandidates, referenceWork, workloadFor } from '../comparison.mjs';
import { decisionQuestions, interpretDecisions } from '../decisions.mjs';

const benchmark = (id = 'direct', tags = ['coding'], family = id) => ({ id, name: id, tags, family, source: 'test' });
const evidence = (score, definition = benchmark()) => ({ benchmark: definition.id, score, definition, url: 'https://example.com', configurations: ['default'] });
const candidate = (id, score, cost, seconds) => ({ model: { id, inputPrice: cost, outputPrice: cost, speed: seconds === null ? null : { tokensPerSecond: 128, timeToFirstAnswer: seconds } }, evidence: [evidence(score)] });
const task = { weights: { coding: 3 }, workload: { input: 'short', output: 'short', priority: 'balanced' } };

test('all five positions respect better measured quality, lower cost and lower latency; sixth is excluded', () => {
  const candidates = Array.from({ length: 6 }, (_, i) => candidate(`lab/${i}`, .95 - i * .08, 1 + i, 1 + i));
  orderCandidates(candidates.reverse(), task);
  assert.deepEqual(candidates.slice(0, 5).map(c => c.model.id), ['lab/0', 'lab/1', 'lab/2', 'lab/3', 'lab/4']);
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert.ok(candidates[i].model.inputPrice < candidates[j].model.inputPrice);
});
test('ranked comparisons are independent of input order and provider names', () => {
  const original = [candidate('a', .9, 5, 1), candidate('b', .88, 1, 3), candidate('c', .7, .1, 4), candidate('d', .5, .2, 10), candidate('e', .4, .3, 12)];
  const first = structuredClone(original); orderCandidates(first, task);
  const shuffled = structuredClone([original[3], original[1], original[4], original[0], original[2]]); orderCandidates(shuffled, task);
  assert.deepEqual(shuffled.map(c => c.model.id), first.map(c => c.model.id));
  const renamed = original.map(c => ({ ...structuredClone(c), model: { ...c.model, id: `other-provider/${c.model.id}` } })); orderCandidates(renamed, task);
  assert.deepEqual(renamed.map(c => c.model.id.split('/')[1]), first.map(c => c.model.id));
});
test('unrelated benchmark cohorts are never compared as if their percentiles were interchangeable', () => {
  const a = candidate('a', .99, 1, 1), b = candidate('b', .7, 1, 1);
  b.evidence = [evidence(.7, benchmark('different-cohort'))];
  assert.equal(compareQuality(a, b, task.weights), null);
  a.evidence.push(evidence(.4, benchmark('shared'))); b.evidence.push(evidence(.8, benchmark('shared')));
  assert.equal(compareQuality(a, b, task.weights).preference, 0);
});
test('duplicating a correlated benchmark does not change a pair preference', () => {
  const a = candidate('a', .8, 1, 1), b = candidate('b', .7, 1, 1);
  const before = compareQuality(a, b, task.weights).preference;
  for (let i = 0; i < 12; i++) { a.evidence.push(evidence(.8, benchmark(`copy-${i}`, ['coding'], 'direct'))); b.evidence.push(evidence(.7, benchmark(`copy-${i}`, ['coding'], 'direct'))); }
  assert.equal(compareQuality(a, b, task.weights).preference, before);
});
test('first ANSWER delay is included and paired measurements are combined after estimating completion', () => {
  const work = workloadFor(task), model = candidate('a', .8, 1, 1).model;
  model.speed.measurements = [{ tokensPerSecond: 10, timeToFirstAnswer: 1 }, { tokensPerSecond: 100, timeToFirstAnswer: 10 }];
  assert.equal(referenceWork(model, work).seconds, (13.8 + 11.28) / 2);
  model.speed.measurements = [{ tokensPerSecond: 100, timeToFirstAnswer: null }];
  assert.equal(referenceWork(model, work).seconds, null);
  assert.equal(referenceWork({ ...model, speed: null }, work).seconds, null);
  assert.equal(referenceWork({ ...model, speed: { timeToFirstToken: 1, tokensPerSecond: 100 } }, work).seconds, null);
});
test('input/output shapes change cost and completion estimates, without model-specific coefficients', () => {
  const model = { inputPrice: 1, outputPrice: 4, speed: { tokensPerSecond: 100, timeToFirstAnswer: 2 } };
  assert.ok(referenceWork(model, { inputTokens: 1000, outputTokens: 2000 }).cost > referenceWork(model, { inputTokens: 1000, outputTokens: 100 }).cost);
  assert.ok(referenceWork(model, { inputTokens: 1000, outputTokens: 2000 }).seconds > referenceWork(model, { inputTokens: 1000, outputTokens: 100 }).seconds);
  assert.equal(referenceWork(model, { inputTokens: 1000, outputTokens: 100 }).cost, .0014);
});
test('explicit priorities change a close tradeoff but cannot make a very weak cheap model win', () => {
  const input = [candidate('quality', .90, 10, 10), candidate('economy', .86, 1, 1), candidate('weak', .2, .01, 1)];
  const quality = structuredClone(input), cost = structuredClone(input);
  orderCandidates(quality, { ...task, workload: { ...task.workload, priority: 'quality' } });
  orderCandidates(cost, { ...task, workload: { ...task.workload, priority: 'cost' } });
  assert.equal(quality[0].model.id, 'quality'); assert.equal(cost[0].model.id, 'economy'); assert.equal(cost.at(-1).model.id, 'weak');
});
test('missing latency is not treated as zero and cannot outperform an otherwise identical measured model', () => {
  const items = [candidate('unknown', .8, 1, null), candidate('known', .8, 1, 2)]; orderCandidates(items, task);
  assert.equal(items[0].model.id, 'known'); assert.equal(items[1].reference.seconds, null);
});
test('Decisions validates typed workload choices and large-context requirements remain large', () => {
  const choices = { context: 'required', input_length: 'medium', output_length: 'short', priority: 'cost', task_kind: 'retrieve', detection_scope: 'absent', tools: 'no', memory: 'none', json: 'no', output_format: 'unspecified', output_specificity: 'established', output: 'supported' };
  const answers = decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .9, choice: choices[q.name] ?? ({output_format:'unspecified',output_specificity:'established'}[q.name] ?? 'absent') }));
  const result = interpretDecisions(answers);
  assert.deepEqual(result.workload, { input: 'long', output: 'short', priority: 'cost' });
  answers.find(a => a.name === 'priority').choice = 'a-provider'; assert.throws(() => interpretDecisions(answers), /Invalid/);
});
test('runtime ranking never imports local invoice answers or evaluation model IDs', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['rank.mjs', 'comparison.mjs', 'recommend.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /experiments\/|invoice-eval|gemini|gpt-|kimi|qwen|claude|eval-manifest/);
  }
});

test('deployment replaces newer legacy snapshots without treating reasoning-token delay as answer latency', () => {
  const seed = { dataVersion: 2, checkedAt: '2026-10-14T17:00:00Z', sources: [{ id: 'analysis' }] };
  const legacy = { checkedAt: '2026-10-14T18:00:00Z', sources: [{ id: 'analysis' }] };
  assert.equal(selectSnapshot(seed, legacy), seed);
  const fresh = { ...legacy, dataVersion: 2 };
  assert.equal(selectSnapshot(seed, fresh), fresh);
});
