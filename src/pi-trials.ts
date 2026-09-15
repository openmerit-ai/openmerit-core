/** Run a task through pi for each model, using pi's JSON event stream as the measurement source. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, judgeWithImages } from "./judge.js";
import { knownInvoiceScore } from "./invoice-eval.js";
import { paths, readJson } from "./store.js";
import { sessionImages, taskInputKey, type TaskImage } from "./task-input.js";
import type { CatalogEntry, TrialPoint } from "./types.js";

interface PiMessage {
  role?: string;
  content?: unknown;
  usage?: { cost?: { total?: number } };
  stopReason?: string;
}

function answerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x): x is { type: string; text?: string } =>
    !!x && typeof x === "object" && (x as { type?: string }).type === "text")
    .map((x) => x.text ?? "").join("\n");
}

export interface PiRun {
  answer: string;
  costUsd: number;
  latencyMs: number;
  errors: number;
  sessionId?: string;
}

interface SessionMessage extends PiMessage {
  provider?: string;
  model?: string;
  timestamp?: number;
}

/** Use model A's completed result from the active pi session when it matches this task. */
export function recordedActiveTask(task: string, model: string, images: TaskImage[] = []): PiRun | null {
  const state = readJson<{ sessionFile?: string | null }>(paths.harnessState(), {});
  const file = state.sessionFile;
  if (!file || !existsSync(file)) return null;
  let user: SessionMessage | null = null;
  const assistants: SessionMessage[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: SessionMessage };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user") { user = entry.message; assistants.length = 0; }
    else if (user && entry.message.role === "assistant") assistants.push(entry.message);
  }
  const userImages = user ? sessionImages(user.content) : null;
  if (!user || !userImages || taskInputKey(answerText(user.content), userImages) !==
      taskInputKey(task, images)) return null;
  const matching = assistants.filter((m) =>
    (m.provider === "openrouter" ? m.model : `${m.provider}/${m.model}`) === model);
  if (matching.length === 0 || matching.some((m) => m.stopReason === "error")) return null;
  const answer = matching.map((m) => answerText(m.content)).filter(Boolean).at(-1) ?? "";
  if (!answer.trim()) return null;
  const first = user.timestamp ?? 0;
  const last = matching.at(-1)?.timestamp ?? first;
  return {
    answer,
    costUsd: matching.reduce((n, m) => n + (m.usage?.cost?.total ?? 0), 0),
    latencyMs: Math.max(0, last - first),
    errors: 0,
  };
}

export interface SettledTask {
  task: string;
  images: TaskImage[];
  model: string;
  run: PiRun;
  sessionFile: string;
  settledAt: string;
  cwd: string;
}

