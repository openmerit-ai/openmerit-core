import { searchRecord } from './analytics.mjs';
import { redactContent } from '../site/scout/analytics-privacy.js';

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
  } }, ...details];
}
