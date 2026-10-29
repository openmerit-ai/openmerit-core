import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const draft = 'Extract invoice dates and totals as JSON';
const page = await readFile(new URL('../../site/scout/index.html', import.meta.url), 'utf8');
type Session = { status: string; getToken: () => Promise<string> };
type Account = { user: { id: string } | null; session: Session | null };

// Run the real composer and shared auth module; only browser/platform services
// are replaced. Failed optional imports must not stop event registration.
async function fixture(blocked = 'analytics.js', failure = '', options: {
  saved?: Map<string, string>; signedIn?: boolean; storageDisabled?: boolean; coverage?: unknown; coverageFailure?: boolean;
  pauseAuth?: 'config' | 'clerk';
  navigator?: { doNotTrack?: string; globalPrivacyControl?: boolean; clipboard?: Pick<Clipboard, 'writeText'> };
  launchFailure?: boolean; analytics?: { enabled: boolean; linkAccount: boolean };
} = {}) {
  const output = await build({
    entryPoints: [new URL('../../site/scout/scout.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'iife',
    define: { 'import.meta.url': JSON.stringify('https://example.test/scout/scout.js') },
    plugins: [{ name: 'blocked-analytics', setup(builder) {
      // Check source even when a previous website build left generated JS beside it.
      builder.onResolve({ filter: /\/onboarding\.js$/ }, () => ({ path: new URL('../../site/scout/onboarding.ts', import.meta.url).pathname }));
      builder.onLoad({ filter: new RegExp(`/${blocked.replaceAll('.', '\\.')}$`) }, () => ({
        contents: options.analytics
          ? `export const analytics = { configure() {}, account() {}, track: async () => false, preferences: () => ({ available: true, ...${JSON.stringify(options.analytics)} }) };`
          : `throw new Error('blocked optional module'); export const analytics = {}; export const createWebAnalytics = () => {}; export const webPermitted = () => false;`,
      }));
    } }],
  });
  const nodes = new Map<string, ReturnType<typeof node>>(), saved = options.saved ?? new Map<string, string>();
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const observers = new Set<() => void>();
  let releaseAuth = () => {};
  const authReady = options.pauseAuth ? new Promise<void>(resolve => { releaseAuth = resolve; }) : Promise.resolve();
  const state = { authStatus: failure === 'config' ? 503 : 200, loadFailure: failure === 'clerk', hangUI: failure.startsWith('modal'), opened: 0, modal: false, ready: false, requests: [] as string[] };
  const turns: { message: string; authorization: string | null }[] = [];
  let nextTimer = 0;
  function node() {
    const target = new EventTarget();
    return Object.assign(target, {
      value: '', textContent: '', placeholder: '', hidden: true, disabled: false,
      style: {}, dataset: {} as Record<string, string>, inert: true, scrollHeight: 40, focus() {}, scrollIntoView() {},
      setAttribute() {}, removeAttribute() {},
      querySelectorAll: (selector: string): EventTarget[] => selector === '[data-welcome-step]'
        ? Array.from({ length: 5 }, (_, index) => $(`[data-welcome-step="${index}"]`))
        : selector === '[data-example-task]' ? Array.from({ length: 3 }, (_, index) => $(`[data-example-task="${index}"]`)) : [],
      querySelector: $,
      append() {}, prepend() {}, cloneNode: node, replaceChildren() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} },
      requestSubmit() { target.dispatchEvent(new Event('submit', { cancelable: true })); },
    });
  }
  function $(selector: string) {
    if (!nodes.has(selector)) {
      const value = node();
      value.hidden = selector === '#onboarding'
        ? /\bhidden\b/.test(page.match(/<div\b[^>]*\bid="onboarding"[^>]*>/)![0])
        : selector !== '#scout-app';
      const step = selector.match(/^\[data-welcome-step="(\d+)"\]$/);
      if (step) value.dataset.welcomeStep = step[1]!;
      nodes.set(selector, value);
    }
    return nodes.get(selector)!;
  }
  const available = () => { if (options.storageDisabled) throw new Error('Storage disabled'); };
  const storage = { getItem: (key: string) => { available(); return saved.get(key) ?? null; }, setItem: (key: string, value: string) => { available(); saved.set(key, value); }, removeItem: (key: string) => { available(); saved.delete(key); } };
  let observe = (_account: Account) => {};
  const clerk = {
    session: options.signedIn ? { status: 'active', getToken: async () => 'current-session-token' } : null as Session | null,
    user: options.signedIn ? { id: 'user-one' } : null as { id: string } | null,
    load: async () => { if (options.pauseAuth === 'clerk') await authReady; if (state.loadFailure) throw new Error('private provider failure'); },
    addListener: (fn: (value: Account) => void) => { observe = fn; fn(clerk); },
    mountUserButton() {}, unmountUserButton() {},
    openSignIn() { state.opened++; state.modal = true; state.ready = !state.hangUI; },
    closeSignIn() { state.modal = state.ready = false; for (const check of observers) check(); },
  };
  const document = Object.assign(new EventTarget(), {
    body: node(), visibilityState: 'visible', createElement: node,
    querySelector: (selector: string) => selector === '.scout-auth-ready' ? state.ready ? {} : null : selector === '.scout-auth-modal' ? state.modal ? {} : null : $(selector),
  });
  const location = { origin: 'https://example.test', pathname: '/scout/', href: 'https://example.test/scout/' };
  if (options.launchFailure) Object.defineProperty(location, 'href', { set() { throw new Error('Private launch failure'); } });
  const env = Object.assign(new EventTarget(), {
    document, location,
    URL, Event, AbortSignal, crypto, TextEncoder, navigator: options.navigator ?? {}, sessionStorage: storage, localStorage: storage, performance,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: true }), __internal_ClerkUICtor: {}, Clerk: clerk,
    MutationObserver: class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
    setTimeout: (callback: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, request: RequestInit = {}) => {
      state.requests.push(url);
      if (url.endsWith('/api/status')) {
        if (options.coverageFailure) throw new Error('Status unavailable');
        return Response.json(options.coverage ?? {});
      }
      if (url.endsWith('/api/agent') && request.method === 'POST') {
        turns.push({ message: (JSON.parse(String(request.body)) as { message: string }).message, authorization: new Headers(request.headers).get('Authorization') });
        return Response.json({ busy: false, progress: [], answer: { kind: 'message', text: 'Models found.' } });
      }
      if (url.endsWith('/api/auth') && options.pauseAuth === 'config') await authReady;
      return Response.json({ analytics: { enabled: false } }, { status: url.endsWith('/api/auth') ? state.authStatus : 200 });
    },
  });
  runInNewContext(output.outputFiles[0]!.text, { ...env, window: env, addEventListener: env.addEventListener.bind(env) });
  await drain();
  return { $, state, saved, clerk, turns, document, location,
    async resolveAuth() { releaseAuth(); await drain(); },
    async signedIn(status = 'active') {
      clerk.session = { status, getToken: async () => 'current-session-token' }; clerk.user = { id: 'user-one' };
      observe(clerk); await drain();
    },
    async signedOut() { clerk.session = null; clerk.user = null; observe(clerk); await drain(); },
    async submit(enter = false) {
      $('#prompt').value = draft;
      if (enter) $('#prompt').dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', shiftKey: false, isComposing: false }));
      else $('#composer').requestSubmit();
      await drain();
    },
    async expire(ms: number) { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.callback(); } await drain(); },
  };
}

