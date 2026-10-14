import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Package only Scout and public docs. The main site's protected memo and demos
// must not become reachable through a separate Scout preview deployment.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist/scout-site');
await rm(output, { recursive: true, force: true });
for (const path of ['scout', 'docs', 'styles.css', 'docs.css', 'docs.js', 'docs-search.js', 'favicon.svg',
  'assets/inter-latin.woff2', 'assets/inter-LICENSE.txt', 'assets/openmerit-og-v1.png']) {
  const destination = resolve(output, path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, 'site', path), destination, { recursive: true });
}
await cp(resolve(root, 'scout/task-evidence.json'), resolve(output, 'scout/task-evidence.json'));
console.log('Scout assets prepared in dist/scout-site.');
