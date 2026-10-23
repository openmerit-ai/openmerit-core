import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIndex, recommend } from '../rank.mjs';
import { handleAPI } from '../http.mjs';
const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url)));
const task={kind:'other',weights:{writing:3},workload:{input:'short',output:'medium'}};
const run=(i,p,ids,endpoints)=>recommend(i,p,Date.now(),task,undefined,ids??null,endpoints??null);
const index = createIndex(snapshot);
const post = (body, path = 'api/recommend') => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('existing connections are ranked before truncation, including models outside the unscoped five', async () => {
  const prompt = 'Write a short story';
  const inventory = index.models.filter(m => m.endpoints?.some(e => e.source === 'models')).map(m => m.id);
  const initial = recommend(index, prompt, Date.now(), task, undefined, inventory).recommendations.map(m => m.id);
  const alternatives = recommend(index, prompt, Date.now(), task, undefined, inventory.filter(id => !initial.includes(id))).recommendations.map(m => m.id);
  assert.equal(alternatives.length, 5);
  const result = await (await handleAPI(post({ prompt, modelIds: alternatives }), index, {}, run)).json();
  assert.equal(result.recommendations.length, 5);
  assert.ok(result.recommendations.every(m => alternatives.includes(m.id) && !initial.includes(m.id)));
  assert.deepEqual(result.selection.modelIds, alternatives);
  assert.deepEqual(result.specialists.candidates, []);
});
test('empty, unknown and unsupported scopes never expand silently', async () => {
  for (const modelIds of [[], ['unknown/missing']]) {
    const result = await (await handleAPI(post({ prompt: 'Write Python code', modelIds }), index, {}, run)).json();
    assert.deepEqual(result.recommendations, []); assert.deepEqual(result.selection.modelIds, modelIds);
  }
  assert.deepEqual(recommend(index, 'Generate a video', Date.now(), task, undefined, []).selection.modelIds, []);
});
test('HTTP rejects malformed scopes without spending an interpretation request', async () => {
  let calls = 0; const run = () => { calls++; };
  for (const modelIds of [null, 'all', [42], ['a', 'a'], ['https://x?key=secret'], Array.from({ length: 101 }, (_, i) => `p/m${i}`)]) {
    assert.equal((await handleAPI(post({ prompt: 'task', modelIds }), index, {}, run)).status, 400);
  }
  assert.equal(calls, 0);
});
