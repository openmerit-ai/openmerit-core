import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import './build-browser.ts';

// Package the landing page, the playground walkthrough, the comparison page, the Clerk sign-in and their assets.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist/scout-site');
await rm(output, { recursive: true, force: true });
for (const path of ['index.html', 'styles.css', 'assets', 'scout', 'playground', 'vs-routers', 'favicon.svg']) {
  const destination = resolve(output, path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, 'site', path), destination, { recursive: true });
}
console.log(`Web assets prepared in ${output}.`);
