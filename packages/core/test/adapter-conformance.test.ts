import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OPENMERIT_SCHEMA_DIALECT, type HarnessDescriptor, type IntentResult } from "@openmerit/protocol";
import {
  createOpenMeritIntent,
  dispatchToHarness,
  interpretIntentResult,
  missingHarnessCapabilities,
  OpenMeritCoordinator,
  ProjectStore,
  validateHarnessDescriptor,
  validateObservabilityCoverage,
  type HarnessAdapter,
} from "../src/index.ts";

const descriptor: HarnessDescriptor = {
  id: "fake-harness",
  name: "Fake conformance harness",
  version: "1.0.0",
  protocolVersions: ["0.1"],
  capabilities: [
    "user_confirmation",
    "evaluation_authoring",
    "observability_instrumentation",
    "production_observation",
    "candidate_discovery",
    "challenger_execution",
    "frontier_calculation",
    "model_mutation",
    "post_swap_verification",
    "rollback",
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

const applicationTarget = {
  id: "app-target-1",
  kind: "application_llm_call" as const,
  name: "Application response route",
  applicationId: "portable-app",
  callSites: ["src/respond.ts#respond"],
  routeKey: "RESPONSE_MODEL",
  confirmedAt: "2026-09-22T00:00:30.000Z",
};

const portableProfile = {
  id: "profile-portable",
  revision: 1,
  name: "Portable task",
  goal: "Prove a second harness can integrate",
  applicationTarget,
  objectives: [{ metricId: "task_success" as const, required: true, minimumSamples: 3, tolerance: 0 }],
  createdAt: "2026-09-22T00:00:00.000Z",
  confirmedAt: "2026-09-22T00:00:30.000Z",
};

test("a non-Pi harness can receive canonical OpenMerit intents", async () => {
  const received: string[] = [];
  const adapter: HarnessAdapter = {
    descriptor,
    async dispatch(intent) {
      received.push(intent.kind);
      return { accepted: true, harnessJobId: `fake-${intent.id}` };
    },
  };
  const intent = createOpenMeritIntent("discover_candidates", {
    id: "intent-portable",
    requestedAt: "2026-09-22T00:00:00.000Z",
    targetId: applicationTarget.id,
  });
  const receipt = await dispatchToHarness(adapter, intent);

  assert.equal(receipt.accepted, true);
  assert.deepEqual(received, ["discover_candidates"]);
  assert.match(intent.requestedOutcome, /discover other credible candidates/);
  assert.match(createOpenMeritIntent("establish_evals").requestedOutcome, /Mark any metric missing if its collector or grader cannot produce a value/);
});

test("challenger intents expose only the remaining evaluation allowance", () => {
  const policy = {
    mode: "supervised_graduation" as const,
    evaluationBudget: { currency: "USD", maximumSpend: 0.5 },
    automaticSwapsEnabled: false,
    confirmationRequiredUntilVerifiedSwaps: 1,
    requirePostSwapVerification: true as const,
    rollbackOnRegression: true,
    checkPolicy: {
      baselineAssessment: { afterCompletedTasks: 5 },
      frontierReassessment: { afterCompletedTasks: 5, onModelCatalogChange: true },
      regressionCheck: { afterCompletedTasks: 3, thresholds: [] },
      postSwapVerification: { afterCompletedTasks: 1 },
      cooldownSeconds: 60,
      execution: { mode: "active_session_only" as const, infrastructureChangesAllowed: false },
    },
  };
  const intent = createOpenMeritIntent("run_challenger_trials", { policy, evaluationSpend: 0.2 });
  assert.equal(intent.constraints.evaluationSpend, 0.2);
  assert.equal(intent.constraints.remainingEvaluationBudget, 0.3);
});

test("capability negotiation rejects unsupported jobs before dispatch", async () => {
  let dispatched = false;
  const adapter: HarnessAdapter = {
    descriptor: { ...descriptor, capabilities: ["production_observation"] },
    async dispatch() {
      dispatched = true;
      return { accepted: true };
    },
  };
  const receipt = await dispatchToHarness(adapter, createOpenMeritIntent("apply_model_swap"));

  assert.equal(receipt.accepted, false);
  assert.match(receipt.reason ?? "", /model_mutation/);
  assert.equal(dispatched, false);
  assert.deepEqual(missingHarnessCapabilities(adapter.descriptor, "apply_model_swap"), ["model_mutation"]);
});

test("descriptor validation rejects incompatible protocol versions", () => {
  const validation = validateHarnessDescriptor({ ...descriptor, protocolVersions: ["9.9"] });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("; "), /protocol 0\.1/);
});

test("shared core validates and interprets setup results from any harness", () => {
  const intent = createOpenMeritIntent("establish_evals", { id: "intent-setup" });
  const result: IntentResult<"establish_evals"> = {
    protocolVersion: "0.1",
    intentId: intent.id,
    status: "succeeded",
    completedAt: "2026-09-22T00:01:00.000Z",
    summary: "Configured",
    evidence: [{ id: "eval", source: "evaluation_artifact", uri: "artifact://fake/eval" }],
    outputs: {
      taskProfile: {
        ...portableProfile,
      },
      policy: {
        mode: "supervised_graduation",
        evaluationBudget: { currency: "USD", maximumSpend: 5 },
        automaticSwapsEnabled: false,
        confirmationRequiredUntilVerifiedSwaps: 2,
        requirePostSwapVerification: true,
        rollbackOnRegression: true,
        checkPolicy: {
          baselineAssessment: { afterCompletedTasks: 3 },
          frontierReassessment: { afterCompletedTasks: 100, afterElapsedSeconds: 2592000, onModelCatalogChange: true },
          regressionCheck: { afterCompletedTasks: 25, thresholds: [{ metricId: "task_success", relativeChangeAtLeast: 0.1 }] },
          postSwapVerification: { afterCompletedTasks: 20, afterElapsedSeconds: 86400 },
          cooldownSeconds: 3600,
          execution: { mode: "persistent", infrastructureChangesAllowed: false },
        },
      },
      observability: {
        targetId: applicationTarget.id,
        status: "ready",
        requiredMetricIds: ["task_success"],
        coveredMetricIds: ["task_success"],
        missingMetricIds: [],
        checkedAt: "2026-09-22T00:00:30.000Z",
      },
      preliminaryModelLeads: [{
        targetId: applicationTarget.id,
        modelId: "vendor/model-a",
        estimatedPrice: {
          currency: "USD", inputPerMillionTokens: 1, outputPerMillionTokens: 2,
          sourceUri: "https://vendor.example/pricing", checkedAt: "2026-09-22T00:00:00.000Z",
        },
        reputation: {
          summary: "Promising for this task type", sourceUri: "https://vendor.example/evals",
          checkedAt: "2026-09-22T00:00:00.000Z",
        },
      }],
    },
  };
  const interpreted = interpretIntentResult(
    intent,
    result,
    { id: "cycle", stage: "establishing_evidence", verifiedSwapCount: 0, baselineEvidenceSufficient: false },
    { schemaVersion: 1, taskProfiles: [] },
  );

  assert.equal(interpreted.valid, true);
  assert.equal(interpreted.nextStage, "collecting_baseline");
  assert.equal(interpreted.config?.activeTaskProfileId, "profile-portable");
  assert.equal(interpreted.cyclePatch?.taskProfileId, "profile-portable");
  assert.equal(interpreted.config?.preliminaryModelLeads?.[0]?.modelId, "vendor/model-a");
  assert.equal(interpreted.cyclePatch?.baselineEvidenceSufficient, false);
});

test("preliminary leads cannot name another target or duplicate a model", () => {
  const intent = createOpenMeritIntent("establish_evals", { id: "intent-leads" });
  const outputs = {
    taskProfile: portableProfile,
    policy: {
      mode: "supervised_graduation" as const,
      evaluationBudget: { currency: "USD", maximumSpend: 5 },
      automaticSwapsEnabled: false,
      confirmationRequiredUntilVerifiedSwaps: 2,
      requirePostSwapVerification: true as const,
      rollbackOnRegression: true,
      checkPolicy: {
        baselineAssessment: { afterCompletedTasks: 3 },
        frontierReassessment: { afterCompletedTasks: 100, onModelCatalogChange: true },
        regressionCheck: { afterCompletedTasks: 25, thresholds: [] },
        postSwapVerification: { afterCompletedTasks: 20 },
        cooldownSeconds: 3600,
        execution: { mode: "active_session_only" as const, infrastructureChangesAllowed: false },
      },
    },
    observability: {
      targetId: applicationTarget.id,
      status: "ready" as const,
      requiredMetricIds: ["task_success" as const],
      coveredMetricIds: ["task_success" as const],
      missingMetricIds: [],
      checkedAt: "2026-09-22T00:01:00.000Z",
    },
    preliminaryModelLeads: [{
      targetId: "wrong-target",
      modelId: "vendor/model-a",
      estimatedPrice: {
        currency: "USD", inputPerMillionTokens: 1, outputPerMillionTokens: 2,
        sourceUri: "https://vendor.example/pricing", checkedAt: "2026-09-22T00:00:00.000Z",
      },
      reputation: {
        summary: "Promising", sourceUri: "https://vendor.example/evals",
        checkedAt: "2026-09-22T00:00:00.000Z",
      },
    }],
  };
  const result: IntentResult<"establish_evals"> = {
    protocolVersion: "0.1", intentId: intent.id, status: "succeeded",
    completedAt: "2026-09-22T00:01:00.000Z", summary: "Configured",
    evidence: [{ id: "eval", source: "evaluation_artifact", uri: "artifact://fake/eval" }],
    outputs,
  };
  const cycle = { id: "cycle", stage: "establishing_evidence" as const, verifiedSwapCount: 0, baselineEvidenceSufficient: false };
  const config = { schemaVersion: 1 as const, taskProfiles: [] };
  assert.match(interpretIntentResult(intent, result, cycle, config).errors.join("; "), /preliminary lead.*target/);
  const duplicate = { ...outputs.preliminaryModelLeads[0], targetId: applicationTarget.id };
  const duplicated = { ...result, outputs: { ...outputs, preliminaryModelLeads: [duplicate, duplicate] } };
  assert.match(interpretIntentResult(intent, duplicated, cycle, config).errors.join("; "), /duplicate preliminary model lead/);
});

test("shared core rejects structurally invalid successful outputs from any harness", () => {
  const intent = createOpenMeritIntent("run_assessment", { id: "intent-invalid-output" });
  const interpreted = interpretIntentResult(
    intent,
    {
      protocolVersion: "0.1",
      intentId: intent.id,
      status: "succeeded",
      completedAt: "2026-09-22T00:01:00.000Z",
      summary: "Guessed the result shape",
      evidence: [{ id: "trace", source: "harness_trace", uri: "artifact://fake/trace" }],
      outputs: { baseline_ready: "yes" },
    } as unknown as IntentResult<"run_assessment">,
    { id: "cycle", stage: "collecting_baseline", verifiedSwapCount: 0, baselineEvidenceSufficient: false },
    { schemaVersion: 1, taskProfiles: [] },
  );

  assert.equal(interpreted.valid, false);
  assert.match(interpreted.errors.join("; "), /baselineEvidenceSufficient/);
});

test("observability readiness cannot hide a required metric gap", () => {
  const profile = {
    id: "profile-observability",
    revision: 1,
    name: "Observed task",
    goal: "Verify required metrics",
    applicationTarget,
    objectives: [
      { metricId: "task_success" as const, required: true, minimumSamples: 3, tolerance: 0 },
      { metricId: "total_task_cost" as const, required: true, minimumSamples: 3, tolerance: 0 },
    ],
    createdAt: "2026-09-22T00:00:00.000Z",
    confirmedAt: "2026-09-22T00:00:01.000Z",
  };
  const errors = validateObservabilityCoverage(profile, {
    targetId: applicationTarget.id,
    status: "ready",
    requiredMetricIds: ["task_success", "total_task_cost"],
    coveredMetricIds: ["task_success"],
    missingMetricIds: ["total_task_cost"],
    checkedAt: "2026-09-22T00:01:00.000Z",
  }, false);

  assert.match(errors.join("; "), /status must be incomplete/);
});

test("the coordinator runs a durable job through a non-Pi harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmerit-fake-adapter-"));
  const dispatched: string[] = [];
  const adapter: HarnessAdapter = {
    descriptor,
    async dispatch(intent) {
      dispatched.push(intent.id);
      return { accepted: true, harnessJobId: `remote-${intent.id}` };
    },
  };
  try {
    const store = new ProjectStore(root);
    await store.initialize({
      schemaVersion: 1,
      activeTaskProfileId: portableProfile.id,
      taskProfiles: [portableProfile],
      preliminaryModelLeads: [{
        targetId: applicationTarget.id,
        modelId: "vendor/model-a",
        estimatedPrice: {
          currency: "USD", inputPerMillionTokens: 1, outputPerMillionTokens: 2,
          sourceUri: "https://vendor.example/pricing", checkedAt: "2026-09-22T00:00:00.000Z",
        },
        reputation: {
          summary: "Promising", sourceUri: "https://vendor.example/evals",
          checkedAt: "2026-09-22T00:00:00.000Z",
        },
      }],
    }, {
      schemaVersion: 1,
      cycle: {
        id: "cycle-portable",
        targetId: applicationTarget.id,
        taskProfileId: portableProfile.id,
        stage: "baseline_ready",
        verifiedSwapCount: 0,
        baselineEvidenceSufficient: true,
      },
      automation: { setupNudgeShown: true, observedCompletedTasks: 3, lastAssessmentTaskCount: 3 },
      updatedAt: "2026-09-22T00:01:00.000Z",
    });
    const coordinator = new OpenMeritCoordinator(store, adapter);
    const issued = await coordinator.issue("discover_candidates");
    assert.equal((issued.intent.constraints.taskProfile as { goal: string }).goal, portableProfile.goal);
    assert.equal((issued.intent.constraints.preliminaryModelLeads as Array<{ modelId: string }>)[0]?.modelId, "vendor/model-a");
    const result: IntentResult<"discover_candidates"> = {
      protocolVersion: "0.1",
      intentId: issued.intent.id,
      status: "succeeded",
      completedAt: "2026-09-22T00:02:00.000Z",
      summary: "Candidates discovered by fake harness",
      evidence: [{ id: "catalog", source: "external_source", uri: "fake://catalog" }],
      outputs: {
        targetId: applicationTarget.id,
        candidates: [{ targetId: applicationTarget.id, candidateId: "candidate-a", modelId: "vendor/model-a", reasons: ["task fit"] }],
      },
    };
    const accepted = await coordinator.acceptResult(result);

    assert.deepEqual(dispatched, [issued.intent.id]);
    assert.equal(accepted.state.cycle.stage, "candidates_ready");
    assert.equal(accepted.state.activeIntent, undefined);
    assert.equal((await store.readState())?.lastResult?.intentId, issued.intent.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
