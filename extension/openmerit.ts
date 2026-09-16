/**
 * OpenMerit pi extension — runs INSIDE the main harness.
 *
 * Install: `pi install /path/to/openmerit` after `npm ci`.
 * The extension launches session-bound comparisons after pi settles.
 *
 * What it does:
 *  - Reports this harness's current model to openmerit (~/.openmerit/harness-state.json).
 *  - Polls ~/.openmerit/recommendations.jsonl for model-swap recommendations
 *    produced by the background track.
 *  - Applies swaps with pi.setModel() when the policy gate says "auto",
 *    otherwise asks (Apply / Dismiss) or waits for /openmerit apply.
 *  - Keeps the fallback model: on provider errors/rate limits, offers to
 *    switch to the frontier fallback.
 *
 * Self-contained on purpose: pi loads extensions standalone via jiti.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HOME = process.env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");
const RECS_FILE = join(HOME, "recommendations.jsonl");
const TRIALS_FILE = join(HOME, "trials.jsonl");
const STATE_FILE = join(HOME, "harness-state.json");
const POLICY_FILE = join(HOME, "policy.json");
const LEDGER_FILE = join(HOME, "ledger.json");
const JOB_DIR = join(HOME, "watch", "jobs");
const ENGINE_FILE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");
const PROGRESS_PREFIX = "[openmerit/progress] ";

interface TrialProgress {
  phase: "start" | "complete";
  taskKey: string;
  model: string;
  index: number;
  total: number;
  score?: number;
  price?: number;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
  toolCalls?: number;
  toolErrors?: number;
  changedFiles?: number;
}

function parseTrialProgress(line: string): TrialProgress | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as TrialProgress;
    if ((value.phase !== "start" && value.phase !== "complete") ||
        typeof value.taskKey !== "string" || typeof value.model !== "string" ||
        !Number.isInteger(value.index) || !Number.isInteger(value.total) ||
        value.index < 1 || value.total < value.index) return null;
    return value;
  } catch { return null; }
}

function completedTrialText(trial: TrialProgress): string {
  return `${trial.model}: quality ${(trial.score ?? 0).toFixed(2)}, ` +
    `$${(trial.price ?? 0).toFixed(2)}/M, ${Math.round(trial.latencyMs ?? 0)}ms, ` +
    `run $${(trial.costUsd ?? 0).toFixed(4)}, tools ${trial.toolCalls ?? 0}` +
    (trial.toolErrors || trial.changedFiles ? `, tool errors ${trial.toolErrors ?? 0}, changed files ${trial.changedFiles ?? 0}` : "") +
    (trial.error ? ` (failed: ${trial.error})` : "");
}

interface ExtensionPolicy {
  mode?: string;
  fallback?: { apply_on_error?: boolean };
  budgets?: { max_trials_per_day?: number; max_usd_per_day?: number };
}

function trialBudget(): { summary: string; reason: string | null } {
  const policy = loadPolicy();
  const limit = policy.budgets?.max_trials_per_day ?? 20;
  const usdLimit = policy.budgets?.max_usd_per_day ?? 5;
  const today = new Date().toISOString().slice(0, 10);
  let ledger: { date?: string; trials?: number; usd?: number } = {};
  try { ledger = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as typeof ledger; }
  catch {
    if (existsSync(LEDGER_FILE)) return {
      summary: "ledger unreadable",
      reason: "trial ledger is malformed; run `openmerit doctor` before spending",
    };
  }
  const trials = ledger.date === today ? ledger.trials ?? 0 : 0;
  const usd = ledger.date === today ? ledger.usd ?? 0 : 0;
  const reason = trials >= limit ? `daily trial cap reached (${limit})`
    : usd >= usdLimit ? `daily budget exhausted ($${usdLimit})` : null;
  return { summary: `${trials}/${limit} trials, $${usd.toFixed(4)}/$${usdLimit.toFixed(2)} today (UTC)`, reason };
}

function latestSessionJob(sessionFile: string | undefined): string | null {
  if (!sessionFile || !existsSync(JOB_DIR)) return null;
  const jobs: { marker?: string; status?: string; updatedAt?: string }[] = [];
  for (const file of readdirSync(JOB_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(JOB_DIR, file), "utf8")) as typeof jobs[number];
      if (job.marker?.startsWith(`${sessionFile}:`)) jobs.push(job);
    } catch { /* partial or unrelated job */ }
  }
  const latest = jobs.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")).at(-1);
  return latest?.status ?? null;
}

