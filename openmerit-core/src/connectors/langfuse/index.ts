// Langfuse eval connector: reads labelled datasets and experiment results, and records the
// evaluations Scout runs as Langfuse experiments, on Langfuse Cloud or a self-hosted instance.
//
// Read paths: /api/public/projects, /api/public/v2/datasets, /api/public/dataset-items,
// /api/public/experiments, /api/public/experiment-items (fields=scores), /api/public/v3/scores
// (trace-level scores that experiment items omit) and /api/public/v2/observations (cost).
// Write paths: /api/public/v2/datasets and /api/public/dataset-items (ensureDataset), OTLP
// /api/public/otel/v1/traces with langfuse.experiment.* attributes, and /api/public/scores.
// The deprecated dataset-run-items API is not used.

import { createTransport, type LangfuseConnection, LangfuseError, type Query, type TransportOptions } from "./client.ts";
import { asText, attribute, exportRequest, hexId, type OtlpSpan, span } from "./otlp.ts";

export { connectionFromEnv, type LangfuseConnection, LangfuseError, normalizeBaseUrl, type TransportOptions } from "./client.ts";

export type ScoreValue = number | boolean | string;
export type Metadata = Record<string, string | number | boolean>;

export interface EvalItem {
  id: string;
  input: unknown;
  expectedOutput: unknown;
  metadata: Record<string, unknown>;
}

export interface DatasetSummary {
  id: string;
  name: string;
}

export interface ExperimentSummary {
  id: string;
  name: string;
  datasetId: string | null;
  itemCount: number | null;
  startTime: string | null;
  metadata: Record<string, unknown>;
  /** Experiment metadata `model_<role>` entries, e.g. { enrollment: "openrouter/anthropic/claude-sonnet-5.5" }. */
  models: Record<string, string>;
}

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
  scores: Record<string, ScoreValue>;
  costUsd: number | null;
}

export interface ExperimentResult {
  experimentId: string;
  experimentName: string;
  datasetId: string | null;
  items: ItemResult[];
  passes: number;
  total: number;
  /** Requested item IDs with no experiment item in Langfuse. */
  missing: string[];
  /** Item IDs present without the pass score. */
  missingScores: string[];
  /** Sum of generation costs Langfuse recorded for the items; null when not requested or none recorded. */
  costUsd: number | null;
}

export interface ExperimentQuery {
  experimentId?: string;
  /** Names are not unique (the playground gives its claims and enrollments runs one name); an ambiguous name throws. */
  experimentName?: string;
  pass: PassRule;
  /** Only these items count, e.g. the five screening samples; absent ones are listed in `missing`. */
  itemIds?: string[];
  includeCost?: boolean;
  /** Lower bound for Langfuse's required start-time filter. Default: 30 days ago. */
  since?: Date | string;
}

export interface RecordedScore {
  name: string;
  value: ScoreValue;
  /** Inferred from the value when absent: boolean → BOOLEAN, number → NUMERIC, string → CATEGORICAL. */
  dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  comment?: string;
}

export interface RecordedItem {
  /** Dataset item ID; it must exist in the experiment's dataset. */
  itemId: string;
  /** Model that produced the output, e.g. "openrouter/deepseek/deepseek-v4-pro". */
  model: string;
  input: unknown;
  output: unknown;
  startMs: number;
  endMs: number;
  usage?: { input?: number; output?: number; total?: number };
  costUsd?: number;
  /** Set when the run failed; the root observation gets level ERROR. */
  error?: string;
  /** Per-item trace metadata, e.g. { stage: "screen", eci: 142.1 }. */
  metadata?: Metadata;
  scores: RecordedScore[];
}

export interface ExperimentRecording {
  datasetId: string;
  experimentId: string;
  experimentName: string;
  /** Experiment metadata. Put the candidate model under `model_<role>` so listExperiments reports it. */
  metadata?: Metadata;
  /** Trace and root observation name. Default "openmerit-eval". */
  traceName?: string;
  items: RecordedItem[];
}

