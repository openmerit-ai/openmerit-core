/**
 * Trial engine shared by the pi extension's session-bound jobs and the optional
 * CLI watcher. It reads traces, runs pi candidates, and writes recommendations
 * for the extension to apply in the active session.
 */

import { fetchCatalog, diffNewModels, loadSnapshot, saveSnapshot } from "./catalog.js";
import { categorizeTask, loadDigest, relevantBenchmarks, benchmarkPrior, openRouterBenchmarkCandidates } from "./benchmarks.js";
import { loadKey } from "./llm.js";
import { providerAllowed, type Policy } from "./policy.js";
import { buildRecommendation } from "./recommend.js";
import {
  appendJsonl, paths, readJson, readJsonl, taskKey, writeJson,
} from "./store.js";
import { budgetOk, ensureRubric, recordMeritSpend, recordTrialSpend, runTrial, trialBudgetOk } from "./trials.js";
import { JUDGE_PREFS } from "./judge.js";
import { runPiTrial, scorePiRun, settledActiveTask, type SettledTask } from "./pi-trials.js";
import { taskInputKey } from "./task-input.js";
import { pickNext, STRAT_PREFS } from "./strategist.js";
import type { CatalogEntry, ModelRoute, Recommendation, TaskObservation, TrialPoint } from "./types.js";
import { enrichRouteEntry, routeCatalog, routeKey, routeLabel } from "./routes.js";
import { PiCliChatClient } from "./llm.js";
import { LocalJsonlEventSink, PiTraceObservationSource, meritEvent,
  type EventSink, type ObservationSource } from "./integrations.js";

interface CandidateQueue {
  /** Newly released models not yet trialed for each task. */
  newModels: { id: string; firstSeen: string; price: number }[];
}

interface HarnessState {
  currentModel?: string | null;
  currentRoute?: ModelRoute | null;
  routes?: ModelRoute[];
  sessionFile?: string | null;
  updatedAt?: string;
}

function resolveRoutePref(
  cat: Map<string, CatalogEntry>, prefs: (string | null)[], label: string, requireImages = false,
): CatalogEntry {
  const available = [...cat.values()].filter((entry) =>
    !!entry.route && entry.priceKnown !== false &&
    (!requireImages || entry.inputModalities?.includes("image")));
  for (const pref of prefs) {
    if (!pref) continue;
    const routed = cat.get(pref);
    if (routed && available.includes(routed)) return routed;
    const exact = available.find((entry) => entry.id === pref);
    if (exact) return exact;
  }
  for (const pref of prefs) {
    if (!pref) continue;
    const fuzzy = available.find((entry) => entry.id.includes(pref));
    if (fuzzy) return fuzzy;
  }
  const fallback = available.sort((a, b) =>
    (a.priceKnown === false ? 1 : 0) - (b.priceKnown === false ? 1 : 0) || a.price - b.price)[0];
  if (fallback) return fallback;
  throw new Error(`could not resolve ${label} route from Pi's eligible models`);
}

interface ProcessedTask {
  marker: string;
  status: "running" | "complete" | "no_swap" | "failed";
  updatedAt: string;
}

function emitTrialProgress(progress: {
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
}): void {
  console.log(`[openmerit/progress] ${JSON.stringify(progress)}`);
}

function persistTrial(point: TrialPoint & { taskKey?: string; sessionFile?: string }, sink: EventSink): void {
  appendJsonl(paths.trials(), point);
  sink.emit(meritEvent("trial.completed", point));
}

function resolvePref(cat: Map<string, CatalogEntry>, prefs: (string | null)[], label: string): string {
  for (const p of prefs) {
    if (p && cat.has(p)) return p;
  }
  for (const p of prefs) {
    if (!p) continue;
    for (const id of [...cat.keys()].sort()) {
      if (id.includes(p)) return id;
    }
  }
  throw new Error(`could not resolve ${label} model from preferences`);
}

/** Ingest new session-trace bytes into the observation log. */
export function tracesTick(
  source: ObservationSource = new PiTraceObservationSource(),
  sink: EventSink = new LocalJsonlEventSink(),
): TaskObservation[] {
  const fresh = source.read();
  for (const o of fresh) {
    appendJsonl(paths.observations(), o);
    sink.emit(meritEvent("observation.recorded", o, source.id));
  }
  if (fresh.length > 0) console.log(`[openmerit] traces: ${fresh.length} new observation(s)`);
  return fresh;
}

