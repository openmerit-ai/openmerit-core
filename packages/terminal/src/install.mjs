import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBrowser } from './browser.mjs';
import { clientVersion, setupHeaders, setupUUID, sendInstallationEvent, setupCorrelationEnabled, telemetryEnabled } from './telemetry.mjs';
import { configureUpdates, inspectUpdates, recoverUpdates, removeUpdates, runUpdate, withUpdateLock } from './updates.ts';
import { credentialsPath as deviceCredentialsPath, pendingPath as devicePendingPath } from './scout-credentials.ts';
import { rule, skill } from './scout-instructions.ts';
import { piPaths, inspectPi, configurePi, removePi, piConflicts, piVersion } from './scout-pi.ts';
export { rule, skill } from './scout-instructions.ts';

// One-command coding-agent setup: device sign-in in the browser, then the MCP
// server, startup rule and Scout skill. Built to be run by a person or by a coding agent:
// no interactive prompts, bounded waits, resumable logins and explicit exit codes.
export const exitCodes = { ok: 0, error: 1, pending: 10, denied: 11, conflict: 20, unreachable: 30 };
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const policyPath = '.openmerit/scout.json';
const clients = { 'claude-code': 'Claude Code', pi: 'Pi' };

export const help = `OpenMerit · coding-agent setup

  openmerit install [--client claude-code|pi] [--scope user|project] [--setup-id UUID] [--auto-update on|off] [--plan] [--json] [--no-open]
  openmerit status  [--client claude-code|pi] [--scope user|project] [--check] [--json]
  openmerit remove  [--client claude-code|pi] [--scope user|project] [--plan] [--json]
  openmerit login   [--client claude-code|pi] [--scope user|project] [--setup-id UUID] [--json] [--no-open]
  openmerit logout  [--client claude-code|pi] [--scope user|project] [--json]
  openmerit project --policy existing-only|existing-first [--endpoint-id <id> ...] [--plan]
  openmerit doctor  [--client claude-code|pi] [--scope user|project] [--json]
  openmerit update  [--client claude-code|pi] [--scope user|project] [--auto on|off] [--json]
  openmerit scout   --help                   Ask Scout from the terminal

install signs this device in through the browser (one Approve click), adds the
OpenMerit MCP server, startup rule and Scout skill, then verifies the connection.
Automatic Scout instruction updates default on; --auto-update off opts out.
Background SessionStart/Stop hooks check npm at most daily (15-minute failure
retry), verify package integrity, and preserve edited files and credentials.
Pi uses its native MCP extension; run install again to update its managed adapter.
Pi does not install Claude hooks or a background updater. Start a new session after setup.
It opens the approval page and waits up to 9 minutes for the Approve click
(30 seconds when no browser could be opened). If it exits with approval
pending, rerun the same command: it resumes the same request.
--client defaults to the coding agent running the command. --scope defaults to user.
--plan shows the changes without making them. Keys are never printed.

Exit codes: 0 done, 10 approval pending, 11 denied or expired, 20 conflict,
30 OpenMerit unreachable, 1 other error.
`;

class Stop extends Error { constructor(message, code, next) { super(message); this.exit = code; this.next = next; } }

const server = () => (process.env.OPENMERIT_URL ?? 'https://openmerit.ai').replace(/\/+$/, '');
const credentialsPath = telemetry => deviceCredentialsPath(telemetry.properties.agent, telemetry.properties.scope, telemetry.root);
const pendingPath = telemetry => devicePendingPath(telemetry.properties.agent, telemetry.properties.scope, telemetry.root);

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

