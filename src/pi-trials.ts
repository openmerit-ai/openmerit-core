/** Run a task through pi for each model, using pi's JSON event stream as the measurement source. */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { judge, judgeWithImages } from "./judge.js";
import { paths, readJson } from "./store.js";
import { sessionFiles, sessionImages, taskInputKey, type TaskFile, type TaskImage } from "./task-input.js";
import type { HarnessAdapter, HarnessTask, HarnessRun, HarnessScore, SettledHarnessTask } from "./harness.js";
import type { ModelRoute, TrialPoint } from "./types.js";
import { legacyOpenRouterRoute, meritModelId, modelRoute, routeKey, routePrice } from "./routes.js";
import type { MeritChatClient } from "./providers.js";
import { PiCliChatClient } from "./llm.js";
import { piProviderExtensionArgs } from "./pi-config.js";

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

export type PiRun = HarnessRun;

/** Pi-backed harness adapter. Future harnesses can implement the same seam. */
export class PiHarnessAdapter implements HarnessAdapter {
  constructor(private readonly providerExtensions: string[] = []) {}

  runTask(route: ModelRoute, input: HarnessTask): Promise<HarnessRun> {
    return executePiTask(route, input.task, input.cwd, input.images, input.files, this.providerExtensions);
  }

  createInferenceClient(onSpend?: (usd: number) => void): MeritChatClient {
    return new PiCliChatClient(undefined, onSpend, this.providerExtensions);
  }

  scoreRun(
    judgeModel: ModelRoute, task: string, rubric: string, route: ModelRoute,
    run: HarnessRun, client: MeritChatClient, source: "pi_trial" | "trace", images: TaskImage[] = [],
  ): Promise<HarnessScore> {
    return scorePiRun(judgeModel, task, rubric, route, run, client, source, images);
  }
}

const defaultHarness: HarnessAdapter = new PiHarnessAdapter();

const KNOWN_TRIAL_TOOLS = new Set([
  "read", "grep", "find", "ls", "bash", "powershell", "edit", "write",
]);

/**
 * Candidate runs have no tools by default. Users may explicitly opt into a
 * list, but a copied cwd is not an OS sandbox for absolute paths or network.
 */
export function piTrialToolArgs(setting = process.env.OPENMERIT_PI_TRIAL_TOOLS): string[] {
  if (!setting?.trim()) return ["--no-tools"];
  const requested = [...new Set(setting.split(",").map((tool) => tool.trim()).filter(Boolean))];
  if (requested.length === 1 && requested[0] === "none") return ["--no-tools"];
  const unknown = requested.filter((tool) => !KNOWN_TRIAL_TOOLS.has(tool));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`invalid OPENMERIT_PI_TRIAL_TOOLS${unknown.length ? `: ${unknown.join(", ")}` : ""}`);
  }
  return ["--tools", requested.join(",")];
}

function fileSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === ".openmerit") continue;
      const file = join(dir, name); const rel = relative(root, file);
      const st = statSync(file);
      if (st.isDirectory()) walk(file);
      else if (st.isFile() && st.size < 20_000_000) {
        out.set(rel, createHash("sha1").update(readFileSync(file)).digest("hex"));
      }
    }
  }
  walk(root); return out;
}

function isolatedWorkspace(cwd: string): string {
  const root = mkdtempSync(join(tmpdir(), "openmerit-pi-workspace-"));
  cpSync(cwd, root, { recursive: true, filter: (src) => {
    const rel = relative(cwd, src);
    return !rel.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".openmerit");
  }});
  return root;
}

interface SessionMessage extends PiMessage {
  provider?: string;
  model?: string;
  timestamp?: number;
}

/** Use model A's completed result from the active pi session when it matches this task. */
export function recordedActiveTask(
  task: string, model: string | ModelRoute, images: TaskImage[] = [], sessionFile?: string, sessionBytes?: number,
): PiRun | null {
  const state = sessionFile ? null : readJson<{ sessionFile?: string | null }>(paths.harnessState(), {});
  const file = sessionFile ?? state?.sessionFile;
  if (!file || !existsSync(file)) return null;
  let user: SessionMessage | null = null;
  const assistants: SessionMessage[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  for (const line of readFileSync(file).subarray(0, sessionBytes).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: SessionMessage };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user") { user = entry.message; assistants.length = 0; toolCalls = 0; toolErrors = 0; }
    else if (user && entry.message.role === "assistant") {
      assistants.push(entry.message);
      if (Array.isArray(entry.message.content)) toolCalls += entry.message.content.filter((part) =>
        (part as { type?: string })?.type === "toolCall").length;
    } else if (user && entry.message.role === "toolResult" &&
      (entry.message as PiMessage & { isError?: boolean }).isError) toolErrors++;
  }
  const userImages = user ? sessionImages(user.content) : null;
  const files = sessionFiles(task);
  if (!user || !userImages || taskInputKey(answerText(user.content), userImages, sessionFiles(answerText(user.content))) !==
      taskInputKey(task, images, files)) return null;
  const matching = assistants.filter((m) => typeof model === "string"
    ? meritModelId(m.provider ?? "openrouter", m.model ?? "") === model
    : m.provider === model.provider && m.model === model.modelId);
  const successful = matching.filter((m) => m.stopReason !== "error");
  if (successful.length === 0) return null;
  const answer = successful.map((m) => answerText(m.content)).filter(Boolean).at(-1) ?? "";
  if (!answer.trim()) return null;
  const first = user.timestamp ?? 0;
  const last = successful.at(-1)?.timestamp ?? first;
  return {
    answer,
    costUsd: matching.reduce((n, m) => n + (m.usage?.cost?.total ?? 0), 0),
    latencyMs: Math.max(0, last - first),
    errors: matching.filter((m) => m.stopReason === "error").length,
    toolCalls,
    toolErrors,
    changedFiles: 0,
  };
}