/** Diff the provider catalog; queue newly released models for trials. */
export async function catalogTick(key: string, policy: Policy): Promise<string[]> {
  const cat = await fetchCatalog(key);
  const snapshot = loadSnapshot();
  const fresh = snapshot.ids.length === 0 ? [] : diffNewModels(cat, snapshot);
  saveSnapshot(cat);

  const allowed = fresh.filter(
    (e) => e.price <= policy.max_usd_per_m && providerAllowed(policy, e.id),
  );
  if (allowed.length > 0) {
    const queue = readJson<CandidateQueue>(paths.candidates(), { newModels: [] });
    const known = new Set(queue.newModels.map((m) => m.id));
    for (const e of allowed) {
      if (!known.has(e.id)) {
        queue.newModels.push({ id: e.id, firstSeen: new Date().toISOString(), price: e.price });
      }
    }
    writeJson(paths.candidates(), queue);
    console.log(`[openmerit] catalog: ${allowed.length} new model(s) queued: ${allowed.map((e) => e.id).join(", ")}`);
  }
  return allowed.map((e) => e.id);
}

/**
 * Run due shadow trials: for each recently observed task, trial queued new
 * models (or a strategist pick when the queue is empty and the frontier is
 * thin). Budget-capped per policy.
 */
export async function trialTick(key: string, policy: Policy): Promise<void> {
  const sink = new LocalJsonlEventSink();
  const budget = budgetOk(policy);
  if (!budget.ok) {
    console.log(`[openmerit] trials paused: ${budget.reason}`);
    return;
  }

  const observations = readJsonl<TaskObservation>(paths.observations());
  const queue = readJson<CandidateQueue>(paths.candidates(), { newModels: [] });
  if (observations.length === 0 || queue.newModels.length === 0) return;

  const cat = await fetchCatalog(key);
  const judge = resolvePref(cat, [policy.judge_model, ...JUDGE_PREFS], "judge");

  // Most recent observation per task.
  const latestByTask = new Map<string, TaskObservation>();
  for (const o of observations) latestByTask.set(o.taskKey, o);

  const trials = readJsonl<TrialPoint & { taskKey?: string }>(paths.trials());
  const rubricCache = new Map<string, string>();
  const digest = loadDigest();

  for (const [tKey, obs] of latestByTask) {
    const due = queue.newModels.filter((m) => !trials.some((t) => t.taskKey === tKey && t.model === m.id));
    if (due.length === 0) continue;

    const { benchmarks } = relevantBenchmarks(obs.taskLabel);
    const category = categorizeTask(obs.taskLabel);

    // Rank due candidates by benchmark prior; cheapest first when unknown.
    due.sort((a, b) => {
      const pa = benchmarkPrior(category, a.id, digest);
      const pb = benchmarkPrior(category, b.id, digest);
      return (pb ?? -1) - (pa ?? -1) || a.price - b.price;
    });

    const candidate = due[0];
    const b = budgetOk(policy);
    if (!b.ok) break;

    console.log(`[openmerit] shadow trial: ${candidate.id} on task ${tKey} (${category}; benchmarks: ${benchmarks.join(", ")})`);
    const rubric = await ensureRubric(key, judge, obs.taskLabel, rubricCache);
    const { point, costUsd, error } = await runTrial(
      key, judge, obs.taskLabel, rubric, candidate.id, cat.get(candidate.id),
    );
    recordTrialSpend(costUsd);
    persistTrial({ ...point, taskKey: tKey }, sink);
    if (error) console.log(`[openmerit] trial failed: ${error.slice(0, 120)}`);
    else console.log(`[openmerit] trial: ${candidate.id} score=${point.score.toFixed(2)} $${point.price.toFixed(2)}/M`);
  }
}

