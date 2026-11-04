// Standalone updater copied into Claude's configuration directory. Only Node
// built-ins: it must survive the npx cache disappearing, without installing or
// executing code from the release it downloads.
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

type ObjectValue = Record<string, unknown>;
interface Bundle { format: number; contract: string; version: string; skill: string; rule: string }
interface UpdateRecord { enabled: boolean; version: string; runnerHash: string; hook: ObjectValue }
export const updateContract = 'scout-recommend-v1';
const registry = 'https://registry.npmjs.org/openmerit/latest';
const day = 24 * 60 * 60 * 1000;
const retry = 15 * 60 * 1000;
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const parsed = (text: string): ObjectValue => {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error('Expected a JSON object.');
  return value;
};
async function optional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (isObject(error) && error.code === 'ENOENT') return null; throw error; }
}
async function object(path: string): Promise<ObjectValue> { return parsed(await optional(path) ?? '{}'); }
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export function updatePaths(base: string, scope: string) {
  return {
    record: join(base, 'openmerit-install.json'), runner: join(base, 'openmerit-updater.mts'),
    settings: join(base, scope === 'user' ? 'settings.json' : 'settings.local.json'),
    state: join(base, 'openmerit-updates.json'), backup: join(base, 'openmerit-update-backup.json'),
    skill: join(base, 'skills/openmerit-scout/SKILL.md'), rule: join(base, 'rules/openmerit-scout.md'),
  };
}
function updateRecord(record: ObjectValue): UpdateRecord | null {
  const value = record.updates;
  if (!isObject(value) || typeof value.enabled !== 'boolean' || typeof value.version !== 'string'
    || typeof value.runnerHash !== 'string' || !isObject(value.hook)) return null;
  return value as unknown as UpdateRecord;
}

// Serialize installs, removals and hooks. A dead process's lock is recoverable;
// an active login is not mistaken for a stale updater just because it is slow.
export async function withUpdateLock<T>(base: string, work: () => Promise<T>): Promise<T> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const path = join(base, 'openmerit-update.lock');
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if (!isObject(error) || error.code !== 'EEXIST') throw error;
      // Only one process may reap a dead lock. Without this guard, two stale
      // observers can unlink each other's newly acquired live lock.
      const recoveryPath = `${path}.recovery`;
      let recovery;
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch { throw new Error('Another OpenMerit lock recovery is running. If it was interrupted, review openmerit-update.lock.recovery before removing it.'); }
      try {
        await recovery.writeFile(JSON.stringify({ pid: process.pid }));
        const text = await optional(path);
        if (text === null) continue;
        let alive = true;
        try {
          const pid = parsed(text).pid;
          if (typeof pid === 'number' && pid > 0) {
            try { process.kill(pid, 0); }
            catch (failure) { if (isObject(failure) && failure.code === 'ESRCH') alive = false; }
          } else alive = Date.now() - (await stat(path)).mtimeMs < 10 * 60_000;
        } catch { alive = Date.now() - (await stat(path)).mtimeMs < 10 * 60_000; }
        if (alive) throw new Error('Another OpenMerit install or update is running. Retry shortly.');
        await rm(path, { force: true });
      } finally { await recovery.close(); await rm(recoveryPath, { force: true }); }
    }
  }
  if (!handle) throw new Error('Another OpenMerit update is running.');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await work(); }
  finally { await handle.close(); await rm(path, { force: true }); }
}

