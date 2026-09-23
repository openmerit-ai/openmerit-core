import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(root, 'site');
const manifest = JSON.parse(await readFile(join(site, 'docs/manifest.json'), 'utf8'));
const html = await Promise.all(['/', ...manifest.pages.map(page => page.url)].map(async url => ({
  url, text: await readFile(join(site, url, 'index.html'), 'utf8'),
})));

test('all generated navigation, source, asset and section links resolve', async () => {
  for (const page of html) {
    for (const match of page.text.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), `https://openmerit.site${page.url}`);
      if (url.origin !== 'https://openmerit.site') continue;
      let path = join(site, decodeURIComponent(url.pathname));
      const info = await stat(path).catch(() => undefined);
      assert.ok(info, `${page.url}: missing ${url.pathname}`);
      if (info.isDirectory()) path = join(path, 'index.html');
      if (url.hash && path.endsWith('.html')) {
        const target = await readFile(path, 'utf8');
        const ids = [...target.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `${page.url}: missing anchor ${url.href}`);
      }
    }
  }
});

test('pages have one H1, distinct section IDs, and a canonical address', () => {
  for (const page of html.slice(1)) {
    assert.equal([...page.text.matchAll(/<h1(?:\s|>)/g)].length, 1, page.url);
    const ids = [...page.text.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, `Duplicate IDs on ${page.url}`);
    assert.ok(page.text.includes(`<link rel="canonical" href="https://openmerit.site${page.url}">`));
  }
});

test('downloadable Markdown matches the maintained source and excludes internal site notes', async () => {
  for (const page of manifest.pages) {
    assert.ok(!page.source.startsWith('site-'), `Internal site notes published: ${page.source}`);
    const original = await readFile(join(root, 'docs', page.source), 'utf8');
    const downloadable = await readFile(join(site, page.url, 'source.md'), 'utf8');
    assert.equal(downloadable, original, page.url);
  }
});

test('search finds operational topics and produces valid section destinations', async () => {
  const bundle = JSON.parse(await readFile(join(site, manifest.searchIndex), 'utf8'));
  const index = MiniSearch.loadJSON(JSON.stringify(bundle.index), bundle.options);
  for (const [query, expectedPage] of [['budget', '/docs/budgets/'], ['pause', '/docs/commands/'], ['rollback', '/docs/lifecycle/']]) {
    const results = index.search(query);
    assert.ok(results.some(result => result.url.startsWith(expectedPage)), query);
    for (const result of results) {
      const [url, fragment] = result.url.split('#');
      const page = manifest.pages.find(page => page.url === url);
      assert.ok(page, result.url);
      if (fragment) assert.ok(page.headings.some(heading => heading.id === fragment), result.url);
    }
  }
  assert.equal(index.search('zzzxnonexistenttopic').length, 0);
});
