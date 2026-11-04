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
const browserErrorType = error => ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
export function browserErrorProperties(error) {
  try {
    const stack = error?.stack;
    const frames = (typeof stack === 'string' ? stack.slice(0, 8000) : '').split('\n').slice(1, 40).flatMap(line => {
      const match = line.match(/(?:\(|\s|@)(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
      if (!match || match[1] !== new URL('/app.js', globalThis.location.href).href) return [];
      const lineNumber = Number(match[2]), column = Number(match[3]);
      return lineNumber > 0 && lineNumber <= 1000000 && column > 0 && column <= 1000000 ? [{ filename: 'app.js', lineno: lineNumber, colno: column }] : [];
    }).slice(0, 8);
    return { error_type: browserErrorType(error), frames };
  } catch { return { error_type: 'Error', frames: [] }; }
}
