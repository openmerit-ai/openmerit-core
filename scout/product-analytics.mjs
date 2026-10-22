import { json, readJSON } from './http.mjs';
import { searchEvents } from './search-analytics.mjs';
import { errorType, exceptionFrames, safeFrames } from '../site/scout/analytics-privacy.js';

const hosts = new Set(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
const environments = ['production', 'development', 'test'];
const choice = values => value => values.includes(value) ? value : undefined;
const integer = (min, max) => value => Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const duration = integer(0, 86_400_000);
const counts = { task_count: integer(0, 3), candidate_count: integer(0, 15) };
const position = { rank: integer(1, 5), task_index: integer(1, 3) };
const command = choice(['help', 'dash', 'eval_init', 'eval_doctor', 'eval_plan', 'eval_run', 'eval_watch', 'eval_report', 'unknown']);
const mode = choice(['sample', 'live']), page = choice(['home', 'docs']);
const agent = choice(['claude-code', 'cursor', 'codex', 'amp', 'opencode', 't3-code', 'other', 'unknown']);
const mcpMethod = choice(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled']);
const exception = { error_type: errorType, frames: safeFrames };
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,30})?$/.test(value) ? value : undefined;
const clientEvents = {
  scout_visited: {},
  scout_sign_in_opened: {},
  scout_example_selected: { example: choice(['invoice-extraction', 'support-workflow', 'feedback-workflow']) },
  scout_session_observed: { auth_provider: choice(['google', 'github', 'unknown']) },
  scout_agent_setup_opened: { source: choice(['button', 'navigation', 'disclosure', 'deep_link']) },
  scout_agent_selected: { agent },
  scout_agent_setup_copied: { agent, artifact: choice(['mcp_url', 'api_request']), outcome: choice(['ok', 'error']) },
  scout_agent_docs_opened: { agent },
  scout_results_viewed: { ...counts, duration_ms: duration },
  scout_evidence_opened: position,
  scout_model_id_copied: position,
  scout_provider_opened: position,
  scout_client_error: { code: choice(['auth_unavailable', 'search_timeout', 'network_error', 'http_error', 'invalid_response', 'render_error', 'uncaught_error']), http_status: integer(400, 599), ...exception },
  cli_command_started: { command },
  cli_command_completed: { command, outcome: choice(['ok', 'error']), duration_ms: duration, error_type: errorType },
  terminal_visited: { mode },
  terminal_page_viewed: { mode, page: choice(['overview', 'models', 'services', 'activity', 'compute', 'sources', 'connections']) },
  terminal_interaction: { mode, action: choice(['inspect', 'filter', 'search', 'map_expand', 'mode', 'command']), kind: choice(['model', 'agent', 'task', 'service', 'source', 'host', 'deployment', 'pool', 'record', 'path', 'other']) },
  terminal_snapshot: { mode, ...Object.fromEntries(['model_count', 'record_count', 'source_count', 'host_count', 'deployment_count', 'agent_count'].map(k => [k, integer(0, 1000000000)])) },
  terminal_error: { code: choice(['collection_error', 'snapshot_error', 'render_error', 'uncaught_error']), error_type: errorType },
  website_visited: { page },
  website_link_opened: { page, destination: choice(['scout', 'docs', 'terminal', 'github', 'other']) },
  website_error: { page, code: choice(['uncaught_error']), error_type: errorType },
};
const schemas = {
  ...clientEvents,
  scout_search_completed: {
    ...counts, duration_ms: duration, cache: choice(['miss', 'hit', 'shared', 'unknown']),
    outcome: choice(['ok', 'empty', 'unsupported', 'clarification', 'rate_limited', 'interpretation_error', 'selection_error', 'internal_error']),
  },
  scout_request_completed: { route: choice(['recommend', 'mcp']), mcp_method: mcpMethod, http_status: integer(100, 599), duration_ms: duration, outcome: choice(['ok', 'error']) },
  scout_agent_connected: { reported_agent: agent },
  scout_server_error: { code: choice(['catalogue_error', 'interpretation_error', 'selection_error', 'internal_error']), ...exception },
};
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
const milliseconds = value => Math.max(0, Math.min(86_400_000, Math.round(value)));
const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export function productAnalyticsEnabled(env) {
  // Require both region and environment; never guess where to send user events.
  return typeof env.POSTHOG_PROJECT_TOKEN === 'string' && env.POSTHOG_PROJECT_TOKEN.startsWith('phc_') &&
    hosts.has(env.POSTHOG_HOST) && environments.includes(env.POSTHOG_ENVIRONMENT);
}

