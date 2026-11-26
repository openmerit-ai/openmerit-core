import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import './build-browser.ts';
import { contentPages, markdownPages } from '../demo/public-site.ts';
import { pageMarkdown } from './page-markdown.ts';

// Package the landing page, the playground walkthrough, the content pages and their assets.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist/scout-site');
await rm(output, { recursive: true, force: true });
for (const path of ['index.html', 'styles.css', 'assets', 'playground', ...contentPages.map(page => page.slice(1, -1)), 'favicon.svg']) {
  const destination = resolve(output, path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, 'site', path), destination, { recursive: true });
}
// The Markdown versions AI agents get when they ask for text/markdown.
for (const page of markdownPages) {
  const html = await readFile(resolve(output, `.${page}index.html`), 'utf8');
  await writeFile(resolve(output, `.${page}index.md`), pageMarkdown(html, 'https://openmerit.ai'));
}
console.log(`Web assets prepared in ${output}.`);
