/** Provider-neutral standalone task trials executed through Pi routes. */

import { readFileSync } from "node:fs";
import { openRouterBenchmarkCandidates, relevantBenchmarks } from "./benchmarks.js";
import { fetchCatalog, saveSnapshot } from "./catalog.js";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { JUDGE_PREFS } from "./judge.js";
import { loadKey, PiCliChatClient } from "./llm.js";
import { availablePiRoutes, PiHarnessAdapter, recordedActiveTask, runPiTrial, scorePiRun } from "./pi-trials.js";
import { loadPolicy, providerAllowed, type Policy } from "./policy.js";
import { buildRecommendation } from "./recommend.js";
import { applyRouteOverrides, enrichRouteEntry, routeCatalog, routeKey, routeLabel } from "./routes.js";
import { appendJsonl, paths, readJson, taskKey } from "./store.js";
import { pickNext, STRAT_PREFS } from "./strategist.js";
import { budgetOk, recordMeritSpend, recordTrialSpend, trialBudgetOk } from "./trials.js";
import type { CatalogEntry, ModelRoute, Recommendation, TrialPoint } from "./types.js";

export interface StandaloneTrialConfig {
  task: string;
  eval: string;
  /** Backward-compatible logical vendor/model id or provider:model route key. */
  initial_model: string;
  /** Optional exact route when the same logical model is exposed by multiple providers. */
  initial_route?: string | { provider: string; modelId?: string; model_id?: string };
  judge_model?: string;
  strategist_model?: string;
  max_usd_per_m?: number;
  cwd?: string;
}

export interface StandaloneTrialResult {
  points: TrialPoint[];
  recommendation: Recommendation | null;
}

function optionalOpenRouterKey(): string | null {
  try { return loadKey(); } catch { return null; }
}

function configuredRoutes(policy: Policy): { routes: ModelRoute[]; currentRoute: ModelRoute | null } {
  const state = readJson<{ routes?: ModelRoute[]; currentRoute?: ModelRoute | null }>(paths.harnessState(), {});
  let routes = state.routes?.length ? state.routes : availablePiRoutes(undefined, policy.pi.provider_extensions);
  if (state.currentRoute && !routes.some((route) => routeKey(route) === routeKey(state.currentRoute!)))
    routes = [state.currentRoute, ...routes];
  routes = applyRouteOverrides(routes, policy.route_overrides);
  const unique = new Map(routes.map((route) => [routeKey(route), route]));
  const currentRoute = state.currentRoute
    ? applyRouteOverrides([state.currentRoute], policy.route_overrides)[0] : null;
  return { routes: [...unique.values()], currentRoute };
}

function selectorKey(selector: StandaloneTrialConfig["initial_route"]): string | null {
  if (!selector) return null;
  if (typeof selector === "string") return selector;
  const modelId = selector.modelId ?? selector.model_id;
  return selector.provider && modelId ? `${selector.provider}:${modelId}` : null;
}

function matchingEntries(cat: Map<string, CatalogEntry>, selector: string): CatalogEntry[] {
  const exact = cat.get(selector);
  if (exact) return [exact];
  return [...cat.values()].filter((entry) =>
    entry.id === selector || entry.route?.meritId === selector ||
    (entry.route && `${entry.route.provider}/${entry.route.modelId}` === selector));
}

function resolveInitial(
  cat: Map<string, CatalogEntry>, cfg: StandaloneTrialConfig, currentRoute: ModelRoute | null,
): CatalogEntry {
  const exactKey = selectorKey(cfg.initial_route);
  if (cfg.initial_route && !exactKey) throw new Error("initial_route must include provider and modelId");
  if (exactKey) {
    const exact = cat.get(exactKey);
    if (!exact) throw new Error(`initial route ${exactKey} is not eligible in Pi`);
    if (cfg.initial_model !== exact.id && cfg.initial_model !== exactKey)
      throw new Error(`initial_route ${exactKey} resolves to ${exact.id}, not initial_model ${cfg.initial_model}`);
    return exact;
  }
  const matches = matchingEntries(cat, cfg.initial_model);
  if (matches.length === 0) throw new Error(`initial_model ${cfg.initial_model} is not eligible in Pi`);
  if (matches.length === 1) return matches[0];
  if (currentRoute) {
    const current = matches.find((entry) => entry.route && routeKey(entry.route) === routeKey(currentRoute));
    if (current) return current;
  }
  throw new Error(`initial_model ${cfg.initial_model} has multiple Pi routes; set initial_route to one of: ` +
    matches.map((entry) => routeKey(entry.route!)).join(", "));
}

