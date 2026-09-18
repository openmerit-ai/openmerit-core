/** Provider-neutral public benchmark snapshots. */
import { appendJsonl, paths, readJsonl } from "./store.js";
import { log } from "./logger.js";
import type { ModelRoute, TaskIntent } from "./types.js";
import { routeKey } from "./routes.js";

export interface PublicBenchmarkPoint {
  schemaVersion: 1;
  source: string;
  benchmark?: string;
  taskType?: string;
  model: string;
  scores: Record<string, number>;
  pricing?: { input?: number; output?: number };
  asOf?: string;
  fetchedAt: string;
}

export interface PublicBenchmarkSource {
  readonly id: string;
  fetch(options?: { taskType?: string; maxResults?: number }): Promise<PublicBenchmarkPoint[]>;
}

interface OpenRouterResponse { data?: Record<string, unknown>[]; meta?: { as_of?: string } }

/** OpenRouter's unified /api/v1/benchmarks endpoint. */
export class OpenRouterBenchmarkSource implements PublicBenchmarkSource {
  readonly id = "openrouter";
  constructor(private readonly apiKey = process.env.OPENROUTER_API_KEY, private readonly baseUrl = "https://openrouter.ai/api/v1") {}

  async fetch(options: { taskType?: string; maxResults?: number } = {}): Promise<PublicBenchmarkPoint[]> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is required for public benchmark discovery");
    const query = new URLSearchParams();
    if (options.taskType) query.set("task_type", options.taskType);
    if (options.maxResults) query.set("max_results", String(options.maxResults));
    const response = await fetch(`${this.baseUrl}/benchmarks${query.size ? `?${query}` : ""}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new Error(`OpenRouter benchmarks request failed (${response.status})`);
    const payload = await response.json() as OpenRouterResponse;
    const fetchedAt = new Date().toISOString();
    return (payload.data ?? []).flatMap((item) => {
      const model = typeof item.model_permaslug === "string" ? item.model_permaslug : null;
      if (!model) return [];
      const scores = Object.fromEntries(Object.entries(item).filter(([key, value]) =>
        key.endsWith("_index") || key.endsWith("_score") || key === "elo")
        .filter(([, value]) => typeof value === "number")) as Record<string, number>;
      return [{ schemaVersion: 1 as const, source: this.id, benchmark: typeof item.source === "string" ? item.source : undefined,
        taskType: options.taskType, model, scores,
        pricing: item.pricing && typeof item.pricing === "object" ? {
          input: Number((item.pricing as Record<string, unknown>).prompt),
          output: Number((item.pricing as Record<string, unknown>).completion),
        } : undefined,
        asOf: payload.meta?.as_of, fetchedAt }];
    });
  }
}

export function savePublicBenchmark(points: PublicBenchmarkPoint[]): void {
  for (const point of points) appendJsonl(paths.publicBenchmarks(), point);
}

export function listPublicBenchmarks(): PublicBenchmarkPoint[] {
  return readJsonl<PublicBenchmarkPoint>(paths.publicBenchmarks());
}

/** Return deterministic public-prior ordering for routes already available in the harness. */
export function publicPriorModels(routes: ModelRoute[], taskOrIntent: string | TaskIntent): string[] {
  let type: string | undefined;
  if (typeof taskOrIntent === "object" && taskOrIntent !== null) {
    const category = taskOrIntent.category?.toLowerCase();
    const modalities = taskOrIntent.inputModalities ?? [];
    if (category === "coding") {
      type = "coding";
    } else if (category === "extraction" || category === "classification" || modalities.includes("image")) {
      type = "intelligence";
    } else if (taskOrIntent.purpose) {
      log("debug", "public_benchmarks", "fallback_regex", "inferring task type from intent purpose string", { purpose: taskOrIntent.purpose });
      type = /image|invoice|ocr|visual/i.test(taskOrIntent.purpose) ? "intelligence" :
        /code|coding|typescript|javascript|sql/i.test(taskOrIntent.purpose) ? "coding" : undefined;
    }
  } else if (typeof taskOrIntent === "string") {
    log("debug", "public_benchmarks", "fallback_regex", "inferring task type from raw task text", { task: taskOrIntent });
    type = /image|invoice|ocr|visual/i.test(taskOrIntent) ? "intelligence" :
      /code|coding|typescript|javascript|sql/i.test(taskOrIntent) ? "coding" : undefined;
  }
  const scores = new Map<string, number>();
  for (const point of listPublicBenchmarks()) {
    if (type && point.taskType && point.taskType !== type) continue;
    const score = Math.max(0, ...Object.values(point.scores));
    if (score > (scores.get(point.model) ?? -Infinity)) scores.set(point.model, score);
  }
  return routes.filter((route) => scores.has(route.meritId))
    .sort((a, b) => (scores.get(b.meritId)! - scores.get(a.meritId)!) || a.meritId.localeCompare(b.meritId))
    .map((route) => routeKey(route));
}
