import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Package compiled, allowlisted artifacts only. No checkout or build tools at install time.
export async function buildTerminalInstall(destination) {
  const staging = await mkdtemp(join(tmpdir(), 'openmerit-preview-pack-'));
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const name of ['core', 'protocol', 'pi', 'terminal']) await cp(join(root, 'dist', name), join(staging, 'dist', name), { recursive: true });
    for (const name of ['docs', 'README.md', 'CHANGELOG.md', 'LICENSE']) await cp(join(root, name), join(staging, name), { recursive: true });
    delete manifest.scripts;
    delete manifest.workspaces;
    delete manifest.devDependencies;
    await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const hash = createHash('sha256');
    async function hashDirectory(relative = '') {
      for (const entry of (await readdir(join(staging, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await hashDirectory(name);
        else if (entry.isFile()) { hash.update(name + '\0'); hash.update(await readFile(join(staging, name))); }
        else throw new Error('Preview package must contain only regular files and directories.');
      }
    }
    await hashDirectory();
    manifest.version = `${manifest.version.split('-')[0]}-dash.${hash.digest('hex').slice(0, 12)}`;
    await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(destination, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', resolve(destination)], { cwd: staging, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))[0];
    await rename(join(destination, packed.filename), join(destination, 'openmerit-preview.tgz'));
    const bytes = await readFile(join(destination, 'openmerit-preview.tgz'));
    const info = { version: manifest.version, filename: 'openmerit-preview.tgz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: packed.integrity, node: manifest.engines.node };
    await writeFile(join(destination, 'preview.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`Built ${manifest.name}@${manifest.version} (${bytes.length} bytes) for preview installation.`);
    return info;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTerminalInstall(resolve(process.argv[2] || join(root, 'dist/terminal-install')));
