// Langfuse's only data reads here are experiment headers and aggregate metrics.
// No trace, observation, item, raw score, comment, input or output endpoint is reachable.
import type { MeasurementInput, Level, MeasureKind } from './agent/recommendation.ts';

export const langfuseHosts = {
  us: 'https://us.cloud.langfuse.com',
  eu: 'https://cloud.langfuse.com',
  hipaa: 'https://hipaa.cloud.langfuse.com',
} as const;
export interface ScoreMapping {
  metric: string;
  modelKey: string;
  task: string;
  traceName: string;
  level: Level;
  kind: MeasureKind;
  higherIsBetter: boolean;
}
export interface LangfuseConfig {
  region: keyof typeof langfuseHosts;
  publicKey: string;
  secretKey: string;
  from: string;
  // Every scored trace must carry this prefix followed by its experiment ID.
  tagPrefix: string;
  mappings: ScoreMapping[];
  // Explicit aliases from experiment metadata to catalogue model/endpoint IDs.
  models: Record<string, string>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;
export function parseLangfuse(value: unknown): LangfuseConfig {
  if (!object(value) || !Object.hasOwn(langfuseHosts, String(value.region))
    || typeof value.publicKey !== 'string' || !/^pk-lf-[a-zA-Z0-9-]{8,100}$/.test(value.publicKey)
    || typeof value.secretKey !== 'string' || !/^sk-lf-[a-zA-Z0-9-]{8,100}$/.test(value.secretKey)
    || typeof value.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.from) || !Number.isFinite(Date.parse(value.from))
    || !label(value.tagPrefix) || !Array.isArray(value.mappings) || value.mappings.length > 8
    || !object(value.models) || Object.keys(value.models).length > 100) throw new Error('Provide a Langfuse region, key pair, start date, experiment tag prefix and mappings.');
  for (const m of value.mappings) {
    if (!object(m) || ![m.metric, m.modelKey, m.task, m.traceName].every(label)
      || !['task', 'agent', 'environment'].includes(String(m.level)) || !['quality', 'usd', 'seconds'].includes(String(m.kind))
      || typeof m.higherIsBetter !== 'boolean') throw new Error('Each score mapping needs metric, modelKey, task, traceName, level, kind and direction.');
  }
  if (Object.entries(value.models).some(([key, id]) => !label(key) || !label(id))) throw new Error('Model aliases must map metadata values to catalogue model or endpoint IDs.');
  return { region: value.region as LangfuseConfig['region'], publicKey: value.publicKey, secretKey: value.secretKey,
    from: value.from, tagPrefix: value.tagPrefix, mappings: value.mappings as ScoreMapping[], models: value.models as Record<string, string> };
}

// Bounded reads and fixed hosts prevent credential forwarding and unbounded upstream bodies.
async function request(config: LangfuseConfig, path: '/api/public/experiments' | '/api/public/v2/metrics' | '/api/public/v2/datasets', query: URLSearchParams, fetcher: typeof fetch, probe = false): Promise<Response> {
  const url = new URL(path, langfuseHosts[config.region]);
  url.search = query.toString();
  const response = await fetcher(url, {
    method: probe ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Basic ${btoa(`${config.publicKey}:${config.secretKey}`)}`, ...(probe ? { 'Content-Type': 'application/json' } : {}) },
    ...(probe ? { body: '{}' } : {}),
  });
  return response;
}
async function data(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429 ? 'Langfuse rate limited the read. Wait at least one minute before syncing again.' : `Langfuse read failed (HTTP ${response.status}). Check the region and Viewer key.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Langfuse returned an empty response.');
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 512_000) { await reader.cancel(); throw new Error('Langfuse response is too large. Narrow the start date.'); }
    text += decoder.decode(value, { stream: true });
  }
  const value: unknown = JSON.parse(text + decoder.decode());
  if (!object(value)) throw new Error('Langfuse returned an invalid response.');
  return value;
}

