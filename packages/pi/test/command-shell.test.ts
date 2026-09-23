import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  detectApplicationLlmTargets,
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
  const userMessages: Array<{ content: unknown; options: unknown }> = [];
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
    sendUserMessage(content: unknown, options: unknown) {
      userMessages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  openMeritExtension(pi);
  assert.ok(handler);
  assert.ok(completionTool);
  return { handler, completionTool, completionTools, tools, entries, messages, userMessages, eventHandlers };
}

interface CompletionInputForTest {
  intentId: string;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  evidence: Array<{
    id: string;
    source: "harness_trace" | "evaluation_artifact" | "observability_record" | "external_source" | "user_feedback";
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
      applicationTarget: {
        id: "app-target-test",
        kind: "application_llm_call",
        name: "Test application LLM route",
        applicationId: "test-app",
        callSites: ["src/llm.ts:1"],
        routeKey: "TEST_MODEL",
        confirmedAt: new Date().toISOString(),
      },
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
      targetId: "app-target-test",
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
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [] },
    getContextUsage: () => ({ tokens: 100 }),
    isIdle: () => false,
  } as unknown as ExtensionContext;
}

test("Pi automatically starts setup only when an application LLM call is detected", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-auto-setup-"));
  writeFileSync(join(projectRoot, "app.ts"), "await client.chat.completions.create({ model: 'app-model' });\n");
  const notifications: Notification[] = [];
  const { eventHandlers, entries, messages } = loadCommand();
  const sessionStart = eventHandlers.get("session_start");
  assert.ok(sessionStart);

  try {
    await sessionStart({ type: "session_start" }, sessionContext(projectRoot, notifications));
    assert.match(notifications[0]?.message ?? "", /detected 1 application LLM target/);
    assert.equal(entries[0]?.customType, "openmerit.intent");
    const intent = (entries[0]?.data as { intent: { kind: string; constraints: Record<string, unknown> } }).intent;
    assert.equal(intent.kind, "establish_evals");
    assert.equal(intent.constraints.applicationTargetRequired, true);
    assert.equal((intent.constraints.detectedApplicationTargets as Array<{ kind: string }>)[0]?.kind, "application_llm_call");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Pi remains idle for an unconfigured project without an application LLM call", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-auto-idle-"));
  const notifications: Notification[] = [];
  const { eventHandlers, entries } = loadCommand();
  const sessionStart = eventHandlers.get("session_start");
  assert.ok(sessionStart);
  try {
    await sessionStart({ type: "session_start" }, sessionContext(projectRoot, notifications));
    assert.match(notifications[0]?.message ?? "", /no application LLM call detected/);
    assert.equal(entries.length, 0);
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
  const { handler, completionTools, entries } = loadCommand();

  await handler("setup", commandContext(notifications));
  const setupTool = completionTools.at(-1);
  assert.ok(setupTool);
  const setupIntent = (entries[0]?.data as { intent: { id: string } }).intent.id;
  await setupTool.execute("tool-setup", {
    intentId: setupIntent,
    status: "succeeded",
    summary: "Configured",
    evidence: [{ id: "setup", source: "evaluation_artifact", uri: "file:///setup.json" }],
    outputs: confirmedSetupOutputs(),
  }, undefined, undefined, commandContext(notifications));
  await handler("assess", commandContext(notifications));

  assert.ok(completionTools.length >= 2);
  const activeTool = completionTools.at(-1);
  assert.ok(activeTool?.parameters);
  assert.doesNotThrow(() => makeStrictJsonSchema(activeTool.parameters as never));
  assert.equal(Check(activeTool.parameters as never, {
    intentId: "intent-1",
    status: "succeeded",
    summary: "Baseline is ready",
    evidence: [{ id: "trace", source: "harness_trace", uri: "file:///trace.json" }],
    outputs: {
      targetId: "app-target-test",
      baselineEvidenceSufficient: true,
      metrics: [{
        targetId: "app-target-test",
        metricId: "task_success",
        state: "measured",
        scope: "sample_window",
        direction: "maximize",
        method: "observed",
        value: 1,
        unit: "ratio",
        sampleCount: 1,
        evidence: [{ id: "metrics", source: "observability_record", uri: "file:///metrics.json" }],
      }],
    },
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
  }), false);
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

test("Pi dispatches assessment only from application-target signals", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-signals-"));
  const notifications: Notification[] = [];
  const { handler, completionTool, entries, tools } = loadCommand();
  const ctx = sessionContext(projectRoot, notifications);
  const signalTool = tools.get("openmerit_report_signal");
  assert.ok(signalTool);

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

    for (let index = 0; index < 3; index += 1) {
      await signalTool.execute(`tool-task-${index}`, {
        signalId: `application-task-${index}`,
        type: "product_task_completed",
        targetId: "app-target-test",
        modelId: "provider/application-model",
        evidence: [{ id: `trace-${index}`, source: "harness_trace", uri: `file:///app-task-${index}.json` }],
      } as never, undefined, undefined, ctx as unknown as ExtensionCommandContext);
    }

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
  const { handler, completionTool, completionTools, entries, userMessages, eventHandlers } = loadCommand();
  const ctx = sessionContext(projectRoot, notifications);
  const input = eventHandlers.get("input");
  assert.ok(input);

  try {
    await handler("setup", { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext);
    await input({ type: "input", text: "Build the product after setup", source: "interactive" }, ctx);
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
    assert.equal(userMessages.length, 0);
    const instrumentationEntry = [...entries].reverse().find((entry) => entry.customType === "openmerit.intent");
    const instrumentationIntent = (instrumentationEntry?.data as { intent: { id: string } }).intent;
    const instrumentationTool = completionTools.at(-1);
    assert.ok(instrumentationTool);
    await instrumentationTool.execute("tool-instrument", {
      intentId: instrumentationIntent.id,
      status: "succeeded",
      summary: "Instrumentation completed",
      evidence: [{ id: "trace", source: "evaluation_artifact", uri: "file:///trace.json" }],
      outputs: { targetId: "app-target-test", coveredMetricIds: ["task_success"], missingMetricIds: [] },
    }, undefined, undefined, ctx as unknown as ExtensionCommandContext);
    assert.equal(userMessages[0]?.content, "Build the product after setup");
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
    targetId: "app-target-test",
    metrics: [{
      targetId: "app-target-test",
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

test("Pi queues interactive input while setup is active and releases it after completion", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-queued-input-"));
  const notifications: Notification[] = [];
  const { handler, completionTool, entries, userMessages, eventHandlers } = loadCommand();
  const input = eventHandlers.get("input");
  assert.ok(input);

  try {
    await handler("setup", { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext);
    const handled = await input({ type: "input", text: "Build the requested feature", source: "interactive" }, sessionContext(projectRoot, notifications));
    assert.deepEqual(handled, { action: "handled" });
    const intent = (entries[0]?.data as { intent: { id: string } }).intent;
    await completionTool.execute("tool-setup", {
      intentId: intent.id,
      status: "succeeded",
      summary: "Configured",
      evidence: [{ id: "eval", source: "evaluation_artifact", uri: "file:///eval.json" }],
      outputs: confirmedSetupOutputs(),
    }, undefined, undefined, sessionContext(projectRoot, notifications) as unknown as ExtensionCommandContext);

    assert.deepEqual(userMessages, [{
      content: "Build the requested feature",
      options: { deliverAs: "followUp" },
    }]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Pi allows user replies when an active intent is waiting at the prompt", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-intent-reply-"));
  const notifications: Notification[] = [];
  const { handler, eventHandlers, userMessages } = loadCommand();
  const input = eventHandlers.get("input");
  assert.ok(input);
  try {
    await handler("setup", { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext);
    const ctx = { ...sessionContext(projectRoot, notifications), isIdle: () => true } as ExtensionContext;
    const result = await input({ type: "input", text: "I approve the proposed policy", source: "interactive" }, ctx);
    assert.equal(result, undefined);
    assert.equal(userMessages.length, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cancel records interrupted work as cancelled and clears durable active state", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-cancel-"));
  const notifications: Notification[] = [];
  const { handler } = loadCommand();
  try {
    const ctx = { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext;
    await handler("setup", ctx);
    await handler("cancel", ctx);
    const state = JSON.parse(readFileSync(join(projectRoot, ".openmerit", "state.json"), "utf8"));
    assert.equal(state.activeIntent, undefined);
    assert.equal(state.lastResult.status, "cancelled");
    assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Pi does not turn its own model telemetry into application evidence", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-task-telemetry-"));
  const notifications: Notification[] = [];
  const { eventHandlers } = loadCommand();

  try {
    assert.equal(eventHandlers.has("agent_start"), false);
    assert.equal(eventHandlers.has("message_end"), false);
    assert.equal(eventHandlers.has("agent_settled"), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Pi accepts application cost telemetry and rejects coverage-only tool-use claims", async () => {
  const { tools } = loadCommand();
  const signalTool = tools.get("openmerit_report_signal");
  assert.ok(signalTool);
  const projectRoot = mkdtempSync(join(tmpdir(), "openmerit-application-metrics-"));
  const notifications: Notification[] = [];
  const { handler, completionTools, entries } = loadCommand();
  const ctx = { ...commandContext(notifications), cwd: projectRoot } as ExtensionCommandContext;
  await handler("setup", ctx);
  const setupIntent = (entries[0]?.data as { intent: { id: string } }).intent;
  await completionTools.at(-1)!.execute("tool-setup", {
    intentId: setupIntent.id,
    status: "succeeded",
    summary: "Configured",
    evidence: [{ id: "eval", source: "evaluation_artifact", uri: "file:///eval.json" }],
    outputs: confirmedSetupOutputs(),
  }, undefined, undefined, ctx);
  const base = {
    targetId: "app-target-test",
    state: "measured", scope: "single_run", direction: "minimize", method: "evaluator",
    value: 0, unit: "usd", sampleCount: 1,
    evidence: [{ id: "eval", source: "evaluation_artifact", uri: "file:///coverage.json" }],
  };
  await signalTool.execute("signal", { signalId: "app-cost", type: "metric_window_available", targetId: "app-target-test", metrics: [
    { ...base, metricId: "total_task_cost" },
  ] } as never, undefined, undefined, ctx);
  await assert.rejects(
    signalTool.execute("signal", { signalId: "bad-tools", type: "metric_window_available", targetId: "app-target-test", metrics: [
      { ...base, metricId: "tool_use_performance", direction: "maximize", unit: "score" },
    ] } as never, undefined, undefined, ctx),
    /requires harness-trace evidence/,
  );
  rmSync(projectRoot, { recursive: true, force: true });
});
