import assert from "node:assert/strict";
import test from "node:test";

import type {
  CandidateAssessment,
  FrontierSnapshot,
  MetricId,
  MetricRecord,
  TaskProfile,
} from "@openmerit/protocol";
import { verifyFrontierSnapshot } from "../src/index.ts";

const profile: TaskProfile = {
  id: "task-1",
  revision: 1,
  name: "Task",
  goal: "Maximize quality while controlling cost and latency.",
  createdAt: "2026-09-22T00:00:00.000Z",
  confirmedAt: "2026-09-22T00:01:00.000Z",
  objectives: [
    { metricId: "task_quality", required: true, minimumSamples: 5, tolerance: 0 },
    { metricId: "total_task_cost", required: true, minimumSamples: 5, tolerance: 0 },
    { metricId: "end_to_end_task_latency", required: true, minimumSamples: 5, tolerance: 0 },
  ],
};

function metric(id: MetricId, value: number): MetricRecord {
  return {
    metricId: id,
    state: "measured",
    scope: "sample_window",
    direction: id === "task_quality" ? "maximize" : "minimize",
    method: "derived",
    value,
    unit: id === "task_quality" ? "score" : id === "total_task_cost" ? "usd" : "milliseconds",
    sampleCount: 10,
    evidence: [],
  };
}

function assessment(candidateId: string, quality: number, cost: number, latency: number): CandidateAssessment {
  return {
    id: `assessment-${candidateId}`,
    taskProfileId: profile.id,
    taskProfileRevision: profile.revision,
    candidateId,
    modelId: candidateId,
    productRevision: "git:abc",
    harnessId: "pi",
    startedAt: "2026-09-22T01:00:00.000Z",
    completedAt: "2026-09-22T02:00:00.000Z",
    metrics: [
      metric("task_quality", quality),
      metric("total_task_cost", cost),
      metric("end_to_end_task_latency", latency),
    ],
  };
}

const assessments = [
  assessment("model-a", 95, 1, 2000),
  assessment("model-b", 90, 0.4, 800),
  assessment("model-c", 82, 0.1, 300),
  assessment("model-d", 80, 0.5, 1000),
];

function validSnapshot(): FrontierSnapshot {
  const comparisons = assessments.flatMap((candidate) => assessments
    .filter((other) => other.candidateId !== candidate.candidateId)
    .map((other) => {
      const dominates = (candidate.candidateId === "model-b" || candidate.candidateId === "model-c") &&
        other.candidateId === "model-d";
      return {
        candidateId: candidate.candidateId,
        otherCandidateId: other.candidateId,
        state: dominates ? "dominates" as const : "does_not_dominate" as const,
        reasons: [dominates ? "B is no worse and materially better." : "A trade-off prevents dominance."],
      };
    }));
  return {
    id: "frontier-1",
    taskProfileId: profile.id,
    taskProfileRevision: profile.revision,
    productRevision: "git:abc",
    createdAt: "2026-09-22T03:00:00.000Z",
    frontierCandidateIds: ["model-a", "model-b", "model-c"],
    dominatedCandidateIds: ["model-d"],
    ineligibleCandidateIds: [],
    unresolvedCandidateIds: [],
    comparisons,
    assessmentIds: assessments.map((item) => item.id),
    calculationEvidence: [{ id: "calc-1", source: "harness_trace", uri: "session://pi/frontier-1" }],
  };
}

test("accepts a harness frontier that conforms to the OpenMerit definition", () => {
  const result = verifyFrontierSnapshot(profile, assessments, validSnapshot());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects a frontier that promotes a dominated model", () => {
  const snapshot = validSnapshot();
  const result = verifyFrontierSnapshot(profile, assessments, {
    ...snapshot,
    frontierCandidateIds: [...snapshot.frontierCandidateIds, "model-d"],
    dominatedCandidateIds: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("frontier candidate set is incorrect"));
  assert.ok(result.errors.includes("dominated candidate set is incorrect"));
});

test("rejects an otherwise correct result without calculation evidence", () => {
  const result = verifyFrontierSnapshot(profile, assessments, {
    ...validSnapshot(),
    calculationEvidence: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("calculation evidence is required"));
});
