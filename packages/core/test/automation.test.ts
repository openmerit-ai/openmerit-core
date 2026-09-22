import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPENMERIT_SCHEMA_DIALECT,
  type AutomationSignal,
  type HarnessDescriptor,
  type OpenMeritProjectState,
  type SupervisedGraduationPolicy,
} from "@openmerit/protocol";
import {
  buildAutomationPlan,
  OpenMeritCoordinator,
  ProjectStore,
  type HarnessAdapter,
} from "../src/index.ts";

const policy: SupervisedGraduationPolicy = {
  mode: "supervised_graduation",
  evaluationBudget: { currency: "USD", maximumSpend: 20 },
  automaticSwapsEnabled: false,
  confirmationRequiredUntilVerifiedSwaps: 2,
  requirePostSwapVerification: true,
  rollbackOnRegression: true,
  checkPolicy: {
    baselineAssessment: { afterCompletedTasks: 2, afterElapsedSeconds: 3600 },
    frontierReassessment: { afterCompletedTasks: 100, afterElapsedSeconds: 604800, onModelCatalogChange: true },
    regressionCheck: {
      afterCompletedTasks: 100,
      thresholds: [{ metricId: "task_success", relativeChangeAtLeast: 0.1 }],
    },
    postSwapVerification: { afterCompletedTasks: 10, afterElapsedSeconds: 86400 },
    cooldownSeconds: 0,
    execution: { mode: "persistent", infrastructureChangesAllowed: false },
  },
};

const descriptor: HarnessDescriptor = {
  id: "automation-test",
  name: "Automation test harness",
  version: "1.0.0",
  protocolVersions: ["0.1"],
  capabilities: [
    "user_confirmation", "evaluation_authoring", "observability_instrumentation",
    "production_observation", "candidate_discovery", "challenger_execution",
    "frontier_calculation", "model_mutation", "post_swap_verification", "rollback",
  ],
  executionModes: ["remote"],
  structuredOutput: {
    schemaDialect: OPENMERIT_SCHEMA_DIALECT,
    presentation: "adapter_validation",
    enforcement: "adapter",
  },
  automation: {
    supportedSignals: ["product_task_completed", "metric_window_available", "scheduled_tick", "model_catalog_changed", "verification_window_completed"],
    persistentScheduling: true,
    backgroundExecution: true,
    wakeupProvisioning: "native",
  },
};

