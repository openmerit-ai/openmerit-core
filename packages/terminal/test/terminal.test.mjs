import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request, createServer } from 'node:http';
import { createCollector, JsonlReader, loadConfig, normalizeRecord, parseRuntimeMetrics } from '../src/collect.mjs';
import { startTerminal } from '../src/server.mjs';
import { sampleSnapshot } from '../src/sample.mjs';
import { contiguousSamples, nearestSample } from '../client/samples.mjs';
import { routeKind, routeBreakdown, requestCountKnown } from '../client/routes.mjs';

async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'openmerit-terminal-')); await mkdir(join(root, '.openmerit')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const record = (overrides = {}) => ({ id: 'call-1', occurredAt: new Date().toISOString(), model: 'test-model', provider: 'test-provider', workload: 'test-workload', ...overrides });
const jsonl = value => `${JSON.stringify(value)}\n`;

test('projects metadata, rejects invalid measurements, and never exports arbitrary payload fields', () => {
  const result = normalizeRecord(record({ inputTokens: '[REDACTED]', outputTokens: -1, cost: Infinity, durationMs: 0, prompt: 'private prompt', response: 'private response', headers: { Authorization: 'secret' } }), 'test');
  assert.equal(result.inputTokens, null); assert.equal(result.outputTokens, null); assert.equal(result.cost, null); assert.equal(result.durationMs, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|Authorization|secret/);
  assert.equal(normalizeRecord(record({ occurredAt: 'yesterday' }), 'test'), null);
  assert.equal(normalizeRecord(record({ model: '' }), 'test'), null);
});

test('path classification keeps explicit paths distinct from model location and provider', () => {
  const snapshot = { inventory: [{ name: 'Company edge', kind: 'gateway', location: 'local' }], sources: [{ name: 'Ollama', kind: 'Local runtime' }] };
  assert.equal(routeKind(normalizeRecord(record({ route: 'Company edge', location: 'local' }), 'test'), snapshot), 'gateway');
  assert.equal(routeKind(record({ route: ' COMPANY EDGE ' }), snapshot), 'gateway');
  assert.equal(routeKind(normalizeRecord(record({ route: 'Company edge', routeKind: 'router' }), 'test'), snapshot), 'router');
  assert.equal(routeKind(normalizeRecord(record({ route: 'Company edge', routeKind: 'unknown' }), 'test'), snapshot), 'unknown');
  assert.equal(routeKind(record({ route: 'OLLAMA' }), snapshot), 'local');
  assert.equal(routeKind(record({ route: 'Direct API' }), snapshot), 'direct');
  assert.equal(routeKind(record({ provider: 'OpenAI', location: 'cloud' }), snapshot), 'unknown');
  assert.equal(routeKind(record({ provider: 'Ollama', location: 'local' }), snapshot), 'unknown');
  assert.equal(normalizeRecord(record({ routeKind: 'not-a-kind' }), 'test').routeKind, null);
});

test('agent and task metadata are optional, bounded labels rather than arbitrary payloads', () => {
  const result = normalizeRecord(record({ agentId: 'agent-4', agent: 'Security / Review', taskId: 'task-27', task: 'Review access permissions', taskPayload: { prompt: 'private' } }), 'test');
  assert.equal(result.agentId, 'agent-4'); assert.equal(result.agent, 'Security / Review');
  assert.equal(result.taskId, 'task-27'); assert.equal(result.task, 'Review access permissions');
  assert.doesNotMatch(JSON.stringify(result), /taskPayload|private/);
  const absent = normalizeRecord(record({ agentId: {}, task: ['invalid'] }), 'test');
  assert.equal(absent.agentId, null); assert.equal(absent.taskId, null); assert.equal(absent.task, null);
  assert.equal(normalizeRecord(record({ task: 'x'.repeat(200) }), 'test').task.length, 160);
});

test('identities are copied from metadata; workload text and prompts do not create agent names or IDs', () => {
  const result = normalizeRecord(record({ agentId: 'support.review', taskId: 'job-42', workload: 'services/support', prompt: 'You are the support agent' }), 'activity');
  assert.equal(result.agentId, 'support.review'); assert.equal(result.agent, null);
  assert.equal(result.taskId, 'job-42'); assert.equal(result.task, null);
  const unnamed = normalizeRecord(record({ workload: '', provider: '' }), 'activity');
  assert.equal(unnamed.workload, 'Unattributed workload'); assert.equal(unnamed.provider, 'Unattributed');
  assert.equal(unnamed.agentId, null); assert.equal(unnamed.taskId, null);
});

test('unnamed runtimes retain their configured address instead of receiving an invented service name', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ runtimes: [{ type: 'openai-compatible', url: 'http://127.0.0.1:1234' }] }));
  const config = await loadConfig(root);
  assert.equal(config.runtimes[0].name, 'http://127.0.0.1:1234');
});

