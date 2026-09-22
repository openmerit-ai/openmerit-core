import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENT_OUTPUT_SCHEMAS,
  type IntentKind,
  validateIntentOutputSchema,
} from "../src/index.ts";

const evidence = [{ id: "evidence-1", source: "harness_trace", uri: "file:///trace.json" }];
const metric = {
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
  },
  instrument_observability: { coveredMetricIds: ["task_success"], missingMetricIds: [] },
  run_assessment: { baselineEvidenceSufficient: true, metrics: [metric] },
  discover_candidates: {
    candidates: [{ candidateId: "candidate-a", modelId: "vendor/model-a", reasons: ["Strong task fit"] }],
  },
  run_challenger_trials: { assessments: [assessment] },
  calculate_frontier: {
    assessments: [assessment],
    frontierSnapshot: {
      id: "frontier-1",
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
  investigate_regression: { regressionDetected: true, affectedMetricIds: ["task_success"], likelyCause: "Provider change" },
  apply_model_swap: { appliedCandidateId: "candidate-a", previousCandidateId: "candidate-old" },
  verify_model_swap: { verified: true, regressionDetected: false },
  rollback_model_swap: { restoredCandidateId: "candidate-old" },
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
