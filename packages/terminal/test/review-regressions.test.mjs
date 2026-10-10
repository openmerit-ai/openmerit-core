import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { JsonlReader, createCollector, loadConfig, normalizeRecord } from '../src/collect.mjs';
import { createProjectActivity } from '../src/project-activity.mjs';
import { reconcileActivity } from '../src/activity-merge.mjs';
import * as history from '../src/history.mjs';
import * as routes from '../client/routes.mjs';
import * as brands from '../client/brands.mjs';
import * as environment from '../client/environment.mjs';

const at = new Date(Date.now() - 1000).toISOString();
const request = (id, extra = {}) => ({ id, requestId: id, occurredAt: at, model: 'test-model', provider: 'service', route: 'service', status: 'completed', usage: { input_tokens: 10, output_tokens: 2 }, ...extra });
const line = value => JSON.stringify(value) + '\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-review-'));
  await mkdir(join(root, 'logs')); await mkdir(join(root, '.openmerit'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, 'logs/requests.jsonl') };
}

for (const kind of ['explicit', 'discovered']) {
  for (const variant of ['small', 'shared-prefix', 'shared-tail']) {
    test(`${kind} log rereads a growing rewrite with ${variant} contents and preserved mtime`, async t => {
      const { root, path } = await fixture(t);
      const shared = line(request('shared', { ignoredContent: 'x'.repeat(9000) }));
      const before = variant === 'shared-prefix' ? shared + line(request('old-1')) : variant === 'shared-tail' ? line(request('old-1')) + shared : line(request('old-1'));
      const after = variant === 'shared-prefix' ? shared + line(request('new-1')) + line(request('new-2')) : variant === 'shared-tail' ? line(request('new-1')) + shared + line(request('new-2')) : line(request('new-1')) + line(request('new-2'));
      await writeFile(path, before);
      const reader = new JsonlReader(root, path);
      const read = kind === 'explicit' ? () => reader.read() : createProjectActivity(root, normalizeRecord);
      assert.ok((await read()).records.some(item => item.id === 'old-1'));
      const original = await stat(path);
      await writeFile(path, after);
      await utimes(path, original.atime, original.mtime);
      assert.equal((await stat(path)).ino, original.ino);
      let result = await read();
      const expected = ['new-1', 'new-2', ...(variant === 'small' ? [] : ['shared'])];
      assert.deepEqual(result.records.map(item => item.id).sort(), expected.sort());
      assert.equal(kind === 'explicit' ? result.invalid : result.sources[0].invalid, 0);
      assert.equal(kind === 'explicit' ? result.state : result.sources[0].state, 'connected');
      // A subsequent ordinary append must not discard the rebuilt history.
      await appendFile(path, line(request('new-3')));
      result = await read();
      assert.deepEqual(result.records.map(item => item.id).sort(), [...expected, 'new-3'].sort());
      assert.equal((await read()).records.length, expected.length + 1);
    });
  }
}

test('contradictory terminal outcomes disclose status conflicts in either source order', () => {
  for (const statuses of [['completed', 'failed'], ['failed', 'completed']]) {
    const batches = statuses.map((status, i) => ({ sourceId: String(i), records: [normalizeRecord(request('same', { status }), String(i))] }));
    const result = reconcileActivity(batches);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].status, statuses[0]);
    assert.equal(result.conflicts, 1);
    assert.deepEqual(result.records[0].conflictingFields, ['status']);
    assert.deepEqual(result.records[0].sourceIds, ['0', '1']);
  }
  const running = normalizeRecord(request('same', { status: 'running' }), 'a');
  const result = reconcileActivity([{ sourceId: 'a', records: [running] }, { sourceId: 'b', records: [{ ...running, sourceId: 'b', status: 'completed' }] }]);
  assert.equal(result.records[0].status, 'completed');
  assert.equal(result.conflicts, 0);
});

