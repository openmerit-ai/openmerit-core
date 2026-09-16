#!/usr/bin/env node
/** openmerit CLI: init / watch / trial / frontier / recommend / status / doctor. */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./policy.js";
import { loadKey } from "./llm.js";
import { fetchCatalog } from "./catalog.js";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { buildRecommendation } from "./recommend.js";
import { appendJsonl, paths, readJson, readJsonl, taskKey } from "./store.js";
import { autoTaskTick, recommendTick, runDaemon, tickOnce } from "./daemon.js";
import { budgetOk, recordTrialSpend } from "./trials.js";
import { availablePiModels, availablePiRoutes, piExecutable, recordedActiveTask, runPiTrial, scorePiRun, settledActiveTask } from "./pi-trials.js";
import { pickNext, STRAT_PREFS } from "./strategist.js";
import { JUDGE_PREFS } from "./judge.js";
import { openRouterBenchmarkCandidates, relevantBenchmarks } from "./benchmarks.js";
import type { CatalogEntry, Frontier, ModelRoute, Recommendation, TaskObservation, TrialPoint } from "./types.js";
import { modelRoute, routeLabel } from "./routes.js";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function resolvePref(cat: Map<string, CatalogEntry>, prefs: (string | null)[], label: string): string {
  for (const p of prefs) if (p && cat.has(p)) return p;
  for (const p of prefs) {
    if (!p) continue;
    for (const id of [...cat.keys()].sort()) if (id.includes(p)) return id;
  }
  throw new Error(`could not resolve ${label} model`);
}

function cmdInit(): void {
  const policyPath = paths.policy();
  mkdirSync(dirname(policyPath), { recursive: true });
  if (!existsSync(policyPath)) {
    copyFileSync(join(ROOT, "instructions", "openmerit.policy.json"), policyPath);
    console.log(`policy  -> ${policyPath}`);
  } else {
    console.log(`policy  -> ${policyPath} (kept existing)`);
  }
  console.log(`instr.  -> ${join(ROOT, "instructions", "OPENMERIT.md")} (add to your harness's AGENTS.md/context)`);
  console.log(`ext.    -> ${join(ROOT, "extension", "openmerit.ts")}`);
  console.log(`pi npm  -> pi install npm:openmerit`);
  console.log(`pi local-> pi install "${ROOT}"`);
  console.log("\nNext: authenticate at least two models in pi, install one extension source, then start pi. OpenRouter is optional enrichment; candidate tools are disabled by default.");
}

function optionalOpenRouterKey(): string | null {
  try { return loadKey(); } catch { return null; }
}

function cmdDoctor(): void {
  const executable = piExecutable();
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
  const state = readJson<{ currentRoute?: ModelRoute | null; routes?: ModelRoute[] }>(paths.harnessState(), {});
  console.log(`pi executable : ${executable}`);
  console.log(`pi detected   : ${version.status === 0 ? `yes (${version.stdout.trim()})` : "no"}`);
  try {
    const policy = loadPolicy(paths.policy());
    console.log(`policy        : valid (v${policy.version}, ${policy.mode})`);
  } catch (error) {
    console.log(`policy        : invalid (${(error as Error).message})`);
  }
  let routes: ModelRoute[] = state.routes ?? [];
  const hasLiveSnapshot = routes.length > 0;
  if (routes.length === 0 && version.status === 0) {
    try { routes = availablePiRoutes(); } catch { /* reported below */ }
  }
  console.log(`eligible routes: ${routes.length}`);
  for (const route of routes.slice(0, 8)) console.log(`  - ${routeLabel(route)}${route.cost ? "" : " (price unknown)"}`);
  if (routes.length > 8) console.log(`  … ${routes.length - 8} more`);
  console.log(`active route  : ${state.currentRoute ? routeLabel(state.currentRoute) : "not reported; start pi once"}`);
  const pricedRoutes = routes.filter((route) => !!route.cost).length;
  console.log(`alternates    : ${hasLiveSnapshot
    ? pricedRoutes >= 2 ? "ready" : "need at least two priced eligible pi routes"
    : "start Pi once to capture route prices and capabilities"}`);
  console.log(`OpenRouter enrichment: ${optionalOpenRouterKey() ? "available" : "not configured (optional)"}`);
}

