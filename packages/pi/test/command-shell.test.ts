import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { Check } from "typebox/value";
import {
  completionToolSchemaFor,
  INTENT_OUTPUT_SCHEMAS,
  type IntentKind,
} from "@openmerit/protocol";

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

const testProjectRoot = mkdtempSync(join(tmpdir(), "openmerit-pi-test-"));
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
  const tools = new Map<string, NonNullable<typeof completionTool>>();

  const pi = {
    registerCommand(name: string, definition: { handler: typeof handler }) {
      assert.equal(name, "openmerit");
      handler = definition.handler;
    },
    on(event: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
      eventHandlers.set(event, callback);
    },
    registerTool(definition: typeof completionTool) {
      if (!definition) return;
      const named = definition as typeof definition & { name: string };
      tools.set(named.name, named);
      if (named.name === "openmerit_complete_intent") {
        completionTool = named;
        completionTools.push(named);
      }
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
  return { handler, completionTool, completionTools, tools, entries, messages, eventHandlers };
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
      checkPolicy: {
        baselineAssessment: { afterCompletedTasks: 3 },
        frontierReassessment: { afterCompletedTasks: 100, afterElapsedSeconds: 2592000, onModelCatalogChange: true },
        regressionCheck: { afterCompletedTasks: 25, thresholds: [{ metricId: "task_success", relativeChangeAtLeast: 0.1 }] },
        postSwapVerification: { afterCompletedTasks: 20, afterElapsedSeconds: 86400 },
        cooldownSeconds: 3600,
        execution: { mode: "active_session_only", infrastructureChangesAllowed: false },
      },
    },
    observability: {
      status: "ready",
      requiredMetricIds: ["task_success"] as string[],
      coveredMetricIds: ["task_success"] as string[],
      missingMetricIds: [] as string[],
      checkedAt: new Date().toISOString(),
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
    getContextUsage: () => ({ tokens: 100 }),
  } as unknown as ExtensionContext;
}

test("Pi automatically starts setup for an unconfigured interactive project", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-auto-setup-"));
  const notifications: Notification[] = [];
  const { eventHandlers, entries, messages } = loadCommand();
  const sessionStart = eventHandlers.get("session_start");
  assert.ok(sessionStart);

  try {
    await sessionStart({ type: "session_start" }, sessionContext(projectRoot, notifications));
    assert.match(notifications[0]?.message ?? "", /asking Pi to establish evals and observability/);
    assert.equal(entries[0]?.customType, "openmerit.intent");
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
  assert.equal(entries[0]?.customType, "openmerit.intent");
  assert.equal(messages.length, 1);
  assert.equal((messages[0]?.message as { display?: boolean }).display, false);
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
});

test("Pi replaces the completion tool with a strict-compatible active intent schema", async () => {
  rmSync(join(testProjectRoot, ".openmerit"), { recursive: true, force: true });
  const notifications: Notification[] = [];
  const { handler, completionTools } = loadCommand();

  await handler("assess", commandContext(notifications));

  assert.equal(completionTools.length, 2);
  const activeTool = completionTools.at(-1);
  assert.ok(activeTool?.parameters);
  assert.doesNotThrow(() => makeStrictJsonSchema(activeTool.parameters as never));
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
  }), true);
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Forgot the proof",
    evidence: [],
    outputs: { baselineEvidenceSufficient: true },
  }), true);
});

test("every intent completion schema supports Pi strict sampling", () => {
  for (const kind of Object.keys(INTENT_OUTPUT_SCHEMAS) as IntentKind[]) {
    assert.doesNotThrow(() => makeStrictJsonSchema(completionToolSchemaFor(kind)), kind);
  }
});

