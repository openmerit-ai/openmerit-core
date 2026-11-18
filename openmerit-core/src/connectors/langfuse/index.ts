// Langfuse connector, read-only, for Langfuse Cloud or a self-hosted instance. It reads:
// - per-item pass/fail of experiments the application's own eval recorded (experiment items and
//   their scores), which is how Scout measures a model without writing anything itself;
// - dataset item IDs (never their contents), to know which items an eval run must cover;
// - aggregate production evidence: generation counts, cost and latency by model, score averages.
// It never creates datasets, experiments, traces or scores, and it never reads inputs, outputs or comments.
//
// The only non-GET request is the Viewer check: a deliberately invalid dataset creation ({} has no
// name). A Viewer key gets 403; any other answer means the key can write, so setup refuses it.

import { createTransport, cursorPages, type LangfuseConnection, LangfuseError, metricsRows, type Query, type TransportOptions } from "./client.ts";

export { connectionFromEnv, type LangfuseConnection, LangfuseError, normalizeBaseUrl, type TransportOptions } from "./client.ts";

export type ScoreValue = number | boolean | string;

/**
 * Decides whether one item passed from one score. With no condition, a BOOLEAN score must be true
 * and a NUMERIC score must be 1. `equals` compares exactly; `min`/`max` are inclusive numeric bounds.
 */
export interface PassRule {
  score: string;
  equals?: ScoreValue;
  min?: number;
  max?: number;
}

export interface ItemResult {
  itemId: string;
  traceId: string;
  passed: boolean;
  /** The pass score was absent: the item failed to run or was not scored. It never counts as a pass. */
  missingScore: boolean;
}

export interface ExperimentResult {
  experimentName: string;
  experimentId: string;
  datasetId: string | null;
  items: ItemResult[];
  passes: number;
  total: number;
  /** Requested item IDs with no experiment item in Langfuse. */
  missing: string[];
  /** Item IDs present without the pass score. */
  missingScores: string[];
}

export interface ExperimentQuery {
  experimentName: string;
  pass: PassRule;
  /** Only these items count; absent ones are listed in `missing`. */
  itemIds?: readonly string[];
  /** Lower bound for Langfuse's required start-time filter. */
  since: string;
}

export interface ModelUsage {
  /** Model name as the traces report it (Langfuse `providedModelName`). */
  model: string;
  generations: number;
  costUsd: number | null;
  p50LatencyMs: number | null;
}

export interface ScoreAggregate { name: string; average: number; count: number }

export interface TaskEvidence {
  traceName: string;
  from: string;
  to: string;
  models: ModelUsage[];
  /** Score averages over every trace of this name in the window, whichever model produced it. */
  scores: ScoreAggregate[];
}

export interface LangfuseConnector {
  readonly baseUrl: string;
  check(): Promise<{ baseUrl: string; projectId: string; projectName: string }>;
  /** Throws unless the key pair is read-only (Viewer). */
  verifyViewer(): Promise<void>;
  /** IDs of the dataset's active items. */
  datasetItemIds(name: string): Promise<string[]>;
  experimentResults(query: ExperimentQuery): Promise<ExperimentResult>;
  /** Polls until every expected item is present and scored, allowing for ingestion lag; throws on timeout. */
  waitForExperiment(query: ExperimentQuery, options: { expectItems: number; timeoutMs?: number; intervalMs?: number }): Promise<ExperimentResult>;
  /** Trace names with generation counts, to suggest task mappings in setup. */
  traceNames(days?: number): Promise<{ traceName: string; generations: number }[]>;
  taskEvidence(mapping: { traceName: string; scores: string[] }, days?: number): Promise<TaskEvidence>;
}