function resolveMeritRoute(
  cat: Map<string, CatalogEntry>, prefs: (string | null | undefined)[], label: string,
): CatalogEntry {
  for (const pref of prefs) {
    if (!pref) continue;
    const matches = matchingEntries(cat, pref);
    if (matches.length) return matches.sort((a, b) =>
      (a.priceKnown === false ? 1 : 0) - (b.priceKnown === false ? 1 : 0) || a.price - b.price)[0];
  }
  for (const pref of prefs) {
    if (!pref) continue;
    const fuzzy = [...cat.values()].find((entry) => entry.id.includes(pref));
    if (fuzzy) return fuzzy;
  }
  const fallback = [...cat.values()].sort((a, b) =>
    (a.priceKnown === false ? 1 : 0) - (b.priceKnown === false ? 1 : 0) || a.price - b.price)[0];
  if (fallback) return fallback;
  throw new Error(`could not resolve ${label} route from Pi's eligible models`);
}

async function buildCatalog(routes: ModelRoute[], key: string | null): Promise<Map<string, CatalogEntry>> {
  let cat = routeCatalog(routes);
  if (!key) return cat;
  try {
    const live = await fetchCatalog(key);
    saveSnapshot(live);
    cat = new Map([...cat].map(([id, entry]) => [id,
      entry.route?.provider === "openrouter" ? enrichRouteEntry(entry, live.get(entry.id)) : entry]));
  } catch (error) {
    console.log(`OpenRouter enrichment unavailable: ${(error as Error).message}`);
  }
  return cat;
}

