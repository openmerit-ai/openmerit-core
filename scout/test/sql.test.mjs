import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with { type: 'json' };
import fixtures from './fixtures/sql-contracts.json' with { type: 'json' };
import { createIndex } from '../rank.mjs';
import { createRecommender } from '../recommend.mjs';
import { handleAPI } from '../http.mjs';

import {decisionQuestions} from '../decisions.mjs';
const index = createIndex(snapshot);
const post = (path, body) => new Request(`https://example.test/scout/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// Replay recorded provider answers through the HTTP API. Semantic
// accuracy is checked separately by the opt-in real-provider interpretation audit.
for (const c of fixtures.cases) test(`SQL operation and answer format survive HTTP: ${c.id}`, async () => {
  let calls = 0;
  const run = createRecommender({ apiKey: 'test', fetcher: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if(body.questions[0].name.startsWith('verify_')) return Response.json({answers:body.questions.map(q=>({name:q.name,type:'choice',choice:'no',confidence:.95}))});
    assert.equal(body.questions.length, decisionQuestions.length);
    assert.equal(JSON.parse(body.input.slice(body.input.indexOf('\n') + 1)).task, c.prompt);
    return Response.json({ answers: body.questions.map(q => ({name:q.name,type:'choice',choice:q.name.startsWith('verify_')?'no':c.choices[q.name]??({output_format:'unspecified',output_specificity:'established'}[q.name]??q.choices[0].value),confidence:c.confidence[q.name]??.95})) });
  } });
  const result = await (await handleAPI(post('api/recommend', { prompt: c.prompt }), index, {}, run)).json();
  assert.ok(calls>=1 && calls<=2, 'Interpretation and at most one verification per request');
  const t = result.task, e = c.expected;
  if (e.kind) assert.equal(t.kind, e.kind);
  if (e.notKinds) assert.ok(!e.notKinds.includes(t.kind));
  if (e.coding) assert.equal(t.weights.coding, 3);
  if ('structured' in e) assert.equal(t.needsStructured, e.structured);
  if ('tools' in e) assert.equal(t.needsTools, e.tools);
  if (e.agentic) assert.equal(t.weights.agents, 3);
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every(m => !m.endpoint.operations), 'Query code and prose cannot use decision-only endpoints');
  if (e.structured) assert.ok(result.recommendations.every(m => m.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))));
});