test('sample naming exercises absent display names and code-style identifiers without claiming discovery', () => {
  const snapshot = sampleSnapshot();
  assert.ok(snapshot.records.some(item => item.agentId && !item.agent));
  assert.ok(snapshot.records.some(item => item.taskId && !item.task));
  assert.ok(snapshot.records.every(item => /^[a-z]+\.[a-z]+$/.test(item.agentId)));
  assert.equal(snapshot.machine.site, '');
  assert.ok(snapshot.sources.find(source => source.id === 'sample-activity').note.includes('not discovered code'));
  assert.doesNotMatch(JSON.stringify(snapshot), /Company gateway|Knowledge \/ Research|"site":"Studio"/);
});

test('ambiguous route declarations remain unclassified and mixed paths count each request once', () => {
  const snapshot = { inventory: [{ name: 'edge', kind: 'router' }, { name: 'edge', kind: 'gateway' }] };
  assert.equal(routeKind(record({ route: 'edge' }), snapshot), 'unknown');
  const items = [record({ routeKind: 'direct' }), record({ routeKind: 'router' }), record({ routeKind: 'gateway', location: 'local' }), record({ routeKind: 'local' }), record()];
  assert.deepEqual(routeBreakdown(items, snapshot), { direct: 1, local: 1, router: 1, gateway: 1, unknown: 1 });
});

test('tails complete lines, preserves split UTF-8, and updates a stable request without double counting', async t => {
  const root = await fixture(t), path = join(root, 'activity.jsonl');
  const reader = new JsonlReader(root, path);
  const data = Buffer.from(jsonl(record({ model: '模型', status: 'running' })));
  const split = data.indexOf(Buffer.from('模')) + 1;
  await writeFile(path, data.subarray(0, split));
  assert.equal((await reader.read()).records.length, 0);
  await appendFile(path, data.subarray(split));
  let result = await reader.read();
  assert.equal(result.records[0].model, '模型'); assert.equal(result.records[0].status, 'running');
  await appendFile(path, jsonl(record({ model: '模型', status: 'completed', cost: .2 })));
  result = await reader.read(); assert.equal(result.records.length, 1); assert.equal(result.records[0].cost, .2);
  assert.equal((await reader.read()).records.length, 1);
});

test('rotation, malformed lines, and deletion do not leave stale data marked connected', async t => {
  const root = await fixture(t), path = join(root, 'activity.jsonl'), reader = new JsonlReader(root, path);
  await writeFile(path, jsonl(record()) + 'broken\n');
  assert.equal((await reader.read()).invalid, 1);
  await rename(path, `${path}.old`);
  await writeFile(path, jsonl(record({ id: 'call-2' })));
  let result = await reader.read(); assert.deepEqual(result.records.map(item => item.id), ['call-2']); assert.equal(result.invalid, 0);
  await rm(path); result = await reader.read(); assert.equal(result.state, 'not_found'); assert.equal(result.records.length, 0);
});

test('refuses a symlink source outside the selected project', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await writeFile(join(outside, 'private.jsonl'), jsonl(record()));
  await symlink(join(outside, 'private.jsonl'), join(root, 'activity.jsonl'));
  const result = await new JsonlReader(root, join(root, 'activity.jsonl')).read();
  assert.equal(result.state, 'unavailable'); assert.equal(result.records.length, 0);
});

