import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export let clientVersion;
for (const path of ['../../../package.json', '../../../../package.json']) {
  try { const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')); if (pkg.name === 'openmerit') { clientVersion = pkg.version; break; } } catch {}
}
const frameFiles = Object.freeze(['cli.mjs', 'server.mjs', 'collect.mjs', 'repository-index.mjs', 'install.mjs', 'scout.mjs', 'config.mjs', 'runner.mjs', 'adapters.mjs', 'process.mjs', 'report.mjs', 'app.js']);
const applicationURLs = frameFiles.flatMap(file => ['terminal/src/', 'eval/src/'].map(dir => new URL(`../../${dir}${file}`, import.meta.url).href));
const diagnostics = new WeakMap();
export function scoutDiagnostic(error, trace, code) {
  if (error && typeof error === 'object' && ['scout_network_error', 'scout_http_error', 'scout_response_error', 'scout_timeout'].includes(code)) diagnostics.set(error, { operation: 'scout_recommend', code, ...(typeof trace === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trace) ? { trace_id: trace } : {}) });
}
export function safeFrames(error) {
  try {
    const stack = error?.stack;
    if (typeof stack !== 'string') return [];
    return stack.slice(0, 8000).split('\n').slice(1, 40).flatMap(line => {
      const match = line.match(/(?:\(|\s)(file:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
      if (!match || !applicationURLs.includes(match[1])) return [];
      const lineNumber = Number(match[2]), column = Number(match[3]);
      return lineNumber > 0 && lineNumber <= 1000000 && column > 0 && column <= 1000000 ? [{ filename: match[1].split('/').at(-1), lineno: lineNumber, colno: column }] : [];
    }).slice(0, 8);
  } catch { return []; }
}
export function errorProperties(error) {
  try { return { error_type: errorType(error), frames: safeFrames(error), ...(diagnostics.get(error) ?? {}) }; }
  catch { return { error_type: 'Error', frames: [] }; }
}
const environment = () => ({ ...(clientVersion ? { client_version: clientVersion } : {}), platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'unknown', runtime_major: Number(process.versions.node.split('.')[0]) });

const anonymousId = randomUUID();
export const telemetryEnabled = (defaultEnabled = false) => (process.env.OPENMERIT_TELEMETRY ? process.env.OPENMERIT_TELEMETRY === '1' : defaultEnabled) && process.env.DO_NOT_TRACK !== '1';
export const setupCorrelationEnabled = () => telemetryEnabled(true) && process.env.OPENMERIT_ANALYTICS_ACCOUNT !== 'off';
export const setupUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Scout setup defaults to analytics on; explicit privacy refusals must survive
// device approval and future agent sessions. Prompt content stays off.
export function setupHeaders(ids = {}, client = 'cli') {
  return {
    'X-Scout-Client': client,
    'X-Scout-Agent': ids.agent === 'pi' ? 'pi' : 'claude-code',
    ...(clientVersion ? { 'X-Scout-Client-Version': clientVersion } : {}),
    'X-Scout-Analytics-Content': 'off',
    ...(client === 'cli' ? { 'X-Scout-Analytics': telemetryEnabled(true) ? 'on' : 'off' } : !telemetryEnabled(true) ? { 'X-Scout-Analytics': 'off' } : {}),
    ...(process.env.OPENMERIT_ANALYTICS_ACCOUNT === 'off' || !telemetryEnabled(true) ? { 'X-Scout-Analytics-Account': 'off' } : {}),
    ...(setupCorrelationEnabled() && setupUUID(ids.setup_id) ? { 'X-Scout-Setup-Id': ids.setup_id } : {}),
    ...(setupCorrelationEnabled() && setupUUID(ids.installation_id) ? { 'X-Scout-Installation-Id': ids.installation_id } : {}),
  };
}
export function installationProperties(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  const enums = {
    stage: ['started', 'preflight', 'login', 'browser_open', 'configuration', 'verification', 'status', 'remove', 'completed'],
    outcome: ['started', 'ok', 'error', 'pending', 'denied', 'conflict', 'not_installed'],
    command: ['install', 'status', 'remove', 'login', 'logout', 'project', 'doctor', 'unknown'],
    agent: ['claude-code', 'pi'], scope: ['user', 'project'],
    rule_status: ['matches', 'missing', 'modified_or_unowned'],
    skill_status: ['matches', 'missing', 'modified_or_unowned'],
    server_status: ['matches', 'missing', 'modified_or_unowned'],
    connection: ['connected', 'failed', 'key_rejected', 'not_checked'],
    code: ['command_error', 'approval_pending', 'access_denied', 'install_conflict', 'openmerit_unreachable'],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (input[key] === undefined && !['stage', 'outcome'].includes(key)) continue;
    if (!values.includes(input[key])) return null;
    out[key] = input[key];
  }
  for (const key of ['setup_id', 'installation_id']) if (setupUUID(input[key])) out[key] = input[key];
  for (const key of ['applied', 'installed']) if (typeof input[key] === 'boolean') out[key] = input[key];
  return out;
}
export async function sendInstallationEvent(input) {
  if (!telemetryEnabled(true)) return;
  const properties = installationProperties(input);
  if (!properties) return;
  if (!setupCorrelationEnabled()) { delete properties.setup_id; delete properties.installation_id; }
  // One immutable envelope across a transient retry. A hard total deadline
  // bounds awaited milestones even if the transport ignores cancellation.
  const body = JSON.stringify({ event: 'scout_installation_step', event_id: randomUUID(), anonymousId, properties: { ...properties, ...environment() } });
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (let attempt = 0; attempt < 2 && !controller.signal.aborted && telemetryEnabled(true); attempt++) {
          try {
            const response = await fetch('https://openmerit.ai/scout/api/analytics', {
              method: 'POST', headers: { 'Content-Type': 'application/json', ...setupHeaders(properties) },
              body, signal: controller.signal, redirect: 'error',
            });
            await response.body?.cancel();
            if (response.ok || response.status !== 429 && response.status < 500) return;
          } catch { /* Only a bounded retry; never export error text. */ }
        }
      })(),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 1500); }),
    ]);
  } catch { /* Never affect setup, even if the transport ignores abort. */ }
  finally { clearTimeout(timer); }
}
export const errorType = error => ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
export function terminalProperties(event, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  const select = (key, values) => { if (!values.includes(input[key])) return false; out[key] = input[key]; return true; };
  if (event === 'terminal_error') {
    if (!select('code', ['collection_error', 'snapshot_error', 'render_error', 'uncaught_error']) || !select('error_type', ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'])) return null;
    if (Array.isArray(input.frames)) out.frames = input.frames.slice(0, 8).filter(f => f && frameFiles.includes(f.filename) && Number.isInteger(f.lineno) && f.lineno > 0 && f.lineno <= 1000000 && Number.isInteger(f.colno) && f.colno > 0 && f.colno <= 1000000).map(f => ({ filename: f.filename, lineno: f.lineno, colno: f.colno }));
    return out;
  }
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
  const body = JSON.stringify({ event, event_id: randomUUID(), anonymousId, properties: { ...properties, ...environment() } });
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => fetch('https://openmerit.ai/scout/api/analytics', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'cli', 'X-Scout-Analytics': 'on', ...(process.env.OPENMERIT_ANALYTICS_ACCOUNT === 'off' ? { 'X-Scout-Analytics-Account': 'off' } : {}) },
        body, signal: controller.signal, redirect: 'error',
      })).then(response => response.body?.cancel()),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 750); timer.unref(); }),
    ]);
  } catch { /* Never affect product behavior. */ }
  finally { clearTimeout(timer); }
}

