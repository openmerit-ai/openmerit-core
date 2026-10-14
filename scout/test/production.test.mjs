import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decisionQuestions, interpretDecisions, classifyPrompt } from '../decisions.mjs';
import { createRecommender } from '../recommend.mjs';
import { createIndex, recommend } from '../rank.mjs';
import { handleAPI } from '../http.mjs';
import { handleMCP } from '../mcp.mjs';
import { bfclMetrics, parseBFCL, compileSnapshot } from '../sources.mjs';

const snapshot = JSON.parse(await readFile(new URL('../snapshot.json', import.meta.url), 'utf8'));
const index = createIndex(snapshot);
const answers = (choices = {}) => decisionQuestions.map(q => ({ name: q.name, type: 'choice', confidence: .9, choice: choices[q.name] ?? ({ tools: 'no', memory: 'none', json: 'no', output: 'supported', input_length: 'medium', output_length: 'medium', priority: 'balanced', task_kind: 'other' }[q.name] ?? 'absent') }));
const post = (body, path = 'api/recommend') => new Request(`https://example.test/scout/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rpc = prompt => post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: { prompt } } }, 'mcp');

// Reproduce the observed false positives, including low-confidence format answers.
test('a mention of tools or agents and a spurious JSON answer cannot force action or schema requirements', () => {
  for (const prompt of ['Write a story about a secret agent.', 'Compare these supplied product descriptions in ordinary prose.']) {
    const a = answers({ writing: 'required', agents: 'useful', structured: 'required', json: 'yes' });
    a.find(v => v.name === 'json').confidence = .04;
    a.find(v => v.name === 'structured').confidence = .23;
    const task = interpretDecisions(a, prompt);
    assert.equal(task.needsTools, false); assert.equal(task.needsStructured, false);
    assert.equal(task.weights.agents, undefined); assert.equal(task.weights.structured, undefined);
    assert.deepEqual(task.uncertainty, []);
  }
  const explicit = answers({ structured: 'required', json: 'yes' }); explicit.find(v => v.name === 'json').confidence = .2;
  assert.equal(interpretDecisions(explicit, 'Return strict JSON with these six fields.').needsStructured, true);
  assert.equal(interpretDecisions(answers({ writing: 'required', json: 'no' }), 'A story about a robot named JSON, in ordinary prose.').needsStructured, false);
});

test('invalid, missing, duplicate, refused or uncalibrated answers fail closed', () => {
  assert.throws(() => interpretDecisions([], 'task'), /Incomplete/);
  for (const replacement of [{ name: 'documents', type: 'refusal' }, { name: 'documents', type: 'choice', choice: 'required' }, { name: 'vision', type: 'choice', choice: 'required', confidence: .8 }, { name: 'documents', type: 'choice', choice: 'required', confidence: 2 }]) {
    const a = answers(); a[0] = replacement; assert.throws(() => interpretDecisions(a, 'task'), /Invalid/);
  }
});

test('HTTP and MCP make one server-side interpretation each and retain required memory/tool evidence in compact results', async () => {
  let calls = 0;
  const run = createRecommender({ apiKey: 'test-secret', fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/decisions'); assert.ok(options.signal);
    assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
    return Response.json({ answers: answers({ memory: 'persistent', tools: 'yes', agents: 'required', reasoning: 'required', knowledge: 'required' }) });
  } });
  const prompt = 'Use functions to save supplier details and recall them across future sessions.';
  const http = await (await handleAPI(post({ prompt }), index, {}, run)).json();
  const mcp = (await (await handleMCP(rpc(prompt), index, {}, run)).json()).result.structuredContent;
  assert.equal(calls, 2); assert.equal(http.task.interpreter, 'openai-decisions');
  assert.equal(http.recommendations.length, 5);
  assert.deepEqual(mcp.recommendations.map(m => m.id), http.recommendations.map(m => m.id));
  for (const model of mcp.recommendations) {
    assert.ok(model.parameters.includes('tools'));
    assert.ok(model.evidence.some(e => /BFCL v4 memory/.test(e.benchmark)));
    assert.ok(model.evidence.some(e => /function calling|single-turn|multi-turn|τ/.test(e.benchmark)));
    assert.ok(model.evidence.length <= 4);
  }
  assert.ok(http.warnings.some(w => /external key-value/.test(w)));
});

test('memory requires direct evidence and callable tools; session state is not persistent memory', () => {
  const memory = interpretDecisions(answers({ memory: 'persistent', tools: 'unspecified' }), 'Remember suppliers on future visits.');
  const noEvidence = structuredClone(snapshot); noEvidence.models.forEach(m => m.evidence = m.evidence.filter(e => !e.benchmark.startsWith('bfcl:memory')));
  assert.equal(recommend(createIndex(noEvidence), 'Remember suppliers', Date.now(), memory).recommendations.length, 0);
  const noTools = structuredClone(snapshot); noTools.models.forEach(m => m.parameters = m.parameters.filter(p => p !== 'tools'));
  assert.equal(recommend(createIndex(noTools), 'Remember suppliers', Date.now(), memory).recommendations.length, 0);
  const session = interpretDecisions(answers({ memory: 'session', writing: 'required' }), 'Keep track during this conversation only.');
  assert.equal(session.needsMemory, false); assert.equal(session.weights.memory, undefined);
});

test('invalid requests spend no provider calls and provider failure is unavailable, never a keyword fallback', async () => {
  let calls = 0;
  const run = createRecommender({ apiKey: 'test-secret', fetcher: async () => { calls++; throw new Error('test-secret must stay private'); } });
  for (const prompt of ['', 'x'.repeat(4001), 42]) assert.equal((await handleAPI(post({ prompt }), index, {}, run)).status, 400);
  assert.equal((await handleAPI(post({ prompt: 'Task', task: {} }), index, {}, run)).status, 400);
  assert.equal(calls, 0);
  const failed = await handleAPI(post({ prompt: 'Write a story' }), index, {}, run);
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /test-secret/);
  assert.equal((await (await handleMCP(rpc('Write a story'), index, {}, run)).json()).result.isError, true);
  await assert.rejects(createRecommender()(index, 'Task'), e => e.status === 503);
  await assert.rejects(classifyPrompt('Task', { apiKey: 'test', timeoutMs: 5, fetcher: (_u, { signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout did not fire')), 100);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
  }) }), /timeout/i);
});

test('admission bounds simultaneous and per-minute provider spend, and releases slots after failure', async () => {
  let clock = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = createRecommender({ apiKey: 'test', now: () => clock, fetcher: async () => { calls++; await gate; throw new Error('unavailable'); } });
  const pending = Array.from({ length: 8 }, () => run(index, 'Task').catch(e => e.status));
  const limited = await handleAPI(post({ prompt: 'Task' }), index, {}, run);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '2'); assert.equal(calls, 8);
  release(); assert.deepEqual(await Promise.all(pending), Array(8).fill(503));
  for (let i = 8; i < 120; i++) await assert.rejects(run(index, 'Task'), e => e.status === 503);
  await assert.rejects(run(index, 'Task'), e => e.status === 429); assert.equal(calls, 120);
  clock = 60_000; await assert.rejects(run(index, 'Task'), e => e.status === 503); assert.equal(calls, 121);
});

const bfcl = (rows = ['gpt-4.1 (FC),0%,80%,60%,0%,40%,50%', 'gpt-4.1 (Prompt),99%,99%,99%,99%,99%,99%', 'unknown-model (FC),20%,30%,40%,N/A,-,—']) => ['Model,' + bfclMetrics.map(m => m[1]).join(','), ...rows].join('\n');
test('BFCL imports native function calling only, preserves zero/unknown, and rejects bad scores and headers', () => {
  const rows = parseBFCL(bfcl()); assert.equal(rows.length, 2); assert.equal(rows[0].scores.memoryKV, 0);
  assert.equal(rows[1].scores.memoryVector, undefined);
  assert.throws(() => parseBFCL(bfcl().replace('0%', '101%')), /Invalid/);
  assert.throws(() => parseBFCL(bfcl().replace('0%', '0.5')), /percentage/);
  assert.throws(() => parseBFCL(bfcl().replace('Memory KV', 'Memory')), /format/);
  const router = { data: snapshot.models.map(m => ({ id: m.id, name: m.name, canonical_slug: m.canonical, architecture: { input_modalities: m.modalities, output_modalities: ['text'] }, pricing: { prompt: m.inputPrice / 1e6, completion: m.outputPrice / 1e6 }, supported_parameters: m.parameters })) };
  const retained = compileSnapshot({ previous: snapshot, router, bfclCSV: 'broken' });
  assert.equal(retained.sources.find(s => s.id === 'bfcl').status, 'failed');
  assert.equal(retained.sources.find(s => s.id === 'bfcl').checkedAt, snapshot.sources.find(s => s.id === 'bfcl').checkedAt);
  assert.deepEqual(retained.models.find(m => m.id === 'openai/gpt-4.1').evidence.filter(e => e.benchmark.startsWith('bfcl:')), snapshot.models.find(m => m.id === 'openai/gpt-4.1').evidence.filter(e => e.benchmark.startsWith('bfcl:')));
  const definitions = snapshot.benchmarks.filter(b => b.source === 'bfcl');
  assert.equal(definitions.length, 6); assert.ok(definitions.every(b => b.family === 'bfcl-v4'));
  assert.ok(snapshot.models.every(m => m.evidence.filter(e => e.benchmark.startsWith('bfcl:')).every(e => e.observedAt === null && e.configurations.every(c => /\(FC/.test(c)))));
});

test('typed operations ground their required capability and single dispatch does not become an autonomous agent', () => {
 const dispatch=interpretDecisions(answers({task_kind:'dispatch',tools:'no',agents:'useful'}),'Choose one provided function and its arguments.');
 assert.equal(dispatch.needsTools,true);assert.equal(dispatch.weights.tools,3);assert.equal(dispatch.weights.agents,undefined);
 const loop=interpretDecisions(answers({task_kind:'dispatch',tools:'yes',agents:'required'}),'Call a function, inspect errors and retry with corrected arguments.');
 assert.equal(loop.weights.agents,3);
 const sql=interpretDecisions(answers({task_kind:'sql',coding:'absent'}),'Write a read-only SQLite SELECT.');
 assert.equal(sql.weights.coding,3);
 const retrieval=interpretDecisions(answers({task_kind:'retrieve',context:'absent',input_length:'short'}),'Find the latest record in a long ledger.');
 assert.equal(retrieval.weights.context,3);assert.equal(retrieval.workload.input,'long');
});


test('a short task description cannot make visual input a short text workload', () => {
 const task=interpretDecisions(answers({task_kind:'extract',vision:'required',documents:'required',input_length:'short',output_length:'short'}),'Read a photo and extract fields.');
 assert.equal(task.workload.input,'medium');
 const long=interpretDecisions(answers({vision:'required',context:'required',input_length:'short'}),'Read a very large collection of scans.');
 assert.equal(long.workload.input,'long');
});

test('typed execution operations retain tool and memory requirements despite contradictory independent answers', () => {
 const code=interpretDecisions(answers({task_kind:'code'}),'Implement a JavaScript function under a specification.');
 assert.equal(code.weights.coding,3);assert.equal(code.needsTools,false);
 const action=interpretDecisions(answers({task_kind:'act',tools:'no'}),'Look up state with functions and choose the next permitted action.');
 assert.equal(action.needsTools,true);assert.equal(action.weights.agents,3);assert.equal(action.weights.tools,3);
 const memory=interpretDecisions(answers({task_kind:'remember',memory:'none',tools:'unspecified',agents:'required'}),'Save facts with memory tools and recall them in a new session.');
 assert.equal(memory.needsMemory,true);assert.equal(memory.needsTools,true);assert.equal(memory.requirements.memory,'persistent');assert.equal(memory.weights.agents,3);
 // An ordinary description of a tool does not select an execution operation.
 const prose=interpretDecisions(answers({task_kind:'other',writing:'required'}),'Explain how an external memory tool works.');
 assert.equal(prose.needsMemory,false);assert.equal(prose.needsTools,false);
});
