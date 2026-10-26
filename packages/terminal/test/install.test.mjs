import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalD1 } from '../../../scout/test/helpers-projection.mjs';
import { handleConnect, deviceKeyUser } from '../../../scout/connect.mjs';
import { handleMCP } from '../../../scout/mcp.mjs';
import { main, rule } from '../src/install.mjs';
import { clientVersion, setupUUID } from '../src/telemetry.mjs';

// A fake `claude` that stores MCP servers like Claude Code does (user or local
// scope in .claude.json) and, on request, fails while echoing its arguments.
const fakeClaude = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.0 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, args.slice(0, 2).join(' ') + '\\n');
if (process.env.FAKE_CLAUDE_FAIL) { console.error('Failed to add server with ' + args.join(' ')); process.exit(1); }
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const scope = args[args.indexOf('--scope') + 1];
const target = scope === 'user' ? config : ((config.projects ??= {})[process.cwd()] ??= {});
target.mcpServers ??= {};
if (args[1] === 'add-json') target.mcpServers[args[4]] = JSON.parse(args[5]);
if (args[1] === 'remove') delete target.mcpServers[args.at(-1)];
fs.writeFileSync(file, JSON.stringify(config));
`;

async function harness(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'openmerit-install-')));
  const bin = join(dir, 'bin'), root = join(dir, 'project'), claudeDir = join(dir, 'claude');
  await Promise.all([mkdir(bin), mkdir(root), mkdir(claudeDir)]);
  await writeFile(join(bin, 'claude'), fakeClaude); await chmod(join(bin, 'claude'), 0o755);
  const env = { SCOUT_INDEX: new LocalD1() }, requests = [], events = [], transport = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, headers: req.headers });
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === 'GET' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
    let response;
    if (url.pathname.startsWith('/connect/api/')) response = await handleConnect(request, env, { session: async () => null });
    else if (url.pathname === '/scout/mcp') {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      response = transport.mcpStatus ? Response.json({}, { status: transport.mcpStatus }) : await deviceKeyUser(env, token ?? '') ? await handleMCP(request, {}) : Response.json({ code: 'device_key_required' }, { status: 401 });
    } else response = Response.json({ ok: true });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, OPENMERIT_URL: `http://127.0.0.1:${server.address().port}`, OPENMERIT_CONFIG_DIR: join(dir, 'openmerit'),
    CLAUDE_CONFIG_DIR: claudeDir, OPENMERIT_LOGIN_WAIT: '0', OPENMERIT_DEVICE_NAME: 'test-laptop', FAKE_CLAUDE_LOG: join(dir, 'claude.log'), OPENMERIT_TELEMETRY: '0', DO_NOT_TRACK: '', OPENMERIT_ANALYTICS_ACCOUNT: '' });
  delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT;
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://openmerit.ai/scout/api/analytics') {
      events.push({ ...JSON.parse(options.body), headers: options.headers });
      if (transport.analytics === 'hang') return new Promise(() => {});
      if (transport.analytics === 'fail') throw new Error('PRIVATE analytics failure');
      return new Response(null);
    }
    if (new URL(url).pathname === '/connect/api/keys/self') {
      if (transport.revokeStatus) return Response.json({}, { status: transport.revokeStatus });
      if (transport.revokeUnreachable) throw new Error('PRIVATE revocation network failure');
    }
    if (transport.unreachable && new URL(url).pathname === '/scout/mcp') throw new Error('PRIVATE network failure');
    return fetcher(url, options);
  };
  t.after(async () => { globalThis.fetch = fetcher; process.env = saved; server.close(); await rm(dir, { recursive: true, force: true }); });
  const run = async (...args) => {
    let out = '', stdout = '', stderr = '';
    const code = await main(args, { root, print: text => { out += `${text}\n`; stdout += `${text}\n`; }, printError: text => { out += `${text}\n`; stderr += `${text}\n`; } });
    return { code, out, stdout, stderr };
  };
  const approve = async userCode => {
    const response = await handleConnect(new Request('http://x/connect/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: userCode, decision: 'approve' }) }), env, { session: async () => 'user_alice' });
    assert.equal(response.status, 200);
  };
  const claudeConfig = async () => JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8'));
  return { run, approve, claudeConfig, env, root, claudeDir, dir, requests, events, transport };
}

test('install signs in once, resumes a pending approval, installs, verifies and stays idempotent', async t => {
  const h = await harness(t);
  await assert.rejects(h.run('install'), /--client claude-code/); // no detected agent

  const pending = await h.run('install', '--client', 'claude-code', '--no-open');
  assert.equal(pending.code, 10);
  const userCode = pending.out.match(/Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.match(pending.out, new RegExp(`/connect\\?code=${userCode}`));
  // Rerunning resumes the same request instead of issuing a new code.
  assert.match((await h.run('install', '--client', 'claude-code', '--no-open')).out, new RegExp(`Code: ${userCode}`));

  await h.approve(userCode);
  process.env.CLAUDECODE = '1'; // detected client
  const done = await h.run('install', '--no-open');
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /Connection check: connected/);
  const server = (await h.claudeConfig()).mcpServers.openmerit;
  const key = server.headers.Authorization.replace('Bearer ', '');
  assert.match(key, /^om_/); assert.equal(server.url, `${process.env.OPENMERIT_URL}/scout/mcp`);
  assert.equal((await deviceKeyUser(h.env, key)).userId, 'user_alice');
  assert.ok(!done.out.includes(key), 'the key is never printed');
  assert.match(await readFile(join(h.claudeDir, 'skills/openmerit-scout/SKILL.md'), 'utf8'), /^---\nname: openmerit-scout\n/);
  assert.equal(await readFile(join(h.claudeDir, 'rules/openmerit-scout.md'), 'utf8'), rule);
  const settingsPath = join(h.claudeDir, 'settings.json');
  const hooks = JSON.parse(await readFile(settingsPath, 'utf8')).hooks;
  assert.equal(hooks.SessionStart[0].hooks[0].async, true);
  assert.equal(hooks.Stop[0].hooks[0].async, true);
  assert.equal(JSON.parse((await h.run('status', '--json')).out).autoUpdates, true);
  assert.equal((await h.run('update', '--auto', 'off', '--json')).code, 0);
  assert.equal(JSON.parse((await h.run('status', '--json')).out).autoUpdates, false);

  const calls = (await readFile(process.env.FAKE_CLAUDE_LOG, 'utf8')).trim().split('\n').length;
  const again = await h.run('install', '--json');
  assert.equal(again.code, 0); assert.equal(JSON.parse(again.out).connection, 'connected');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).hooks, {}, 'rerunning install preserves the automatic-update opt-out');
  assert.equal((await h.run('update', '--auto', 'on')).code, 0);
  const partial = JSON.parse(await readFile(join(h.claudeDir, 'openmerit-install.json'), 'utf8'));
  partial.pendingUpdates = partial.updates; delete partial.updates;
  await writeFile(join(h.claudeDir, 'openmerit-install.json'), JSON.stringify(partial));
  assert.equal((await h.run('install', '--json')).code, 0, 'an interrupted updater bootstrap resumes without treating its files as foreign');
  assert.equal((await readFile(process.env.FAKE_CLAUDE_LOG, 'utf8')).trim().split('\n').length, calls, 'an unchanged install does not rewrite Claude config');
  assert.equal(JSON.parse((await h.run('status', '--check', '--json')).out).installed, true);

  const rulePath = join(h.claudeDir, 'rules/openmerit-scout.md');
  const recordPath = join(h.claudeDir, 'openmerit-install.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  // Upgrade an existing stable skill-only installation without signing in again.
  delete record.ruleHash; record.version = 2;
  await writeFile(recordPath, JSON.stringify(record));
  await rm(rulePath);
  const beforeUpgrade = JSON.parse((await h.run('status', '--json')).out);
  assert.equal(beforeUpgrade.installed, false); assert.equal(beforeUpgrade.rule, 'missing');
  assert.equal(JSON.parse((await h.run('doctor', '--json')).out).checks.find(c => c.name === 'install').ok, false);
  const plan = await h.run('install', '--plan');
  assert.match(plan.out, /rules\/openmerit-scout.md/);
  await assert.rejects(readFile(rulePath), { code: 'ENOENT' }, 'plan does not write the rule');
  assert.equal((await h.run('install')).code, 0);
  assert.equal((await h.claudeConfig()).mcpServers.openmerit.headers.Authorization, `Bearer ${key}`);
  assert.equal(await readFile(rulePath, 'utf8'), rule);
  assert.equal(JSON.parse((await h.run('status', '--json')).out).rule, 'matches');

  // Rerun after interruption between writing the new rule and finalizing ownership.
  const interrupted = JSON.parse(await readFile(recordPath, 'utf8'));
  interrupted.ruleHash = createHash('sha256').update('previous rule').digest('hex');
  interrupted.pendingRule = createHash('sha256').update(rule).digest('hex');
  await writeFile(recordPath, JSON.stringify(interrupted));
  assert.equal((await h.run('install')).code, 0);
  await rm(rulePath);
  assert.equal((await h.run('install')).code, 0, 'missing owned rule is repaired');
  await writeFile(join(h.claudeDir, 'rules/personal.md'), 'Keep my instructions');
  assert.equal((await h.run('remove')).code, 0);
  await assert.rejects(readFile(rulePath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).hooks, {});
  await assert.rejects(readFile(join(h.claudeDir, 'openmerit-updater.mts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(h.claudeDir, 'rules/personal.md'), 'utf8'), 'Keep my instructions');
});

test('install refuses to overwrite user edits or foreign servers, and remove revokes the key', async t => {
  const h = await harness(t);
  await writeFile(join(h.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { openmerit: { type: 'http', url: 'https://other.example/mcp' } } }));
  const foreign = await h.run('install', '--client', 'claude-code', '--no-open');
  assert.equal(foreign.code, 20); assert.match(foreign.out, /did not create/);
  await writeFile(join(h.claudeDir, '.claude.json'), '{}');

  const rulePath = join(h.claudeDir, 'rules/openmerit-scout.md');
  await mkdir(join(h.claudeDir, 'rules'));
  await writeFile(rulePath, 'My own Scout instructions');
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 20);
  await assert.rejects(readFile(join(h.dir, 'openmerit/login.json')), { code: 'ENOENT' }, 'conflict is caught before sign-in');
  assert.equal(await readFile(rulePath, 'utf8'), 'My own Scout instructions');
  await rm(rulePath);

  const userCode = (await h.run('install', '--client', 'claude-code', '--no-open')).out.match(/Code: (\S+)/)[1];
  await h.approve(userCode);
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 0);
  const settingsPath = join(h.claudeDir, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.hooks.Stop[0].hooks[0].timeout = 25;
  await writeFile(settingsPath, JSON.stringify(settings));
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 20, 'edited maintenance hooks are not overwritten');
  const skillPath = join(h.claudeDir, 'skills/openmerit-scout/SKILL.md');
  await writeFile(skillPath, 'my edits');
  const edited = await h.run('install', '--client', 'claude-code');
  assert.equal(edited.code, 20); assert.equal(await readFile(skillPath, 'utf8'), 'my edits');
  await writeFile(rulePath, 'my rule edits');
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 20);
  assert.equal(JSON.parse((await h.run('status', '--client', 'claude-code', '--json')).out).rule, 'modified_or_unowned');

  const key = (await h.claudeConfig()).mcpServers.openmerit.headers.Authorization.slice(7);
  const removed = await h.run('remove', '--client', 'claude-code', '--json');
  assert.equal(removed.code, 0); assert.equal(JSON.parse(removed.out).keyRevoked, true);
  assert.equal((await h.claudeConfig()).mcpServers.openmerit, undefined);
  assert.equal(await readFile(skillPath, 'utf8'), 'my edits', 'edited skill is kept');
  assert.equal(await readFile(rulePath, 'utf8'), 'my rule edits', 'edited startup rule is kept');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).hooks.Stop, settings.hooks.Stop, 'edited hook is kept');
  assert.ok(await readFile(join(h.claudeDir, 'openmerit-updater.mts')), 'an edited hook keeps its referenced runner');
  assert.equal(await deviceKeyUser(h.env, key), null);
});

