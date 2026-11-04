import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceDocuments, stageEvidence, verifyEvidenceReady, recordLegacyEvidence, pruneEvidence} from '../evidence-search.mjs';
import {d1} from './helpers-d1.ts';

test('hourly evidence documents retain research and methodology instead of generic feed labels', () => {
  const [document] = evidenceDocuments({benchmarks: [{id: 'b', name: 'Opaque series', tags: ['vision'], interpretation: {status: 'ready'}, definition: {description: 'Receives images.'}, research: {description: 'Recognize instances in photographs.', methodology: 'Copy the visible category.', limitations: 'No location evaluation.'}, methodologySelection: {sections: [{title: 'Scope', text: 'Single photograph inputs.'}]}}]});
  for (const text of ['Recognize instances', 'Copy the visible category', 'Single photograph inputs', 'No location evaluation']) assert.ok(document.text.includes(text));
});

test('shared evidence vectors are reused and pruning protects the published generation', async () => {
  const snapshot = (description: string) => ({benchmarks: [{id: 'b', name: 'b', tags: ['vision'], definition: {description}, interpretation: {status: 'ready'}}]});
  const db = d1();
  const cache = new Map<string, string>();
  let embeddingCalls = 0;
  const options = (now: string) => ({db, now, apiKey: 'fixture', cache: {get: async (key: string) => cache.get(key), put: async (key: string, value: string) => cache.set(key, value)}, fetcher: async (url: string, request: RequestInit) => {
    assert.ok(url.endsWith('/embeddings'));
    embeddingCalls++;
    const body = JSON.parse(String(request.body)) as {input: string[]};
    return Response.json({data: body.input.map((_, index) => ({index, embedding: Array(256).fill(.01)}))});
  }});
  const vectors: {id: string; namespace: string}[] = [];
  const deleted: string[] = [];
  const service = {
    upsert: async (rows: typeof vectors) => {vectors.push(...rows); return {mutationId: 'new'};},
    describe: async () => ({processedUpToMutation: 'old'}),
    getByIds: async (ids: string[]) => vectors.filter(vector => ids.includes(vector.id)),
    deleteByIds: async (ids: string[]) => {assert.ok(ids.length <= 20); deleted.push(...ids);},
  };
  const legacy = Array.from({length: 45}, (_, i) => `L${i}`);
  assert.equal(await recordLegacyEvidence(db, async function* () {yield {index: {version: 'legacy', documents: legacy.map(vectorId => ({vectorId}))}, uploaded: '2026-09-01T00:00:00Z'};}), 45);
  const a = await stageEvidence(service, snapshot('Photo interpretation.'), 'a', options('2026-10-01T00:00:00Z'));
  await assert.rejects(verifyEvidenceReady(service, a), /finished indexing/);
  const b = await stageEvidence(service, snapshot('Photo interpretation.'), 'b', options('2026-10-02T00:00:00Z'));
  assert.deepEqual([embeddingCalls, vectors.length, b.upserted, b.mutationId, b.documents[0].vectorId], [1, 1, 0, undefined, a.documents[0].vectorId]);
  assert.equal(await verifyEvidenceReady(service, b), true);
  assert.equal(await recordLegacyEvidence(db, async function* () {throw Error('must not list again');}), 0);
  for (const [i, version] of ['c', 'd', 'e', 'f', 'g', 'h'].entries()) await stageEvidence(service, snapshot('Changed description.'), version, options(`2026-10-0${i + 3}T00:00:00Z`));
  assert.deepEqual([embeddingCalls, vectors.length], [2, 2]);
  const remove = service.deleteByIds;
  let calls = 0;
  service.deleteByIds = async ids => {if (++calls === 2) throw Error('Vectorize busy'); return remove(ids);};
  assert.deepEqual(await pruneEvidence(db, service, ['h', 'a']), {versions: 0, deleted: 20, remaining: 2, error: 'Vectorize busy'});
  service.deleteByIds = remove;
  assert.deepEqual(await pruneEvidence(db, service, ['h', 'a'], 10), {versions: 1, deleted: 45, remaining: 1});
  assert.deepEqual(await pruneEvidence(db, service, ['h', 'a']), {versions: 1, deleted: 0, remaining: 0});
  assert.deepEqual([...new Set(deleted)].sort(), [...legacy].sort());
  assert.deepEqual(await pruneEvidence(db, service, ['h']), {versions: 1, deleted: 1, remaining: 0});
  assert.equal(deleted.at(-1), a.documents[0].vectorId);
});

test('a processed mutation cannot publish missing or cross-generation vectors', async () => {
  const index = {version: 'next', mutationId: 'submitted', submittedAt: '2026-10-16T00:00:00Z', documents: [{vectorId: 'one'}, {vectorId: 'two'}]};
  let vectors = [{id: 'one', namespace: 'next'}];
  const service = {describe: async () => ({processedUpToMutation: 'later', processedUpToDatetime: '2026-10-16T00:01:00Z'}), getByIds: async () => vectors};
  await assert.rejects(verifyEvidenceReady(service, index), /unavailable/);
  vectors = [{id: 'one', namespace: 'next'}, {id: 'two', namespace: 'previous'}];
  await assert.rejects(verifyEvidenceReady(service, index), /unavailable/);
  vectors = [{id: 'one', namespace: 'next'}, {id: 'two', namespace: 'next'}];
  assert.equal(await verifyEvidenceReady(service, index), true);
});
