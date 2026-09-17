/**
 * OpenMerit pi extension — runs INSIDE the main harness.
 *
 * Install: `pi install /path/to/openmerit` after `npm ci`.
 * The extension launches session-bound comparisons after pi settles.
 *
 * What it does:
 *  - Reports this harness's current model to openmerit (~/.openmerit/harness-state.json).
 *  - Queues one controlled, session-bound comparison after an eligible task settles.
 *  - Polls ~/.openmerit/recommendations.jsonl for completed route decisions.
 *  - Applies swaps with pi.setModel() when the policy gate says "auto",
 *    otherwise asks (Apply / Dismiss) or waits for /openmerit apply.
 *  - Keeps the fallback model: on provider errors/rate limits, offers to
 *    switch to the frontier fallback.
 *
 * Self-contained on purpose: pi loads extensions standalone via jiti.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
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
const JOB_DIR = join(HOME, "jobs");
const BENCHMARKS_FILE = join(HOME, "benchmarks.jsonl");
const BENCHMARK_JOBS_FILE = join(HOME, "benchmark-jobs.jsonl");
const LOG_FILE = join(HOME, "openmerit.log.jsonl");
const ENGINE_FILE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");
const INSTRUCTION_FILE = join(fileURLToPath(new URL("..", import.meta.url)), "instructions", "OPENMERIT.md");
const POLICY_TEMPLATE_FILE = join(fileURLToPath(new URL("..", import.meta.url)), "instructions", "openmerit.policy.json");
const PROGRESS_PREFIX = "[openmerit/progress] ";

interface TrialRunProgress {
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

interface TrialSelectionProgress {
  phase: "selection";
  taskKey: string;
  eligible: string[];
  excluded: { model: string; reasons: string[] }[];
}

type TrialProgress = TrialRunProgress | TrialSelectionProgress;

function parseTrialProgress(line: string): TrialProgress | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as TrialProgress;
    if (typeof value.taskKey !== "string") return null;
    if (value.phase === "selection") {
      if (!Array.isArray(value.eligible) || !Array.isArray(value.excluded) ||
          value.eligible.some((item) => typeof item !== "string") ||
          value.excluded.some((item) => typeof item?.model !== "string" || !Array.isArray(item.reasons) ||
            item.reasons.some((reason) => typeof reason !== "string"))) return null;
      return value;
    }
    if ((value.phase !== "start" && value.phase !== "complete") || typeof value.model !== "string" ||
        !Number.isInteger(value.index) || !Number.isInteger(value.total) ||
        value.index < 1 || value.total < value.index) return null;
    return value;
  } catch { return null; }
}

function completedTrialText(trial: TrialRunProgress): string {
  return `${trial.model}: quality ${(trial.score ?? 0).toFixed(2)}, ` +
    `$${(trial.price ?? 0).toFixed(2)}/M, ${Math.round(trial.latencyMs ?? 0)}ms, ` +
    `run $${(trial.costUsd ?? 0).toFixed(4)}, tools ${trial.toolCalls ?? 0}` +
    (trial.toolErrors || trial.changedFiles ? `, tool errors ${trial.toolErrors ?? 0}, changed files ${trial.changedFiles ?? 0}` : "") +
    (trial.error ? ` (failed: ${trial.error})` : "");
}

interface ExtensionPolicy {
  mode?: string;
  auto_apply?: {
    enabled?: boolean;
    min_score_gain?: number;
    max_price_ratio?: number;
    require_frontier?: boolean;
  };
  providers?: { allow?: string[]; deny?: string[] };
  fallback?: { auto_update?: boolean; apply_on_error?: boolean };
  budgets?: { max_trials_per_day?: number; max_usd_per_day?: number };
  max_usd_per_m?: number;
  benchmark_refresh_minutes?: number;
  route_overrides?: Record<string, {
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    context_window?: number;
    max_tokens?: number;
    input?: ("text" | "image")[];
    availability?: "active" | "preview" | "deprecated" | "retired";
  }>;
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
    return { mode: "recommend", auto_apply: { enabled: false },
      fallback: { auto_update: false, apply_on_error: false },
      budgets: { max_trials_per_day: 0, max_usd_per_day: 0 } };
  }
}

function currentPolicyAllowsRoute(
  policy: ExtensionPolicy, model: string, route: ModelRoute | null | undefined,
): boolean {
  if (!route || route.meritId !== model || !route.cost ||
      !Number.isFinite(route.cost.input) || route.cost.input < 0 ||
      !Number.isFinite(route.cost.output) || route.cost.output < 0) return false;
  const maxPrice = policy.max_usd_per_m ?? 20;
  if (typeof maxPrice !== "number" || !Number.isFinite(maxPrice) || maxPrice < 0) return false;
  const price = (route.cost.input + route.cost.output) / 2;
  if (price > maxPrice) return false;
  const provider = route.provider;
  const vendor = model.split("/")[0];
  const matches = (pattern: string) => pattern === "*" || pattern === model || pattern === provider ||
    (pattern.endsWith("/*") && (pattern.slice(0, -2) === vendor || pattern.slice(0, -2) === provider));
  const allow = policy.providers?.allow ?? ["*"];
  const deny = policy.providers?.deny ?? [];
  if (!Array.isArray(allow) || !Array.isArray(deny) ||
      allow.some((item) => typeof item !== "string" || !item.trim()) ||
      deny.some((item) => typeof item !== "string" || !item.trim())) return false;
  if (deny.some(matches)) return false;
  return allow.some(matches);
}

function currentPolicyAllowsAuto(rec: Recommendation): boolean {
  const policy = loadPolicy();
  if (policy.mode !== "auto" || policy.auto_apply?.enabled !== true) return false;
  if (rec.evidence.priceKnown === false ||
      !currentPolicyAllowsRoute(policy, rec.recommended.model, rec.recommended.route)) return false;
  const minGain = policy.auto_apply.min_score_gain ?? 0.1;
  const maxRatio = policy.auto_apply.max_price_ratio ?? 1.5;
  const requireFrontier = policy.auto_apply.require_frontier ?? true;
  if (typeof minGain !== "number" || !Number.isFinite(minGain) || minGain < 0 || minGain > 1 ||
      typeof maxRatio !== "number" || !Number.isFinite(maxRatio) || maxRatio < 0 ||
      typeof requireFrontier !== "boolean" ||
      typeof rec.evidence.scoreGain !== "number" || !Number.isFinite(rec.evidence.scoreGain) ||
      typeof rec.evidence.priceRatio !== "number" || !Number.isFinite(rec.evidence.priceRatio)) return false;
  if (rec.evidence.scoreGain < minGain) return false;
  if (rec.evidence.priceRatio > maxRatio) return false;
  if (requireFrontier && !rec.evidence.onFrontier) return false;
  return true;
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
  availability?: "active" | "preview" | "deprecated" | "retired";
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

function extensionLog(level: "error" | "warn" | "info" | "debug", component: string, event: string, message: string, details?: unknown): void {
  const configured = process.env.OPENMERIT_LOG_LEVEL ?? "info";
  const rank = { error: 0, warn: 1, info: 2, debug: 3 } as const;
  if (rank[level] > (rank[configured as keyof typeof rank] ?? rank.info)) return;
  appendJsonl(LOG_FILE, { ts: new Date().toISOString(), level, component, event, message, ...(details === undefined ? {} : { details }) });
}

/** Initialize only the state needed by the extension; never overwrite user policy. */
function ensureState(): void {
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(POLICY_FILE) && existsSync(POLICY_TEMPLATE_FILE)) {
    copyFileSync(POLICY_TEMPLATE_FILE, POLICY_FILE);
    extensionLog("info", "lifecycle", "state_initialized", "created default policy");
  }
}

