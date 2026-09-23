import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import type { OpenMeritProjectState, SupervisedGraduationPolicy } from "@openmerit/protocol";
import { isPiWakeupDue } from "../src/wakeup.ts";
import { piWakeupLabel, piWakeupPlistPath, renderPiWakeupPlist } from "../src/scheduler.ts";

const policy: SupervisedGraduationPolicy = {
  mode: "supervised_graduation",
  evaluationBudget: { currency: "USD", maximumSpend: 10 },
  automaticSwapsEnabled: false,
  confirmationRequiredUntilVerifiedSwaps: 2,
  requirePostSwapVerification: true,
  rollbackOnRegression: true,
  checkPolicy: {
    baselineAssessment: { afterCompletedTasks: 3, afterElapsedSeconds: 3600 },
    frontierReassessment: { afterElapsedSeconds: 86400, onModelCatalogChange: true },
    regressionCheck: { afterElapsedSeconds: 7200, thresholds: [] },
    postSwapVerification: { afterElapsedSeconds: 3600 },
    cooldownSeconds: 0,
    execution: { mode: "persistent", infrastructureChangesAllowed: true },
  },
};

function state(overrides: Partial<OpenMeritProjectState> = {}): OpenMeritProjectState {
  return {
    schemaVersion: 1,
    cycle: {
      id: "cycle-1", targetId: "target-1", taskProfileId: "profile-1",
      stage: "collecting_baseline", verifiedSwapCount: 0, baselineEvidenceSufficient: false,
      policy,
    },
    automation: { setupNudgeShown: true, observedCompletedTasks: 0, lastAssessmentTaskCount: 0 },
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

test("LaunchAgent labels are stable and project-specific", () => {
  assert.equal(piWakeupLabel("/tmp/project-a"), piWakeupLabel("/tmp/project-a"));
  assert.notEqual(piWakeupLabel("/tmp/project-a"), piWakeupLabel("/tmp/project-b"));
  assert.match(piWakeupPlistPath("/tmp/project-a"), /Library\/LaunchAgents\/com\.openmerit\.pi\.[a-f0-9]+\.plist$/);
});

test("the generated LaunchAgent plist is valid and contains no provider key", { skip: process.platform !== "darwin" }, () => {
  const content = renderPiWakeupPlist({
    projectRoot: "/tmp/project & one",
    extensionPath: "/tmp/openmerit/index.js",
    provider: "openrouter",
    modelId: "vendor/model-a",
  }, "/opt/homebrew/bin/pi", "/tmp/openmerit/wakeup.js");
  assert.match(content, /project &amp; one/);
  assert.doesNotMatch(content, /API_KEY|sk-/);
  assert.match(execFileSync("plutil", ["-lint", "-"], { input: content, encoding: "utf8" }), /OK/);
});

test("background Pi starts only for a due, authorized, idle project", () => {
  assert.equal(isPiWakeupDue(state(), "2026-09-22T00:59:59.000Z"), false);
  assert.equal(isPiWakeupDue(state(), "2026-09-22T01:00:00.000Z"), true);
  assert.equal(isPiWakeupDue(state({
    cycle: { ...state().cycle, stage: "baseline_ready" },
    automation: { ...state().automation, pendingIntentKind: "discover_candidates" },
  }), "2026-09-22T00:01:00.000Z"), true);
  assert.equal(isPiWakeupDue(state({ activeIntent: { id: "active" } as never }), "2026-09-22T01:00:00.000Z"), false);
  assert.equal(isPiWakeupDue(state({ automation: { ...state().automation, paused: true } }), "2026-09-22T01:00:00.000Z"), false);
  assert.equal(isPiWakeupDue(state({ cycle: { ...state().cycle, policy: {
    ...policy, checkPolicy: { ...policy.checkPolicy, execution: { mode: "active_session_only", infrastructureChangesAllowed: false } },
  } } }), "2026-09-22T01:00:00.000Z"), false);
});