test('bounds historical import and discloses truncation', async t => {
  const root = await fixture(t), path = join(root, 'activity.jsonl');
  await writeFile(path, ' '.repeat(4 * 1024 * 1024 + 100) + '\n' + jsonl(record()));
  const result = await new JsonlReader(root, path).read();
  assert.equal(result.truncated, true); assert.equal(result.records.length, 1);
});

test('configuration restricts local endpoints and source paths and excludes unknown inventory fields', async t => {
  const root = await fixture(t), configPath = join(root, '.openmerit/terminal.json');
  assert.equal((await loadConfig(root)).ollama, 'http://127.0.0.1:11434');
  for (const config of [{ activityFile: '../elsewhere' }, { ollama: 'https://external.example' }, { ollama: 'http://user:secret@localhost:11434' }, { ollama: 'http://localhost:11434/other' }, null]) {
    await writeFile(configPath, JSON.stringify(config)); await assert.rejects(loadConfig(root));
  }
  await writeFile(configPath, JSON.stringify({ ollama: false, inventory: [{ name: 'Gateway', kind: 'gateway', token: 'secret' }] }));
  const config = await loadConfig(root); assert.equal(config.ollama, null); assert.doesNotMatch(JSON.stringify(config), /secret/);
});

test('imports audit application summaries without converting redacted token fields to zero', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.openmerit/events.jsonl'), jsonl({ id: 'event-1', type: 'automation_signal_recorded', occurredAt: new Date().toISOString(), data: { signalType: 'product_task_completed', signalId: 'signal-1', modelId: 'model', targetId: 'application', telemetry: { inputTokens: '[REDACTED]', outputTokens: 20, cost: .12, durationMs: 150 } } }));
  const collect = createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: null, inventory: [] });
  const result = await collect();
  assert.equal(result.records.length, 1); assert.equal(result.records[0].inputTokens, null); assert.equal(result.records[0].cost, .12); assert.equal(result.records[0].sourceId, 'openmerit');
  assert.equal(result.machine.cpuPercent, null);
});

test('explicit activity retains old requests, excludes future dates and takes precedence over audit summaries', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.openmerit/events.jsonl'), jsonl({ id: 'event-1', type: 'automation_signal_recorded', occurredAt: new Date().toISOString(), data: { signalType: 'product_task_completed', signalId: 'signal-1', modelId: 'model', telemetry: { cost: .12 } } }));
  await writeFile(join(root, '.openmerit/inference.jsonl'), jsonl(record({ cost: .12 })) + jsonl(record({ id: 'old', occurredAt: '2020-01-01T00:00:00Z', cost: 100 })) + jsonl(record({ id: 'future', occurredAt: '2999-01-01T00:00:00Z' })));
  const collect = createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: null, inventory: [] });
  const result = await collect(); assert.equal(result.records.length, 2); assert.equal(result.records[0].sourceId, 'activity');
  assert.equal(result.history.first, '2020-01-01T00:00:00.000Z'); assert.equal(result.history.coverage, 'available');
  assert.equal((await collect()).records.length, 2);
  assert.match(result.sources.find(source => source.id === 'openmerit').note, /avoid counting/);
});

test('Ollama collection only calls inventory endpoints and separates installed from loaded models', async t => {
  const root = await fixture(t), paths = [];
  const runtime = createServer((req, res) => { paths.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: req.url === '/api/ps' ? [{ name: 'loaded', size_vram: 1024 }] : [{ name: 'installed' }, { name: 'loaded' }] })); });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => runtime.close(resolve)));
  const collect = createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: `http://127.0.0.1:${runtime.address().port}`, inventory: [] });
  const result = await collect();
  assert.deepEqual(paths.sort(), ['/api/ps', '/api/tags']);
  assert.equal(result.models.find(model => model.name === 'loaded').state, 'loaded');
  assert.equal(result.models.find(model => model.name === 'installed').state, 'installed');
  assert.equal(result.records.length, 0);
});

