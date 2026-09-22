import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HarnessDescriptor, IntentResult } from "@openmerit-v2/protocol";
import {
  createOpenMeritIntent,
  dispatchToHarness,
  interpretIntentResult,
  missingHarnessCapabilities,
  OpenMeritCoordinator,
  ProjectStore,
  validateHarnessDescriptor,
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
  });
  const receipt = await dispatchToHarness(adapter, intent);

  assert.equal(receipt.accepted, true);
  assert.deepEqual(received, ["discover_candidates"]);
  assert.match(intent.requestedOutcome, /Discover credible model candidates/);
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
        id: "profile-portable",
        revision: 1,
        name: "Portable task",
        goal: "Prove a second harness can integrate",
        objectives: [{ metricId: "task_success", required: true, minimumSamples: 3, tolerance: 0 }],
        createdAt: "2026-09-22T00:00:00.000Z",
        confirmedAt: "2026-09-22T00:00:30.000Z",
      },
      policy: {
        mode: "supervised_graduation",
        evaluationBudget: { currency: "USD", maximumSpend: 5 },
        automaticSwapsEnabled: false,
        confirmationRequiredUntilVerifiedSwaps: 2,
        requirePostSwapVerification: true,
        rollbackOnRegression: true,
      },
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
    const coordinator = new OpenMeritCoordinator(store, adapter);
    const issued = await coordinator.issue("discover_candidates");
    const result: IntentResult<"discover_candidates"> = {
      protocolVersion: "0.1",
      intentId: issued.intent.id,
      status: "succeeded",
      completedAt: "2026-09-22T00:02:00.000Z",
      summary: "Candidates discovered by fake harness",
      evidence: [{ id: "catalog", source: "external_source", uri: "fake://catalog" }],
      outputs: {
        candidates: [{ candidateId: "candidate-a", modelId: "vendor/model-a", reasons: ["task fit"] }],
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
