#!/usr/bin/env node
/** openmerit CLI: init / watch / trial / frontier / recommend / status / doctor / verify. */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./policy.js";
import { loadKey } from "./llm.js";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { paths, readJson, readJsonl } from "./store.js";
import { autoTaskTick, recommendTick, runDaemon, tickOnce } from "./daemon.js";
import { settledActiveTask } from "./pi-trials.js";
import type { Frontier, ModelRoute, Recommendation, TaskObservation, TrialPoint } from "./types.js";
import { modelRoute, routeLabel } from "./routes.js";
import { runStandaloneTrial } from "./standalone.js";
import { collectDoctorReport, renderDiagnosticReport, runOfflineVerify } from "./diagnostics.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

function printReport(report: ReturnType<typeof collectDoctorReport>, json: boolean): void {
  console.log(json ? JSON.stringify(report, null, 2) : renderDiagnosticReport(report));
  if (!report.ok) process.exitCode = 1;
}

function cmdDoctor(json: boolean): void {
  printReport(collectDoctorReport(), json);
}

function cmdVerify(json: boolean): void {
  printReport(runOfflineVerify(), json);
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
  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "session-trial": {
      const policy = loadPolicy(paths.policy());
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
      if (args.includes("--once")) await tickOnce(loadPolicy(paths.policy()));
      else await runDaemon(loadPolicy(paths.policy()));
      break;
    case "trial": {
      const file = args[0];
      if (!file) throw new Error("usage: openmerit trial <task.json> [--rounds N]");
      const rIdx = args.indexOf("--rounds");
      await runStandaloneTrial(file, rIdx >= 0 ? Number(args[rIdx + 1]) : 5);
      break;
    }
    case "frontier":
      cmdFrontier(args[0]);
      break;
    case "recommend":
      recommendTick(loadPolicy(paths.policy()));
      break;
    case "status":
      cmdStatus();
      break;
    case "doctor":
      cmdDoctor(args.includes("--json"));
      break;
    case "verify":
      cmdVerify(args.includes("--json"));
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
  doctor [--json]      diagnose pi, policy, routes, state, and installation
  verify [--json]      run an offline, provider-free core self-test`);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`openmerit: ${(e as Error).message}`);
  process.exit(1);
});
