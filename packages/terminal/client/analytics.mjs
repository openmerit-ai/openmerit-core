// Only the local relay is reachable. No identity or project data enters the browser payload.
export function createAnalytics({ enabled, mode, navigator = globalThis.navigator, storage, fetcher = globalThis.fetch }) {
  let start = 0, count = 0, active = 0;
  return (event, properties = {}) => {
    try {
      if (!enabled() || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true || (storage ?? globalThis.localStorage).getItem('scout-analytics-opt-out') === '1') return;
      if (Date.now() - start >= 60000) { start = Date.now(); count = 0; }
      if (count >= 60 || active >= 2) return;
      count++; active++;
      let timer;
      void Promise.race([Promise.resolve().then(() => fetcher('/api/analytics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, properties: event === 'terminal_error' ? properties : { ...properties, mode: mode() } }),
        signal: AbortSignal.timeout(1000), credentials: 'same-origin', redirect: 'error',
      })), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]).catch(() => {}).finally(() => { clearTimeout(timer); active--; });
    } catch { /* Storage and transport failures never affect the UI. */ }
  };
}
export const browserErrorType = error => ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
