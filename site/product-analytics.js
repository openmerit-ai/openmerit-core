// First-party, bounded website telemetry. Never read authenticated Scout state.
const path = location.pathname;
const page = path === '/' ? 'home' : path.startsWith('/docs/') && !path.startsWith('/docs/demo/') ? 'docs' : null;
const identityKey = 'openmerit-website-tab-id';
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let enabled = false;
let anonymousId;
let errors = 0;
let sent = [];
let web;
let privacy;
function accountHeader() {
  try { return { 'X-Scout-Analytics-Account': localStorage.getItem('scout-analytics-account-link') === '0' ? 'off' : 'on' }; }
  catch { return { 'X-Scout-Analytics-Account': 'off' }; }
}

function permitted() {
  try {
    return navigator.doNotTrack !== '1' && window.doNotTrack !== '1' && navigator.globalPrivacyControl !== true && localStorage.getItem('scout-analytics-opt-out') !== '1';
  } catch {
    // If the opt-out preference cannot be read, fail closed.
    return false;
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    return options.method ? undefined : response.ok ? await response.json() : undefined;
  } catch {
    // Analytics must never affect navigation or generate its own error events.
  } finally {
    clearTimeout(timer);
  }
}

function send(event, properties) {
  if (!enabled || !anonymousId || !permitted()) return;
  const now = Date.now();
  sent = sent.filter(time => now - time < 60_000);
  if (sent.length >= 30) return;
  const body = JSON.stringify({ event, anonymousId, properties: { page, ...properties } });
  if (body.length > (event === 'website_error' ? 4096 : 512)) return;
  sent.push(now);
  void request('/scout/api/analytics', {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'web', 'X-Scout-Analytics': 'on', ...accountHeader() },
    body,
  });
}

function destination(anchor) {
  try {
    const raw = anchor.getAttribute('href');
    if (!raw || raw.startsWith('#')) return;
    const url = new URL(raw, location.href);
    if (!['https:', 'http:'].includes(url.protocol)) return;
    if (url.origin === location.origin) {
      if (/^\/(memo|docs\/demo)(\/|$)/.test(url.pathname)) return;
      if (url.pathname.startsWith('/scout/')) return 'scout';
      if (url.pathname.startsWith('/docs/')) return 'docs';
    }
    if (url.hostname === 'dash.openmerit.ai') return 'terminal';
    if (url.hostname === 'github.com') return 'github';
    return 'other';
  } catch { /* Ignore malformed navigation links. */ }
}

async function start() {
  if (!page || !permitted()) return;
  const config = await request('/scout/api/auth');
  if (config?.analytics?.enabled !== true || !permitted()) return;
  try {
    anonymousId = sessionStorage.getItem(identityKey);
    if (!uuid.test(anonymousId ?? '')) {
      anonymousId = crypto.randomUUID();
      sessionStorage.setItem(identityKey, anonymousId);
    }
  } catch {
    // Storage-denied browsers may still use a page-lifetime random ID.
    try { anonymousId = crypto.randomUUID(); } catch { return; }
  }
  enabled = true;
  void import('./scout/analytics-privacy.js').then(module => { privacy = module; }).catch(() => {});
  // Dynamic import keeps this entry point usable without a bundler. The shared
  // contract is also imported directly by the first-party ingestion service.
  void import('./scout/web-analytics.js').then(({ createWebAnalytics }) => {
    web = createWebAnalytics({ permitted: () => enabled && permitted(), send(event, properties, webId) {
      void request('/scout/api/analytics', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'web', 'X-Scout-Analytics': 'on', ...accountHeader(), 'X-Scout-Session-Id': properties.session_id },
        body: JSON.stringify({ event, anonymousId: webId, properties }),
      });
    } });
  }).catch(() => {});
  send('website_visited', {});
  document.addEventListener('click', event => {
    // Only explicit navigation regions/links, never arbitrary clickable content.
    const anchor = event.target?.closest?.('nav a[href], a.brand[href], a.text-link[href], .docs-article a[href], .docs-footer a[href]');
    if (!anchor) return;
    const category = destination(anchor);
    if (category) send('website_link_opened', { destination: category });
    if (['scout', 'docs', 'terminal', 'github'].includes(category) && !anchor.hasAttribute?.('data-web-cta')) web?.interaction(`open_${category}`);
  });
  function report(value) {
    if (errors >= 3 || !permitted()) return;
    let name;
    try { name = value?.name; } catch { return; }
    if (!errorTypes.has(name)) return;
    errors++;
    let frames;
    try { frames = privacy?.exceptionFrames(value?.stack); } catch { frames = []; }
    send('website_error', { code: 'uncaught_error', error_type: name, ...(frames ? { frames } : {}) });
  }
  window.addEventListener('error', event => report(event.error));
  window.addEventListener('unhandledrejection', event => report(event.reason));
}

void start().catch(() => {});
