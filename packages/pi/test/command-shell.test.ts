import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Check } from "typebox/value";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import openMeritExtension, {
  createInitialUiState,
  renderStatus,
} from "../src/index.ts";

interface Notification {
  message: string;
  level: string;
}

const testProjectRoot = mkdtempSync(join(tmpdir(), "openmerit-v2-pi-test-"));
after(() => rmSync(testProjectRoot, { recursive: true, force: true }));

function loadCommand() {
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const eventHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  let completionTool: {
    parameters?: unknown;
    execute: (
      toolCallId: string,
      input: CompletionInputForTest,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: ExtensionCommandContext,
    ) => Promise<unknown>;
  } | undefined;
  const completionTools: Array<NonNullable<typeof completionTool>> = [];

  const pi = {
    registerCommand(name: string, definition: { handler: typeof handler }) {
      assert.equal(name, "openmerit");
      handler = definition.handler;
    },
    on(event: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
      eventHandlers.set(event, callback);
    },
    registerTool(definition: typeof completionTool) {
      completionTool = definition;
      if (definition) completionTools.push(definition);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  openMeritExtension(pi);
  assert.ok(handler);
  assert.ok(completionTool);
  return { handler, completionTool, completionTools, entries, messages, eventHandlers };
}

interface CompletionInputForTest {
  intentId: string;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  evidence: Array<{
    id: string;
    source: "evaluation_artifact";
    uri: string;
  }>;
  outputs?: Record<string, unknown>;
}

function confirmedSetupOutputs() {
  return {
    taskProfile: {
      id: "profile-test",
      revision: 1,
      name: "Test task",
      goal: "Complete the representative project task",
      objectives: [{ metricId: "task_success", required: true, minimumSamples: 3, tolerance: 0 }],
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    },
    policy: {
      mode: "supervised_graduation",
      evaluationBudget: { currency: "USD", maximumSpend: 10 },
      automaticSwapsEnabled: false,
      confirmationRequiredUntilVerifiedSwaps: 3,
      requirePostSwapVerification: true,
      rollbackOnRegression: true,
    },
  };
}

function commandContext(notifications: Notification[]): ExtensionCommandContext {
  return {
    cwd: testProjectRoot,
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
}

function sessionContext(projectRoot: string, notifications: Notification[]): ExtensionContext {
  return {
    cwd: projectRoot,
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: { getEntries: () => [] },
    modelRegistry: { getAvailable: () => [] },
  } as unknown as ExtensionContext;
}

test("Pi automatically starts setup for an unconfigured interactive project", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-v2-auto-setup-"));
  const notifications: Notification[] = [];
  const { eventHandlers, entries, messages } = loadCommand();
  const sessionStart = eventHandlers.get("session_start");
  assert.ok(sessionStart);

  try {
    await sessionStart({ type: "session_start" }, sessionContext(projectRoot, notifications));
    assert.match(notifications[0]?.message ?? "", /asking Pi to establish evals and observability/);
    assert.equal(entries[0]?.customType, "openmerit-v2.intent");
    assert.equal((entries[0]?.data as { intent: { kind: string } }).intent.kind, "establish_evals");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("status emphasizes evidence readiness", async () => {
  const notifications: Notification[] = [];
  const { handler } = loadCommand();

  await handler("", commandContext(notifications));

  assert.match(notifications[0]?.message ?? "", /OpenMerit evidence readiness/);
  assert.match(notifications[0]?.message ?? "", /task profile\s+: not configured/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /switch|fallback/i);
});

test("pause and resume control proactive nudges", async () => {
  const notifications: Notification[] = [];
  const { handler } = loadCommand();
  const ctx = commandContext(notifications);

  await handler("pause", ctx);
  await handler("status", ctx);
  await handler("resume", ctx);
  await handler("status", ctx);

  assert.match(notifications[1]?.message ?? "", /proactive nudges\s+: paused/);
  assert.match(notifications[3]?.message ?? "", /proactive nudges\s+: enabled/);
});

test("setup dispatches a private typed intent", async () => {
  rmSync(join(testProjectRoot, ".openmerit"), { recursive: true, force: true });
  const notifications: Notification[] = [];
  const { handler, entries, messages } = loadCommand();

  await handler("setup", commandContext(notifications));

  assert.match(notifications[0]?.message ?? "", /setup started/);
  assert.equal(entries[0]?.customType, "openmerit-v2.intent");
  assert.equal(messages.length, 1);
  assert.equal((messages[0]?.message as { display?: boolean }).display, false);
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
});

test("Pi replaces the completion tool with the active intent schema", async () => {
  rmSync(join(testProjectRoot, ".openmerit"), { recursive: true, force: true });
  const notifications: Notification[] = [];
  const { handler, completionTools } = loadCommand();

  await handler("assess", commandContext(notifications));

  assert.equal(completionTools.length, 2);
  const activeTool = completionTools.at(-1);
  assert.ok(activeTool?.parameters);
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Baseline is ready",
    evidence: [{ id: "trace", source: "harness_trace", uri: "file:///trace.json" }],
    outputs: { baselineEvidenceSufficient: true },
  }), true);
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Guessed the contract",
    evidence: [{ id: "trace", source: "harness_trace", uri: "file:///trace.json" }],
    outputs: { baseline_ready: "yes" },
  }), false);
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Forgot the output",
    evidence: [{ id: "trace", source: "harness_trace", uri: "file:///trace.json" }],
  }), false);
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Forgot the proof",
    evidence: [],
    outputs: { baselineEvidenceSufficient: true },
  }), false);
});

test("completion requires evidence for success and persists the result", async () => {
  rmSync(join(testProjectRoot, ".openmerit"), { recursive: true, force: true });
  const notifications: Notification[] = [];
  const { handler, completionTool, entries } = loadCommand();
  await handler("setup", commandContext(notifications));
  const intent = (entries[0]?.data as { intent: { id: string } }).intent;

  await assert.rejects(
    completionTool.execute("tool-1", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Done without proof",
      evidence: [],
    }, undefined, undefined, commandContext(notifications)),
    /requires at least one evidence reference/,
  );

  await completionTool.execute("tool-2", {
    intentId: intent.id,
    status: "succeeded",
    summary: "Eval created and verified",
    evidence: [{
      id: "eval-1",
      source: "evaluation_artifact",
      uri: "file:///workspace/evals/task.test.ts",
    }],
    outputs: confirmedSetupOutputs(),
  }, undefined, undefined, commandContext(notifications));

  assert.equal(entries[1]?.customType, "openmerit-v2.result");
});

test("initial state renders without model-changing behavior", () => {
  const status = renderStatus(createInitialUiState());
  assert.doesNotMatch(status, /current model|recommended model|apply model/i);
});