test('selecting an example starts one conversation turn, after sign-in if needed', async () => {
  for (const signedIn of [true, false]) {
    const f = await fixture('analytics.js', '', { signedIn });
    const button = f.$('[data-example-task="1"]');
    button.textContent = 'Extract invoice dates, line items and totals into JSON.';
    button.dispatchEvent(new Event('click')); await drain();
    assert.equal(f.state.opened, signedIn ? 0 : 1);
    if (!signedIn) {
      assert.equal(f.turns.length, 0);
      assert.equal(f.$('#prompt').value, 'Extract invoice dates, line items and totals into JSON.');
      await f.signedIn();
    }
    assert.equal(f.turns.length, 1);
    assert.equal(f.turns[0]!.message, 'Extract invoice dates, line items and totals into JSON.');
    assert.equal(f.$('#prompt').value, '');
  }
});

test('five modal steps lead to auth while the visible page stays inert until an active session, without submitting an example', async () => {
  const f = await fixture();
  assert.equal(f.$('#onboarding').hidden, false);
  assert.equal(f.$('#scout-app').hidden, false);
  assert.equal(f.$('#scout-app').inert, true);
  const figures = ['#welcome-note', '#welcome-intro', '#welcome-stack', '#welcome-product', '#welcome-claude'];
  for (const [index, figure] of figures.entries()) {
    for (const other of figures) assert.equal(f.$(other).hidden, other !== figure, `${other} visibility on slide ${index + 1}`);
    assert.equal(f.$('#scout-app').inert, true);
    assert.equal(f.state.opened, 0, `slide ${index + 1} does not open auth before its CTA`);
    f.$('#welcome-next').dispatchEvent(new Event('click')); await drain();
  }
  assert.equal(f.state.opened, 1);
  assert.equal(f.$('#scout-app').inert, true);
  f.clerk.closeSignIn(); await drain();
  assert.equal(f.$('#onboarding').hidden, false);
  assert.equal(f.$('#welcome-error').hidden, true);
  await f.signedIn('pending');
  assert.equal(f.$('#scout-app').inert, true);
  await f.signedIn();
  assert.equal(f.$('#onboarding').hidden, true);
  assert.equal(f.$('#scout-app').hidden, false);
  assert.equal(f.$('#scout-app').inert, false);
  assert.equal(f.turns.length, 0);
  await f.signedOut();
  assert.equal(f.$('#scout-app').hidden, false);
  assert.equal(f.$('#scout-app').inert, true);
  assert.equal(f.$('#onboarding').hidden, false);
});