test('a failing claude command never leaks the key, and project scope keeps it out of the repository', async t => {
  const h = await harness(t);
  const userCode = (await h.run('install', '--client', 'claude-code', '--scope', 'project', '--no-open')).out.match(/Code: (\S+)/)[1];
  await h.approve(userCode);
  process.env.FAKE_CLAUDE_FAIL = '1';
  const failed = await h.run('install', '--client', 'claude-code', '--scope', 'project');
  delete process.env.FAKE_CLAUDE_FAIL;
  assert.equal(failed.code, 1); assert.match(failed.out, /\[key\]/); assert.doesNotMatch(failed.out, /om_[A-Za-z0-9_-]{20,}/);

  assert.equal((await h.run('install', '--client', 'claude-code', '--scope', 'project')).code, 0);
  assert.ok((await h.claudeConfig()).projects[h.root].mcpServers.openmerit, 'stored in Claude private local scope');
  await assert.rejects(readFile(join(h.root, '.mcp.json')));
  assert.match(await readFile(join(h.root, '.claude/skills/openmerit-scout/SKILL.md'), 'utf8'), /openmerit-scout/);
  assert.equal(await readFile(join(h.root, '.claude/rules/openmerit-scout.md'), 'utf8'), rule);
  await assert.rejects(readFile(join(h.claudeDir, 'rules/openmerit-scout.md')), { code: 'ENOENT' });
  const settings = JSON.parse(await readFile(join(h.root, '.claude/settings.local.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /--scope project --hook/);
  await assert.rejects(readFile(join(h.claudeDir, 'settings.json')), { code: 'ENOENT' });
});

test('install opens only the approval page, once, and resumes without reopening it', { skip: process.platform !== 'linux' }, async t => {
  const h = await harness(t);
  delete process.env.OPENMERIT_TELEMETRY;
  const opener = join(h.dir, 'bin', 'xdg-open'), opened = join(h.dir, 'opened.log');
  await writeFile(opener, `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`); await chmod(opener, 0o755);
  process.env.DISPLAY = ':0'; delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
  const first = await h.run('install', '--client', 'claude-code');
  assert.equal(first.code, 10);
  const userCode = first.out.match(/Code: (\S+)/)[1];
  assert.deepEqual((await readFile(opened, 'utf8')).trim().split('\n'), [`${process.env.OPENMERIT_URL}/connect?code=${userCode}`]);
  await h.approve(userCode);
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 0);
  assert.equal((await readFile(opened, 'utf8')).trim().split('\n').length, 1, 'a resumed login does not open a second tab');
});

const setupId = '359afdd2-0e4e-4f5b-9a91-2213814b1234';
const installArgs = ['install', '--client', 'claude-code', '--no-open'];

test('default lifecycle correlates browser setup, resumed login, ownership, verification, status and remove', async t => {
  const h = await harness(t);
  delete process.env.OPENMERIT_TELEMETRY;
  const pending = await h.run(...installArgs, '--setup-id', setupId);
  assert.equal(pending.code, 10);
  const login = JSON.parse(await readFile(join(h.dir, 'openmerit/login.json'), 'utf8'));
  assert.equal(login.setup_id, setupId); assert.ok(setupUUID(login.installation_id));
  const approval = new URL(login.url);
  assert.equal(approval.searchParams.get('setup_id'), setupId);
  assert.equal(approval.searchParams.has('analytics'), false);
  assert.equal(h.events.at(-1).properties.outcome, 'pending');
  assert.equal(h.events.at(-1).properties.code, 'approval_pending');
  await h.approve(login.userCode);
  const start = h.events.length;
  assert.equal((await h.run(...installArgs)).code, 0);
  const record = JSON.parse(await readFile(join(h.claudeDir, 'openmerit-install.json'), 'utf8'));
  assert.equal(record.setup_id, setupId); assert.equal(record.installation_id, login.installation_id);
  const headers = (await h.claudeConfig()).mcpServers.openmerit.headers;
  assert.equal(headers['X-Scout-Client'], 'agent');
  assert.equal(headers['X-Scout-Agent'], 'claude-code');
  assert.equal(headers['X-Scout-Client-Version'], clientVersion);
  assert.equal(headers['X-Scout-Setup-Id'], setupId);
  assert.equal(headers['X-Scout-Installation-Id'], record.installation_id);
  assert.equal(headers['X-Scout-Analytics'], undefined, 'default MCP analytics is not overridden');
  const lifecycle = h.events.slice(start);
  assert.ok(lifecycle.some(e => e.properties.stage === 'configuration' && e.properties.outcome === 'ok'));
  assert.ok(lifecycle.some(e => e.properties.stage === 'verification' && e.properties.connection === 'connected'));
  assert.deepEqual(Object.fromEntries(['applied', 'installed', 'rule_status', 'skill_status', 'server_status', 'connection'].map(k => [k, lifecycle.at(-1).properties[k]])),
    { applied: true, installed: true, rule_status: 'matches', skill_status: 'matches', server_status: 'matches', connection: 'connected' });
  for (const event of lifecycle) {
    assert.equal(event.properties.setup_id, setupId); assert.equal(event.properties.installation_id, record.installation_id);
  }
  for (const request of h.requests) {
    assert.equal(request.headers['x-scout-client'], 'cli');
    assert.equal(request.headers['x-scout-agent'], 'claude-code');
    assert.equal(request.headers['x-scout-client-version'], clientVersion);
    assert.equal(request.headers['x-scout-setup-id'], setupId);
    assert.equal(request.headers['x-scout-installation-id'], record.installation_id);
    assert.equal(request.headers['x-scout-analytics'], 'on');
  }
  await h.run(...installArgs);
  assert.equal(JSON.parse(await readFile(join(h.claudeDir, 'openmerit-install.json'), 'utf8')).installation_id, record.installation_id, 'upgrades retain identity');
  await writeFile(join(h.claudeDir, 'rules/openmerit-scout.md'), 'PRIVATE edited rule');
  const status = await h.run('status', '--client', 'claude-code', '--check', '--json');
  assert.equal(JSON.parse(status.out).rule, 'modified_or_unowned');
  const statusEvent = h.events.findLast(e => e.properties.stage === 'status');
  assert.equal(statusEvent.properties.rule_status, 'modified_or_unowned');
  assert.equal(statusEvent.properties.installed, false); assert.equal(statusEvent.properties.outcome, 'conflict');
  await h.run('remove', '--client', 'claude-code');
  assert.equal(h.events.at(-1).properties.installation_id, record.installation_id);
  assert.equal(h.events.at(-1).properties.installed, false);
  assert.equal(new Set(h.events.map(e => e.event_id)).size, h.events.length);
  for (const event of h.events) { assert.equal(event.event, 'scout_installation_step'); assert.ok(setupUUID(event.event_id)); }
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE|om_[A-Za-z0-9_-]{20,}|Bearer|test-laptop|deviceCode|userCode/);
  assert.ok(!JSON.stringify(h.events).includes(h.dir), 'paths never leave the device');
});

test('verification failures are errors in telemetry even when install/status retain successful exit semantics', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  const pending = await h.run(...installArgs, '--setup-id', setupId);
  await h.approve(pending.out.match(/Code: (\S+)/)[1]);
  h.transport.mcpStatus = 503;
  const result = await h.run(...installArgs, '--json');
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).connection, 'failed');
  assert.equal(h.events.at(-1).properties.outcome, 'error');
  assert.equal(h.events.at(-1).properties.installed, true);
  assert.ok(h.events.some(e => e.properties.stage === 'verification' && e.properties.outcome === 'error' && e.properties.connection === 'failed'));
  assert.equal((await h.run('status', '--client', 'claude-code', '--check')).code, 0);
  assert.equal(h.events.at(-1).properties.outcome, 'error');
  h.transport.mcpStatus = 401;
  await h.run('status', '--client', 'claude-code', '--check');
  assert.equal(h.events.at(-1).properties.connection, 'key_rejected');
  h.transport.unreachable = true;
  assert.equal((await h.run('status', '--client', 'claude-code', '--check')).code, 30);
  assert.equal(h.events.at(-2).properties.stage, 'verification');
  assert.equal(h.events.at(-2).properties.code, 'openmerit_unreachable');
});

