/** Strategist: pick the next untried model to trial, benchmark-aware. */

import { directChatClient } from "./llm.js";
import { parseObj } from "./judge.js";
import type { CatalogEntry, ModelRoute, TrialPoint } from "./types.js";
import type { MeritChatClient } from "./providers.js";
import { routeKey, routeLabel } from "./routes.js";

export const STRAT_PREFS = [
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-4o",
];

const STRAT_PROMPT = `We are finding the best configured model route for a task via iterative trials.
TASK: {task}
RUBRIC: {rubric}
RELEVANT PUBLIC BENCHMARKS FOR THIS TASK: {benchmarks}
RESULTS SO FAR (model=score): {results}
Pick ONE untried model from the catalog below that is likely to do well on this
task, based on the benchmarks relevant to it. Balance quality against price so
a pareto frontier emerges.
Return ONLY json: {{"next_model": "<route id>", "why": "<one line>"}}
ROUTES (route id | logical model | blended $/1M tokens | ctx):
{catalog}`;

export interface StratPick {
  model: string;
  route?: ModelRoute;
  why: string;
}

/** Pick the next model to trial, or null when the catalog is exhausted. */
export async function pickNext(
  key: string,
  stratModel: string | ModelRoute,
  task: string,
  rubric: string,
  benchmarks: string[],
  results: TrialPoint[],
  cat: Map<string, CatalogEntry>,
  tried: Set<string>,
  maxPrice: number,
  failedVendors: Set<string>,
  extraCandidates?: string[],
  client: MeritChatClient = directChatClient(key),
): Promise<StratPick | null> {
  const entryKey = (c: CatalogEntry) => c.route ? routeKey(c.route) : c.id;
  const ok = (c: CatalogEntry) =>
    c.priceKnown !== false && c.price <= maxPrice &&
    !tried.has(entryKey(c)) &&
    c.ctx >= 4096 &&
    !failedVendors.has(c.route?.provider ?? c.id.split("/")[0]);

  // Benchmark-shortlisted models get priority in the listing.
  const pool = [...cat.values()].filter(ok);
  if (pool.length === 0) return null;
  const priority = new Set(extraCandidates ?? []);
  pool.sort((a, b) => {
    const pa = priority.has(a.id) ? 0 : 1;
    const pb = priority.has(b.id) ? 0 : 1;
    return pa - pb || (a.priceKnown === false ? 1 : 0) - (b.priceKnown === false ? 1 : 0) || a.price - b.price;
  });

  const lines = pool
    .map((c) => `${entryKey(c)} | ${c.route ? routeLabel(c.route) : c.id} | ` +
      `${c.priceKnown === false ? "unknown" : c.price.toFixed(2)} | ${c.ctx}${priority.has(c.id) ? " | BENCHMARK" : ""}`)
    .join("\n");
  const res =
    results
      .map((r) => `${r.model}=${r.score.toFixed(2)}`)
      .join("  ") || "none yet";

  const { content } = await client.chat(
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
    const entry = cat.get(pick) ?? [...cat.values()].find((candidate) => candidate.id === pick);
    if (entry && ok(entry)) return { model: entry.id, route: entry.route, why };
  }

  const cheapest = pool[0];
  return { model: cheapest.id, route: cheapest.route,
    why: `fallback pick: cheapest untried (strategist pick ${pick ?? "none"} unusable)` };
}
