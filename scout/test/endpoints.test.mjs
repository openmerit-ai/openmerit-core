import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderCatalogue, mergeCatalogues } from '../catalogue.mjs';
import { contractModels } from '../endpoints.mjs';

test('native provider discovery works without router models; metadata is not a benchmark', () => {
  const data = { openai: { name: 'OpenAI', models: {} }, google: { name: 'Google', models: {} } };
  for (let i = 0; i < 12; i++) data.openai.models[`new-${i}`] = { id: `new-${i}`, name: `New ${i}`, modalities: { input: ['text'], output: ['text'] }, cost: { input: 1, output: 2 }, limit: { context: 4096 } };
  const models = mergeCatalogues([], parseProviderCatalogue(data, '2026-10-15T00:00:00Z'));
  assert.equal(models.length, 12); assert.ok(models.every(m => m.endpoints[0].source === 'modelsdev' && !m.evidence.length));
  assert.throws(() => parseProviderCatalogue({}, '2026-10-15'), /Invalid/);
});
test('status includes reviewed contracts and refreshed decision routes without claiming measurements', () => {
  const models=contractModels({contracts:[{model:'new/decision',modelId:'decision',provider:'New'}],decisionScores:{'new/decision':{quality:.8}}});
  assert.ok(models.length>1);
  const model=models.find(m=>m.id==='new/decision');
  assert.equal(model.decisionScore.quality,.8);assert.deepEqual(model.evidence,[]);
});