function loadPolicy(): ExtensionPolicy {
  if (!existsSync(POLICY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(POLICY_FILE, "utf8")) as ExtensionPolicy;
  } catch {
    return { mode: "recommend", fallback: { apply_on_error: false },
      budgets: { max_trials_per_day: 0, max_usd_per_day: 0 } };
  }
}

interface Recommendation {
  schemaVersion?: 1;
  id: string;
  ts: string;
  taskKey: string;
  taskLabel: string;
  sessionFile?: string | null;
  currentModel: string | null;
  currentRoute?: ModelRoute | null;
  recommended: { model: string; route?: ModelRoute; reason: string };
  fallback: { model: string; route?: ModelRoute; reason: string } | null;
  evidence: { scoreGain: number; priceRatio: number; priceKnown?: boolean; onFrontier: boolean; trials: number };
  policy: { autoApply: boolean; reasons: string[] };
  status: "pending" | "applied" | "dismissed" | "expired";
}

interface ModelRoute {
  provider: string;
  modelId: string;
  meritId: string;
  input: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
}

interface RecordedTrial {
  taskKey?: string;
  sessionFile?: string;
  model: string;
  score: number;
  price: number;
  latencyMs?: number;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(HOME, { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

/** Latest status per recommendation id. */
function latestRecommendations(): Recommendation[] {
  const byId = new Map<string, Recommendation>();
  for (const r of readJsonl<Recommendation>(RECS_FILE)) byId.set(r.id, r);
  let malformed = false;
  if (existsSync(RECS_FILE)) {
    for (const line of readFileSync(RECS_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch { malformed = true; break; }
    }
  }
  return [...byId.values()].map((rec) => malformed && rec.status === "pending" && rec.policy.autoApply
    ? { ...rec, policy: { autoApply: false,
        reasons: [...rec.policy.reasons, "recommendation history contains a malformed line; manual review required"] } }
    : rec);
}

function taskKey(text: string): string {
  return createHash("sha1").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

function userTaskKey(content: unknown): string | null {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" ");
  if (!text.trim()) return null;
  const images = parts.filter((b) => b?.type === "image");
  if (parts.length !== parts.filter((b) => b?.type === "text" || b?.type === "image").length ||
      images.some((b) => typeof b.data !== "string" || typeof b.mimeType !== "string")) return null;
  const files: string[] = [];
  const fileRe = /<file\s+name=["']([^"']+)["'][^>]*>/g;
  for (const match of text.matchAll(fileRe)) {
    const file = match[1];
    if (!file || !existsSync(file) || files.includes(file)) continue;
    try { files.push(`${basename(file)}:` + createHash("sha256").update(readFileSync(file)).digest("hex")); }
    catch { /* inaccessible attachment */ }
  }
  if (images.length === 0 && files.length === 0) return taskKey(text);
  const hashes = images.map((b) => `${b.mimeType}:` +
    createHash("sha256").update(Buffer.from(b.data, "base64")).digest("hex"));
  return taskKey(`${text.toLowerCase().replace(/\s+/g, " ").trim()}\nimages:${hashes.join(",")}\nfiles:${files.join(",")}`);
}

function latestSessionTaskKey(ctx: ExtensionContext): string | null {
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !existsSync(file)) return null;
  let latest: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (e.type !== "message" || e.message?.role !== "user") continue;
      latest = userTaskKey(e.message.content);
    } catch { /* partial/corrupt session line */ }
  }
  return latest;
}

let settledTaskKey: string | null = null;

function pendingRecommendations(ctx?: ExtensionContext): Recommendation[] {
  const pending = latestRecommendations().filter((r) => r.status === "pending");
  if (!ctx) return pending;
  const file = ctx.sessionManager.getSessionFile();
  const liveTaskKey = latestSessionTaskKey(ctx);
  return pending.filter((r) => r.sessionFile
    ? r.sessionFile === file && r.taskKey === settledTaskKey
    : !!liveTaskKey && r.taskKey === liveTaskKey);
}

/** Earlier measured comparisons are advice in another session, never pending swaps. */
function priorExactTaskSuggestion(ctx: ExtensionContext): {
  recommendation: Recommendation; trials: RecordedTrial[];
} | null {
  const file = ctx.sessionManager.getSessionFile();
  const key = latestSessionTaskKey(ctx);
  if (!file || !key || key !== settledTaskKey) return null;
  const prior = latestRecommendations().filter((r) =>
    r.sessionFile && r.sessionFile !== file && r.taskKey === key &&
    (r.status === "pending" || r.status === "applied") && r.evidence.trials >= 2);
  const recommendation = prior.at(-1);
  if (!recommendation) return null;
  const byModel = new Map<string, RecordedTrial>();
  for (const trial of readJsonl<RecordedTrial>(TRIALS_FILE)) {
    if (trial.taskKey === key && trial.sessionFile === recommendation.sessionFile) {
      byModel.set(trial.model, trial);
    }
  }
  return { recommendation, trials: [...byModel.values()] };
}

function suggestionText(rec: Recommendation, trials: RecordedTrial[]): string {
  const measured = trials.map((p) =>
    `${p.model}: quality ${p.score.toFixed(2)}, $${p.price.toFixed(2)}/M` +
      (p.latencyMs ? `, ${Math.round(p.latencyMs)}ms` : ""));
  return `openmerit: exact task was tested in another pi session (${rec.evidence.trials} models). ` +
    `Earlier choice: ${rec.recommended.model}. This session will run its own comparison before any swap.` +
    (measured.length ? `\n${measured.join("\n")}` : `\n${rec.recommended.reason}`);
}

function canonicalModel(provider: string, id: string): string {
  return provider === "openrouter" || id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

function routeDisplay(route: ModelRoute | undefined, fallback: string): string {
  return route && route.provider !== "openrouter" ? `${route.meritId} via ${route.provider}` : fallback;
}

function setStatus(rec: Recommendation, status: Recommendation["status"]): void {
  appendJsonl(RECS_FILE, { ...rec, status, ts: new Date().toISOString() });
}

let fallbackModel: string | null = null;
let fallbackRoute: ModelRoute | null = null;

function routeFor(model: { provider: string; id: string; input?: ("text" | "image")[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number; maxTokens?: number }): ModelRoute {
  return {
    provider: model.provider,
    modelId: model.id,
    meritId: canonicalModel(model.provider, model.id),
    input: model.input ?? ["text"],
    cost: model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number"
      ? { input: model.cost.input, output: model.cost.output,
          cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite }
      : undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function eligibleRoutes(ctx: ExtensionContext): ModelRoute[] {
  const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<Parameters<typeof routeFor>[0]> };
  const scoped = (ctx.scopedModels ?? []) as readonly { model: Parameters<typeof routeFor>[0] }[];
  const models = scoped.length ? scoped.map((item) => item.model) : registry.getAvailable?.() ?? [];
  if (ctx.model && !models.some((model) => model.provider === ctx.model!.provider && model.id === ctx.model!.id))
    models.unshift(ctx.model);
  const byRoute = new Map<string, ModelRoute>();
  for (const model of models) {
    const route = routeFor(model);
    byRoute.set(`${route.provider}:${route.modelId}`, route);
  }
  return [...byRoute.values()];
}

function writeState(value: unknown): void {
  const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(value) + "\n");
    renameSync(temp, STATE_FILE);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function reportHarnessState(ctx: ExtensionContext, settled = false): void {
  try {
    mkdirSync(HOME, { recursive: true });
    const model = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    const currentRoute = ctx.model ? routeFor(ctx.model) : null;
    if (settled) settledTaskKey = latestSessionTaskKey(ctx);
    const prior = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as { sessionFile?: string | null; settledAt?: string }
      : {};
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const settledAt = settled ? new Date().toISOString()
      : prior.sessionFile === sessionFile ? prior.settledAt ?? null : null;
    writeState({
        schemaVersion: 1,
        currentModel: model,
        currentRoute,
        routes: eligibleRoutes(ctx),
        fallbackModel,
        fallbackRoute,
        sessionFile,
        settledTaskKey,
        settledAt,
        cwd: ctx.cwd,
        updatedAt: new Date().toISOString(),
      });
  } catch {
    /* never break the host session over reporting */
  }
}

/** Restore the persisted fallback so a fresh session keeps it even with no pending recs. */
function restoreFallback(): void {
  try {
    const st = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
      fallbackModel?: string | null; fallbackRoute?: ModelRoute | null;
    };
    if (st.fallbackModel) fallbackModel = st.fallbackModel;
    if (st.fallbackRoute) fallbackRoute = st.fallbackRoute;
  } catch {
    /* no state yet */
  }
}

/** Resolve an OpenRouter-style "vendor/model" id against pi's model registry. */
function resolveModel(ctx: ExtensionContext, openrouterId: string) {
  const [vendor, ...rest] = openrouterId.split("/");
  const modelId = rest.join("/");
  const reg = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => unknown | undefined;
    getAvailable?: () => { provider: string; id: string }[];
  };
  // Prefer the OpenRouter provider entry itself.
  const viaOpenRouter = reg.find?.("openrouter", openrouterId) ?? reg.find?.("openrouter", modelId);
  if (viaOpenRouter) return viaOpenRouter;
  // Then a native provider ("anthropic/claude-..." -> provider "anthropic").
  const native = reg.find?.(vendor, modelId);
  if (native) return native;
  // Last resort: scan the catalogue for an id match.
  for (const m of reg.getAvailable?.() ?? []) {
    if (m.id === openrouterId || m.id === modelId || m.id.endsWith(`/${modelId}`)) return m;
  }
  return undefined;
}

interface CatalogEntryLite {
  id: string;
  name?: string;
  ctx?: number;
  pp?: number;
  pc?: number;
  inputModalities?: string[];
}

const INJECT_PROVIDER = "openmerit-openrouter";
const injectedModels: CatalogEntryLite[] = [];

function catalogEntry(openrouterId: string): CatalogEntryLite | undefined {
  try {
    const snap = JSON.parse(readFileSync(join(HOME, "catalog", "snapshot.json"), "utf8")) as {
      entries?: CatalogEntryLite[];
    };
    return (snap.entries ?? []).find((e) => e.id === openrouterId);
  } catch {
    return undefined;
  }
}

/**
 * Ensure pi can use the model. pi's built-in registry lags the live
 * OpenRouter catalog, so inject anything missing via registerProvider
 * (takes effect immediately, no /reload needed).
 */
function ensureModel(pi: ExtensionAPI, ctx: ExtensionContext, openrouterId: string, route?: ModelRoute) {
  const registry = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => unknown | undefined;
  };
  if (route) {
    const exact = registry.find?.(route.provider, route.modelId);
    if (exact) return exact;
    if (route.provider !== "openrouter") return undefined;
  }
  const existing = resolveModel(ctx, openrouterId);
  if (existing) return existing;

  const entry = catalogEntry(openrouterId);
  if (!entry) return undefined;
  if (!injectedModels.some((m) => m.id === entry.id)) injectedModels.push(entry);

  pi.registerProvider(INJECT_PROVIDER, {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "$OPENROUTER_API_KEY",
    api: "openai-completions",
    models: injectedModels.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: false,
      input: entry.inputModalities?.includes("image") ? ["text", "image"] : ["text"],
      cost: {
        input: (m.pp ?? 0) * 1e6,
        output: (m.pc ?? 0) * 1e6,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: m.ctx && m.ctx > 0 ? m.ctx : 128000,
      maxTokens: 16384,
    })),
  });

  return registry.find?.(INJECT_PROVIDER, openrouterId);
}

