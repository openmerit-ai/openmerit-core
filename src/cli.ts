#!/usr/bin/env node
/** openmerit CLI: init / watch / trial / frontier / recommend / status. */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./policy.js";
import { loadKey } from "./llm.js";
import { fetchCatalog } from "./catalog.js";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { buildRecommendation } from "./recommend.js";
import { appendJsonl, paths, readJson, readJsonl, taskKey } from "./store.js";
import { recommendTick, runDaemon, tickOnce } from "./daemon.js";
import { budgetOk, recordTrialSpend, runTrial } from "./trials.js";
import { pickNext, STRAT_PREFS } from "./strategist.js";
import { JUDGE_PREFS } from "./judge.js";
import { relevantBenchmarks } from "./benchmarks.js";
import type { CatalogEntry, Frontier, Recommendation, TaskObservation, TrialPoint } from "./types.js";

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
  console.log(`ext.    -> ${join(ROOT, "extension", "openmerit.ts")} (install into pi: copy to ~/.pi/agent/extensions/)`);
  console.log("\nNext: set OPENROUTER_API_KEY (env or ~/.openmerit/.env), then `openmerit watch`.");
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
  console.log(`catalog: ${cat.size} models`);

  const judge = resolvePref(cat, [cfg.judge_model ?? policy.judge_model, ...JUDGE_PREFS], "judge");
  const strat = resolvePref(cat, [cfg.strategist_model ?? policy.strategist_model, ...STRAT_PREFS], "strategist");
  const { benchmarks } = relevantBenchmarks(cfg.task);
  console.log(`judge: ${judge} | strategist: ${strat} | benchmarks: ${benchmarks.join(", ")}`);

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
      const pick = await pickNext(key, strat, cfg.task, cfg.eval, benchmarks, results, cat, tried, maxPrice, failedVendors);
      if (!pick) break;
      model = pick.model;
      why = pick.why;
    }
    if (tried.has(model)) break;
    console.log(`[round ${i + 1}/${rounds}] ${model} (${why}) ...`);
    const { point, costUsd, error } = await runTrial(key, judge, cfg.task, cfg.eval, model, cat.get(model));
    tried.add(model);
    results.push(point);
    recordTrialSpend(costUsd);
    appendJsonl(paths.trials(), { ...point, taskKey: tKey });
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

  const rec = buildRecommendation(tKey, cfg.task.slice(0, 120), null, pts, policy);
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
  const harness = readJson<{ currentModel?: string; updatedAt?: string }>(paths.harnessState(), {});
  const queue = readJson<{ newModels: { id: string; firstSeen: string }[] }>(paths.candidates(), { newModels: [] });
  const latestById = new Map<string, Recommendation>();
  for (const r of readJsonl<Recommendation>(paths.recommendations())) latestById.set(r.id, r);
  const recs = [...latestById.values()].filter((r) => r.status === "pending");
  const frontiers = loadFrontiers();
  console.log(`harness model : ${harness.currentModel ?? "unknown"} (as of ${harness.updatedAt ?? "n/a"})`);
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
    default:
      console.log(`openmerit — external model-merit harness

usage: openmerit <command>

  init                 set up ~/.openmerit (policy, state dirs)
  watch [--once]       run the background track (traces, catalog watch, shadow trials, recommendations)
  trial <task.json>    iterative model search on one task spec [--rounds N]
  frontier [taskKey]   print pareto frontier(s)
  recommend            emit recommendations now
  status               harness model, queued models, pending recommendations`);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`openmerit: ${(e as Error).message}`);
  process.exit(1);
});