export async function runStandaloneTrial(taskFile: string, rounds: number): Promise<StandaloneTrialResult> {
  const cfg = JSON.parse(readFileSync(taskFile, "utf8")) as StandaloneTrialConfig;
  if (!cfg.task?.trim() || !cfg.eval?.trim() || !cfg.initial_model?.trim())
    throw new Error("task JSON requires task, eval, and initial_model");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");

  const policy = loadPolicy(paths.policy());
  const key = optionalOpenRouterKey();
  const { routes, currentRoute } = configuredRoutes(policy);
  let cat = await buildCatalog(routes, key);
  for (const [id, entry] of [...cat]) {
    if (!entry.route || !providerAllowed(policy, entry.id, entry.route.provider) ||
        (entry.priceKnown !== false && entry.price > (cfg.max_usd_per_m ?? policy.max_usd_per_m))) cat.delete(id);
  }
  if (cat.size === 0) throw new Error("Pi exposes no model routes allowed by the current policy");

  const initial = resolveInitial(cat, cfg, currentRoute);
  const judge = resolveMeritRoute(cat, [cfg.judge_model, policy.judge_model, ...JUDGE_PREFS, initial.id], "judge");
  const strategist = resolveMeritRoute(cat,
    [cfg.strategist_model, policy.strategist_model, ...STRAT_PREFS, initial.id], "strategist");
  const client = new PiCliChatClient(undefined, recordMeritSpend, policy.pi.provider_extensions);
  const harness = new PiHarnessAdapter(policy.pi.provider_extensions);
  const { category, benchmarks } = relevantBenchmarks(cfg.task);
  let benchmarkCandidates: string[] = [];
  if (key) {
    try {
      benchmarkCandidates = await openRouterBenchmarkCandidates(key, category,
        new Map([...cat.values()].map((entry) => [entry.id, entry])));
    } catch (error) {
      console.log(`OpenRouter benchmark shortlist unavailable: ${(error as Error).message}`);
    }
  }
  console.log(`routes: ${cat.size} eligible in Pi${key ? " (OpenRouter enrichment enabled)" : ""}`);
  console.log(`initial: ${routeLabel(initial.route!)} | judge: ${routeLabel(judge.route!)} | ` +
    `strategist: ${routeLabel(strategist.route!)} | benchmarks: ${benchmarks.join(", ")}`);

  const tKey = taskKey(cfg.task);
  const tried = new Set<string>();
  const results: TrialPoint[] = [];
  const failedProviders = new Set<string>();

  for (let i = 0; i < rounds; i++) {
    const daily = budgetOk(policy);
    if (!daily.ok) {
      console.log(`budget: ${daily.reason}; stopping`);
      break;
    }
    let entry: CatalogEntry;
    let why: string;
    if (i === 0) {
      entry = initial;
      why = "initial route";
    } else {
      const pick = await pickNext(key ?? "", strategist.route!, cfg.task, cfg.eval, benchmarks,
        results, cat, tried, cfg.max_usd_per_m ?? policy.max_usd_per_m,
        failedProviders, benchmarkCandidates, client);
      if (!pick) break;
      entry = pick.route ? cat.get(routeKey(pick.route))! : cat.get(pick.model)!;
      why = pick.why;
    }
    const route = entry.route!;
    const keyForRoute = routeKey(route);
    if (tried.has(keyForRoute)) break;
    if (i > 0) {
      const admission = trialBudgetOk(policy, entry, cfg.task.length);
      if (!admission.ok) {
        tried.add(keyForRoute);
        console.log(`[round ${i + 1}/${rounds}] ${routeLabel(route)} skipped: ${admission.reason}`);
        continue;
      }
    }
    console.log(`[round ${i + 1}/${rounds}] ${routeLabel(route)} (${why}) ...`);
    const observed = i === 0 ? recordedActiveTask(cfg.task, route) : null;
    if (i === 0) console.log(observed
      ? "    using the exact provider route from Pi's active session trace"
      : "    active trace unavailable; running the initial route in a fresh Pi session");
    const outcome = observed
      ? await scorePiRun(key ?? "", judge.route!, cfg.task, cfg.eval, entry.id, entry,
          observed, "trace", [], client)
      : await runPiTrial(key ?? "", judge.route!, cfg.task, cfg.eval, entry.id, entry,
          cfg.cwd ?? process.cwd(), [], [], harness, client);
    tried.add(keyForRoute);
    results.push(outcome.point);
    // Reusing the active Pi answer is observation, not a new candidate call.
    if (!observed) recordTrialSpend(outcome.costUsd);
    appendJsonl(paths.trials(), { ...outcome.point, taskKey: tKey });
    if (outcome.sessionId) console.log(`    pi trace session: ${outcome.sessionId}`);
    if (outcome.error) {
      failedProviders.add(route.provider);
      console.log(`    FAILED: ${outcome.error.slice(0, 160)}`);
    } else {
      const price = outcome.point.priceKnown === false ? "price unknown" : `$${outcome.point.price}/M`;
      console.log(`    score=${outcome.point.score.toFixed(2)}  ${price}  ` +
        `run=$${outcome.costUsd.toFixed(4)}  ${(outcome.point.why ?? "").slice(0, 100)}`);
    }
  }

  const scored = results.filter((point) => point.score > 0);
  if (scored.length === 0) throw new Error("no trials completed");
  const frontier = paretoFrontier(scored);
  const best = pickBest(scored)!;
  const fallback = pickFallback(scored, best, policy.fallback.min_score);
  console.log("\n=== pareto frontier (quality up, price and latency down) ===");
  for (const point of frontier) console.log(`  ${(point.route ? routeLabel(point.route) : point.model).padEnd(52)} ` +
    `score=${point.score.toFixed(2)}  ${point.priceKnown === false ? "price unknown" : `$${point.price.toFixed(2)}/M`}`);
  console.log(`\nBEST FIT : ${best.route ? routeLabel(best.route) : best.model}`);
  console.log(fallback ? `FALLBACK : ${fallback.route ? routeLabel(fallback.route) : fallback.model}` : "FALLBACK : n/a");

  const recommendation = buildRecommendation(tKey, cfg.task.slice(0, 120), initial.id, results,
    policy, null, initial.route);
  if (recommendation) {
    appendJsonl(paths.recommendations(), recommendation);
    console.log(`\nrecommendation -> ${paths.recommendations()} (auto=${recommendation.policy.autoApply})`);
  }
  return { points: results, recommendation };
}