test('progress controls unlock with Continue and keep visited slides available after going back', async () => {
  const f = await fixture();
  const buttons = Array.from({ length: 5 }, (_, index) => f.$(`[data-welcome-step="${index}"]`));
  assert.deepEqual(buttons.map(button => button.disabled), [false, true, true, true, true]);
  f.$('#welcome-next').dispatchEvent(new Event('click'));
  assert.deepEqual(buttons.map(button => button.disabled), [false, false, true, true, true]);
  f.$('#welcome-next').dispatchEvent(new Event('click'));
  assert.deepEqual(buttons.map(button => button.disabled), [false, false, false, true, true]);
  buttons[0]!.dispatchEvent(new Event('click'));
  assert.equal(f.$('#welcome-note').hidden, false);
  assert.deepEqual(buttons.map(button => button.disabled), [false, false, false, true, true]);
  buttons[2]!.dispatchEvent(new Event('click'));
  assert.equal(f.$('#welcome-stack').hidden, false);
  f.$('#welcome-next').dispatchEvent(new Event('click'));
  assert.deepEqual(buttons.map(button => button.disabled), [false, false, false, false, true]);
  assert.equal(f.state.opened, 0);
  assert.equal(f.turns.length, 0);
});

test('returning sessions bypass onboarding; signed-out reloads start at the first slide despite an old marker or blocked storage', async () => {
  const returning = await fixture('analytics.js', '', { signedIn: true });
  assert.equal(returning.$('#onboarding').hidden, true);
  assert.equal(returning.$('#scout-app').hidden, false);
  assert.equal(returning.turns.length, 0);
  for (const storageDisabled of [false, true]) {
    const saved = new Map([['scout-onboarding-v1', '1']]);
    const f = await fixture('analytics.js', 'config', { saved, storageDisabled });
    assert.equal(f.$('#welcome-note').hidden, false);
    assert.equal(f.$('#welcome-claude').hidden, true);
    assert.equal(f.$('[data-welcome-step="4"]').disabled, true);
    for (let i = 0; i < 4; i++) f.$('#welcome-next').dispatchEvent(new Event('click'));
    f.$('#welcome-next').dispatchEvent(new Event('click')); await drain();
    assert.equal(f.$('#welcome-error').hidden, false);
    assert.match(f.$('#welcome-error').textContent, /Sign-in could not load/);
    assert.equal(f.$('#welcome-next').disabled, false);
    assert.equal(f.$('#scout-app').hidden, false);
    assert.equal(f.$('#scout-app').inert, true);
    f.state.authStatus = 200;
    f.$('#welcome-next').dispatchEvent(new Event('click')); await drain();
    assert.equal(f.state.opened, 1);
    await f.signedIn();
    assert.equal(f.$('#scout-app').hidden, false);
    assert.equal(f.$('#scout-app').inert, false);
    assert.equal(f.turns.length, 0);
  }
});

