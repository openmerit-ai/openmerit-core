// Test the installed artifact, not source imports. No third-party test dependencies.
// Default: deterministic runtime fixture. --ollama-url: real local inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const executable = resolve(args.shift() || 'node_modules/.bin/openmerit');
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const upstream = option('--ollama-url');
const output = option('--output');
const model = option('--model') || (upstream ? 'smollm2:135m' : 'fixture-model');
if (upstream) {
  const url = new URL(upstream);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'Use a disposable loopback runtime');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
}
const root = await mkdtemp(join(tmpdir(), 'terminal-package-'));
const project = join(root, 'test-project');
await mkdir(join(project, '.openmerit'), { recursive: true });
const cleanEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
cleanEnv.HOME = root;
const checks = [];
const runtimeRequests = [];
const discoveryRequests = [];
const generations = [];
let loaded = false;
let unavailable = false;
let child;
let terminalLog = '';
const report = { mode: upstream ? 'real-ollama' : 'fixture', node: process.version, platform: process.platform, arch: process.arch, model, checks, generations, runtimeRequests };
const pass = (name, detail) => { checks.push({ name, detail }); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`); };
const json = value => `${JSON.stringify(value)}\n`;
const listen = server => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => yes(server.address().port)); });
const close = server => new Promise(yes => { server.close(yes); server.closeAllConnections(); });
const httpStatus = (url, options) => new Promise((yes, no) => {
  const request = httpRequest(url, options, response => { response.resume(); response.once('end', () => yes(response.statusCode)); });
  request.once('error', no); request.end();
});
async function command(commandArgs) {
  const process = spawn(executable, commandArgs, { cwd: project, env: cleanEnv });
  let stdout = '', stderr = '';
  process.stdout.on('data', data => stdout += data);
  process.stderr.on('data', data => stderr += data);
  const [code] = await once(process, 'exit');
  return { code, stdout, stderr };
}
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(200);
  }
  throw new Error(`${label} timed out. ${error?.message || ''}\n${terminalLog}`);
}
async function generate(label) {
  if (!upstream) { loaded = true; return { prompt_eval_count: 12, eval_count: 8, total_duration: 1e8 }; }
  const response = await fetch(`${upstream}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'In one sentence, what is a computer?', stream: false, keep_alive: '5m', options: { num_predict: 32, num_ctx: 1024, num_thread: 2, temperature: 0, seed: 42 } }),
    signal: AbortSignal.timeout(90000),
  });
  assert.equal(response.status, 200, 'The test application can generate independently');
  const result = await response.json();
  assert.equal(result.done, true);
  assert.ok(result.eval_count > 0 && result.prompt_eval_count > 0 && result.total_duration > 0);
  assert.ok(result.response.length > 0);
  generations.push({ label, inputTokens: result.prompt_eval_count, outputTokens: result.eval_count, durationMs: result.total_duration / 1e6 });
  return result;
}
const discoveryRuntime = createServer((request, response) => {
  discoveryRequests.push(`${request.method} ${request.url}`);
  if (request.method === 'GET' && request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(json({ data: [{ id: 'discovered-model' }] })); }
  else { response.writeHead(404); response.end(); }
});
const runtime = createServer(async (request, response) => {
  runtimeRequests.push(`${request.method} ${request.url}`);
  // This observation proxy exists only in the test. It guards the discovery API;
  // application inference goes directly to Ollama and never through the terminal.
  if (unavailable) { response.writeHead(503); response.end(); return; }
  if (request.method !== 'GET' || !['/api/tags', '/api/ps'].includes(request.url)) { response.writeHead(405); response.end(); return; }
  try {
    if (upstream) {
      const result = await fetch(`${upstream}${request.url}`, { signal: AbortSignal.timeout(2000) });
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(json({ models: request.url === '/api/ps' && !loaded ? [] : [{ name: model, size_vram: 0, details: { parameter_size: 'fixture' } }] }));
    }
  } catch { response.writeHead(503); response.end(); }
});
try {
  const discoveryPort = await listen(discoveryRuntime);
  const declarations = `OPENAI_BASE_URL=http://127.0.0.1:${discoveryPort}/v1\nGROQ_API_KEY=fixture-secret-never-export\n`;
  await writeFile(join(project, '.env'), declarations);
  await writeFile(join(project, 'package.json'), json({ dependencies: { '@anthropic-ai/sdk': 'fixture' } }));
  const autoCommand = await command(['dash', '--json']);
  assert.equal(autoCommand.code, 0, autoCommand.stderr);
  const automatic = JSON.parse(autoCommand.stdout);
  assert.equal(automatic.discovery.enabled, true);
  assert.ok(automatic.models.some(item => item.name === 'discovered-model' && item.provider === `http://127.0.0.1:${discoveryPort}`));
  assert.ok(automatic.inventory.some(item => item.name === 'Groq' && item.sourceId === 'project:.env'));
  assert.ok(automatic.sources.some(item => item.id === 'project:package.json' && item.state === 'detected'));
  assert.equal(automatic.records.length, 0);
  assert.doesNotMatch(autoCommand.stdout, /fixture-secret-never-export/);
  assert.equal(await readFile(join(project, '.env'), 'utf8'), declarations);
  assert.deepEqual(discoveryRequests.sort(), ['GET /metrics', 'GET /v1/models']);
  await rm(join(project, '.env')); await rm(join(project, 'package.json'));
  pass('Automatic project and runtime discovery without terminal configuration; SDK hints and secrets remain separate from usage');
  const runtimePort = await listen(runtime);
  const configPath = join(project, '.openmerit/terminal.json');
  const config = json({ ollama: `http://127.0.0.1:${runtimePort}` });
  await writeFile(configPath, config);
  assert.match((await command(['--help'])).stdout, /openmerit dash/);
  assert.equal((await command(['dash', '--interval', '9'])).code, 1);
  const firstCommand = await command(['dash', '--json']);
  assert.equal(firstCommand.code, 0, firstCommand.stderr);
  const first = JSON.parse(firstCommand.stdout);
  assert.equal(first.mode, 'live');
  assert.equal(first.project.name, 'test-project');
  assert.equal(first.machine.hostname, hostname());
  assert.equal(first.models.find(item => item.name === model)?.state, 'installed');
  assert.equal(first.records.length, 0);
  assert.equal(first.inventory.length, 0, 'No ambient provider credentials or invented connections');
  pass('Installed CLI, JSON output, argument validation, runtime inventory, actual hostname');

  const portReservation = createServer();
  const port = await listen(portReservation);
  await close(portReservation);
  const base = `http://127.0.0.1:${port}`;
  child = spawn(executable, ['dash', '--port', String(port), '--interval', '10'], { cwd: project, env: cleanEnv });
  child.stdout.on('data', data => terminalLog += data);
  child.stderr.on('data', data => terminalLog += data);
  const snapshot = async () => { const response = await fetch(`${base}/api/snapshot`); assert.equal(response.status, 200); return response.json(); };
  await until(snapshot, 'Terminal startup');
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.deepEqual(info, { version: 1, defaultMode: 'live', interval: 10 });
  const page = await fetch(base);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /app.js/);
  for (const asset of ['/app.js', '/styles.css', '/favicon.svg', '/brands/ollama.png', '/brands/openai.png']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 50, asset);
  }
  for (const [path, options, status] of [
    ['/api/snapshot', { method: 'POST' }, 405],
    ['/api/snapshot', { headers: { Origin: 'https://unrelated.example' } }, 403],
    ['/api/snapshot', { headers: { Host: 'unrelated.example' } }, 403],
    ['/api/snapshot', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    ['/.openmerit/terminal.json', {}, 404],
  ]) assert.equal(await httpStatus(`${base}${path}`, options), status, JSON.stringify(options));
  const reads = runtimeRequests.length;
  await Promise.all(Array.from({ length: 20 }, snapshot));
  assert.equal(runtimeRequests.length, reads, 'Browser reads use the cached snapshot');
  const sample = await (await fetch(`${base}/api/sample`)).json();
  assert.equal(sample.mode, 'sample');
  assert.equal(sample.records.length, 9600);
  assert.equal((await snapshot()).records.length, 0);
  pass('Bundled assets, read-only HTTP boundary, cached reads, sample isolation');

  await generate('without-export');
  const discovered = await until(async () => { const s = await snapshot(); return s.models.find(item => item.name === model)?.state === 'loaded' && s; }, 'Loaded inventory');
  assert.equal(discovered.records.length, 0);
  pass('Loaded model discovered without inventing request history or agents');

  const activityPath = join(project, '.openmerit/inference.jsonl');
  // The running lifecycle case is intentionally a supplied metadata fixture.
  // Actual completed records below use measured counters from the local model.
  const lifecycle = { id: 'lifecycle-fixture', occurredAt: new Date().toISOString(), model, provider: 'Ollama', workload: 'package-smoke', agentId: 'test-agent', taskId: 'test-task', route: 'Ollama', routeKind: 'local', location: 'local', status: 'running' };
  await writeFile(activityPath, json(lifecycle));
  const running = await until(async () => { const s = await snapshot(); return s.records.find(r => r.id === lifecycle.id)?.status === 'running' && s; }, 'Running metadata import');
  assert.equal(running.records[0].agent, null);
  assert.equal(running.records[0].task, null);
  assert.equal(running.records[0].cost, null);
  await appendFile(activityPath, json({ ...lifecycle, status: 'completed' }));
  const expected = [];
  for (let index = 0; index < 2; index++) {
    const measurement = await generate(`exported-${index + 1}`);
    const record = { id: `actual-${index + 1}`, occurredAt: new Date().toISOString(), model, provider: 'Ollama', workload: 'package-smoke', route: 'Ollama', routeKind: 'local', location: 'local', status: 'completed', inputTokens: measurement.prompt_eval_count, outputTokens: measurement.eval_count, durationMs: measurement.total_duration / 1e6 };
    expected.push(record);
    await appendFile(activityPath, json({ ...record, prompt: 'private-payload-canary', response: 'private-payload-canary', headers: { Authorization: 'private-payload-canary' } }));
  }
  const sourceBefore = await readFile(activityPath, 'utf8');
  const completed = await until(async () => { const s = await snapshot(); return s.records.length === 3 && s.records.find(r => r.id === lifecycle.id)?.status === 'completed' && s; }, 'Completed metadata import');
  for (const expectedRecord of expected) {
    const actual = completed.records.find(r => r.id === expectedRecord.id);
    for (const key of ['inputTokens', 'outputTokens', 'durationMs']) assert.equal(actual[key], expectedRecord[key]);
    assert.equal(actual.agentId, null);
    assert.equal(actual.taskId, null);
    assert.equal(actual.cost, null);
  }
  assert.doesNotMatch(JSON.stringify(completed), /private-payload-canary|Authorization/);
  assert.equal(await readFile(activityPath, 'utf8'), sourceBefore);
  assert.equal(await readFile(configPath, 'utf8'), config);
  report.snapshot = completed;
  pass('Measured counters preserved; metadata updates deduplicate; no invented names/costs; payload omitted; files unchanged');

  await rm(activityPath);
  unavailable = true;
  const missing = await until(async () => { const s = await snapshot(); return s.records.length === 0 && s.sources.find(item => item.id === 'ollama')?.state === 'unavailable' && s; }, 'Deleted feed and runtime outage');
  assert.equal(missing.sources.find(item => item.id === 'activity').state, 'not_found');
  assert.equal(missing.models.length, 0);
  pass('Deleted source and runtime outage clear unavailable data');
  unavailable = false;
  await until(async () => (await snapshot()).models.some(item => item.state === 'loaded'), 'Runtime recovery');
  pass('Runtime recovery on the next passive poll');

  const inFlight = generate('terminal-shutdown');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
  child = undefined;
  await inFlight;
  const afterStop = runtimeRequests.length;
  await delay(1200);
  assert.equal(runtimeRequests.length, afterStop);
  assert.ok(runtimeRequests.every(request => ['GET /api/tags', 'GET /api/ps'].includes(request)));
  await assert.rejects(fetch(`${base}/api/snapshot`));
  pass('Inference succeeds across terminal shutdown; collector makes only inventory GETs');
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
  await close(runtime);
  await close(discoveryRuntime);
  if (output) { await mkdir(resolve(output), { recursive: true }); await writeFile(join(resolve(output), 'terminal-smoke.json'), JSON.stringify(report, null, 2)); }
  await rm(root, { recursive: true, force: true });
}