async function request(path, { method = 'GET', body, key, telemetry } = {}) {
  let response;
  try {
    response = await fetch(`${server()}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...setupHeaders(telemetry?.properties) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Stop(`Could not reach ${server()}. Check your connection and retry.`, exitCodes.unreachable); }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function detectClient() {
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (process.env.PI_CODING_AGENT_DIR) return 'pi';
  return null;
}

// Claude Code locations. Project scope keeps the key out of the repository:
// the MCP entry uses Claude's private "local" scope; rule and skill are in the project.
function claudePaths(root, scope) {
  const config = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const base = scope === 'user' ? config : join(root, '.claude');
  return {
    skill: join(base, 'skills/openmerit-scout/SKILL.md'),
    rule: join(base, 'rules/openmerit-scout.md'),
    legacyRule: join(base, 'rules/openmerit.md'),
    record: join(base, 'openmerit-install.json'),
    mcpFile: process.env.CLAUDE_CONFIG_DIR ? join(config, '.claude.json') : join(homedir(), '.claude.json'),
    mcpScope: scope === 'user' ? 'user' : 'local',
  };
}
const configuredServer = (config, root, scope) => scope === 'user' ? config.mcpServers?.openmerit : config.projects?.[root]?.mcpServers?.openmerit;
const serverConfig = (key, telemetry) => ({ type: 'http', url: `${server()}/scout/mcp`, headers: { Authorization: `Bearer ${key}`, ...setupHeaders(telemetry.properties, 'agent') } });
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
async function inspect(root, scope, client = 'claude-code') {
  if (client === 'pi') return { ...await inspectPi(root, scope), client };
  const paths = claudePaths(root, scope);
  const [record, config, installedSkill, installedRule, legacyRule] = await Promise.all([object(paths.record), object(paths.mcpFile), optional(paths.skill), optional(paths.rule), optional(paths.legacyRule)]);
  const updates = await inspectUpdates(dirname(paths.record), scope, record);
  const owned = [2, 3].includes(record.version) && record.scope === scope;
  const current = configuredServer(config, root, scope);
  const otherScope = configuredServer(config, root, scope === 'user' ? 'project' : 'user');
  const projectFile = await object(join(root, '.mcp.json'));
  return {
    paths, record, owned, current, installedSkill, installedRule, updates, client,
    // A full pending hash covers interruption without accepting edited headers.
    // Keep pendingAuth compatibility for records from the earlier installer.
    serverOwned: !current || owned && (serverHash(current) === record.serverHash || serverHash(current) === record.pendingServerHash || !!record.pendingAuth && hash(current.headers?.Authorization ?? '') === record.pendingAuth),
    skillOwned: installedSkill === null || owned && [record.skillHash, record.pendingSkill].includes(hash(installedSkill)),
    ruleOwned: installedRule === null || owned && record.version === 3 && [record.ruleHash, record.pendingRule].includes(hash(installedRule)),
    // The pre-release installer recorded its rule hash; only an unchanged rule is removed.
    legacyRule: legacyRule !== null && record.version === 1 && hash(legacyRule) === record.ruleHash ? 'remove' : legacyRule !== null ? 'keep' : 'none',
    shadowed: !!(otherScope || projectFile.mcpServers?.openmerit),
  };
}

function conflicts(state) {
  if (state.client === 'pi') return piConflicts(state);
  const found = [...state.updates.conflicts];
  if (!state.serverOwned) found.push('Claude Code already has an MCP server named "openmerit" that this installer did not create or that was edited. Remove it with "claude mcp remove openmerit", then retry.');
  if (!state.skillOwned) found.push(`${state.paths.skill} exists and was not created by this installer or was edited. Move or delete it, then retry.`);
  if (!state.ruleOwned) found.push(`${state.paths.rule} exists and was not created by this installer or was edited. Move or delete it, then retry.`);
  if (state.shadowed) found.push('An "openmerit" MCP server exists in another Claude Code scope (or in .mcp.json). Remove it, then retry.');
  return found;
}

function diagnostics(state) {
  return {
    installed: state.owned && !!state.current && state.serverOwned && state.installedSkill !== null && state.skillOwned && state.installedRule !== null && state.ruleOwned && !state.shadowed,
    server_status: state.current ? state.serverOwned ? 'matches' : 'modified_or_unowned' : 'missing',
    skill_status: state.installedSkill === null ? 'missing' : state.skillOwned ? 'matches' : 'modified_or_unowned',
    rule_status: state.installedRule === null ? 'missing' : state.ruleOwned ? 'matches' : 'modified_or_unowned',
  };
}

async function credentials(telemetry) {
  const saved = await object(credentialsPath(telemetry));
  return saved.version === 1 && saved.server === server() && typeof saved.key === 'string' ? saved : null;
}

// Device login. Starts or resumes a login, waits a bounded time, and stores the
// key only on disk. Never prints the key.
async function login({ client, scope, open, log, wait, telemetry }) {
  await telemetry.step('login', 'started');
  let pending = await object(pendingPath(telemetry));
  if (!(pending.server === server() && pending.expiresAt > Date.now() && typeof pending.deviceCode === 'string')) {
    const deviceName = (process.env.OPENMERIT_DEVICE_NAME ?? hostname()).replace(/[^\x20-\x7e]/g, '').slice(0, 64) || 'this device';
    const { status, data } = await request('/connect/api/device', { method: 'POST', body: { client, scope, device_name: deviceName }, telemetry });
    if (status !== 200 || !data.device_code) throw new Stop(data.error ?? `Could not start sign-in (HTTP ${status}).`, status === 429 ? exitCodes.unreachable : exitCodes.error);
    pending = { server: server(), deviceCode: data.device_code, userCode: data.user_code, url: data.verification_uri_complete, interval: data.interval, expiresAt: Date.now() + data.expires_in * 1000, opened: false, setup_id: telemetry.properties.setup_id, installation_id: telemetry.properties.installation_id };
    await save(pendingPath(telemetry), pending);
  }
  const approvalURL = new URL(pending.url);
  // Rebuild consent on every resume, so old query parameters cannot override a
  // later refusal. Only analytics-enabled, linked setup IDs reach the page.
  for (const key of ['setup_id', 'analytics', 'analytics_account']) approvalURL.searchParams.delete(key);
  if (setupCorrelationEnabled() && setupUUID(telemetry.properties.setup_id)) approvalURL.searchParams.set('setup_id', telemetry.properties.setup_id);
  // Preserve explicit refusals across surfaces; unlinking must not disable usage.
  if (!telemetryEnabled(true)) approvalURL.searchParams.set('analytics', 'off');
  if (process.env.OPENMERIT_ANALYTICS_ACCOUNT === 'off' || !telemetryEnabled(true)) approvalURL.searchParams.set('analytics_account', 'off');
  pending = { ...pending, url: approvalURL.href, setup_id: telemetry.properties.setup_id, installation_id: telemetry.properties.installation_id };
  await save(pendingPath(telemetry), pending);
  log(`Approve this device in your browser (opening it now):\n\n  ${pending.url}\n\n  Code: ${pending.userCode} (expires ${new Date(pending.expiresAt).toLocaleTimeString()})\n`);
  await telemetry.step('browser_open', 'started');
  if (open && !pending.opened && !pending.openFailed) {
    // Only the approval page on the configured OpenMerit server may be opened.
    const approvalPage = url => {
      const u = new URL(url);
      return u.origin === server() && u.pathname === '/connect' && !!u.searchParams.get('code')
        && [...u.searchParams.keys()].every(key => ['code', 'setup_id', 'analytics', 'analytics_account'].includes(key) && u.searchParams.getAll(key).length === 1)
        && (!u.searchParams.has('setup_id') || setupUUID(u.searchParams.get('setup_id')))
        && ['analytics', 'analytics_account'].every(key => !u.searchParams.has(key) || u.searchParams.get(key) === 'off')
        && !u.username && !u.password && !u.hash;
    };
    const opened = await openBrowser(pending.url, { allowed: approvalPage }).catch(() => false);
    pending = { ...pending, ...(opened ? { opened: true } : { openFailed: true }) };
    await save(pendingPath(telemetry), pending);
  }
  await telemetry.step('browser_open', pending.opened ? 'ok' : pending.openFailed ? 'error' : 'pending');
  await telemetry.step('login', 'started');
  // With the approval page open, keep waiting for the Approve click (inside a
  // coding agent's 10-minute command limit) so nobody has to rerun anything.
  // Without a browser, return soon so the agent can show the link.
  const deadline = Date.now() + (wait ?? (pending.opened ? 540 : 30)) * 1000;
  let interval = (pending.interval ?? 5) * 1000;
  for (;;) {
    const { status, data } = await request('/connect/api/token', { method: 'POST', body: { device_code: pending.deviceCode }, telemetry });
    if (status === 200 && data.access_token) {
      await save(credentialsPath(telemetry), { version: 1, server: server(), key: data.access_token, keyId: data.key_id, setup_id: telemetry.properties.setup_id, headers: setupHeaders(telemetry.properties, 'agent'), createdAt: new Date().toISOString() });
      await rm(pendingPath(telemetry), { force: true });
      await telemetry.step('login', 'ok');
      return data.access_token;
    }
    if (data.error === 'slow_down') interval += 5000;
    else if (data.error !== 'authorization_pending') {
      await rm(pendingPath(telemetry), { force: true });
      if (data.error === 'access_denied') throw new Stop('The sign-in request was denied. Nothing was installed.', exitCodes.denied, 'Rerun the command to start a new request.');
      throw new Stop('The sign-in code expired or was already used. Nothing was installed.', exitCodes.denied, 'Rerun the command to get a new code.');
    }
    if (Date.now() + interval > deadline) throw new Stop(`Waiting for approval of code ${pending.userCode}.`, exitCodes.pending, `Open ${pending.url}, click Approve, then rerun the same command. It resumes this request.`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// A real MCP initialize and tool discovery with the stored key; no search.
async function verify(key, telemetry) {
  await telemetry.step('verification', 'started');
  const call = (id, method, params = {}) => request('/scout/mcp', { method: 'POST', key, telemetry, body: { jsonrpc: '2.0', id, method, params } });
  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openmerit-cli', version: clientVersion ?? 'unknown' } });
  let connection = init.status === 401 ? 'key_rejected' : 'failed';
  if (init.status === 200 && init.data.result) {
    const tools = await call(2, 'tools/list');
    connection = tools.status === 401 ? 'key_rejected' : tools.status === 200 && tools.data.result?.tools?.some(tool => tool.name === 'scout_models') ? 'connected' : 'failed';
  }
  await telemetry.step('verification', connection === 'connected' ? 'ok' : 'error', { connection, ...(connection === 'connected' ? {} : { code: connection === 'key_rejected' ? 'access_denied' : 'command_error' }) });
  return connection;
}

async function install(root, { client, scope, plan, open, log, wait, telemetry, autoUpdate, json }) {
  const state = await inspect(root, scope, client);
  const enabled = autoUpdate === undefined ? state.updates.saved?.enabled ?? true : autoUpdate === 'on';
  const found = conflicts(state);
  if (client === 'pi' && autoUpdate === 'on') throw new Stop('Pi updates are explicit: rerun install --client pi. Automatic hooks are Claude Code only.', exitCodes.error);
  const changes = [
    `${state.current ? 'Update' : 'Add'} ${client === 'pi' ? 'native Pi MCP extension' : 'MCP server "openmerit" in Claude Code'} (${scope} scope)`,
    `${state.installedSkill === null ? 'Create' : 'Update'} ${state.paths.skill}`,
    `${state.installedRule === null ? 'Create' : 'Update'} ${state.paths.rule} (loaded at session startup)`,
    ...(client === 'pi' ? [] : [
      `Automatic Scout instruction updates ${enabled ? 'on' : 'off'} (SessionStart/Stop background hooks; disable with openmerit update --auto off)`,
      `Write the owned updater at ${state.updates.paths.runner}; merge its hooks in ${state.updates.paths.settings}`,
    ]),
    ...(state.legacyRule === 'remove' ? [`Remove the unchanged earlier instructions at ${state.paths.legacyRule}`] : []),
    ...(await credentials(telemetry) ? [] : [`Sign this device in through the browser and store its key in ${credentialsPath(telemetry)} (mode 600)`]),
  ];
  if (plan) return { action: 'install', applied: false, client, scope, changes, conflicts: found };
  if (found.length) throw new Stop(found.join('\n'), exitCodes.conflict, 'Nothing was changed.');
  if (!json && client !== 'pi') log(changes.find(change => change.startsWith('Automatic Scout')));
  if (client === 'pi') {
    const { stdout } = await exec('pi', ['--version'], { cwd: root, timeout: 10_000 });
    if (stdout.trim() !== piVersion) throw new Stop(`Pi ${piVersion} (latest stable supported) is required; found ${stdout.trim()}. Update Pi first.`, exitCodes.error);
  } else await claude(['--version'], root);
  if (setupCorrelationEnabled()) telemetry.properties.installation_id ??= randomUUID();
  await telemetry.step('preflight', 'ok');
  let key = (await credentials(telemetry))?.key;
  // A revoked or expired key gets a fresh sign-in instead of a broken install.
  if (key && await verify(key, telemetry) === 'key_rejected') { await rm(credentialsPath(telemetry), { force: true }); key = undefined; log('The saved device key is no longer valid; signing in again.'); }
  key ??= await login({ client, scope, open, log, wait, telemetry });
  await telemetry.step('configuration', 'started');
  const ids = { setup_id: telemetry.properties.setup_id, installation_id: telemetry.properties.installation_id };
  if (client === 'pi') {
    await save(credentialsPath(telemetry), { ...await credentials(telemetry), headers: setupHeaders(telemetry.properties, 'agent') });
    await configurePi(root, scope, credentialsPath(telemetry), ids);
    telemetry.properties.applied = true;
  } else {
    const next = serverConfig(key, telemetry);
    // Record intent first so an interrupted install is repaired by rerunning.
    await save(state.paths.record, { version: 3, scope, client, ...ids, updates: state.record.updates, pendingUpdates: state.record.pendingUpdates, serverHash: serverHash(state.current), skillHash: state.installedSkill === null ? null : hash(state.installedSkill), ruleHash: state.installedRule === null ? null : hash(state.installedRule), pendingServerHash: serverHash(next), pendingSkill: hash(skill), pendingRule: hash(rule) });
    telemetry.properties.applied = true;
    if (serverHash(state.current) !== serverHash(next)) {
      if (state.current) await claude(['mcp', 'remove', '--scope', state.paths.mcpScope, 'openmerit'], root, key);
      await claude(['mcp', 'add-json', '--scope', state.paths.mcpScope, 'openmerit', JSON.stringify(next)], root, key);
    }
    await save(state.paths.skill, skill);
    await save(state.paths.rule, rule);
    if (state.legacyRule === 'remove') await rm(state.paths.legacyRule, { force: true });
    // Record what Claude actually wrote, so later edits are detected precisely.
    const written = configuredServer(await object(state.paths.mcpFile), root, scope);
    if (!written) throw new Stop('Claude Code did not save the "openmerit" MCP server.', exitCodes.error, 'Run "openmerit doctor".');
    const updates = await configureUpdates(dirname(state.paths.record), scope, state.record, clientVersion, enabled);
    await save(state.paths.record, { version: 3, scope, client, ...ids, serverHash: serverHash(written), skillHash: hash(skill), ruleHash: hash(rule), updates, installedAt: new Date().toISOString() });
  }
  await telemetry.step('configuration', 'ok', diagnostics(await inspect(root, scope, client)));
  const connection = await verify(key, telemetry);
  if (connection !== 'connected') telemetry.outcome = 'error';
  if (connection === 'key_rejected') throw new Stop('OpenMerit rejected this device key (expired or revoked).', exitCodes.denied, 'Run "openmerit login", then rerun install.');
  return { action: 'install', applied: true, client, scope, changes, connection,
    next: connection === 'connected'
      ? `Scout is ready in new ${clients[client]} sessions. Start a new session to load the extension, instructions and skill.`
      : `Installed, but the connection check failed. Run "openmerit doctor --client ${client} --scope ${scope}".` };
}

async function status(root, { client, scope, check, telemetry }) {
  await telemetry.step('status', 'started');
  const state = await inspect(root, scope, client), saved = await credentials(telemetry);
  const details = diagnostics(state), found = conflicts(state);
  const connection = check && saved ? await verify(saved.key, telemetry) : 'not_checked';
  telemetry.outcome = ['failed', 'key_rejected'].includes(connection) ? 'error' : found.length ? 'conflict' : details.installed ? 'ok' : 'not_installed';
  await telemetry.step('status', telemetry.outcome, { ...details, connection });
  return { action: 'status', client, scope, installed: details.installed, signedIn: !!saved,
    server: details.server_status, skill: details.skill_status, rule: details.rule_status,
    autoUpdates: state.updates.saved?.enabled ?? false, instructionVersion: state.updates.saved?.version ?? null,
    updateHooks: state.updates.saved?.enabled ? state.updates.active && !state.updates.conflicts.length ? 'ready' : 'incomplete' : 'disabled',
    conflicts: found, connection };
}

async function revokeKey(telemetry) {
  const saved = await credentials(telemetry);
  if (!saved) return false;
  await telemetry.step('remove', 'started');
  const { status } = await request('/connect/api/keys/self', { method: 'DELETE', key: saved.key, telemetry }).catch(() => ({ status: 0 }));
  await rm(credentialsPath(telemetry), { force: true });
  if (status !== 200) telemetry.outcome = 'error';
  await telemetry.step('remove', status === 200 ? 'ok' : 'error', status === 200 ? {} : {
    code: status === 0 ? 'openmerit_unreachable' : status === 401 || status === 403 ? 'access_denied' : 'command_error',
  });
  return status === 200;
}

async function remove(root, { client, scope, plan, telemetry }) {
  await telemetry.step('remove', 'started');
  const state = await inspect(root, scope, client);
  if (!state.owned) {
    telemetry.outcome = 'not_installed';
    await telemetry.step('remove', 'not_installed');
    return { action: 'remove', applied: false, client, scope, changes: [], note: 'No OpenMerit installation by this installer in this scope.' };
  }
  const changes = [...(state.current && state.serverOwned ? [`Remove MCP server "openmerit" (${state.paths.mcpScope} scope)`] : []),
    ...(state.installedSkill !== null && state.skillOwned ? [`Delete ${state.paths.skill}`] : []),
    ...(state.installedRule !== null && state.ruleOwned ? [`Delete ${state.paths.rule}`] : []),
    ...(state.updates.saved ? ['Remove unchanged owned update hooks and updater; retain edited hooks and their runner'] : []), 'Revoke and delete this device key'];
  const kept = [...(state.serverOwned ? [] : ['the edited "openmerit" MCP server']), ...(state.skillOwned ? [] : [state.paths.skill]), ...(state.ruleOwned ? [] : [state.paths.rule]), policyPath];
  kept.push(...state.updates.conflicts);
  if (plan) return { action: 'remove', applied: false, client, scope, changes, keeps: kept };
  telemetry.properties.applied = true;
  if (client === 'pi') await removePi(state);
  else {
    if (state.current && state.serverOwned) await claude(['mcp', 'remove', '--scope', state.paths.mcpScope, 'openmerit'], root);
    if (state.installedSkill !== null && state.skillOwned) await rm(dirname(state.paths.skill), { recursive: true, force: true });
    if (state.installedRule !== null && state.ruleOwned) await rm(state.paths.rule, { force: true });
    await removeUpdates(dirname(state.paths.record), scope, state.record);
    await rm(state.paths.record, { force: true });
  }
  const revoked = await revokeKey(telemetry);
  await telemetry.step('remove', telemetry.outcome, diagnostics(await inspect(root, scope, client)));
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

async function doctor(root, { client, scope, telemetry }) {
  await telemetry.step('status', 'started');
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 22 || major === 22 && minor >= 19, `Node.js ${process.versions.node} (22.19+ required)`);
  const binary = client === 'pi' ? 'pi' : 'claude';
  try { const { stdout } = await exec(binary, ['--version'], { timeout: 10_000 }); add(binary, client !== 'pi' || stdout.trim() === piVersion, stdout.trim().slice(0, 80)); }
  catch { add(binary, false, `${clients[client]} (${binary}) is not on PATH`); }
  const reach = await request('/scout/api/status', { telemetry }).catch(error => ({ status: 0, error }));
  add('openmerit', reach.status === 200, reach.status === 200 ? `${server()} reachable` : `${server()} unreachable`);
  const saved = await credentials(telemetry);
  add('key', !!saved, saved ? `Device key ${saved.keyId ?? ''} stored in ${credentialsPath(telemetry)}` : 'Not signed in. Run targeted install or login.');
  if (saved && reach.status === 200) { const connection = await verify(saved.key, telemetry); add('mcp', connection === 'connected', `MCP check: ${connection}`); }
  const state = await inspect(root, scope, client).catch(() => null);
  if (state) add('install', state.owned && !!state.current && state.installedSkill !== null && state.installedRule !== null && !conflicts(state).length, state.owned ? conflicts(state).join(' ') || (state.current && state.installedSkill !== null && state.installedRule !== null ? `Installed (${scope} scope)` : 'Installation incomplete. Rerun "openmerit install".') : `Not installed in ${scope} scope`);
  if (state?.updates.saved?.enabled) add('updater', state.updates.active && !state.updates.conflicts.length, state.updates.active && !state.updates.conflicts.length ? 'Automatic instruction hooks installed' : 'Automatic instruction hooks missing or edited. Rerun install after reviewing conflicts.');
  telemetry.outcome = checks.every(check => check.ok) ? 'ok' : 'error';
  await telemetry.step('status', telemetry.outcome, { ...(state ? diagnostics(state) : {}), ...(reach.status === 200 ? {} : { code: 'openmerit_unreachable', connection: 'failed' }) });
  return { action: 'doctor', ok: checks.every(check => check.ok), checks };
}

function render(result) {
  if (result.action === 'doctor') return result.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');
  if (result.action === 'status') return [`OpenMerit in ${clients[result.client]} (${result.scope} scope): ${result.installed ? 'installed' : 'not installed'}`, `Signed in: ${result.signedIn ? 'yes' : 'no'} · MCP server: ${result.server} · skill: ${result.skill} · rule: ${result.rule} · connection: ${result.connection}`, `Automatic instruction updates: ${result.autoUpdates ? 'on' : 'off'} · hooks: ${result.updateHooks} · instruction version: ${result.instructionVersion ?? 'bootstrap required'}`, ...result.conflicts].join('\n');
  if (result.action === 'update') return result.message;
  if (result.action === 'project') return `${result.applied ? 'Saved' : 'Would save'} ${result.path}: ${result.policy.policy}, ${result.policy.endpointIds.length} endpoint ID(s). ${result.note}`;
  if (result.action === 'login') return result.note;
  if (result.action === 'logout') return result.note;
  const lines = [result.applied ? `Done (${result.action}):` : result.changes.length ? `Plan (${result.action}, nothing changed):` : result.note, ...result.changes.map(c => `  • ${c}`)];
  if (result.conflicts?.length) lines.push('Conflicts (install would stop):', ...result.conflicts.map(c => `  • ${c}`));
  if (result.connection) lines.push(`Connection check: ${result.connection}`);
  if (result.next) lines.push('', result.next);
  return lines.join('\n');
}

export async function main(args, dependencies = {}) {
  const telemetry = {
    stage: 'started', outcome: 'ok',
    properties: { command: ['install', 'status', 'remove', 'login', 'logout', 'project', 'doctor'].includes(args[0]) ? args[0] : 'unknown', agent: 'claude-code', scope: 'user', applied: false, installed: false, connection: 'not_checked' },
    async step(stage, outcome, properties = {}) {
      this.stage = stage;
      if (outcome === 'ok') delete this.properties.code;
      Object.assign(this.properties, properties);
      if (args[0] !== 'update') await sendInstallationEvent({ ...this.properties, stage, outcome });
    },
    async fail(error) {
      this.outcome = ({ 10: 'pending', 11: 'denied', 20: 'conflict' })[error.exit] ?? 'error';
      const code = ({ 10: 'approval_pending', 11: 'access_denied', 20: 'install_conflict', 30: 'openmerit_unreachable' })[error.exit] ?? 'command_error';
      await this.step(this.stage, this.outcome, { code, ...(this.stage === 'verification' ? { connection: error.exit === exitCodes.denied ? 'key_rejected' : 'failed' } : {}) });
    },
  };
  try {
    const code = await runMain(args, dependencies, telemetry);
    await telemetry.step('completed', telemetry.outcome);
    return code;
  } catch (error) {
    await telemetry.fail(error);
    await telemetry.step('completed', telemetry.outcome);
    throw error;
  }
}

async function runMain(args, { root = process.cwd(), print = console.log, printError = console.error }, telemetry) {
  const [action, ...rest] = args;
  if (!action || rest.includes('--help') || rest.includes('-h')) { print(help); return exitCodes.ok; }
  const options = { client: undefined, scope: 'user', plan: false, check: false, json: false, open: true, policy: undefined, ids: [], telemetry };
  const allowed = { install: ['--client', '--scope', '--setup-id', '--plan', '--json', '--no-open', '--auto-update'], status: ['--client', '--scope', '--check', '--json'], remove: ['--client', '--scope', '--plan', '--json'],
    login: ['--client', '--scope', '--setup-id', '--json', '--no-open'], logout: ['--client', '--scope', '--json'], project: ['--policy', '--endpoint-id', '--plan', '--json'], doctor: ['--client', '--scope', '--json'], update: ['--client', '--scope', '--auto', '--json'] }[action];
  if (!allowed) throw new Error('Unknown command. Run openmerit --help.');
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (!allowed.includes(option)) throw new Error(`Unknown option for ${action}: ${option}`);
    const value = () => { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${option} needs a value.`); return v; };
    if (option === '--client') options.client = value();
    else if (option === '--scope') options.scope = value();
    else if (option === '--setup-id') { options.setup_id = value(); if (!setupUUID(options.setup_id)) throw new Error('--setup-id must be a UUID v4.'); }
    else if (option === '--policy') options.policy = value();
    else if (option === '--endpoint-id') options.ids.push(value());
    else if (option === '--auto-update' || option === '--auto') { const setting = value(); if (!['on', 'off'].includes(setting)) throw new Error(`${option} needs on or off.`); options.autoUpdate = setting; }
    else if (option === '--no-open') options.open = false;
    else options[option.slice(2)] = true;
  }
  if (!['user', 'project'].includes(options.scope)) throw new Error('Use --scope user or --scope project.');
  if (action !== 'project') {
    options.client ??= detectClient() ?? (['install', 'status', 'remove'].includes(action) ? undefined : 'claude-code');
    if (!options.client) throw new Error('Choose the coding agent with --client claude-code or --client pi.');
    if (!clients[options.client]) throw new Error(`Unsupported client "${options.client}". Supported: ${Object.keys(clients).join(', ')}.`);
  }
  root = resolve(root);
  telemetry.root = root;
  telemetry.properties.agent = options.client ?? 'claude-code';
  // Agents run commands with a few-minute timeout; wait well inside it, then resume.
  const wait = process.env.OPENMERIT_LOGIN_WAIT === undefined ? undefined : Number(process.env.OPENMERIT_LOGIN_WAIT);
  const log = text => (options.json ? printError : print)(text);
  try {
    telemetry.properties.scope = options.scope;
    // Hydrate correlation without creating identities or writing anything. A
    // pending approval owns its setup ID even when the resumed command omits it.
    if (['install', 'status', 'remove', 'doctor'].includes(action)) {
      telemetry.stage = 'preflight';
      const state = await inspect(root, options.scope, options.client);
      Object.assign(telemetry.properties, diagnostics(state));
      if (state.owned) for (const key of ['setup_id', 'installation_id']) if (setupUUID(state.record[key])) telemetry.properties[key] = state.record[key];
    }
    if (options.setup_id) telemetry.properties.setup_id = options.setup_id;
    if (['install', 'login'].includes(action)) {
      const saved = await credentials(telemetry);
      if (!telemetry.properties.setup_id && setupUUID(saved?.setup_id)) telemetry.properties.setup_id = saved.setup_id;
      const pending = await object(pendingPath(telemetry));
      if (pending.server === server() && pending.expiresAt > Date.now() && typeof pending.deviceCode === 'string') {
        if (setupUUID(pending.setup_id)) telemetry.properties.setup_id = pending.setup_id;
        if (!telemetry.properties.installation_id && setupUUID(pending.installation_id)) telemetry.properties.installation_id = pending.installation_id;
      }
    }
    await telemetry.step('started', 'started');
    await telemetry.step('preflight', 'started');
    const base = dirname((options.client === 'pi' ? piPaths : claudePaths)(root, options.scope).record);
    const maintenance = work => options.plan ? work() : withUpdateLock(base, async () => { if (options.client !== 'pi') await recoverUpdates(base, options.scope); return work(); });
    if (action === 'update' && options.client === 'pi') throw new Stop('Update Pi Scout by running npx -y openmerit@latest install --client pi with the same --scope. Automatic hooks are Claude Code only.', exitCodes.error);
    const result = action === 'install' ? await maintenance(() => install(root, { ...options, log, wait }))
      : action === 'status' ? await status(root, options)
      : action === 'remove' ? await maintenance(() => remove(root, options))
      : action === 'update' ? { action, ...await runUpdate(base, options.scope, options.autoUpdate === undefined ? {} : { enabled: options.autoUpdate === 'on' }) }
      : action === 'project' ? await project(root, options)
      : action === 'doctor' ? await doctor(root, options)
      : action === 'logout' ? { action, revoked: await revokeKey(telemetry), note: 'Signed out. This device key was revoked and deleted. Agents configured with it stop working until you run install again.' }
      : (await revokeKey(telemetry), await login({ client: options.client, scope: options.scope, open: options.open, log, wait, telemetry }), { action, signedIn: true, note: `Signed in. Run "openmerit install --client ${options.client} --scope ${options.scope}" to refresh this installation.` });
    if (result.conflicts?.length && telemetry.outcome !== 'error') { telemetry.outcome = 'conflict'; telemetry.properties.code = 'install_conflict'; }
    if (options.plan) await telemetry.step(telemetry.stage, telemetry.outcome, { applied: false });
    print(options.json ? JSON.stringify({ ok: action !== 'update' || !['conflict', 'retry', 'manual_required'].includes(result.status), ...result }, null, 2) : render(result));
    if (action === 'update') return result.status === 'conflict' ? exitCodes.conflict : result.status === 'retry' ? exitCodes.unreachable : result.status === 'manual_required' ? exitCodes.error : exitCodes.ok;
    return action === 'doctor' && !result.ok ? exitCodes.error : exitCodes.ok;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    await telemetry.fail(error);
    if (options.json) print(JSON.stringify({ ok: false, action, code: Object.keys(exitCodes).find(k => exitCodes[k] === error.exit), message: error.message, next: error.next }, null, 2));
    else printError([error.message, error.next].filter(Boolean).join('\n'));
    return error.exit;
  }
}