test('onboarding stays hidden during session restoration and only opens for signed-out or failed checks', async () => {
  for (const pauseAuth of ['config', 'clerk'] as const) {
    for (const signedIn of [true, false]) {
      const f = await fixture('analytics.js', '', { pauseAuth, signedIn });
      assert.equal(f.$('#onboarding').hidden, true, `no introduction while ${pauseAuth} is pending`);
      assert.equal(f.$('#scout-app').inert, true);
      await f.resolveAuth();
      assert.equal(f.$('#onboarding').hidden, signedIn);
      assert.equal(f.$('#scout-app').inert, !signedIn);
      assert.equal(f.state.opened, 0);
      assert.equal(f.turns.length, 0);
    }
    const failed = await fixture('analytics.js', pauseAuth, { pauseAuth });
    assert.equal(failed.$('#onboarding').hidden, true);
    await failed.resolveAuth();
    assert.equal(failed.$('#onboarding').hidden, false, 'sign-in remains reachable after a failed check');
    assert.equal(failed.$('#scout-app').inert, true);
  }
});

test('Claude handoff remains usable with analytics blocked and opens before clipboard permission settles', async () => {
  let copied = '', finishCopy = () => {};
  const f = await fixture('analytics.js', '', { navigator: { clipboard: { writeText: text => {
    copied = text; return new Promise<void>(resolve => { finishCopy = resolve; });
  } } } });
  f.$('#prompt').value = 'Private task that must never enter setup';
  f.$('#add-to-claude').dispatchEvent(new Event('click'));
  const url = new URL(f.location.href);
  assert.equal(url.protocol, 'claude:'); assert.equal(url.hostname, 'code'); assert.equal(url.pathname, '/new');
  assert.deepEqual([...url.searchParams.keys()], ['q']); assert.equal(url.searchParams.get('q'), copied);
  assert.match(copied, /npx -y openmerit@latest install --client claude-code/);
  assert.match(copied, /start a new Claude Code session/);
  assert.doesNotMatch(copied, /Private task|--setup-id|DO_NOT_TRACK|OPENMERIT_TELEMETRY/);
  assert.equal(f.state.opened, 0); assert.equal(f.turns.length, 0);
  finishCopy(); await drain();
  assert.match(f.$('#claude-setup-status').textContent, /Setup prompt copied/);
  assert.equal(f.$('#prompt').value, 'Private task that must never enter setup');
});

test('Claude handoff preserves privacy refusals and unlinked setup without browser correlation', async () => {
  for (const options of [
    { saved: new Map([['scout-analytics-opt-out', '1']]) },
    { navigator: { doNotTrack: '1' } }, { navigator: { globalPrivacyControl: true } }, { storageDisabled: true },
    { saved: new Map([['scout-analytics-account-link', '0']]) },
  ]) {
    let copied = '';
    const f = await fixture('analytics.js', '', { ...options, navigator: { ...options.navigator, clipboard: { writeText: async text => { copied = text; } } } });
    f.$('#add-to-claude').dispatchEvent(new Event('click')); await drain();
    assert.match(copied, options.saved?.has('scout-analytics-account-link') ? /OPENMERIT_ANALYTICS_ACCOUNT=off npx/ : /DO_NOT_TRACK=1 npx/);
    assert.doesNotMatch(copied, /--setup-id/);
    assert.equal(new URL(f.location.href).searchParams.get('q'), copied);
  }
});