function registerBenchmark(ctx: ExtensionContext): void {
  const policy = loadPolicy();
  const everyMinutes = policy.benchmark_refresh_minutes ?? 0;
  if (!Number.isInteger(everyMinutes) || everyMinutes <= 0 || !settledTaskKey) return;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const now = new Date().toISOString();
  const benchmarkId = `task-${settledTaskKey}`;
  appendJsonl(BENCHMARKS_FILE, {
    schemaVersion: 1, id: benchmarkId, taskKey: settledTaskKey,
    taskLabel: "Pi task benchmark", instructions: "Reuse the completed task and its harness trace.",
    inputModalities: ["text"], createdAt: now, updatedAt: now,
  });
  appendJsonl(BENCHMARK_JOBS_FILE, {
    schemaVersion: 1, id: `refresh-${benchmarkId}`, benchmarkId,
    trigger: "interval", schedule: { everyMinutes }, action: "ask_harness", enabled: true,
    taskKey: settledTaskKey, sessionFile, route: ctx.model ? routeFor(ctx.model) : undefined,
    routes: eligibleRoutes(ctx), cwd: ctx.cwd, updatedAt: now,
  });
}

function dueRefresh(ctx: ExtensionContext): boolean {
  const policy = loadPolicy();
  const everyMinutes = policy.benchmark_refresh_minutes ?? 0;
  if (!Number.isInteger(everyMinutes) || everyMinutes <= 0 || !existsSync(BENCHMARK_JOBS_FILE)) return false;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !settledTaskKey) return false;
  const jobs = readJsonl<{ taskKey?: string; sessionFile?: string; schedule?: { everyMinutes?: number }; lastRunAt?: string }>(BENCHMARK_JOBS_FILE);
  const job = jobs.filter((j) => j.taskKey === settledTaskKey && j.sessionFile === sessionFile).at(-1);
  if (!job?.schedule?.everyMinutes) return false;
  return !job.lastRunAt || Date.now() - Date.parse(job.lastRunAt) >= job.schedule.everyMinutes * 60_000;
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

