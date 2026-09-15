/** Pareto frontier over (score up, price down, latency down) + best-fit/fallback picks. */

import type { TrialPoint } from "./types.js";

/** a dominates b if a is no worse on every objective and strictly better on one. */
export function dominates(a: TrialPoint, b: TrialPoint): boolean {
  const aLat = a.latencyMs ?? Number.POSITIVE_INFINITY;
  const bLat = b.latencyMs ?? Number.POSITIVE_INFINITY;
  const noWorse = a.score >= b.score && a.price <= b.price && aLat <= bLat;
  const better = a.score > b.score || a.price < b.price || aLat < bLat;
  return noWorse && better;
}

/**
 * Non-dominated set, cheapest first. When no point carries latency this
 * reduces to the classic "strictly increasing score as price rises" chain
 * from the original model-search prototype.
 */
export function paretoFrontier(points: TrialPoint[]): TrialPoint[] {
  const fr = points.filter(
    (p) => !points.some((q) => q !== p && dominates(q, p)),
  );
  return fr.sort((a, b) => a.price - b.price || b.score - a.score);
}

/** Simple 2-objective chain (score vs price only), cheapest first. */
export function scorePriceChain(points: TrialPoint[]): TrialPoint[] {
  const pts = [...points].sort((a, b) => a.price - b.price || b.score - a.score);
  const chain: TrialPoint[] = [];
  let best = -1;
  for (const p of pts) {
    if (p.score > best) {
      chain.push(p);
      best = p.score;
    }
  }
  return chain;
}

/** Highest score; ties broken by lower price then lower latency. */
export function pickBest(points: TrialPoint[]): TrialPoint | undefined {
  return [...points].sort(
    (a, b) => b.score - a.score || a.price - b.price || (a.latencyMs ?? 1e18) - (b.latencyMs ?? 1e18),
  )[0];
}

/**
 * Fallback for `best`: prefer the cheapest frontier point that still clears
 * `minScore`; otherwise the next-best scoring point overall. Never returns
 * `best` itself.
 */
export function pickFallback(
  points: TrialPoint[],
  best: TrialPoint,
  minScore: number,
): TrialPoint | undefined {
  const others = points.filter((p) => p.model !== best.model);
  if (others.length === 0) return undefined;
  const fr = paretoFrontier(others).filter((p) => p.score >= minScore);
  if (fr.length > 0) return fr[0]; // cheapest adequate frontier point
  return pickBest(others);
}