export async function verifyViewer(config: LangfuseConfig, fetcher: typeof fetch = fetch): Promise<void> {
  // Authenticate a read first. A 403 alone could otherwise mean an invalid key.
  await data(await request(config, '/api/public/experiments', new URLSearchParams({ fields: 'core', limit: '1', fromStartTime: `${config.from}T00:00:00Z` }), fetcher));
  // Intentionally invalid: name is required, so {} cannot create a dataset, even
  // with a Full access key. Full access returns 400; Viewer must return 403.
  // Unknown responses fail closed. No valid write payload is ever sent.
  const probe = await request(config, '/api/public/v2/datasets', new URLSearchParams(), fetcher, true);
  await probe.body?.cancel();
  if (probe.status !== 403) throw new Error('A Viewer key is required. Create a separate Viewer key in Langfuse Project Settings → API Keys; do not replace your tracing keys.');
}

export interface LangfuseImport { results: MeasurementInput[]; experiments: number; unmapped: number }
export async function importLangfuse(config: LangfuseConfig, fetcher: typeof fetch = fetch, now = Date.now()): Promise<LangfuseImport> {
  const results: MeasurementInput[] = []; let experiments = 0, unmapped = 0, cursor = '';
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ fields: 'core,metadata', limit: '20', fromStartTime: `${config.from}T00:00:00Z`, toStartTime: new Date(now).toISOString() });
    if (cursor) query.set('cursor', cursor);
    const page = await data(await request(config, '/api/public/experiments', query, fetcher));
    if (!Array.isArray(page.data)) throw new Error('Langfuse returned invalid experiment headers.');
    for (const e of page.data) {
      if (!object(e) || typeof e.id !== 'string' || e.id.length > 200 || !object(e.metadata)) continue;
      if (++experiments > 100) throw new Error('More than 100 experiments match. Narrow the start date; no partial import was saved.');
      for (const m of config.mappings) {
        const rawModel = e.metadata[m.modelKey];
        if (!label(rawModel)) { unmapped++; continue; }
        const model = Object.hasOwn(config.models, rawModel) ? config.models[rawModel] : undefined;
        if (!model) { unmapped++; continue; }
        // Scores with no explicit experiment tag are NOT attributed by time or
        // by the currently selected model. Concurrent runs cannot contaminate it.
        const query = new URLSearchParams({ query: JSON.stringify({
          view: 'scores-numeric', dimensions: [],
          metrics: [{ measure: 'value', aggregation: 'avg' }, { measure: 'count', aggregation: 'count' }],
          filters: [
            { column: 'tags', type: 'arrayOptions', operator: 'any of', value: [`${config.tagPrefix}${e.id}`] },
            { column: 'traceName', type: 'string', operator: '=', value: m.traceName },
            { column: 'name', type: 'string', operator: '=', value: m.metric },
          ],
          fromTimestamp: `${config.from}T00:00:00Z`, toTimestamp: new Date(now).toISOString(), config: { row_limit: 1 },
        }) });
        const metrics = await data(await request(config, '/api/public/v2/metrics', query, fetcher));
        if (!Array.isArray(metrics.data)) throw new Error('Langfuse returned invalid aggregate metrics.');
        const row: unknown = metrics.data[0];
        if (!object(row) || typeof row.count_count !== 'number' || row.count_count === 0) continue;
        if (!Number.isSafeInteger(row.count_count) || row.count_count < 1 || typeof row.avg_value !== 'number' || !Number.isFinite(row.avg_value)) throw new Error('Langfuse returned invalid aggregate values.');
        // Never keep names, descriptions, arbitrary metadata, record IDs or raw scores.
        // A hash identifies an experiment without importing its potentially sensitive name.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(e.id));
        const experiment = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        results.push({ level: m.level, kind: m.kind, task: m.task, scope: m.task, model, metric: m.metric,
          value: row.avg_value, samples: row.count_count, higherIsBetter: m.higherIsBetter, source: `Langfuse experiment ${experiment}` });
      }
    }
    cursor = object(page.meta) && typeof page.meta.cursor === 'string' ? page.meta.cursor : '';
    if (cursor && seen.has(cursor)) throw new Error('Langfuse repeated a pagination cursor; no partial import was saved.');
    seen.add(cursor);
  } while (cursor);
  return { results, experiments, unmapped };
}
