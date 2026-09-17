/** Session-bound comparison engine. Integrations supply a settled task and eligible routes. */

import { providerAllowed, type Policy } from "./policy.js";
import { buildRecommendation } from "./recommend.js";
import { appendJsonl, paths, readJson, writeJson } from "./store.js";
import { budgetOk, ensureRubric, recordTrialSpend, trialBudgetOk } from "./trials.js";
import type { SettledHarnessTask as SettledTask, HarnessAdapter, HarnessScore } from "./harness.js";
import { taskInputKey } from "./task-input.js";
import type { ModelRoute, Recommendation, TrialPoint } from "./types.js";
import { applyRouteOverrides, routeKey, routeLabel, routePrice } from "./routes.js";
import type { MeritChatClient } from "./providers.js";
import { LocalJsonlEventSink, meritEvent, type EventSink } from "./integrations.js";
import { publicPriorModels } from "./public-benchmarks.js";
import { log } from "./logger.js";

interface ProcessedTask {
  marker: string;
  status: "running" | "complete" | "no_swap" | "failed";
  updatedAt: string;
  ownerPid?: number;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Completed jobs stay final; live owners retain their claim; abandoned claims can retry. */
export function taskJobIsClaimed(prior: ProcessedTask | null, marker: string, now = Date.now()): boolean {
  if (!prior || prior.marker !== marker || prior.status === "failed") return false;
  if (prior.status !== "running") return true;
  if (prior.ownerPid !== undefined) return processIsAlive(prior.ownerPid);
  const updated = Date.parse(prior.updatedAt);
  return Number.isFinite(updated) && now - updated < 15 * 60_000;
}

type TrialProgress = {
  phase: "selection";
  taskKey: string;
  eligible: string[];
  excluded: { model: string; reasons: string[] }[];
} | {
  phase: "start" | "complete";
  taskKey: string;
  model: string;
  index: number;
  total: number;
  score?: number;
  price?: number;
  latencyMs?: number;
  costUsd?: number;
  toolCalls?: number;
  toolErrors?: number;
  changedFiles?: number;
  error?: string;
};

function emitTrialProgress(progress: TrialProgress): void {
  console.log(`[openmerit/progress] ${JSON.stringify(progress)}`);
}

function persistTrial(point: TrialPoint, sink: EventSink): void {
  appendJsonl(paths.trials(), point);
  sink.emit(meritEvent("trial.completed", point));
}

function inputSize(task: SettledTask): number {
  return Buffer.byteLength(task.task) +
    task.images.reduce((sum, image) => sum + Buffer.from(image.data, "base64").length, 0) +
    task.files.reduce((sum, file) => sum + file.size, 0);
}

function resolveEvaluator(
  routes: ModelRoute[], policy: Policy, active: ModelRoute, requireImages: boolean,
): ModelRoute {
  const capable = routes.filter((route) => {
    const priced = routePrice(route);
    return providerAllowed(policy, route.meritId, route.provider) && priced.known &&
      priced.price <= policy.max_usd_per_m && (!requireImages || route.input.includes("image"));
  });
  const configured = policy.evaluator_model;
  if (configured) {
    const matches = capable.filter((route) =>
      routeKey(route) === configured || route.meritId === configured ||
      `${route.provider}/${route.modelId}` === configured);
    if (!matches.length) throw new Error(`evaluator route ${configured} is not eligible for this task`);
    return matches.sort((a, b) => {
      const ap = routePrice(a); const bp = routePrice(b);
      return Number(!ap.known) - Number(!bp.known) || ap.price - bp.price || routeKey(a).localeCompare(routeKey(b));
    })[0];
  }
  const activeRoute = capable.find((route) => routeKey(route) === routeKey(active));
  if (activeRoute) return activeRoute;
  const fallback = capable.sort((a, b) => {
    const ap = routePrice(a); const bp = routePrice(b);
    return Number(!ap.known) - Number(!bp.known) || ap.price - bp.price || routeKey(a).localeCompare(routeKey(b));
  })[0];
  if (!fallback) throw new Error("no eligible evaluator route for this task");
  return fallback;
}

/** Pick a deterministic price-spread slate. Production routing must remain reproducible and auditable. */
function selectAlternates(routes: ModelRoute[], count: number, priorKeys: string[] = []): ModelRoute[] {
  if (count <= 0 || routes.length === 0) return [];
  const sorted = [...routes].sort((a, b) => {
    const ap = routePrice(a); const bp = routePrice(b);
    return ap.price - bp.price || routeKey(a).localeCompare(routeKey(b));
  });
  if (sorted.length <= count) return sorted;
  if (count === 1) return [sorted[0]];
  const selected: ModelRoute[] = [];
  for (const key of priorKeys) {
    const route = sorted.find((candidate) => routeKey(candidate) === key);
    if (route && !selected.some((item) => routeKey(item) === key)) selected.push(route);
    if (selected.length === count) return selected;
  }
  for (let i = 0; i < count; i++) {
    const index = Math.round(i * (sorted.length - 1) / (count - 1));
    if (!selected.some((route) => routeKey(route) === routeKey(sorted[index]))) selected.push(sorted[index]);
  }
  return selected;
}

/** Compare one completed task, sequentially, and emit a session-bound route recommendation. */
export async function compareSettledTask(
  policy: Policy, settledTask: SettledTask,
  integration: { harness: HarnessAdapter; client: MeritChatClient },
): Promise<Recommendation | null> {
  const sink = new LocalJsonlEventSink();
  const routes = applyRouteOverrides(settledTask.routes, policy.route_overrides);
  const active = applyRouteOverrides([settledTask.route], policy.route_overrides)[0];
  const task = { ...settledTask, routes, route: active };
  const tKey = taskInputKey(task.task, task.images, task.files);
  const marker = `${task.sessionFile}:${task.sessionBytes ?? task.settledAt}:${task.comparisonNonce ?? "initial"}`;
  const processedPath = paths.sessionJob(marker);
  const prior = readJson<ProcessedTask | null>(processedPath, null);
  if (taskJobIsClaimed(prior, marker)) return null;
  if (!budgetOk(policy).ok) return null;
  log("info", "comparison", "started", "comparison started", { taskKey: tKey, routes: routes.length });

  writeJson(processedPath, { marker, status: "running", ownerPid: process.pid,
    updatedAt: new Date().toISOString() } satisfies ProcessedTask);
  try {
    const byRoute = new Map(routes.map((route) => [routeKey(route), route]));
    byRoute.set(routeKey(active), active);
    const excluded: { model: string; reasons: string[] }[] = [];
    const candidateRoutes: ModelRoute[] = [];
    const bytes = inputSize(task);
    const approximateInputTokens = Math.ceil(bytes / 4);
    for (const route of byRoute.values()) {
      if (routeKey(route) === routeKey(active)) continue;
      const reasons: string[] = [];
      const priced = routePrice(route);
      if (route.availability === "deprecated" || route.availability === "retired" || route.availability === "preview")
        reasons.push(`route is marked ${route.availability}`);
      if (!priced.known) reasons.push("route price is unknown");
      else if (priced.price > policy.max_usd_per_m)
        reasons.push(`price $${priced.price.toFixed(2)}/M exceeds $${policy.max_usd_per_m.toFixed(2)}/M policy limit`);
      if (!providerAllowed(policy, route.meritId, route.provider)) reasons.push("provider is denied by policy");
      if (task.images.length > 0 && !route.input.includes("image"))
        reasons.push("route does not advertise image input");
      const neededContext = approximateInputTokens + Math.min(route.maxTokens ?? 4096, 4096);
      if (route.contextWindow && route.contextWindow < neededContext)
        reasons.push(`context window ${route.contextWindow} is below estimated ${neededContext} tokens`);
      const admission = trialBudgetOk(policy, route, bytes);
      if (!admission.ok && admission.reason && !reasons.includes(admission.reason)) reasons.push(admission.reason);
      if (reasons.length) excluded.push({ model: routeLabel(route), reasons });
      else candidateRoutes.push(route);
    }
    const alternates = selectAlternates(candidateRoutes, Math.max(0, policy.comparison.max_routes - 1),
      publicPriorModels(candidateRoutes, task.task));
    const eligible = [active, ...alternates];
    emitTrialProgress({ phase: "selection", taskKey: tKey,
      eligible: eligible.map(routeLabel), excluded });
    log("info", "comparison", "selection", "candidate routes selected", { taskKey: tKey, eligible: eligible.map(routeLabel), excluded: excluded.length });
    if (alternates.length === 0) throw new Error("the harness exposes no eligible alternate route for this task");

    const evaluator = resolveEvaluator([...byRoute.values()], policy, active, task.images.length > 0);
    const { harness, client } = integration;
    if (!harness.scoreRun) throw new Error("harness adapter does not provide scoreRun");
    const rubric = await ensureRubric(client, evaluator, task.task, new Map());
    const points: TrialPoint[] = [];
    const total = eligible.length;

    emitTrialProgress({ phase: "start", taskKey: tKey, model: routeLabel(active), index: 1, total });
    const baseline = await harness.scoreRun(evaluator, task.task, rubric, active, task.run, client,
      "trace", task.images);
    const baselinePoint = { ...baseline.point, taskKey: tKey, taskLabel: task.task.slice(0, 120),
      sessionFile: task.sessionFile };
    points.push(baselinePoint);
    persistTrial(baselinePoint, sink);
    console.log(`[openmerit] task ${tKey}: A=${routeLabel(active)} score=${baselinePoint.score.toFixed(2)} from harness outcome`);
    emitTrialProgress({ phase: "complete", taskKey: tKey, model: routeLabel(active), index: 1, total,
      score: baselinePoint.score, price: baselinePoint.price, latencyMs: baselinePoint.latencyMs,
      costUsd: baseline.costUsd, toolCalls: baselinePoint.toolCalls,
      toolErrors: baselinePoint.toolErrors, changedFiles: baselinePoint.changedFiles });

    // A failed evaluator cannot establish a baseline for a meaningful model
    // comparison. Preserve the trial record for diagnostics, but do not let a
    // candidate win by default when the active route was never scored.
    if (baselinePoint.score <= 0 && /judge (?:error|unavailable)/i.test(baselinePoint.why ?? "")) {
      writeJson(processedPath, { marker, status: "failed", ownerPid: process.pid,
        updatedAt: new Date().toISOString() } satisfies ProcessedTask);
      log("warn", "comparison", "baseline_unmeasured", "comparison stopped because the baseline could not be scored", { taskKey: tKey });
      return null;
    }

    for (const [offset, route] of alternates.entries()) {
      if (!budgetOk(policy).ok) break;
      const index = offset + 2;
      emitTrialProgress({ phase: "start", taskKey: tKey, model: routeLabel(route), index, total });
      let outcome: HarnessScore;
      try {
        const input = {
          task: task.task, cwd: task.cwd, images: task.images, files: task.files,
          mode: task.mode,
        };
        const run = task.mode === "inference" && harness.runInference
            ? await harness.runInference(route, input)
            : await harness.runTask(route, input);
        outcome = await harness.scoreRun(evaluator, task.task, rubric, route, run, client, "pi_trial", task.images);
      } catch (error) {
        const priced = routePrice(route);
        outcome = { point: { schemaVersion: 1 as const, model: route.meritId, route, score: 0,
          price: priced.price, priceKnown: priced.known, ts: new Date().toISOString(), source: "pi_trial" as const,
          toolCalls: 0, toolErrors: 1, changedFiles: 0, why: String(error).slice(0, 160) }, costUsd: 0,
          error: String(error) };
      }
      const point = { ...outcome.point, taskKey: tKey, taskLabel: task.task.slice(0, 120),
        sessionFile: task.sessionFile };
      points.push(point);
      recordTrialSpend(outcome.costUsd);
      persistTrial(point, sink);
      console.log(`[openmerit] task ${tKey}: ${routeLabel(route)} score=${point.score.toFixed(2)} ` +
        `cost=$${outcome.costUsd.toFixed(4)} tools=${point.toolCalls ?? 0} ` +
        `toolErrors=${point.toolErrors ?? 0} changedFiles=${point.changedFiles ?? 0}` +
        `${outcome.error ? ` error=${outcome.error.slice(0, 80)}` : ""}`);
      emitTrialProgress({ phase: "complete", taskKey: tKey, model: routeLabel(route), index, total,
        score: point.score, price: point.price, latencyMs: point.latencyMs, costUsd: outcome.costUsd,
        error: outcome.error?.slice(0, 120), toolCalls: point.toolCalls,
        toolErrors: point.toolErrors, changedFiles: point.changedFiles });
    }

    const recommendation = buildRecommendation(tKey, task.task.slice(0, 120), active.meritId,
      points, policy, task.sessionFile, active);
    if (recommendation) {
      appendJsonl(paths.recommendations(), recommendation);
      sink.emit(meritEvent("recommendation.created", recommendation));
      console.log(`[openmerit] task ${tKey}: selected ${routeLabel(recommendation.recommended.route!)}; ` +
        `auto=${recommendation.policy.autoApply}`);
    } else {
      console.log(`[openmerit] task ${tKey}: active route remains best`);
    }
    writeJson(processedPath, { marker, status: recommendation ? "complete" : "no_swap",
      ownerPid: process.pid, updatedAt: new Date().toISOString() } satisfies ProcessedTask);
    log("info", "comparison", "completed", recommendation ? "recommendation created" : "active route remains best", { taskKey: tKey });
    return recommendation;
  } catch (error) {
    writeJson(processedPath, { marker, status: "failed", ownerPid: process.pid,
      updatedAt: new Date().toISOString() } satisfies ProcessedTask);
    log("error", "comparison", "failed", String(error), { taskKey: tKey });
    throw error;
  }
}
