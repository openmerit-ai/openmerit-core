/**
 * OpenMerit pi extension — runs INSIDE the main harness.
 *
 * Install: copy/symlink this file to ~/.pi/agent/extensions/openmerit.ts
 * and run `openmerit watch` (the background track) alongside your session.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const HOME = process.env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");
const RECS_FILE = join(HOME, "recommendations.jsonl");
const STATE_FILE = join(HOME, "harness-state.json");
const POLICY_FILE = join(HOME, "policy.json");

interface ExtensionPolicy {
  mode?: string;
  fallback?: { apply_on_error?: boolean };
}

function loadPolicy(): ExtensionPolicy {
  try {
    return JSON.parse(readFileSync(POLICY_FILE, "utf8")) as ExtensionPolicy;
  } catch {
    return {};
  }
}

interface Recommendation {
  id: string;
  ts: string;
  taskKey: string;
  taskLabel: string;
  sessionFile?: string | null;
  currentModel: string | null;
  recommended: { model: string; reason: string };
  fallback: { model: string; reason: string } | null;
  evidence: { scoreGain: number; priceRatio: number; onFrontier: boolean; trials: number };
  policy: { autoApply: boolean; reasons: string[] };
  status: "pending" | "applied" | "dismissed" | "expired";
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
  return [...byId.values()];
}

function taskKey(text: string): string {
  return createHash("sha1").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
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
      const content = e.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" ") : "";
      if (text.trim()) latest = taskKey(text);
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

function canonicalModel(provider: string, id: string): string {
  return provider === "openrouter" ? id : `${provider}/${id}`;
}

function setStatus(rec: Recommendation, status: Recommendation["status"]): void {
  appendJsonl(RECS_FILE, { ...rec, status, ts: new Date().toISOString() });
}

let fallbackModel: string | null = null;

function reportHarnessState(ctx: ExtensionContext, settled = false): void {
  try {
    mkdirSync(HOME, { recursive: true });
    const model = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    if (settled) settledTaskKey = latestSessionTaskKey(ctx);
    const prior = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as { sessionFile?: string | null; settledAt?: string }
      : {};
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const settledAt = settled ? new Date().toISOString()
      : prior.sessionFile === sessionFile ? prior.settledAt ?? null : null;
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        currentModel: model,
        fallbackModel,
        sessionFile,
        settledTaskKey,
        settledAt,
        cwd: ctx.cwd,
        updatedAt: new Date().toISOString(),
      }) + "\n",
    );
  } catch {
    /* never break the host session over reporting */
  }
}

/** Restore the persisted fallback so a fresh session keeps it even with no pending recs. */
function restoreFallback(): void {
  try {
    const st = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { fallbackModel?: string | null };
    if (st.fallbackModel) fallbackModel = st.fallbackModel;
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
function ensureModel(pi: ExtensionAPI, ctx: ExtensionContext, openrouterId: string) {
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
      input: ["text"],
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

  const reg = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => unknown | undefined;
  };
  return reg.find?.(INJECT_PROVIDER, openrouterId);
}

export default function openmerit(pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const notified = new Set<string>();

  async function applyRecommendation(ctx: ExtensionContext, rec: Recommendation): Promise<boolean> {
    const current = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : null;
    if (rec.currentModel && current !== rec.currentModel) {
      ctx.ui.notify(`openmerit: recommendation was measured against ${rec.currentModel}; current model is ${current ?? "unknown"}`, "warning");
      return false;
    }
    const model = ensureModel(pi, ctx, rec.recommended.model);
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
      if (rec.fallback) fallbackModel = rec.fallback.model;
      ctx.ui.notify(`openmerit: switched to ${rec.recommended.model}\n${rec.recommended.reason}`, "info");
      reportHarnessState(ctx);
    } else {
      ctx.ui.notify(`openmerit: no auth for ${rec.recommended.model}`, "error");
    }
    return ok;
  }

  async function surface(ctx: ExtensionContext): Promise<void> {
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
          `openmerit recommends: ${rec.recommended.model}\n${rec.recommended.reason}\n` +
            `gate: ${rec.policy.reasons.join("; ")}\n(/openmerit apply to switch, /openmerit dismiss to ignore)`,
          "info",
        );
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
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
    const model = ensureModel(pi, ctx, fallbackModel);
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
        const model = ensureModel(pi, ctx, fallbackModel);
        if (model && (await pi.setModel(model as Parameters<typeof pi.setModel>[0]))) {
          ctx.ui.notify(`openmerit: switched to fallback ${fallbackModel}`, "info");
          reportHarnessState(ctx);
        } else {
          ctx.ui.notify(`openmerit: could not switch to ${fallbackModel} (not in registry or no auth)`, "error");
        }
        return;
      }

      const current = ctx.model ? canonicalModel(ctx.model.provider, ctx.model.id) : "unknown";
      const lines = [
        `current model : ${current}`,
        `fallback      : ${fallbackModel ?? "n/a"}`,
        `pending recs  : ${pending.length}`,
      ];
      for (const r of pending.slice(-5)) {
        lines.push(
          "",
          `-> ${r.recommended.model} (gain ${r.evidence.scoreGain}, ${r.evidence.priceRatio}x price, frontier=${r.evidence.onFrontier})`,
          `   ${r.recommended.reason}`,
          `   gate: ${r.policy.reasons.join("; ") || "n/a"}`,
        );
        if (r.fallback) lines.push(`   fallback: ${r.fallback.model} — ${r.fallback.reason}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
