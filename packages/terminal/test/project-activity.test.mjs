import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectActivity, projectActivityRecord } from '../src/project-activity.mjs';
import { reconcileActivity } from '../src/activity-merge.mjs';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const now = () => new Date().toISOString();
const line = value => JSON.stringify(value) + '\n';
const request = (overrides = {}) => ({ id: 'worker-request-1', requestId: 'api-response-1', occurredAt: now(), model: 'model-1', provider: 'serving-company', route: 'edge', routeKind: 'gateway', workload: 'worker.code', agentId: 'worker.code', taskId: 'task-1', status: 'completed', inputTokens: 12, outputTokens: 3, cost: .001, costKind: 'reported', usage: { prompt_tokens: 12, completion_tokens: 3, cost: .001 }, output: 'PRIVATE_OUTPUT', headers: { authorization: 'SECRET' }, ...overrides });
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-existing-load-'))), root = join(base, 'project'), home = join(base, 'home');
  await mkdir(root); await mkdir(home); await mkdir(join(root, '.openmerit')); await mkdir(join(root, 'runs', 'batch'), { recursive: true });
  t.after(() => rm(base, { force: true, recursive: true }));
  return { root, base, home, file: join(root, 'runs', 'batch', 'results.jsonl') };
}
function noRuntime(t) { t.mock.method(globalThis, 'fetch', async () => { throw new Error('No fixture runtimes'); }); }

test('projects request metadata without outputs, secrets, invented identities, or guessed API providers', () => {
  const raw = request(), record = projectActivityRecord(raw, 'log', 'runs/b/results.jsonl', normalizeRecord);
  assert.equal(record.agentId, raw.agentId); assert.equal(record.taskId, raw.taskId);
  assert.equal(record.inputTokens, 12); assert.equal(record.cost, .001);
  assert.equal(record.evidenceFormat, 'structured-request');
  assert.doesNotMatch(JSON.stringify(record), /SECRET|PRIVATE_OUTPUT|authorization|headers|usage/);
  const native = projectActivityRecord({ id: 'resp-1', object: 'response', model: 'model-1', status: 'completed', created_at: Date.now() / 1000, usage: { input_tokens: 7, output_tokens: 4 }, output: [{ text: 'PRIVATE_OUTPUT' }] }, 'native', 'logs/api.jsonl', normalizeRecord);
  assert.equal(native.inputTokens, 7); assert.equal(native.outputTokens, 4); assert.equal(native.cost, null);
  assert.equal(native.provider, 'Unattributed'); assert.equal(native.route, 'Unattributed route');
  assert.equal(native.agentId, null); assert.equal(native.taskId, null); assert.equal(native.workload, 'logs/api.jsonl');
  const chat = projectActivityRecord({ id: 'chat-1', object: 'chat.completion', model: 'model-1', created: Date.now() / 1000, usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_OUTPUT' } }] }, 'chat', 'logs/chat.jsonl', normalizeRecord);
  assert.equal(chat.status, 'completed'); assert.equal(chat.inputTokens, 10);
  for (const value of [{ model: 'catalog-model', id: 'catalog', object: 'model' }, { ...raw, occurredAt: 'yesterday' }, { ...raw, status: 'unknown' }, { ...raw, id: 'x'.repeat(161) }, { id: 'fake', model: 'm', occurredAt: now() }]) assert.equal(projectActivityRecord(value, 'x', 'logs/x.jsonl', normalizeRecord), null);
});

test('existing logs follow appends, partial UTF-8, running updates, rotation, and deletion', async t => {
  const f = await fixture(t), read = createProjectActivity(f.root, normalizeRecord), raw = request({ model: '模型', status: 'running' });
  const bytes = Buffer.from(line(raw)), split = bytes.indexOf(Buffer.from('模')) + 1;
  await writeFile(f.file, bytes.subarray(0, split)); assert.equal((await read()).records.length, 0);
  await appendFile(f.file, bytes.subarray(split)); assert.equal((await read()).records[0].status, 'running');
  await appendFile(f.file, line({ ...raw, status: 'completed', outputTokens: 9 }));
  let result = await read(); assert.equal(result.records.length, 1); assert.equal(result.records[0].outputTokens, 9);
  await rename(f.file, f.file + '.old'); await writeFile(f.file, line(request({ id: 'new', requestId: 'api-new' })));
  result = await read(); assert.equal(result.records.length, 1); assert.equal(result.records[0].id, 'new');
  await rm(f.file); assert.equal((await read()).records.length, 0);
});

test('project log readers skip symlinks, outside paths, arbitrary directories and unsupported data', async t => {
  const f = await fixture(t), outside = join(f.base, 'private.jsonl');
  await writeFile(outside, line(request())); await symlink(outside, f.file);
  await mkdir(join(f.root, 'node_modules')); await writeFile(join(f.root, 'node_modules', 'private.jsonl'), line(request()));
  await symlink(f.base, join(f.root, 'logs'));
  const read = createProjectActivity(f.root, normalizeRecord); assert.equal((await read()).records.length, 0);
  await rm(f.file); await writeFile(f.file, 'malformed\n' + line({ messages: ['PRIVATE_OUTPUT'], model: 'm' }) + line(request({ occurredAt: '2000-01-01T00:00:00Z' })));
  const result = await read(); assert.equal(result.records.length, 1); assert.equal(result.records[0].occurredAt, '2000-01-01T00:00:00.000Z'); assert.equal(result.sources[0].state, 'partial');
  assert.equal(result.sources[0].invalid, 1); assert.equal(result.sources[0].unsupported, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTPUT|SECRET/);
});

test('large historical logs import a bounded tail and report the limitation', async t => {
  const f = await fixture(t); await writeFile(f.file, ' '.repeat(600 * 1024) + '\n' + line(request()));
  const result = await createProjectActivity(f.root, normalizeRecord)();
  assert.equal(result.records.length, 1); assert.equal(result.sources[0].state, 'partial'); assert.equal(result.sources[0].truncated, true);
});

test('deduplication preserves distinct calls, scopes response IDs, and discloses conflicting copies', () => {
  const a = normalizeRecord(request(), 'activity'), copied = { ...a, sourceId: 'log', outputTokens: 99 };
  let result = reconcileActivity([{ sourceId: 'activity', records: [a] }, { sourceId: 'log', records: [copied] }]);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].outputTokens, 3); assert.equal(result.conflicts, 1);
  assert.deepEqual(result.records[0].sourceIds, ['activity', 'log']); assert.deepEqual(result.records[0].conflictingFields, ['outputTokens']);
  result = reconcileActivity([{ sourceId: 'activity', records: [a] }, { sourceId: 'log', records: [{ ...a, id: 'other-id', requestId: 'api-other', sourceId: 'log' }] }]);
  assert.equal(result.records.length, 2); assert.equal(result.excluded, 0);
  result = reconcileActivity([{ sourceId: 'activity', records: [a] }, { sourceId: 'log', records: [{ ...a, route: 'other-edge', sourceId: 'log' }] }]);
  assert.equal(result.records.length, 2); assert.equal(new Set(result.records.map(record => record.id)).size, 2);
  result = reconcileActivity([{ sourceId: 'activity', records: [{ ...a, status: 'running' }] }, { sourceId: 'log', records: [{ ...copied, status: 'completed' }] }]);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].status, 'completed');
});

