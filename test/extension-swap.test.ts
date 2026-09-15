import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskKey } from "../src/store.js";

let dir: string | null = null;
const oldHome = process.env.OPENMERIT_HOME;
afterEach(() => {
  process.env.OPENMERIT_HOME = oldHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  vi.resetModules();
});

describe("pi extension model handoff", () => {
  it("applies a recommendation for the active task and changes the session model", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(session, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: "task A" }],
    } }) + "\n");
    const rec = {
      id: "rec-a", ts: new Date().toISOString(), taskKey: taskKey("task A"), taskLabel: "task A",
      currentModel: "vendor/model-a", recommended: { model: "vendor/model-b", reason: "better" },
      fallback: null, evidence: { scoreGain: 0.2, priceRatio: 0.5, onFrontier: true, trials: 3 },
      policy: { autoApply: false, reasons: ["recommend mode"] }, status: "pending",
    };
    writeFileSync(join(dir, "recommendations.jsonl"), JSON.stringify(rec) + "\n");
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    let command: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const ctx = {
      model: { provider: "openrouter", id: "vendor/model-a" },
      modelRegistry: { find: (provider: string, id: string) =>
        provider === "openrouter" && id === "vendor/model-b" ? { provider, id } : undefined },
      sessionManager: { getSessionFile: () => session }, cwd: dir, hasUI: false,
      ui: { notify: () => undefined },
    };
    const pi = {
      on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        command = options.handler;
      },
      setModel: async (model: { provider: string; id: string }) => { ctx.model = model; return true; },
    };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    expect(command).not.toBeNull();
    await command!("apply", ctx);
    expect(ctx.model.id).toBe("vendor/model-b");
    const lines = readFileSync(join(dir, "recommendations.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!).status).toBe("applied");
    await handlers.get("session_shutdown")?.();
  });
});
