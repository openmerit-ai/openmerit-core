import test from 'node:test';
import assert from 'node:assert/strict';
import { hubQueries, parseHubModels } from '../huggingface.mjs';

const checkedAt = '2026-10-15T00:00:00Z';
const row = (id, pipeline = 'document-question-answering', extra = {}) => ({ id, pipeline_tag: pipeline, sha: 'a'.repeat(40), tags: [], ...extra });
test('Hub discovery has bounded coverage and excludes non-standalone packaging without merging fine-tunes', () => {
  assert.equal(hubQueries.length, 14);assert.ok(hubQueries.every(q => new URL(q.url).searchParams.get('limit') === '30'));
  const rows = [row('lab/base'), row('lab/tuned', 'document-question-answering', { cardData: { base_model: 'lab/base', base_model_relation: 'finetune' } }), row('lab/adapter', 'text-generation', { tags: ['peft'] }), row('lab/private', undefined, { private: true }), row('lab/disabled', undefined, { disabled: true }), row('lab/bad', undefined, { sha: 'main' }), row('lab/base')];
  const models = parseHubModels(rows, checkedAt);
  assert.deepEqual(models.map(m => m.id), ['lab/base', 'lab/tuned']);assert.deepEqual(models[1].baseModels, ['lab/base']);assert.match(models[0].cardURL, /blob\/a{40}\/README.md$/);assert.throws(() => parseHubModels(Array(421).fill(rows[0]), checkedAt));
});
test('Hub results preserve original units, configuration and provenance', () => {
  const [m] = parseHubModels([row('lab/ocr', 'image-to-text', { tags: ['ocr'], cardData: { license: 'custom', license_link: 'javascript:alert(1)', language: ['en'], 'model-index': [{ results: [{ dataset: { type: 'sample', split: 'test', config: 'cropped' }, task: { type: 'ocr' }, metrics: [{ type: 'error-rate', value: 0 }, { type: 'accuracy', value: '99' }] }] }] }, evalResults: [{ data: { dataset: { id: 'lab/pages', task_id: 'overall', revision: 'v2' }, value: 76.1, notes: 'Excludes headers', date: '2026-01-01', source: { url: 'https://example.org/paper' }, verifyToken: 'untrusted' } }, { error: 'invalid', data: { value: 100 } }], inferenceProviderMapping: { endpoint: { status: 'live', task: 'image-to-text', providerId: 'ocr-v1' }, old: { status: 'staging' } } })], checkedAt);
  assert.equal(m.evaluations.length, 2);assert.deepEqual(m.evaluations.map(e => e.value), [76.1, 0]);assert.equal(m.evaluations[0].notes, 'Excludes headers');assert.equal(m.evaluations[0].datasetRevision, 'v2');assert.match(m.evaluations[0].provenance, /not independently verified/);assert.equal(m.evaluations[1].configuration, 'cropped');assert.equal(m.providers.length, 1);assert.match(m.licenseURL, /^https:\/\/huggingface.co/);
});
