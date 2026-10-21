const endpoint = new URL('./api/analytics', import.meta.url).pathname;
const storageKey = 'scout-product-analytics';
let enabled = false, state, session, currentUser, generation = 0, visited = false, ready = Promise.resolve();
const fresh = () => ({ anonymousId: crypto.randomUUID(), user: null, session: null });
function allowed() {
  if (!enabled || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return false;
  try { return localStorage.getItem('scout-analytics-opt-out') !== '1'; } catch { return true; }
}
function save() {
  try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Optional tab storage. */ }
}
async function hash(value) {
  if (!value) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const analytics = {
  configure(value) {
    enabled = value === true; currentUser = undefined; generation++;
    if (!allowed()) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey));
      if (/^[0-9a-f-]{36}$/.test(saved?.anonymousId) && [saved.user, saved.session].every(v => v === null || /^[0-9a-f]{64}$/.test(v))) state = saved;
    } catch { /* Disabled or invalid storage does not affect Scout. */ }
    state ??= fresh();
  },
  account(userId, activeSession) {
    const unchanged = currentUser === userId && session?.id === activeSession?.id;
    currentUser = userId; session = activeSession;
    if (!allowed()) {
      generation++; state = undefined;
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional tab storage. */ }
      return;
    }
    if (unchanged && state) return;
    const current = ++generation;
    state ??= fresh();
    ready = (async () => {
      const [user, sessionId] = await Promise.all([hash(userId), hash(activeSession?.id)]);
      if (current !== generation) return;
      if (state.user && state.user !== user) state = fresh();
      const signedIn = !!user && state.session !== sessionId;
      state.user = user; state.session = sessionId; save();
      if (!visited) { visited = true; analytics.track('scout_visited'); }
      if (signedIn) analytics.track('scout_signed_in');
    })().catch(() => {});
  },
  headers() {
    return {
      'X-Scout-Client': 'web', 'X-Scout-Analytics': allowed() ? 'on' : 'off',
      ...(allowed() && state ? { 'X-Scout-Anonymous-Id': state.anonymousId } : {}),
    };
  },
  track(event, properties = {}) {
    if (!allowed() || !state) return;
    const current = generation;
    void (async () => {
      await ready;
      if (current !== generation || !allowed()) return;
      const anonymousId = state.anonymousId, active = session;
      const token = active ? await active.getToken() : null;
      // A sign-out/account switch while fetching a token must not merge users.
      if (current !== generation || !allowed() || active && !token) return;
      await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...analytics.headers(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ event, anonymousId, properties }),
        signal: AbortSignal.timeout(2000), keepalive: true, redirect: 'error',
      });
    })().catch(() => {});
  },
};
