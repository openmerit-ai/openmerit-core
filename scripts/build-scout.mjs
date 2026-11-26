import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import './build-browser.ts';
import { contentPages, markdownPages } from '../demo/public-site.ts';
import { pageMarkdown } from './page-markdown.ts';
import { llmsTxt, pageInfo, sitemap, withStructuredData } from './agent-files.ts';

// Package the landing page, the playground walkthrough, the content pages and their assets.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist/scout-site');
await rm(output, { recursive: true, force: true });
for (const path of ['index.html', 'styles.css', 'assets', 'playground', ...contentPages.map(page => page.slice(1, -1)), 'favicon.svg']) {
  const destination = resolve(output, path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, 'site', path), destination, { recursive: true });
}
// For search engines and AI agents: each page's Markdown version (served when they ask
// for text/markdown), its JSON-LD, and the site's sitemap.xml and llms.txt.
const pages = [];
for (const page of markdownPages) {
  const file = resolve(output, `.${page}index.html`), html = await readFile(file, 'utf8');
  await writeFile(resolve(output, `.${page}index.md`), pageMarkdown(html, 'https://openmerit.ai'));
  await writeFile(file, withStructuredData(html, page));
  pages.push(pageInfo(html, page));
}
await writeFile(resolve(output, 'sitemap.xml'), sitemap(pages));
await writeFile(resolve(output, 'llms.txt'), llmsTxt(pages));
console.log(`Web assets prepared in ${output}.`);
