import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OpenMeritCoordinator, ProjectStore } from "@openmerit/core";
import type { SupervisedGraduationPolicy } from "@openmerit/protocol";
import { removePiWakeup } from "../src/scheduler.ts";

test("headless wakeup checks an insufficient baseline without starting Pi", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openmerit-live-wakeup-"));
  const previous = new Date(Date.now() - 10 * 60_000).toISOString();
  const policy: SupervisedGraduationPolicy = {
    mode: "supervised_graduation",
    evaluationBudget: { currency: "USD", maximumSpend: 0.05 },
    automaticSwapsEnabled: false,
    confirmationRequiredUntilVerifiedSwaps: 1,
    requirePostSwapVerification: true,
    rollbackOnRegression: true,
    checkPolicy: {
      baselineAssessment: { afterElapsedSeconds: 60 },
      frontierReassessment: { afterElapsedSeconds: 86400, onModelCatalogChange: false },
      regressionCheck: { afterElapsedSeconds: 86400, thresholds: [] },
      postSwapVerification: { afterElapsedSeconds: 3600 },
      cooldownSeconds: 0,
      execution: { mode: "persistent", infrastructureChangesAllowed: true },
    },
  };
  try {
    await writeFile(join(root, "app.ts"), "// Product LLM route under evaluation: OpenRouter support classifier.\n");
    const store = new ProjectStore(root);
    const profile = {
      id: "profile-live-wakeup", revision: 1, name: "Support classification",
      goal: "Classify support messages accurately",
      applicationTarget: {
        id: "target-support", kind: "application_llm_call" as const,
        name: "Support classifier", applicationId: "support-app",
        callSites: ["app.ts#classify"], routeKey: "SUPPORT_MODEL", confirmedAt: previous,
      },
      objectives: [{ metricId: "task_success" as const, required: true, minimumSamples: 2, tolerance: 0,
        samplingPlan: { strategy: "repeated_same_input" as const, representativeCaseCount: 1, repetitionsPerCase: 2, aggregation: "rate" as const, rationale: "Measure repeated task success." } }],
      createdAt: previous, confirmedAt: previous,
    };
    await store.initialize({ schemaVersion: 1, activeTaskProfileId: profile.id, taskProfiles: [profile], policy }, {
      schemaVersion: 1,
      cycle: {
        id: "cycle-live-wakeup", targetId: profile.applicationTarget.id, taskProfileId: profile.id,
        stage: "collecting_baseline", verifiedSwapCount: 0, baselineEvidenceSufficient: false,
        observabilityReady: true, policy,
      },
      observability: {
        targetId: profile.applicationTarget.id, status: "ready", requiredMetricIds: ["task_success"],
        coveredMetricIds: ["task_success"], missingMetricIds: [], checkedAt: previous,
      },
      automation: {
        setupNudgeShown: true, observedCompletedTasks: 0, lastAssessmentTaskCount: 0,
        baselineStartedAt: previous,
      },
      updatedAt: previous,
    });
    const samplePath = join(root, "baseline-sample.json");
    await writeFile(samplePath, JSON.stringify({ task: "route a support request", expected: "billing", actual: "billing" }));
    await new OpenMeritCoordinator(store, {
      descriptor: {
        id: "fixture", name: "fixture", version: "1", protocolVersions: ["0.1"], capabilities: [], executionModes: ["non_interactive"],
        structuredOutput: { schemaDialect: "https://json-schema.org/draft/2020-12/schema", presentation: "adapter_validation", enforcement: "adapter" },
        automation: { supportedSignals: ["metric_window_available"], persistentScheduling: false, backgroundExecution: false, wakeupProvisioning: "none" },
      },
      async dispatch() { return { accepted: true }; },
    }).recordAutomationSignal({
      protocolVersion: "0.1", id: "one-sample", type: "metric_window_available",
      occurredAt: new Date(Date.parse(previous) + 1_000).toISOString(), targetId: profile.applicationTarget.id,
      metrics: [{
        targetId: profile.applicationTarget.id, metricId: "task_success", state: "measured", scope: "sample_window",
        direction: "maximize", method: "observed", aggregation: "rate", value: 1, unit: "ratio", sampleCount: 1,
        evidence: [{ id: "one-sample", source: "evaluation_artifact", uri: `file://${samplePath}` }],
      }],
    });
    const wakeup = fileURLToPath(new URL("../src/wakeup.ts", import.meta.url));
    const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", wakeup, root, "/does/not/exist/pi", extension,
      "openrouter", "~google/gemini-flash-latest",
    ], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, `${run.error?.message ?? ""}\n${run.stderr}\n${run.stdout}`);
    const status = JSON.parse(await readFile(join(root, ".openmerit", "scheduler-status.json"), "utf8")) as { exitCode: number };
    assert.equal(status.exitCode, 0);
    const events = await readFile(join(root, ".openmerit", "events.jsonl"), "utf8");
    assert.match(events, /"type":"baseline_sufficiency_checked"/);
    const completed = await store.readState();
    assert.equal(completed?.activeIntent, undefined);
    assert.equal(completed?.cycle.stage, "collecting_baseline");
    assert.equal(completed?.automation.lastAssessmentAt !== undefined, true);

    assert.ok(completed);
    await store.writeState({
      ...completed,
      cycle: { ...completed.cycle, stage: "baseline_ready", baselineEvidenceSufficient: true },
      automation: { ...completed.automation, pendingIntentKind: "discover_candidates", pendingIntentReason: "retry candidate discovery" },
    });
    const retry = spawnSync(process.execPath, [
      "--experimental-strip-types", wakeup, root, process.execPath, extension,
      "openrouter", "~google/gemini-flash-latest",
    ], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(retry.status, 0, "pending work should retry Pi and surface an unsuccessful dispatch");
    assert.equal((await store.readState())?.automation.pendingIntentKind, "discover_candidates");
  } finally {
    await removePiWakeup(root);
    await rm(root, { recursive: true, force: true });
  }
});
