import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { main, renderScout, scoutTurn, type ScoutModel } from '../src/scout.ts';
import { connection } from '../src/connections.ts';
import { credentialsPath } from '../src/scout-credentials.ts';

test('headless CLI resumes explicit management approval, protects keys, and manages connections without changing agent credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openmerit-connector-'));
  const names = ['OPENMERIT_CONFIG_DIR', 'OPENMERIT_URL', 'OPENMERIT_LOGIN_WAIT', 'OPENMERIT_CONNECTION_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'DO_NOT_TRACK'];
  const before = new Map(names.map(name => [name, process.env[name]]));
  t.after(async () => { for (const [name, value] of before) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } await rm(home, { recursive: true, force: true }); });
  Object.assign(process.env, { OPENMERIT_CONFIG_DIR: home, OPENMERIT_URL: 'https://scout.example', OPENMERIT_LOGIN_WAIT: '0', DO_NOT_TRACK: '1', LANGFUSE_PUBLIC_KEY: 'pk-lf-fictional-key', LANGFUSE_SECRET_KEY: 'sk-lf-fictional-secret' });
  delete process.env.OPENMERIT_CONNECTION_KEY;
  const management = `om_${'m'.repeat(43)}`, recommendation = `om_${'r'.repeat(43)}`;
  const agentPath = credentialsPath('claude-code', 'user', home);
  const agentFile = JSON.stringify({ version: 1, server: 'https://scout.example', key: recommendation });
  await writeFile(agentPath, agentFile);
  const printed: string[] = [], errors: string[] = [];
  const run = (args: string[]) => connection(args, { root: home, print: text => printed.push(text), printError: text => errors.push(text) });
  let approved = false, connected = false, results = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (path === '/connect/api/device') {
      assert.equal(body.client, 'connector');
      return Response.json({ device_code: 'fictional-device', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://scout.example/connect?code=ABCD-EFGH', expires_in: 1800, interval: 5 });
    }
    if (path === '/connect/api/token') return approved ? Response.json({ access_token: management, key_id: 'dk_fixture' }) : Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (new Headers(options?.headers).get('Authorization') !== `Bearer ${management}`) return Response.json({ error: 'rejected' }, { status: 401 });
    if (options?.method === 'DELETE') { connected = false; results = 0; }
    if (path.endsWith('/sync')) results = connected ? 7 : 0;
    else if (options?.method === 'POST') {
      assert.equal(body.publicKey, 'pk-lf-fictional-key'); assert.equal(body.secretKey, 'sk-lf-fictional-secret'); connected = true;
    }
    return Response.json({ connected, results });
  });
  await assert.rejects(run(['connect', 'langfuse', '--status']), /Authorize connection management first/);
  assert.equal(await run(['connect', 'langfuse', '--authorize', '--no-open', '--json']), 10);
  assert.equal(JSON.parse(printed.join('\n')).code, 'pending', '--json stdout is machine-readable even while approval is pending');
  assert.match(printed.join('\n'), /ABCD-EFGH/);
  approved = true;
  assert.equal(await run(['connect', 'langfuse', '--authorize', '--no-open', '--json']), 0);
  assert.equal((await stat(credentialsPath('connector', 'user', home))).mode & 0o777, 0o600);
  const config = { region: 'us', from: '2026-11-01', tagPrefix: 'experiment:', mappings: [], models: {} };
  await writeFile(join(home, 'mappings.json'), JSON.stringify(config));
  assert.equal(await run(['connect', 'langfuse', '--config', 'mappings.json']), 0);
  assert.equal(JSON.parse(printed.at(-1) ?? '').connected, true);
  await run(['connect', 'langfuse', '--sync']);
  assert.equal(JSON.parse(printed.at(-1) ?? '').results, 7);
  await assert.rejects(run(['disconnect', 'langfuse', '--delete-all']), /requires --yes/);
  await run(['disconnect', 'langfuse', '--yes']);
  assert.equal(JSON.parse(printed.at(-1) ?? '').connected, false);
  t.mock.getter(process, 'stdin', () => Readable.from([JSON.stringify({ ...config, publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY })]));
  await run(['connect', 'langfuse', '--stdin']);
  assert.equal(JSON.parse(printed.at(-1) ?? '').connected, true);
  await run(['disconnect', 'langfuse', '--delete-all', '--yes']);
  assert.equal(JSON.parse(printed.at(-1) ?? '').connected, false);
  assert.equal(await readFile(agentPath, 'utf8'), agentFile);
  assert.doesNotMatch([...printed, ...errors].join('\n'), /om_|pk-lf|sk-lf|fictional-device/);
  await assert.rejects(run(['connect', 'langfuse', '--secret-key=DO_NOT_ECHO']), error => error instanceof Error && !error.message.includes('DO_NOT_ECHO'));
});

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
  // More than Scout's 50 per call is refused before anything is sent.
  await writeFile(join(root, 'many.json'), JSON.stringify(Array(51).fill(results[0])));
  const sent = calls.length;
  await assert.rejects(main(['--conversation', answer.conversationId, '--results', 'many.json'], { root, print: () => {} }), /holds 51 results; Scout accepts at most 50 per call/);
  assert.equal(calls.length, sent);
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