async function cmdTrial(taskFile: string, rounds: number): Promise<void> {
  const cfg = JSON.parse(readFileSync(taskFile, "utf8")) as {
    task: string;
    eval: string;
    initial_model: string;
    judge_model?: string;
    strategist_model?: string;
    max_usd_per_m?: number;
  };
  const policy = loadPolicy(paths.policy());
  const key = loadKey();

  console.log("fetching OpenRouter catalog...");
  const cat = await fetchCatalog(key);
  const piModels = availablePiModels();
  for (const id of [...cat.keys()]) if (!piModels.has(id)) cat.delete(id);
  if (!cat.has(cfg.initial_model)) throw new Error(`initial_model ${cfg.initial_model} is unavailable in pi's OpenRouter registry`);
  console.log(`catalog: ${cat.size} models selectable in pi`);

  const judge = resolvePref(cat, [cfg.judge_model ?? policy.judge_model, ...JUDGE_PREFS], "judge");
  const strat = resolvePref(cat, [cfg.strategist_model ?? policy.strategist_model, ...STRAT_PREFS], "strategist");
  const { category, benchmarks } = relevantBenchmarks(cfg.task);
  let benchmarkCandidates: string[] = [];
  try {
    benchmarkCandidates = await openRouterBenchmarkCandidates(key, category, cat);
  } catch (e) {
    console.log(`OpenRouter benchmark shortlist unavailable: ${(e as Error).message}`);
  }
  console.log(`judge: ${judge} | strategist: ${strat} | benchmarks: ${benchmarks.join(", ")}`);
  console.log(`OpenRouter benchmark candidates: ${benchmarkCandidates.slice(0, 5).join(", ") || "none"}`);

  const tKey = taskKey(cfg.task);
  const maxPrice = cfg.max_usd_per_m ?? policy.max_usd_per_m;
  const tried = new Set<string>();
  const results: TrialPoint[] = [];
  const failedVendors = new Set<string>();

  for (let i = 0; i < rounds; i++) {
    const budget = budgetOk(policy);
    if (!budget.ok) {
      console.log(`budget: ${budget.reason}; stopping`);
      break;
    }
    let model: string;
    let why: string;
    if (i === 0) {
      model = cfg.initial_model;
      why = "initial model";
    } else {
      const pick = await pickNext(key, strat, cfg.task, cfg.eval, benchmarks, results, cat, tried, maxPrice, failedVendors, benchmarkCandidates);
      if (!pick) break;
      model = pick.model;
      why = pick.why;
    }
    if (tried.has(model)) break;
    console.log(`[round ${i + 1}/${rounds}] ${model} (${why}) ...`);
    const observed = i === 0 ? recordedActiveTask(cfg.task, model) : null;
    if (i === 0) console.log(observed ? "    using model A's active pi session trace" : "    active trace unavailable; running model A in a fresh pi session");
    const { point, costUsd, error, sessionId } = observed
      ? await scorePiRun(key, judge, cfg.task, cfg.eval, model, cat.get(model), observed, "trace")
      : await runPiTrial(key, judge, cfg.task, cfg.eval, model, cat.get(model));
    tried.add(model);
    results.push(point);
    recordTrialSpend(costUsd);
    appendJsonl(paths.trials(), { ...point, taskKey: tKey });
    if (sessionId) console.log(`    pi trace session: ${sessionId}`);
    if (error) {
      failedVendors.add(model.split("/")[0]);
      console.log(`    FAILED: ${error.slice(0, 160)}`);
    } else {
      console.log(`    score=${point.score.toFixed(2)}  $/M=${point.price}  est_cost=$${costUsd.toFixed(4)}  ${(point.why ?? "").slice(0, 110)}`);
    }
  }

  const pts = results.filter((p) => p.score > 0);
  if (pts.length === 0) {
    console.log("no trials completed");
    process.exit(1);
  }
  const chain = paretoFrontier(pts);
  const best = pickBest(pts)!;
  const fb = pickFallback(pts, best, policy.fallback.min_score);

  console.log("\n=== pareto frontier (nondominated: score up, price down, latency down) ===");
  for (const p of chain) console.log(`  ${p.model.padEnd(44)} score=${p.score.toFixed(2)}  $${p.price.toFixed(2)}/M`);
  console.log(`\nBEST FIT : ${best.model}  (score ${best.score.toFixed(2)}, $${best.price.toFixed(2)}/M)`);
  console.log(fb ? `FALLBACK : ${fb.model}  (score ${fb.score.toFixed(2)}, $${fb.price.toFixed(2)}/M)` : "FALLBACK : n/a");

  const rec = buildRecommendation(tKey, cfg.task.slice(0, 120), cfg.initial_model, pts, policy);
  if (rec) {
    appendJsonl(paths.recommendations(), rec);
    console.log(`\nrecommendation -> ${paths.recommendations()} (auto=${rec.policy.autoApply})`);
  }
}

function loadFrontiers(): Frontier[] {
  const trials = readJsonl<TrialPoint & { taskKey?: string }>(paths.trials());
  const observations = readJsonl<TaskObservation>(paths.observations());
  const labelByTask = new Map<string, string>();
  for (const o of observations) if (!labelByTask.has(o.taskKey)) labelByTask.set(o.taskKey, o.taskLabel);
  const byTask = new Map<string, TrialPoint[]>();
  for (const t of trials) {
    if (!t.taskKey) continue;
    byTask.set(t.taskKey, [...(byTask.get(t.taskKey) ?? []), t]);
  }
  const policy = loadPolicy(paths.policy());
  return [...byTask.entries()].map(([tKey, points]) => {
    const scored = points.filter((p) => p.score > 0);
    const best = pickBest(scored);
    return {
      taskKey: tKey,
      taskLabel: labelByTask.get(tKey) ?? tKey,
      points,
      frontier: paretoFrontier(scored).map((p) => p.model),
      bestFit: best?.model,
      fallback: best ? pickFallback(scored, best, policy.fallback.min_score)?.model : undefined,
      updatedAt: new Date().toISOString(),
    } satisfies Frontier;
  });
}

