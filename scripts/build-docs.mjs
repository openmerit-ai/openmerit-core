import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import MiniSearch from 'minisearch';
import { groups, pages } from './docs.config.mjs';
import { createSocialImage } from './social-image.mjs';
import { buildMemo } from './build-memo.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'site/docs');
const repository = 'https://github.com/laz-aslam/openmerit';
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const bySource = new Map(pages.map(page => [page.source, page]));
const markdown = new MarkdownIt({ html: false, typographer: false });
const plain = token => (token.children ?? []).map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('');
const links = [];
const searchDocuments = [];
const icons = {
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M12 4l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  source: '<path d="m7 5-5 5 5 5m6-10 5 5-5 5m-2-12-2 14"/>',
  edit: '<path d="m13 3 4 4M3 17l4-1L18 5a2.8 2.8 0 0 0-4-4L3 12z"/>',
  markdown: '<path d="M11 2H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM11 2v6h6M6 11v4m0-4 2 2 2-2v4m3-4v4m-1-1 1 1 1-1"/>',
};
const icon = name => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

function resolveLink(href, page) {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (href.startsWith('#')) return `${page.url}${href}`;
  if (href.startsWith('/')) return href;
  const [path, hash = ''] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(page.source), decodeURIComponent(path)));
  if (bySource.has(target)) return `${bySource.get(target).url}${hash ? `#${hash}` : ''}`;
  return `${repository}/blob/main/${posix.normalize(`docs/${target}`)}${hash ? `#${hash}` : ''}`;
}

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = resolveLink(tokens[idx].attrGet('href'), env.page);
  tokens[idx].attrSet('href', href);
  links.push({ from: env.page.url, href });
  return self.renderToken(tokens, idx, options);
};
markdown.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
  const id = tokens[idx - 2].attrGet('id');
  const title = plain(tokens[idx - 1]);
  return `<a class="heading-anchor" href="#${escape(id)}" aria-label="Link to ${escape(title)}" title="Link to this section" data-section-link>${icon('link')}<span class="heading-copy-feedback" aria-hidden="true">Copied</span></a>${self.renderToken(tokens, idx, options)}`;
};
markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0] || 'text';
  return `<div class="code-block"><div class="code-caption">${escape(language)}</div><pre tabindex="0" aria-label="${escape(language)} example"><code>${escape(token.content)}</code></pre></div>\n`;
};
markdown.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="Reference table" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

const docs = await Promise.all(pages.map(async page => {
  const source = await readFile(join(root, 'docs', page.source), 'utf8');
  const tokens = markdown.parse(source, { page });
  if (tokens[0]?.type !== 'heading_open' || tokens[0].tag !== 'h1') throw new Error(`${page.source} must begin with one H1`);
  const title = plain(tokens[1]);
  const body = tokens.slice(3);
  const headings = [];
  const ids = new Set();
  let section = { id: page.url, url: page.url, title, pageTitle: page.title, group: page.group, text: '' };
  for (let i = 0; i < body.length; i++) {
    const token = body[i];
    if (token.type === 'heading_open') {
      if (token.tag === 'h1') throw new Error(`${page.source} has more than one H1`);
      const label = plain(body[i + 1]);
      const base = label.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      token.attrSet('id', id);
      headings.push({ id, label, depth: Number(token.tag.slice(1)) });
      if (section.text.trim()) searchDocuments.push(section);
      section = { id: `${page.url}#${id}`, url: `${page.url}#${id}`, title: label, pageTitle: page.title, group: page.group, text: '' };
    } else if (token.type === 'inline') section.text += `${plain(token)} `;
    else if (token.type === 'fence' || token.type === 'code_block') section.text += `${token.content} `;
  }
  if (section.text.trim()) searchDocuments.push(section);
  return { ...page, title: page.slug ? page.title : 'OpenMerit documentation', sourceText: source, headings, ids, html: markdown.renderer.render(body, markdown.options, { page }) };
}));