test('unresolved cross-source overlap remains separate from combined totals', () => {
  const a = normalizeRecord(request({ requestId: null }), 'activity');
  const b = { ...a, id: 'different-local-id', sourceId: 'log' };
  const result = reconcileActivity([{ sourceId: 'activity', records: [a] }, { sourceId: 'log', records: [b] }]);
  assert.equal(result.records.length, 1); assert.equal(result.excluded, 1); assert.equal(result.sources[1].records, 1); assert.equal(result.sources[1].included, 0);
});

test('application logs reconcile with explicit exports and keep application agent identities', async t => {
  const f = await fixture(t); noRuntime(t);
  const cloud = request({ scope: 'agent' });
  await writeFile(f.file, line(cloud) + line(request({ id: 'development', scope: 'development' })));
  const config = await loadConfig(f.root); config.ollama = null;
  const collect = createCollector(f.root, config);
  let snapshot = await collect();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].agentId, 'worker.code');
  assert.equal(snapshot.records[0].scope, 'agent');
  assert.ok(snapshot.discovery.requestSource.startsWith('project-log:'));
  await writeFile(join(f.root, '.openmerit/inference.jsonl'), line(cloud) + line(request({ id: 'development', scope: 'development' })));
  snapshot = await collect();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.discovery.reconciliation.duplicates, 1);
  assert.equal(snapshot.records[0].sourceIds.length, 2);
  await rm(join(f.root, '.openmerit/inference.jsonl'));
  snapshot = await collect(); assert.equal(snapshot.records.length, 1);
  config.discovery = false;
  snapshot = await createCollector(f.root, config)(); assert.equal(snapshot.records.length, 0);
});

