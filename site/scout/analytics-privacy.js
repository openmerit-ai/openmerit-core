// Shared by browser and ingestion: no raw exception message, source context,
// function name, URL, or absolute path crosses either telemetry boundary.
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError']);
const files = new Set(['scout.js', 'auth.js', 'analytics.js', 'worker.mjs', 'alpha-worker.mjs', 'worker.js', 'alpha-worker.js', 'recommend.mjs', 'matching.mjs', 'interpreter.mjs', 'product-analytics.mjs', 'store.mjs', 'http.mjs', 'mcp.mjs']);
export const errorType = value => types.has(value) ? value : 'Error';
export function exceptionFrames(stack) {
  if (typeof stack !== 'string') return [];
  return stack.slice(0, 8000).split('\n').slice(1, 21).flatMap(line => {
    const match = line.match(/(?:^|[/\\\s(])([a-z-]+\.(?:mjs|js)):(\d{1,7}):(\d{1,7})\)?\s*$/);
    return match && files.has(match[1]) ? [{ filename: match[1], lineno: Number(match[2]), colno: Number(match[3]) }] : [];
  });
}
export function safeFrames(value) {
  return Array.isArray(value) ? value.slice(0, 20).flatMap(frame => files.has(frame?.filename) && Number.isInteger(frame.lineno) && frame.lineno > 0 && frame.lineno < 10000000 && Number.isInteger(frame.colno) && frame.colno >= 0 && frame.colno < 10000000
    ? [{ platform: 'custom', lang: 'javascript', function: '<redacted>', filename: frame.filename, lineno: frame.lineno, colno: frame.colno, in_app: true }] : []) : [];
}

// Best-effort redaction is not a confidentiality guarantee. Content capture is
// separately opt-in; arbitrary names or proprietary prose cannot be detected.
export function redactContent(value, max = 4000) {
  if (typeof value !== 'string') return null;
  return value.slice(0, 16000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[AUTHORIZATION]')
    .replace(/\b(?:sk[-_]|pk_live_|ph[cpx]_|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{8,}/g, '[TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]')
    .replace(/\b(?:[a-z_-]*(?:api[_-]?key|secret|password|token)|authorization|cookie)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '[CREDENTIAL]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g, '[PHONE]')
    .replace(/(?:\/(?:Users|home|private|tmp)\/|[A-Z]:\\)[^\s"'<>]+/gi, '[PATH]')
    .slice(0, max);
}