const miniSearchFile = fileURLToPath(import.meta.resolve('minisearch'));
const revision = createHash('sha256').update(JSON.stringify([pkg.version, groups, ...docs.map(doc => doc.sourceText),
  await readFile(join(root, 'site/docs.css'), 'utf8'), await readFile(join(root, 'site/docs.js'), 'utf8'),
  await readFile(join(root, 'site/docs-search.js'), 'utf8'),
  await readFile(join(root, 'site/styles.css'), 'utf8'), await readFile(miniSearchFile, 'utf8'),
  await readFile(join(root, 'scripts/social-image.mjs'), 'utf8'), await readFile(join(root, 'site/assets/inter-latin.woff2')),
  createHash('sha256').update(await readFile(join(root, 'site/assets/openmerit-og-workshop-v1.png'))).digest('hex'),
  await readFile(fileURLToPath(import.meta.url), 'utf8'),
])).digest('hex').slice(0, 12);
const indexUrl = `/docs/search-index.${revision}.json`;
const searchLibrary = `/docs/minisearch.${revision}.js`;
const sourceUrl = doc => `${doc.url}source.md`;
const defaultSocialImage = {
  url: 'https://openmerit.ai/assets/openmerit-og-v1.png', type: 'image/png', width: 1200, height: 630,
  alt: 'Good models prove themselves in the work. Three miniature makers compare tools at a wooden workbench.',
};
const brand = '<svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 24V8l12 10L28 8v16M4 8l12 16L28 8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>openmerit</span>';
function navigation(doc, label) {
  return `<nav aria-label="${label}">${groups.map(group => `<div class="docs-nav-group"><p>${escape(group.title)}</p><ul>${group.pages.map(item => {
    const page = bySource.get(item.source);
    return `<li><a href="${page.url}"${doc.url === page.url ? ' aria-current="page"' : ''}>${escape(page.title)}</a></li>`;
  }).join('')}</ul></div>`).join('')}</nav>`;
}
function outline(doc, label) {
  return `<nav aria-label="${label}"><ul>${doc.headings.filter(h => h.depth <= 3).map(h => `<li class="toc-level-${h.depth}"><a href="#${escape(h.id)}">${escape(h.label)}</a></li>`).join('')}</ul></nav>`;
}
function articleActions(doc) {
  const path = doc.source.split('/').map(encodeURIComponent).join('/');
  return `<div class="doc-meta"><span>v${escape(pkg.version)}</span>${[
    [`${repository}/blob/main/docs/${path}`, 'View source on GitHub', 'source'],
    [`${repository}/edit/main/docs/${path}`, 'Edit this page on GitHub', 'edit'],
    [sourceUrl(doc), 'Read as Markdown', 'markdown'],
  ].map(([href, label, symbol]) => `<a class="doc-action" href="${href}" aria-label="${label}" title="${label}">${icon(symbol)}</a>`).join('')}</div>`;
}
function mobileNavigation(doc) {
  return `<details class="docs-mobile-nav"><summary>Navigation <span aria-hidden="true">+</span></summary><div class="docs-mobile-nav-body">
    ${doc.headings.length ? `<div class="docs-mobile-outline"><p>On this page</p>${outline(doc, 'On this page on mobile')}</div>` : ''}
    <details class="docs-mobile-pages"><summary>Documentation <span aria-hidden="true">+</span></summary>${navigation(doc, 'Documentation on mobile')}</details>
  </div></details>`;
}
function layout(doc) {
  const socialImage = doc.socialImage || defaultSocialImage;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f8f7f4">
  <meta name="description" content="${escape(doc.description)}">
  <title>${escape(doc.title)} · OpenMerit docs</title>
  <link rel="canonical" href="https://openmerit.ai${doc.url}">
  <meta property="og:title" content="${escape(doc.title)} · OpenMerit docs">
  <meta property="og:description" content="${escape(doc.description)}">
  <meta property="og:type" content="${doc.slug ? 'article' : 'website'}">
  <meta property="og:url" content="https://openmerit.ai${doc.url}">
  <meta property="og:site_name" content="OpenMerit">
  <meta property="og:image" content="${escape(socialImage.url)}">
  <meta property="og:image:type" content="${socialImage.type}">
  <meta property="og:image:width" content="${socialImage.width}">
  <meta property="og:image:height" content="${socialImage.height}">
  <meta property="og:image:alt" content="${escape(socialImage.alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escape(doc.title)}">
  <meta name="twitter:description" content="${escape(doc.description)}">
  <meta name="twitter:image" content="${escape(socialImage.url)}">
  <meta name="twitter:image:alt" content="${escape(socialImage.alt)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css?v=${revision}">
  <link rel="stylesheet" href="/docs.css?v=${revision}">
  <script src="/docs.js?v=${revision}" defer></script>
</head>
<body class="docs-page">
  <a class="skip-link" href="#doc-content">Skip to content</a>
  <header class="docs-header"><div class="docs-header-inner">
    <a class="brand" href="/" aria-label="OpenMerit home">${brand}</a>
    <nav class="docs-header-links" aria-label="Primary navigation"><a href="/">Home</a><a href="${repository}">GitHub <span aria-hidden="true">↗</span></a></nav>
  </div></header>
  <div class="docs-intro"><p class="docs-intro-title">Documentation</p><p>Guides and reference for using and extending OpenMerit.</p></div>
  <div class="docs-layout">
    <aside class="docs-sidebar"><div class="docs-sidebar-body">${navigation(doc, 'Documentation')}<p class="docs-release">OpenMerit ${escape(pkg.version)}</p></div></aside>
    <main class="docs-main">
      ${mobileNavigation(doc)}
      <section class="docs-search" aria-label="Search documentation" hidden data-index-url="${indexUrl}" data-library-url="${searchLibrary}">
        <form role="search"><label class="sr-only" for="doc-search">Search documentation</label><span class="search-icon" aria-hidden="true">⌕</span><input id="doc-search" type="search" placeholder="Search documentation…" autocomplete="off" spellcheck="false" autocapitalize="none" enterkeyhint="search" aria-controls="search-results"><kbd>⌘ K</kbd><button type="button" class="search-clear" aria-label="Clear search" hidden>×</button></form>
        <div class="search-panel" hidden><p class="search-status" role="status" aria-live="polite"></p><ul id="search-results"></ul></div>
      </section>
      ${doc.headings.length ? `<details class="docs-mobile-toc"><summary>On this page <span aria-hidden="true">+</span></summary>${outline(doc, 'On this page on tablet')}</details>` : ''}
      <article class="docs-article" id="doc-content" tabindex="-1">
        <header class="doc-heading"><div class="doc-title-row"><h1>${escape(doc.title)}</h1>${articleActions(doc)}</div><p class="doc-description">${escape(doc.description)}</p></header>
        <div class="doc-prose">${doc.html}</div>
      </article>
      <footer class="docs-footer"><a href="/docs/roadmap/">Current limitations <span aria-hidden="true">↗</span></a></footer>
    </main>
    <aside class="docs-toc"><p class="docs-panel-heading">On this page</p><div class="docs-toc-body">${outline(doc, 'On this page')}<div class="docs-toc-footer"><a href="${repository}/issues">Report an issue ↗</a></div></div></aside>
  </div>
  <div class="sr-only" id="copy-status" role="status" aria-live="polite"></div>
</body>
</html>\n`;
}

// Fail on broken local page or section links before replacing generated output.
for (const link of links) {
  if (!link.href.startsWith('/docs/')) continue;
  const [url, fragment] = link.href.split('#');
  const target = docs.find(doc => doc.url === url);
  if (!target || (fragment && !target.ids.has(decodeURIComponent(fragment)))) throw new Error(`Broken documentation link from ${link.from}: ${link.href}`);
}
const options = {
  fields: ['title', 'pageTitle', 'text'], storeFields: ['title', 'pageTitle', 'group', 'url', 'excerpt'],
  searchOptions: { boost: { title: 4, pageTitle: 2 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
};
const index = new MiniSearch(options);
searchDocuments.sort((a, b) => a.id.localeCompare(b.id));
index.addAll(searchDocuments.map(doc => ({ ...doc, text: doc.text.replace(/\s+/g, ' ').trim(), excerpt: doc.text.replace(/\s+/g, ' ').trim().slice(0, 220) })));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const doc of docs) {
  const directory = join(out, doc.slug);
  await mkdir(directory, { recursive: true });
  if (doc.socialImage) {
    const { png, svg, revision, ...metadata } = createSocialImage(doc);
    await writeFile(join(directory, 'og.png'), png);
    doc.socialImage = { ...metadata, url: `https://openmerit.ai${doc.url}og.png?v=${revision}` };
  } else if (!doc.slug) {
    // Keep previously shared docs-image URLs working with the default artwork.
    await copyFile(join(root, 'site', new URL(defaultSocialImage.url).pathname), join(directory, 'og.png'));
  }
  await writeFile(join(directory, 'index.html'), layout(doc));
  await writeFile(join(directory, 'source.md'), doc.sourceText);
}
await writeFile(join(root, 'site', indexUrl), JSON.stringify({ options, index: index.toJSON() }));
await copyFile(miniSearchFile, join(root, 'site', searchLibrary));
await copyFile(join(dirname(miniSearchFile), '../../LICENSE.txt'), join(out, 'minisearch-LICENSE.txt'));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ version: pkg.version, revision, pages: docs.map(doc => ({ url: doc.url, source: doc.source, title: doc.title, headings: doc.headings, ...(doc.socialImage && { socialImage: doc.socialImage }) })), searchIndex: indexUrl, searchLibrary }, null, 2));
console.log(`Built ${docs.length} documentation pages and ${searchDocuments.length} searchable sections (${revision}).`);
await buildMemo(root);