test('collector surfaces outcome conflicts to the dashboard warning and request inspector', async t => {
  const { root, path } = await fixture(t);
  await writeFile(join(root, '.openmerit/inference.jsonl'), line(request('same')));
  await writeFile(path, line(request('same', { status: 'failed' })));
  const snapshot = await createCollector(root, await loadConfig(root))();
  assert.equal(snapshot.discovery.reconciliation.conflicts, 1);
  assert.equal(snapshot.records.length, 1);
  assert.deepEqual(snapshot.records[0].conflictingFields, ['status']);
});

test('resident inventory uses fresh evidence regardless of host order and expires it', async t => {
  const { root } = await fixture(t);
  const loadedModels = [{ id: 'resident-1', name: 'test-model', provider: 'service' }];
  const stale = { id: 'stale', observedAt: new Date(Date.now() - 300000).toISOString(), loadedModels };
  const fresh = { id: 'fresh', observedAt: new Date(Date.now() - 1000).toISOString(), loadedModels };
  const collect = createCollector(root, await loadConfig(root));
  for (const hosts of [[stale, fresh], [fresh, stale]]) {
    await writeFile(join(root, '.openmerit/hosts.json'), JSON.stringify({ hosts }));
    const snapshot = await collect();
    assert.equal(snapshot.models.length, 1);
    assert.equal(snapshot.models[0].state, 'loaded');
  }
  await writeFile(join(root, '.openmerit/hosts.json'), JSON.stringify({ hosts: [stale, { ...fresh, observedAt: stale.observedAt }] }));
  assert.equal((await collect()).models[0].state, 'unknown');
  await writeFile(join(root, '.openmerit/hosts.json'), JSON.stringify({ hosts: [{ ...fresh, loadedModels: [] }] }));
  assert.deepEqual((await collect()).models, []);
});

test('model details render unavailable usage without evidence and preserve measured zero', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.openmerit/terminal.json'), JSON.stringify({ inventory: [{ kind: 'model', name: 'test-model', provider: 'service', location: 'cloud' }] }));
  const collect = createCollector(root, await loadConfig(root));
  // Run the actual browser view with event wiring and the dialog mount stubbed.
  // Imported data/formatting helpers remain the production implementations.
  const source = (await readFile(new URL('../client/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('void start();', '');
  const context = vm.createContext({ ...history, ...routes, ...brands, ...environment, URLSearchParams,
    location: { hash: '#models', search: '' }, document: { querySelectorAll: () => [], documentElement: { hasAttribute: () => false }, addEventListener() {} }, window: { addEventListener() {} },
  });
  vm.runInContext(source, context);
  const render = snapshot => {
    context.snapshot = snapshot;
    vm.runInContext("state.data = snapshot; openInspector = (title, subtitle, body) => { globalThis.inspector = body; }; inspectInner('model', snapshot.models[0].id);", context);
    return context.inspector;
  };
  let snapshot = await collect();
  assert.equal(routes.requestCountKnown(snapshot), false);
  let markup = render(snapshot);
  assert.match(markup, /<dt>Observed requests<\/dt><dd>Unavailable<\/dd>/);
  assert.match(markup, /<dt>Cost coverage<\/dt><dd>Unavailable<\/dd>/);
  assert.match(markup, /Request activity is unavailable/);
  await writeFile(join(root, '.openmerit/inference.jsonl'), '');
  snapshot = await collect();
  assert.equal(routes.requestCountKnown(snapshot), true);
  markup = render(snapshot);
  assert.match(markup, /<dt>Observed requests<\/dt><dd>0<\/dd>/);
  assert.match(markup, /<dt>Cost coverage<\/dt><dd>0 of 0 requests<\/dd>/);
  await appendFile(join(root, '.openmerit/inference.jsonl'), line(request('one')));
  assert.match(render(await collect()), /<dt>Observed requests<\/dt><dd>1<\/dd>/);
});
