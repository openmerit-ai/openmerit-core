import { mkdir, open, realpath, stat, lstat, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export function piSessionPath(project, home = homedir(), env = process.env) {
  // Only explicit process settings can change the tool's home; project config cannot.
  const configured = env.PI_CODING_AGENT_DIR;
  const agent = configured ? resolve(configured.startsWith('~/') ? join(home, configured.slice(2)) : configured) : join(home, '.pi', 'agent');
  return join(agent, 'sessions', `--${resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}
export function createAccess(project, { home = homedir(), env = process.env } = {}) {
  const path = piSessionPath(project, home, env), directory = join(home, '.openmerit'), file = join(directory, 'terminal-access.json');
  const identity = async () => ({ project: await realpath(project), path: await realpath(path) });
  async function entries() {
    try {
      const canonical = await realpath(file), root = await realpath(project), base = await realpath(directory);
      if (inside(root, canonical) || canonical !== join(base, 'terminal-access.json')) return [];
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (process.getuid && info.uid !== process.getuid())) return [];
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      let value; try { const buffer = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > 64 * 1024) return []; value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } finally { await handle.close(); }
      return value.version === 1 && Array.isArray(value.grants) ? value.grants.slice(0, 200) : [];
    } catch { return []; }
  }
  async function status() {
    let target;
    try { target = await identity(); if (!(await stat(target.path)).isDirectory()) return { state: 'not_found', path }; }
    catch (error) { return { state: error.code === 'ENOENT' ? 'not_found' : 'unavailable', path }; }
    const grant = (await entries()).find(item => item.source === 'pi' && item.project === target.project && item.path === target.path);
    return { ...target, state: grant?.allowed === true ? 'allowed' : grant?.allowed === false ? 'denied' : 'needs_access' };
  }
  async function set(allowed) {
    const target = allowed ? await identity() : { project: await realpath(project), path: await realpath(path).catch(() => resolve(path)) };
    // Never accept repo-controlled grants, including when the project is the home directory.
    if (inside(target.project, resolve(file))) throw new Error('Access choices must be stored outside the selected project. Choose a project below your home directory.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const base = await realpath(directory);
    if (inside(target.project, base)) throw new Error('Access storage resolves inside the project.');
    const grants = (await entries()).filter(item => !(item.source === 'pi' && item.project === target.project)).slice(-199);
    grants.push({ source: 'pi', ...target, allowed, updatedAt: new Date().toISOString() });
    const temp = join(base, `.terminal-access-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, grants }, null, 2)); } finally { await handle.close(); }
    try { await rename(temp, join(base, 'terminal-access.json')); } finally { await rm(temp, { force: true }); }
  }
  return { path, file, status, set };
}
