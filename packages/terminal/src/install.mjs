import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBrowser } from './browser.mjs';

// One-command coding-agent setup: device sign-in in the browser, then the MCP
// server and Scout skill. Built to be run by a person or by a coding agent:
// no interactive prompts, bounded waits, resumable logins and explicit exit codes.
export const exitCodes = { ok: 0, error: 1, pending: 10, denied: 11, conflict: 20, unreachable: 30 };
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const policyPath = '.openmerit/scout.json';
const clients = { 'claude-code': 'Claude Code' };

export const skill = `---
name: openmerit-scout
description: Use when choosing, adding, replacing or configuring an application inference model (an LLM or other model the user's application calls), for example when building extraction, classification, generation or agent features. Consults OpenMerit Scout for an evidence-based shortlist. Not for unrelated edits, ordinary inference calls or this coding agent's own model.
---

# OpenMerit · Scout

Before introducing, recommending, replacing or configuring an application
inference model, call the \`scout_models\` tool on the \`openmerit\` MCP server.
This applies even when the user never mentions Scout. Preserve the user's explicit
model choice; assess it rather than silently replacing it. Leave unchanged,
approved application selections in place.

## Project policy

Read \`${policyPath}\` before searching. If it is absent, ask once whether this
project uses **existing-only** (only endpoints it can already reach) or
**existing-first** (prefer them, ask before searching the whole catalogue), and
which public catalogue endpoint IDs it can access. Save the answer:

\`\`\`sh
npx -y openmerit@preview project --policy existing-only --endpoint-id <id> ...
\`\`\`

Never infer access from a model name, SDK or environment-variable name. Never
record credentials, private URLs, prompts or customer data. An empty inventory
is not permission to search all models.

## Searching

Call \`scout_models\` with a non-confidential task description and
\`endpointIds\` set to the saved inventory, including \`[]\` when empty.
Existing-only never broadens. For existing-first, if no existing candidate fits,
explain the gap and ask before a separate search without \`endpointIds\`. Send
only task requirements, never source files, secrets or real customer records.

Compare model AND endpoint, evidence, reference cost/time, unknowns and
warnings. For multiple tasks read \`tasks[].slots[0].recommendations\`; the
top-level list is empty. Prefer the cheapest usable option the quality evidence
supports, without claiming benchmarks prove application accuracy. Use the
returned provider model ID and the project's actual SDK and protocol.

## Boundaries

Ask before adding providers or credentials, spending, deploying or external
writes. Report recommendation, endpoint connectivity and application checks as
separate results, each only after it succeeds. Do not switch this coding agent's
own model.

If Scout fails, say so and pause the model decision; do not substitute a
remembered recommendation. If it reports that the device key is missing,
expired or revoked, run \`npx -y openmerit@preview login\` and then
\`npx -y openmerit@preview install\` again. Never ask the user to paste a key.
`;

export const help = `OpenMerit · coding-agent setup (preview)

  openmerit install [--client claude-code] [--scope user|project] [--plan] [--json] [--no-open]
  openmerit status  [--client claude-code] [--scope user|project] [--check] [--json]
  openmerit remove  [--client claude-code] [--scope user|project] [--plan] [--json]
  openmerit login   [--json] [--no-open]     Replace this device's key
  openmerit logout  [--json]                 Revoke this device's key
  openmerit project --policy existing-only|existing-first [--endpoint-id <id> ...] [--plan]
  openmerit doctor  [--json]

install signs this device in through the browser (one Approve click), adds the
OpenMerit MCP server and the Scout skill, then verifies the connection.
Rerun the same command when it reports that approval is pending.
--client defaults to the coding agent running the command. --scope defaults to user.
--plan shows the changes without making them. Keys are never printed.

Exit codes: 0 done, 10 approval pending, 11 denied or expired, 20 conflict,
30 OpenMerit unreachable, 1 other error.
`;