const DAY_MS = 86_400_000;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function evaluatePass(rule: PassRule, value: ScoreValue | undefined): boolean {
  if (value === undefined) return false;
  if (rule.equals !== undefined) return value === rule.equals || (typeof rule.equals === "boolean" && value === (rule.equals ? 1 : 0));
  if (rule.min !== undefined || rule.max !== undefined) {
    if (typeof value !== "number") return false;
    return (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
  }
  return value === true || value === 1;
}

function scoreValue(score: Record<string, unknown>): ScoreValue | undefined {
  const value = score.value;
  if (score.dataType === "BOOLEAN") {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true" || value === "True") return true;
    if (value === 0 || value === "0" || value === "false" || value === "False") return false;
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return undefined;
}

export function createLangfuseConnector(connection: LangfuseConnection, options: TransportOptions = {}): LangfuseConnector {
  const transport = createTransport(connection, options);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const get = async <T>(path: string, query?: Query): Promise<T | null> => (await transport.request<T>("GET", path, query ? { query } : {})).data;
  const window = (days: number) => ({ from: new Date(Date.now() - days * DAY_MS).toISOString(), to: new Date().toISOString() });

  const pages = (path: string, query: Query) => cursorPages(transport, path, query);
  const metrics = (query: Record<string, unknown>) => metricsRows(transport, query);
  const generation = { column: "type", operator: "=", value: "GENERATION", type: "string" };

  /** Latest score of one name per trace, from /api/public/v3/scores (trace- and observation-level). */
  async function scoresByTrace(traceIds: string[], name: string, since: string): Promise<Map<string, ScoreValue>> {
    const latest = new Map<string, { at: string; value: ScoreValue }>();
    for (let i = 0; i < traceIds.length; i += 40) {
      for await (const page of pages("/api/public/v3/scores", { traceId: traceIds.slice(i, i + 40).join(","), name, fields: "subject", limit: 100, fromTimestamp: since })) {
        for (const raw of page) {
          if (!isObject(raw) || !isObject(raw.subject)) continue;
          const traceId = raw.subject.kind === "trace" ? str(raw.subject.id) : str(raw.subject.traceId);
          const value = scoreValue(raw);
          const at = str(raw.timestamp) ?? "";
          if (!traceId || value === undefined) continue;
          const old = latest.get(traceId);
          if (!old || at > old.at) latest.set(traceId, { at, value });
        }
      }
    }
    return new Map([...latest].map(([traceId, { value }]) => [traceId, value]));
  }

  async function experimentResults(query: ExperimentQuery): Promise<ExperimentResult> {
    if (!query.experimentName) throw new LangfuseError("Pass the experiment name to read.");
    if (!query.pass?.score) throw new LangfuseError("Pass a pass rule naming the score that decides each item.");
    const latest = new Map<string, { raw: Record<string, unknown>; at: string }>();
    const experimentIds = new Set<string>();
    let datasetId: string | null = null;
    for await (const page of pages("/api/public/experiment-items", { fields: "core,scores", limit: 100, scoreLimit: 50, fromStartTime: query.since, experimentName: query.experimentName })) {
      for (const raw of page) {
        if (!isObject(raw) || !str(raw.experimentItemId) || !str(raw.traceId)) continue;
        experimentIds.add(str(raw.experimentId) ?? "");
        datasetId = str(raw.experimentDatasetId) ?? datasetId;
        const itemId = String(raw.experimentItemId);
        const at = str(raw.startTime) ?? "";
        const old = latest.get(itemId);
        // A retried item has several experiment items; its latest run counts.
        if (!old || at > old.at) latest.set(itemId, { raw, at });
      }
    }
    if (experimentIds.size > 1) throw new LangfuseError(`Experiment name "${query.experimentName}" matches ${experimentIds.size} experiments; the eval must use a fresh name per run.`);
    const wanted = query.itemIds ? new Set(query.itemIds) : null;
    const items: (ItemResult & { score?: ScoreValue })[] = [];
    for (const [itemId, { raw }] of latest) {
      if (wanted && !wanted.has(itemId)) continue;
      let best: { at: string; value: ScoreValue } | undefined;
      for (const score of Array.isArray(raw.scores) ? raw.scores : []) {
        if (!isObject(score) || score.name !== query.pass.score) continue;
        const value = scoreValue(score), at = str(score.timestamp) ?? "";
        if (value !== undefined && (!best || at > best.at)) best = { at, value };
      }
      items.push({ itemId, traceId: String(raw.traceId), passed: false, missingScore: false, ...(best ? { score: best.value } : {}) });
    }
    // Experiment items list observation-level scores; scores posted on the trace come from the scores API.
    const unscored = items.filter(item => item.score === undefined);
    if (unscored.length) {
      const found = await scoresByTrace(unscored.map(item => item.traceId), query.pass.score, query.since);
      for (const item of unscored) { const value = found.get(item.traceId); if (value !== undefined) item.score = value; }
    }
    const results: ItemResult[] = items.map(({ score, ...item }) => ({ ...item, missingScore: score === undefined, passed: evaluatePass(query.pass, score) }));
    results.sort((a, b) => a.itemId.localeCompare(b.itemId));
    return {
      experimentName: query.experimentName, experimentId: [...experimentIds][0] ?? "", datasetId, items: results,
      passes: results.filter(item => item.passed).length, total: results.length,
      missing: query.itemIds ? query.itemIds.filter(id => !latest.has(id)) : [],
      missingScores: results.filter(item => item.missingScore).map(item => item.itemId),
    };
  }

  return {
    baseUrl: transport.baseUrl,
    async check() {
      const data = await get<{ data?: { id?: string; name?: string }[] }>("/api/public/projects");
      const project = data?.data?.[0];
      if (!project?.id) throw new LangfuseError("Langfuse returned no project for this key pair.");
      return { baseUrl: transport.baseUrl, projectId: project.id, projectName: project.name ?? project.id };
    },
    async verifyViewer() {
      let status: number;
      try {
        status = (await transport.request("POST", "/api/public/v2/datasets", { body: {} })).status;
      } catch (error) {
        if (!(error instanceof LangfuseError) || error.status === null) throw error;
        status = error.status;
      }
      if (status !== 403) throw new LangfuseError("This key pair can write to Langfuse. Create a separate Viewer key in Langfuse Project Settings → API Keys; OpenMerit only reads and keeps your tracing keys untouched.");
    },
    async datasetItemIds(name) {
      const ids: string[] = [];
      for (let page = 1; ; page += 1) {
        const body = await get<{ data?: unknown; meta?: { totalPages?: unknown } }>("/api/public/dataset-items", { datasetName: name, page, limit: 100 });
        if (!body || !Array.isArray(body.data)) throw new LangfuseError("Langfuse GET /api/public/dataset-items returned no data array.");
        for (const raw of body.data) if (isObject(raw) && str(raw.id) && raw.status !== "ARCHIVED") ids.push(String(raw.id));
        if (page >= (num(body.meta?.totalPages) ?? 0) || body.data.length === 0) break;
      }
      if (!ids.length) throw new LangfuseError(`Langfuse dataset "${name}" has no active items (or does not exist in this project).`);
      return ids;
    },
    experimentResults,
    async waitForExperiment(query, { expectItems, timeoutMs = 300_000, intervalMs = 15_000 }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await experimentResults(query);
        const scored = result.total - result.missingScores.length;
        if (scored >= expectItems) return result;
        if (Date.now() + intervalMs > deadline) {
          throw new LangfuseError(`Langfuse shows ${scored}/${expectItems} items scored with "${query.pass.score}" in experiment "${query.experimentName}" after ${Math.round(timeoutMs / 1000)} s (missing items: ${result.missing.slice(0, 10).join(", ") || "none"}; unscored: ${result.missingScores.slice(0, 10).join(", ") || "none"}). The eval must record every requested item under OPENMERIT_EXPERIMENT.`);
        }
        await sleep(intervalMs);
      }
    },
    async traceNames(days = 30) {
      const { from, to } = window(days);
      const rows = await metrics({ view: "observations", dimensions: [{ field: "traceName" }], metrics: [{ measure: "count", aggregation: "count" }], filters: [generation], fromTimestamp: from, toTimestamp: to, config: { row_limit: 100 } });
      return rows.filter(row => typeof row.traceName === "string").map(row => ({ traceName: row.traceName as string, generations: num(row.count_count) ?? 0 })).sort((a, b) => b.generations - a.generations);
    },
    async taskEvidence(mapping, days = 30) {
      const { from, to } = window(days);
      const byTrace = { column: "traceName", operator: "=", value: mapping.traceName, type: "string" };
      const usage = await metrics({
        view: "observations", dimensions: [{ field: "providedModelName" }],
        metrics: [{ measure: "count", aggregation: "count" }, { measure: "totalCost", aggregation: "sum" }, { measure: "latency", aggregation: "p50" }],
        filters: [generation, byTrace], fromTimestamp: from, toTimestamp: to, config: { row_limit: 50 },
      });
      const scores = mapping.scores.length ? await metrics({
        view: "scores-numeric", dimensions: [{ field: "name" }], metrics: [{ measure: "value", aggregation: "avg" }, { measure: "count", aggregation: "count" }],
        filters: [byTrace, { column: "name", operator: "any of", value: mapping.scores, type: "stringOptions" }], fromTimestamp: from, toTimestamp: to, config: { row_limit: mapping.scores.length },
      }) : [];
      return {
        traceName: mapping.traceName, from, to,
        models: usage.filter(row => typeof row.providedModelName === "string").map(row => ({ model: row.providedModelName as string, generations: num(row.count_count) ?? 0, costUsd: num(row.sum_totalCost), p50LatencyMs: num(row.p50_latency) })),
        scores: scores.filter(row => typeof row.name === "string" && num(row.avg_value) !== null).map(row => ({ name: row.name as string, average: num(row.avg_value)!, count: num(row.count_count) ?? 0 })),
      };
    },
  };
}