test('loopback server exposes cached snapshots, isolates sample data, and rejects cross-origin writes and file access', async t => {
  let calls = 0;
  const terminal = await startTerminal({ port: 0, collect: async () => { calls++; return { schemaVersion: 1, mode: 'live', records: [], observedAt: new Date().toISOString() }; } });
  t.after(() => terminal.close());
  const snapshot = await fetch(`${terminal.url}/api/snapshot`);
  assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).mode, 'live');
  const sample = await (await fetch(`${terminal.url}/api/sample`)).json(); assert.equal(sample.mode, 'sample'); assert.ok(sample.records.length > 0);
  assert.deepEqual((await (await fetch(`${terminal.url}/api/snapshot`)).json()).records, []); assert.equal(calls, 1);
  assert.equal((await fetch(terminal.url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${terminal.url}/api/snapshot`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${terminal.url}/api/snapshot`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${terminal.url}/.openmerit/config.json`)).status, 404);
  const badHost = await new Promise((resolve, reject) => { const req = request(terminal.url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(badHost, 403);
  const page = await fetch(terminal.url); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await page.text(), /color-scheme.*dark/);
});

test('malformed runtime inventory is a collection gap, not an empty connected source', async t => {
  const root = await fixture(t);
  const runtime = createServer((_req, res) => res.end('null'));
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => runtime.close(resolve)));
  const snapshot = await createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: `http://127.0.0.1:${runtime.address().port}`, inventory: [] })();
  assert.equal(snapshot.sources.find(source => source.id === 'ollama').state, 'unavailable'); assert.equal(snapshot.models.length, 0);
});

test('sample data is explicitly labeled, deterministic, and never fabricates local dollar costs', () => {
  const snapshot = sampleSnapshot(1_800_000_000_000);
  assert.equal(snapshot.mode, 'sample'); assert.deepEqual(snapshot, sampleSnapshot(1_800_000_000_000));
  assert.ok(snapshot.records.every(item => item.location !== 'local' || item.cost === null));
  assert.ok(snapshot.records.every(item => Date.parse(item.occurredAt) <= 1_800_000_000_000));
  assert.equal(snapshot.machine.cpuPercent, snapshot.machine.history.at(-1).cpuPercent);
  assert.equal(snapshot.machine.memoryUsed, snapshot.machine.history.at(-1).memoryUsed);
  const paths = routeBreakdown(snapshot.records, snapshot);
  assert.ok(['direct', 'local', 'router', 'gateway', 'unknown'].every(kind => paths[kind] > 0));
  assert.equal(Object.values(paths).reduce((total, count) => total + count, 0), snapshot.records.length);
  assert.equal(snapshot.records.length, 9600);
  assert.equal(new Set(snapshot.records.map(item => item.id)).size, snapshot.records.length);
  assert.equal(new Set(snapshot.records.map(item => item.agentId)).size, 40);
  assert.equal(new Set(snapshot.records.map(item => item.taskId)).size, 140);
  assert.equal(snapshot.models.length, 21);
  assert.equal(new Set(snapshot.records.map(item => `${item.provider}:${item.model}`)).size, 21);
  assert.ok(snapshot.records.every(item => snapshot.models.some(model => model.name === item.model && model.provider === item.provider)));
  assert.ok(snapshot.records.every(item => Date.parse(item.occurredAt) >= 1_800_000_000_000 - 86400000));
  assert.deepEqual([...new Set(snapshot.records.map(item => item.status))].sort(), ['completed', 'failed', 'running']);
  assert.ok(snapshot.records.filter(item => item.status === 'running').every(item => item.outputTokens === null && item.durationMs === null && item.cost === null));
  assert.ok(snapshot.records.filter(item => item.status === 'running' && item.location === 'local').every(item => snapshot.models.some(model => model.name === item.model && model.provider === item.provider && model.state === 'loaded')));
  const taskAgents = new Map();
  for (const item of snapshot.records) { if (taskAgents.has(item.taskId)) assert.equal(item.agentId, taskAgents.get(item.taskId)); taskAgents.set(item.taskId, item.agentId); }
});

test('sampled charts break at unknown readings, missed polls, and clock reversals', () => {
  const point = (second, cpuPercent) => ({ at: new Date(second * 1000).toISOString(), cpuPercent });
  assert.deepEqual(contiguousSamples([point(0, 10), point(15, null)], 'cpuPercent', 15), []);
  assert.deepEqual(contiguousSamples([point(0, 10), point(15, null), point(30, 0), point(45, 12)], 'cpuPercent', 15), [{ time: 30, value: 0 }, { time: 45, value: 12 }]);
  assert.deepEqual(contiguousSamples([point(0, 10), point(45, 20), point(60, 30)], 'cpuPercent', 15), [{ time: 45, value: 20 }, { time: 60, value: 30 }]);
  assert.deepEqual(contiguousSamples([point(45, 10), point(30, 20)], 'cpuPercent', 15), [{ time: 30, value: 20 }]);
});

test('chart inspection returns an actual recorded sample rather than an interpolated value', () => {
  const points = [{ time: 10, value: 0 }, { time: 25, value: 92 }, { time: 40, value: 10 }];
  assert.equal(nearestSample(points, 22), points[1]);
  assert.equal(nearestSample(points, 12), points[0]);
  assert.equal(nearestSample(points, 900), points[2]);
  assert.equal(nearestSample([], 0), null);
});

test('vLLM counters retain their aggregate scope and ignore malformed or unrelated metrics', () => {
  assert.deepEqual(parseRuntimeMetrics('vllm:num_requests_running{model_name="a"} 2\nvllm:num_requests_running{model_name="b"} 3\nvllm:prompt_tokens_total 1.5e3\nvllm:generation_tokens_total NaN\nsecret 123\nvllm:num_requests_waiting -1'), { running: 5, inputTokens: 1500 });
});

test('compatible runtimes list models without implying they are loaded or generating', async t => {
  const root = await fixture(t), paths = [];
  const runtime = createServer((req, res) => { paths.push(req.url); res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'model-a' }] }) : 'vllm:num_requests_running 2\nvllm:prompt_tokens_total 42\n'); });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => runtime.close(resolve)));
  const collect = createCollector(root, { activityFile: '.openmerit/inference.jsonl', ollama: null, inventory: [], runtimes: [{ id: 'vllm', name: 'vLLM', type: 'vllm', url: `http://127.0.0.1:${runtime.address().port}` }] });
  const snapshot = await collect(); assert.equal(snapshot.models[0].state, 'available'); assert.equal(snapshot.records.length, 0); assert.equal(snapshot.runtimeStats[0].running, 2); assert.deepEqual(paths.sort(), ['/metrics', '/v1/models']);
});