export function accountSyncEnabled(env) {
  // Do not export personal data before both authenticated delivery and erasure
  // are configured. The capture token alone cannot delete a PostHog person.
  return productAnalyticsEnabled(env) && !!env.SCOUT_ACCOUNTS && !!env.CLERK_SECRET_KEY &&
    !!env.CLERK_WEBHOOK_SIGNING_SECRET && !!env.POSTHOG_PERSONAL_API_KEY && /^\d+$/.test(env.POSTHOG_PROJECT_ID ?? '');
}

export async function accountId(userId) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`openmerit:posthog:${userId}`));
  return `account:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function accountAnalytics(env, userId) {
  return env.SCOUT_ACCOUNTS.get(env.SCOUT_ACCOUNTS.idFromName(await accountId(userId)));
}

export async function sendProductBatch(env, batch) {
  if (!batch.length) return;
  const response = await fetch(`${env.POSTHOG_HOST}/batch/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_TOKEN, batch }),
    // Workers rejects "error"; "manual" also prevents forwarding this body.
    signal: AbortSignal.timeout(1500), redirect: 'manual',
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Analytics delivery unavailable.');
}

// Request-local identity only: never attach an account or trace to a shared
// computation/cache. Search and interaction events now share this destination.
export function createProductAnalytics(request, env, ctx = {}) {
  const url = new URL(request.url);
  const enabled = productAnalyticsEnabled(env) && request.headers.get('dnt') !== '1' &&
    request.headers.get('sec-gpc') !== '1' && request.headers.get('x-scout-analytics') !== 'off' && url.searchParams.get('analytics') !== 'off';
  const path = url.pathname, started = performance.now();
  const observedAt = Date.now();
  // Setup URLs carry only a public agent category, never an account or token.
  // These caller hints are attribution, not authentication or proof of installation.
  const selectedAgent = agent(request.headers.get('x-scout-agent') ?? url.searchParams.get('agent')) ?? 'unknown';
  const client = choice(['web', 'cli', 'agent'])(request.headers.get('x-scout-client')) ?? (selectedAgent !== 'unknown' ? 'agent' : 'unknown');
  const anonymousId = uuid(request.headers.get('x-scout-anonymous-id')) ?? crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const contentAllowed = env.POSTHOG_CAPTURE_CONTENT === 'true' && accountSyncEnabled(env) && request.headers.get('x-scout-analytics-content') === 'on';
  let userId, method, reportedAgent = 'unknown';

  function background(promise) {
    const safe = promise.catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(safe);
  }
  function capture(event, properties = {}, options = {}) {
    if (!enabled || !Object.hasOwn(schemas, event)) return;
    const safe = {};
    // Only typed, bounded values can cross this boundary, including for errors.
    for (const [key, validate] of Object.entries({ ...schemas[event], trace_id: uuid, client_version: version,
      platform: choice(['darwin', 'linux', 'win32', 'unknown']), runtime_major: integer(22, 100) })) {
      const value = validate(properties[key]); if (value !== undefined) safe[key] = value;
    }
    if (!safe.trace_id) delete safe.trace_id;
    const identity = userId, anon = options.anonymousId ?? anonymousId;
    const timestamp = new Date().toISOString();
    background((async () => {
      const distinctId = identity ? await accountId(identity) : `anonymous:${anon}`;
      const common = {
        distinct_id: distinctId, $process_person_profile: !!identity, $geoip_disable: true, $ip: null,
        product: event.startsWith('cli_') || event.startsWith('terminal_') ? 'openmerit' : event.startsWith('website_') ? 'website' : 'scout', environment: env.POSTHOG_ENVIRONMENT,
        client: options.client ?? client, transport: path === '/scout/mcp' ? 'mcp' : 'http',
        agent: selectedAgent,
        request_id: traceId, trace_id: safe.trace_id ?? traceId, $session_id: anon,
        analytics_version: 3,
        ...(safe.trace_id || ['/scout/api/recommend', '/scout/mcp'].includes(path) ? { $ai_trace_id: safe.trace_id ?? traceId } : {}),
        ...(env.CF_VERSION_METADATA?.id ? { release: env.CF_VERSION_METADATA.id } : {}),
      };
      const batch = [{ event, uuid: crypto.randomUUID(), timestamp, properties: { ...common, ...safe } }];
      for (const entry of options.entries ?? []) batch.push({ ...entry, uuid: crypto.randomUUID(), timestamp,
        properties: { ...common, ...entry.properties, $ai_trace_id: traceId } });
      if (['scout_client_error', 'scout_server_error', 'terminal_error', 'website_error'].includes(event) || event === 'cli_command_completed' && safe.outcome === 'error') {
        const code = safe.code ?? (event === 'cli_command_completed' ? 'command_error' : 'unknown_error');
        batch.push({ event: '$exception', uuid: crypto.randomUUID(), timestamp, properties: { ...common,
          $exception_level: 'error', $exception_list: [{ type: safe.error_type ?? 'Error', value: code,
            mechanism: { handled: code !== 'uncaught_error', synthetic: !safe.frames?.length },
            stacktrace: { type: 'raw', frames: safe.frames ?? [] } }],
          ...(safe.command ? { command: safe.command } : {}), code,
        } });
      }
      if (event === 'scout_session_observed' && identity) batch.unshift({
        event: '$identify', uuid: crypto.randomUUID(), timestamp,
        properties: { ...common, $anon_distinct_id: `anonymous:${anon}` },
      });
      // Capture API only: no SDK/autocapture/replay, arbitrary metadata or IPs.
      // All expanded events retain account preference and deletion enforcement.
      if (identity && env.SCOUT_ACCOUNTS) await (await accountAnalytics(env, identity)).capture(batch);
      else await sendProductBatch(env, batch);
    })());
  }

  return {
    observeMCP(value, clientName) {
      method = mcpMethod(value);
      // Never retain arbitrary client names/versions; some contain local paths.
      reportedAgent = agent(clientName) ?? 'unknown';
    },
    identify(id) {
      userId = id;
      // An opted-out authenticated API/MCP call also stops background sync.
      if (!enabled && env.SCOUT_ACCOUNTS) background((async () => {
        await (await accountAnalytics(env, id)).preference(id, false, observedAt);
      })());
    },
    async handlePreference() {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
      if (!userId) return json({ error: 'Sign in to update analytics preferences.' }, 401);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
      let body;
      try { body = await readJSON(request); } catch { return json({ error: 'Invalid preference.' }, 400); }
      if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).length !== 1) return json({ error: 'Invalid preference.' }, 400);
      if (!env.SCOUT_ACCOUNTS) return noContent();
      try {
        await (await accountAnalytics(env, userId)).preference(userId, enabled && body.enabled, observedAt);
        return noContent();
      } catch { return json({ error: 'Analytics preferences temporarily unavailable.' }, 503); }
    },
    observeSearch(event) {
      if (!enabled) return;
      const { result, outcome, durationMs, error } = event;
      const tasks = result?.tasks ?? (result ? [{ slots: [result] }] : []);
      capture('scout_search_completed', {
        outcome, duration_ms: milliseconds(durationMs), task_count: tasks.length,
        candidate_count: tasks.reduce((n, task) => n + task.slots.reduce((n, slot) => n + slot.recommendations.length, 0), 0),
        cache: result?.runtime?.cache ?? 'unknown',
      }, { entries: searchEvents(event, contentAllowed) });
      if (error && ['interpretation_error', 'selection_error', 'internal_error'].includes(outcome)) {
        capture('scout_server_error', { code: outcome, error_type: errorType(error.name), frames: exceptionFrames(error.stack) });
      }
    },
    exception(error, code = 'catalogue_error') {
      capture('scout_server_error', { code, error_type: errorType(error?.name), frames: exceptionFrames(error?.stack) });
    },
    response(response) {
      const headers = new Headers(response.headers);
      headers.set('X-Scout-Trace-Id', traceId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    complete(response) {
      if (!enabled || !['/scout/api/recommend', '/scout/mcp'].includes(path)) return;
      const duration_ms = milliseconds(performance.now() - started);
      background((async () => {
        // MCP tool/protocol failures can have HTTP 200. Inspect the outcome, but
        // never copy its body, error message or JSON-RPC ID into an event.
        const body = path === '/scout/mcp' ? await response.clone().json().catch(() => null) : null;
        const ok = response.ok && !body?.error && !body?.result?.isError;
        capture('scout_request_completed', {
          route: path === '/scout/mcp' ? 'mcp' : 'recommend', http_status: response.status, duration_ms,
          ...(method ? { mcp_method: method } : {}), outcome: ok ? 'ok' : 'error',
        });
        if (userId && method === 'initialize' && ok && body?.result?.protocolVersion) {
          capture('scout_agent_connected', { reported_agent: reportedAgent });
        }
      })());
    },
    async handleEvent() {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
      if (!enabled) return noContent();
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
      let body;
      try { body = await readJSON(request); } catch { return json({ error: 'Invalid analytics event.' }, 400); }
      if (!body || typeof body.event !== 'string' || !Object.hasOwn(clientEvents, body.event) || !uuid(body.anonymousId) ||
          !body.properties || typeof body.properties !== 'object' || Array.isArray(body.properties)) return json({ error: 'Invalid analytics event.' }, 400);
      if (body.event === 'scout_session_observed' && !userId) return json({ error: 'Sign in to identify an analytics account.' }, 401);
      capture(body.event, body.properties, { anonymousId: uuid(body.anonymousId), client: body.event.startsWith('cli_') || body.event.startsWith('terminal_') ? 'cli' : 'web' });
      return noContent();
    },
  };
}