/** Pi-side heuristic: skip ordinary one-off coding tasks unless they mention an
 * LLM/agent workload or a measurable extraction/classification task. Users can
 * always override this with `/openmerit compare`. */
function latestTaskLooksIntelligenceDriven(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getEntries?: () => { type?: string; message?: { role?: string; content?: unknown } }[];
  };
  const entries = manager.getEntries?.();
  if (entries) {
    let latest = "";
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      latest = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join(" ") : "";
    }
    return /\b(llm|large language model|language model|agent|prompt|embedding|rag|classification|classify|extract|ocr|summarize|structured json|generate text|evaluate|model)\b/i.test(latest);
  }
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !existsSync(file)) return false;
  let latest = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (e.type !== "message" || e.message?.role !== "user") continue;
      const content = e.message.content;
      latest = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join(" ") : "";
    } catch { /* partial session line */ }
  }
  return /\b(llm|large language model|language model|agent|prompt|embedding|rag|classification|classify|extract|ocr|summarize|structured json|generate text|evaluate|model)\b/i.test(latest);
}

async function classifyTaskWithHarness(ctx: ExtensionContext, taskOverride?: string | null): Promise<boolean | null> {
  if (!existsSync(ENGINE_FILE) || !ctx.model) return null;
  const task = taskOverride?.trim() || latestUserTaskText(ctx);
  if (!task) return null;
  const child = spawn(process.execPath, [ENGINE_FILE, "classify", ctx.model.provider, ctx.model.id, task], {
    cwd: ctx.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already closed */ } }, 30_000);
    child.on("close", (value) => { clearTimeout(timer); resolve(value ?? 1); });
  });
  if (code !== 0) { extensionLog("warn", "eligibility", "classifier_failed", "semantic classifier exited unsuccessfully"); return null; }
  try {
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { eligible?: boolean; confidence?: number };
    if (typeof result.eligible !== "boolean" || !(Number(result.confidence) >= 0.7)) return null;
    extensionLog("info", "eligibility", "classified", `semantic eligibility=${result.eligible}`);
    return result.eligible;
  } catch { extensionLog("warn", "eligibility", "invalid_result", "semantic classifier returned invalid JSON"); return null; }
}

