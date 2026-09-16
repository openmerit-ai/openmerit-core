import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskKey } from "../src/store.js";
import { taskInputKey } from "../src/task-input.js";

let dir: string | null = null;
const oldHome = process.env.OPENMERIT_HOME;
afterEach(() => {
  process.env.OPENMERIT_HOME = oldHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  vi.resetModules();
});

describe("pi extension model handoff", () => {
  it("persists Pi's scoped provider routes without collapsing equivalent models", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-routes-"));
    process.env.OPENMERIT_HOME = dir;
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const direct = { provider: "anthropic", id: "claude-test", input: ["text"],
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 };
    const routed = { ...direct, provider: "openrouter", id: "anthropic/claude-test" };
    const ctx = { model: direct, scopedModels: [{ model: direct }, { model: routed }],
      modelRegistry: { find: () => undefined, getAvailable: () => [direct, routed] },
      sessionManager: { getSessionFile: () => null }, cwd: dir,
      hasUI: false, isIdle: () => true, ui: { notify: () => undefined } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: () => undefined, setModel: async () => true };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    const state = JSON.parse(readFileSync(join(dir, "harness-state.json"), "utf8"));
    expect(state.currentRoute).toMatchObject({ provider: "anthropic", modelId: "claude-test",
      meritId: "anthropic/claude-test" });
    expect(state.routes).toHaveLength(2);
    expect(new Set(state.routes.map((route: { provider: string }) => route.provider)))
      .toEqual(new Set(["anthropic", "openrouter"]));
    await handlers.get("session_shutdown")?.();
  });

  it("reports a reached trial cap in Pi and skips the comparison", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-budget-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(session, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Task A" }] } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "vendor/a",
        content: [{ type: "text", text: "Answer A" }], stopReason: "stop" } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ budgets: {
      max_trials_per_day: 2, max_usd_per_day: 5,
    } }));
    writeFileSync(join(dir, "ledger.json"), JSON.stringify({
      date: new Date().toISOString().slice(0, 10), trials: 2, usd: 0.0036,
    }));
    const notices: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    let command: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const ctx = { model: { provider: "openrouter", id: "vendor/a" },
      modelRegistry: { find: () => undefined },
      sessionManager: { getSessionFile: () => session }, cwd: dir,
      hasUI: true, isIdle: () => true, ui: { notify: (message: string) => notices.push(message) } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        command = options.handler;
      }, setModel: async () => true };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(notices.some((x) => x.includes("comparison skipped: daily trial cap reached (2)"))).toBe(true);
    expect(notices.some((x) => x.includes("comparing models for task"))).toBe(false);
    await command!("", ctx);
    expect(notices.at(-1)).toContain("comparison    : not started (daily trial cap reached (2))");
    expect(notices.at(-1)).toContain("trial budget  : 2/2 trials, $0.0036/$5.00 today (UTC)");
    await handlers.get("session_shutdown")?.();
  });

  it("starts a session-bound comparison after a completed pi response settles", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-trigger-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(session, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Task A" }], timestamp: 1000 } },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "vendor/a",
        content: [{ type: "text", text: "Answer A" }], timestamp: 1500, stopReason: "stop" } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const notices: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const ctx = { model: { provider: "openrouter", id: "vendor/a" },
      modelRegistry: { find: () => undefined },
      sessionManager: { getSessionFile: () => session }, cwd: dir,
      hasUI: true, isIdle: () => true, ui: { notify: (message: string) => notices.push(message) } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: () => undefined, setModel: async () => true };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(notices.some((x) => x.includes("comparing models for task"))).toBe(true);
    await handlers.get("session_shutdown")?.();
  });

  it("does not reuse a recommendation for a different invoice with the same prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-invoice-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "invoice-session.jsonl");
    const source = join(dir, "source-session.jsonl");
    const prompt = "Extract this invoice to JSON";
    const imageA = { type: "image" as const, mimeType: "image/jpeg",
      data: Buffer.from("invoice A").toString("base64") };
    const imageB = { ...imageA, data: Buffer.from("invoice B").toString("base64") };
    writeFileSync(session, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: prompt }, imageB],
    } }) + "\n");
    writeFileSync(join(dir, "recommendations.jsonl"), JSON.stringify({
      id: "image-A", ts: new Date().toISOString(), taskKey: taskInputKey(prompt, [imageA]),
      taskLabel: prompt, sessionFile: source, currentModel: "vendor/a",
      recommended: { model: "vendor/b", reason: "better" }, fallback: null,
      evidence: { scoreGain: 0.2, priceRatio: 0.5, onFrontier: true, trials: 3 },
      policy: { autoApply: true, reasons: [] }, status: "applied",
    }) + "\n");
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const notices: string[] = [];
    const ctx = { model: { provider: "openrouter", id: "vendor/a" },
      modelRegistry: { find: () => undefined },
      sessionManager: { getSessionFile: () => session }, cwd: dir,
      hasUI: true, isIdle: () => true, ui: { notify: (s: string) => notices.push(s) } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: () => undefined, setModel: async () => true };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(notices).toEqual([]);
    writeFileSync(session, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: prompt }, imageA],
    } }) + "\n");
    await handlers.get("agent_settled")?.({}, ctx);
    expect(notices.filter((x) => x.includes("exact task was tested"))).toHaveLength(1);
    await handlers.get("session_shutdown")?.();
  });

  it("suggests an exact-task result from another session without switching this session", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-reuse-"));
    process.env.OPENMERIT_HOME = dir;
    const task = "Give a word ladder from cat to dog";
    const currentSession = join(dir, "current.jsonl");
    const priorSession = join(dir, "prior.jsonl");
    writeFileSync(currentSession, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: task }],
    } }) + "\n");
    writeFileSync(join(dir, "recommendations.jsonl"), JSON.stringify({
      id: "prior-rec", ts: new Date().toISOString(), taskKey: taskKey(task), taskLabel: task,
      sessionFile: priorSession, currentModel: "vendor/model-a",
      recommended: { model: "vendor/model-b", reason: "quality tied; cheaper" },
      fallback: null, evidence: { scoreGain: 0, priceRatio: 0.5, onFrontier: true, trials: 3 },
      policy: { autoApply: true, reasons: ["all thresholds met"] }, status: "applied",
    }) + "\n");
    writeFileSync(join(dir, "trials.jsonl"), [
      { taskKey: taskKey(task), sessionFile: priorSession, model: "vendor/model-a", score: 0.8, price: 1.2, latencyMs: 1200 },
      { taskKey: taskKey(task), sessionFile: priorSession, model: "vendor/model-b", score: 0.8, price: 0.6, latencyMs: 900 },
      { taskKey: taskKey(task), sessionFile: priorSession, model: "vendor/model-c", score: 0.6, price: 0.4, latencyMs: 500 },
    ].map((p) => JSON.stringify(p)).join("\n") + "\n");
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    let command: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const notices: string[] = [];
    let swaps = 0;
    const ctx = {
      model: { provider: "openrouter", id: "vendor/model-a" },
      modelRegistry: { find: () => undefined },
      sessionManager: { getSessionFile: () => currentSession }, cwd: dir, hasUI: true,
      isIdle: () => true, ui: { notify: (message: string) => notices.push(message) },
    };
    const pi = {
      on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        command = options.handler;
      },
      setModel: async () => { swaps++; return true; },
    };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(swaps).toBe(0);
    expect(notices.filter((x) => x.includes("exact task was tested"))).toHaveLength(1);
    expect(notices[0]).toContain("vendor/model-b: quality 0.80, $0.60/M, 900ms");
    await command!("", ctx);
    expect(notices.at(-1)).toContain("exact task was tested");
    expect(notices.at(-1)).toContain("pending recs  : 0");
    writeFileSync(currentSession, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: "Give a word ladder from cat to fox" }],
    } }) + "\n");
    await handlers.get("agent_settled")?.({}, ctx);
    expect(notices.filter((x) => x.includes("exact task was tested"))).toHaveLength(2);
    await handlers.get("session_shutdown")?.();
  });

  it("automatically applies only a recommendation bound to its settled session", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ext-auto-"));
    process.env.OPENMERIT_HOME = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(session, JSON.stringify({ type: "message", message: {
      role: "user", content: [{ type: "text", text: "task A" }],
    } }) + "\n");
    const base = { ts: new Date().toISOString(), taskKey: taskKey("task A"), taskLabel: "task A",
      currentModel: "vendor/model-a", recommended: { model: "vendor/model-b", reason: "better" },
      fallback: null, evidence: { scoreGain: 0.2, priceRatio: 0.5, onFrontier: true, trials: 3 },
      policy: { autoApply: true, reasons: ["all auto-apply thresholds met"] }, status: "pending" };
    writeFileSync(join(dir, "recommendations.jsonl"), [
      { ...base, id: "wrong", sessionFile: join(dir, "other.jsonl") },
      { ...base, id: "right", sessionFile: session },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    let switched = 0;
    const ctx = {
      model: { provider: "openrouter", id: "vendor/model-a" },
      modelRegistry: { find: (provider: string, id: string) =>
        provider === "openrouter" && id === "vendor/model-b" ? { provider, id } : undefined },
      sessionManager: { getSessionFile: () => session }, cwd: dir, hasUI: false,
      isIdle: () => true, ui: { notify: () => undefined },
    };
    const pi = {
      on: (name: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(name, fn),
      registerCommand: () => undefined,
      setModel: async (model: { provider: string; id: string }) => {
        switched++;
        ctx.model = model;
        return true;
      },
    };
    const { default: extension } = await import("../extension/openmerit.js");
    extension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    expect(switched).toBe(0);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(switched).toBe(1);
    expect(ctx.model.id).toBe("vendor/model-b");
    const lines = readFileSync(join(dir, "recommendations.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!).id).toBe("right");
    expect(JSON.parse(lines.at(-1)!).status).toBe("applied");
    await handlers.get("session_shutdown")?.();
  });

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