/** Read the exact latest completed text task from the pi extension's session marker. */
export function settledActiveTask(): SettledTask | null {
  const st = readJson<{
    currentModel?: string | null; sessionFile?: string | null;
    settledTaskKey?: string | null; settledAt?: string | null; cwd?: string;
  }>(paths.harnessState(), {});
  if (!st.currentModel || !st.sessionFile || !st.settledTaskKey || !st.settledAt ||
      !existsSync(st.sessionFile)) return null;
  let userContent: unknown = null;
  let usedTools = false;
  for (const line of readFileSync(st.sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user") { userContent = entry.message.content; usedTools = false; }
    else if (userContent && entry.message.role === "toolResult") usedTools = true;
    else if (userContent && entry.message.role === "assistant" &&
      Array.isArray(entry.message.content) && entry.message.content.some((b) => b?.type === "toolCall"))
      usedTools = true;
  }
  if (!userContent || usedTools) return null;
  const images = sessionImages(userContent);
  if (!images) return null;
  const task = answerText(userContent);
  if (!task.trim() || taskInputKey(task, images) !== st.settledTaskKey) return null;
  const run = recordedActiveTask(task, st.currentModel, images);
  if (!run) return null;
  return { task, images, model: st.currentModel, run, sessionFile: st.sessionFile,
    settledAt: st.settledAt, cwd: st.cwd ?? process.cwd() };
}

/** Limit candidates to models this installed pi can actually select. */
export function availablePiModels(): Set<string> {
  const result = spawnSync("pi", ["--offline", "--list-models", "openrouter"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("could not list pi OpenRouter models");
  return new Set(result.stdout.split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((id): id is string => !!id && !id.startsWith("~")));
}

/** Each invocation is a fresh pi run, so model B does not inherit model A's answer. */
export async function executePiTask(
  model: string, task: string, cwd = process.cwd(), images: TaskImage[] = [],
): Promise<PiRun> {
  const imageDir = images.length ? mkdtempSync(join(tmpdir(), "openmerit-pi-image-")) : null;
  const suffix: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  };
  const imageArgs = images.map((image, i) => {
    if (!imageDir || !suffix[image.mimeType]) throw new Error(`unsupported pi image: ${image.mimeType}`);
    const file = join(imageDir, `image-${i}.${suffix[image.mimeType]}`);
    writeFileSync(file, Buffer.from(image.data, "base64"));
    return `@${file}`;
  });
  const child = spawn("pi", [
    "--provider", "openrouter", "--model", model, "--mode", "json",
    "--offline", "--no-extensions", "--no-tools", "--print", ...imageArgs, task,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let answer = "";
  let costUsd = 0;
  let errors = 0;
  let sessionId: string | undefined;
  const started = Date.now();

  function consume(line: string): void {
    if (!line.trim()) return;
    let event: { type?: string; id?: string; message?: PiMessage };
    try { event = JSON.parse(line) as typeof event; } catch { return; }
    if (event.type === "session" && event.id) sessionId = event.id;
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    answer = answerText(event.message.content) || answer;
    costUsd += event.message.usage?.cost?.total ?? 0;
    if (event.message.stopReason === "error") errors++;
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let n: number;
    while ((n = buffer.indexOf("\n")) >= 0) {
      consume(buffer.slice(0, n));
      buffer = buffer.slice(n + 1);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (imageDir) rmSync(imageDir, { recursive: true, force: true });
  }
  consume(buffer);
  if (exitCode !== 0 || !answer.trim()) {
    throw new Error(`pi trial ${model} failed: ${stderr.trim().slice(0, 180) || `exit ${exitCode}, empty answer`}`);
  }
  return { answer, costUsd, latencyMs: Date.now() - started, errors, sessionId };
}

/** Quality uses the same OpenMerit judge; cost and latency come from pi itself. */
export async function runPiTrial(
  key: string, judgeModel: string, task: string, rubric: string,
  model: string, entry: CatalogEntry | undefined, cwd = process.cwd(), images: TaskImage[] = [],
): Promise<{ point: TrialPoint; costUsd: number; error?: string; sessionId?: string }> {
  try {
    const run = await executePiTask(model, task, cwd, images);
    return await scorePiRun(key, judgeModel, task, rubric, model, entry, run, "pi_trial", images);
  } catch (e) {
    const error = String(e);
    return {
      point: { model, score: 0, price: entry?.price ?? 0,
        ts: new Date().toISOString(), source: "pi_trial", why: error.slice(0, 160) },
      costUsd: 0, error,
    };
  }
}

export async function scorePiRun(
  key: string, judgeModel: string, task: string, rubric: string,
  model: string, entry: CatalogEntry | undefined, run: PiRun,
  source: "pi_trial" | "trace", images: TaskImage[] = [],
): Promise<{ point: TrialPoint; costUsd: number; error?: string; sessionId?: string }> {
    let score = 0;
    let why = "judge unavailable";
    try {
      const pinned = images.length ? await knownInvoiceScore(task, images, run.answer) : null;
      const j = pinned ?? (images.length
        ? await judgeWithImages(key, judgeModel, task, rubric, run.answer, images)
        : await judge(key, judgeModel, task, rubric, run.answer));
      score = Math.max(0, Math.min(1, j.score));
      why = j.why;
    } catch (e) { why = `judge error: ${String(e).slice(0, 120)}`; }
    return {
      point: {
        model, score, price: entry?.price ?? 0,
        latencyMs: run.latencyMs, ts: new Date().toISOString(), source,
        why: `${why}${run.errors ? `; pi errors: ${run.errors}` : ""}`,
      },
      costUsd: run.costUsd,
      sessionId: run.sessionId,
    };
}
