import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENT_OUTPUT_SCHEMAS,
  type IntentKind,
  validateIntentOutputSchema,
} from "../src/index.ts";

const evidence = [{ id: "evidence-1", source: "harness_trace", uri: "file:///trace.json" }];
const metric = {
  targetId: "app-target-1",
  metricId: "task_success",
  state: "measured",
  scope: "sample_window",
  direction: "maximize",
  method: "observed",
  value: 0.9,
  unit: "ratio",
  sampleCount: 10,
  evidence,
};
const assessment = {
  id: "assessment-a",
  targetId: "app-target-1",
  taskProfileId: "profile-1",
  taskProfileRevision: 1,
  candidateId: "candidate-a",
  modelId: "vendor/model-a",
  productRevision: "revision-1",
  harnessId: "test-harness",
  startedAt: "2026-09-22T00:00:00.000Z",
  completedAt: "2026-09-22T00:01:00.000Z",
  metrics: [metric],
};

const validOutputs: Readonly<Record<IntentKind, unknown>> = {
  establish_evals: {
    taskProfile: {
      id: "profile-1",
      revision: 1,
      name: "Representative task",
      goal: "Complete the representative task",
      applicationTarget: {
        id: "app-target-1",
        kind: "application_llm_call",
        name: "Support answer generation",
        applicationId: "support-app",
        callSites: ["src/answer.ts#generate"],
        routeKey: "SUPPORT_MODEL",
        confirmedAt: "2026-09-22T00:00:00.000Z",
      },
      objectives: [{ metricId: "task_success", required: true, minimumSamples: 3, tolerance: 0 }],
      createdAt: "2026-09-22T00:00:00.000Z",
      confirmedAt: "2026-09-22T00:00:00.000Z",
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
        execution: { mode: "persistent", infrastructureChangesAllowed: false },
      },
    },
    observability: {
      targetId: "app-target-1",
      status: "ready",
      requiredMetricIds: ["task_success"],
      coveredMetricIds: ["task_success"],
      missingMetricIds: [],
      checkedAt: "2026-09-22T00:00:00.000Z",
    },
    preliminaryModelLeads: [{
      targetId: "app-target-1",
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
  instrument_observability: { targetId: "app-target-1", coveredMetricIds: ["task_success"], missingMetricIds: [] },
  run_assessment: { targetId: "app-target-1", baselineEvidenceSufficient: true, metrics: [metric] },
  discover_candidates: {
    targetId: "app-target-1",
    candidates: [{ targetId: "app-target-1", candidateId: "candidate-a", modelId: "vendor/model-a", reasons: ["Strong task fit"] }],
  },
  run_challenger_trials: { targetId: "app-target-1", assessments: [assessment] },
  calculate_frontier: {
    targetId: "app-target-1",
    assessments: [assessment],
    frontierSnapshot: {
      id: "frontier-1",
      targetId: "app-target-1",
      taskProfileId: "profile-1",
      taskProfileRevision: 1,
      productRevision: "revision-1",
      createdAt: "2026-09-22T00:02:00.000Z",
      frontierCandidateIds: ["candidate-a"],
      dominatedCandidateIds: [],
      ineligibleCandidateIds: [],
      unresolvedCandidateIds: [],
      comparisons: [],
      assessmentIds: ["assessment-a"],
      calculationEvidence: evidence,
    },
  },
  investigate_regression: { targetId: "app-target-1", regressionDetected: true, affectedMetricIds: ["task_success"], likelyCause: "Provider change" },
  apply_model_swap: { targetId: "app-target-1", appliedCandidateId: "candidate-a", previousCandidateId: "candidate-old" },
  verify_model_swap: { targetId: "app-target-1", verified: true, regressionDetected: false },
  rollback_model_swap: { targetId: "app-target-1", restoredCandidateId: "candidate-old" },
};

test("the schema registry covers every intent kind", () => {
  assert.deepEqual(Object.keys(INTENT_OUTPUT_SCHEMAS).sort(), Object.keys(validOutputs).sort());
  for (const [kind, output] of Object.entries(validOutputs) as Array<[IntentKind, unknown]>) {
    assert.deepEqual(validateIntentOutputSchema(kind, output), [], kind);
  }
});

test("intent schemas reject guessed fields and wrong primitive types", () => {
  assert.match(validateIntentOutputSchema("run_assessment", { baseline_ready: "yes" }).join("; "), /baselineEvidenceSufficient|required/);
  assert.match(validateIntentOutputSchema("apply_model_swap", { appliedCandidateId: 42 }).join("; "), /string/);
  assert.match(validateIntentOutputSchema("verify_model_swap", {
    verified: true,
    regressionDetected: false,
    inventedField: true,
  }).join("; "), /additional properties/);
});

test("setup accepts a sourced preliminary shortlist or an older 0.1 result without one", () => {
  const setup = validOutputs.establish_evals as Record<string, unknown>;
  const { preliminaryModelLeads: _omitted, ...legacySetup } = setup;
  assert.deepEqual(validateIntentOutputSchema("establish_evals", legacySetup), []);
  assert.deepEqual(validateIntentOutputSchema("establish_evals", { ...setup, preliminaryModelLeads: [] }), []);
  const leads = setup.preliminaryModelLeads as Array<Record<string, unknown>>;
  assert.match(validateIntentOutputSchema("establish_evals", {
    ...setup,
    preliminaryModelLeads: [{ ...leads[0], reputation: { summary: "Unsourced" } }],
  }).join("; "), /sourceUri/);
});
