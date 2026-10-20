import { readFile, writeFile, mkdir, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { agents } from './adapters.mjs';

export const configPath = '.openmerit/eval.json';
export const statePath = '.openmerit/eval';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function saveJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path);
}
const text = v => typeof v === 'string' && v.trim().length > 0;
const id = v => text(v) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v);
function requireThat(ok, message) { if (!ok) throw new Error(`Eval config: ${message}`); }
export function safePath(path) {
  requireThat(text(path) && !isAbsolute(path) && !path.split(/[\\/]/).some(p => ['..', '.', '.git', '.openmerit', 'node_modules'].includes(p) || p.startsWith('.env')), `unsafe file path ${path}. Use explicit project-relative source/fixture paths, without secrets or symlinks.`);
  return path;
}
export function validateConfig(config) {
  requireThat(config.version === 1, 'version must be 1.');
  requireThat([null, 'existing', 'all'].includes(config.scope), 'scope must be null, existing or all.');
  requireThat(Array.isArray(config.connections) && config.connections.length <= 100, 'connections must be a list of up to 100 routes.');
  requireThat(new Set(config.connections.map(c => c.id)).size === config.connections.length, 'connection IDs must be unique.');
  for (const c of config.connections) {
    requireThat(id(c.id) && agents.includes(c.agent) && text(c.scoutId) && text(c.model), 'each connection needs id, scoutId, agent and native model.');
    requireThat(!c.model.startsWith('-') && c.model.length <= 200, 'invalid native model.');
    requireThat(c.env === undefined || Array.isArray(c.env) && c.env.every(k => /^[A-Z][A-Z0-9_]*$/.test(k)), 'env contains variable names, never credential values.');
    requireThat(c.command === undefined || text(c.command), 'command must be an executable path.');
  }
  requireThat(Array.isArray(config.tasks) && config.tasks.length > 0 && config.tasks.length <= 30, 'provide 1–30 tasks.');
  requireThat(new Set(config.tasks.map(t => t.id)).size === config.tasks.length, 'task IDs must be unique.');
  for (const t of config.tasks) {
    requireThat(id(t.id) && text(t.description) && t.description.length <= 4000 && text(t.prompt), 'each task needs id, description for Scout and a local execution prompt.');
    safePath(t.fixture); safePath(t.grader);
  }
  requireThat(Array.isArray(config.variants) && config.variants.length > 0 && config.variants.length <= 5, 'provide 1–5 variants.');
  requireThat(new Set(config.variants.map(v => v.id)).size === config.variants.length, 'variant IDs must be unique.');
  for (const v of config.variants) {
    requireThat(id(v.id) && Array.isArray(v.files) && typeof v.instructions === 'string', 'each variant needs id, files and instructions.');
    v.files.forEach(safePath);
  }
  requireThat(Number.isInteger(config.repeats?.min) && Number.isInteger(config.repeats?.max) && config.repeats.min >= 3 && config.repeats.max <= 10 && config.repeats.min <= config.repeats.max, 'repeats must be between 3 and 10.');
  requireThat((config.budget?.maxUsd === 'unlimited' || Number.isFinite(config.budget?.maxUsd) && config.budget.maxUsd >= 0) && (config.budget.reservationUsd === 'auto' || Number.isFinite(config.budget.reservationUsd) && config.budget.reservationUsd > 0), 'set nonnegative maxUsd or explicit "unlimited", and reservationUsd to "auto" or a positive amount.');
  requireThat(Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds >= 1 && config.timeoutSeconds <= 1800, 'timeoutSeconds must be 1–1800.');
  if (config.scoutURL !== undefined) {
    const url = new URL(config.scoutURL);
    requireThat(!url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'scoutURL requires HTTPS, or HTTP on loopback for development.');
  }
  return config;
}
export async function loadConfig(root) { return validateConfig(await readJSON(join(root, configPath))); }

export function reservationFor(config, plan) {
  if (config.budget.reservationUsd !== 'auto') return config.budget.reservationUsd;
  const attempts = plan.tasks.reduce((total, task) => total + task.candidates.reduce((n, model) => n + model.connections.length, 0), 0) * config.variants.length * config.repeats.min;
  return config.budget.maxUsd === 'unlimited' || config.budget.maxUsd === 0 ? .25 : Math.min(.25, config.budget.maxUsd / Math.max(1, attempts));
}

// Snapshot exact bytes before executing; edits during a run belong to the next revision.
export async function filesAt(root, paths) {
  const files = Object.create(null); let bytes = 0; const canonicalRoot = await realpath(root);
  async function visit(path) {
    safePath(path);
    const full = resolve(root, path), info = await lstat(full);
    if (info.isSymbolicLink() || relative(canonicalRoot, await realpath(full)).startsWith('..')) throw new Error(`Eval refuses symlink/outside path: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await visit(join(path, name));
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > 25_000_000) throw new Error('Eval fixture/source snapshot exceeds 25 MB. Select smaller paths.');
      files[path] = { data: (await readFile(full)).toString('base64'), executable: !!(info.mode & 0o111) };
    } else throw new Error(`Eval requires regular files: ${path}`);
  }
  for (const path of paths) await visit(path);
  return files;
}
export async function snapshot(root, config) {
  const tasks = [];
  for (const task of config.tasks) {
    if (!(await lstat(join(root, task.fixture))).isDirectory() || !(await lstat(join(root, task.grader))).isFile()) throw new Error(`${task.id}: fixture must be a directory and grader a standalone file.`);
    tasks.push({ ...task, fixtureFiles: await filesAt(root, [task.fixture]), graderFiles: await filesAt(root, [task.grader]) });
  }
  const variants = [];
  for (const variant of config.variants) variants.push({ ...variant, sourceFiles: await filesAt(root, variant.files) });
  for (const task of tasks) for (const variant of variants) {
    const fixtureNames = new Set(Object.keys(task.fixtureFiles).map(path => relative(task.fixture, path)));
    if (Object.keys(variant.sourceFiles).some(path => fixtureNames.has(path))) throw new Error(`${variant.id} overwrites a fixture file for ${task.id}. Keep CLI files and task inputs separate.`);
  }
  const compatibility = digest({ tasks, connections: config.connections, repeats: config.repeats, variantIds: variants.map(v => v.id), timeoutSeconds: config.timeoutSeconds });
  return { tasks, variants, compatibility, revision: digest({ tasks, variants, config }) };
}
export async function materialize(files, dest, strip = '') {
  for (const [path, file] of Object.entries(files)) {
    const target = join(dest, strip ? relative(strip, path) : path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.data, 'base64'), { mode: file.executable ? 0o700 : 0o600 });
  }
}

export const starter = {
  version: 1, scope: null, connections: [],
  tasks: [{ id: 'json', description: 'Extract a customer name and item count from text into a strict JSON object.', prompt: 'Read request.txt. Return only JSON with keys name (string) and count (number).', fixture: 'eval/fixtures/json', grader: 'eval/grade.mjs' }],
  variants: [{ id: 'bare', files: [], instructions: '' }, { id: 'cli', files: ['eval/tool.mjs'], instructions: 'You can use node eval/tool.mjs request.txt to extract the fields.' }],
  repeats: { min: 3, max: 10 }, budget: { maxUsd: 0, reservationUsd: 'auto' }, timeoutSeconds: 180,
};