/** Compare the one completed active pi task, sequentially, then target its session. */
export async function autoTaskTick(key: string | null, policy: Policy, settledTask?: SettledTask | null): Promise<Recommendation | null> {
  const sink = new LocalJsonlEventSink();
  const task = settledTask === undefined ? settledActiveTask() : settledTask;
  if (!task) return null;
  const marker = settledTask === undefined
    ? `${task.sessionFile}:${task.settledAt}`
    : `${task.sessionFile}:${task.sessionBytes ?? task.settledAt}`;
  const processedPath = settledTask === undefined ? paths.watchProcessed() : paths.sessionJob(marker);
  const prior = readJson<ProcessedTask | null>(processedPath, null);
  if (prior?.marker === marker && prior.status !== "failed") return null;
  if (!budgetOk(policy).ok) return null;

  // Claim the settled turn before provider calls so the next poll cannot duplicate it.
  writeJson(processedPath, { marker, status: "running", updatedAt: new Date().toISOString() } satisfies ProcessedTask);
  try {
  let cat = routeCatalog(task.routes);
  if (!cat.has(routeKey(task.route))) cat.set(routeKey(task.route), routeCatalog([task.route]).values().next().value!);
  if (key) {
    try {
      const live = await fetchCatalog(key);
      saveSnapshot(live);
      cat = new Map([...cat].map(([id, entry]) => [id,
        entry.route?.provider === "openrouter" ? enrichRouteEntry(entry, live.get(entry.id)) : entry]));
    } catch (error) {
      console.log(`[openmerit] OpenRouter enrichment unavailable: ${(error as Error).message}`);
    }
  }
  for (const [id, entry] of [...cat]) {
    if ((entry.priceKnown !== false && entry.price > policy.max_usd_per_m) ||
        !providerAllowed(policy, entry.id, entry.route?.provider) ||
        (task.images.length > 0 && !entry.inputModalities?.includes("image")) ||
        (id !== routeKey(task.route) && !trialBudgetOk(policy, entry, task.task.length).ok)) cat.delete(id);
  }
  const activeEntry = cat.get(routeKey(task.route));
  if (!activeEntry) throw new Error(`active route ${task.route.provider}/${task.route.modelId} is excluded by policy or task capabilities`);
  if (cat.size < 2) throw new Error("Pi exposes no eligible alternate model route for this task");
  const judge = resolveRoutePref(cat, [policy.judge_model, ...JUDGE_PREFS, task.model], "judge", task.images.length > 0);
  const strategist = resolveRoutePref(cat, [policy.strategist_model, ...STRAT_PREFS, task.model], "strategist");
  const client = new PiCliChatClient(undefined, recordMeritSpend);
  const { category, benchmarks } = relevantBenchmarks(task.task);
  let benchmarkCandidates: string[] = [];
  try { if (key) benchmarkCandidates = await openRouterBenchmarkCandidates(key, category,
    new Map([...cat.values()].map((entry) => [entry.id, entry]))); }
  catch (e) { console.log(`[openmerit] benchmark shortlist unavailable: ${(e as Error).message}`); }
  const rubric = await ensureRubric(key ?? "", judge.route!, task.task, new Map(), client);
  const tKey = taskInputKey(task.task, task.images, task.files);
  const points: TrialPoint[] = [];
  const tried = new Set<string>();
  const failedVendors = new Set<string>();
  const total = Math.max(1, Math.floor(policy.watch.models_per_task));

  if (settledTask !== undefined) emitTrialProgress({ phase: "start", taskKey: tKey,
    model: routeLabel(task.route), index: 1, total });
  const baseline = await scorePiRun(key ?? "", judge.route!, task.task, rubric, task.model, activeEntry,
    task.run, "trace", task.images, client);
  points.push(baseline.point);
  tried.add(routeKey(task.route));
  persistTrial({ ...baseline.point, taskKey: tKey, sessionFile: task.sessionFile }, sink);
  console.log(`[openmerit] task ${tKey}: A=${task.model} score=${baseline.point.score.toFixed(2)} from pi trace`);
  if (settledTask !== undefined) emitTrialProgress({ phase: "complete", taskKey: tKey,
    model: routeLabel(task.route), index: 1, total, score: baseline.point.score,
    price: baseline.point.price, latencyMs: baseline.point.latencyMs,
    costUsd: baseline.costUsd, toolCalls: baseline.point.toolCalls,
    toolErrors: baseline.point.toolErrors, changedFiles: baseline.point.changedFiles });

  for (let i = 1; i < total; i++) {
    if (!budgetOk(policy).ok) break;
    const pick = await pickNext(key ?? "", strategist.route!, task.task, rubric, benchmarks,
      points, cat, tried, policy.max_usd_per_m, failedVendors, benchmarkCandidates, client);
    if (!pick) break;
    if (settledTask !== undefined) emitTrialProgress({ phase: "start", taskKey: tKey,
      model: pick.route ? routeLabel(pick.route) : pick.model, index: i + 1, total });
    const entry = pick.route ? cat.get(routeKey(pick.route)) : cat.get(pick.model);
    const { point, costUsd, error } = await runPiTrial(
      key ?? "", judge.route!, task.task, rubric, pick.model, entry, task.cwd, task.images, task.files,
      undefined, client);
    tried.add(pick.route ? routeKey(pick.route) : pick.model);
    points.push(point);
    recordTrialSpend(costUsd);
    persistTrial({ ...point, taskKey: tKey, sessionFile: task.sessionFile }, sink);
    if (error) failedVendors.add(pick.route?.provider ?? pick.model.split("/")[0]);
    console.log(`[openmerit] task ${tKey}: ${pick.model} score=${point.score.toFixed(2)} cost=$${costUsd.toFixed(4)} ` +
      `tools=${point.toolCalls ?? 0} toolErrors=${point.toolErrors ?? 0} changedFiles=${point.changedFiles ?? 0}` +
      `${error ? ` error=${error.slice(0, 80)}` : ""}`);
    if (settledTask !== undefined) emitTrialProgress({ phase: "complete", taskKey: tKey,
      model: pick.route ? routeLabel(pick.route) : pick.model, index: i + 1, total, score: point.score, price: point.price,
      latencyMs: point.latencyMs, costUsd, error: error?.slice(0, 120),
      toolCalls: point.toolCalls, toolErrors: point.toolErrors, changedFiles: point.changedFiles });
  }

  const rec = buildRecommendation(tKey, task.task.slice(0, 120), task.model, points, policy, task.sessionFile, task.route);
  if (rec) {
    appendJsonl(paths.recommendations(), rec);
    sink.emit(meritEvent("recommendation.created", rec));
    console.log(`[openmerit] task ${tKey}: selected ${rec.recommended.model}; auto=${rec.policy.autoApply}`);
  } else console.log(`[openmerit] task ${tKey}: active model remains best`);
  writeJson(processedPath, { marker, status: rec ? "complete" : "no_swap",
    updatedAt: new Date().toISOString() } satisfies ProcessedTask);
  return rec;
  } catch (error) {
    writeJson(processedPath, { marker, status: "failed",
      updatedAt: new Date().toISOString() } satisfies ProcessedTask);
    throw error;
  }
}

