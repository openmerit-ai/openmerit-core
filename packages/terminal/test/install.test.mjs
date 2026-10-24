import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalD1 } from '../../../scout/test/helpers-projection.mjs';
import { handleConnect, deviceKeyUser } from '../../../scout/connect.mjs';
import { handleMCP } from '../../../scout/mcp.mjs';
import { main } from '../src/install.mjs';

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
  const env = { SCOUT_INDEX: new LocalD1() };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === 'GET' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
    let response;
    if (url.pathname.startsWith('/connect/api/')) response = await handleConnect(request, env, { session: async () => null });
    else if (url.pathname === '/scout/mcp') {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      response = await deviceKeyUser(env, token ?? '') ? await handleMCP(request, {}) : Response.json({ code: 'device_key_required' }, { status: 401 });
    } else response = Response.json({ ok: true });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, OPENMERIT_URL: `http://127.0.0.1:${server.address().port}`, OPENMERIT_CONFIG_DIR: join(dir, 'openmerit'),
    CLAUDE_CONFIG_DIR: claudeDir, OPENMERIT_LOGIN_WAIT: '0', OPENMERIT_DEVICE_NAME: 'test-laptop', FAKE_CLAUDE_LOG: join(dir, 'claude.log') });
  delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT;
  t.after(async () => { process.env = saved; server.close(); await rm(dir, { recursive: true, force: true }); });
  const run = async (...args) => {
    let out = '';
    const code = await main(args, { root, print: text => { out += `${text}\n`; }, printError: text => { out += `${text}\n`; } });
    return { code, out };
  };
  const approve = async userCode => {
    const response = await handleConnect(new Request('http://x/connect/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: userCode, decision: 'approve' }) }), env, { session: async () => 'user_alice' });
    assert.equal(response.status, 200);
  };
  const claudeConfig = async () => JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8'));
  return { run, approve, claudeConfig, env, root, claudeDir, dir };
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

  const calls = (await readFile(process.env.FAKE_CLAUDE_LOG, 'utf8')).trim().split('\n').length;
  const again = await h.run('install', '--json');
  assert.equal(again.code, 0); assert.equal(JSON.parse(again.out).connection, 'connected');
  assert.equal((await readFile(process.env.FAKE_CLAUDE_LOG, 'utf8')).trim().split('\n').length, calls, 'an unchanged install does not rewrite Claude config');
  assert.equal(JSON.parse((await h.run('status', '--check', '--json')).out).installed, true);
});

test('install refuses to overwrite user edits or foreign servers, and remove revokes the key', async t => {
  const h = await harness(t);
  await writeFile(join(h.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { openmerit: { type: 'http', url: 'https://other.example/mcp' } } }));
  const foreign = await h.run('install', '--client', 'claude-code', '--no-open');
  assert.equal(foreign.code, 20); assert.match(foreign.out, /did not create/);
  await writeFile(join(h.claudeDir, '.claude.json'), '{}');

  const userCode = (await h.run('install', '--client', 'claude-code', '--no-open')).out.match(/Code: (\S+)/)[1];
  await h.approve(userCode);
  assert.equal((await h.run('install', '--client', 'claude-code')).code, 0);
  const skillPath = join(h.claudeDir, 'skills/openmerit-scout/SKILL.md');
  await writeFile(skillPath, 'my edits');
  const edited = await h.run('install', '--client', 'claude-code');
  assert.equal(edited.code, 20); assert.equal(await readFile(skillPath, 'utf8'), 'my edits');

  const key = (await h.claudeConfig()).mcpServers.openmerit.headers.Authorization.slice(7);
  const removed = await h.run('remove', '--client', 'claude-code', '--json');
  assert.equal(removed.code, 0); assert.equal(JSON.parse(removed.out).keyRevoked, true);
  assert.equal((await h.claudeConfig()).mcpServers.openmerit, undefined);
  assert.equal(await readFile(skillPath, 'utf8'), 'my edits', 'edited skill is kept');
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
});

test('install opens only the approval page, once, and resumes without reopening it', { skip: process.platform !== 'linux' }, async t => {
  const h = await harness(t);
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
