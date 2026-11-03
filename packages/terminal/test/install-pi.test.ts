import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const load = (path: string) => import(new URL(path, import.meta.url).href);
const { LocalD1 } = await load('../../../scout/test/helpers-projection.mjs');
const { handleConnect, deviceKeyUser } = await load('../../../scout/connect.mjs');
const { handleMCP } = await load('../../../scout/mcp.mjs');

test('Pi CLI setup isolates approvals and keys by client/scope, preserves edits, and survives reinstall', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openmerit-pi-install-'));
  const config = join(root, 'private'), agentDir = join(root, 'pi-agent'), project = join(root, 'project');
  await mkdir(project);
  const env = { SCOUT_INDEX: new LocalD1() };
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method!, headers: req.headers as Record<string, string>,
      ...(req.method === 'GET' ? {} : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }) });
    requests.push(new URL(request.url).pathname);
    const token = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
    const response: Response = req.url?.startsWith('/connect/api/')
      ? await handleConnect(request, env, { session: async () => null })
      : await deviceKeyUser(env, token) ? await handleMCP(request, {}) : Response.json({}, { status: 401 });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const host = `http://127.0.0.1:${address.port}`;
  const environment = { ...process.env, OPENMERIT_CONFIG_DIR: config, PI_CODING_AGENT_DIR: agentDir,
    OPENMERIT_URL: host, OPENMERIT_LOGIN_WAIT: '0', OPENMERIT_TELEMETRY: '0', PATH: `${resolve(repository, 'node_modules/.bin')}:${process.env.PATH}` };
  const cli = resolve(repository, 'packages/terminal/src/cli.mjs');
  const run = async (...args: string[]) => {
    try { const result = await exec(process.execPath, [cli, ...args, '--json'], { cwd: project, env: environment }); return { code: 0, ...result }; }
    catch (error) {
      if (!(error instanceof Error) || !('stdout' in error) || !('stderr' in error) || !('code' in error)) throw error;
      return { code: Number(error.code), stdout: String(error.stdout), stderr: String(error.stderr) };
    }
  };
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const install = async (scope: 'user' | 'project') => {
    const pending = await run('install', '--client', 'pi', '--scope', scope, '--no-open');
    assert.equal(pending.code, 10, pending.stderr);
    const code = pending.stderr.match(/Code: (\S+)/)?.[1]; assert.ok(code);
    const approval = await handleConnect(new Request(`${host}/connect/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, decision: 'approve' }) }), env, { session: async () => 'user_pi_test' });
    assert.equal(approval.status, 200);
    const done = await run('install', '--client', 'pi', '--scope', scope, '--no-open');
    assert.equal(done.code, 0, done.stderr); assert.equal(JSON.parse(done.stdout).connection, 'connected');
    return done;
  };
  const plan = await run('install', '--client', 'pi', '--plan');
  assert.equal(plan.code, 0); assert.deepEqual(requests, []);
  await assert.rejects(stat(agentDir), { code: 'ENOENT' });
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { openmerit: { url: 'https://example.com/mcp' } } }));
  assert.equal((await run('install', '--client', 'pi', '--scope', 'project')).code, 20, 'global MCP entry must not be shadowed by a project extension');
  assert.deepEqual(requests, [], 'duplicate preflight makes no approval request');
  await rm(join(agentDir, 'mcp.json'));
  // A pre-existing Claude user key must neither be reused nor revoked by Pi.
  const claudeKey = `om_${'c'.repeat(43)}`;
  await mkdir(config); await writeFile(join(config, 'credentials.json'), JSON.stringify({ version: 1, server: host, key: claudeKey }));
  const done = await install('project');
  const extension = join(project, '.pi/extensions/openmerit-scout.ts');
  const locator = await read(join(project, '.pi/extensions/openmerit-scout.json'));
  assert.equal(typeof locator.credentialsPath, 'string');
  assert.ok(!String(locator.credentialsPath).startsWith(project));
  const projectKey = await read(String(locator.credentialsPath));
  assert.notEqual(projectKey.key, claudeKey); assert.ok(!done.stdout.includes(String(projectKey.key)));
  assert.equal((await stat(String(locator.credentialsPath))).mode & 0o777, 0o600);
  assert.equal((await read(join(config, 'credentials.json'))).key, claudeKey);
  assert.equal((projectKey.headers as Record<string, string>)['X-Scout-Agent'], 'pi');
  const original = await readFile(extension, 'utf8'); assert.ok(original.length < 30_000);
  // Use default discovery, not -e/an explicit factory: a loadable extension
  // suffix is part of the installed product contract.
  const settingsManager = SettingsManager.inMemory({ packages: [], cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
    noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(root, 'mcp.log') })],
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: project, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(project) });
  try {
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({});
    await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Discovery acceptance' }, { cwd: project });
    assert.ok(session.getActiveToolNames().includes('mcp__openmerit__scout_models'), 'installed project adapter is automatically discovered with native MCP');
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
  }
  const again = await run('install', '--client', 'pi', '--scope', 'project');
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await read(String(locator.credentialsPath))).key, projectKey.key);
  const status = await run('status', '--client', 'pi', '--scope', 'project', '--check');
  assert.equal(JSON.parse(status.stdout).installed, true); assert.equal(JSON.parse(status.stdout).connection, 'connected');
  const conflict = await run('install', '--client', 'pi', '--scope', 'user');
  assert.equal(conflict.code, 20, 'a duplicate user/project extension must not silently shadow another');
  await writeFile(extension, `${original}\n// User edit\n`);
  assert.equal((await run('install', '--client', 'pi', '--scope', 'project')).code, 20);
  const removal = await run('remove', '--client', 'pi', '--scope', 'project');
  assert.equal(removal.code, 0); assert.equal(JSON.parse(removal.stdout).keyRevoked, true);
  assert.match(await readFile(extension, 'utf8'), /User edit/);
  assert.equal(await deviceKeyUser(env, projectKey.key), null);
  assert.equal((await read(join(config, 'credentials.json'))).key, claudeKey);
  // After explicit removal of the retained edited file, user scope can install.
  await rm(extension);
  await install('user');
  const userLocator = await read(join(agentDir, 'extensions/openmerit-scout.json'));
  const userKey = await read(String(userLocator.credentialsPath));
  assert.notEqual(userKey.key, projectKey.key);
  assert.equal((await run('logout', '--client', 'pi', '--scope', 'project')).code, 0);
  assert.ok(await deviceKeyUser(env, userKey.key), 'project logout must not revoke user Pi key');
  assert.equal((await run('logout', '--client', 'pi', '--scope', 'user')).code, 0);
  assert.equal(await deviceKeyUser(env, userKey.key), null);
});
