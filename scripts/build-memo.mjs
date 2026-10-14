import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { memo } from './docs.config.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function buildMemo(root) {
  const source = await readFile(join(root, 'docs', memo.source), 'utf8');
  const markdown = new MarkdownIt({ html: false, typographer: false });
  const tokens = markdown.parse(source, {});
  if (tokens[0]?.type !== 'heading_open' || tokens[0].tag !== 'h1') throw new Error('The memo must begin with one H1');
  const title = tokens[1].content;
  const ids = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      if (i > 0 && token.tag === 'h1') throw new Error('The memo must contain only one H1');
      const base = tokens[i + 1].content.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      token.attrSet('id', id);
    }
    // The supplied memo uses H4 sections; render them as H2 for a logical outline.
    if (['heading_open', 'heading_close'].includes(token.type) && token.tag === 'h4') token.tag = 'h2';
  }
  const article = markdown.renderer.render(tokens, markdown.options, {});
  const revision = createHash('sha256').update([
    await readFile(join(root, 'site/styles.css'), 'utf8'),
    await readFile(join(root, 'site/memo.css'), 'utf8'),
  ].join('\n')).digest('hex').slice(0, 12);
  const image = 'https://openmerit.ai/assets/openmerit-og-v1.png';
  const imageAlt = 'Good models prove themselves in the work. Three miniature makers compare tools at a wooden workbench.';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f8f7f4" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#171915" media="(prefers-color-scheme: dark)">
  <meta name="description" content="${escape(memo.description)}">
  <title>${escape(title)} · OpenMerit</title>
  <link rel="canonical" href="https://openmerit.ai${memo.url}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escape(title)} · OpenMerit">
  <meta property="og:description" content="${escape(memo.description)}">
  <meta property="og:url" content="https://openmerit.ai${memo.url}">
  <meta property="og:site_name" content="OpenMerit">
  <meta property="og:image" content="${image}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${imageAlt}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escape(title)}">
  <meta name="twitter:description" content="${escape(memo.description)}">
  <meta name="twitter:image" content="${image}">
  <meta name="twitter:image:alt" content="${imageAlt}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css?v=${revision}">
  <link rel="stylesheet" href="/memo.css?v=${revision}">
</head>
<body class="memo-page">
  <a class="skip-link" href="#memo-content">Skip to content</a>
  <header class="memo-header wrap">
    <a class="brand" href="/" aria-label="OpenMerit home"><svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 24V8l12 10L28 8v16M4 8l12 16L28 8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>openmerit</span></a>
    <nav class="memo-nav" aria-label="Primary navigation"><a href="/">Home</a><a href="/docs/">Documentation</a></nav>
  </header>
  <figure class="memo-cover" aria-hidden="true"><img src="/assets/memo-inference-abstract-v1.webp" width="2172" height="724" alt="" fetchpriority="high" decoding="async"></figure>
  <main class="memo-main" id="memo-content" tabindex="-1">
    <p class="memo-eyebrow">Last updated on: <time datetime="2026-09-28">Sep 28, 2026</time></p>
    <article class="memo-prose">${article}</article>
  </main>
  <footer class="memo-footer">
    <a href="/">OpenMerit</a>
    <nav aria-label="Footer navigation"><a href="${memo.url}source.md">Read as Markdown</a><a href="#memo-content">Back to top <span aria-hidden="true">↑</span></a></nav>
  </footer>
</body>
</html>
`;
  const directory = join(root, 'site', memo.url);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'source.md'), source);
  console.log(`Built the memo at ${memo.url} from docs/${memo.source}.`);
}