test('failed remote revocation is recorded even when local removal or logout succeeds', async t => {
  for (const command of ['remove', 'logout']) await t.test(command, async t => {
    const h = await harness(t);
    process.env.OPENMERIT_TELEMETRY = '1';
    const pending = await h.run(...installArgs, '--setup-id', setupId);
    await h.approve(pending.out.match(/Code: (\S+)/)[1]);
    await h.run(...installArgs);
    if (command === 'remove') h.transport.revokeStatus = 503;
    else h.transport.revokeUnreachable = true;
    const result = await h.run(command, ...(command === 'remove' ? ['--client', 'claude-code'] : []), '--json');
    assert.equal(result.code, 0, 'existing local command exit semantics are unchanged');
    assert.equal(JSON.parse(result.out)[command === 'remove' ? 'keyRevoked' : 'revoked'], false);
    assert.equal(h.events.at(-1).properties.outcome, 'error');
    assert.equal(h.events.at(-1).properties.code, command === 'remove' ? 'command_error' : 'openmerit_unreachable');
    assert.ok(h.events.some(e => e.properties.command === command && e.properties.stage === 'remove' && e.properties.outcome === 'error'));
    await assert.rejects(readFile(join(h.dir, 'openmerit/credentials.json')), { code: 'ENOENT' });
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE|om_[A-Za-z0-9_-]{20,}|Bearer/);
  });
});

