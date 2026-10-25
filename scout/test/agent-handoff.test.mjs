import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const entry = new URL('../../site/scout/scout.js', import.meta.url);
const { code } = transformSync(await readFile(entry, 'utf8'), {
  format: 'cjs', define: { 'import.meta.url': JSON.stringify('https://example.test/scout/scout.js') },
});

function fixture({ settings = { enabled: true, linkAccount: true }, clipboard, launchError = false } = {}) {
  const nodes = new Map(), sent = [];
  const querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, Object.assign(new EventTarget(), { style: {}, value: '', textContent: '', hidden: true, remove() {} }));
    return nodes.get(selector);
  };
  const location = { origin: 'https://example.test', hash: '', href: 'https://example.test/scout/' };
  if (launchError) Object.defineProperty(location, 'href', { set() { throw Error('PRIVATE launch details'); } });
  const window = Object.assign(new EventTarget(), { matchMedia: () => new EventTarget() });
  runInNewContext(code, {
    require: name => {
      if (name === './providers.js') return {};
      if (name === './auth.js') return { initAuth: () => ({}) };
      if (name === './analytics.js') return { analytics: { preferences: () => ({ ...settings }), track: (event, properties) => { if (settings.enabled) sent.push({ event, ...properties }); } } };
      throw new Error(`Unexpected import: ${name}`);
    },
    document: Object.assign(new EventTarget(), { querySelector, querySelectorAll: () => [] }), window,
    navigator: { clipboard }, crypto, location, URL, ResizeObserver: class {}, fetch: () => new Promise(() => {}),
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  return { querySelector, sent, location, settings, window, click: () => querySelector('.add-agent-button').dispatchEvent(new Event('click')) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Add to Claude Code opens a prefilled Desktop link without waiting for clipboard permission', async t => {
  for (const copied of [true, false]) await t.test(copied ? 'clipboard allowed' : 'clipboard denied', async () => {
    let resolveCopy, rejectCopy, clipboard;
    const copying = new Promise((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; });
    const { click, location, querySelector, sent } = fixture({ clipboard: { writeText: text => { clipboard = text; return copying; } } });
    click();
    // Check before resolving/rejecting permission: a blocked clipboard must not
    // hold up the app handoff or force a second click.
    const link = new URL(location.href);
    assert.equal(link.protocol, 'claude:');
    assert.equal(link.hostname, 'code');
    assert.equal(link.pathname, '/new');
    assert.deepEqual([...link.searchParams.keys()], ['q']);
    assert.equal(link.searchParams.get('q'), clipboard);
    assert.match(clipboard, /npx -y openmerit@latest install --client claude-code/);
    assert.match(clipboard, /start a new Claude Code session/);
    assert.match(clipboard, /reconnecting \/mcp alone is not enough/);
    assert.doesNotMatch(clipboard, /OPENMERIT_TELEMETRY|DO_NOT_TRACK/);
    const setupId = sent[0].setup_id;
    assert.match(setupId, /^[0-9a-f-]{36}$/);
    assert.ok(clipboard.includes(`--setup-id ${setupId}`));
    assert.deepEqual(sent.map(row => row.event), ['scout_agent_setup_started', 'scout_agent_launch_requested']);
    assert.equal(sent[1].outcome, 'ok');
    if (copied) resolveCopy(); else rejectCopy(new Error('Clipboard denied'));
    await settle();
    assert.equal(querySelector('#toast').hidden, false);
    assert.equal(querySelector('#toast').textContent, copied ? 'Copied to clipboard' : 'Claude launch requested');
    assert.equal(querySelector('#announcement').textContent, querySelector('#toast').textContent);
    assert.equal(sent[2].event, 'scout_agent_setup_copied');
    assert.equal(sent[2].setup_id, setupId);
    assert.equal(sent[2].outcome, copied ? 'ok' : 'error');
    assert.equal(sent[2].code, copied ? undefined : 'clipboard_error');
    click(); await settle();
    assert.notEqual(sent[3].setup_id, setupId, 'every click creates a new setup');
  });
});

test('privacy choices propagate into the copied and deep-linked command without correlation', async () => {
  for (const settings of [{ enabled: true, linkAccount: false }, { enabled: false, linkAccount: true }]) {
    let prompt;
    const f = fixture({ settings, clipboard: { writeText: text => { prompt = text; return Promise.resolve(); } } });
    f.click(); await settle();
    assert.equal(new URL(f.location.href).searchParams.get('q'), prompt);
    assert.doesNotMatch(prompt, /--setup-id/);
    assert.match(prompt, settings.enabled ? /OPENMERIT_ANALYTICS_ACCOUNT=off npx/ : /DO_NOT_TRACK=1 npx/);
    assert.ok(f.sent.every(row => row.setup_id === undefined));
    assert.equal(f.sent.length, settings.enabled ? 3 : 0);
  }
});

test('synchronous clipboard and link failures are independent and bounded', async () => {
  for (const launchError of [true, false]) for (const clipboardMode of ['missing', 'throws', 'ok']) {
    const clipboardError = clipboardMode !== 'ok';
    const clipboard = clipboardMode === 'missing' ? undefined : { writeText: () => { if (clipboardError) throw Error('PRIVATE clipboard details'); return Promise.resolve(); } };
    const f = fixture({ launchError, clipboard });
    f.click(); await settle();
    assert.equal(f.sent[1].outcome, launchError ? 'error' : 'ok');
    assert.equal(f.sent[1].code, launchError ? 'launch_error' : undefined);
    assert.equal(f.sent[2].outcome, clipboardError ? 'error' : 'ok');
    assert.equal(f.sent[2].code, clipboardError ? 'clipboard_error' : undefined);
    assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE|details/);
  }
});

test('a privacy change during clipboard permission drops the stale completion event', async () => {
  for (const notify of [true, false]) {
    let release;
    const f = fixture({ clipboard: { writeText: () => new Promise(resolve => { release = resolve; }) } });
    f.click(); f.settings.linkAccount = false;
    if (notify) f.window.dispatchEvent(new Event('scout-analytics-change'));
    release(); await settle();
    assert.equal(f.sent.length, 2);
  }
});