function groups(settings: ObjectValue): ObjectValue {
  if (settings.hooks === undefined) return {};
  if (!isObject(settings.hooks)) throw new Error('Claude settings.hooks is not an object; nothing changed.');
  return settings.hooks;
}
function eventGroups(hooks: ObjectValue, event: string): unknown[] {
  const value = hooks[event];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Claude ${event} hooks are not an array; nothing changed.`);
  return value;
}
function usesRunner(group: unknown, runner: string): boolean {
  return isObject(group) && Array.isArray(group.hooks) && group.hooks.some(hook =>
    isObject(hook) && typeof hook.command === 'string' && (hook.command.includes(runner) || hook.command.includes(quote(runner))));
}
export async function inspectUpdates(base: string, scope: string, record: ObjectValue) {
  const paths = updatePaths(base, scope), saved = updateRecord(record);
  const pending = updateRecord({ updates: record.pendingUpdates });
  const owners = [saved, pending].filter(value => value !== null);
  const runner = await optional(paths.runner), settings = await object(paths.settings), hooks = groups(settings);
  const conflicts: string[] = [];
  if (runner !== null && !owners.some(owner => digest(runner) === owner.runnerHash)) conflicts.push('OpenMerit updater was edited or is not owned; nothing changed.');
  for (const event of ['SessionStart', 'Stop']) {
    for (const group of eventGroups(hooks, event)) {
      if (usesRunner(group, paths.runner) && !owners.some(owner => JSON.stringify(group) === JSON.stringify(owner.hook))) {
        conflicts.push(`OpenMerit ${event} hook was edited or is not owned; nothing changed.`);
      }
    }
  }
  const active = runner !== null && ['SessionStart', 'Stop'].every(event =>
    eventGroups(hooks, event).some(group => owners.some(owner => JSON.stringify(group) === JSON.stringify(owner.hook))));
  return { paths, saved: saved ?? pending, runner, settings, hooks, conflicts, active };
}
// Claude Code uses a shell for command hooks, including Git Bash on Windows.
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export async function configureUpdates(base: string, scope: string, record: ObjectValue, version: string, enabled: boolean) {
  const state = await inspectUpdates(base, scope, record);
  if (state.conflicts.length) throw new Error(state.conflicts.join('\n'));
  const source = await readFile(new URL('./updates.ts', import.meta.url), 'utf8');
  const hook = { hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(state.paths.runner)} --base ${quote(base)} --scope ${scope} --hook`, async: true, timeout: 150 }] };
  const hooks = { ...state.hooks };
  for (const event of ['SessionStart', 'Stop']) {
    const kept = eventGroups(hooks, event).filter(group => !usesRunner(group, state.paths.runner));
    if (enabled) kept.push(hook);
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  // Avoid clobbering settings that changed while the installer was signing in.
  const latest = await object(state.paths.settings);
  if (JSON.stringify(latest) !== JSON.stringify(state.settings)) throw new Error('Claude settings changed during setup. Retry.');
  const next = { enabled, version, runnerHash: digest(source), hook };
  await atomic(state.paths.record, { ...await object(state.paths.record), pendingUpdates: next });
  await atomic(state.paths.runner, source);
  await atomic(state.paths.settings, { ...state.settings, hooks });
  return next;
}
export async function removeUpdates(base: string, scope: string, record: ObjectValue) {
  const state = await inspectUpdates(base, scope, record);
  const hooks = { ...state.hooks };
  for (const event of ['SessionStart', 'Stop']) {
    const kept = eventGroups(hooks, event).filter(group => !state.saved || JSON.stringify(group) !== JSON.stringify(state.saved.hook));
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (state.saved) await atomic(state.paths.settings, { ...state.settings, hooks });
  const stillReferenced = ['SessionStart', 'Stop'].some(event => eventGroups(hooks, event).some(group => usesRunner(group, state.paths.runner)));
  if (!stillReferenced && state.runner !== null && state.saved && digest(state.runner) === state.saved.runnerHash) await rm(state.paths.runner, { force: true });
  await rm(state.paths.state, { force: true });
}

// Read one fixed regular file in memory, never extract archive paths onto disk.
function instructionBundle(bytes: Buffer): ObjectValue | null {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  let found: ObjectValue | null = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const rawSize = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid package archive.');
    const size = Number.parseInt(rawSize, 8), start = offset + 512;
    if (start + size > tar.length) throw new Error('Truncated package archive.');
    if (name === 'package/dist/terminal/scout-update.json') {
      if (found || size > 256 * 1024 || ![0, 48].includes(header[156] ?? -1)) throw new Error('Invalid instruction bundle.');
      found = parsed(tar.subarray(start, start + size).toString('utf8'));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return found;
}
const stableVersion = (version: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
function newer(next: string, installed: string) {
  if (!stableVersion(next) || !stableVersion(installed)) return false;
  const a = next.split('.').map(Number), b = installed.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! > b[i]!; }
  return false;
}
async function boundedFetch(url: string, max: number, fetcher: typeof fetch, timeout = 12_000): Promise<Buffer> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Update download timed out.')); }, timeout);
  });
  const download = async () => {
    const response = await fetcher(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok || !response.body || controller.signal.aborted) throw new Error('Update server unavailable.');
    const parts: Uint8Array[] = []; let size = 0;
    reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('Update download exceeded its size limit.');
      parts.push(value);
    }
    return Buffer.concat(parts);
  };
  try {
    return await Promise.race([download(), deadline]);
  } finally {
    clearTimeout(timer); controller.abort();
    // Cancellation itself must not keep a timed-out hook alive.
    void reader?.cancel().catch(() => {});
  }
}
async function recover(base: string, scope: string) {
  const paths = updatePaths(base, scope), text = await optional(paths.backup);
  if (!text) return;
  const backup = parsed(text);
  if (typeof backup.skill !== 'string' || typeof backup.rule !== 'string' || !isObject(backup.record)) throw new Error('Update recovery needs manual review.');
  for (const field of ['skill', 'rule'] as const) {
    const current = await optional(paths[field]);
    if (current !== null && digest(current) !== digest(backup[field] as string) && digest(current) !== backup[`${field}Hash`]) throw new Error('An interrupted update has user edits; nothing changed.');
  }
  // Recover the previous complete pair before any retry. Atomic per-file writes
  // plus a durable journal cover failure between the two renames.
  await atomic(paths.skill, backup.skill); await atomic(paths.rule, backup.rule);
  await atomic(paths.record, backup.record); await rm(paths.backup, { force: true });
}
export async function recoverUpdates(base: string, scope: string) { await recover(base, scope); }