function state(stage: OpenMeritProjectState["cycle"]["stage"]): OpenMeritProjectState {
  return {
    schemaVersion: 1,
    cycle: {
      id: "cycle-automation",
      stage,
      verifiedSwapCount: 0,
      baselineEvidenceSufficient: stage !== "collecting_baseline",
      policy,
    },
    automation: {
      setupNudgeShown: true,
      observedCompletedTasks: 0,
      lastAssessmentTaskCount: 0,
      processedSignalIds: [],
    },
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

async function fixture(stage: OpenMeritProjectState["cycle"]["stage"], adapter: HarnessAdapter = {
  descriptor,
  async dispatch(intent) { return { accepted: true, harnessJobId: intent.id }; },
}) {
  const root = await mkdtemp(join(tmpdir(), "openmerit-automation-"));
  const store = new ProjectStore(root);
  await store.initialize({ schemaVersion: 1, taskProfiles: [], policy }, state(stage));
  return { root, store, coordinator: new OpenMeritCoordinator(store, adapter) };
}

function taskSignal(id: string, occurredAt: string): AutomationSignal {
  return { protocolVersion: "0.1", id, type: "product_task_completed", occurredAt, modelId: "vendor/model" };
}

test("completed-task cadence is durable and duplicate signals are idempotent", async () => {
  const { root, store, coordinator } = await fixture("collecting_baseline");
  try {
    const first = await coordinator.recordAutomationSignal(taskSignal("task-1", "2026-09-22T00:01:00.000Z"));
    assert.equal(first.decision.action, "observe");
    const duplicate = await coordinator.recordAutomationSignal(taskSignal("task-1", "2026-09-22T00:01:00.000Z"));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.state.automation.observedCompletedTasks, 1);

    const due = await coordinator.recordAutomationSignal(taskSignal("task-2", "2026-09-22T00:02:00.000Z"));
    assert.equal(due.decision.action, "issue_intent");
    if (due.decision.action === "issue_intent") assert.equal(due.decision.intentKind, "run_assessment");
    assert.equal((await store.readState())?.automation.pendingIntentKind, "run_assessment");

    await coordinator.issue("run_assessment");
    assert.equal((await store.readState())?.automation.pendingIntentKind, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalogue changes and metric regressions produce the correct intents", async () => {
  const catalogFixture = await fixture("monitoring");
  try {
    const first = await catalogFixture.coordinator.recordAutomationSignal({
      protocolVersion: "0.1", id: "catalog-1", type: "model_catalog_changed",
      occurredAt: "2026-09-22T00:01:00.000Z", fingerprint: "one",
    });
    assert.equal(first.decision.action, "observe");
    const changed = await catalogFixture.coordinator.recordAutomationSignal({
      protocolVersion: "0.1", id: "catalog-2", type: "model_catalog_changed",
      occurredAt: "2026-09-22T00:02:00.000Z", fingerprint: "two",
    });
    assert.equal(changed.decision.action, "issue_intent");
    if (changed.decision.action === "issue_intent") assert.equal(changed.decision.intentKind, "discover_candidates");
  } finally {
    await rm(catalogFixture.root, { recursive: true, force: true });
  }

  const metricFixture = await fixture("monitoring");
  const metric = (value: number) => ({
    metricId: "task_success" as const,
    state: "measured" as const,
    scope: "sample_window" as const,
    direction: "maximize" as const,
    method: "observed" as const,
    value,
    unit: "ratio",
    sampleCount: 20,
    evidence: [],
  });
  try {
    await metricFixture.coordinator.recordAutomationSignal({
      protocolVersion: "0.1", id: "metrics-1", type: "metric_window_available",
      occurredAt: "2026-09-22T00:01:00.000Z", metrics: [metric(1)],
    });
    const regressed = await metricFixture.coordinator.recordAutomationSignal({
      protocolVersion: "0.1", id: "metrics-2", type: "metric_window_available",
      occurredAt: "2026-09-22T00:02:00.000Z", metrics: [metric(0.8)],
    });
    assert.equal(regressed.decision.action, "issue_intent");
    if (regressed.decision.action === "issue_intent") assert.equal(regressed.decision.intentKind, "investigate_regression");
  } finally {
    await rm(metricFixture.root, { recursive: true, force: true });
  }
});

test("automation planning reports native wakeups and honest fallbacks", async () => {
  const scheduled: string[] = [];
  const adapter: HarnessAdapter = {
    descriptor,
    async dispatch(intent) { return { accepted: true, harnessJobId: intent.id }; },
    async scheduleWakeup(request) {
      scheduled.push(request.at);
      return { accepted: true, harnessJobId: `wakeup-${request.at}` };
    },
  };
  const { root, coordinator } = await fixture("collecting_baseline", adapter);
  try {
    const reconciled = await coordinator.reconcileAutomation("2026-09-22T00:30:00.000Z");
    assert.equal(reconciled.plan.scheduling, "native");
    assert.equal(reconciled.plan.nextWakeupAt, "2026-09-22T01:00:00.000Z");
    assert.deepEqual(scheduled, ["2026-09-22T01:00:00.000Z"]);

    const limited = buildAutomationPlan(state("collecting_baseline"), {
      ...descriptor,
      automation: {
        supportedSignals: ["product_task_completed", "scheduled_tick"],
        persistentScheduling: false,
        backgroundExecution: false,
        wakeupProvisioning: "none",
      },
    });
    assert.equal(limited.scheduling, "external_scheduler_required");
    assert.ok(limited.gaps.some((gap) => gap.includes("external scheduler")));
    assert.ok(limited.gaps.some((gap) => gap.includes("model_catalog_changed")));

    const unauthorizedInfrastructure = buildAutomationPlan(state("collecting_baseline"), {
      ...descriptor,
      automation: {
        ...descriptor.automation,
        wakeupProvisioning: "infrastructure_change",
      },
    });
    assert.equal(unauthorizedInfrastructure.scheduling, "external_scheduler_required");
    assert.ok(unauthorizedInfrastructure.gaps.some((gap) => gap.includes("not authorized")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-swap verification waits for the configured window signal", async () => {
  const { root, coordinator } = await fixture("swap_applied");
  try {
    const due = await coordinator.recordAutomationSignal({
      protocolVersion: "0.1",
      id: "verification-window-1",
      type: "verification_window_completed",
      occurredAt: "2026-09-22T00:10:00.000Z",
    });
    assert.equal(due.decision.action, "issue_intent");
    if (due.decision.action === "issue_intent") assert.equal(due.decision.intentKind, "verify_model_swap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
