/** Provider-neutral public benchmark snapshots. */
import { appendJsonl, paths, readJsonl } from "./store.js";

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
