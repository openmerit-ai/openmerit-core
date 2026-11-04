import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import './build-web-analytics.mjs';

// Package the existing landing page, Scout, agent sign-in and their assets.
// The data policy is generated under scout/; the docs site stays unpublished.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist/scout-site');
await rm(output, { recursive: true, force: true });
for (const path of ['index.html', 'styles.css', 'assets', 'scout', 'connect', 'favicon.svg']) {
  const destination = resolve(output, path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, 'site', path), destination, { recursive: true });
}
console.log(`Scout assets prepared in ${output}.`);
