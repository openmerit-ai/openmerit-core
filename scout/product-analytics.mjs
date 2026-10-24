import { json, readJSON } from './http.mjs';
import { searchEvents, failureCodes } from './search-analytics.mjs';
import { errorType, exceptionFrames, safeFrames } from '../site/scout/analytics-privacy.js';
import { timingStages } from './timing.mjs';
import { webEvents, validateWebProperties } from '../site/scout/web-analytics.js';

const hosts = new Set(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
const environments = ['production', 'development', 'test'];
const choice = values => value => values.includes(value) ? value : undefined;
const integer = (min, max) => value => Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const duration = integer(0, 86_400_000);
const counts = { task_count: integer(0, 3), candidate_count: integer(0, 15) };
const position = { rank: integer(1, 5), task_index: integer(1, 3) };
const command = choice(['help', 'dash', 'install', 'status', 'remove', 'login', 'logout', 'project', 'doctor', 'eval_init', 'eval_doctor', 'eval_plan', 'eval_run', 'eval_watch', 'eval_report', 'unknown']);
const mode = choice(['sample', 'live']), page = choice(['home', 'docs']);
const exception = { error_type: errorType, frames: safeFrames };
const failure = { failure_stage: choice([...timingStages, 'matching']), failure_code: value => failureCodes.has(value) ? value : undefined, provider_status: integer(100, 599) };
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,30})?$/.test(value) ? value : undefined;
const agent = choice(['claude-code', 'openmerit-cli', 'unknown']);
const setup = { agent, scope: choice(['user', 'project']), outcome: choice(['started', 'ok', 'error', 'pending', 'denied', 'conflict', 'not_installed']) };
const component = choice(['matches', 'missing', 'modified_or_unowned']);
const mcp = { mcp_method: choice(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled', 'other']),
  mcp_tool: choice(['scout_models', 'other']), harness: agent, harness_version: version,
  protocol_error: choice([-32700, -32600, -32601, -32602, -32603]), tool_error: value => typeof value === 'boolean' ? value : undefined };
const clientEvents = {
  ...Object.fromEntries(webEvents.map(event => [event, {}])),
  scout_visited: {},
  scout_sign_in_opened: {},
  scout_example_selected: { example: choice(['invoice-extraction', 'support-workflow', 'feedback-workflow']) },
  scout_session_observed: { auth_provider: choice(['google', 'github', 'unknown']) },
  scout_results_viewed: { ...counts, duration_ms: duration },
  scout_evidence_opened: position,
  scout_model_id_copied: position,
  scout_agent_setup_started: { agent },
  scout_agent_setup_copied: { agent, outcome: choice(['ok', 'error']), code: choice(['clipboard_error']) },
  scout_agent_launch_requested: { agent, outcome: choice(['ok', 'error']), code: choice(['launch_error']) },
  scout_connect_client_error: { stage: choice(['auth', 'load', 'approve', 'deny', 'poll', 'devices', 'revoke']), code: choice(['auth_unavailable', 'network_error', 'http_error', 'approval_timeout', 'uncaught_error']), http_status: integer(400, 599), ...exception },
  scout_installation_step: { ...setup, command, stage: choice(['started', 'preflight', 'login', 'browser_open', 'configuration', 'verification', 'status', 'remove', 'completed']),
    applied: value => typeof value === 'boolean' ? value : undefined, installed: value => typeof value === 'boolean' ? value : undefined,
    rule_status: component, skill_status: component, server_status: component,
    connection: choice(['connected', 'failed', 'key_rejected', 'not_checked']),
    code: choice(['command_error', 'approval_pending', 'access_denied', 'install_conflict', 'openmerit_unreachable']), ...exception },
  scout_provider_opened: position,
  scout_recommendation_feedback: { rating: choice(['useful', 'not_useful']), reason: choice(['wrong_task', 'missing_model', 'too_expensive', 'insufficient_evidence', 'other']), ...counts },
  scout_client_error: { code: choice(['auth_unavailable', 'search_timeout', 'network_error', 'http_error', 'invalid_response', 'render_error', 'uncaught_error']), http_status: integer(400, 599), duration_ms: duration, ...exception },
  cli_command_started: { command },
  cli_command_completed: { command, outcome: choice(['ok', 'error']), duration_ms: duration, code: choice(['command_error', 'approval_pending', 'access_denied', 'install_conflict', 'openmerit_unreachable', 'scout_network_error', 'scout_http_error', 'scout_response_error', 'scout_timeout']), operation: choice(['scout_recommend']), ...exception },
  terminal_visited: { mode },
  terminal_page_viewed: { mode, page: choice(['overview', 'models', 'services', 'activity', 'compute', 'sources', 'connections']) },
  terminal_interaction: { mode, action: choice(['inspect', 'filter', 'search', 'map_expand', 'mode', 'command']), kind: choice(['model', 'agent', 'task', 'service', 'source', 'host', 'deployment', 'pool', 'record', 'path', 'other']) },
  terminal_snapshot: { mode, ...Object.fromEntries(['model_count', 'record_count', 'source_count', 'host_count', 'deployment_count', 'agent_count'].map(k => [k, integer(0, 1000000000)])) },
  terminal_error: { code: choice(['collection_error', 'snapshot_error', 'render_error', 'uncaught_error']), ...exception },
  website_visited: { page },
  website_link_opened: { page, destination: choice(['scout', 'docs', 'terminal', 'github', 'other']) },
  website_error: { page, code: choice(['uncaught_error']), ...exception },
};
const schemas = {
  ...clientEvents,
  scout_search_completed: {
    ...counts, ...failure, duration_ms: duration, cache: choice(['miss', 'hit', 'shared', 'unknown']),
    outcome: choice(['ok', 'empty', 'unsupported', 'clarification', 'rate_limited', 'interpretation_error', 'selection_error', 'internal_error']),
  },
  scout_request_completed: { route: choice(['recommend', 'mcp']), http_status: integer(100, 599), duration_ms: duration, outcome: choice(['ok', 'error']), ...mcp },
  scout_tool_invocation_started: mcp,
  scout_tool_invocation_completed: { ...mcp, outcome: choice(['ok', 'error']), duration_ms: duration, ...counts },
  scout_connect_step: { ...setup, stage: choice(['device', 'token', 'login', 'keys', 'revoke', 'request']), status: choice(['pending', 'slow_down', 'approved', 'denied', 'collected', 'expired', 'invalid', 'revoked']), http_status: integer(100, 599), duration_ms: duration },
  scout_server_error: { code: choice(['catalogue_error', 'interpretation_error', 'selection_error', 'internal_error', 'auth_error', 'request_error', 'mcp_protocol_error', 'mcp_tool_error', 'connect_error']), ...exception, ...failure },
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

export function betaEvaluationEnabled(env) {
  // Roll out only after privacy review and live acceptance of PostHog's AI
  // content retention. Existing deployments keep their explicit opt-in default.
  return env.SCOUT_BETA_EVALUATION_LOGGING === 'true' && env.POSTHOG_CAPTURE_CONTENT === 'true' && accountSyncEnabled(env);
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
  // Reuse the exact UUIDs and timestamps: a timeout can occur after ingestion.
  const body = JSON.stringify({ api_key: env.POSTHOG_PROJECT_TOKEN, batch });
  for (let attempt = 1; attempt <= 3; attempt++) {
    let status = 0;
    try {
      const response = await fetch(`${env.POSTHOG_HOST}/batch/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(1500), redirect: 'manual',
      });
      status = response.status;
      await response.body?.cancel();
      if (response.ok) { deliveryDiagnostic('delivered', attempt, batch.length); return; }
    } catch { /* Transport failure; never log the request or exception. */ }
    if (attempt === 3 || status && status !== 429 && status < 500) {
      deliveryDiagnostic('failed', attempt, batch.length);
      throw new Error('Analytics delivery unavailable.');
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 100));
  }
}

// Operational counters, independent of PostHog. No identity, content, URLs or
// correlation IDs: opted-out users must not become another analytics stream.
export function deliveryDiagnostic(status, attempt = 0, count = 0) {
  console[status === 'failed' ? 'warn' : 'info'](JSON.stringify({ event: 'scout_analytics_delivery', status, attempt, event_count: count }));
}

async function relatedUUID(id, event) {
  const hex = (await accountId(`${id}:${event}`)).slice(8, 40);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

// Request-local identity only: never attach an account or trace to a shared
// computation/cache. Search and interaction events now share this destination.
export function createProductAnalytics(request, env, ctx = {}) {
  const url = new URL(request.url);
  const enabled = productAnalyticsEnabled(env) && request.headers.get('dnt') !== '1' &&
    request.headers.get('sec-gpc') !== '1' && request.headers.get('x-scout-analytics') !== 'off' && url.searchParams.get('analytics') !== 'off';
  const path = url.pathname, started = performance.now();
  const observedAt = Date.now();
  const client = choice(['web', 'cli', 'agent'])(request.headers.get('x-scout-client')) ?? 'unknown';
  const linkAccount = request.headers.get('x-scout-analytics-account') !== 'off';
  const anonymousId = uuid(request.headers.get('x-scout-anonymous-id')) ?? crypto.randomUUID();
  // Correlation is not authentication. Accept only a random operation ID; never
  // reuse browser correlation in unlinking mode, even before response headers.
  const traceId = linkAccount && uuid(request.headers.get('x-scout-trace-id')) || crypto.randomUUID();
  const retryOf = linkAccount && uuid(request.headers.get('x-scout-retry-of'));
  const contentChoice = request.headers.get('x-scout-analytics-content');
  const contentAllowed = env.POSTHOG_CAPTURE_CONTENT === 'true' && accountSyncEnabled(env) &&
    (contentChoice === 'on' || contentChoice === null && client === 'web' && betaEvaluationEnabled(env));
  let userId, serverErrorReported = false, mcpProperties = {}, searchCounts = {};
  const correlation = linkAccount ? {
    setup_id: uuid(request.headers.get('x-scout-setup-id')),
    installation_id: uuid(request.headers.get('x-scout-installation-id')),
  } : {};
  const clientVersion = version(request.headers.get('x-scout-client-version'));
  const reportedAgent = agent(request.headers.get('x-scout-agent'));

  function background(promise) {
    const safe = promise.catch(() => deliveryDiagnostic('failed'));
    if (ctx.waitUntil) ctx.waitUntil(safe);
  }
  function capture(event, properties = {}, options = {}) {
    if (!Object.hasOwn(schemas, event)) return;
    if (!enabled) { deliveryDiagnostic('request_suppressed'); return; }
    const safe = {};
    const web = webEvents.includes(event);
    if (web) {
      if (!validateWebProperties(event, properties)) return;
      Object.assign(safe, properties);
    }
    // Only typed, bounded values can cross this boundary, including for errors.
    for (const [key, validate] of Object.entries({ ...schemas[event], trace_id: uuid, session_id: uuid, command_id: uuid, setup_id: uuid, installation_id: uuid, client_version: version,
      platform: choice(['darwin', 'linux', 'win32', 'unknown']), runtime_major: integer(22, 100) })) {
      const value = validate(properties[key]); if (value !== undefined && value !== null) safe[key] = value;
    }
    // A browser ID or result trace may already belong to an identified person.
    // Unlinked requests must not reuse either, even after a privacy-mode change.
    if (!safe.trace_id || !linkAccount) delete safe.trace_id;
    if (!linkAccount) { delete safe.session_id; delete safe.command_id; delete safe.pageview_id; delete safe.setup_id; delete safe.installation_id; }
    const account = userId, identity = linkAccount ? account : null;
    const anon = linkAccount ? options.anonymousId ?? anonymousId : crypto.randomUUID();
    const timestamp = new Date().toISOString();
    background((async () => {
      const distinctId = identity ? await accountId(identity) : `anonymous:${anon}`;
      const common = {
        distinct_id: distinctId, $process_person_profile: !!identity, $geoip_disable: true, $ip: null,
        product: event.startsWith('cli_') || event.startsWith('terminal_') ? 'openmerit' : event.startsWith('website_') || web && safe.page !== 'scout' ? 'website' : 'scout', environment: env.POSTHOG_ENVIRONMENT,
        client: options.client ?? client, transport: path === '/scout/mcp' ? 'mcp' : 'http',
        request_id: traceId, trace_id: safe.trace_id ?? traceId, $session_id: linkAccount ? safe.session_id ?? uuid(request.headers.get('x-scout-session-id')) ?? anon : anon,
        ...(retryOf ? { retry_of: retryOf } : {}),
        ...Object.fromEntries(Object.entries(correlation).filter(([, value]) => value)),
        ...(clientVersion ? { client_version: clientVersion } : {}),
        ...(reportedAgent ? { agent: reportedAgent } : {}),
        analytics_version: 5, account_linked: !!identity,
        ...(safe.trace_id || ['/scout/api/recommend', '/scout/mcp'].includes(path) ? { $ai_trace_id: safe.trace_id ?? traceId } : {}),
        ...(env.CF_VERSION_METADATA?.id ? { release: env.CF_VERSION_METADATA.id } : {}),
      };
      const native = web ? {
        $current_url: `https://openmerit.ai${safe.page_path}`, $pathname: safe.page_path, $host: 'openmerit.ai',
        $pageview_id: safe.pageview_id ?? anon,
        ...(event === 'web_pageview' ? {
          $referrer: safe.referrer_domain === 'none' ? '' : `https://${safe.referrer_domain}/`,
          $referring_domain: safe.referrer_domain === 'none' ? '' : safe.referrer_domain,
          $browser: { chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Microsoft Edge', other: 'Other' }[safe.browser],
          $device_type: { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' }[safe.device],
          $os: { windows: 'Windows', macos: 'Mac OS X', ios: 'iOS', android: 'Android', linux: 'Linux', other: 'Other' }[safe.os],
        } : event === 'web_pageleave' ? {
          $prev_pageview_id: safe.pageview_id ?? anon, $prev_pageview_pathname: safe.page_path,
          $prev_pageview_duration: safe.duration_ms / 1000, $prev_pageview_max_scroll_percentage: safe.scroll_depth / 100,
          $prev_pageview_max_content_percentage: safe.content_depth / 100,
        } : event === 'web_vitals' ? { [`$web_vitals_${safe.vital_name}_value`]: safe.vital_value }
          : { $event_type: 'click', $elements: [{ tag_name: 'button', attr_id: safe.cta_id }] }),
      } : {};
      const nativeEvent = { web_pageview: '$pageview', web_pageleave: '$pageleave', web_vitals: '$web_vitals', web_interaction: '$autocapture' }[event] ?? event;
      const eventUUID = options.eventId ?? crypto.randomUUID();
      const batch = [{ event: nativeEvent, uuid: eventUUID, timestamp, properties: { ...common, ...safe, ...native } }];
      for (const entry of options.entries ?? []) batch.push({ ...entry, uuid: crypto.randomUUID(), timestamp: entry.timestamp ?? timestamp,
        properties: { ...common, ...entry.properties, $ai_trace_id: traceId,
          ...(entry.event === '$ai_trace' ? { $ai_span_id: traceId } : entry.event.startsWith('$ai_') ? { $ai_parent_id: traceId } : {}) } });
      if (['scout_client_error', 'scout_connect_client_error', 'scout_server_error', 'terminal_error', 'website_error'].includes(event) || ['cli_command_completed', 'scout_installation_step'].includes(event) && safe.outcome === 'error') {
        const code = safe.code ?? (event === 'cli_command_completed' ? 'command_error' : 'unknown_error');
        batch.push({ event: '$exception', uuid: await relatedUUID(eventUUID, '$exception'), timestamp, properties: { ...common,
          $exception_level: 'error', $exception_list: [{ type: safe.error_type ?? 'Error', value: code,
            mechanism: { handled: code !== 'uncaught_error', synthetic: !safe.frames?.length },
            stacktrace: { type: 'raw', frames: safe.frames ?? [] } }],
          ...safe, code,
        } });
      }
      if (event === 'scout_session_observed' && identity) batch.unshift({
        event: '$identify', uuid: await relatedUUID(eventUUID, '$identify'), timestamp,
        properties: { ...common, $anon_distinct_id: `anonymous:${anon}` },
      });
      // Capture API only: no arbitrary DOM capture/replay, metadata or IPs.
      // All expanded events retain account preference and deletion enforcement.
      if (account && env.SCOUT_ACCOUNTS) await (await accountAnalytics(env, account)).capture(batch);
      else await sendProductBatch(env, batch);
    })());
  }

  return {
    identify(id) {
      userId = id;
      // Request-local refusals (including a default-off installer) must not
      // silently change the account's saved choice. Only handlePreference does.
    },
    observeMCP(method, name, tool, harnessVersion) {
      mcpProperties = {
        mcp_method: mcp.mcp_method(method) ?? 'other',
        ...(method === 'tools/call' ? { mcp_tool: tool === 'scout_models' ? tool : 'other' } : {}),
        ...(method === 'initialize' ? { harness: ['claude-code', 'claude-ai', 'Claude Code'].includes(name) ? 'claude-code' : name === 'openmerit-cli' ? name : 'unknown', harness_version: version(harnessVersion) } : {}),
      };
      if (method === 'tools/call') capture('scout_tool_invocation_started', mcpProperties);
    },
    connectStep(properties) {
      capture('scout_connect_step', properties);
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
      const diagnostic = event.diagnostics?.failure ?? result?.runtime?.failure;
      const failureProperties = { failure_stage: diagnostic?.stage, failure_code: diagnostic?.code, provider_status: diagnostic?.providerStatus };
      const tasks = result?.tasks ?? (result ? [{ slots: [result] }] : []);
      searchCounts = { task_count: tasks.length, candidate_count: tasks.reduce((n, task) => n + task.slots.reduce((n, slot) => n + slot.recommendations.length, 0), 0) };
      capture('scout_search_completed', {
        outcome, ...failureProperties, duration_ms: milliseconds(durationMs), ...searchCounts,
        cache: result?.runtime?.cache ?? 'unknown',
      }, { entries: searchEvents(event, contentAllowed) });
      if (error && ['interpretation_error', 'selection_error', 'internal_error'].includes(outcome)) {
        serverErrorReported = true;
        capture('scout_server_error', { code: outcome, ...failureProperties, error_type: errorType(error.cause?.name ?? error.name), frames: exceptionFrames(error.cause?.stack ?? error.stack) });
      }
    },
    exception(error, code = 'catalogue_error') {
      serverErrorReported = true;
      capture('scout_server_error', { code, error_type: errorType(error?.name), frames: exceptionFrames(error?.stack) });
    },
    response(response) {
      const headers = new Headers(response.headers);
      // Do not hand an unlinked trace back to later account-linked clicks.
      if (linkAccount) headers.set('X-Scout-Trace-Id', traceId);
      else headers.delete('X-Scout-Trace-Id');
      headers.set('X-Scout-Analytics-Status', enabled ? 'request_allowed' : 'request_suppressed');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    async complete(response) {
      if (!['/scout/api/recommend', '/scout/mcp'].includes(path)) return;
      const isMCP = path === '/scout/mcp';
      let logicalError = false;
      if (enabled && isMCP && response.headers.get('content-type')?.includes('application/json')) {
        try {
          const body = await response.clone().json();
          logicalError = !!body.error || body.result?.isError === true;
          mcpProperties = { ...mcpProperties,
            ...(mcp.protocol_error(body.error?.code) !== undefined ? { protocol_error: body.error.code } : {}),
            ...(body.result?.isError === true ? { tool_error: true } : {}) };
        } catch { logicalError = true; }
      }
      const duration_ms = milliseconds(performance.now() - started);
      const outcome = response.ok && !logicalError ? 'ok' : 'error';
      capture('scout_request_completed', {
        route: isMCP ? 'mcp' : 'recommend', http_status: response.status, duration_ms, outcome, ...mcpProperties,
      });
      if (isMCP && mcpProperties.mcp_method === 'tools/call') capture('scout_tool_invocation_completed', { ...mcpProperties, ...searchCounts, duration_ms, outcome });
      if (!serverErrorReported && (logicalError || response.status >= 400)) capture('scout_server_error', {
        code: logicalError ? mcpProperties.tool_error ? 'mcp_tool_error' : 'mcp_protocol_error' : response.status === 401 || response.status === 403 ? 'auth_error' : 'request_error',
      });
    },
    async handleEvent() {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
      if (!enabled) return noContent();
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
      let body;
      try { body = await readJSON(request); } catch { return json({ error: 'Invalid analytics event.' }, 400); }
      if (!body || typeof body.event !== 'string' || !Object.hasOwn(clientEvents, body.event) || !uuid(body.anonymousId) ||
          !body.properties || typeof body.properties !== 'object' || Array.isArray(body.properties)) return json({ error: 'Invalid analytics event.' }, 400);
      if (webEvents.includes(body.event) && !validateWebProperties(body.event, body.properties)) return json({ error: 'Invalid web analytics event.' }, 400);
      if (body.event === 'scout_recommendation_feedback' && !['useful', 'not_useful'].includes(body.properties.rating)) return json({ error: 'Invalid feedback.' }, 400);
      if (body.event === 'scout_session_observed' && !userId) return json({ error: 'Sign in to identify an analytics account.' }, 401);
      capture(body.event, body.properties, { anonymousId: uuid(body.anonymousId), eventId: uuid(body.event_id), client: body.event.startsWith('cli_') || body.event.startsWith('terminal_') || body.event === 'scout_installation_step' ? 'cli' : 'web' });
      return noContent();
    },
  };
}
