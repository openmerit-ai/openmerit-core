import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat, readdir} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import MarkdownIt from 'markdown-it';
import {memo} from './memo.config.ts';

const root = resolve(import.meta.dirname, '..'), site = join(root, 'site');
const pages = await Promise.all(['/', '/scout/', '/memo/'].map(async url => ({url, text: await readFile(join(site, url, 'index.html'), 'utf8')})));

test('live pages keep valid links, unique section IDs and device-driven appearance', async () => {
  for (const page of pages) {
    assert.equal([...page.text.matchAll(/<h1(?:\s|>)/g)].length, 1, page.url);
    const ids = [...page.text.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, page.url);
    assert.ok(page.text.includes(`<link rel="canonical" href="https://openmerit.ai${page.url}">`));
    assert.ok(page.text.includes('<meta name="color-scheme" content="light dark">'));
    for (const scheme of ['light', 'dark']) assert.match(page.text, new RegExp(`<meta name="theme-color" content="#[a-f0-9]{6}" media="\\(prefers-color-scheme: ${scheme}\\)">`));
    for (const match of page.text.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1]!.replaceAll('&amp;', '&'), `https://openmerit.ai${page.url}`);
      if (url.origin !== 'https://openmerit.ai') continue;
      assert.ok(!/^\/(docs|demo|engineering)(\/|$)/.test(url.pathname), `${page.url}: retired link ${url.pathname}`);
      let path = join(site, decodeURIComponent(url.pathname));
      const info = await stat(path);
      if (info.isDirectory()) path = join(path, 'index.html');
      if (url.hash && path.endsWith('.html')) assert.ok((await readFile(path, 'utf8')).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${page.url}: ${url.href}`);
    }
  }
});

test('memo publishes only its gate, not the protected article or Markdown', async () => {
  const gate = pages.find(page => page.url === '/memo/')!.text;
  assert.match(gate, /data-memo-login/);
  assert.ok(!gate.includes('A choice made once'));
  await assert.rejects(stat(join(site, 'memo/source.md')), {code: 'ENOENT'});
  const {memoHtml, memoMarkdown} = await import('../demo/memo/generated/content.ts');
  assert.equal(memoMarkdown, await readFile(join(root, 'docs', memo.source), 'utf8'));
  assert.ok(memoHtml.includes('A choice made once'));
  assert.equal((memoHtml.match(/class="memo-vector"/g) || []).length, 10);
});

test('Markdown product guides retain working relative links and section destinations', async () => {
  const markdown = new MarkdownIt({html: false});
  const sources = ['README.md', ...(await readdir(join(root, 'docs'))).filter(name => name.endsWith('.md') && !name.startsWith('site-') && !name.startsWith('memo-')).map(name => `docs/${name}`)];
  for (const source of sources) {
    const tokens = markdown.parse(await readFile(join(root, source), 'utf8'), {});
    for (const token of tokens.flatMap(token => token.children ?? [])) {
      const href = String(token.attrGet(token.type === 'image' ? 'src' : 'href') ?? '');
      if (!href || /^(?:[a-z]+:|\/)/i.test(href)) continue;
      const [file, fragment] = href.split('#'), target = file ? resolve(root, dirname(source), decodeURIComponent(file)) : join(root, source);
      await stat(target);
      if (!fragment || !target.endsWith('.md')) continue;
      const targetTokens = markdown.parse(await readFile(target, 'utf8'), {});
      const headings = targetTokens.filter((token, index) => token.type === 'inline' && targetTokens[index - 1]?.type === 'heading_open').map(token => token.content.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-'));
      assert.ok(headings.includes(decodeURIComponent(fragment)), `${source}: ${href}`);
    }
  }
});