test('Claude handoff creates fresh setup correlation only for enabled, account-linked collection', async () => {
  for (const linkAccount of [true, false]) {
    const prompts: string[] = [];
    const f = await fixture('analytics.js', '', { analytics: { enabled: true, linkAccount }, navigator: { clipboard: { writeText: async text => { prompts.push(text); } } } });
    for (let i = 0; i < 2; i++) { f.$('#add-to-claude').dispatchEvent(new Event('click')); await drain(); }
    if (linkAccount) {
      for (const prompt of prompts) assert.match(prompt, /--setup-id [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
      assert.notEqual(prompts[0], prompts[1]);
    } else for (const prompt of prompts) { assert.match(prompt, /OPENMERIT_ANALYTICS_ACCOUNT=off npx/); assert.doesNotMatch(prompt, /--setup-id/); }
  }
});

test('Claude handoff attempts clipboard and app launch independently and reports failures honestly', async () => {
  for (const launchFailure of [false, true]) for (const copy of ['missing', 'throws', 'denied', 'allowed']) {
    let copied = '';
    const navigator = copy === 'missing' ? {} : { clipboard: { writeText: (text: string) => {
      if (copy === 'throws') throw new Error('Private clipboard failure');
      if (copy === 'denied') return Promise.reject(new Error('Private clipboard denial'));
      copied = text; return Promise.resolve();
    } } };
    const f = await fixture('analytics.js', '', { navigator, launchFailure });
    f.$('#add-to-claude').dispatchEvent(new Event('click')); await drain();
    const status = f.$('#claude-setup-status').textContent;
    assert.match(status, copy === 'allowed' ? /Setup prompt copied/ : launchFailure ? /Couldn’t copy or request Claude/ : /Claude launch requested/);
    assert.doesNotMatch(status, /Private|connected|installed/);
    if (copy === 'allowed') assert.match(copied, /install --client claude-code/);
    if (!launchFailure) assert.equal(new URL(f.location.href).protocol, 'claude:');
  }
});

test('public coverage distinguishes catalogue models, Hub repositories, benchmarked labs and source feeds', async () => {
  const coverage = { availableModels: 1234, models: 213, specialistRepositories: 87, providers: 19, benchmarks: 462, sources: [{ id: 'feed' }, { id: 'research:example.org' }, { id: 'feed' }] };
  const f = await fixture('analytics.js', '', { coverage });
  assert.equal(f.$('#index-counts').hidden, false);
  assert.equal(f.$('#index-counts').textContent.replaceAll('\u00a0', ' '), '1,234 indexed models · 87 Hub repos · 19 benchmarked labs · 462 benchmarks · 2 source feeds');
  assert.equal(f.$('#welcome-coverage').hidden, false);
  assert.equal(f.$('#welcome-coverage-summary').hidden, true);
  assert.equal(f.$('#welcome-model-count').textContent, '1,234');
  assert.equal(f.$('#welcome-lab-count').textContent, '19');
  assert.equal(f.$('#welcome-benchmark-count').textContent, '462');
  assert.equal(f.$('#welcome-source-count').textContent, '2');
  assert.equal(f.$('#welcome-hub-count').textContent, 'Also exploring 87 Hugging Face repositories.');
  assert.equal(f.state.requests.filter(url => url.endsWith('/api/status')).length, 1);
  for (const options of [{ coverageFailure: true }, { coverage: { ...coverage, availableModels: -1 } }, { coverage: { ...coverage, providers: null } }, { coverage: { ...coverage, sources: [{}] } }]) {
    const unavailable = await fixture('analytics.js', '', options);
    assert.equal(unavailable.$('#index-counts').hidden, true);
    assert.equal(unavailable.$('#welcome-coverage').hidden, true);
    await unavailable.submit();
    assert.equal(unavailable.state.opened, 1, 'coverage failure must not block sign-in');
    assert.equal(unavailable.$('#error').hidden, true);
  }
});

test('click and Enter submissions still open sign-in with either analytics dependency blocked', async () => {
  for (const blocked of ['analytics.js', 'web-analytics.js']) for (const enter of [false, true]) {
    const f = await fixture(blocked);
    await f.submit(enter);
    assert.equal(f.state.opened, 1);
    assert.equal(f.$('#prompt').value, draft);
    assert.equal(f.saved.get('scout-sign-in-draft'), draft);
    assert.ok(f.state.requests.every(url => !url.includes('/api/agent')));
    assert.equal(f.$('#error').hidden, true);
    f.clerk.closeSignIn(); await drain();
    assert.equal(f.$('#error').hidden, true, 'closing the usable modal is not an error');
  }
});

test('auth failures show an actionable error, preserve the draft, and allow a later retry', async () => {
  for (const failure of ['config', 'clerk', 'modal', 'modal-disappeared']) {
    const f = await fixture('analytics.js', failure);
    await f.submit();
    if (failure === 'modal') await f.expire(30_000);
    if (failure === 'modal-disappeared') { f.clerk.closeSignIn(); await drain(); }
    assert.equal(f.$('#error').hidden, false, failure);
    assert.match(f.$('#error').textContent, /Sign-in could not load.*reload/);
    assert.equal(f.$('#prompt').value, draft);
    assert.equal(f.state.modal, false);
    assert.ok(f.state.requests.every(url => !url.includes('/api/agent')));
    f.state.authStatus = 200; f.state.loadFailure = f.state.hangUI = false;
    await f.submit(true);
    assert.equal(f.state.modal, true);
    assert.equal(f.$('#error').hidden, true);
  }
});

test('an explicit submission starts one authenticated turn after sign-in, not during pending signup or session refreshes', async () => {
  for (const storageDisabled of [false, true]) {
    const f = await fixture('analytics.js', '', { storageDisabled });
    await f.submit();
    assert.equal(f.turns.length, 0);
    await f.signedIn('pending');
    assert.equal(f.turns.length, 0);
    await f.signedIn();
    assert.deepEqual(f.turns, [{ message: draft, authorization: 'Bearer current-session-token' }]);
    assert.equal(f.$('#prompt').value, '');
    assert.equal(f.saved.has('scout-sign-in-submission'), false);
    await f.signedIn();
    assert.equal(f.turns.length, 1);
  }
});

test('OAuth return resumes the submitted draft once, while ordinary header sign-in only restores a draft', async () => {
  const before = await fixture();
  await before.submit(true);
  const saved = new Map(before.saved);
  const returned = await fixture('analytics.js', '', { saved, signedIn: true });
  assert.deepEqual(returned.turns, [{ message: draft, authorization: 'Bearer current-session-token' }]);
  const reload = await fixture('analytics.js', '', { saved, signedIn: true });
  assert.equal(reload.turns.length, 0);

  const header = await fixture();
  header.$('#prompt').value = draft;
  header.$('#sign-in').dispatchEvent(new Event('click'));
  await drain();
  assert.equal(header.state.opened, 1);
  const headerReturn = await fixture('analytics.js', '', { saved: header.saved, signedIn: true });
  assert.equal(headerReturn.$('#prompt').value, draft);
  assert.equal(headerReturn.turns.length, 0);
});

test('editing the draft or dismissing sign-in cancels automatic submission', async () => {
  for (const cancel of ['edit', 'dismiss']) {
    const f = await fixture();
    await f.submit();
    if (cancel === 'edit') {
      f.$('#prompt').value = 'A different task';
      f.$('#prompt').dispatchEvent(new Event('input'));
    } else {
      f.document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      f.clerk.closeSignIn();
    }
    await f.signedIn();
    assert.equal(f.turns.length, 0);
    assert.equal(f.saved.has('scout-sign-in-submission'), false);
  }
});
