import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, renderScout, scoutTurn, type ScoutModel } from '../src/scout.ts';

test('openmerit scout talks to the Scout agent over MCP under the project policy', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openmerit-scout-')), root = await mkdtemp(join(tmpdir(), 'openmerit-project-'));
  process.env.OPENMERIT_CONFIG_DIR = home;
  t.after(() => { delete process.env.OPENMERIT_CONFIG_DIR; });
  const key = `om_${'k'.repeat(43)}`;
  const calls: Array<{ url: string; authorization: string | null; agent: string | null; body: { params: { name: string; arguments: Record<string, unknown> } } }> = [];
  const answer = { conversationId: '6cbb63c0-e848-4d65-9231-171c95756cf1', status: 'needs_answers', brief: { criteria: { text: '', source: 'missing' } }, questions: [{ component: 'criteria', question: 'What matters most?' }] };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization'), agent: new Headers(init.headers).get('x-scout-agent'), body: JSON.parse(String(init.body)) });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false } });
  });

  await assert.rejects(scoutTurn(root, { prompt: 'Summarize tickets', allEndpoints: true }), /not signed in/);
  // A Pi user installation's key, with its correlation header.
  await mkdir(join(home, 'pi/user'), { recursive: true });
  await writeFile(join(home, 'pi/user/credentials.json'), JSON.stringify({ version: 1, server: 'https://scout.example', key, headers: { 'X-Scout-Agent': 'pi' } }));
  // No saved policy: the whole catalogue needs an explicit choice.
  await assert.rejects(scoutTurn(root, { prompt: 'Summarize tickets' }), /scout\.json is missing/);
  await mkdir(join(root, '.openmerit'));
  await writeFile(join(root, '.openmerit/scout.json'), JSON.stringify({ version: 1, policy: 'existing-only', endpointIds: ['openai:gpt'] }));
  await assert.rejects(scoutTurn(root, { prompt: 'Summarize tickets', allEndpoints: true }), /existing-only/);
  assert.equal(calls.length, 0, 'refused turns never reach Scout');

  const printed: string[] = [];
  assert.equal(await main(['Summarize', 'tickets'], { root, print: text => printed.push(text) }), 0);
  assert.equal(calls[0]?.url, 'https://scout.example/scout/mcp');
  assert.equal(calls[0]?.authorization, `Bearer ${key}`);
  assert.equal(calls[0]?.agent, 'pi');
  assert.deepEqual(calls[0]?.body.params, { name: 'scout_models', arguments: { prompt: 'Summarize tickets', endpointIds: ['openai:gpt'] } });
  assert.match(printed[0] ?? '', /criteria: What matters most\?/);
  assert.match(printed[0] ?? '', /--conversation 6cbb63c0-e848-4d65-9231-171c95756cf1 --brief/);

  // Answers continue the same conversation; its inventory was fixed when it started.
  await main(['--conversation', answer.conversationId, '--brief', 'criteria=Accuracy = first', '--json'], { root, print: () => {} });
  assert.deepEqual(calls[1]?.body.params.arguments, { conversationId: answer.conversationId, brief: { criteria: 'Accuracy = first' } });
  await writeFile(join(root, '.openmerit/scout.json'), JSON.stringify({ version: 1, policy: 'existing-first', endpointIds: ['openai:gpt'] }));
  await scoutTurn(root, { prompt: 'Summarize tickets', allEndpoints: true });
  assert.deepEqual(calls[2]?.body.params.arguments, { prompt: 'Summarize tickets' });

  // Measured results continue a conversation; Scout validates their fields.
  const results = [{ level: 'agent', scope: 'summary agent', model: 'openai:gpt', metric: 'accepted', value: 0.9, higherIsBetter: true, samples: 30, source: 'own eval' }];
  await writeFile(join(root, 'results.json'), JSON.stringify(results));
  await main(['--conversation', answer.conversationId, '--results', 'results.json', '--json'], { root, print: () => {} });
  assert.deepEqual(calls[3]?.body.params.arguments, { conversationId: answer.conversationId, results });
  await assert.rejects(main(['Summarize', '--results', 'results.json'], { root, print: () => {} }), /--results continues a conversation/);
});

test('terminal shortlists name an explicit ranking and show the value it sorts by', () => {
  const model = (rank: number, name: string, seconds: number | null, released: string | null): ScoutModel => ({ rank, id: name, name, provider: 'lab', rationale: 'why', watchOut: null,
    quality: { score: 80, evidence: [] }, cost: null, latency: seconds === null ? null : { seconds }, recency: released ? { released } : null });
  const models = [model(1, 'Quick', 2.04, '2026-08-01'), model(2, 'Slow', null, null)];
  const render = (priority?: 'cost' | 'latency' | 'recency') => renderScout({ conversationId: 'c', status: 'recommended', tasks: [{ title: 't', work: 'w', summary: 's', ...(priority ? { priority } : {}), models }] });
  const fastest = render('latency');
  assert.match(fastest, /Fastest first\./);
  assert.match(fastest, /1\. Quick · 2\.0s per task · quality 80\/100/);
  assert.match(fastest, /2\. Slow · time unknown · quality/);
  assert.match(render('recency'), /1\. Quick · released 2026-08-01 · quality/);
  // Cheapest first is the default and stays unlabelled, with no extra metric.
  for (const output of [render(), render('cost')]) { assert.doesNotMatch(output, /first\./); assert.match(output, /1\. Quick · quality 80\/100/); }
});

test('terminal shortlists show the evaluation plan and which quality rests on measured results', () => {
  const measured: ScoutModel = { rank: 1, id: 'a', name: 'Alpha', provider: 'lab', rationale: 'why', watchOut: null, quality: { score: 90, measured: true, evidence: [] }, cost: null };
  const output = renderScout({ conversationId: 'c', status: 'recommended', tasks: [
    { title: 'Adjudicate', work: 'w', summary: 's', agent: 'Adjudication agent', callsPerRun: 6, models: [measured], evaluation: { checks: [{ level: 'agent', metric: 'line decisions correct', how: 'Run the claims dataset.' }], samples: 40, stopEarly: 'stop after 10 if it trails by 15 points' } },
    { title: 'Triage', work: 'w', summary: 's', models: [] }] });
  assert.match(output, /1\. Adjudicate \(Adjudication agent, 6 calls per run\)/);
  assert.match(output, /1\. Alpha · quality 90\/100 \(measured\)/);
  assert.match(output, /Measure with your evals \(40 labelled examples per candidate; stop after 10 if it trails by 15 points\):\n {5}- agent: line decisions correct\. Run the claims dataset\./);
  assert.match(output, /--conversation c --results <file\.json>/);
  assert.match(output, /\(measured\) rests on the results you reported/);
});
