import assert from "node:assert/strict";
import test from "node:test";

import type { ImprovementCycleState, SupervisedGraduationPolicy } from "@openmerit/protocol";
import { nextImprovementAction } from "../src/index.ts";

const policy: SupervisedGraduationPolicy = {
  mode: "supervised_graduation",
  evaluationBudget: { currency: "USD", maximumSpend: 10, maximumCandidateCount: 3, maximumRunsPerCandidate: 10 },
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
};

function state(overrides: Partial<ImprovementCycleState>): ImprovementCycleState {
  return {
    id: "cycle-1",
    stage: "unconfigured",
    verifiedSwapCount: 0,
    baselineEvidenceSufficient: false,
    policy,
    ...overrides,
  };
}

test("observes the baseline until sufficiency is reported", () => {
  assert.deepEqual(nextImprovementAction(state({ stage: "collecting_baseline" })).action, "observe");
  assert.deepEqual(nextImprovementAction(state({ stage: "collecting_baseline", baselineEvidenceSufficient: true })), {
    action: "issue_intent",
    intentKind: "discover_candidates",
    reason: "The baseline is ready for candidate discovery.",
  });
});

test("sequences candidate discovery, trials, and harness frontier calculation", () => {
  for (const [stage, expected] of [
    ["baseline_ready", "discover_candidates"],
    ["candidates_ready", "run_challenger_trials"],
    ["challengers_ready", "calculate_frontier"],
  ] as const) {
    const decision = nextImprovementAction(state({ stage }));
    assert.equal(decision.action, "issue_intent");
    if (decision.action === "issue_intent") assert.equal(decision.intentKind, expected);
  }
});

test("early swaps require confirmation", () => {
  const decision = nextImprovementAction(state({
    stage: "frontier_ready",
    activeCandidateId: "model-a",
    proposedCandidateId: "model-b",
  }));
  assert.equal(decision.action, "await_user");
});

test("automatic swaps require explicit opt-in and enough verified swaps", () => {
  const decision = nextImprovementAction(state({
    stage: "frontier_ready",
    activeCandidateId: "model-a",
    proposedCandidateId: "model-b",
    verifiedSwapCount: 2,
    policy: { ...policy, automaticSwapsEnabled: true },
  }));
  assert.deepEqual(decision.action, "issue_intent");
  if (decision.action === "issue_intent") assert.equal(decision.intentKind, "apply_model_swap");
});

test("every applied swap is verified and regressions can trigger rollback", () => {
  const verify = nextImprovementAction(state({ stage: "swap_applied" }));
  const rollback = nextImprovementAction(state({ stage: "verification_failed" }));
  assert.equal(verify.action, "observe");
  assert.equal(rollback.action, "issue_intent");
  if (rollback.action === "issue_intent") assert.equal(rollback.intentKind, "rollback_model_swap");
});