interface UpdateResult { status: string; message: string; version?: string }
export async function runUpdate(base: string, scope: string, options: { hook?: boolean; enabled?: boolean; fetcher?: typeof fetch; now?: number } = {}): Promise<UpdateResult> {
  return withUpdateLock(base, async () => {
    await recover(base, scope);
    const paths = updatePaths(base, scope), record = await object(paths.record), saved = updateRecord(record);
    if (record.version !== 3 || record.scope !== scope || !saved) return { status: 'manual_required', message: 'Run npx -y openmerit@latest install --client claude-code to bootstrap updates in this scope.' };
    if (options.hook && (!saved.enabled || process.env.OPENMERIT_AUTO_UPDATE === 'off')) return { status: 'disabled', message: 'Automatic updates disabled.' };
    const now = options.now ?? Date.now(), state = options.enabled === undefined ? await object(paths.state) : {};
    if (options.hook && typeof state.nextCheckAt === 'number' && now < state.nextCheckAt) return { status: 'not_due', message: 'Update check not due.' };
    const support = await inspectUpdates(base, scope, record);
    if (support.conflicts.length) {
      if (options.hook) await atomic(paths.state, { nextCheckAt: now + day, status: 'conflict' });
      return { status: 'conflict', message: `${support.conflicts.join(' ')} Say “update openmerit” after resolving the conflict.` };
    }
    if (options.enabled !== undefined) {
      record.updates = await configureUpdates(base, scope, record, saved.version, options.enabled);
      delete record.pendingUpdates;
      await atomic(paths.record, record);
      return { status: options.enabled ? 'enabled' : 'disabled', message: `Automatic Scout instruction updates ${options.enabled ? 'enabled' : 'disabled'}. Start a new Claude Code session to reload hooks.` };
    }
    // Record the attempt before networking so a crashed hook cannot hammer npm.
    await atomic(paths.state, { ...state, nextCheckAt: now + retry });
    try {
      const fetcher = options.fetcher ?? fetch;
      const release = parsed((await boundedFetch(registry, 512 * 1024, fetcher)).toString('utf8'));
      const version = release.version;
      if (release.name !== 'openmerit' || typeof version !== 'string' || !stableVersion(version)) throw new Error('Invalid stable release metadata.');
      if (!newer(version, saved.version)) {
        await atomic(paths.state, { checkedAt: now, nextCheckAt: now + day, status: 'current' });
        return { status: 'current', version: saved.version, message: `Scout instructions ${saved.version} are current.` };
      }
      const dist = release.dist;
      const tarball = `https://registry.npmjs.org/openmerit/-/openmerit-${version}.tgz`;
      if (!isObject(dist) || dist.tarball !== tarball || typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) throw new Error('Release has no trusted SHA-512 package integrity.');
      const bytes = await boundedFetch(tarball, 16 * 1024 * 1024, fetcher, 120_000);
      if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== dist.integrity) throw new Error('Package integrity verification failed.');
      const bundle = instructionBundle(bytes);
      if (!bundle || bundle.format !== 1 || bundle.contract !== updateContract || bundle.version !== version) {
        await atomic(paths.state, { checkedAt: now, nextCheckAt: now + day, status: 'manual_required' });
        return { status: 'manual_required', version, message: `Release ${version} needs a reviewed installer upgrade. Review its changes, then run npx -y openmerit@latest install --client claude-code --scope ${scope}. Do not bypass permissions or rerun login automatically.` };
      }
      if (typeof bundle.skill !== 'string' || typeof bundle.rule !== 'string' || !bundle.skill.startsWith('---\nname: openmerit-scout\n') || !bundle.rule.trim()) throw new Error('Invalid Scout instructions.');
      const instructions = bundle as unknown as Bundle;
      const skill = await optional(paths.skill), rule = await optional(paths.rule);
      if (skill === null || rule === null || digest(skill) !== record.skillHash || digest(rule) !== record.ruleHash) {
        await atomic(paths.state, { checkedAt: now, nextCheckAt: now + day, status: 'conflict' });
        return { status: 'conflict', message: 'Scout instructions are missing or edited. Nothing changed. Say “update openmerit” after reviewing the files.' };
      }
      const skillHash = digest(instructions.skill), ruleHash = digest(instructions.rule);
      await atomic(paths.backup, { record, skill, rule, skillHash, ruleHash });
      try {
        // Do not overwrite edits made during the download or journal write.
        if (await optional(paths.skill) !== skill || await optional(paths.rule) !== rule) throw new Error('Scout instructions changed during the update.');
        await atomic(paths.skill, instructions.skill); await atomic(paths.rule, instructions.rule);
        await atomic(paths.record, { ...record, skillHash, ruleHash, updates: { ...saved, version } });
        await rm(paths.backup, { force: true });
      } catch (error) {
        try { await recover(base, scope); }
        catch { return { status: 'conflict', message: 'An interrupted Scout update could not be recovered safely. Review the installed files and openmerit-update-backup.json; no user edits were overwritten.' }; }
        throw error;
      }
      // A failed schedule write must not misreport an already applied update.
      await atomic(paths.state, { checkedAt: now, nextCheckAt: now + day, status: 'updated', version }).catch(() => {});
      return { status: 'updated', version, message: `Scout instructions updated to ${version}. Start a new Claude Code session to load them; the running session may still use its previous instructions.` };
    } catch {
      await atomic(paths.state, { nextCheckAt: now + retry, status: 'retry' });
      return { status: 'retry', message: 'Could not safely update Scout. The installed version was retained. Automatic checks retry after 15 minutes while Claude Code is in use; say “update openmerit” to retry now.' };
    }
  });
}

// Hooks deliberately never ask Claude to continue, read transcripts or emit
// blocking decisions. Offline and concurrent-hook failures exit successfully.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), base = args[args.indexOf('--base') + 1], scope = args[args.indexOf('--scope') + 1];
  if (base && ['user', 'project'].includes(scope ?? '')) {
    process.stdin.resume();
    try {
      const result = await runUpdate(resolve(base), scope!, { hook: args.includes('--hook') });
      if (['updated', 'conflict', 'manual_required', 'retry'].includes(result.status)) console.log(JSON.stringify({ systemMessage: result.message }));
    } catch { /* Maintenance cannot block the user's task. */ }
  }
}
