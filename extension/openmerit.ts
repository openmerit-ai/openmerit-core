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

function pendingRecommendations(): Recommendation[] {
  return latestRecommendations().filter((r) => r.status === "pending");
}

function setStatus(rec: Recommendation, status: Recommendation["status"]): void {
  appendJsonl(RECS_FILE, { ...rec, status, ts: new Date().toISOString() });
}

function reportHarnessState(ctx: ExtensionContext): void {
  try {
    mkdirSync(HOME, { recursive: true });
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        currentModel: model,
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd,
        updatedAt: new Date().toISOString(),
      }) + "\n",
    );
  } catch {
    /* never break the host session over reporting */
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

export default function openmerit(pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fallbackModel: string | null = null;
  const notified = new Set<string>();

  async function applyRecommendation(ctx: ExtensionContext, rec: Recommendation): Promise<boolean> {
    const model = resolveModel(ctx, rec.recommended.model);
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
    for (const rec of pendingRecommendations()) {
      if (notified.has(rec.id)) continue;
      notified.add(rec.id);
      if (rec.fallback) fallbackModel = rec.fallback.model;

      if (rec.policy.autoApply) {
        await applyRecommendation(ctx, rec);
        continue;
      }
      if (!ctx.hasUI) continue; // print/json mode: leave for /openmerit apply
      const choice = await ctx.ui.select(
        `openmerit recommends: ${rec.recommended.model}\n\n${rec.recommended.reason}\n\ngate: ${rec.policy.reasons.join("; ")}`,
        ["Apply", "Dismiss", "Later"],
      );
      if (choice === "Apply") await applyRecommendation(ctx, rec);
      else if (choice === "Dismiss") setStatus(rec, "dismissed");
      else notified.delete(rec.id); // "Later": re-surface next poll
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    reportHarnessState(ctx);
    await surface(ctx);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      surface(ctx).catch(() => undefined);
    }, 30_000);
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
    const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model";
    const model = resolveModel(ctx, fallbackModel);
    if (!model) return;

    const auto = policy.mode === "auto";
    const ok =
      auto ||
      (ctx.hasUI &&
        (await ctx.ui.confirm(
          "openmerit fallback",
          `${current} is failing. Switch to frontier fallback ${fallbackModel}?`,
        )));
    if (!ok) return;
    if (await pi.setModel(model as Parameters<typeof pi.setModel>[0])) {
      ctx.ui.notify(`openmerit: fallback engaged -> ${fallbackModel}`, "warning");
      reportHarnessState(ctx);
    }
  });

  pi.registerCommand("openmerit", {
    description: "OpenMerit: status, pending recommendations, apply/dismiss",
    handler: async (args, ctx) => {
      const pending = pendingRecommendations();
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

      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
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
