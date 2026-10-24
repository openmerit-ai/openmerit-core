import { errorType, exceptionFrames } from './analytics-privacy.js';
import { createWebAnalytics, webPermitted } from './web-analytics.js';

const endpoint = new URL('./api/analytics', import.meta.url).pathname;
const storageKey = 'scout-product-analytics';
let enabled = false, accountSync = false, contentAvailable = false, contentDefault = false, state, session, currentUser, lastAllowed, lastLinked, generation = 0, visited = false, ready = Promise.resolve();
let usageChoice, contentChoice, linkChoice, errors = 0;
let page = 'scout', requestUsage = true, requestLink = true;
let web;
const fresh = () => ({ anonymousId: accountLinked() && web?.identity()?.anonymousId || crypto.randomUUID(), user: null, session: null, linked: accountLinked() });
function allowed() {
  if (!enabled || !requestUsage || !webPermitted()) return false;
  if (usageChoice !== undefined) return usageChoice;
  try { return localStorage.getItem('scout-analytics-opt-out') !== '1'; } catch { return false; }
}
function contentAllowed() {
  if (!allowed() || !contentAvailable) return false;
  if (contentChoice !== undefined) return contentChoice;
  try {
    const saved = localStorage.getItem('scout-analytics-content');
    return saved === '1' || saved === null && contentDefault;
  } catch { return false; } // An unreadable existing refusal must not become consent.
}
function accountLinked() {
  try { return requestLink && localStorage.getItem('scout-analytics-account-link') !== '0' && linkChoice !== false; } catch { return false; }
}
function save() {
  try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Optional tab storage. */ }
}
async function hash(value) {
  if (!value) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function preference(active, current, value) {
  if (!accountSync || !active) return;
  try {
    const token = await active.getToken();
    if (!token || current !== generation || allowed() !== value) return;
    // Privacy control, not a product event: even opted-out sessions send only
    // this boolean and their authentication token, without an anonymous ID.
    await fetch(`${endpoint}/preference`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Scout-Analytics': value ? 'on' : 'off' },
      body: JSON.stringify({ enabled: value }), signal: AbortSignal.timeout(7000), keepalive: true, redirect: 'error',
    });
  } catch { /* Analytics availability must never affect sign-in or search. */ }
}

