import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('project setup preserves an unowned MCP entry at the active Claude version’s worktree scope', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'openmerit-worktree-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'main'), worktree = join(dir, 'linked');
  const bin = join(dir, 'bin'), config = join(dir, 'claude');
  await Promise.all([mkdir(repository), mkdir(bin), mkdir(config)]);
  await exec('git', ['init', '-q', repository]);
  await exec('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  await exec('git', ['-C', repository, 'worktree', 'add', '--detach', worktree]);
  const project = join(worktree, 'customer');
  await mkdir(project);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "%s (Claude Code)\\n" "$FIXTURE_CLAUDE_VERSION"; else exit 77; fi\n', { mode: 0o755 });

  for (const [version, location] of [['2.1.62', worktree], ['2.1.63', repository], ['2.1.318', repository]] as const) {
    await t.test(`Claude ${version}`, async () => {
      const path = join(config, '.claude.json');
      const original = JSON.stringify({ projects: { [location]: { mcpServers: {
        openmerit: { type: 'http', url: 'https://example.invalid/mcp' },
      } } } });
      await writeFile(path, original);
      const { stdout } = await exec(process.execPath, [cli, 'install', '--client', 'claude-code', '--scope', 'project', '--auto-update', 'off', '--plan', '--json'], {
        cwd: project,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CLAUDE_CONFIG_DIR: config,
          OPENMERIT_CONFIG_DIR: join(dir, 'private'),
          FIXTURE_CLAUDE_VERSION: version,
          DO_NOT_TRACK: '1',
        },
      });
      const result = JSON.parse(stdout) as { applied: boolean; conflicts: string[] };
      assert.equal(result.applied, false);
      assert.equal(result.conflicts.length, 1, 'The active client’s existing server must block replacement');
      assert.equal(await readFile(path, 'utf8'), original, 'Planning must not edit either worktree’s connection');
    });
  }
});