/** Rebuild frontiers from trials and emit recommendations for the harness's current model. */
export function recommendTick(policy: Policy): Recommendation[] {
  const sink = new LocalJsonlEventSink();
  const harness = readJson<HarnessState>(paths.harnessState(), {});
  const currentModel = harness.currentModel ?? null;
  const currentRoute = harness.currentRoute ?? null;

  const trials = readJsonl<TrialPoint & { taskKey?: string }>(paths.trials());
  const observations = readJsonl<TaskObservation>(paths.observations());
  const labelByTask = new Map<string, string>();
  for (const o of observations) if (!labelByTask.has(o.taskKey)) labelByTask.set(o.taskKey, o.taskLabel);

  const byTask = new Map<string, TrialPoint[]>();
  for (const t of trials) {
    if (!t.taskKey) continue;
    const arr = byTask.get(t.taskKey) ?? [];
    arr.push(t);
    byTask.set(t.taskKey, arr);
  }

  // Dedupe on latest status per id: don't re-emit what is pending or was dismissed.
  const all = readJsonl<Recommendation>(paths.recommendations());
  const latestById = new Map<string, Recommendation>();
  for (const r of all) latestById.set(r.id, r);
  const existing = new Set(
    [...latestById.values()]
      .filter((r) => r.status === "pending" || r.status === "dismissed")
      .map((r) => `${r.taskKey}:${r.recommended.route ? routeKey(r.recommended.route) : `openrouter:${r.recommended.model}`}`),
  );

  const emitted: Recommendation[] = [];
  for (const [tKey, points] of byTask) {
    const rec = buildRecommendation(tKey, labelByTask.get(tKey) ?? tKey, currentModel, points, policy,
      null, currentRoute);
    if (!rec) continue;
    const dedupeKey = `${rec.taskKey}:${rec.recommended.route ? routeKey(rec.recommended.route) : `openrouter:${rec.recommended.model}`}`;
    if (existing.has(dedupeKey)) continue;
    appendJsonl(paths.recommendations(), rec);
    sink.emit(meritEvent("recommendation.created", rec));
    emitted.push(rec);
    console.log(
      `[openmerit] recommendation: ${rec.recommended.model} <- ${currentModel ?? "unknown"} ` +
      `(gain ${rec.evidence.scoreGain}, auto=${rec.policy.autoApply})`,
    );
  }
  return emitted;
}

/** One full pass. */
export async function tickOnce(policy: Policy): Promise<void> {
  tracesTick();
  let key: string | null = null;
  try {
    key = loadKey();
  } catch (e) {
    console.log(`[openmerit] ${(e as Error).message}; OpenRouter enrichment disabled`);
  }
  if (key) {
    await catalogTick(key, policy);
  }
  await autoTaskTick(key, policy);
}

/** Run forever, honoring policy watch intervals. */
export async function runDaemon(policy: Policy): Promise<void> {
  console.log("[openmerit] background track started");
  const tracesMs = Math.max(5, policy.watch.traces_interval_sec) * 1000;
  let lastCatalog = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      tracesTick();
    } catch (e) {
      console.log(`[openmerit] traces tick failed: ${(e as Error).message}`);
    }
    const now = Date.now();
    const wantCatalog = now - lastCatalog >= policy.watch.catalog_interval_min * 60_000;
    {
      let key: string | null = null;
      try {
        key = loadKey();
      } catch {
        /* no key; skip provider ticks */
      }
      try {
          if (key && wantCatalog) {
            await catalogTick(key, policy);
            lastCatalog = now;
          }
          await autoTaskTick(key, policy);
        } catch (e) {
          console.log(`[openmerit] provider tick failed: ${(e as Error).message}`);
        }
    }
    await new Promise((r) => setTimeout(r, tracesMs));
  }
}