export interface RecordedExperiment {
  experimentId: string;
  traceIds: Record<string, string>;
  url: string;
}

export interface DatasetInput {
  name: string;
  description?: string;
  metadata?: Metadata;
  /** Without an ID, an item gets one derived from the dataset name and its input, so re-pushing a file upserts. */
  items: { id?: string; input: unknown; expectedOutput: unknown; metadata?: Record<string, unknown> }[];
}

export interface LangfuseConnector {
  readonly baseUrl: string;
  check(): Promise<{ baseUrl: string; projectId: string; projectName: string }>;
  listDatasets(): Promise<DatasetSummary[]>;
  getDataset(name: string): Promise<DatasetSummary>;
  getDatasetItems(datasetName: string): Promise<EvalItem[]>;
  ensureDataset(input: DatasetInput): Promise<{ datasetId: string; itemIds: string[] }>;
  listExperiments(query?: { datasetName?: string; datasetId?: string; names?: string[]; ids?: string[]; since?: Date | string }): Promise<ExperimentSummary[]>;
  experimentResults(query: ExperimentQuery): Promise<ExperimentResult>;
  waitForExperiment(query: ExperimentQuery, options: { expectItems: number; timeoutMs?: number; intervalMs?: number }): Promise<ExperimentResult>;
  recordExperimentItems(recording: ExperimentRecording): Promise<RecordedExperiment>;
  experimentUrl(datasetId: string, experimentId: string): Promise<string>;
}

export interface ConnectorOptions extends TransportOptions {
  /** Langfuse environment for recorded traces and scores. Default "openmerit". */
  environment?: string;
}

/** Version written into recorded traces' scope. */
export const CONNECTOR_VERSION = "0.1.0";
const DAY_MS = 86_400_000;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

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

const iso = (since: Date | string | undefined, now: number): string => (since === undefined ? new Date(now - 30 * DAY_MS).toISOString() : new Date(since).toISOString());

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Trace ID of one recorded item: the first 32 hex characters of SHA-256 over its experiment and item. */
export const recordedTraceId = (experimentId: string, itemId: string): string => hexId(`openmerit:experiment:${experimentId}:item:${itemId}`, 32);

