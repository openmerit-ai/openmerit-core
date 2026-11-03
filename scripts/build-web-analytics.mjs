import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Serve the pinned metrics collector from our own origin; no third-party CDN.
const license = await readFile(new URL('../node_modules/web-vitals/LICENSE', import.meta.url), 'utf8');
await build({
  absWorkingDir: resolve(import.meta.dirname, '..'), entryPoints: ['web-vitals'],
  outfile: 'site/scout/vendor/web-vitals.js', bundle: true, format: 'esm',
  platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline',
  footer: { js: `/*! Third-party notices: web-vitals\n${license.replaceAll('*/', '* /')}\n*/` },
});
for (const page of ['privacy/privacy', 'onboarding', 'scout']) await build({
  absWorkingDir: resolve(import.meta.dirname, '..'), entryPoints: [`site/scout/${page}.ts`],
  outfile: `site/scout/${page}.js`, format: 'esm', platform: 'browser', target: 'es2022',
});
for (const script of ['video-player', 'thread-rule', 'speed-egg']) await build({
  absWorkingDir: resolve(import.meta.dirname, '..'), entryPoints: [`site/${script}.ts`],
  outfile: `site/assets/${script}.js`, format: 'esm', platform: 'browser', target: 'es2022',
});
