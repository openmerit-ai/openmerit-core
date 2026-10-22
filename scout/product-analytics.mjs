import { json, readJSON } from './http.mjs';

const hosts = new Set(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
const environments = ['production', 'development', 'test'];
const choice = values => value => values.includes(value) ? value : undefined;
const integer = (min, max) => value => Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const duration = integer(0, 86_400_000);
const counts = { task_count: integer(0, 3), candidate_count: integer(0, 15) };
const position = { rank: integer(1, 5), task_index: integer(1, 3) };
const command = choice(['help', 'dash', 'eval_init', 'eval_doctor', 'eval_plan', 'eval_run', 'eval_watch', 'eval_report', 'unknown']);
const clientEvents = {
  scout_visited: {},
  scout_sign_in_opened: {},
  scout_signed_in: {},
  scout_results_viewed: { ...counts, duration_ms: duration },
  scout_evidence_opened: position,
  scout_model_id_copied: position,
  scout_provider_opened: position,
  scout_client_error: { code: choice(['auth_unavailable', 'search_timeout', 'network_error', 'http_error', 'invalid_response', 'render_error']), http_status: integer(400, 599) },
  cli_command_started: { command },
  cli_command_completed: { command, outcome: choice(['ok', 'error']), duration_ms: duration },
};
const schemas = {
  ...clientEvents,
  scout_search_completed: {
    ...counts, duration_ms: duration, cache: choice(['miss', 'hit', 'shared', 'unknown']),
    outcome: choice(['ok', 'empty', 'unsupported', 'clarification', 'rate_limited', 'interpretation_error', 'selection_error', 'internal_error']),
  },
  scout_request_completed: { route: choice(['recommend', 'mcp']), http_status: integer(100, 599), duration_ms: duration, outcome: choice(['ok', 'error']) },
};
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
const milliseconds = value => Math.max(0, Math.min(86_400_000, Math.round(value)));
const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export function productAnalyticsEnabled(env) {
  // Require both region and environment; never guess where to send user events.
  return typeof env.POSTHOG_PROJECT_TOKEN === 'string' && env.POSTHOG_PROJECT_TOKEN.startsWith('phc_') &&
    hosts.has(env.POSTHOG_HOST) && environments.includes(env.POSTHOG_ENVIRONMENT);
}

async function accountId(userId) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`openmerit:posthog:${userId}`));
  return `account:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}

// Request-local identity only: never attach an account to the shared recommender
// or to the separate Cloudflare prompt/evidence observer.
export function createProductAnalytics(request, env, ctx = {}) {
  const enabled = productAnalyticsEnabled(env) && request.headers.get('dnt') !== '1' &&
    request.headers.get('sec-gpc') !== '1' && request.headers.get('x-scout-analytics') !== 'off';
  const path = new URL(request.url).pathname, started = performance.now();
  const client = choice(['web', 'cli', 'agent'])(request.headers.get('x-scout-client')) ?? 'unknown';
  const anonymousId = uuid(request.headers.get('x-scout-anonymous-id')) ?? crypto.randomUUID();
  let userId;

  function background(promise) {
    const safe = promise.catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(safe);
  }
  function capture(event, properties = {}, options = {}) {
    if (!enabled || !Object.hasOwn(schemas, event)) return;
    const safe = {};
    // Only typed, bounded values can cross this boundary, including for errors.
    for (const [key, validate] of Object.entries(schemas[event])) {
      const value = validate(properties[key]); if (value !== undefined) safe[key] = value;
    }
    const identity = userId, anon = options.anonymousId ?? anonymousId;
    const timestamp = new Date().toISOString();
    background((async () => {
      const distinctId = identity ? await accountId(identity) : `anonymous:${anon}`;
      const common = {
        distinct_id: distinctId, $process_person_profile: !!identity, $geoip_disable: true, $ip: null,
        product: event.startsWith('cli_') ? 'openmerit' : 'scout', environment: env.POSTHOG_ENVIRONMENT,
        client: options.client ?? client, transport: path === '/scout/mcp' ? 'mcp' : 'http',
      };
      const batch = [{ event, uuid: crypto.randomUUID(), timestamp, properties: { ...common, ...safe } }];
      if (event === 'scout_signed_in' && identity) batch.unshift({
        event: '$identify', uuid: crypto.randomUUID(), timestamp,
        properties: { ...common, $anon_distinct_id: `anonymous:${anon}` },
      });
      // Capture API only: no browser SDK, remote flags, autocapture, replay,
      // exception stacks, request metadata, retries or visitor-IP forwarding.
      const response = await fetch(`${env.POSTHOG_HOST}/batch/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_TOKEN, batch }),
        // Workers rejects "error"; "manual" also prevents forwarding this body.
        signal: AbortSignal.timeout(1500), redirect: 'manual',
      });
      await response.body?.cancel();
    })());
  }

  return {
    identify(id) { userId = id; },
    observeSearch({ result, outcome, durationMs }) {
      const tasks = result?.tasks ?? (result ? [{ slots: [result] }] : []);
      capture('scout_search_completed', {
        outcome, duration_ms: milliseconds(durationMs), task_count: tasks.length,
        candidate_count: tasks.reduce((n, task) => n + task.slots.reduce((n, slot) => n + slot.recommendations.length, 0), 0),
        cache: result?.runtime?.cache ?? 'unknown',
      });
    },
    complete(response) {
      if (!enabled || !['/scout/api/recommend', '/scout/mcp'].includes(path)) return;
      const duration_ms = milliseconds(performance.now() - started);
      background((async () => {
        // MCP tool/protocol failures can have HTTP 200. Inspect the outcome, but
        // never copy its body, error message or JSON-RPC ID into an event.
        const body = path === '/scout/mcp' ? await response.clone().json().catch(() => null) : null;
        capture('scout_request_completed', {
          route: path === '/scout/mcp' ? 'mcp' : 'recommend', http_status: response.status, duration_ms,
          outcome: response.ok && !body?.error && !body?.result?.isError ? 'ok' : 'error',
        });
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
      if (body.event === 'scout_signed_in' && !userId) return json({ error: 'Sign in to identify an analytics account.' }, 401);
      capture(body.event, body.properties, { anonymousId: uuid(body.anonymousId), client: body.event.startsWith('cli_') ? 'cli' : 'web' });
      return noContent();
    },
  };
}