// Consent is independent of terminal discovery. Command identity is ephemeral;
// the installer separately manages the owned installation's correlation IDs.
export function commandTelemetry(args) {
  const setup = ['install', 'status', 'remove', 'login', 'logout', 'project', 'doctor'];
  const enabled = () => telemetryEnabled(setup.includes(args[0]));
  if (!enabled()) return async () => {};
  const started = performance.now();
  const command_id = randomUUID();
  const actions = ['init', 'doctor', 'plan', 'run', 'watch', 'report'];
  const command = !args.length || args.includes('--help') || args.includes('-h') || args[0] === 'eval' && args.length === 1
    ? 'help' : args[0] === 'dash' ? 'dash' : setup.includes(args[0]) ? args[0] : args[0] === 'eval' && actions.includes(args[1]) ? `eval_${args[1]}` : 'unknown';
  async function send(event, properties) {
    if (!enabled()) return;
    const controller = new AbortController();
    const body = JSON.stringify({ event, event_id: randomUUID(), anonymousId, properties: { ...properties, ...environment(), command_id } });
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => fetch('https://openmerit.ai/scout/api/analytics', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Client': 'cli', 'X-Scout-Analytics': 'on', ...(process.env.OPENMERIT_ANALYTICS_ACCOUNT === 'off' ? { 'X-Scout-Analytics-Account': 'off' } : {}) },
          body,
          signal: controller.signal, redirect: 'error',
        })).then(response => response.body?.cancel()),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 750); }),
      ]);
    } catch { /* Analytics must never affect command behavior. */ }
    finally { clearTimeout(timer); }
  }
  const pending = send('cli_command_started', { command });
  let completed = false;
  // code: a content-free setup outcome such as approval_pending; never a message.
  return async (outcome, error, code) => {
    if (completed) return;
    completed = true;
    await Promise.all([pending, send('cli_command_completed', {
      command, outcome: outcome === 'ok' ? 'ok' : 'error',
      ...(outcome === 'ok' ? {} : { code: code ?? 'command_error', ...(error ? errorProperties(error) : {}) }),
      duration_ms: Math.min(86400000, Math.max(0, Math.round(performance.now() - started))),
    })]);
  };
}