test('explicit opt-outs suppress setup and installed analytics; unlinking keeps usage without IDs', async t => {
  for (const mode of ['off', 'dnt', 'account-off']) await t.test(mode, async t => {
    const h = await harness(t);
    if (mode === 'dnt') { process.env.OPENMERIT_TELEMETRY = '1'; process.env.DO_NOT_TRACK = '1'; }
    if (mode === 'account-off') { delete process.env.OPENMERIT_TELEMETRY; process.env.OPENMERIT_ANALYTICS_ACCOUNT = 'off'; }
    const pending = await h.run(...installArgs, '--setup-id', setupId);
    const login = JSON.parse(await readFile(join(h.dir, 'openmerit/login.json'), 'utf8'));
    const url = new URL(login.url);
    assert.equal(url.searchParams.get('analytics'), mode === 'account-off' ? null : 'off');
    assert.equal(url.searchParams.get('setup_id'), null);
    assert.equal(url.searchParams.get('analytics_account'), 'off');
    await h.approve(pending.out.match(/Code: (\S+)/)[1]);
    assert.equal((await h.run(...installArgs)).code, 0);
    const headers = (await h.claudeConfig()).mcpServers.openmerit.headers;
    assert.equal(headers['X-Scout-Analytics'], mode === 'account-off' ? undefined : 'off');
    assert.equal(headers['X-Scout-Analytics-Account'], 'off');
    assert.equal(headers['X-Scout-Installation-Id'], undefined);
    assert.equal(login.installation_id, undefined, 'refused correlation must not create an identity');
    for (const request of h.requests) {
      assert.equal(request.headers['x-scout-analytics'], mode === 'account-off' ? 'on' : 'off');
      assert.equal(request.headers['x-scout-installation-id'], undefined);
      assert.equal(request.headers['x-scout-setup-id'], undefined);
    }
    if (mode !== 'account-off') assert.deepEqual(h.events, []);
    else assert.ok(h.events.every(e => e.headers['X-Scout-Analytics-Account'] === 'off' && !e.properties.setup_id && !e.properties.installation_id));
  });
});

