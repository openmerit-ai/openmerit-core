/**
 * Public benchmark signals.
 *
 * Two jobs:
 *  1. Map a task to the public benchmarks that matter for it (so the
 *     strategist and the user know why a candidate is "worth testing").
 *  2. Provide a prior score for a model from a benchmark digest, so a newly
 *     released model can be ranked against the existing frontier before we
 *     spend money on shadow trials.
 *
 * The digest lives at ~/.openmerit/benchmarks/digest.json and is a simple
 * map: { "vendor/model": { "benchmark_name": score_0_to_100, ... }, ... }.
 * Refresh it from public leaderboards (LMArena, Artificial Analysis,
 * SWE-bench, ...) however you like; a small seed ships below so the system
 * works offline.
 */

import { paths, readJson, writeJson } from "./store.js";
import type { CatalogEntry } from "./types.js";

/** Task category -> public benchmarks that are predictive for it. */
export const TASK_BENCHMARKS: Record<string, string[]> = {
  code: ["SWE-bench Verified", "HumanEval", "LMArena Code", "Aider Polyglot"],
  agentic: ["SWE-bench Verified", "tau2-bench", "Terminal-Bench", "BrowseComp"],
  knowledge: ["MMLU", "GPQA Diamond", "SimpleQA"],
  math: ["MATH-500", "AIME", "HMMT"],
  instruction: ["IFEval", "FollowBench"],
  multimodal: ["MMMU", "MathVista", "DocVQA"],
  long_context: ["RULER", "MRCR", "LongBench"],
  general: ["LMArena Overall", "MMLU", "IFEval"],
};

/** Guess the task category from its text (deliberately simple keyword scan). */
export function categorizeTask(taskText: string): string {
  const t = taskText.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has("image", "invoice", "screenshot", "ocr", "vision", "pdf page", "photo")) return "multimodal";
  if (has("agent", "tool call", "terminal", "browse", "multi-step", "workflow")) return "agentic";
  if (has("function", "code", "python", "typescript", "bug", "refactor", "compile", "sql")) return "code";
  if (has("prove", "equation", "math", "integral", "probability", "aime")) return "math";
  if (has("summarize", "extract", "format", "json", "follow the format", "instruction")) return "instruction";
  if (has("who ", "what is", "explain", "history", "science")) return "knowledge";
  return "general";
}

export interface Digest {
  updatedAt: string;
  /** model id -> benchmark name -> score 0..100 */
  scores: Record<string, Record<string, number>>;
}

/** Small offline seed; overwrite/extend via `openmerit benchmarks import <file>`. */
export const SEED_DIGEST: Digest = {
  updatedAt: "2026-09-01T00:00:00.000Z",
  scores: {},
};

export function loadDigest(): Digest {
  return readJson<Digest>(paths.benchmarksDigest(), SEED_DIGEST);
}

export function saveDigest(d: Digest): void {
  writeJson(paths.benchmarksDigest(), d);
}

/**
 * Prior 0..1 for a model on a task category, from the digest. Averages the
 * category's benchmarks the model has scores for; returns null when the
 * digest knows nothing about this model.
 */
export function benchmarkPrior(taskCategory: string, modelId: string, digest: Digest): number | null {
  const benches = TASK_BENCHMARKS[taskCategory] ?? TASK_BENCHMARKS.general;
  const modelScores = digest.scores[modelId];
  if (!modelScores) return null;
  const hits = benches
    .map((b) => modelScores[b])
    .filter((s): s is number => typeof s === "number");
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => a + b, 0) / hits.length / 100;
}

/**
 * Which benchmarks should we check when a NEW model appears for this task?
 * Returns the list to display in "worth testing" reasoning.
 */
export function relevantBenchmarks(taskText: string): { category: string; benchmarks: string[] } {
  const category = categorizeTask(taskText);
  return { category, benchmarks: TASK_BENCHMARKS[category] ?? TASK_BENCHMARKS.general };
}

/** Live OpenRouter benchmark scores shortlist candidates; task trials still decide quality. */
export async function openRouterBenchmarkCandidates(
  key: string, category: string, catalog: Map<string, CatalogEntry>,
): Promise<string[]> {
  const metric = category === "code" ? "coding_index"
    : category === "agentic" ? "agentic_index" : "intelligence_index";
  const response = await fetch("https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`OpenRouter benchmarks HTTP ${response.status}`);
  const payload = await response.json() as { data?: Record<string, unknown>[] };
  return (payload.data ?? [])
    .map((row) => ({ id: String(row.model_permaslug ?? ""), score: Number(row[metric]) }))
    .filter((row) => catalog.has(row.id) && Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20).map((row) => row.id);
}
