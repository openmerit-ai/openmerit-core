import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  isTerminalIntentStatus,
  type IntentLifecycleUpdate,
  type IntentResult,
  type OpenMeritIntent,
} from "../src/index.ts";

test("an intent describes an outcome without prescribing harness steps", () => {
  const intent: OpenMeritIntent = {
    protocolVersion: PROTOCOL_VERSION,
    id: "intent-1",
    kind: "establish_evals",
    taskProfileId: "task-1",
    authorizationPolicyId: "policy-1",
    requestedOutcome: "Representative task evaluations exist and can be run repeatedly.",
    constraints: {
      requiredMetricIds: ["task_quality", "task_success"],
    },
    requiredEvidence: [
      {
        id: "runnable-eval",
        description: "A runnable evaluation artifact and its verification result.",
        metricProfileId: "metrics-1",
      },
    ],
    requestedAt: "2026-09-22T00:00:00.000Z",
  };

  assert.equal(intent.kind, "establish_evals");
  assert.equal("steps" in intent, false);
});

test("lifecycle updates can represent work waiting for the user", () => {
  const update: IntentLifecycleUpdate = {
    protocolVersion: PROTOCOL_VERSION,
    intentId: "intent-1",
    status: "waiting_for_user",
    occurredAt: "2026-09-22T00:01:00.000Z",
    message: "The harness needs a representative expected output.",
  };

  assert.equal(update.status, "waiting_for_user");
  assert.equal(isTerminalIntentStatus(update.status), false);
});

test("terminal results carry evidence references", () => {
  const result: IntentResult<"instrument_observability"> = {
    protocolVersion: PROTOCOL_VERSION,
    intentId: "intent-1",
    status: "succeeded",
    completedAt: "2026-09-22T00:02:00.000Z",
    summary: "The harness created and verified the requested evaluation.",
    evidence: [
      {
        id: "evidence-1",
        source: "evaluation_artifact",
        uri: "file:///workspace/evals/task-quality.test.ts",
        mediaType: "text/typescript",
      },
    ],
    outputs: {
      coveredMetricIds: ["task_quality", "task_success"],
      missingMetricIds: [],
    },
  };

  assert.equal(isTerminalIntentStatus(result.status), true);
  assert.equal(result.evidence[0]?.source, "evaluation_artifact");
});