test('plan and status are read-only, validate UUIDs, and stage thrown/configuration errors without private text', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  await assert.rejects(h.run(...installArgs, '--setup-id', 'PRIVATE invalid id'), /UUID v4/);
  assert.equal(h.events.at(-1).properties.code, 'command_error');
  h.events.length = 0;
  await h.run(...installArgs, '--setup-id', setupId, '--plan');
  await h.run('status', '--client', 'claude-code');
  assert.ok(h.events.every(e => !e.properties.installed && !e.properties.applied && !e.properties.installation_id));
  assert.equal(h.events.at(-1).properties.outcome, 'not_installed');
  await assert.rejects(readFile(join(h.dir, 'openmerit/login.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(h.claudeDir, 'openmerit-install.json')), { code: 'ENOENT' });
  const pending = await h.run(...installArgs, '--setup-id', setupId);
  await h.approve(pending.out.match(/Code: (\S+)/)[1]);
  process.env.FAKE_CLAUDE_FAIL = '1';
  assert.equal((await h.run(...installArgs)).code, 1);
  assert.equal(h.events.at(-2).properties.stage, 'configuration');
  assert.equal(h.events.at(-2).properties.outcome, 'error');
  delete process.env.FAKE_CLAUDE_FAIL;
  assert.equal((await h.run(...installArgs)).code, 0, 'interrupted intent record is repaired');
  const config = await h.claudeConfig();
  config.mcpServers.openmerit.headers['X-Scout-Client'] = 'PRIVATE user edit';
  await writeFile(join(h.claudeDir, '.claude.json'), JSON.stringify(config));
  assert.equal((await h.run(...installArgs)).code, 20, 'edited headers remain protected');
  assert.equal(h.events.at(-2).properties.stage, 'preflight');
  assert.equal(h.events.at(-2).properties.outcome, 'conflict');
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE|Bearer|om_[A-Za-z0-9_-]{20,}/);
});

test('owned headers update on consent changes without changing installation identity', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  const pending = await h.run(...installArgs, '--setup-id', setupId);
  await h.approve(pending.out.match(/Code: (\S+)/)[1]);
  await h.run(...installArgs);
  const id = (await h.claudeConfig()).mcpServers.openmerit.headers['X-Scout-Installation-Id'];
  process.env.OPENMERIT_TELEMETRY = '0';
  await h.run(...installArgs);
  const defaultHeaders = (await h.claudeConfig()).mcpServers.openmerit.headers;
  assert.equal(defaultHeaders['X-Scout-Analytics'], 'off');
  assert.equal(defaultHeaders['X-Scout-Installation-Id'], undefined);
  assert.equal(defaultHeaders['X-Scout-Setup-Id'], undefined);
  process.env.OPENMERIT_TELEMETRY = '1';
  process.env.DO_NOT_TRACK = '1';
  assert.equal((await h.run(...installArgs)).code, 0);
  let headers = (await h.claudeConfig()).mcpServers.openmerit.headers;
  assert.equal(headers['X-Scout-Analytics'], 'off'); assert.equal(headers['X-Scout-Setup-Id'], undefined);
  assert.equal(headers['X-Scout-Installation-Id'], undefined);
  process.env.DO_NOT_TRACK = '';
  await h.run(...installArgs);
  headers = (await h.claudeConfig()).mcpServers.openmerit.headers;
  assert.equal(headers['X-Scout-Installation-Id'], id); assert.equal(headers['X-Scout-Setup-Id'], setupId);
  assert.equal(headers['X-Scout-Analytics'], undefined);
});

