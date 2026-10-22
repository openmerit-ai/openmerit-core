import { randomUUID } from 'node:crypto';

const anonymousId = randomUUID();
export const telemetryEnabled = () => process.env.OPENMERIT_TELEMETRY === '1' && process.env.DO_NOT_TRACK !== '1';
export const errorType = error => ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
export function terminalProperties(event, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  const select = (key, values) => { if (!values.includes(input[key])) return false; out[key] = input[key]; return true; };
  if (event === 'terminal_error') return select('code', ['collection_error', 'snapshot_error', 'render_error', 'uncaught_error']) && select('error_type', ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError']) ? out : null;
  if (!select('mode', ['sample', 'live'])) return null;
  if (event === 'terminal_visited') return out;
  if (event === 'terminal_page_viewed') return select('page', ['overview', 'models', 'services', 'activity', 'compute', 'sources', 'connections']) ? out : null;
  if (event === 'terminal_interaction') return select('action', ['inspect', 'filter', 'search', 'map_expand', 'mode', 'command']) && select('kind', ['model', 'agent', 'task', 'service', 'source', 'host', 'deployment', 'pool', 'record', 'path', 'other']) ? out : null;
  if (event !== 'terminal_snapshot') return null;
  for (const key of ['model_count', 'record_count', 'source_count', 'host_count', 'deployment_count', 'agent_count']) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 1000000000) return null;
    out[key] = input[key];
  }
  return out;
}
// Shared, process-wide budget; no queue and at most four in-flight requests.
let windowStart = 0, count = 0, active = 0;
export function sendTerminalEvent(event, input) {
  if (!telemetryEnabled()) return;
  const properties = terminalProperties(event, input);
  if (!properties) return;
  if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); count = 0; }
  if (count >= 60 || active >= 4) return;
  count++; active++;
  void sendAnalytics(event, properties).finally(() => active--);
}
async function sendAnalytics(event, properties) {
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => fetch('https://openmerit.ai/scout/api/analytics', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'cli', 'X-Scout-Analytics': 'on' },
        body: JSON.stringify({ event, anonymousId, properties }), signal: controller.signal, redirect: 'error',
      })).then(response => response.body?.cancel()),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 750); timer.unref(); }),
    ]);
  } catch { /* Never affect product behavior. */ }
  finally { clearTimeout(timer); }
}

// Consent is independent of terminal discovery. Never persist an identity.
export function commandTelemetry(args) {
  if (process.env.OPENMERIT_TELEMETRY !== '1' || process.env.DO_NOT_TRACK === '1') return async () => {};
  const started = performance.now();
  const actions = ['init', 'doctor', 'plan', 'run', 'watch', 'report'];
  const command = !args.length || args.includes('--help') || args.includes('-h') || args[0] === 'eval' && args.length === 1
    ? 'help' : args[0] === 'dash' ? 'dash' : args[0] === 'eval' && actions.includes(args[1]) ? `eval_${args[1]}` : 'unknown';
  async function send(event, properties) {
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => fetch('https://openmerit.ai/scout/api/analytics', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'cli', 'X-Scout-Analytics': 'on' },
          body: JSON.stringify({ event, anonymousId, properties }),
          signal: controller.signal, redirect: 'error',
        })).then(response => response.body?.cancel()),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 750); }),
      ]);
    } catch { /* Analytics must never affect command behavior. */ }
    finally { clearTimeout(timer); }
  }
  const pending = send('cli_command_started', { command });
  return async outcome => {
    await Promise.all([pending, send('cli_command_completed', {
      command, outcome: outcome === 'ok' ? 'ok' : 'error',
      duration_ms: Math.min(86400000, Math.max(0, Math.round(performance.now() - started))),
    })]);
  };
}
