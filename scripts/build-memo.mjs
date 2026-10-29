import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { build } from 'esbuild';
import { memo } from './docs.config.mjs';
import { renderMemoSvg } from './memo-svg.ts';
import { loginPage } from '../demo/memo/views.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function buildMemo(root) {
  const source = await readFile(join(root, 'docs', memo.source), 'utf8');
  const markdown = new MarkdownIt({ html: false, typographer: false });
  const defaultFence = markdown.renderer.rules.fence;
  let figureIndex = 0;
  markdown.renderer.rules.fence = (tokens, idx, options, env, renderer) => tokens[idx].info.trim() === 'memo-svg'
    ? renderMemoSvg(tokens[idx].content, ++figureIndex)
    : defaultFence(tokens, idx, options, env, renderer);
  markdown.renderer.rules.link_open = (tokens, idx, options, env, renderer) => {
    const token = tokens[idx];
    const number = tokens[idx + 1]?.content;
    if (/^#source-\d+-/.test(token.attrGet('href') ?? '') && /^\d+$/.test(number ?? '')) {
      token.attrSet('class', 'memo-citation');
      token.attrSet('aria-label', `Source ${number}`);
      token.attrSet('role', 'doc-noteref');
    }
    return renderer.renderToken(tokens, idx, options);
  };
  markdown.renderer.rules.table_open = () => '<div class="memo-table-scroll" role="region" aria-label="A typical router and OpenMerit comparison" tabindex="0"><table>\n';
  markdown.renderer.rules.table_close = () => '</table></div>\n';
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
  const sharingMetadata = `  <meta name="description" content="${escape(memo.description)}">
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
  <meta name="twitter:image:alt" content="${imageAlt}">`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f8f7f4" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#171915" media="(prefers-color-scheme: dark)">
  <title>${escape(title)} · OpenMerit</title>
${sharingMetadata}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css?v=${revision}">
  <link rel="stylesheet" href="/memo.css?v=${revision}">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <script src="/memo-access.js" defer></script><link rel="stylesheet" href="/memo-access.css">
</head>
<body class="memo-page memo-page--reference">
  <a class="skip-link" href="#memo-content">Skip to content</a>
  <header class="memo-header wrap">
    <a class="brand" href="/" aria-label="OpenMerit home"><svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg><span>openmerit</span></a>
    <nav class="memo-nav" aria-label="Primary navigation"><a href="/">Home</a></nav>
  </header>
  <main class="memo-main" id="memo-content" tabindex="-1">
    <article class="memo-prose">${article}</article>
  </main>
  <footer class="memo-footer">
    <a href="/">OpenMerit</a>
    <nav aria-label="Footer navigation"><a href="${memo.url}source.md">Read as Markdown</a><button class="memo-signout" type="button" data-memo-signout>Sign out</button><a href="#memo-content">Back to top <span aria-hidden="true">↑</span></a></nav>
    <p role="status" data-status></p>
  </footer>
</body>
</html>
`;
  const privateDirectory = join(root, 'demo/memo/generated');
  await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(privateDirectory, 'content.ts'), `// Generated from docs/${memo.source}. Do not edit.\nexport const memoHtml = ${JSON.stringify(html)};\nexport const memoMarkdown = ${JSON.stringify(source)};\nexport const memoSharingMetadata = ${JSON.stringify(sharingMetadata)};\n`);
  const directory = join(root, 'site', memo.url);
  // Remove stale public Markdown and older memo versions before writing the gate.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), loginPage({ sharingMetadata }));
  await build({ entryPoints: [join(root, 'site/memo-access.ts')], outfile: join(root, 'site/memo-access.js'), format: 'esm', platform: 'browser', target: 'es2022' });
  console.log(`Built the protected memo from docs/${memo.source}; only its gate is a public asset.`);
}
