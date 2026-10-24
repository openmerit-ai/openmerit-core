import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const entry = new URL('../../site/scout/scout.js', import.meta.url);
const { code } = transformSync(await readFile(entry, 'utf8'), {
  format: 'cjs', define: { 'import.meta.url': JSON.stringify('https://example.test/scout/scout.js') },
});

test('Add to Claude Code opens a prefilled Desktop link without waiting for clipboard permission', async t => {
  for (const copied of [true, false]) await t.test(copied ? 'clipboard allowed' : 'clipboard denied', async () => {
    const nodes = new Map();
    const querySelector = selector => {
      if (!nodes.has(selector)) nodes.set(selector, Object.assign(new EventTarget(), { style: {}, value: '', textContent: '', hidden: true }));
      return nodes.get(selector);
    };
    let resolveCopy, rejectCopy, clipboard;
    const copying = new Promise((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; });
    const location = { origin: 'https://example.test', hash: '', href: 'https://example.test/scout/' };
    runInNewContext(code, {
      require: name => {
        if (name === './providers.js') return {};
        if (name === './auth.js') return { initAuth: () => ({}) };
        if (name === './analytics.js') return { analytics: { preferences: () => ({}), track() {} } };
        throw new Error(`Unexpected import: ${name}`);
      },
      document: Object.assign(new EventTarget(), { querySelector, querySelectorAll: () => [] }),
      window: Object.assign(new EventTarget(), { matchMedia: () => new EventTarget() }),
      navigator: { clipboard: { writeText: text => { clipboard = text; return copying; } } },
      location, URL, ResizeObserver: class {}, fetch: () => new Promise(() => {}),
      setTimeout() {}, clearTimeout() {}, setInterval() {},
    });
    querySelector('.add-agent-button').dispatchEvent(new Event('click'));
    // Check before resolving/rejecting permission: a blocked clipboard must not
    // hold up the app handoff or force a second click.
    const link = new URL(location.href);
    assert.equal(link.protocol, 'claude:');
    assert.equal(link.hostname, 'code');
    assert.equal(link.pathname, '/new');
    assert.deepEqual([...link.searchParams.keys()], ['q']);
    assert.equal(link.searchParams.get('q'), clipboard);
    assert.match(clipboard, /npx -y openmerit@latest install --client claude-code/);
    if (copied) resolveCopy(); else rejectCopy(new Error('Clipboard denied'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(querySelector('#toast').hidden, false);
    assert.equal(querySelector('#toast').textContent, copied ? 'Copied to clipboard' : 'Opening Claude');
    assert.equal(querySelector('#announcement').textContent, querySelector('#toast').textContent);
  });
});
