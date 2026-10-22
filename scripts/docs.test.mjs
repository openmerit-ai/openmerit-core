import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { loadSearchIndex } from '../site/docs-search.js';
import { createSocialImage } from './social-image.mjs';
import { pages, memo } from './docs.config.mjs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(root, 'site');
const manifest = JSON.parse(await readFile(join(site, 'docs/manifest.json'), 'utf8'));
const publishedPages = [...manifest.pages, memo, { source: 'scout-data-policy.md', url: '/scout/data-policy/' }];
const html = await Promise.all(['/', '/scout/', ...publishedPages.map(page => page.url)].map(async url => ({
  url, text: await readFile(join(site, url, 'index.html'), 'utf8'),
})));

test('all website, Scout and generated documentation links resolve', async () => {
  for (const page of html) {
    for (const match of page.text.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), `https://openmerit.ai${page.url}`);
      if (url.origin !== 'https://openmerit.ai') continue;
      // The alpha Worker serves the same Scout sources under its own prefix.
      const assetPath = url.pathname.replace(/^\/scout\/alpha(?=\/|$)/, '/scout');
      let path = join(site, decodeURIComponent(assetPath));
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
    assert.ok(page.text.includes(`<link rel="canonical" href="https://openmerit.ai${page.url}">`));
  }
});

test('every generated page declares device-driven appearance before styles load', () => {
  for (const page of html) {
    assert.ok(page.text.includes('<meta name="color-scheme" content="light dark">'), page.url);
    for (const scheme of ['light', 'dark']) {
      assert.match(page.text, new RegExp(`<meta name="theme-color" content="#[a-f0-9]{6}" media="\\(prefers-color-scheme: ${scheme}\\)">`), page.url);
    }
  }
});

test('downloadable Markdown matches the maintained source and excludes internal site notes', async () => {
  for (const page of publishedPages) {
    assert.ok(!page.source.startsWith('site-'), `Internal site notes published: ${page.source}`);
    const original = await readFile(join(root, 'docs', page.source), 'utf8');
    const downloadable = await readFile(join(site, page.url, 'source.md'), 'utf8');
    assert.equal(downloadable, original, page.url);
  }
});

