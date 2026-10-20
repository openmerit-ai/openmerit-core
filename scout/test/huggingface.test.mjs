import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hubQueries, parseHubModels, discoverSpecialists } from '../huggingface.mjs';
import { createIndex, recommend, indexStatus } from '../rank.mjs';
import { handleMCP } from '../mcp.mjs';
import { allowProfiles } from './helpers-specialists.mjs';
import { specialistProfiles } from '../specialists.mjs';

const checkedAt = '2026-10-15T00:00:00Z';
const row = (id, pipeline = 'document-question-answering', extra = {}) => ({ id, pipeline_tag: pipeline, sha: 'a'.repeat(40), tags: [], ...extra });
const task = { kind: 'extract', weights: { documents: 3 }, needsVision: true };
const annotated = (m, operation = 'documents') => ({ ...m, semantic: { version: '1', profileId: m.id, spec: { operation, pipeline: m.pipeline, languages: m.languages, labels: m.labels, subject: null } } });
test('Hub discovery has bounded coverage and excludes non-standalone packaging without merging fine-tunes', () => {
  assert.equal(hubQueries.length, 14);
  assert.ok(hubQueries.every(q => new URL(q.url).searchParams.get('limit') === '30'));
  const rows = [row('lab/base'), row('lab/tuned', 'document-question-answering', { cardData: { base_model: 'lab/base', base_model_relation: 'finetune' } }), row('lab/adapter', 'text-generation', { tags: ['peft'] }), row('lab/private', undefined, { private: true }), row('lab/disabled', undefined, { disabled: true }), row('lab/bad', undefined, { sha: 'main' }), row('lab/base')];
  const models = parseHubModels(rows, checkedAt);
  assert.deepEqual(models.map(m => m.id), ['lab/base', 'lab/tuned']);
  assert.deepEqual(models[1].baseModels, ['lab/base']);
  assert.match(models[0].cardURL, /blob\/a{40}\/README.md$/);
  assert.throws(() => parseHubModels(Array(421).fill(rows[0]), checkedAt));
});

test('Hub results preserve original units, configuration and provenance; metadata never establishes measured quality', () => {
  const [m] = parseHubModels([row('lab/ocr', 'image-to-text', { tags: ['ocr'], cardData: { license: 'custom', license_link: 'javascript:alert(1)', language: ['en'], 'model-index': [{ results: [{ dataset: { type: 'sample', split: 'test', config: 'cropped' }, task: { type: 'ocr' }, metrics: [{ type: 'error-rate', value: 0 }, { type: 'accuracy', value: '99' }] }] }] }, evalResults: [{ data: { dataset: { id: 'lab/pages', task_id: 'overall', revision: 'v2' }, value: 76.1, notes: 'Excludes headers', date: '2026-01-01', source: { url: 'https://example.org/paper' }, verifyToken: 'untrusted' } }, { error: 'invalid', data: { value: 100 } }], inferenceProviderMapping: { endpoint: { status: 'live', task: 'image-to-text', providerId: 'ocr-v1' }, old: { status: 'staging' } } })], checkedAt);
  assert.equal(m.evaluations.length, 2);
  assert.deepEqual(m.evaluations.map(e => e.value), [76.1, 0]);
  assert.equal(m.evaluations[0].notes, 'Excludes headers');
  assert.equal(m.evaluations[0].datasetRevision, 'v2');
  assert.match(m.evaluations[0].provenance, /not independently verified/);
  assert.equal(m.evaluations[1].configuration, 'cropped');
  assert.equal(m.providers.length, 1);
  assert.match(m.licenseURL, /^https:\/\/huggingface.co/);
  m.tags.push('document-understanding');
  const specialists = [annotated(m)], snapshot = { specialists, specialistProfiles: specialistProfiles(specialists) };
  const found = discoverSpecialists(snapshot, { ...task, specialistMatch: allowProfiles(snapshot) }, 'Read scanned pages');
  assert.equal(found.candidates[0].quality, null);
  assert.equal(found.candidates[0].costUsd, null);
  assert.equal(found.candidates[0].latencySeconds, null);
});

test('discovery honors semantic compatibility and tool requirements without rereading prompt words', () => {
  const models = parseHubModels([row('lab/invoices'), row('copy/invoices'), row('lab/medical'), row('lab/ocr', 'image-to-text', { tags: ['ocr', 'document-understanding'], cardData: { language: 'en' } }), row('lab/spanish', undefined, { cardData: { language: 'es' } }), row('lab/detector', 'image-to-text', { tags: ['ocr', 'object-detection'] })], checkedAt);
  const specialists = models.map(m => annotated(m)), snapshot = { specialists, specialistProfiles: specialistProfiles(specialists) };
  const interpreted = { ...task, specialistMatch: allowProfiles(snapshot, p => ['lab/invoices', 'copy/invoices', 'lab/ocr'].includes(p.id)) };
  const found = discoverSpecialists(snapshot, interpreted, 'Extract fields from English invoices into a JSON object');
  assert.deepEqual(found, discoverSpecialists(snapshot, interpreted, 'Different words cannot override typed compatibility'));
  assert.deepEqual(found.candidates.map(m => m.id).sort(), ['copy/invoices', 'lab/ocr']);
  assert.equal(discoverSpecialists(snapshot, { ...interpreted, needsTools: true }, 'Invoice').candidates.length, 0);
  assert.ok(!discoverSpecialists(snapshot, interpreted, 'invoice', [{ model: { repository: 'copy/invoices' } }]).candidates.some(m => m.id === 'copy/invoices'));
});

test('specialist discovery cannot change the five rankings, and API/MCP expose its provenance separately', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url)));
  const prompt = 'Upload an invoice and return six fields as JSON';
  const base = createIndex({ ...snapshot, specialists: [] }), index = createIndex(snapshot);
  const interpreted = { ...task, specialistMatch: allowProfiles(snapshot, p => p.operation === 'documents') };
  const result = recommend(index, prompt, Date.now(), interpreted);
  assert.deepEqual(result.recommendations, recommend(base, prompt, Date.now(), interpreted).recommendations);
  assert.ok(result.specialists.candidates.length);
  const response = await handleMCP(new Request('https://example.org/scout/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt } } }) }), index, {}, (i, p) => recommend(i, p, Date.now(), interpreted));
  const compact = (await response.json()).result.structuredContent;
  assert.deepEqual(compact.specialists.candidates.map(m => m.id), result.specialists.candidates.map(m => m.id));
  assert.ok(compact.specialists.candidates.every(m => m.evaluations.length <= 4 && m.evaluationCount >= m.evaluations.length));
  const status = indexStatus(index);
  assert.equal(status.specialistRepositories, snapshot.specialists.length);
  assert.ok(status.sources.every(s => s.role && s.limits && s.coverage));
  assert.equal(status.sources.find(s => s.id === 'huggingface').coverage.repositoriesWithReportedResults, snapshot.specialists.filter(m => m.evaluations.length).length);
});