function latestUserTaskText(ctx: ExtensionContext): string | null {
  const entries = (ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getEntries?: () => { type?: string; message?: { role?: string; content?: unknown } }[];
  }).getEntries?.();
  let latest = "";
  const consume = (entry: { type?: string; message?: { role?: string; content?: unknown } }) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return;
    const content = entry.message.content;
    latest = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join(" ") : "";
  };
  if (entries) {
    for (const entry of entries) consume(entry);
  } else {
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) return null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try { consume(JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }); }
      catch { /* partial session line */ }
    }
  }
  return latest.trim() || null;
}

let settledTaskKey: string | null = null;
let comparisonsPaused = false;

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
  contextWindow?: number; maxTokens?: number;
  availability?: "active" | "preview" | "deprecated" | "retired" }, overrides = loadPolicy().route_overrides ?? {}): ModelRoute {
  const route: ModelRoute = {
    provider: model.provider,
    modelId: model.id,
    meritId: canonicalModel(model.provider, model.id),
    input: model.input ?? ["text"],
    cost: model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number" &&
      Number.isFinite(model.cost.input) && Number.isFinite(model.cost.output) &&
      model.cost.input >= 0 && model.cost.output >= 0
      ? { input: model.cost.input, output: model.cost.output,
          cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite }
      : undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    availability: model.availability,
  };
  const override = overrides[`${route.provider}:${route.modelId}`];
  if (!override) return route;
  const finite = (value: unknown, min: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
  const integer = (value: unknown) => {
    const normalized = finite(value, 1);
    return normalized !== undefined && Number.isInteger(normalized) ? normalized : undefined;
  };
  const input = Array.isArray(override.input) && override.input.length > 0 &&
    override.input.every((item) => item === "text" || item === "image")
    ? [...new Set(override.input)] : undefined;
  const costInput = finite(override.cost?.input, 0);
  const costOutput = finite(override.cost?.output, 0);
  return {
    ...route,
    ...(costInput === undefined || costOutput === undefined ? {} : { cost: {
      input: costInput,
      output: costOutput,
      cacheRead: finite(override.cost?.cacheRead, 0),
      cacheWrite: finite(override.cost?.cacheWrite, 0),
    }}),
    ...(integer(override.context_window) === undefined ? {} : {
      contextWindow: integer(override.context_window),
    }),
    ...(integer(override.max_tokens) === undefined ? {} : { maxTokens: integer(override.max_tokens) }),
    ...(input ? { input } : {}),
    ...(override.availability ? { availability: override.availability } : {}),
  };
}

function eligibleRoutes(ctx: ExtensionContext): ModelRoute[] {
  const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<Parameters<typeof routeFor>[0]> };
  const scoped = (ctx.scopedModels ?? []) as readonly { model: Parameters<typeof routeFor>[0] }[];
  const models = scoped.length ? scoped.map((item) => item.model) : registry.getAvailable?.() ?? [];
  if (ctx.model && !models.some((model) => model.provider === ctx.model!.provider && model.id === ctx.model!.id))
    models.unshift(ctx.model);
  const byRoute = new Map<string, ModelRoute>();
  const overrides = loadPolicy().route_overrides ?? {};
  for (const model of models) {
    const route = routeFor(model, overrides);
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

function reportHarnessState(ctx: ExtensionContext, settled = false, settledKeyOverride?: string | null): void {
  try {
    mkdirSync(HOME, { recursive: true });
    const model = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    const currentRoute = ctx.model ? routeFor(ctx.model) : null;
    if (settled) settledTaskKey = settledKeyOverride ?? latestSessionTaskKey(ctx);
    const prior = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as { sessionFile?: string | null; settledAt?: string }
      : {};
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const settledAt = settled ? new Date().toISOString()
      : prior.sessionFile === sessionFile ? prior.settledAt ?? null : null;
    writeState({
        schemaVersion: 2,
        currentModel: model,
        currentRoute,
        routes: eligibleRoutes(ctx),
        fallbackModel,
        fallbackRoute,
        sessionFile,
        settledTaskKey,
        settledAt,
        comparisonsPaused,
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

/** Resolve a legacy logical "vendor/model" id against Pi's configured registry. */
function resolveModel(ctx: ExtensionContext, meritId: string) {
  const [vendor, ...rest] = meritId.split("/");
  const modelId = rest.join("/");
  const reg = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => unknown | undefined;
    getAvailable?: () => { provider: string; id: string }[];
  };
  // Prefer the OpenRouter provider entry itself.
  const viaOpenRouter = reg.find?.("openrouter", meritId) ?? reg.find?.("openrouter", modelId);
  if (viaOpenRouter) return viaOpenRouter;
  // Then a native provider ("anthropic/claude-..." -> provider "anthropic").
  const native = reg.find?.(vendor, modelId);
  if (native) return native;
  // Last resort for old route-less records: scan configured routes for an id match.
  for (const m of reg.getAvailable?.() ?? []) {
    if (m.id === meritId || m.id === modelId || m.id.endsWith(`/${modelId}`)) return m;
  }
  return undefined;
}

/** Resolve only routes already configured in Pi; OpenMerit never registers a provider. */
function ensureModel(_pi: ExtensionAPI, ctx: ExtensionContext, meritId: string, route?: ModelRoute) {
  const registry = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => unknown | undefined;
  };
  if (route) {
    const exact = registry.find?.(route.provider, route.modelId);
    if (exact) return exact;
    return undefined;
  }
  return resolveModel(ctx, meritId);
}

async function doctorSummary(): Promise<{ text: string; ok: boolean }> {
  if (!existsSync(ENGINE_FILE)) return {
    text: "trial engine missing; reinstall OpenMerit or run npm ci in the checkout",
    ok: false,
  };
  const child = spawn(process.execPath, [ENGINE_FILE, "doctor", "--json"], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  });
  try {
    const report = JSON.parse(stdout) as { ok?: boolean; checks?: {
      id?: string; status?: string; message?: string;
    }[] };
    const lines = (report.checks ?? []).map((item) =>
      `${(item.status ?? "?").toUpperCase().padEnd(4)} ${item.id ?? "check"}: ${item.message ?? ""}`);
    return { text: lines.join("\n") || "doctor returned no checks", ok: report.ok === true };
  } catch {
    return { text: stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || `doctor exited ${code}`, ok: false };
  }
}

export default function openmerit(pi: ExtensionAPI) {
  // Pi supplies the prompt that started an agent run directly through this
  // lifecycle event. Keep it separate from the session transcript so a later
  // follow-up cannot replace the task being settled. Other harness adapters
  // should provide the equivalent prompt in their SettledHarnessTask.
  let capturedTaskPrompt: string | null = null;
  let capturedTaskKey: string | null = null;
  // The package owns the instruction source of truth; inject it through Pi's
  // supported per-turn system-prompt hook so users need not copy it manually.
  pi.on("before_agent_start", async (event) => {
    if (!capturedTaskPrompt) {
      capturedTaskPrompt = event.prompt.trim() || null;
      capturedTaskKey = userTaskKey(event.images?.length
        ? [{ type: "text", text: event.prompt }, ...event.images]
        : event.prompt);
      extensionLog("debug", "lifecycle", "task_captured", "captured harness task prompt", {
        chars: capturedTaskPrompt?.length ?? 0,
        images: event.images?.length ?? 0,
      });
    }
    if (!existsSync(INSTRUCTION_FILE)) return;
    const instructions = readFileSync(INSTRUCTION_FILE, "utf8").trim();
    if (!instructions) return;
    return { systemPrompt: `${event.systemPrompt}\n\n# OpenMerit integration context\n${instructions}` };
  });
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let trialJob: ChildProcessByStdio<null, Readable, Readable> | null = null;
  const queuedJobs: { sessionFile: string; settledAt: string; model: string; route: ModelRoute;
    key: string; cwd: string; bytes: number }[] = [];
  const startedJobs = new Set<string>();
  let activeSession: string | null = null;
  let progress: { sessionFile: string; taskKey: string; current: TrialRunProgress | null;
    completed: TrialRunProgress[]; eligible: string[]; excluded: TrialSelectionProgress["excluded"] } | null = null;

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
    progress = { sessionFile: job.sessionFile, taskKey: job.key, current: null, completed: [],
      eligible: [], excluded: [] };
    if (ctx.hasUI) ctx.ui.notify(`openmerit: comparing models for task ${job.key} (A=${job.model})`, "info");
    let stdout = "";
    let stderr = "";
    function onLine(line: string): void {
      const trial = parseTrialProgress(line);
      if (trial && job.sessionFile === activeSession && progress?.taskKey === trial.taskKey) {
        if (trial.phase === "selection") {
          progress.eligible = trial.eligible;
          progress.excluded = trial.excluded;
          if (ctx.hasUI) ctx.ui.notify(`openmerit: ${trial.eligible.length} routes eligible; ` +
            `${trial.excluded.length} skipped (/openmerit for reasons)`, "info");
        } else if (trial.phase === "start") {
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

  function queueSettledTask(ctx: ExtensionContext, force = false, refresh = false): string {
    if (comparisonsPaused && !force) return "comparisons are paused";
    const sessionFile = ctx.sessionManager.getSessionFile();
    const model = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    const route = ctx.model ? routeFor(ctx.model) : null;
    if (!sessionFile || !model || !route || !settledTaskKey || !existsSync(sessionFile))
      return "no saved completed task is available";
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
    if (!completed) return "the latest task has not completed successfully";
    const settledAt = new Date().toISOString();
    const bytes = readFileSync(sessionFile).length;
    const interval = loadPolicy().benchmark_refresh_minutes ?? 0;
    const refreshSlot = refresh && interval > 0 ? Math.floor(Date.now() / (interval * 60_000)) : "initial";
    const marker = `${sessionFile}:${settledTaskKey}:${model}:${bytes}:${refreshSlot}`;
    if (startedJobs.has(marker)) return "this task is already queued or was compared in this Pi session";
    const budget = trialBudget();
    if (budget.reason) {
      if (ctx.hasUI) ctx.ui.notify(`openmerit: comparison skipped: ${budget.reason}. ${budget.summary}`, "warning");
      return budget.reason;
    }
    startedJobs.add(marker);
    if (refresh) appendJsonl(BENCHMARK_JOBS_FILE, {
      schemaVersion: 1, id: `refresh-task-${settledTaskKey}`, benchmarkId: `task-${settledTaskKey}`,
      trigger: "interval", schedule: { everyMinutes: interval }, action: "ask_harness", enabled: true,
      taskKey: settledTaskKey, sessionFile, route, routes: eligibleRoutes(ctx), cwd: ctx.cwd,
      lastRunAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    queuedJobs.push({ sessionFile, settledAt, model, route, key: settledTaskKey, cwd: ctx.cwd, bytes });
    startNextJob(ctx);
    return "comparison queued";
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
      if (rec.fallback && loadPolicy().fallback?.auto_update !== false) {
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
      if (rec.policy.autoApply && currentPolicyAllowsAuto(rec)) {
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
    ensureState();
    activeSession = ctx.sessionManager.getSessionFile() ?? null;
    stopTrialJob();
    queuedJobs.length = 0;
    progress = null;
    suggested.clear();
    restoreFallback();
    try {
      const st = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        sessionFile?: string | null; settledTaskKey?: string | null; comparisonsPaused?: boolean;
      };
      comparisonsPaused = st.comparisonsPaused === true;
      settledTaskKey = st.sessionFile === ctx.sessionManager.getSessionFile()
        ? st.settledTaskKey ?? null : null;
    } catch { settledTaskKey = null; comparisonsPaused = false; }
    reportHarnessState(ctx);
    await surface(ctx);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (dueRefresh(ctx) && !trialJob && queuedJobs.length === 0)
        queueSettledTask(ctx, false, true);
      surface(ctx).catch(() => undefined);
    }, 5_000);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const taskPrompt = capturedTaskPrompt;
    reportHarnessState(ctx, true, capturedTaskKey);
    // Semantic classification is only meaningful for the prompt captured from
    // the harness lifecycle. If an older Pi host lacks that event, retain the
    // local heuristic rather than classifying an unrelated latest transcript
    // turn.
    const semantic = taskPrompt ? await classifyTaskWithHarness(ctx, taskPrompt) : null;
    const eligible = semantic ?? (taskPrompt
      ? /\b(llm|large language model|language model|agent|prompt|embedding|rag|classification|classify|extract|ocr|summarize|structured json|generate text|evaluate|model)\b/i.test(taskPrompt)
      : latestTaskLooksIntelligenceDriven(ctx));
    extensionLog("info", "eligibility", "decision", `task eligible=${eligible} source=${semantic === null ? "heuristic" : "semantic"}`);
    if (eligible) {
      registerBenchmark(ctx);
      queueSettledTask(ctx);
    }
    else if (ctx.hasUI) ctx.ui.notify("openmerit: task looks like ordinary coding work; comparison skipped (use /openmerit compare to override)", "info");
    capturedTaskPrompt = null;
    capturedTaskKey = null;
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
    if (policy.fallback?.apply_on_error !== undefined && policy.fallback.apply_on_error !== true) return;
    const current = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : "current model";
    const model = ensureModel(pi, ctx, fallbackModel, fallbackRoute ?? undefined);
    if (!model) return;

    const auto = policy.mode === "auto" && policy.auto_apply?.enabled === true &&
      currentPolicyAllowsRoute(policy, fallbackModel, fallbackRoute);
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
    description: "OpenMerit: status, compare, pause/resume, doctor, apply/dismiss",
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
      if (sub === "pause") {
        comparisonsPaused = true;
        queuedJobs.length = 0;
        stopTrialJob();
        startedJobs.clear();
        progress = null;
        reportHarnessState(ctx);
        ctx.ui.notify("openmerit: automatic comparisons paused; `/openmerit compare` remains available", "info");
        return;
      }
      if (sub === "resume") {
        comparisonsPaused = false;
        reportHarnessState(ctx);
        ctx.ui.notify("openmerit: automatic comparisons resumed for future completed tasks", "info");
        return;
      }
      if (sub === "compare") {
        settledTaskKey = latestSessionTaskKey(ctx);
        const result = queueSettledTask(ctx, true);
        if (result !== "comparison queued") ctx.ui.notify(`openmerit: ${result}`, "warning");
        return;
      }
      if (sub === "doctor") {
        try {
          const result = await doctorSummary();
          ctx.ui.notify(`openmerit doctor:\n${result.text}`, result.ok ? "info" : "warning");
        } catch (error) {
          ctx.ui.notify(`openmerit doctor failed: ${(error as Error).message}`, "error");
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
        : comparisonsPaused ? "paused"
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
      if (liveProgress?.excluded.length) {
        lines.push("", "routes skipped:");
        for (const route of liveProgress.excluded)
          lines.push(`  ${route.model}: ${route.reasons.join("; ")}`);
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