test('search finds operational topics and produces valid section destinations', async () => {
  const bundle = JSON.parse(await readFile(join(site, manifest.searchIndex), 'utf8'));
  const index = MiniSearch.loadJSON(JSON.stringify(bundle.index), bundle.options);
  for (const [query, expectedPage] of [['budget', '/docs/budgets/'], ['pause', '/docs/commands/'], ['rollback', '/docs/lifecycle/'], ['data policy', '/docs/scout-data-policy/']]) {
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

const searchUrls = { indexUrl: manifest.searchIndex, libraryUrl: manifest.searchLibrary };
const searchBundle = JSON.parse(await readFile(join(site, manifest.searchIndex), 'utf8'));
const jsonResponse = value => new Response(JSON.stringify(value));

test('search loads the page’s index without an extra manifest request', async () => {
  const fetched = [];
  const imported = [];
  const index = await loadSearchIndex(searchUrls, {
    fetch: async url => { fetched.push(url); return jsonResponse(searchBundle); },
    importModule: async url => { imported.push(url); return { default: MiniSearch }; },
  });
  assert.deepEqual(fetched, [manifest.searchIndex]);
  assert.deepEqual(imported, [manifest.searchLibrary]);
  assert.ok(index.search('budget').some(result => result.url === '/docs/budgets/#budget-fields'));
});

test('search recovers when deployment removes an open page’s index or library', async () => {
  for (const missing of ['index', 'library', 'both']) {
    const fetched = [];
    const imported = [];
    const oldUrls = { indexUrl: '/docs/search-index.000000000000.json', libraryUrl: '/docs/minisearch.000000000000.js' };
    const index = await loadSearchIndex(oldUrls, {
      fetch: async (url, options) => {
        fetched.push([url, options]);
        if (url === '/docs/manifest.json') return jsonResponse(manifest);
        if (url === oldUrls.indexUrl && missing !== 'library') return new Response(null, { status: 404 });
        assert.ok([oldUrls.indexUrl, manifest.searchIndex].includes(url));
        return jsonResponse(searchBundle);
      },
      importModule: async url => {
        imported.push(url);
        if (url === oldUrls.libraryUrl && missing !== 'index') throw new TypeError('Failed to fetch dynamically imported module');
        return { default: MiniSearch };
      },
    });
    assert.deepEqual(fetched.find(([url]) => url === '/docs/manifest.json'), ['/docs/manifest.json', { cache: 'no-store' }]);
    assert.equal(fetched.at(-1)[0], manifest.searchIndex);
    assert.ok(imported.at(-1).startsWith(`${manifest.searchLibrary}?recovery=`));
    assert.ok(index.search('pause').some(result => result.url === '/docs/commands/#pause-and-resume'));
  }
});

test('search stops after one failed recovery so the UI can offer another attempt', async () => {
  const fetched = [];
  await assert.rejects(loadSearchIndex(searchUrls, {
    fetch: async url => {
      fetched.push(url);
      if (url === '/docs/manifest.json') return jsonResponse(manifest);
      return new Response(null, { status: 503 });
    },
    importModule: async () => ({ default: MiniSearch }),
  }), /Search index unavailable/);
  assert.deepEqual(fetched, [manifest.searchIndex, '/docs/manifest.json', manifest.searchIndex]);
});

test('search recovery rejects invalid or external asset locations', async () => {
  for (const invalid of [
    {},
    { ...manifest, searchLibrary: 'https://example.com/search.js' },
    { ...manifest, searchIndex: '//example.com/search.json' },
  ]) {
    const imported = [];
    await assert.rejects(loadSearchIndex(searchUrls, {
      fetch: async url => url === '/docs/manifest.json' ? jsonResponse(invalid) : new Response(null, { status: 404 }),
      importModule: async url => { imported.push(url); return { default: MiniSearch }; },
    }), /Invalid search manifest/);
    assert.deepEqual(imported, [manifest.searchLibrary]);
  }
});

test('pages assign the default or enabled custom image to Open Graph and Twitter cards', async () => {
  const defaultUrl = html[0].text.match(/property="og:image" content="([^"]+)"/)[1];
  for (const page of publishedPages) {
    const tags = html.find(doc => doc.url === page.url).text;
    const image = page.socialImage ?? { url: defaultUrl, width: 1200, height: 630, type: 'image/png' };
    assert.ok(image, page.url);
    const url = new URL(image.url);
    assert.equal(url.origin, 'https://openmerit.ai');
    if (page.socialImage) assert.equal(url.pathname, `${page.url}og.png`);
    const png = await readFile(join(site, url.pathname));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
    assert.equal(image.type, 'image/png');
    if (page.socialImage) assert.equal(url.searchParams.get('v'), createHash('sha256').update(png).digest('hex').slice(0, 12));
    assert.ok(tags.includes(`<meta property="og:image" content="${image.url}">`));
    assert.ok(tags.includes(`<meta name="twitter:image" content="${image.url}">`));
    assert.ok(tags.includes('<meta name="twitter:card" content="summary_large_image">'));
    for (const field of ['type', 'width', 'height', 'alt']) assert.ok(tags.includes(`property="og:image:${field}"`));
    if (page.socialImage) {
      assert.ok(image.alt.includes(page.title));
      assert.ok(image.alt.includes('Three miniature makers'));
    }
  }
  if (!manifest.pages.find(page => page.url === '/docs/').socialImage) {
    assert.deepEqual(await readFile(join(site, 'docs/og.png')), await readFile(join(site, new URL(defaultUrl).pathname)));
  }
});

test('social images are reproducible and change with the maintained page heading', () => {
  const page = { title: 'OpenMerit documentation', description: pages[0].description, url: '/docs/', version: manifest.version };
  const original = createSocialImage(page);
  assert.deepEqual(createSocialImage(page).png, original.png);
  const updated = createSocialImage({ ...page, title: 'Installation & setup' });
  assert.notEqual(updated.revision, original.revision);
  assert.notDeepEqual(updated.png, original.png);
  // Details absent from the artwork should not invalidate the cached image.
  const sameArtwork = createSocialImage({ ...page, description: 'Updated page summary.', version: '0.1.6' });
  assert.deepEqual(sameArtwork.png, original.png);
});

test('social image text escapes markup and rejects copy that cannot fit', () => {
  const page = { title: 'Metrics & evidence <guide>', description: 'Use "measured" results.', url: '/docs/', version: manifest.version };
  const image = createSocialImage(page);
  assert.ok(image.svg.includes('Metrics &amp; evidence'));
  assert.ok(image.svg.includes('&lt;guide&gt;'));
  assert.throws(() => createSocialImage({ ...page, title: 'Very long documentation title '.repeat(20) }), /too long to fit/);
  assert.throws(() => createSocialImage({ ...page, title: '' }), /nonempty text/);
});


test('hosted Scout docs link to their published Markdown without claiming the feature is on main', () => {
  const scout = html.find(page => page.url === '/docs/scout/').text;
  assert.match(scout, /Hosted beta/);
  assert.match(scout, /href="\/docs\/scout\/source.md"/);
  assert.ok(!scout.includes('/blob/main/docs/scout.md'));
  assert.ok(!scout.includes('/edit/main/docs/scout.md'));
});

const websiteAnalytics = await readFile(join(site, 'product-analytics.js'), 'utf8');
async function websiteBrowser(options = {}) {
  const calls = [];
  const listeners = {};
  const storage = options.storage ?? new Map();
  const preference = { value: options.optOut ?? null };
  const listen = (type, callback) => { listeners[type] = callback; };
  const pathname = options.path ?? '/';
  const navigator = { doNotTrack: options.dnt, globalPrivacyControl: options.gpc };
  runInNewContext(websiteAnalytics, {
    location: { pathname, origin: 'https://openmerit.ai', href: `https://openmerit.ai${pathname}?private=secret#private` },
    navigator, window: { addEventListener: listen }, document: { addEventListener: listen },
    localStorage: { getItem: key => {
      assert.ok(['scout-analytics-opt-out', 'scout-analytics-account-link'].includes(key));
      if (options.localDenied) throw Error();
      return key === 'scout-analytics-account-link' ? options.accountLink ?? null : preference.value;
    } },
    sessionStorage: {
      getItem: key => { if (options.sessionDenied) throw Error(); return storage.get(key); },
      setItem: (key, value) => storage.set(key, value),
    },
    crypto: { randomUUID: () => '12345678-1234-4123-8123-123456789abc' },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (url === '/scout/api/auth') {
        if (options.duringConfig) options.duringConfig(preference);
        if (options.failConfig) throw Error('private network error');
        return { ok: true, json: async () => options.missingConfig ? {} : ({ analytics: { enabled: options.enabled ?? true } }) };
      }
      return { ok: true };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    calls, listeners, preference, navigator, storage,
    events: () => calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body)),
    click: (href, matches = true) => listeners.click?.({ target: { closest: selector => {
      assert.ok(selector.includes('nav a[href]'));
      return matches ? { getAttribute: () => href } : null;
    } } }),
  };
}

test('website analytics only loads on homepage/public guides, never memo or demos', () => {
  for (const page of html) {
    const expected = page.url === '/' || (page.url.startsWith('/docs/') && !page.url.startsWith('/docs/demo/'));
    assert.equal(page.text.includes('type="module" src="/product-analytics.js"'), expected, page.url);
  }
});

test('website analytics fails closed for privacy, disabled/missing config, and excluded pages', async () => {
  for (const options of [
    { dnt: '1' }, { gpc: true }, { optOut: '1' }, { localDenied: true },
    { path: '/memo/' }, { path: '/docs/demo/' }, { path: '/scout/' },
  ]) {
    const browser = await websiteBrowser(options);
    assert.equal(browser.calls.length, 0, JSON.stringify(options));
  }
  for (const options of [{ enabled: false }, { missingConfig: true }, { failConfig: true }, { duringConfig: preference => { preference.value = '1'; } }]) {
    assert.equal((await websiteBrowser(options)).events().length, 0);
  }
});

test('website analytics sends only bounded schemas via first-party requests with a separate tab ID', async () => {
  const browser = await websiteBrowser({ path: '/docs/security/' });
  assert.deepEqual(browser.events(), [{ event: 'website_visited', anonymousId: '12345678-1234-4123-8123-123456789abc', properties: { page: 'docs' } }]);
  assert.deepEqual([...browser.storage.keys()], ['openmerit-website-tab-id']);
  for (const [href, destination] of [
    ['/scout/?q=private', 'scout'], ['/docs/security/#private', 'docs'],
    ['https://dash.openmerit.ai/?private', 'terminal'], ['https://github.com/laz-aslam/openmerit', 'github'], ['https://example.com/private', 'other'],
  ]) {
    browser.click(href);
    assert.deepEqual(browser.events().at(-1).properties, { page: 'docs', destination });
  }
  const count = browser.events().length;
  for (const href of ['#private', '/memo/', '/docs/demo/', 'mailto:private@example.com', 'javascript:alert(1)']) browser.click(href);
  browser.click('/docs/', false);
  assert.equal(browser.events().length, count);
  browser.listeners.error({ error: { name: 'TypeError', message: 'private', stack: 'private' } });
  browser.listeners.unhandledrejection({ reason: { name: 'AbortError', message: 'private' } });
  browser.listeners.unhandledrejection({ reason: 'private' });
  browser.listeners.error({ error: { name: 'PrivateError' } });
  browser.listeners.error({ error: new Error('private') });
  browser.listeners.error({ error: new Error('private') });
  assert.equal(browser.events().filter(event => event.event === 'website_error').length, 3);
  assert.deepEqual(browser.events().at(-1).properties, { page: 'docs', code: 'uncaught_error', error_type: 'Error' });
  for (let i = 0; i < 60; i++) browser.click('/docs/');
  assert.equal(browser.events().length, 30);
  for (const call of browser.calls) {
    assert.ok(['/scout/api/auth', '/scout/api/analytics'].includes(call.url));
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.referrerPolicy, 'no-referrer');
    assert.ok(call.signal instanceof AbortSignal);
    if (!call.body) continue;
    assert.ok(call.body.length <= 512);
    assert.ok(!call.body.includes('private'));
    assert.deepEqual({ ...call.headers }, { 'Content-Type': 'application/json', 'X-Scout-Client': 'web', 'X-Scout-Analytics': 'on', 'X-Scout-Analytics-Account': 'on' });
  }
});

test('website analytics rechecks privacy before sends and handles denied session storage', async () => {
  const unlinked = await websiteBrowser({ accountLink: '0' });
  assert.equal(unlinked.calls.find(call => call.method === 'POST').headers['X-Scout-Analytics-Account'], 'off');
  for (const property of ['optOut', 'dnt', 'gpc']) {
    const browser = await websiteBrowser({ sessionDenied: true });
    assert.equal(browser.events().length, 1);
    if (property === 'optOut') browser.preference.value = '1';
    if (property === 'dnt') browser.navigator.doNotTrack = '1';
    if (property === 'gpc') browser.navigator.globalPrivacyControl = true;
    browser.click('/docs/');
    browser.listeners.error({ error: new Error('private') });
    assert.equal(browser.events().length, 1);
  }
  const storage = new Map([['openmerit-website-tab-id', 'abcdefab-1234-4123-8123-123456789abc']]);
  const browser = await websiteBrowser({ storage });
  assert.equal(browser.events()[0].anonymousId, storage.get('openmerit-website-tab-id'));
});