export type SettledTask = SettledHarnessTask;

/** Read the exact latest completed text task from the pi extension's session marker. */
export function settledActiveTask(snapshot?: {
  currentModel?: string | null; sessionFile?: string | null;
  currentRoute?: ModelRoute | null; routes?: ModelRoute[];
  settledTaskKey?: string | null; settledAt?: string | null; cwd?: string; sessionBytes?: number; comparisonNonce?: string;
}): SettledTask | null {
  const st = snapshot ?? readJson<{
    currentModel?: string | null; sessionFile?: string | null;
    currentRoute?: ModelRoute | null; routes?: ModelRoute[];
    settledTaskKey?: string | null; settledAt?: string | null; cwd?: string; sessionBytes?: number; comparisonNonce?: string;
  }>(paths.harnessState(), {});
  if (!st.currentModel || !st.sessionFile || !st.settledTaskKey || !st.settledAt ||
      !existsSync(st.sessionFile)) return null;
  let userContent: unknown = null;
  let usedTools = false;
  for (const line of readFileSync(st.sessionFile).subarray(0, st.sessionBytes).toString("utf8").split("\n")) {
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
  if (!userContent) return null;
  const images = sessionImages(userContent);
  if (!images) return null;
  const task = answerText(userContent);
  const files = sessionFiles(task);
  if (!task.trim() || taskInputKey(task, images, files) !== st.settledTaskKey) return null;
  const route = st.currentRoute ?? legacyOpenRouterRoute(st.currentModel);
  const run = recordedActiveTask(task, route, images, st.sessionFile, st.sessionBytes);
  if (!run) return null;
  const routes = st.routes?.length ? st.routes : [route];
  return { task, images, model: st.currentModel, run, sessionFile: st.sessionFile,
    settledAt: st.settledAt, sessionBytes: st.sessionBytes, cwd: st.cwd ?? process.cwd(), usedTools, files,
    route, routes, comparisonNonce: st.comparisonNonce };
}

export function piExecutable(): string {
  return process.env.OPENMERIT_PI_BIN?.trim() || "pi";
}

function compactNumber(value: string): number | undefined {
  const match = value.match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) return undefined;
  const scale = ({ K: 1_000, M: 1_000_000, G: 1_000_000_000 } as Record<string, number>)[
    (match[2] ?? "").toUpperCase()
  ] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

/** Read provider/model routes from pi when no live extension snapshot is available. */
export function availablePiRoutes(snapshot?: ModelRoute[], providerExtensions: string[] = []): ModelRoute[] {
  if (snapshot?.length) return snapshot;
  const result = spawnSync(piExecutable(), ["--offline", "--no-extensions",
    ...piProviderExtensionArgs(providerExtensions), "--list-models"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("could not list models from pi");
  const routes: ModelRoute[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const [provider, id, context, maxOut, , images] = line.trim().split(/\s+/);
    if (!provider || !id || id.startsWith("~")) continue;
    routes.push(modelRoute(provider, id, {
      input: images === "yes" ? ["text", "image"] : ["text"],
      contextWindow: compactNumber(context),
      maxTokens: compactNumber(maxOut),
    }));
  }
  return routes;
}

/** Each invocation is a fresh pi run, so model B does not inherit model A's answer. */
export async function executePiTask(
  model: string | ModelRoute, task: string, cwd = process.cwd(), images: TaskImage[] = [], files: TaskFile[] = [],
  providerExtensions: string[] = [],
): Promise<PiRun> {
  const route = typeof model === "string" ? legacyOpenRouterRoute(model) : model;
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
  const workspace = isolatedWorkspace(cwd);
  try {
    const attachmentDir = join(workspace, ".openmerit-attachments");
    mkdirSync(attachmentDir, { recursive: true });
    const attachmentPaths = new Map<string, string>();
    const fileArgs = files.map((file, i) => {
      const safeName = `${String(i).padStart(3, "0")}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      const target = join(attachmentDir, safeName);
      cpSync(file.path, target);
      attachmentPaths.set(file.path, target);
      return `@${target}`;
    });
    const candidateTask = [...attachmentPaths.entries()].reduce(
      (text, [source, target]) => text.split(source).join(target), task,
    );
    const before = fileSnapshot(workspace);
    const traceFile = paths.trialTrace(`${routeKey(route)}:${task}:${Date.now()}`);
    const traceLines: string[] = [];
    const child = spawn(piExecutable(), [
      "--provider", route.provider, "--model", route.modelId, "--mode", "json",
      "--offline", "--no-extensions", ...piProviderExtensionArgs(providerExtensions),
      "--approve", ...piTrialToolArgs(),
      "--print", ...imageArgs, ...fileArgs, candidateTask,
    ], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let answer = "";
    let costUsd = 0;
    let errors = 0;
    let sessionId: string | undefined;
    let toolCalls = 0;
    let toolErrors = 0;
    const started = Date.now();

    function consume(line: string): void {
      if (!line.trim()) return;
      traceLines.push(line);
      let event: { type?: string; id?: string; message?: PiMessage };
      try { event = JSON.parse(line) as typeof event; } catch { return; }
      if (event.type === "session" && event.id) sessionId = event.id;
      const content = event.message?.content;
      if (event.message?.role === "assistant" && Array.isArray(content))
        toolCalls += content.filter((part) => (part as { type?: string })?.type === "toolCall").length;
      if (event.message?.role === "toolResult" && (event.message as PiMessage & { isError?: boolean }).isError) toolErrors++;
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
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    consume(buffer);
    mkdirSync(dirname(traceFile), { recursive: true });
    writeFileSync(traceFile, traceLines.join("\n") + (traceLines.length ? "\n" : ""));
    const after = fileSnapshot(workspace);
    let changedFiles = 0;
    for (const [file, hash] of after) if (before.get(file) !== hash) changedFiles++;
    for (const file of before.keys()) if (!after.has(file)) changedFiles++;
    if (exitCode !== 0 || !answer.trim()) {
      throw new Error(`pi trial ${route.meritId} via ${route.provider} failed: ${stderr.trim().slice(0, 180) || `exit ${exitCode}, empty answer`}`);
    }
    return { answer, costUsd, latencyMs: Date.now() - started, errors, sessionId,
      toolCalls, toolErrors, changedFiles, traceFile };
  } finally {
    if (imageDir) rmSync(imageDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Quality uses the same OpenMerit judge; cost and latency come from pi itself. */
export async function runPiTrial(
  judgeModel: ModelRoute, task: string, rubric: string,
  route: ModelRoute, client: MeritChatClient,
  cwd = process.cwd(), images: TaskImage[] = [], files: TaskFile[] = [],
  harness: HarnessAdapter = defaultHarness,
): Promise<{ point: TrialPoint; costUsd: number; error?: string; sessionId?: string }> {
  try {
    const run = await harness.runTask(route, { task, cwd, images, files });
    return await scorePiRun(judgeModel, task, rubric, route, run, client, "pi_trial", images);
  } catch (e) {
    const error = String(e);
    const priced = routePrice(route);
    return {
      point: { schemaVersion: 1, model: route.meritId, route, score: 0, price: priced.price,
        priceKnown: priced.known,
        ts: new Date().toISOString(), source: "pi_trial", toolCalls: 0, toolErrors: 1,
        changedFiles: 0, why: error.slice(0, 160) },
      costUsd: 0, error,
    };
  }
}

export async function scorePiRun(
  judgeModel: ModelRoute, task: string, rubric: string,
  route: ModelRoute, run: PiRun, client: MeritChatClient,
  source: "pi_trial" | "trace", images: TaskImage[] = [],
): Promise<{ point: TrialPoint; costUsd: number; error?: string; sessionId?: string }> {
    let score = 0;
    let why = "judge unavailable";
    try {
      const j = images.length
        ? await judgeWithImages(client, judgeModel, task, rubric, run.answer, images)
        : await judge(client, judgeModel, task, rubric, run.answer);
      score = j.score;
      why = j.why;
    } catch (e) { why = `judge error: ${String(e).slice(0, 120)}`; }
    const priced = routePrice(route);
    return {
      point: {
        schemaVersion: 1, model: route.meritId, route, score, price: priced.price,
        priceKnown: priced.known,
        latencyMs: run.latencyMs, ts: new Date().toISOString(), source,
        why: `${why}${run.errors ? `; pi errors: ${run.errors}` : ""}; ` +
          `tools=${run.toolCalls}, toolErrors=${run.toolErrors}, changedFiles=${run.changedFiles}`,
        toolCalls: run.toolCalls, toolErrors: run.toolErrors, changedFiles: run.changedFiles,
      },
      costUsd: run.costUsd,
      sessionId: run.sessionId,
    };
}
