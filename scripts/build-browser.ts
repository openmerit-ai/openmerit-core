// Browser scripts for the landing page.
import { build } from 'esbuild';
import { resolve } from 'node:path';

const absWorkingDir = resolve(import.meta.dirname, '..');
for (const script of ['video-player', 'thread-rule', 'speed-egg']) await build({
  absWorkingDir, entryPoints: [`site/${script}.ts`],
  outfile: `site/assets/${script}.js`, format: 'esm', platform: 'browser', target: 'es2022',
});
