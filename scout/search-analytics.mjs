import { searchRecord } from './analytics.mjs';
import { redactContent } from '../site/scout/analytics-privacy.js';
import { timingStages } from './timing.mjs';

const nonnegative = value => Number.isFinite(value) && value >= 0;
const spanId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const failureCodes = new Set(['timeout', 'transport_error', 'http_error', 'rate_limited', 'rate_limit_exceeded', 'insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'organization_usage_limit_exceeded', 'refusal', 'incomplete', 'validation_error', 'provider_error']);

// These are real computation attempts, never the recommended models. Cache
// followers have no attempts of their own. Missing usage/cost stays unknown.
function computationEvents(diagnostics) {
  if (!diagnostics || ['hit', 'shared'].includes(diagnostics.cache)) return [];
  const events = [];
  for (const [kind, records, limit] of [['span', diagnostics.spans, 80], ['generation', diagnostics.generations, 40]]) {
    for (const record of (records ?? []).slice(0, limit)) {
      if (!spanId(record.id) || !nonnegative(record.durationMs) || !Number.isFinite(Date.parse(record.startedAt))) continue;
      if (kind === 'span' && !timingStages.includes(record.stage)) continue;
      if (kind === 'generation' && !['responses', 'decisions', 'embeddings'].includes(record.operation)) continue;
      const code = failureCodes.has(record.code) ? record.code : undefined;
      const properties = {
        $ai_span_id: record.id, $ai_span_name: kind === 'span' ? record.stage : `openai.${record.operation}`,
        $ai_latency: Math.max(0, Math.min(record.pending && kind === 'generation' ? Date.now() - Date.parse(record.startedAt) : record.durationMs, 86400000)) / 1000,
        $ai_is_error: record.failed === true || !!code,
        ...(kind === 'span' ? { stage_state: record.failed ? 'failed' : record.pending ? 'incomplete' : 'completed' } : {}),
        ...(code ? { $ai_error: code, failure_code: code } : {}),
      };
      if (kind === 'generation') {
        properties.$ai_provider = 'openai';
        properties.operation = record.operation;
        properties.attempt_state = record.pending ? 'incomplete' : code ? 'failed' : 'completed';
        if (['gpt-6-luna', 'text-embedding-3-small'].includes(record.model)) properties.$ai_model = record.model;
        for (const [source, target] of [['inputTokens', '$ai_input_tokens'], ['outputTokens', '$ai_output_tokens'], ['cachedInputTokens', '$ai_cache_read_input_tokens']]) {
          if (Number.isSafeInteger(record[source]) && record[source] >= 0) properties[target] = record[source];
        }
        if (Number.isInteger(record.providerStatus) && record.providerStatus >= 100 && record.providerStatus <= 599) properties.provider_status = record.providerStatus;
      }
      events.push({ event: kind === 'generation' && record.operation === 'embeddings' ? '$ai_embedding' : `$ai_${kind}`, timestamp: record.startedAt, properties });
    }
  }
  return events;
}

// Public evidence is selected by searchRecord, then bounded for PostHog. Never
// serialize a whole recommendation: it also carries prompt-derived prose.
export function searchEvents(event, includeContent) {
  const tasks = event.result?.tasks ?? [{ slots: [event.result] }];
  const details = [];
  for (const [i, task] of tasks.slice(0, 3).entries()) for (const [j, slot] of (task.slots ?? []).slice(0, 3).entries()) {
    const record = searchRecord({ ...event, prompt: undefined, result: slot, task: slot?.task ?? event.task, diagnostics: slot?.runtime ?? event.diagnostics,
      position: { task: i + 1, slot: j + 1, tasks: tasks.length, slots: task.slots.length } });
    let truncated = false, remaining = 48000;
    function bounded(value, key = '', depth = 0) {
      if (depth > 10 || remaining <= 0) { truncated = true; return null; }
      if (typeof value === 'string') {
        let safe;
        if (/url$/i.test(key)) {
          try { const url = new URL(value); safe = url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null; } catch { safe = null; }
        } else safe = redactContent(value, 1000);
        if (value.length > 1000) truncated = true;
        if (safe && safe.length > remaining) { safe = safe.slice(0, remaining); truncated = true; }
        remaining -= safe?.length ?? 0;
        return safe;
      }
      if (Array.isArray(value)) { if (value.length > 20) truncated = true; return value.slice(0, 20).map(v => bounded(v, key, depth + 1)); }
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bounded(v, k, depth + 1)]));
      return typeof value === 'number' ? Number.isFinite(value) ? value : null : value ?? null;
    }
    for (const model of record.top5) {
      // Semantic matches may contain the user's described labels/subjects.
      if (model.evidence.endpoint) {
        delete model.evidence.endpoint.semanticMatch;
        delete model.evidence.endpoint.semanticProfile;
      }
    }
    const { prompt, ...metadata } = record;
    // Evidence budgets must never discard later ranks or turn missing metrics
    // into zero. All five compact identities/metrics survive an oversized source.
    const properties = { ...metadata, top5: record.top5.map(({ evidence, ...model }) => ({ ...model, evidence: bounded(evidence) })) };
    properties.task_index = i + 1; properties.slot_index = j + 1;
    properties.ranking_mode = ['measured', 'benchmarks', 'task-fit'].includes(slot?.ranking?.mode) ? slot.ranking.mode : 'unknown';
    properties.quality_status = ['proxy-qualified', 'unverified'].includes(slot?.ranking?.frontier?.qualityGate?.status) ? slot.ranking.frontier.qualityGate.status : 'unknown';
    properties.evidence_truncated = truncated;
    properties.benchmark_counts = (slot?.recommendations ?? []).slice(0, 5).map(m => (m.evidence ?? []).length);
    details.push({ event: 'scout_search_details', properties });
  }
  return [{ event: '$ai_trace', properties: {
    $ai_span_name: 'scout_recommendation', $ai_session_id: null,
    $ai_latency: Math.max(0, Math.min(86400, (event.durationMs ?? 0) / 1000)),
    $ai_is_error: /error$/.test(event.outcome ?? ''),
    content_captured: includeContent,
    // PostHog Cloud expires these AI content fields after 30 days. Never copy
    // prompt-derived prose to ordinary event properties, which persist longer.
    ...(includeContent ? { $ai_input_state: {
      prompt: redactContent(event.prompt),
      tasks: tasks.slice(0, 3).map((task, i) => ({
        task_index: i + 1, excerpt: redactContent(task.sourceText ?? task.title, 1000),
        layers: Object.fromEntries(['input', 'work', 'output', 'criteria', 'constraints'].map(key => [key, {
          origin: ['explicit', 'inferred', 'missing'].includes(task.layers?.[key]?.origin) ? task.layers[key].origin : 'missing',
          text: redactContent(task.layers?.[key]?.text, 1000),
        }])),
      })),
    } } : {}),
    // These are recommended models, not executions or actual provider charges.
    $ai_output_state: details.map(({ properties: p }) => ({ task_index: p.task_index, slot_index: p.slot_index,
      quality_status: p.quality_status, models: p.top5.map(({ evidence, ...model }) => model) })),
  } }, ...details, ...computationEvents(event.diagnostics ?? event.result?.runtime)];
}