export default function openmerit(pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let trialJob: ChildProcessByStdio<null, Readable, Readable> | null = null;
  const queuedJobs: { sessionFile: string; settledAt: string; model: string; route: ModelRoute;
    key: string; cwd: string; bytes: number }[] = [];
  const startedJobs = new Set<string>();
  let activeSession: string | null = null;
  let progress: { sessionFile: string; taskKey: string; current: TrialProgress | null;
    completed: TrialProgress[] } | null = null;

  function stopTrialJob(): void {
    if (!trialJob) return;
    const child = trialJob;
    trialJob = null;
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { child.kill("SIGTERM"); }
  }
  const notified = new Set<string>();
  const suggested = new Set<string>();

  function startNextJob(ctx: ExtensionContext): void {
    if (trialJob || queuedJobs.length === 0) return;
    const job = queuedJobs.shift()!;
    if (job.sessionFile !== activeSession) return startNextJob(ctx);
    if (!existsSync(ENGINE_FILE)) {
      ctx.ui.notify("openmerit: trial engine missing; run npm ci in the OpenMerit checkout", "error");
      return;
    }
    const child = spawn(process.execPath, [ENGINE_FILE, "session-trial", job.sessionFile,
      job.settledAt, job.model, job.key, job.cwd, String(job.bytes), job.route.provider, job.route.modelId], {
      cwd: job.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    trialJob = child;
    progress = { sessionFile: job.sessionFile, taskKey: job.key, current: null, completed: [] };
    if (ctx.hasUI) ctx.ui.notify(`openmerit: comparing models for task ${job.key} (A=${job.model})`, "info");
    let stdout = "";
    let stderr = "";
    function onLine(line: string): void {
      const trial = parseTrialProgress(line);
      if (trial && job.sessionFile === activeSession && progress?.taskKey === trial.taskKey) {
        if (trial.phase === "start") {
          progress.current = trial;
          if (ctx.hasUI) ctx.ui.notify(
            `openmerit: trial ${trial.index}/${trial.total} comparing ${trial.model}` +
              (trial.index === 1 ? " (scoring Pi trace)" : ""), "info",
          );
        } else {
          progress.current = null;
          progress.completed.push(trial);
          if (ctx.hasUI) ctx.ui.notify(`openmerit: trial ${trial.index}/${trial.total} finished — ` +
            completedTrialText(trial), trial.error ? "warning" : "info");
        }
        return;
      }
      if (ctx.hasUI && job.sessionFile === activeSession &&
          (line.includes(": selected ") || line.includes(": active model remains best")))
        ctx.ui.notify(line.trim(), "info");
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let end: number;
      while ((end = stdout.indexOf("\n")) >= 0) {
        onLine(stdout.slice(0, end));
        stdout = stdout.slice(end + 1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (ctx.hasUI && job.sessionFile === activeSession)
        ctx.ui.notify(`openmerit: trial engine failed: ${error.message}`, "error");
    });
    child.on("close", (code) => {
      if (trialJob !== child) return;
      trialJob = null;
      if (job.sessionFile === activeSession) {
        if (code !== 0 && ctx.hasUI)
          ctx.ui.notify(`openmerit: comparison failed: ${stderr.trim().slice(0, 240) || `exit ${code}`}`, "error");
        else surface(ctx).catch(() => undefined);
        startNextJob(ctx);
      }
    });
  }

  function queueSettledTask(ctx: ExtensionContext): void {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const model = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    const route = ctx.model ? routeFor(ctx.model) : null;
    if (!sessionFile || !model || !route || !settledTaskKey || !existsSync(sessionFile)) return;
    // The alpha compares completed response tasks. The engine validates images,
    // tool use and the baseline answer before any provider calls.
    let completed = false;
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; stopReason?: string } };
        if (entry.type !== "message") continue;
        if (entry.message?.role === "user") completed = false;
        if (entry.message?.role === "assistant" && entry.message.stopReason !== "error" &&
            userTaskKeyFromAnswer(entry.message.content)) completed = true;
      } catch { /* partial session line */ }
    }
    if (!completed) return;
    const settledAt = new Date().toISOString();
    const bytes = readFileSync(sessionFile).length;
    const marker = `${sessionFile}:${settledTaskKey}:${model}:${bytes}`;
    if (startedJobs.has(marker)) return;
    startedJobs.add(marker);
    const budget = trialBudget();
    if (budget.reason) {
      if (ctx.hasUI) ctx.ui.notify(`openmerit: comparison skipped: ${budget.reason}. ${budget.summary}`, "warning");
      return;
    }
    queuedJobs.push({ sessionFile, settledAt, model, route, key: settledTaskKey, cwd: ctx.cwd, bytes });
    startNextJob(ctx);
  }

  function userTaskKeyFromAnswer(content: unknown): boolean {
    if (typeof content === "string") return !!content.trim();
    return Array.isArray(content) && content.some((part) => part?.type === "text" &&
      typeof part.text === "string" && part.text.trim());
  }

  async function applyRecommendation(ctx: ExtensionContext, rec: Recommendation): Promise<boolean> {
    const current = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    const currentRoute = ctx.model ? routeFor(ctx.model) : null;
    if (rec.currentRoute && currentRoute &&
        (rec.currentRoute.provider !== currentRoute.provider || rec.currentRoute.modelId !== currentRoute.modelId)) {
      ctx.ui.notify(`openmerit: recommendation targets ${rec.currentRoute.provider}/${rec.currentRoute.modelId}; ` +
        `current route is ${currentRoute.provider}/${currentRoute.modelId}`, "warning");
      return false;
    }
    if (!rec.currentRoute && rec.currentModel && current !== rec.currentModel) {
      ctx.ui.notify(`openmerit: recommendation was measured against ${rec.currentModel}; current model is ${current ?? "unknown"}`, "warning");
      return false;
    }
    const model = ensureModel(pi, ctx, rec.recommended.model, rec.recommended.route);
    if (!model) {
      ctx.ui.notify(
        `openmerit: ${rec.recommended.model} not found in pi's model registry (add the provider/model first)`,
        "warning",
      );
      return false;
    }
    const ok = await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
    if (ok) {
      setStatus(rec, "applied");
      if (rec.fallback) {
        fallbackModel = rec.fallback.model;
        fallbackRoute = rec.fallback.route ?? null;
      }
      ctx.ui.notify(`openmerit: switched to ${routeDisplay(rec.recommended.route, rec.recommended.model)}\n` +
        rec.recommended.reason, "info");
      reportHarnessState(ctx);
    } else {
      ctx.ui.notify(`openmerit: no auth for ${rec.recommended.model}`, "error");
    }
    return ok;
  }

  async function surface(ctx: ExtensionContext): Promise<void> {
    const prior = priorExactTaskSuggestion(ctx);
    if (prior && ctx.hasUI) {
      const key = `${ctx.sessionManager.getSessionFile()}:${prior.recommendation.id}:${settledTaskKey}`;
      if (!suggested.has(key)) {
        suggested.add(key);
        ctx.ui.notify(suggestionText(prior.recommendation, prior.trials), "info");
      }
    }
    for (const rec of pendingRecommendations(ctx)) {
      if (notified.has(rec.id)) continue;
      if (rec.policy.autoApply) {
        if (!rec.sessionFile || rec.sessionFile !== ctx.sessionManager.getSessionFile()) continue;
        if (!ctx.isIdle()) continue;
        notified.add(rec.id);
        await applyRecommendation(ctx, rec);
        continue;
      }
      notified.add(rec.id);
      // Never block here: surface() runs during session_start and on a poll
      // timer, where a modal dialog would deadlock RPC mode and stall TUI
      // startup. Notify (fire-and-forget) and let the user act via /openmerit.
      if (ctx.hasUI) {
        ctx.ui.notify(
          `openmerit recommends: ${routeDisplay(rec.recommended.route, rec.recommended.model)}\n${rec.recommended.reason}\n` +
            `gate: ${rec.policy.reasons.join("; ")}\n(/openmerit apply to switch, /openmerit dismiss to ignore)`,
          "info",
        );
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    activeSession = ctx.sessionManager.getSessionFile() ?? null;
    stopTrialJob();
    queuedJobs.length = 0;
    progress = null;
    suggested.clear();
    restoreFallback();
    try {
      const st = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        sessionFile?: string | null; settledTaskKey?: string | null;
      };
      settledTaskKey = st.sessionFile === ctx.sessionManager.getSessionFile()
        ? st.settledTaskKey ?? null : null;
    } catch { settledTaskKey = null; }
    reportHarnessState(ctx);
    await surface(ctx);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      surface(ctx).catch(() => undefined);
    }, 5_000);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    reportHarnessState(ctx, true);
    queueSettledTask(ctx);
    await surface(ctx);
  });

  pi.on("input", async (_event, ctx) => {
    // A ready comparison can switch the route before the next user task starts.
    await surface(ctx);
    return { action: "continue" };
  });

  pi.on("model_select", async (_event, ctx) => {
    reportHarnessState(ctx);
  });

  pi.on("session_shutdown", async () => {
    activeSession = null;
    queuedJobs.length = 0;
    stopTrialJob();
    progress = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // Fallback swap when the active model finished with an error.
  pi.on("agent_end", async (event, ctx) => {
    if (!fallbackModel) return;
    const e = event as unknown as {
      willRetry?: boolean;
      messages?: { role?: string; stopReason?: string }[];
    };
    if (e.willRetry) return; // pi is still retrying; wait for the final outcome
    const lastAssistant = [...(e.messages ?? [])].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.stopReason !== "error") return;

    const policy = loadPolicy();
    if (policy.fallback?.apply_on_error === false) return;
    const current = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : "current model";
    const model = ensureModel(pi, ctx, fallbackModel, fallbackRoute ?? undefined);
    if (!model) return;

    const auto = policy.mode === "auto";
    let ok = auto;
    if (!ok && ctx.mode === "tui") {
      // Modal confirm only in TUI; in RPC mode an unanswered dialog blocks
      // the command stream.
      ok = await ctx.ui.confirm(
        "openmerit fallback",
        `${current} is failing. Switch to frontier fallback ${fallbackModel}?`,
      );
    } else if (!ok && ctx.hasUI) {
      ctx.ui.notify(
        `openmerit: ${current} is failing; frontier fallback is ${fallbackModel} (/openmerit fallback to switch)`,
        "warning",
      );
      return;
    }
    if (!ok) return;
    if (await pi.setModel(model as Parameters<typeof pi.setModel>[0])) {
      ctx.ui.notify(`openmerit: fallback engaged -> ${fallbackModel}`, "warning");
      reportHarnessState(ctx);
    }
  });

  pi.registerCommand("openmerit", {
    description: "OpenMerit: status, pending recommendations, apply/dismiss",
    handler: async (args, ctx) => {
      const pending = pendingRecommendations(ctx);
      const prior = priorExactTaskSuggestion(ctx);
      const sub = args.trim().split(/\s+/)[0] ?? "";

      if (sub === "apply") {
        const target = pending[pending.length - 1];
        if (!target) {
          ctx.ui.notify("openmerit: no pending recommendations", "info");
          return;
        }
        await applyRecommendation(ctx, target);
        return;
      }
      if (sub === "dismiss") {
        for (const r of pending) setStatus(r, "dismissed");
        ctx.ui.notify(`openmerit: dismissed ${pending.length} recommendation(s)`, "info");
        return;
      }
      if (sub === "fallback") {
        if (!fallbackModel) {
          ctx.ui.notify("openmerit: no fallback set yet", "info");
          return;
        }
        const model = ensureModel(pi, ctx, fallbackModel, fallbackRoute ?? undefined);
        if (model && (await pi.setModel(model as Parameters<typeof pi.setModel>[0]))) {
          ctx.ui.notify(`openmerit: switched to fallback ${fallbackModel}`, "info");
          reportHarnessState(ctx);
        } else {
          ctx.ui.notify(`openmerit: could not switch to ${fallbackModel} (not in registry or no auth)`, "error");
        }
        return;
      }

      const currentRoute = ctx.model ? routeFor(ctx.model) : undefined;
      const current = currentRoute ? routeDisplay(currentRoute, currentRoute.meritId) : "unknown";
      const budget = trialBudget();
      const liveProgress = progress?.sessionFile === ctx.sessionManager.getSessionFile() ? progress : null;
      const comparison = trialJob ? liveProgress?.current
        ? `running — ${liveProgress.current.model} (trial ${liveProgress.current.index}/${liveProgress.current.total})`
        : "running — selecting next model"
        : queuedJobs.length ? `queued (${queuedJobs.length})`
        : latestSessionJob(ctx.sessionManager.getSessionFile() ?? undefined) ?? "not started";
      const lines = [
        `current model : ${current}`,
        `fallback      : ${fallbackModel ?? "n/a"}`,
        `pending recs  : ${pending.length}`,
        `comparison    : ${comparison}${budget.reason ? ` (${budget.reason})` : ""}`,
        `trial budget  : ${budget.summary}`,
      ];
      if (liveProgress?.completed.length) {
        lines.push("", "models tested:");
        for (const trial of liveProgress.completed) lines.push(`  ${completedTrialText(trial)}`);
      }
      if (prior) lines.push("", suggestionText(prior.recommendation, prior.trials));
      for (const r of pending.slice(-5)) {
        lines.push(
          "",
          `-> ${routeDisplay(r.recommended.route, r.recommended.model)} (gain ${r.evidence.scoreGain}, ` +
            `${r.evidence.priceKnown === false ? "price unknown" : `${r.evidence.priceRatio}x price`}, frontier=${r.evidence.onFrontier})`,
          `   ${r.recommended.reason}`,
          `   gate: ${r.policy.reasons.join("; ") || "n/a"}`,
        );
        if (r.fallback) lines.push(`   fallback: ${r.fallback.model} — ${r.fallback.reason}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