class Stop extends Error { constructor(message, code, next) { super(message); this.exit = code; this.next = next; } }

const server = () => (process.env.OPENMERIT_URL ?? 'https://openmerit.ai').replace(/\/+$/, '');
const configDir = () => resolve(process.env.OPENMERIT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'openmerit'));
const credentialsPath = () => join(configDir(), 'credentials.json');
const pendingPath = () => join(configDir(), 'login.json');

async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function object(path) {
  const text = await optional(path);
  if (text === null) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new Stop(`Invalid JSON in ${path}; nothing was changed.`, exitCodes.conflict); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Stop(`Expected a JSON object in ${path}.`, exitCodes.conflict);
  return value;
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function request(path, { method = 'GET', body, key } = {}) {
  let response;
  try {
    response = await fetch(`${server()}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), 'X-Scout-Client': 'cli', 'X-Scout-Analytics-Content': 'off' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Stop(`Could not reach ${server()}. Check your connection and retry.`, exitCodes.unreachable); }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function detectClient() {
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  return null;
}

// Claude Code locations. Project scope keeps the key out of the repository:
// the MCP entry uses Claude's private "local" scope, only the skill is in the project.
function claudePaths(root, scope) {
  const config = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const base = scope === 'user' ? config : join(root, '.claude');
  return {
    skill: join(base, 'skills/openmerit-scout/SKILL.md'),
    legacyRule: join(base, 'rules/openmerit.md'),
    record: join(base, 'openmerit-install.json'),
    mcpFile: process.env.CLAUDE_CONFIG_DIR ? join(config, '.claude.json') : join(homedir(), '.claude.json'),
    mcpScope: scope === 'user' ? 'user' : 'local',
  };
}
const configuredServer = (config, root, scope) => scope === 'user' ? config.mcpServers?.openmerit : config.projects?.[root]?.mcpServers?.openmerit;
const serverConfig = key => ({ type: 'http', url: `${server()}/scout/mcp`, headers: { Authorization: `Bearer ${key}`, 'X-Scout-Analytics-Content': 'off' } });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const serverHash = value => value ? hash(JSON.stringify(canonical(value))) : null;

async function claude(args, root, key) {
  try { return await exec('claude', args, { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Stop('Claude Code (the claude command) was not found on PATH. Install it, then retry.', exitCodes.error);
    // Claude echoes headers on some failures: scrub the key, and show only a short excerpt.
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.split(key || '\u0000').join('[key]').replace(/om_[A-Za-z0-9_-]{20,}/g, '[key]').trim().slice(0, 300);
    throw new Stop(`Claude Code could not complete "claude ${args.slice(0, 2).join(' ')}"${detail ? `: ${detail}` : '.'}`, exitCodes.error);
  }
}

// Inspect the current Claude Code installation without changing anything.
async function inspect(root, scope) {
  const paths = claudePaths(root, scope);
  const [record, config, installedSkill, legacyRule] = await Promise.all([object(paths.record), object(paths.mcpFile), optional(paths.skill), optional(paths.legacyRule)]);
  const owned = record.version === 2 && record.scope === scope;
  const current = configuredServer(config, root, scope);
  const otherScope = configuredServer(config, root, scope === 'user' ? 'project' : 'user');
  const projectFile = await object(join(root, '.mcp.json'));
  return {
    paths, record, owned, current, installedSkill,
    // A pending header hash covers an install interrupted between add and record.
    serverOwned: !current || owned && (serverHash(current) === record.serverHash || !!record.pendingAuth && hash(current.headers?.Authorization ?? '') === record.pendingAuth),
    skillOwned: installedSkill === null || owned && [record.skillHash, record.pendingSkill].includes(hash(installedSkill)),
    // The pre-release installer recorded its rule hash; only an unchanged rule is removed.
    legacyRule: legacyRule !== null && record.version === 1 && hash(legacyRule) === record.ruleHash ? 'remove' : legacyRule !== null ? 'keep' : 'none',
    shadowed: !!(otherScope || projectFile.mcpServers?.openmerit),
  };
}

function conflicts(state) {
  const found = [];
  if (!state.serverOwned) found.push('Claude Code already has an MCP server named "openmerit" that this installer did not create or that was edited. Remove it with "claude mcp remove openmerit", then retry.');
  if (!state.skillOwned) found.push(`${state.paths.skill} exists and was not created by this installer or was edited. Move or delete it, then retry.`);
  if (state.shadowed) found.push('An "openmerit" MCP server exists in another Claude Code scope (or in .mcp.json). Remove it, then retry.');
  return found;
}

async function credentials() {
  const saved = await object(credentialsPath());
  return saved.version === 1 && saved.server === server() && typeof saved.key === 'string' ? saved : null;
}

// Device login. Starts or resumes a login, waits a bounded time, and stores the
// key only on disk. Never prints the key.
async function login({ client, scope, open, log, wait }) {
  let pending = await object(pendingPath());
  if (!(pending.server === server() && pending.expiresAt > Date.now() && typeof pending.deviceCode === 'string')) {
    const deviceName = (process.env.OPENMERIT_DEVICE_NAME ?? hostname()).replace(/[^\x20-\x7e]/g, '').slice(0, 64) || 'this device';
    const { status, data } = await request('/connect/api/device', { method: 'POST', body: { client, scope, device_name: deviceName } });
    if (status !== 200 || !data.device_code) throw new Stop(data.error ?? `Could not start sign-in (HTTP ${status}).`, status === 429 ? exitCodes.unreachable : exitCodes.error);
    pending = { server: server(), deviceCode: data.device_code, userCode: data.user_code, url: data.verification_uri_complete, interval: data.interval, expiresAt: Date.now() + data.expires_in * 1000, opened: false };
    await save(pendingPath(), pending);
  }
  log(`Approve this device in your browser:\n\n  ${pending.url}\n\n  Code: ${pending.userCode} (expires ${new Date(pending.expiresAt).toLocaleTimeString()})\n`);
  if (open && !pending.opened) { await openBrowser(pending.url).catch(() => false); await save(pendingPath(), { ...pending, opened: true }); }
  const deadline = Date.now() + wait * 1000;
  let interval = (pending.interval ?? 5) * 1000;
  for (;;) {
    const { status, data } = await request('/connect/api/token', { method: 'POST', body: { device_code: pending.deviceCode } });
    if (status === 200 && data.access_token) {
      await save(credentialsPath(), { version: 1, server: server(), key: data.access_token, keyId: data.key_id, createdAt: new Date().toISOString() });
      await rm(pendingPath(), { force: true });
      return data.access_token;
    }
    if (data.error === 'slow_down') interval += 5000;
    else if (data.error !== 'authorization_pending') {
      await rm(pendingPath(), { force: true });
      if (data.error === 'access_denied') throw new Stop('The sign-in request was denied. Nothing was installed.', exitCodes.denied, 'Rerun the command to start a new request.');
      throw new Stop('The sign-in code expired or was already used. Nothing was installed.', exitCodes.denied, 'Rerun the command to get a new code.');
    }
    if (Date.now() + interval > deadline) throw new Stop(`Waiting for approval of code ${pending.userCode}.`, exitCodes.pending, `Open ${pending.url}, click Approve, then rerun the same command. It resumes this request.`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// A real MCP initialize and tool discovery with the stored key; no search.
async function verify(key) {
  const call = (id, method, params = {}) => request('/scout/mcp', { method: 'POST', key, body: { jsonrpc: '2.0', id, method, params } });
  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openmerit-cli', version: '1' } });
  if (init.status === 401) return 'key_rejected';
  if (init.status !== 200 || !init.data.result) return 'failed';
  const tools = await call(2, 'tools/list');
  return tools.data.result?.tools?.some(tool => tool.name === 'scout_models') ? 'connected' : 'failed';
}

async function install(root, { client, scope, plan, open, log, wait }) {
  const state = await inspect(root, scope);
  const found = conflicts(state);
  const changes = [
    `${state.current ? 'Update' : 'Add'} MCP server "openmerit" in Claude Code (${state.paths.mcpScope} scope, ${state.paths.mcpFile})`,
    `${state.installedSkill === null ? 'Create' : 'Update'} ${state.paths.skill}`,
    ...(state.legacyRule === 'remove' ? [`Remove the unchanged earlier instructions at ${state.paths.legacyRule}`] : []),
    ...(await credentials() ? [] : [`Sign this device in through the browser and store its key in ${credentialsPath()} (mode 600)`]),
  ];
  if (plan) return { action: 'install', applied: false, client, scope, changes, conflicts: found };
  if (found.length) throw new Stop(found.join('\n'), exitCodes.conflict, 'Nothing was changed.');
  await claude(['--version'], root);
  let key = (await credentials())?.key;
  // A revoked or expired key gets a fresh sign-in instead of a broken install.
  if (key && await verify(key) === 'key_rejected') { await rm(credentialsPath(), { force: true }); key = undefined; log('The saved device key is no longer valid; signing in again.'); }
  key ??= await login({ client, scope, open, log, wait });
  const next = serverConfig(key);
  // Record intent first so an interrupted install is repaired by rerunning.
  await save(state.paths.record, { version: 2, scope, client, serverHash: serverHash(state.current), skillHash: state.installedSkill === null ? null : hash(state.installedSkill), pendingAuth: hash(next.headers.Authorization), pendingSkill: hash(skill) });
  if (state.current?.url !== next.url || state.current?.headers?.Authorization !== next.headers.Authorization) {
    if (state.current) await claude(['mcp', 'remove', '--scope', state.paths.mcpScope, 'openmerit'], root, key);
    await claude(['mcp', 'add-json', '--scope', state.paths.mcpScope, 'openmerit', JSON.stringify(next)], root, key);
  }
  await save(state.paths.skill, skill);
  if (state.legacyRule === 'remove') await rm(state.paths.legacyRule, { force: true });
  // Record what Claude actually wrote, so later edits are detected precisely.
  const written = configuredServer(await object(state.paths.mcpFile), root, scope);
  if (!written) throw new Stop('Claude Code did not save the "openmerit" MCP server.', exitCodes.error, 'Run "openmerit doctor".');
  await save(state.paths.record, { version: 2, scope, client, serverHash: serverHash(written), skillHash: hash(skill), installedAt: new Date().toISOString() });
  const connection = await verify(key);
  if (connection === 'key_rejected') throw new Stop('OpenMerit rejected this device key (expired or revoked).', exitCodes.denied, 'Run "openmerit login", then rerun install.');
  return { action: 'install', applied: true, client, scope, changes, connection,
    next: connection === 'connected'
      ? `Restart ${clients[client]} (or run /mcp and reconnect "openmerit"), then try Scout on a non-confidential task.`
      : 'Installed, but the connection check failed. Run "openmerit doctor".' };
}

async function status(root, { client, scope, check }) {
  const state = await inspect(root, scope), saved = await credentials();
  const installed = state.owned && !!state.current && state.serverOwned && state.installedSkill !== null && state.skillOwned && !state.shadowed;
  return { action: 'status', client, scope, installed, signedIn: !!saved,
    server: state.current ? state.serverOwned ? 'matches' : 'modified_or_unowned' : 'missing',
    skill: state.installedSkill === null ? 'missing' : state.skillOwned ? 'matches' : 'modified_or_unowned',
    conflicts: conflicts(state), connection: check && saved ? await verify(saved.key) : 'not_checked' };
}

async function revokeKey() {
  const saved = await credentials();
  if (!saved) return false;
  const { status } = await request('/connect/api/keys/self', { method: 'DELETE', key: saved.key }).catch(() => ({ status: 0 }));
  await rm(credentialsPath(), { force: true });
  return status === 200;
}

async function remove(root, { client, scope, plan }) {
  const state = await inspect(root, scope);
  if (!state.owned) return { action: 'remove', applied: false, client, scope, changes: [], note: 'No OpenMerit installation by this installer in this scope.' };
  const changes = [...(state.current && state.serverOwned ? [`Remove MCP server "openmerit" (${state.paths.mcpScope} scope)`] : []),
    ...(state.installedSkill !== null && state.skillOwned ? [`Delete ${state.paths.skill}`] : []), 'Revoke and delete this device key'];
  const kept = [...(state.serverOwned ? [] : ['the edited "openmerit" MCP server']), ...(state.skillOwned ? [] : [state.paths.skill]), policyPath];
  if (plan) return { action: 'remove', applied: false, client, scope, changes, keeps: kept };
  if (state.current && state.serverOwned) await claude(['mcp', 'remove', '--scope', state.paths.mcpScope, 'openmerit'], root);
  if (state.installedSkill !== null && state.skillOwned) await rm(dirname(state.paths.skill), { recursive: true, force: true });
  await rm(state.paths.record, { force: true });
  const revoked = await revokeKey();
  return { action: 'remove', applied: true, client, scope, changes, keeps: kept, keyRevoked: revoked };
}

async function project(root, { policy, ids, plan }) {
  if (!['existing-only', 'existing-first'].includes(policy)) throw new Stop('Choose --policy existing-only or existing-first.', exitCodes.error);
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || id.includes('://') || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,159}$/.test(id))) throw new Stop('Use up to 100 unique public catalogue endpoint IDs, never credentials or URLs.', exitCodes.error);
  const value = { version: 1, policy, endpointIds: ids }, file = join(root, policyPath), existing = await object(file);
  if (Object.keys(existing).some(key => !['version', 'policy', 'endpointIds'].includes(key))) throw new Stop(`${policyPath} has unrecognized fields; edit it yourself instead.`, exitCodes.conflict);
  if (!plan) await save(file, value);
  return { action: 'project', applied: !plan, path: policyPath, policy: value, note: 'Endpoint IDs limit discovery only; they do not prove access or authorize spending.' };
}

async function doctor(root, { scope }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 22 || major === 22 && minor >= 19, `Node.js ${process.versions.node} (22.19+ required)`);
  try { const { stdout } = await exec('claude', ['--version'], { timeout: 10_000 }); add('claude', true, stdout.trim().slice(0, 80)); }
  catch { add('claude', false, 'Claude Code (claude) is not on PATH'); }
  const reach = await request('/scout/api/status').catch(error => ({ status: 0, error }));
  add('openmerit', reach.status === 200, reach.status === 200 ? `${server()} reachable` : `${server()} unreachable`);
  const saved = await credentials();
  add('key', !!saved, saved ? `Device key ${saved.keyId ?? ''} stored in ${credentialsPath()}` : 'Not signed in. Run "openmerit install" or "openmerit login".');
  if (saved && reach.status === 200) { const connection = await verify(saved.key); add('mcp', connection === 'connected', `MCP check: ${connection}`); }
  const state = await inspect(root, scope).catch(() => null);
  if (state) add('install', state.owned && !conflicts(state).length, state.owned ? conflicts(state).join(' ') || `Installed (${scope} scope)` : `Not installed in ${scope} scope`);
  return { action: 'doctor', ok: checks.every(check => check.ok), checks };
}

function render(result) {
  if (result.action === 'doctor') return result.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');
  if (result.action === 'status') return [`OpenMerit in ${clients[result.client]} (${result.scope} scope): ${result.installed ? 'installed' : 'not installed'}`, `Signed in: ${result.signedIn ? 'yes' : 'no'} · MCP server: ${result.server} · skill: ${result.skill} · connection: ${result.connection}`, ...result.conflicts].join('\n');
  if (result.action === 'project') return `${result.applied ? 'Saved' : 'Would save'} ${result.path}: ${result.policy.policy}, ${result.policy.endpointIds.length} endpoint ID(s). ${result.note}`;
  if (result.action === 'login') return result.note;
  if (result.action === 'logout') return result.note;
  const lines = [result.applied ? `Done (${result.action}):` : result.changes.length ? `Plan (${result.action}, nothing changed):` : result.note, ...result.changes.map(c => `  • ${c}`)];
  if (result.conflicts?.length) lines.push('Conflicts (install would stop):', ...result.conflicts.map(c => `  • ${c}`));
  if (result.connection) lines.push(`Connection check: ${result.connection}`);
  if (result.next) lines.push('', result.next);
  return lines.join('\n');
}

export async function main(args, { root = process.cwd(), print = console.log, printError = console.error } = {}) {
  const [action, ...rest] = args;
  if (!action || rest.includes('--help') || rest.includes('-h')) { print(help); return exitCodes.ok; }
  const options = { client: undefined, scope: 'user', plan: false, check: false, json: false, open: true, policy: undefined, ids: [] };
  const allowed = { install: ['--client', '--scope', '--plan', '--json', '--no-open'], status: ['--client', '--scope', '--check', '--json'], remove: ['--client', '--scope', '--plan', '--json'],
    login: ['--json', '--no-open'], logout: ['--json'], project: ['--policy', '--endpoint-id', '--plan', '--json'], doctor: ['--scope', '--json'] }[action];
  if (!allowed) throw new Error('Unknown command. Run openmerit --help.');
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (!allowed.includes(option)) throw new Error(`Unknown option for ${action}: ${option}`);
    const value = () => { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${option} needs a value.`); return v; };
    if (option === '--client') options.client = value();
    else if (option === '--scope') options.scope = value();
    else if (option === '--policy') options.policy = value();
    else if (option === '--endpoint-id') options.ids.push(value());
    else if (option === '--no-open') options.open = false;
    else options[option.slice(2)] = true;
  }
  if (!['user', 'project'].includes(options.scope)) throw new Error('Use --scope user or --scope project.');
  if (['install', 'status', 'remove'].includes(action)) {
    options.client ??= detectClient();
    if (!options.client) throw new Error('Choose the coding agent with --client claude-code.');
    if (!clients[options.client]) throw new Error(`Unsupported client "${options.client}". Supported: ${Object.keys(clients).join(', ')}.`);
  }
  root = resolve(root);
  // Agents run commands with a few-minute timeout; wait well inside it, then resume.
  const wait = Number(process.env.OPENMERIT_LOGIN_WAIT ?? 90);
  const log = text => (options.json ? printError : print)(text);
  try {
    const result = action === 'install' ? await install(root, { ...options, log, wait })
      : action === 'status' ? await status(root, options)
      : action === 'remove' ? await remove(root, options)
      : action === 'project' ? await project(root, options)
      : action === 'doctor' ? await doctor(root, options)
      : action === 'logout' ? { action, revoked: await revokeKey(), note: 'Signed out. This device key was revoked and deleted. Agents configured with it stop working until you run install again.' }
      : (await revokeKey(), await rm(pendingPath(), { force: true }), await login({ client: 'claude-code', scope: 'user', open: options.open, log, wait }), { action, signedIn: true, note: 'Signed in. Run "openmerit install" again to give your coding agents the new key.' });
    print(options.json ? JSON.stringify({ ok: true, ...result }, null, 2) : render(result));
    return action === 'doctor' && !result.ok ? exitCodes.error : exitCodes.ok;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (options.json) print(JSON.stringify({ ok: false, action, code: Object.keys(exitCodes).find(k => exitCodes[k] === error.exit), message: error.message, next: error.next }, null, 2));
    else printError([error.message, error.next].filter(Boolean).join('\n'));
    return error.exit;
  }
}