test('normal dash ignores coding histories and legacy grants while discovering application requests', async t => {
  const f = await fixture(t);
  const app = request(); await writeFile(f.file, line(app));
  // Even a valid grant from an earlier preview must not reactivate the retired reader.
  const history = join(f.home, '.pi/agent/sessions', `--${f.root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  await mkdir(history, { recursive: true });
  await mkdir(join(f.home, '.openmerit'));
  await writeFile(join(f.home, '.openmerit/terminal-access.json'), JSON.stringify({ version: 1, grants: [{ source: 'pi', project: f.root, path: history, allowed: true }] }));
  await writeFile(join(history, 'session.jsonl'), line({ type: 'session', version: 3, id: 'session', cwd: f.root }) + line({ type: 'message', id: 'dev-call', timestamp: now(), message: { role: 'assistant', model: 'DEV_ONLY_MODEL', provider: 'dev-provider', stopReason: 'stop', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }, content: 'PRIVATE_CONVERSATION' } }));
  for (const path of ['.codex/sessions', '.claude/projects', '.local/share/opencode']) {
    await mkdir(join(f.home, path), { recursive: true });
    await writeFile(join(f.home, path, 'history.jsonl'), line(request({ id: 'dev-history', model: 'DEV_ONLY_MODEL' })));
  }
  // Project audit summaries remain available, but do not duplicate request-level evidence.
  await writeFile(join(f.root, '.openmerit/events.jsonl'), line({ type: 'automation_signal_recorded', id: 'summary', occurredAt: now(), data: { signalType: 'product_task_completed', targetId: 'app-target', modelId: 'app-model', telemetry: { inputTokens: 7, outputTokens: 2 } } }) + line({ type: 'automation_signal_recorded', id: 'harness-event', occurredAt: now(), data: { signalType: 'session_start', modelId: 'DEV_ONLY_MODEL' } }));
  const run = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'dash', f.root, '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HOME: f.home, PI_CODING_AGENT_DIR: join(f.home, '.pi/agent') } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /DEV_ONLY_MODEL|PRIVATE_CONVERSATION|pi-history|terminal-access|Needs access|SECRET|PRIVATE_OUTPUT/);
    return JSON.parse(result.stdout);
  };
  let snapshot = run();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].id, app.id);
  await rm(f.file);
  snapshot = run();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].workload, 'app-target');
  assert.equal(snapshot.discovery.requestSource, 'openmerit');
});


test('a dormant project retains historical Groq request evidence across polls and restart', async t => {
  const f = await fixture(t); noRuntime(t);
  const old = request({ occurredAt: '2020-03-15T09:00:00Z', provider: 'Groq', route: 'Groq', routeKind: 'direct' });
  const file = line(old) + line({ ...old, id: 'future', requestId: 'future', occurredAt: '2999-01-01T00:00:00Z' });
  await writeFile(f.file, file);
  await writeFile(join(f.root, '.env'), 'GROQ_API_KEY=TEST_ONLY_NOT_A_KEY\n');
  const config = await loadConfig(f.root), collect = createCollector(f.root, config);
  for (const snapshot of [await collect(), await collect(), await createCollector(f.root, config)()]) {
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.history.first, '2020-03-15T09:00:00.000Z');
    assert.equal(snapshot.history.last, snapshot.history.first);
    assert.equal(snapshot.history.coverage, 'available');
    assert.ok(snapshot.inventory.some(item => item.name === 'Groq'));
    assert.ok(snapshot.models.some(item => item.provider === 'Groq'));
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_ONLY_NOT_A_KEY|PRIVATE_OUTPUT|SECRET/);
  }
});

test('All time discloses partial history when bounded import drops older evidence', async t => {
  const f = await fixture(t); noRuntime(t);
  await writeFile(f.file, ' '.repeat(600 * 1024) + '\n' + line(request({ occurredAt: '2020-03-15T09:00:00Z' })));
  const snapshot = await createCollector(f.root, await loadConfig(f.root))();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.history.coverage, 'partial');
  assert.equal(snapshot.history.first, '2020-03-15T09:00:00.000Z');
  assert.ok(snapshot.sources.some(source => source.truncated));
});
