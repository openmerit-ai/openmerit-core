import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/agent.mjs';

test('Scout installation preserves unrelated state, persists configuration, repairs missing rules and removes only owned files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openmerit-agent-'));
  const root = join(dir, 'project'), config = join(dir, 'config'), bin = join(dir, 'bin');
  await Promise.all([root, config, bin].map(p => mkdir(p)));
  const previous = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  });
  // The external CLI boundary persists the documented MCP config format. Tests
  // assert user-visible filesystem outcomes; real Claude is validated separately.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.1.309');process.exit(0);}
const scope=a[a.indexOf('--scope')+1];
const file=scope==='user'?path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):path.join(process.cwd(),'.mcp.json');
const value=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
value.mcpServers??={};
if(a[1]==='add-json')value.mcpServers.openmerit=JSON.parse(a.at(-1));
else if(a[1]==='remove')delete value.mcpServers.openmerit;
else process.exit(1);
fs.writeFileSync(file,JSON.stringify(value));
`, { mode: 0o755 });
  const output = [], run = args => main(args, { root, print: s => output.push(s) });
  const mcp = join(root, '.mcp.json'), rule = join(root, '.claude/rules/openmerit.md');
  const unrelated = { type: 'http', url: 'https://unrelated.test/mcp' };
  await writeFile(mcp, JSON.stringify({ mcpServers: { other: unrelated } }));
  await writeFile(join(root, 'CLAUDE.md'), 'Keep my instructions exactly.\n');

  await run(['install', 'claude-code', '--scope', 'project']);
  assert.deepEqual(JSON.parse(await readFile(mcp, 'utf8')), { mcpServers: { other: unrelated } });
  await assert.rejects(readFile(rule), { code: 'ENOENT' });
  await run(['install', 'claude-code', '--scope', 'project', '--url', 'https://scout.test/scout/mcp?analytics=off', '--client-id', 'public-scout-client', '--callback-port', '18741', '--yes']);
  const installed = JSON.parse(await readFile(mcp, 'utf8'));
  assert.deepEqual(installed.mcpServers.other, unrelated);
  assert.equal(installed.mcpServers.openmerit.url, 'https://scout.test/scout/mcp?analytics=off');
  assert.deepEqual(installed.mcpServers.openmerit.oauth, { scopes: 'scout:recommend', clientId: 'public-scout-client', callbackPort: 18741 });
  assert.equal(installed.mcpServers.openmerit.headers['X-Scout-Analytics-Content'], 'off');
  assert.equal(installed.mcpServers.openmerit.headers.Authorization, undefined);
  assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), 'Keep my instructions exactly.\n');
  assert.ok((await readFile(rule, 'utf8')).includes('endpointIds'));
  // Claude Code normalizes OAuth property order when it writes configuration.
  const normalized = structuredClone(installed);
  normalized.mcpServers.openmerit.oauth = { clientId: 'public-scout-client', callbackPort: 18741, scopes: 'scout:recommend' };
  await writeFile(mcp, JSON.stringify(normalized));
  await run(['status', 'claude-code', '--scope', 'project']);
  const status = JSON.parse(output.at(-1));
  assert.equal(status.installed, true);
  assert.equal(status.connection, 'not_checked');
  assert.equal(status.search, 'not_checked');
  await rm(rule);
  await run(['install', 'claude-code', '--scope', 'project', '--yes']);
  assert.deepEqual(JSON.parse(await readFile(mcp, 'utf8')), installed);
  assert.ok(await readFile(rule, 'utf8'));
  await run(['project', '--policy', 'existing-only', '--endpoint-id', 'provider:chat:model', '--yes']);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.openmerit/scout.json'), 'utf8')), { version: 1, policy: 'existing-only', endpointIds: ['provider:chat:model'] });
  const original = await readFile(rule, 'utf8');
  await writeFile(rule, `${original}\nMy changes.\n`);
  await assert.rejects(run(['install', 'claude-code', '--scope', 'project', '--yes']), /nothing was overwritten/);
  await assert.rejects(run(['remove', 'claude-code', '--scope', 'project', '--yes']), /nothing was overwritten/);
  await writeFile(rule, original);
  await writeFile(join(config, '.claude.json'), JSON.stringify({ mcpServers: { openmerit: { type: 'http', url: 'https://other.test/scout/mcp' } } }));
  await run(['status', 'claude-code', '--scope', 'project']);
  assert.equal(JSON.parse(output.at(-1)).scopeConflict, true);
  assert.equal(JSON.parse(output.at(-1)).installed, false);
  await run(['remove', 'claude-code', '--scope', 'project', '--yes']);
  assert.deepEqual(JSON.parse(await readFile(mcp, 'utf8')), { mcpServers: { other: unrelated } });
  await assert.rejects(readFile(rule), { code: 'ENOENT' });
  assert.ok(await readFile(join(root, '.openmerit/scout.json')));
  assert.ok(JSON.parse(await readFile(join(config, '.claude.json'), 'utf8')).mcpServers.openmerit);
});

test('project policy requires explicit scope, rejects secrets/URLs, and treats empty inventory as empty', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openmerit-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = args => main(args, { root, print() {} });
  await assert.rejects(run(['project', '--yes']), /Choose --policy/);
  for (const id of ['https://private.test/model', 'Bearer secret', undefined]) await assert.rejects(run(['project', '--policy', 'existing-first', '--endpoint-id', id, '--yes']), /catalogue endpoint IDs/);
  await run(['project', '--policy', 'existing-only']);
  await assert.rejects(readFile(join(root, '.openmerit/scout.json')), { code: 'ENOENT' });
  await run(['project', '--policy', 'existing-only', '--yes']);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.openmerit/scout.json'), 'utf8')).endpointIds, []);
  await assert.rejects(run(['install', 'claude-code', '--scope', 'user', '--url', 'https://user:secret@example.test/scout/mcp']), /HTTPS/);
  await assert.rejects(run(['install', 'claude-code', '--scope', 'user', '--url', 'https://example.test/scout/mcp?token=secret']), /HTTPS/);
  await assert.rejects(run(['install', 'claude-code', '--scope', 'user', '--client-id', 'public-client']), /both --client-id and --callback-port/);
  await assert.rejects(run(['install', 'claude-code', '--scope', 'user', '--client-id', 'public-client', '--callback-port', '65536']), /callback port/);
});
