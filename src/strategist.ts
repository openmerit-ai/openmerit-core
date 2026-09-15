/** Strategist: pick the next untried model to trial, benchmark-aware. */

import { chat } from "./llm.js";
import { parseObj } from "./judge.js";
import type { CatalogEntry, TrialPoint } from "./types.js";

export const STRAT_PREFS = [
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-4o",
];

const STRAT_PROMPT = `We are finding the best OpenRouter model for a task via iterative trials.
TASK: {task}
RUBRIC: {rubric}
RELEVANT PUBLIC BENCHMARKS FOR THIS TASK: {benchmarks}
RESULTS SO FAR (model=score): {results}
Pick ONE untried model from the catalog below that is likely to do well on this
task, based on the benchmarks relevant to it. Balance quality against price so
a pareto frontier emerges.
Return ONLY json: {{"next_model": "<catalog id>", "why": "<one line>"}}
CATALOG (id | blended $/1M tokens | ctx):
{catalog}`;

export interface StratPick {
  model: string;
  why: string;
}

/** Pick the next model to trial, or null when the catalog is exhausted. */
export async function pickNext(
  key: string,
  stratModel: string,
  task: string,
  rubric: string,
  benchmarks: string[],
  results: TrialPoint[],
  cat: Map<string, CatalogEntry>,
  tried: Set<string>,
  maxPrice: number,
  failedVendors: Set<string>,
  extraCandidates?: string[],
): Promise<StratPick | null> {
  const ok = (c: CatalogEntry) =>
    c.price <= maxPrice &&
    !tried.has(c.id) &&
    c.ctx >= 4096 &&
    !failedVendors.has(c.id.split("/")[0]);

  // New releases queued by the catalog watcher get priority in the listing.
  const pool = [...cat.values()].filter(ok);
  if (pool.length === 0) return null;
  const priority = new Set(extraCandidates ?? []);
  pool.sort((a, b) => {
    const pa = priority.has(a.id) ? 0 : 1;
    const pb = priority.has(b.id) ? 0 : 1;
    return pa - pb || a.price - b.price;
  });

  const lines = pool
    .map((c) => `${c.id} | ${c.price.toFixed(2)} | ${c.ctx}${priority.has(c.id) ? " | NEW" : ""}`)
    .join("\n");
  const res =
    results
      .map((r) => `${r.model}=${r.score.toFixed(2)}`)
      .join("  ") || "none yet";

  const { content } = await chat(
    key,
    stratModel,
    STRAT_PROMPT.replace("{task}", task)
      .replace("{rubric}", rubric)
      .replace("{benchmarks}", benchmarks.join(", "))
      .replace("{results}", res)
      .replace("{catalog}", lines),
    1024,
    0.2,
  );

  let pick: string | null = null;
  let why = "unparseable strategist output";
  try {
    const obj = parseObj(content);
    pick = typeof obj.next_model === "string" ? obj.next_model : null;
    why = String(obj.why ?? "");
  } catch {
    /* fall through to cheap pick */
  }
  if (pick) {
    const entry = cat.get(pick);
    if (entry && ok(entry)) return { model: pick, why };
  }

  const cheapest = pool[0];
  return { model: cheapest.id, why: `fallback pick: cheapest untried (strategist pick ${pick ?? "none"} unusable)` };
}