export function createLangfuseConnector(connection: LangfuseConnection, options: ConnectorOptions = {}): LangfuseConnector {
  const http = createTransport(connection, options);
  const environment = options.environment ?? "openmerit";
  if (!/^(?!langfuse)[a-z0-9_-]{1,40}$/.test(environment)) throw new LangfuseError("The Langfuse environment must be lowercase letters, digits, - or _, and must not start with 'langfuse'.");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let project: Promise<{ id: string; name: string }> | undefined;

  const get = async <T>(path: string, query?: Query, allowNotFound = false): Promise<T | null> => (await http.request<T>("GET", path, { ...(query ? { query } : {}), allowNotFound })).data;

  async function* cursorPages(path: string, query: Query): AsyncGenerator<unknown[]> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await get<{ data?: unknown; meta?: { cursor?: unknown } }>(path, { ...query, cursor });
      if (!page || !Array.isArray(page.data)) throw new LangfuseError(`Langfuse GET ${path} returned no data array.`);
      yield page.data;
      cursor = str(page.meta?.cursor) ?? undefined;
      if (cursor && seen.has(cursor)) throw new LangfuseError(`Langfuse GET ${path} repeated a pagination cursor.`);
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  async function* numberedPages(path: string, query: Query): AsyncGenerator<unknown[]> {
    for (let page = 1; ; page += 1) {
      const body = await get<{ data?: unknown; meta?: { totalPages?: unknown } }>(path, { ...query, page, limit: 100 });
      if (!body || !Array.isArray(body.data)) throw new LangfuseError(`Langfuse GET ${path} returned no data array.`);
      yield body.data;
      const total = typeof body.meta?.totalPages === "number" ? body.meta.totalPages : 0;
      if (page >= total || body.data.length === 0) return;
    }
  }

  function getProject(): Promise<{ id: string; name: string }> {
    project ??= (async () => {
      const body = await get<{ data?: unknown }>("/api/public/projects");
      const first: unknown = Array.isArray(body?.data) ? body.data[0] : undefined;
      if (!isObject(first) || !str(first.id)) throw new LangfuseError("Langfuse returned no project for this key pair. Use a project-scoped API key.");
      return { id: String(first.id), name: str(first.name) ?? "" };
    })();
    project.catch(() => (project = undefined));
    return project;
  }

  async function getDataset(name: string): Promise<DatasetSummary> {
    const body = await get<Record<string, unknown>>(`/api/public/v2/datasets/${encodeURIComponent(name)}`, undefined, true);
    if (!body || !str(body.id)) throw new LangfuseError(`Langfuse has no dataset named "${name}" in this project.`, 404);
    return { id: String(body.id), name: str(body.name) ?? name };
  }

  async function listExperiments(query: { datasetName?: string; datasetId?: string; names?: string[]; ids?: string[]; since?: Date | string } = {}): Promise<ExperimentSummary[]> {
    const datasetId = query.datasetId ?? (query.datasetName ? (await getDataset(query.datasetName)).id : undefined);
    const experiments: ExperimentSummary[] = [];
    for await (const page of cursorPages("/api/public/experiments", { fields: "core,metadata", limit: 100, fromStartTime: iso(query.since, Date.now()), datasetId, name: query.names?.join(","), id: query.ids?.join(",") })) {
      for (const raw of page) {
        if (!isObject(raw) || !str(raw.id)) continue;
        const metadata = isObject(raw.metadata) ? raw.metadata : {};
        const models: Record<string, string> = {};
        for (const [key, value] of Object.entries(metadata)) if (key.startsWith("model_") && typeof value === "string") models[key.slice("model_".length)] = value;
        experiments.push({ id: String(raw.id), name: str(raw.name) ?? "", datasetId: str(raw.datasetId), itemCount: typeof raw.itemCount === "number" ? raw.itemCount : null, startTime: str(raw.startTime), metadata, models });
      }
    }
    return experiments;
  }

  /** Latest score per name for each trace, from /api/public/v3/scores (trace- and observation-level). */
  async function scoresByTrace(traceIds: string[], name: string, since: string): Promise<Map<string, ScoreValue>> {
    const latest = new Map<string, { at: string; value: ScoreValue }>();
    for (let i = 0; i < traceIds.length; i += 40) {
      for await (const page of cursorPages("/api/public/v3/scores", { traceId: traceIds.slice(i, i + 40).join(","), name, fields: "subject", limit: 100, fromTimestamp: since })) {
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

  async function costsByTrace(traceIds: string[], since: string): Promise<Map<string, number>> {
    const costs = new Map<string, number>();
    for (let i = 0; i < traceIds.length; i += 40) {
      const filter = JSON.stringify([
        { type: "stringOptions", column: "traceId", operator: "any of", value: traceIds.slice(i, i + 40) },
        { type: "string", column: "type", operator: "=", value: "GENERATION" },
        { type: "datetime", column: "startTime", operator: ">=", value: since },
      ]);
      for await (const page of cursorPages("/api/public/v2/observations", { fields: "core,usage", limit: 100, filter })) {
        for (const raw of page) {
          if (!isObject(raw) || !str(raw.traceId) || typeof raw.totalCost !== "number" || !Number.isFinite(raw.totalCost)) continue;
          costs.set(String(raw.traceId), (costs.get(String(raw.traceId)) ?? 0) + raw.totalCost);
        }
      }
    }
    return costs;
  }

  async function experimentResults(query: ExperimentQuery): Promise<ExperimentResult> {
    if (!query.experimentId === !query.experimentName) throw new LangfuseError("Pass exactly one of experimentId or experimentName.");
    if (!query.pass?.score) throw new LangfuseError("Pass a pass rule naming the score that decides each item.");
    const since = iso(query.since, Date.now());
    const latest = new Map<string, { raw: Record<string, unknown>; at: string }>();
    const experimentIds = new Set<string>();
    let experimentName = query.experimentName ?? "";
    let datasetId: string | null = null;
    for await (const page of cursorPages("/api/public/experiment-items", { fields: "core,dataset,scores", limit: 100, scoreLimit: 50, fromStartTime: since, experimentId: query.experimentId, experimentName: query.experimentName })) {
      for (const raw of page) {
        if (!isObject(raw) || !str(raw.experimentItemId) || !str(raw.traceId)) continue;
        experimentIds.add(str(raw.experimentId) ?? "");
        experimentName = str(raw.experimentName) ?? experimentName;
        datasetId = str(raw.experimentDatasetId) ?? datasetId;
        const itemId = String(raw.experimentItemId);
        const at = str(raw.startTime) ?? "";
        const old = latest.get(itemId);
        // A retried item has several experiment items; its latest run counts.
        if (!old || at > old.at) latest.set(itemId, { raw, at });
      }
    }
    if (experimentIds.size > 1) throw new LangfuseError(`Experiment name "${query.experimentName}" matches ${experimentIds.size} experiments (${[...experimentIds].join(", ")}). Query by experimentId.`);
    const wanted = query.itemIds ? new Set(query.itemIds) : null;
    const items: ItemResult[] = [];
    for (const [itemId, { raw }] of latest) {
      if (wanted && !wanted.has(itemId)) continue;
      const scores: Record<string, { at: string; value: ScoreValue }> = {};
      for (const score of Array.isArray(raw.scores) ? raw.scores : []) {
        if (!isObject(score) || !str(score.name)) continue;
        const value = scoreValue(score);
        const at = str(score.timestamp) ?? "";
        const old = scores[String(score.name)];
        if (value !== undefined && (!old || at > old.at)) scores[String(score.name)] = { at, value };
      }
      items.push({ itemId, traceId: String(raw.traceId), passed: false, missingScore: false, scores: Object.fromEntries(Object.entries(scores).map(([name, { value }]) => [name, value])), costUsd: null });
    }
    // Experiment items list observation-level scores; scores posted on the trace come from the scores API.
    const unscored = items.filter((item) => item.scores[query.pass.score] === undefined);
    if (unscored.length) {
      const found = await scoresByTrace(unscored.map((item) => item.traceId), query.pass.score, since);
      for (const item of unscored) {
        const value = found.get(item.traceId);
        if (value !== undefined) item.scores[query.pass.score] = value;
      }
    }
    for (const item of items) {
      const value = item.scores[query.pass.score];
      item.missingScore = value === undefined;
      item.passed = evaluatePass(query.pass, value);
    }
    let costUsd: number | null = null;
    if (query.includeCost && items.length) {
      const costs = await costsByTrace(items.map((item) => item.traceId), since);
      for (const item of items) item.costUsd = costs.get(item.traceId) ?? null;
      costUsd = costs.size ? [...costs.values()].reduce((sum, cost) => sum + cost, 0) : null;
    }
    items.sort((a, b) => a.itemId.localeCompare(b.itemId));
    return {
      experimentId: query.experimentId ?? [...experimentIds][0] ?? "",
      experimentName,
      datasetId,
      items,
      passes: items.filter((item) => item.passed).length,
      total: items.length,
      missing: query.itemIds ? query.itemIds.filter((id) => !latest.has(id)) : [],
      missingScores: items.filter((item) => item.missingScore).map((item) => item.itemId),
      costUsd,
    };
  }

  async function experimentUrl(datasetId: string, experimentId: string): Promise<string> {
    const { id } = await getProject();
    return `${http.baseUrl}/project/${encodeURIComponent(id)}/datasets/${encodeURIComponent(datasetId)}/runs/${encodeURIComponent(experimentId)}`;
  }

  return {
    baseUrl: http.baseUrl,

    async check() {
      const { id, name } = await getProject();
      return { baseUrl: http.baseUrl, projectId: id, projectName: name };
    },

    async listDatasets() {
      const datasets: DatasetSummary[] = [];
      for await (const page of numberedPages("/api/public/v2/datasets", {})) for (const raw of page) if (isObject(raw) && str(raw.id) && str(raw.name)) datasets.push({ id: String(raw.id), name: String(raw.name) });
      return datasets;
    },

    getDataset,

    async getDatasetItems(datasetName) {
      const items: EvalItem[] = [];
      for await (const page of numberedPages("/api/public/dataset-items", { datasetName })) {
        for (const raw of page) {
          if (!isObject(raw) || !str(raw.id) || raw.status === "ARCHIVED") continue;
          items.push({ id: String(raw.id), input: raw.input ?? null, expectedOutput: raw.expectedOutput ?? null, metadata: isObject(raw.metadata) ? raw.metadata : {} });
        }
      }
      return items;
    },

    async ensureDataset(input) {
      if (!input.name?.trim()) throw new LangfuseError("A dataset needs a name.");
      const existing = await http.request<Record<string, unknown>>("GET", `/api/public/v2/datasets/${encodeURIComponent(input.name)}`, { allowNotFound: true });
      const dataset = existing.data ?? (await http.request<Record<string, unknown>>("POST", "/api/public/v2/datasets", { body: { name: input.name, description: input.description, metadata: input.metadata } })).data;
      if (!isObject(dataset) || !str(dataset.id)) throw new LangfuseError(`Langfuse returned no ID for dataset "${input.name}".`);
      const itemIds: string[] = [];
      for (const item of input.items) {
        const id = item.id ?? `om-${hexId(`${input.name}\n${stable(item.input)}`, 16)}`;
        // Upserts by ID. Langfuse item IDs are unique per project, so reuse an ID in one dataset only.
        await http.request("POST", "/api/public/dataset-items", { body: { datasetName: input.name, id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata } });
        itemIds.push(id);
      }
      return { datasetId: String(dataset.id), itemIds };
    },

    listExperiments,
    experimentResults,

    async waitForExperiment(query, { expectItems, timeoutMs = 600_000, intervalMs = 15_000 }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await experimentResults(query);
        const scored = result.total - result.missingScores.length;
        if (scored >= expectItems) return result;
        if (Date.now() + intervalMs > deadline) {
          throw new LangfuseError(`Langfuse shows ${scored}/${expectItems} scored items for experiment ${query.experimentId ?? query.experimentName} after ${Math.round(timeoutMs / 1000)} s (missing items: ${result.missing.join(", ") || "none"}; unscored: ${result.missingScores.join(", ") || "none"}).`);
        }
        await sleep(intervalMs);
      }
    },

    async recordExperimentItems(recording) {
      const { datasetId, experimentId, experimentName } = recording;
      if (![datasetId, experimentId, experimentName].every((value) => typeof value === "string" && value.trim())) throw new LangfuseError("A recording needs datasetId, experimentId and experimentName.");
      if (!recording.items.length) throw new LangfuseError("A recording needs at least one item.");
      const traceName = recording.traceName ?? "openmerit-eval";
      const traceIds: Record<string, string> = {};
      const spans: OtlpSpan[] = [];
      const scores: Record<string, unknown>[] = [];
      for (const item of recording.items) {
        if (traceIds[item.itemId]) throw new LangfuseError(`Item ${item.itemId} appears twice in one recording.`);
        const traceId = recordedTraceId(experimentId, item.itemId);
        const rootId = hexId(`${traceId}:root`, 16);
        traceIds[item.itemId] = traceId;
        const common = [
          attribute("langfuse.trace.name", traceName),
          attribute("langfuse.trace.tags", ["openmerit", `experiment:${experimentId}`]),
          attribute("langfuse.environment", environment),
          attribute("langfuse.release", `openmerit-langfuse-connector@${CONNECTOR_VERSION}`),
          attribute("langfuse.trace.metadata.model", item.model),
          ...Object.entries(item.metadata ?? {}).map(([key, value]) => attribute(`langfuse.trace.metadata.${key}`, String(value))),
        ];
        spans.push(
          span({
            traceId, spanId: rootId, name: traceName, startMs: item.startMs, endMs: item.endMs, ...(item.error ? { error: item.error } : {}),
            attributes: [
              ...common,
              attribute("langfuse.observation.type", "span"),
              attribute("langfuse.observation.input", asText(item.input)),
              attribute("langfuse.observation.output", asText(item.output ?? null)),
              ...(item.error ? [attribute("langfuse.observation.level", "ERROR"), attribute("langfuse.observation.status_message", item.error.slice(0, 500))] : []),
              attribute("langfuse.experiment.id", experimentId),
              attribute("langfuse.experiment.name", experimentName),
              attribute("langfuse.experiment.dataset.id", datasetId),
              attribute("langfuse.experiment.item.id", item.itemId),
              attribute("langfuse.experiment.item.root_observation_id", rootId),
              ...Object.entries(recording.metadata ?? {}).map(([key, value]) => attribute(`langfuse.experiment.metadata.${key}`, String(value))),
            ],
          }),
          span({
            traceId, spanId: hexId(`${traceId}:generation`, 16), parentSpanId: rootId, name: `${traceName}-model`, startMs: item.startMs, endMs: item.endMs, ...(item.error ? { error: item.error } : {}),
            attributes: [
              ...common,
              attribute("langfuse.observation.type", "generation"),
              attribute("langfuse.observation.model.name", item.model),
              ...(item.usage ? [attribute("langfuse.observation.usage_details", JSON.stringify(item.usage))] : []),
              ...(item.costUsd !== undefined ? [attribute("langfuse.observation.cost_details", JSON.stringify({ total: item.costUsd }))] : []),
            ],
          }),
        );
        for (const score of item.scores) {
          const dataType = score.dataType ?? (typeof score.value === "boolean" ? "BOOLEAN" : typeof score.value === "number" ? "NUMERIC" : "CATEGORICAL");
          const value = typeof score.value === "boolean" ? (score.value ? 1 : 0) : score.value;
          if (dataType === "CATEGORICAL" ? typeof value !== "string" : typeof value !== "number" || !Number.isFinite(value)) throw new LangfuseError(`Score ${score.name} on item ${item.itemId} has a ${typeof score.value} value for data type ${dataType}.`);
          // A deterministic ID makes a retried recording update the score instead of adding a second one.
          scores.push({ id: hexId(`openmerit:score:${traceId}:${score.name}`, 32), traceId, observationId: rootId, name: score.name, value, dataType, environment, ...(score.comment ? { comment: score.comment.slice(0, 1000) } : {}), metadata: { source: "openmerit", experiment: experimentId } });
        }
      }
      for (let i = 0; i < spans.length; i += 200) {
        const response = await http.request<{ partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown } }>("POST", "/api/public/otel/v1/traces", { body: exportRequest(spans.slice(i, i + 200), CONNECTOR_VERSION), headers: { "x-langfuse-ingestion-version": "4" } });
        const rejected = Number(response.data?.partialSuccess?.rejectedSpans ?? 0);
        if (rejected > 0) throw new LangfuseError(`Langfuse rejected ${rejected} spans: ${String(response.data?.partialSuccess?.errorMessage ?? "").slice(0, 300)}`);
      }
      for (let i = 0; i < scores.length; i += 100) {
        const response = await http.request<{ rejected?: unknown; errors?: unknown }>("POST", "/api/public/scores", { body: scores.slice(i, i + 100) });
        // 207 reports rejected scores with a 2xx status; Langfuse asks clients not to retry the batch.
        if (response.status === 207) throw new LangfuseError(`Langfuse rejected some scores (HTTP 207): ${JSON.stringify(response.data?.errors ?? response.data).slice(0, 300)}`, 207);
      }
      return { experimentId, traceIds, url: await experimentUrl(datasetId, experimentId) };
    },

    experimentUrl,
  };
}