test('CLI rejects invalid options and outputs valid JSON without opening a browser or server', () => {
  const cli = new URL('../src/cli.mjs', import.meta.url);
  for (const args of [['dash', '--interval', '0'], ['dash', '--port', '65536'], ['dash', '--unknown'], ['dash', '--interval']]) {
    assert.notEqual(spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' }).status, 0);
  }
  const result = spawnSync(process.execPath, [cli.pathname, 'dash', '--demo', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0); const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.mode, 'sample'); assert.equal(snapshot.records.length, 9600);
});

test('all client scripts and styling ship locally; dark mode and reduced motion are explicit', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /color-scheme:dark/);
});


test('application request coverage includes partial logs without inventing inventory usage', () => {
  assert.equal(requestCountKnown({ records: [record()], sources: [{ id: 'project-log:fixture', state: 'partial' }] }), true);
  assert.equal(requestCountKnown({ records: [], sources: [{ id: 'project-log:fixture', state: 'connected' }] }), true);
  assert.equal(requestCountKnown({ records: [], sources: [{ id: 'ollama', state: 'connected' }] }), false);
  assert.equal(requestCountKnown({ records: [], sources: [{ id: 'project-log:fixture', state: 'partial' }] }), false);
  assert.equal(requestCountKnown({ records: [], sources: [{ id: 'activity', state: 'connected' }] }), true);
});
