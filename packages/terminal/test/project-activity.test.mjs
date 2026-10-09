import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectActivity, projectActivityRecord } from '../src/project-activity.mjs';
import { reconcileActivity } from '../src/activity-merge.mjs';
import { createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { createAccess } from '../src/access.mjs';
import { createPiHistory, piUsageRecord } from '../src/pi-history.mjs';

const now = () => new Date().toISOString();
const line = value => JSON.stringify(value) + '\n';
const request = (overrides = {}) => ({ id: 'worker-request-1', requestId: 'api-response-1', occurredAt: now(), model: 'model-1', provider: 'serving-company', route: 'edge', routeKind: 'gateway', workload: 'worker.code', agentId: 'worker.code', taskId: 'task-1', status: 'completed', inputTokens: 12, outputTokens: 3, cost: .001, costKind: 'reported', usage: { prompt_tokens: 12, completion_tokens: 3, cost: .001 }, output: 'PRIVATE_OUTPUT', headers: { authorization: 'SECRET' }, ...overrides });
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-existing-load-'))), root = join(base, 'project'), home = join(base, 'home');
  await mkdir(root); await mkdir(home); await mkdir(join(root, '.openmerit')); await mkdir(join(root, 'runs', 'batch'), { recursive: true });
  t.after(() => rm(base, { force: true, recursive: true }));
  return { root, base, home, file: join(root, 'runs', 'batch', 'results.jsonl'), access: createAccess(root, { home, env: {} }) };
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

test('fresh collector discovers existing logs and native Pi without a terminal export or project configuration', async t => {
  const f = await fixture(t); noRuntime(t);
  const cloud = request(); await writeFile(f.file, line(cloud));
  await mkdir(f.access.path, { recursive: true });
  const entry = { type: 'message', id: 'local-1', timestamp: now(), message: { role: 'assistant', model: 'local-model', provider: 'Ollama', stopReason: 'stop', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, content: 'PRIVATE_OUTPUT' } };
  await writeFile(join(f.access.path, 'session.jsonl'), line({ type: 'session', id: 'session', version: 3, cwd: f.root }) + line(entry));
  const config = await loadConfig(f.root); config.ollama = null;
  let snapshot = await createCollector(f.root, config, 15, { access: f.access })();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.sources.find(source => source.id === 'pi-history').state, 'needs_access');
  await f.access.set(true);
  const collect = createCollector(f.root, config, 15, { access: f.access });
  snapshot = await collect(); assert.equal(snapshot.records.length, 2); assert.equal(snapshot.discovery.requestSource, 'combined');
  assert.equal(snapshot.records.find(record => record.agentId)?.agentId, 'worker.code');
  // Restoring a copied feed must not duplicate either the native or log request.
  const local = piUsageRecord(entry, 'session', normalizeRecord);
  await writeFile(join(f.root, '.openmerit/inference.jsonl'), line(cloud) + line(local));
  snapshot = await collect(); assert.equal(snapshot.records.length, 2); assert.equal(snapshot.discovery.reconciliation.duplicates, 2);
  assert.ok(snapshot.records.every(record => record.sourceIds.length === 2));
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|PRIVATE_OUTPUT/);
  await rm(join(f.root, '.openmerit/inference.jsonl')); await f.access.set(false);
  snapshot = await collect(); assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].id, cloud.id);
  config.discovery = false;
  snapshot = await createCollector(f.root, config, 15, { access: f.access })(); assert.equal(snapshot.records.length, 0);
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
  const result = await read(); assert.equal(result.records.length, 0); assert.equal(result.sources[0].state, 'partial');
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

test('native Pi history can recover all 36 existing sessions on a fresh startup', async t => {
  const f = await fixture(t); await mkdir(f.access.path, { recursive: true }); await f.access.set(true);
  for (let i = 0; i < 36; i++) await writeFile(join(f.access.path, `${i}.jsonl`), line({ type: 'session', id: `session-${i}`, version: 3, cwd: f.root }) + line({ type: 'message', id: 'entry', timestamp: now(), message: { role: 'assistant', model: 'local-model', provider: 'Ollama', stopReason: 'stop', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } } }));
  const result = await createPiHistory(f.access, normalizeRecord)();
  assert.equal(result.records.length, 36); assert.equal(result.source.state, 'connected');
});
