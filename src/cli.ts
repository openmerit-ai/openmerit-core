#!/usr/bin/env node
/** openmerit CLI: init / frontier / status / doctor / verify plus the internal session worker. */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./policy.js";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { paths, readJson, readJsonl } from "./store.js";
import { compareSettledTask } from "./comparison.js";
import { settledActiveTask } from "./pi-trials.js";
import type { Frontier, ModelRoute, Recommendation, TrialPoint } from "./types.js";
import { modelRoute, routeLabel } from "./routes.js";
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
  console.log("\nNext: authenticate at least two model routes in pi, install one extension source, then start pi. Candidate tools are disabled by default.");
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
  const trials = readJsonl<TrialPoint>(paths.trials());
  const labelByTask = new Map<string, string>();
  for (const point of trials) {
    if (point.taskKey && point.taskLabel && !labelByTask.has(point.taskKey))
      labelByTask.set(point.taskKey, point.taskLabel);
  }
  for (const rec of readJsonl<Recommendation>(paths.recommendations())) {
    if (!labelByTask.has(rec.taskKey)) labelByTask.set(rec.taskKey, rec.taskLabel);
  }
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
    console.log("no frontiers yet (complete a Pi task or use `/openmerit compare`)");
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
  const latestById = new Map<string, Recommendation>();
  for (const r of readJsonl<Recommendation>(paths.recommendations())) latestById.set(r.id, r);
  const recs = [...latestById.values()].filter((r) => r.status === "pending");
  const frontiers = loadFrontiers();
  console.log(`harness model : ${harness.currentRoute ? routeLabel(harness.currentRoute) : harness.currentModel ?? "unknown"} ` +
    `(as of ${harness.updatedAt ?? "n/a"})`);
  console.log(`tasks tracked : ${frontiers.length}`);
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
      await compareSettledTask(policy, task);
      break;
    }
    case "frontier":
      cmdFrontier(args[0]);
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
      console.log(`openmerit — adaptive model decision layer

usage: openmerit <command>

  init                 set up ~/.openmerit (policy, state dirs)
  frontier [taskKey]   print pareto frontier(s)
  status               active route, measured tasks, and pending recommendations
  doctor [--json]      diagnose pi, policy, routes, state, and installation
  verify [--json]      run an offline, provider-free core self-test`);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`openmerit: ${(e as Error).message}`);
  process.exit(1);
});