test('telemetry delivery failures and ignored aborts are bounded and do not break public main', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  for (const mode of ['fail', 'hang']) {
    h.transport.analytics = mode;
    const start = performance.now();
    const result = await h.run(...installArgs, '--plan', '--json');
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.out).applied, false);
    assert.ok(performance.now() - start < 7000, 'four milestone deliveries have a hard 1.5-second bound each');
  }
});

test('explicit login resumes and passes its setup ID to subsequent install without generating an installation ID', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  const first = await h.run('login', '--no-open', '--setup-id', setupId);
  assert.equal(first.code, 10);
  const code = first.out.match(/Code: (\S+)/)[1];
  assert.equal(JSON.parse(await readFile(join(h.dir, 'openmerit/login.json'), 'utf8')).installation_id, undefined);
  await h.approve(code);
  assert.equal((await h.run('login', '--no-open')).code, 0);
  assert.ok(h.events.every(e => e.properties.installation_id === undefined));
  assert.equal(h.events.at(-1).properties.setup_id, setupId);
  assert.equal((await h.run(...installArgs)).code, 0);
  assert.equal((await h.claudeConfig()).mcpServers.openmerit.headers['X-Scout-Setup-Id'], setupId);
  assert.ok(setupUUID(h.events.at(-1).properties.installation_id));
});

test('resumed approval rebuilds its URL and requests after a telemetry refusal', async t => {
  const h = await harness(t);
  process.env.OPENMERIT_TELEMETRY = '1';
  const first = await h.run(...installArgs, '--setup-id', setupId);
  const code = first.out.match(/Code: (\S+)/)[1];
  const count = h.events.length;
  process.env.DO_NOT_TRACK = '1';
  const resumed = await h.run(...installArgs);
  assert.equal(resumed.code, 10); assert.equal(h.events.length, count);
  const pending = JSON.parse(await readFile(join(h.dir, 'openmerit/login.json'), 'utf8'));
  assert.equal(pending.userCode, code); assert.equal(pending.setup_id, setupId);
  assert.equal(new URL(pending.url).searchParams.has('setup_id'), false);
  assert.equal(new URL(pending.url).searchParams.get('analytics'), 'off');
  assert.equal(h.requests.at(-1).headers['x-scout-setup-id'], undefined);
  assert.equal(h.requests.at(-1).headers['x-scout-analytics'], 'off');
});