function cmdFrontier(filter?: string): void {
  const frontiers = loadFrontiers().filter((f) => !filter || f.taskKey.startsWith(filter));
  if (frontiers.length === 0) {
    console.log("no frontiers yet (run `openmerit trial` or let `openmerit watch` collect trials)");
    return;
  }
  for (const f of frontiers) {
    console.log(`\ntask ${f.taskKey}  "${f.taskLabel}"`);
    const pts = [...f.points].sort((a, b) => a.price - b.price);
    for (const p of pts) {
      const mark = f.frontier.includes(p.model) ? "*" : " ";
      console.log(
        ` ${mark} ${p.model.padEnd(44)} score=${p.score.toFixed(2)}  $${p.price.toFixed(2)}/M` +
        (p.latencyMs ? `  ${Math.round(p.latencyMs)}ms` : ""),
      );
    }
    console.log(`  best=${f.bestFit ?? "n/a"}  fallback=${f.fallback ?? "n/a"}  (* = pareto frontier)`);
  }
}

function cmdStatus(): void {
  const harness = readJson<{ currentModel?: string; currentRoute?: ModelRoute; updatedAt?: string }>(paths.harnessState(), {});
  const queue = readJson<{ newModels: { id: string; firstSeen: string }[] }>(paths.candidates(), { newModels: [] });
  const latestById = new Map<string, Recommendation>();
  for (const r of readJsonl<Recommendation>(paths.recommendations())) latestById.set(r.id, r);
  const recs = [...latestById.values()].filter((r) => r.status === "pending");
  const frontiers = loadFrontiers();
  console.log(`harness model : ${harness.currentRoute ? routeLabel(harness.currentRoute) : harness.currentModel ?? "unknown"} ` +
    `(as of ${harness.updatedAt ?? "n/a"})`);
  console.log(`tasks tracked : ${frontiers.length}`);
  console.log(`new models queued for trial: ${queue.newModels.length}${queue.newModels.length ? " — " + queue.newModels.slice(0, 5).map((m) => m.id).join(", ") + (queue.newModels.length > 5 ? "…" : "") : ""}`);
  console.log(`pending recommendations: ${recs.length}`);
  for (const r of recs.slice(-5)) {
    console.log(`  - ${r.recommended.model} <- ${r.currentModel ?? "?"} (gain ${r.evidence.scoreGain}, auto=${r.policy.autoApply})`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const policy = loadPolicy(paths.policy());
  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "session-trial": {
      const [sessionFile, settledAt, currentModel, settledTaskKey, cwd, bytesText, provider, providerModelId] = args;
      if (!sessionFile || !settledAt || !currentModel || !settledTaskKey || !cwd || !bytesText)
        throw new Error("usage: openmerit session-trial <session-file> <settled-at> <model> <task-key> <cwd> <session-bytes>");
      const sessionBytes = Number(bytesText);
      if (!Number.isSafeInteger(sessionBytes) || sessionBytes <= 0) throw new Error("invalid session byte limit");
      const state = readJson<{ routes?: ModelRoute[]; currentRoute?: ModelRoute | null }>(paths.harnessState(), {});
      const currentRoute = provider && providerModelId
        ? state.routes?.find((route) => route.provider === provider && route.modelId === providerModelId) ??
          modelRoute(provider, providerModelId)
        : state.currentRoute;
      const task = settledActiveTask({ sessionFile, settledAt, currentModel, currentRoute,
        routes: state.routes, settledTaskKey, cwd, sessionBytes });
      if (!task) throw new Error("the specified pi session has no completed, supported task matching this marker");
      await autoTaskTick(optionalOpenRouterKey(), policy, task);
      break;
    }
    case "watch":
      if (args.includes("--once")) await tickOnce(policy);
      else await runDaemon(policy);
      break;
    case "trial": {
      const file = args[0];
      if (!file) throw new Error("usage: openmerit trial <task.json> [--rounds N]");
      const rIdx = args.indexOf("--rounds");
      await cmdTrial(file, rIdx >= 0 ? Number(args[rIdx + 1]) : 5);
      break;
    }
    case "frontier":
      cmdFrontier(args[0]);
      break;
    case "recommend":
      recommendTick(policy);
      break;
    case "status":
      cmdStatus();
      break;
    case "doctor":
      cmdDoctor();
      break;
    default:
      console.log(`openmerit — external model-merit harness

usage: openmerit <command>

  init                 set up ~/.openmerit (policy, state dirs)
  watch [--once]       observe completed pi tasks, trial candidates sequentially, and recommend session swaps
  trial <task.json>    iterative model search on one task spec [--rounds N]
  frontier [taskKey]   print pareto frontier(s)
  recommend            emit recommendations now
  status               harness model, queued models, pending recommendations
  doctor               verify pi, policy, routes, and optional enrichment`);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`openmerit: ${(e as Error).message}`);
  process.exit(1);
});
