// Build only the live policy and protected memo, not a documentation website.
import {readFile, writeFile, mkdir, copyFile, rm} from 'node:fs/promises';
import {join, resolve, posix} from 'node:path';
import {createHash} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {buildMemo} from './build-memo.mjs';
import './build-web-analytics.mjs';

const root = resolve(import.meta.dirname, '..');
await buildMemo(root);
const source = await readFile(join(root, 'docs/scout-data-policy.md'), 'utf8');
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
const markdown = new MarkdownIt({html: false, typographer: false});
const tokens = markdown.parse(source, {});
if (tokens[0]?.type !== 'heading_open' || tokens[0].tag !== 'h1') throw Error('The policy must begin with one H1');
const title = tokens[1]!.content;
const body = tokens.slice(3), ids = new Set<string>();
for (let i = 0; i < body.length; i++) {
  const token = body[i]!;
  if (token.type !== 'heading_open') continue;
  if (token.tag === 'h1') throw Error('The policy must have only one H1');
  const base = body[i + 1]!.content.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id); token.attrSet('id', id);
}
markdown.renderer.rules.link_open = (tokens, i, options, _env, renderer) => {
  const token = tokens[i]!, href = String(token.attrGet('href'));
  if (!/^(?:[a-z]+:|\/|#)/i.test(href)) token.attrSet('href', `https://github.com/openmerit-ai/openmerit-core/blob/main/docs/${posix.normalize(href)}`);
  return renderer.renderToken(tokens, i, options);
};
markdown.renderer.rules.heading_close = (tokens, i, options, _env, renderer) => {
  const id = String(tokens[i - 2]!.attrGet('id')), label = tokens[i - 1]!.content;
  return `<a class="heading-anchor" href="#${escape(id)}" aria-label="Link to ${escape(label)}" title="Link to this section"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M12 4l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></svg></a>${renderer.renderToken(tokens, i, options)}`;
};
markdown.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="Reference table" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
const description = 'Data use, sharing choices and deletion.';
const revision = createHash('sha256').update(source).update(await readFile(join(root, 'site/styles.css'))).update(await readFile(join(root, 'site/policy.css'))).digest('hex').slice(0, 12);
const directory = join(root, 'site/scout/data-policy');
await mkdir(directory, {recursive: true});
await writeFile(join(directory, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">
  <title>${escape(title)} · OpenMerit</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="https://openmerit.ai/scout/data-policy/">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="https://openmerit.ai/scout/data-policy/">
  <meta property="og:image" content="https://openmerit.ai/assets/openmerit-og-v1.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Good models prove themselves in the work. Three miniature makers compare tools at a wooden workbench.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://openmerit.ai/assets/openmerit-og-v1.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/scout/data-policy/styles.css?v=${revision}">
  <link rel="stylesheet" href="/scout/data-policy/docs.css?v=${revision}">
</head>
<body class="docs-page">
  <a class="skip-link" href="#doc-content">Skip to policy</a>
  <header class="docs-header"><div class="docs-header-inner">
    <a class="brand" href="/" aria-label="OpenMerit home"><svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg><span>openmerit</span></a>
    <nav class="docs-header-links" aria-label="Primary navigation"><a href="/scout/">Back to Scout</a><a href="/scout/privacy/">Privacy settings</a></nav>
  </div></header>
  <main class="docs-main">
    <article class="docs-article" id="doc-content" tabindex="-1">
      <header class="doc-heading"><h1>${escape(title)}</h1><p class="doc-description">${description}</p></header>
      <div class="doc-prose">${markdown.renderer.render(body, markdown.options, {})}</div>
    </article>
    <footer class="docs-footer"><a href="/scout/">Back to Scout</a><a href="/scout/data-policy/source.md">Read as Markdown</a></footer>
  </main>
</body>
</html>\n`);
await writeFile(join(directory, 'source.md'), source);
await copyFile(join(root, 'site/styles.css'), join(directory, 'styles.css'));
await copyFile(join(root, 'site/policy.css'), join(directory, 'docs.css'));
// Never leave a previous docs-site build available to local previews or uploads.
await rm(join(root, 'site/docs'), {recursive: true, force: true});
console.log('Built Scout data policy and protected memo. Markdown guides remain in docs/.');
