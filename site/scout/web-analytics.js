// Shared browser/server contract. No DOM access at module evaluation time.
export const webEvents = ['web_pageview', 'web_pageleave', 'web_vitals', 'web_interaction'];
export const ctaIds = ['open_scout', 'open_docs', 'open_terminal', 'open_github', 'search_submit', 'analytics_settings'];
const guides = new Set(['', 'getting-started', 'inference-terminal', 'scout', 'scout-data-policy', 'first-trial', 'demo', 'interactive-demo', 'demo-support', 'demo-spam', 'demo-backfill', 'demo-placement', 'demo-fieldkit', 'agent-evaluations', 'metrics-and-evidence', 'lifecycle', 'automation', 'budgets', 'commands', 'operations', 'troubleshooting', 'security', 'roadmap', 'architecture', 'adapter-guide', 'pareto-spec', 'testing']);
export const uuidV4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function publicPage(path) {
  if (path === '/docs/demo/') return null;
  if (path === '/') return { page: 'home', page_path: '/' };
  if (path === '/scout/' || path === '/scout') return { page: 'scout', page_path: '/scout/' };
  const match = /^\/docs(?:\/([a-z-]+))?\/$/.exec(path);
  return match && guides.has(match[1] || '') ? { page: 'docs', page_path: `/docs/${match[1] ? `${match[1]}/` : ''}` } : null;
}
const enums = {
  referrer_channel: ['direct', 'search', 'social', 'internal', 'referral'],
  referrer_domain: ['none', 'google.com', 'bing.com', 'duckduckgo.com', 'github.com', 'news.ycombinator.com', 'linkedin.com', 'x.com', 'openmerit.ai', 'dash.openmerit.ai'],
  utm_source: ['google', 'bing', 'github', 'hackernews', 'linkedin', 'x', 'newsletter', 'openmerit'],
  utm_medium: ['organic', 'social', 'email', 'referral', 'cpc'],
  utm_campaign: ['launch', 'scout-beta', 'docs'],
  browser: ['chrome', 'safari', 'firefox', 'edge', 'other'],
  device: ['mobile', 'tablet', 'desktop'], os: ['windows', 'macos', 'ios', 'android', 'linux', 'other'],
  viewport: ['small', 'medium', 'large'], cta_id: ctaIds,
  vital_name: ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'],
};
// Reject unknown properties, rather than forwarding potentially sensitive extras.
export function validateWebProperties(event, p) {
  if (!webEvents.includes(event) || !p || typeof p !== 'object') return false;
  const page = publicPage(p.page_path);
  if (!page || page.page !== p.page || page.page_path !== p.page_path || !uuidV4(p.session_id) || !uuidV4(p.pageview_id)) return false;
  const base = ['page', 'page_path', 'session_id', 'pageview_id'];
  const extra = event === 'web_pageview' ? ['referrer_channel', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'browser', 'device', 'os', 'viewport'] : event === 'web_pageleave' ? ['duration_ms', 'scroll_depth', 'content_depth'] : event === 'web_interaction' ? ['cta_id'] : ['vital_name', 'vital_value'];
  if (Object.keys(p).some(key => ![...base, ...extra].includes(key))) return false;
  if (extra.some(key => !key.startsWith('utm_') && !(key in p))) return false;
  for (const key of extra) if (key in p && enums[key] && !enums[key].includes(p[key])) return false;
  if (event === 'web_pageleave' && (!Number.isInteger(p.duration_ms) || p.duration_ms < 0 || p.duration_ms > 86400000 || ['scroll_depth', 'content_depth'].some(key => !Number.isInteger(p[key]) || p[key] < 0 || p[key] > 100))) return false;
  if (event === 'web_vitals' && (!Number.isFinite(p.vital_value) || p.vital_value < 0 || p.vital_value > (p.vital_name === 'CLS' ? 10 : 60000))) return false;
  return true;
}
export function webPermitted(env = globalThis) {
  try { return env.navigator.doNotTrack !== '1' && env.doNotTrack !== '1' && env.navigator.globalPrivacyControl !== true && env.localStorage.getItem('scout-analytics-opt-out') !== '1'; } catch { return false; }
}
export function pageContext(env) {
  const ua = env.navigator.userAgent || '';
  let domain = 'none', channel = 'direct';
  try {
    const host = new URL(env.document.referrer).hostname.replace(/^www\./, '');
    channel = 'referral';
    if (enums.referrer_domain.includes(host)) {
      domain = host;
      channel = ['google.com', 'bing.com', 'duckduckgo.com'].includes(host) ? 'search' : host.endsWith('openmerit.ai') ? 'internal' : ['linkedin.com', 'x.com'].includes(host) ? 'social' : 'referral';
    }
  } catch { /* No public referrer. */ }
  const result = { referrer_channel: channel, referrer_domain: domain,
    browser: /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other',
    device: /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|Android|iPhone/.test(ua) ? 'mobile' : 'desktop',
    os: /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : 'other',
    viewport: env.innerWidth < 640 ? 'small' : env.innerWidth < 1200 ? 'medium' : 'large' };
  const query = new URLSearchParams(env.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) if (enums[key].includes(query.get(key))) result[key] = query.get(key);
  return result;
}
export function createWebAnalytics({ send, permitted = () => webPermitted(), env = globalThis, now = Date.now, autoStart = true, accountLink = () => env.localStorage.getItem('scout-analytics-account-link') !== '0' }) {
  let active, pageSession, pageviewId, started, depth = 0, contentDepth = 0, identity, session, born = 0, touched = 0, linked, count = 0, windowStart = 0;
  let stopped = false, vitalsStarted = false;
  const key = 'openmerit-web-tab';
  function startVitals() {
    if (env !== globalThis || vitalsStarted || stopped) return;
    vitalsStarted = true;
    void import('./vendor/web-vitals.js').then(vitals => {
      if (stopped || !consent()) return;
      for (const name of ['LCP', 'CLS', 'INP', 'FCP', 'TTFB']) vitals[`on${name}`](metric => {
        if (!stopped) emit('web_vitals', { vital_name: metric.name, vital_value: metric.value });
      });
    }).catch(() => {});
  }
  function consent() {
    if (!permitted() || !webPermitted(env)) {
      active = undefined; identity = session = undefined;
      try { env.sessionStorage.removeItem(key); } catch { /* optional */ }
      return false;
    }
    let nextLinked;
    try { nextLinked = accountLink() === true; } catch { return false; }
    if (linked !== undefined && linked !== nextLinked) { identity = session = undefined; active = undefined; }
    linked = nextLinked;
    if (!identity && linked) {
      try {
        const saved = JSON.parse(env.sessionStorage.getItem(key));
        if (uuidV4(saved?.anonymousId) && uuidV4(saved?.session_id) && Number.isFinite(saved.born) && Number.isFinite(saved.touched) && saved.born <= now() && saved.touched <= now()) {
          identity = saved.anonymousId; session = saved.session_id; born = saved.born; touched = saved.touched;
        }
      } catch { /* Optional tab storage. */ }
    }
    identity ||= env.crypto.randomUUID();
    if (!session || now() - touched >= 1800000 || now() - born >= 86400000) { session = env.crypto.randomUUID(); born = now(); }
    touched = now();
    try {
      if (linked) env.sessionStorage.setItem(key, JSON.stringify({ anonymousId: identity, session_id: session, born, touched }));
      else env.sessionStorage.removeItem(key);
    } catch { /* Page lifetime only. */ }
    return true;
  }
  function deliver(event, properties, page = active, sessionId = pageSession) {
    const p = { ...page, session_id: sessionId, pageview_id: pageviewId, ...properties };
    if (!validateWebProperties(event, p)) return;
    if (now() - windowStart >= 60000) { count = 0; windowStart = now(); }
    if (count++ >= 60) return;
    try { Promise.resolve(send(event, p, identity)).catch(() => {}); } catch { /* Non-critical. */ }
  }
  function syncPageSession() {
    if (!active || pageSession === session) return;
    deliver('web_pageleave', { duration_ms: Math.min(86400000, Math.max(0, Math.round(now() - started))), scroll_depth: depth, content_depth: contentDepth });
    pageSession = session; pageviewId = env.crypto.randomUUID(); started = now(); depth = contentDepth = 0; measureScroll();
    deliver('web_pageview', pageContext(env));
  }
  function emit(event, properties, page = active) {
    if (stopped || !consent() || !page || page !== active) return;
    syncPageSession();
    deliver(event, properties, page);
  }
  function leave() {
    if (stopped || !consent() || !active) return;
    syncPageSession();
    measureScroll();
    deliver('web_pageleave', { duration_ms: Math.min(86400000, Math.max(0, Math.round(now() - started))), scroll_depth: depth, content_depth: contentDepth });
    active = undefined;
  }
  function navigate() {
    if (stopped || !consent()) return;
    syncPageSession();
    const page = publicPage(env.location.pathname);
    if (active?.page_path === page?.page_path) return;
    leave();
    if (!page || env.document.visibilityState === 'hidden') return;
    active = page; pageSession = session; pageviewId = env.crypto.randomUUID(); started = now(); depth = contentDepth = 0; measureScroll();
    emit('web_pageview', pageContext(env));
    startVitals();
  }
  const listeners = [];
  function on(target, name, fn) { target.addEventListener(name, fn); listeners.push(() => target.removeEventListener(name, fn)); }
  on(env, 'pagehide', leave);
  on(env, 'pageshow', navigate);
  on(env, 'popstate', navigate);
  on(env, 'scout-analytics-change', navigate);
  on(env, 'storage', event => {
    if (event.key === null || ['scout-analytics-opt-out', 'scout-analytics-account-link'].includes(event.key)) navigate();
  });
  // Tab switches are not navigations. pagehide owns the terminal leave (and
  // pageshow starts a new lifecycle for a BFCache restore).
  on(env.document, 'visibilitychange', () => { if (env.document.visibilityState !== 'hidden') navigate(); else consent(); });
  function measureScroll() {
    if (!active || !consent()) return;
    const height = env.document.documentElement.scrollHeight - env.innerHeight;
    depth = Math.max(depth, height <= 0 ? 100 : Math.min(100, Math.max(0, Math.round(env.scrollY / height * 100))));
    contentDepth = Math.max(contentDepth, Math.min(100, Math.max(0, Math.round((env.scrollY + env.innerHeight) / env.document.documentElement.scrollHeight * 100))) || 0);
  }
  on(env, 'scroll', measureScroll);
  on(env.document, 'click', event => {
    const id = event.target?.closest?.('[data-web-cta]')?.getAttribute('data-web-cta');
    if (ctaIds.includes(id)) emit('web_interaction', { cta_id: id });
  });
  if (autoStart) navigate();
  return { navigate, leave, interaction: id => emit('web_interaction', { cta_id: id }),
    identity() { if (!consent()) return null; syncPageSession(); return { anonymousId: identity, session_id: session }; },
    reset() {
      active = undefined; identity = session = undefined;
      try { env.sessionStorage.removeItem(key); } catch { /* optional */ }
    },
    // Also available to application-owned web-vitals integrations.
    vital: metric => emit('web_vitals', { vital_name: metric.name, vital_value: metric.value }),
    stop() { leave(); stopped = true; listeners.forEach(off => off()); } };
}