test("completion requires evidence for success and persists the result", async () => {
  rmSync(join(testProjectRoot, ".openmerit"), { recursive: true, force: true });
  const notifications: Notification[] = [];
  const { handler, completionTools, entries } = loadCommand();
  await handler("setup", commandContext(notifications));
  const intent = (entries[0]?.data as { intent: { id: string } }).intent;
  const completionTool = completionTools.at(-1);
  assert.ok(completionTool);

  await assert.rejects(
    completionTool.execute("tool-1", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Done without proof",
      evidence: [],
    }, undefined, undefined, commandContext(notifications)),
    /requires at least one evidence reference/,
  );

  await assert.rejects(
    completionTool.execute("tool-2", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Done without structured outputs",
      evidence: [{
        id: "eval-1",
        source: "evaluation_artifact",
        uri: "file:///workspace/evals/task.test.ts",
      }],
    }, undefined, undefined, commandContext(notifications)),
    /result outputs/,
  );

  await completionTool.execute("tool-3", {
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

  assert.equal(entries[1]?.customType, "openmerit.result");
});

test("Pi turns completed work into durable signals and dispatches a due assessment", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-signals-"));
  const notifications: Notification[] = [];
  const { handler, completionTool, entries, eventHandlers } = loadCommand();
  const ctx = sessionContext(projectRoot, notifications);
  const settled = eventHandlers.get("agent_settled");
  assert.ok(settled);

  try {
    await handler("setup", { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext);
    const intent = (entries[0]?.data as { intent: { id: string } }).intent;
    await completionTool.execute("tool-setup", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Configured evals, observability, and automation policy",
      evidence: [{ id: "eval", source: "evaluation_artifact", uri: "file:///eval.json" }],
      outputs: confirmedSetupOutputs(),
    }, undefined, undefined, ctx as unknown as ExtensionCommandContext);

    await settled({ type: "agent_settled" }, ctx); // completion turn is deliberately suppressed
    await settled({ type: "agent_settled" }, ctx);
    await settled({ type: "agent_settled" }, ctx);
    await settled({ type: "agent_settled" }, ctx);

    const intentKinds = entries
      .filter((entry) => entry.customType === "openmerit.intent")
      .map((entry) => (entry.data as { intent: { kind: string } }).intent.kind);
    assert.deepEqual(intentKinds, ["establish_evals", "run_assessment"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Pi automatically requests instrumentation when setup reports a required metric gap", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-instrumentation-"));
  const notifications: Notification[] = [];
  const { handler, completionTool, entries } = loadCommand();
  const ctx = sessionContext(projectRoot, notifications);

  try {
    await handler("setup", { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext);
    const intent = (entries[0]?.data as { intent: { id: string } }).intent;
    const outputs = confirmedSetupOutputs();
    outputs.observability = {
      ...outputs.observability,
      status: "incomplete",
      coveredMetricIds: [] as string[],
      missingMetricIds: ["task_success"] as string[],
    };
    await completionTool.execute("tool-setup", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Configured evals but found a required instrumentation gap",
      evidence: [{ id: "eval", source: "evaluation_artifact", uri: "file:///eval.json" }],
      outputs,
    }, undefined, undefined, ctx as unknown as ExtensionCommandContext);

    const intentKinds = entries
      .filter((entry) => entry.customType === "openmerit.intent")
      .map((entry) => (entry.data as { intent: { kind: string } }).intent.kind);
    assert.deepEqual(intentKinds, ["establish_evals", "instrument_observability"]);
    const events = readFileSync(join(projectRoot, ".openmerit", "events.jsonl"), "utf8");
    assert.match(events, /"type":"observability_readiness_checked"/);
    assert.match(events, /"missingMetricIds":\["task_success"\]/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("initial state renders without model-changing behavior", () => {
  const status = renderStatus(createInitialUiState());
  assert.doesNotMatch(status, /current model|recommended model|apply model/i);
});

test("Pi exposes a typed ingress for observability and verification signals", () => {
  const { tools } = loadCommand();
  const signalTool = tools.get("openmerit_report_signal");
  assert.ok(signalTool?.parameters);
  assert.equal(Check(signalTool.parameters as never, {
    signalId: "window-1",
    type: "metric_window_available",
    metrics: [{
      metricId: "task_success",
      state: "measured",
      scope: "sample_window",
      direction: "maximize",
      method: "observed",
      value: 0.95,
      unit: "ratio",
      sampleCount: 20,
      evidence: [{ id: "obs", source: "observability_record", uri: "file:///metrics.json" }],
    }],
  }), true);
});