export const analytics = {
  configure(value, sync = false, content = false, beta = false, context = {}) {
    page = context.page === 'connect' ? 'connect' : 'scout';
    requestUsage = context.usage !== false; requestLink = context.linkAccount !== false;
    // An installer URL refusal is request-local, not a new account preference.
    enabled = value === true; accountSync = sync === true && requestUsage; contentAvailable = content === true; contentDefault = beta === true; currentUser = undefined; lastAllowed = undefined; lastLinked = undefined; generation++;
    globalThis.dispatchEvent?.(new Event('scout-analytics-change'));
    if (!web && globalThis.document?.addEventListener && globalThis.location) {
      web = createWebAnalytics({ permitted: allowed, accountLink: accountLinked, autoStart: false,
        send: (event, properties, anonymousId) => analytics.track(event, properties, anonymousId) });
    }
    if (!allowed()) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey));
      if (/^[0-9a-f-]{36}$/.test(saved?.anonymousId) && [saved.user, saved.session].every(v => v === null || /^[0-9a-f]{64}$/.test(v))) state = saved;
    } catch { /* Disabled or invalid storage does not affect Scout. */ }
    state ??= fresh();
    if (accountLinked() && web) state.anonymousId = web.identity().anonymousId;
  },
  preferences() {
    return { available: enabled && navigator.doNotTrack !== '1' && navigator.globalPrivacyControl !== true,
      enabled: allowed(), contentAvailable, contentDefault, content: contentAllowed(), linkAccount: accountLinked() };
  },
  webNavigation() { web?.navigate(); },
  webInteraction(id) { web?.interaction(id); },
  webVital(metric) { web?.vital(metric); },
  setPreferences(usage, content, link = accountLinked()) {
    usageChoice = usage === true; contentChoice = usageChoice && content === true; linkChoice = link === true;
    try {
      localStorage.setItem('scout-analytics-opt-out', usageChoice ? '0' : '1');
      localStorage.setItem('scout-analytics-content', contentChoice ? '1' : '0');
      localStorage.setItem('scout-analytics-account-link', linkChoice ? '1' : '0');
    } catch { /* In-memory controls still apply when browser storage is denied. */ }
    analytics.account(currentUser, session);
    globalThis.dispatchEvent?.(new Event('scout-analytics-change'));
  },
  exception(error, code = 'uncaught_error', properties = {}) {
    if (!allowed() || errors >= 3) return;
    errors++;
    analytics.track('scout_client_error', { ...properties, code, error_type: errorType(error?.name), frames: exceptionFrames(error?.stack) });
  },
  account(userId, activeSession, signIn) {
    const permitted = allowed(), linked = accountLinked();
    const unchanged = currentUser === userId && session?.id === activeSession?.id && lastAllowed === permitted && lastLinked === linked;
    const switched = !!currentUser && currentUser !== userId;
    currentUser = userId; session = activeSession;
    lastAllowed = permitted; lastLinked = linked;
    if (!permitted) {
      if (unchanged) return;
      const current = ++generation; state = undefined;
      web?.reset();
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional tab storage. */ }
      ready = preference(activeSession, current, false);
      return;
    }
    if (unchanged && state) return;
    const current = ++generation;
    if (switched || state && (state.linked ?? true) !== linked) { web?.reset(); state = fresh(); }
    state ??= fresh();
    ready = (async () => {
      await preference(activeSession, current, true);
      const [user, sessionId] = await Promise.all([hash(userId), hash(activeSession?.id)]);
      if (current !== generation) return;
      if (state.user && state.user !== user) { web?.reset(); state = fresh(); }
      const signedIn = !!user && state.session !== sessionId;
      state.user = user; state.session = sessionId; save();
      web?.navigate();
      if (page === 'scout' && !visited) {
        visited = true; analytics.track('scout_visited');
        globalThis.dispatchEvent?.(new Event('scout-analytics-ready'));
      }
      if (signedIn && linked) {
        // Linked accounts and the client's latest authentication strategy are
        // not proof of how this particular session was created.
        const verification = signIn?.status === 'complete' && signIn.createdSessionId === activeSession?.id ? signIn.firstFactorVerification : null;
        const strategy = verification?.status === 'verified' ? verification.strategy : null;
        const provider = strategy === 'oauth_google' ? 'google' : strategy === 'oauth_github' ? 'github' : 'unknown';
        analytics.track('scout_session_observed', { auth_provider: provider });
      }
    })().catch(() => {});
  },
  headers() {
    if (state && state.linked !== accountLinked()) analytics.account(currentUser, session);
    const webIdentity = allowed() ? web?.identity() : null;
    return {
      'X-Scout-Client': 'web', 'X-Scout-Analytics': allowed() ? 'on' : 'off',
      'X-Scout-Analytics-Content': contentAllowed() ? 'on' : 'off',
      'X-Scout-Analytics-Account': accountLinked() ? 'on' : 'off',
      ...(allowed() && state ? { 'X-Scout-Anonymous-Id': state.anonymousId } : {}),
      ...(webIdentity ? { 'X-Scout-Session-Id': webIdentity.session_id } : {}),
    };
  },
  track(event, properties = {}, webId) {
    if (!allowed()) { analytics.account(currentUser, session); return Promise.resolve(false); }
    if (state && state.linked !== accountLinked()) analytics.account(currentUser, session);
    if (!state) return Promise.resolve(false);
    const current = generation;
    return (async () => {
      await ready;
      if (current !== generation || !allowed() || !state) return false;
      if (webId && accountLinked() && webId !== state.anonymousId) return false;
      const anonymousId = webId || state.anonymousId, active = session;
      const token = active ? await active.getToken() : null;
      // A sign-out/account switch while fetching a token must not merge users.
      if (current !== generation || !allowed() || active && !token) return false;
      const headers = analytics.headers();
      if (current !== generation || !allowed()) return false;
      if (properties.session_id) headers['X-Scout-Session-Id'] = properties.session_id;
      // One event identity across both attempts lets the receiver deduplicate
      // an accepted request whose response was lost. Never retry a refusal.
      const body = JSON.stringify({ event, event_id: crypto.randomUUID(), anonymousId, properties: properties.session_id ? properties : { ...properties, ...(headers['X-Scout-Session-Id'] ? { session_id: headers['X-Scout-Session-Id'] } : {}) } });
      for (let attempt = 0; attempt < 2; attempt++) {
        analytics.headers(); // Observe an unlink even before its storage event.
        if (current !== generation || !allowed()) return false;
        try {
          const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, 'X-Scout-Anonymous-Id': anonymousId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body, signal: AbortSignal.timeout(2000), keepalive: true, redirect: 'error',
          });
          if (response.ok) return true;
          if (response.status !== 429 && !(response.status >= 500 && response.status <= 599)) return false;
        } catch { /* Network failures (including timeout) get at most one retry. */ }
      }
      return false;
    })().catch(() => false);
  },
};

globalThis.addEventListener?.('storage', event => {
  if (event.key !== null && !['scout-analytics-opt-out', 'scout-analytics-content', 'scout-analytics-account-link'].includes(event.key)) return;
  usageChoice = contentChoice = linkChoice = undefined;
  analytics.account(currentUser, session);
  globalThis.dispatchEvent?.(new Event('scout-analytics-change'));
});
globalThis.addEventListener?.('error', event => { if (page !== 'connect' && event.error) analytics.exception(event.error); });
globalThis.addEventListener?.('unhandledrejection', event => { if (page !== 'connect') analytics.exception(event.reason); });
