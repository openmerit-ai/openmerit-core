import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Ship a self-contained browser bundle; the dashboard never loads a CDN.
export async function buildTerminal() {
  const libraries = ['torph', 'liveline', 'morphdom', 'react', 'react-dom', 'scheduler'];
  const notices = await Promise.all(libraries.map(async name => `${name}\n${await readFile(new URL(`../node_modules/${name}/LICENSE`, import.meta.url), 'utf8')}`));
  await build({
    entryPoints: [fileURLToPath(new URL('../packages/terminal/client/app.js', import.meta.url))],
    outfile: fileURLToPath(new URL('../packages/terminal/public/app.js', import.meta.url)),
    bundle: true,
    format: 'esm',
    target: ['safari17', 'chrome120', 'firefox121'],
    minify: true,
    legalComments: 'inline',
    footer: { js: `/*! Third-party notices\n\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/` },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTerminal();
