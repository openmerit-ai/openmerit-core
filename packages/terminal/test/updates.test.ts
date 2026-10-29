import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { configureUpdates, removeUpdates, runUpdate, updateContract, updatePaths } from '../src/updates.ts';

const exec = promisify(execFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const oldSkill = '---\nname: openmerit-scout\ndescription: Consult Scout for models.\n---\nOld instructions.\n';
const nextSkill = oldSkill.replace('Old instructions.', 'Updated instructions.');
const oldRule = '# Scout\nOriginal rule.\n', nextRule = '# Scout\nUpdated rule.\n';
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

async function fixture(t: TestContext, scope = 'user') {
  const root = await mkdtemp(join(tmpdir(), "openmerit updates ' "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, '.claude'), paths = updatePaths(base, scope);
  await mkdir(join(base, 'skills/openmerit-scout'), { recursive: true });
  await mkdir(join(base, 'rules'));
  await writeFile(paths.skill, oldSkill); await writeFile(paths.rule, oldRule);
  const personalHook = { hooks: [{ type: 'command', command: 'echo personal' }] };
  await writeFile(paths.settings, JSON.stringify({ permissions: { deny: ['Bash(rm *)'] }, hooks: { Stop: [personalHook] } }));
  const record = { version: 3, scope, serverHash: 'unchanged-mcp', skillHash: hash(oldSkill), ruleHash: hash(oldRule) };
  await writeFile(paths.record, JSON.stringify(record));
  const updates = await configureUpdates(base, scope, record, '0.1.9', true);
  await writeFile(paths.record, JSON.stringify({ ...record, updates }));
  return { base, root, paths, personalHook, record: { ...record, updates } };
}

// Real npm archive, including an install script which must never execute.
async function release(root: string, changes: Record<string, unknown> = {}) {
  const version = '0.1.10', dir = await mkdtemp(join(root, 'release-'));
  await mkdir(join(dir, 'dist/terminal'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'openmerit', version, scripts: { install: 'echo UNSAFE > executed' } }));
  await writeFile(join(dir, 'dist/terminal/scout-update.json'), JSON.stringify({ format: 1, contract: updateContract, version, skill: nextSkill, rule: nextRule, ...changes }));
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json'], { cwd: dir });
  const packs = JSON.parse(stdout) as { filename: string }[];
  const bytes = await readFile(join(dir, packs[0]!.filename));
  const metadata = { name: 'openmerit', version, dist: { tarball: `https://registry.npmjs.org/openmerit/-/openmerit-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
  let requests = 0;
  const fetcher: typeof fetch = async input => {
    requests++;
    return String(input).endsWith('/latest') ? Response.json(metadata) : new Response(new Uint8Array(bytes));
  };
  return { fetcher, metadata, bytes, requests: () => requests, dir };
}

test('compatible stable updates replace both instructions, preserve MCP/policy/settings, and throttle numerically across restarts', async t => {
  const h = await fixture(t), r = await release(h.root), now = 1_800_000_000_000;
  await writeFile(join(h.base, 'credentials.json'), 'private credential control');
  await writeFile(join(h.root, 'scout.json'), 'project policy control');
  const settings = await readFile(h.paths.settings, 'utf8');
  const result = await runUpdate(h.base, 'user', { hook: true, fetcher: r.fetcher, now });
  assert.equal(result.status, 'updated'); assert.equal(result.version, '0.1.10');
  assert.match(result.message, /new Claude Code session/);
  assert.equal(await readFile(h.paths.skill, 'utf8'), nextSkill);
  assert.equal(await readFile(h.paths.rule, 'utf8'), nextRule);
  assert.equal((await read(h.paths.record)).serverHash, 'unchanged-mcp');
  assert.equal(await readFile(h.paths.settings, 'utf8'), settings);
  assert.equal(await readFile(join(h.base, 'credentials.json'), 'utf8'), 'private credential control');
  assert.equal(await readFile(join(h.root, 'scout.json'), 'utf8'), 'project policy control');
  await assert.rejects(readFile(join(r.dir, 'executed')), { code: 'ENOENT' });
  await assert.rejects(readFile(h.paths.backup), { code: 'ENOENT' });
  assert.equal((await runUpdate(h.base, 'user', { hook: true, fetcher: r.fetcher, now: now + 86_400_000 - 1 })).status, 'not_due');
  assert.equal(r.requests(), 2);
  assert.equal((await runUpdate(h.base, 'user', { hook: true, fetcher: r.fetcher, now: now + 86_400_000 })).status, 'current');
  assert.equal(r.requests(), 3, '0.1.10 must compare newer than 0.1.9, not lexicographically');
  // Run the installed standalone hook, not the source module, without its npx package.
  const hooks = (await read(h.paths.settings)).hooks as Record<string, { hooks: { command: string; async: boolean }[] }[]>;
  const command = hooks.SessionStart![0]!.hooks[0]!;
  assert.equal(command.async, true);
  const { stdout } = await exec('/bin/sh', ['-c', `${command.command} </dev/null`]);
  assert.equal(stdout, '', 'a cached background check is silent and exits successfully');
});

test('offline checks back off for 15 minutes and manual retry bypasses the schedule', async t => {
  const h = await fixture(t), r = await release(h.root), now = 1_800_000_000_000;
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  assert.equal((await runUpdate(h.base, 'user', { hook: true, fetcher: offline, now })).status, 'retry');
  assert.equal(await readFile(h.paths.skill, 'utf8'), oldSkill);
  assert.equal((await runUpdate(h.base, 'user', { hook: true, fetcher: r.fetcher, now: now + 899_999 })).status, 'not_due');
  assert.equal(r.requests(), 0);
  assert.equal((await runUpdate(h.base, 'user', { hook: true, fetcher: r.fetcher, now: now + 900_000 })).status, 'updated');
  assert.equal((await runUpdate(h.base, 'user', { fetcher: r.fetcher, now: now + 900_001 })).status, 'current');
  assert.equal(r.requests(), 3);
});

test('installed hooks notify on failure with a manual fallback, without blocking or repeating during backoff', async t => {
  const h = await fixture(t), preload = join(h.root, 'offline.mts');
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("offline fixture"); };\n');
  const linkedBase = join(h.root, 'linked-config');
  await symlink(h.base, linkedBase, process.platform === 'win32' ? 'junction' : 'dir');
  const invoke = async () => {
    const check = exec(process.execPath, ['--import', pathToFileURL(preload).href, join(linkedBase, 'openmerit-updater.mts'), '--base', h.base, '--scope', 'user', '--hook']);
    check.child.stdin?.end();
    return check;
  };
  const first = await invoke();
  const notice = JSON.parse(first.stdout) as { systemMessage: string };
  assert.match(notice.systemMessage, /installed version was retained/);
  assert.match(notice.systemMessage, /say “update openmerit”/);
  assert.match(notice.systemMessage, /15 minutes/);
  assert.equal(first.stderr, '');
  assert.equal(await readFile(h.paths.skill, 'utf8'), oldSkill);
  assert.equal(await readFile(h.paths.rule, 'utf8'), oldRule);
  assert.equal((await invoke()).stdout, '', 'a second hook during backoff must not repeat the notice');
  await writeFile(h.paths.state, JSON.stringify({ nextCheckAt: 0 }));
  assert.equal(JSON.parse((await invoke()).stdout).systemMessage, notice.systemMessage, 'the next eligible failed check still notifies');
});

test('stalled requests and body cancellation cannot bypass the network deadline', async t => {
  for (const stall of ['request', 'body'] as const) {
    await t.test(stall, async sub => {
      const h = await fixture(sub);
      let started!: () => void;
      const fetching = new Promise<void>(resolve => { started = resolve; });
      const fetcher: typeof fetch = async () => {
        if (stall === 'request') { started(); return new Promise<Response>(() => {}); }
        return new Response(new ReadableStream<Uint8Array>({
          pull() { started(); return new Promise<void>(() => {}); },
          cancel() { return new Promise<void>(() => {}); },
        }));
      };
      sub.mock.timers.enable({ apis: ['setTimeout'] });
      const updating = runUpdate(h.base, 'user', { hook: true, fetcher });
      await fetching;
      sub.mock.timers.tick(12_000);
      assert.equal((await updating).status, 'retry');
      assert.equal(await readFile(h.paths.skill, 'utf8'), oldSkill);
      assert.equal(await readFile(h.paths.rule, 'utf8'), oldRule);
      assert.equal((await read(h.paths.state)).status, 'retry');
    });
  }
});

test('edited files, incompatible permissions, tampering, previews and foreign download hosts leave instructions untouched', async t => {
  for (const scenario of ['edited', 'contract', 'integrity', 'preview', 'host'] as const) {
    await t.test(scenario, async sub => {
      const h = await fixture(sub), r = await release(h.root, scenario === 'contract' ? { contract: 'new-provider-permissions' } : {});
      if (scenario === 'edited') await writeFile(h.paths.skill, 'My personal edits');
      if (scenario === 'integrity') r.metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
      if (scenario === 'preview') r.metadata.version = '0.1.10-preview.1';
      if (scenario === 'host') r.metadata.dist.tarball = 'https://evil.example/package.tgz';
      const before = await readFile(h.paths.skill, 'utf8');
      const result = await runUpdate(h.base, 'user', { fetcher: r.fetcher });
      assert.equal(result.status, scenario === 'edited' ? 'conflict' : scenario === 'contract' ? 'manual_required' : 'retry');
      assert.equal(await readFile(h.paths.skill, 'utf8'), before);
      assert.equal(await readFile(h.paths.rule, 'utf8'), oldRule);
      assert.equal((await read(h.paths.record)).serverHash, 'unchanged-mcp');
    });
  }
});

test('opt-out persists, preserves personal hooks, permits manual updates and removes only owned files', async t => {
  const h = await fixture(t, 'project'), r = await release(h.root);
  assert.equal((await runUpdate(h.base, 'project', { enabled: false })).status, 'disabled');
  const disabled = await read(h.paths.settings);
  assert.deepEqual(disabled.hooks, { Stop: [h.personalHook] });
  assert.deepEqual(disabled.permissions, { deny: ['Bash(rm *)'] });
  assert.equal((await runUpdate(h.base, 'project', { hook: true, fetcher: r.fetcher })).status, 'disabled');
  assert.equal(r.requests(), 0);
  assert.equal((await runUpdate(h.base, 'project', { fetcher: r.fetcher })).status, 'updated');
  assert.equal((await runUpdate(h.base, 'project', { enabled: true })).status, 'enabled');
  const record = await read(h.paths.record);
  await writeFile(h.paths.runner, 'user modified updater');
  assert.equal((await runUpdate(h.base, 'project', { fetcher: r.fetcher })).status, 'conflict');
  await removeUpdates(h.base, 'project', record);
  assert.equal(await readFile(h.paths.runner, 'utf8'), 'user modified updater');
  assert.deepEqual((await read(h.paths.settings)).hooks, { Stop: [h.personalHook] });
});

test('interrupted writes recover the previous pair, preserve intervening user edits, and concurrent hooks serialize', async t => {
  const h = await fixture(t), r = await release(h.root);
  const backup = { record: h.record, skill: oldSkill, rule: oldRule, skillHash: hash(nextSkill), ruleHash: hash(nextRule) };
  await writeFile(h.paths.backup, JSON.stringify(backup));
  await writeFile(h.paths.skill, nextSkill); // interruption before writing the rule
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  assert.equal((await runUpdate(h.base, 'user', { fetcher: offline })).status, 'retry');
  assert.equal(await readFile(h.paths.skill, 'utf8'), oldSkill);
  assert.equal(await readFile(h.paths.rule, 'utf8'), oldRule);
  await writeFile(h.paths.backup, JSON.stringify(backup));
  await writeFile(h.paths.rule, 'user edits after crash');
  await assert.rejects(runUpdate(h.base, 'user', { fetcher: r.fetcher }), /user edits/);
  assert.equal(await readFile(h.paths.rule, 'utf8'), 'user edits after crash');
  await rm(h.paths.backup); await writeFile(h.paths.rule, oldRule);
  const dead = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await writeFile(join(h.base, 'openmerit-update.lock'), JSON.stringify({ pid: Number(dead.stdout) }));
  let releaseFetch!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFetch = resolve; });
  const fetching = new Promise<void>(resolve => { started = resolve; });
  const slow: typeof fetch = async (...args) => { started(); await blocked; return r.fetcher(...args); };
  const contenders = Promise.allSettled(Array.from({ length: 8 }, () => runUpdate(h.base, 'user', { fetcher: slow })));
  await fetching;
  await assert.rejects(runUpdate(h.base, 'user', { fetcher: r.fetcher }), /Another OpenMerit/);
  releaseFetch();
  const outcomes = await contenders;
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.status === 'updated').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 7, 'dead-lock recovery must not let stale observers delete a new live lock');
  await assert.rejects(readFile(join(h.base, 'openmerit-update.lock')), { code: 'ENOENT' });
});
