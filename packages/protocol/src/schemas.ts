import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { IntentKind, IntentOutputMap } from "./index.ts";

export const OPENMERIT_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;
export const OPENMERIT_RESULT_SCHEMA_VERSION = "0.1" as const;

const strictObject = <T extends Record<string, TSchema>>(
  properties: T,
  options: Readonly<Record<string, unknown>> = {},
) => Type.Object(properties, { additionalProperties: false, ...options });

const metricIds = [
  "task_quality", "task_success", "consistency", "instruction_following",
  "tool_use_performance", "structured_output_reliability", "hallucination_rate",
  "reasoning_efficiency", "input_token_consumption", "output_token_consumption",
  "total_task_cost", "cost_per_successful_task", "time_to_first_useful_output",
  "end_to_end_task_latency", "throughput", "retry_rate", "agent_steps",
  "recovery_ability", "context_handling", "retrieval_use_quality",
  "long_horizon_performance", "human_intervention_rate", "preference_fit",
] as const;

const evidenceSources = [
  "harness_trace", "evaluation_artifact", "observability_record", "external_source", "user_feedback",
] as const;

const stringEnum = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const cadenceSchema = () => strictObject({
  afterCompletedTasks: Type.Optional(Type.Integer({ minimum: 1 })),
  afterElapsedSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const EvidenceReferenceSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  source: stringEnum(evidenceSources),
  uri: Type.String({ minLength: 1 }),
  mediaType: Type.Optional(Type.String({ minLength: 1 })),
  digest: Type.Optional(Type.String({ minLength: 1 })),
});

export const MetricObjectiveSchema = strictObject({
  metricId: stringEnum(metricIds),
  required: Type.Boolean(),
  minimumSamples: Type.Integer({ minimum: 1 }),
  tolerance: Type.Number({ minimum: 0 }),
  constraint: Type.Optional(strictObject({
    operator: stringEnum(["at_least", "at_most"] as const),
    value: Type.Number(),
  })),
});

export const TaskProfileSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  objectives: Type.Array(MetricObjectiveSchema, { minItems: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  confirmedAt: Type.Optional(Type.String({ minLength: 1 })),
});

const ConfirmedTaskProfileSchema = strictObject({
  ...TaskProfileSchema.properties,
  confirmedAt: Type.String({ minLength: 1 }),
});

export const SupervisedGraduationPolicySchema = strictObject({
  mode: Type.Literal("supervised_graduation"),
  evaluationBudget: strictObject({
    currency: Type.String({ minLength: 1 }),
    maximumSpend: Type.Number({ minimum: 0 }),
    maximumCandidateCount: Type.Optional(Type.Integer({ minimum: 1 })),
    maximumRunsPerCandidate: Type.Optional(Type.Integer({ minimum: 1 })),
    expiresAt: Type.Optional(Type.String({ minLength: 1 })),
  }),
  automaticSwapsEnabled: Type.Boolean(),
  confirmationRequiredUntilVerifiedSwaps: Type.Integer({ minimum: 0 }),
  requirePostSwapVerification: Type.Literal(true),
  rollbackOnRegression: Type.Boolean(),
  checkPolicy: strictObject({
    baselineAssessment: cadenceSchema(),
    frontierReassessment: strictObject({
      afterCompletedTasks: Type.Optional(Type.Integer({ minimum: 1 })),
      afterElapsedSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      onModelCatalogChange: Type.Boolean(),
    }),
    regressionCheck: strictObject({
      afterCompletedTasks: Type.Optional(Type.Integer({ minimum: 1 })),
      afterElapsedSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      thresholds: Type.Array(strictObject({
        metricId: stringEnum(metricIds),
        relativeChangeAtLeast: Type.Number({ exclusiveMinimum: 0 }),
      })),
    }),
    postSwapVerification: cadenceSchema(),
    cooldownSeconds: Type.Integer({ minimum: 0 }),
    execution: strictObject({
      mode: stringEnum(["active_session_only", "persistent"] as const),
      infrastructureChangesAllowed: Type.Boolean(),
    }),
  }),
});

export const MetricRecordSchema = strictObject({
  metricId: stringEnum(metricIds),
  state: stringEnum(["measured", "not_applicable", "not_configured", "insufficient_evidence"] as const),
  scope: stringEnum(["single_run", "sample_window"] as const),
  direction: stringEnum(["maximize", "minimize"] as const),
  method: stringEnum(["observed", "derived", "evaluator", "human", "external"] as const),
  value: Type.Optional(Type.Number()),
  unit: Type.String({ minLength: 1 }),
  sampleCount: Type.Integer({ minimum: 0 }),
  interval: Type.Optional(strictObject({
    lower: Type.Number(),
    upper: Type.Number(),
    confidenceLevel: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  })),
  window: Type.Optional(strictObject({
    startedAt: Type.String({ minLength: 1 }),
    endedAt: Type.String({ minLength: 1 }),
  })),
  evidence: Type.Array(EvidenceReferenceSchema),
  note: Type.Optional(Type.String()),
});

export const CandidateDescriptorSchema = strictObject({
  candidateId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  modelVersion: Type.Optional(Type.String({ minLength: 1 })),
  reasons: Type.Array(Type.String()),
});

export const CandidateAssessmentSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  taskProfileId: Type.String({ minLength: 1 }),
  taskProfileRevision: Type.Integer({ minimum: 1 }),
  candidateId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  modelVersion: Type.Optional(Type.String({ minLength: 1 })),
  productRevision: Type.String({ minLength: 1 }),
  harnessId: Type.String({ minLength: 1 }),
  startedAt: Type.String({ minLength: 1 }),
  completedAt: Type.String({ minLength: 1 }),
  metrics: Type.Array(MetricRecordSchema),
});

export const FrontierSnapshotSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  taskProfileId: Type.String({ minLength: 1 }),
  taskProfileRevision: Type.Integer({ minimum: 1 }),
  productRevision: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  frontierCandidateIds: Type.Array(Type.String()),
  dominatedCandidateIds: Type.Array(Type.String()),
  ineligibleCandidateIds: Type.Array(Type.String()),
  unresolvedCandidateIds: Type.Array(Type.String()),
  comparisons: Type.Array(strictObject({
    candidateId: Type.String({ minLength: 1 }),
    otherCandidateId: Type.String({ minLength: 1 }),
    state: stringEnum(["dominates", "does_not_dominate", "unresolved"] as const),
    reasons: Type.Array(Type.String()),
  })),
  assessmentIds: Type.Array(Type.String()),
  calculationEvidence: Type.Array(EvidenceReferenceSchema, { minItems: 1 }),
});

export const FrontierRecommendationSchema = strictObject({
  frontierSnapshotId: Type.String({ minLength: 1 }),
  selectedCandidateId: Type.String({ minLength: 1 }),
  currentCandidateId: Type.String({ minLength: 1 }),
  reasons: Type.Array(Type.String()),
  preferenceEvidence: Type.Array(EvidenceReferenceSchema),
});

export const INTENT_OUTPUT_SCHEMAS = {
  establish_evals: strictObject({
    taskProfile: ConfirmedTaskProfileSchema,
    policy: SupervisedGraduationPolicySchema,
  }),
  instrument_observability: strictObject({
    coveredMetricIds: Type.Array(stringEnum(metricIds)),
    missingMetricIds: Type.Array(stringEnum(metricIds)),
  }),
  run_assessment: strictObject({
    baselineEvidenceSufficient: Type.Boolean(),
    metrics: Type.Optional(Type.Array(MetricRecordSchema)),
  }),
  discover_candidates: strictObject({
    candidates: Type.Array(CandidateDescriptorSchema),
  }),
  run_challenger_trials: strictObject({
    assessments: Type.Array(CandidateAssessmentSchema),
  }),
  calculate_frontier: strictObject({
    assessments: Type.Array(CandidateAssessmentSchema),
    frontierSnapshot: FrontierSnapshotSchema,
    recommendation: Type.Optional(FrontierRecommendationSchema),
  }),
  investigate_regression: strictObject({
    regressionDetected: Type.Boolean(),
    affectedMetricIds: Type.Array(stringEnum(metricIds)),
    likelyCause: Type.Optional(Type.String()),
  }),
  apply_model_swap: strictObject({
    appliedCandidateId: Type.String({ minLength: 1 }),
    previousCandidateId: Type.Optional(Type.String({ minLength: 1 })),
  }),
  verify_model_swap: strictObject({
    verified: Type.Boolean(),
    regressionDetected: Type.Boolean(),
  }),
  rollback_model_swap: strictObject({
    restoredCandidateId: Type.String({ minLength: 1 }),
  }),
} as const satisfies Readonly<Record<IntentKind, TSchema>>;

type SchemaOutputMap = {
  readonly [K in IntentKind]: Static<(typeof INTENT_OUTPUT_SCHEMAS)[K]>;
};
type Assert<T extends true> = T;
type _SchemasMatchProtocolTypes = Assert<SchemaOutputMap extends IntentOutputMap ? true : false>;

export function intentOutputSchemaFor(kind: IntentKind): TSchema {
  return INTENT_OUTPUT_SCHEMAS[kind];
}

export function validateIntentOutputSchema(kind: IntentKind, output: unknown): readonly string[] {
  const schema = intentOutputSchemaFor(kind);
  if (Check(schema, output)) return [];
  return [...Errors(schema, output)].map((error) =>
    `${error.instancePath || "/"} ${error.message}`,
  );
}

export function completionToolSchemaFor(kind: IntentKind): TSchema {
  return strictObject({
    intentId: Type.String({ minLength: 1 }),
    status: stringEnum(["succeeded", "failed", "cancelled"] as const),
    summary: Type.String({ minLength: 1 }),
    evidence: Type.Array(EvidenceReferenceSchema),
    outputs: Type.Optional(intentOutputSchemaFor(kind)),
    errorCode: Type.Optional(Type.String({ minLength: 1 })),
    errorMessage: Type.Optional(Type.String({ minLength: 1 })),
    retryable: Type.Optional(Type.Boolean()),
  });
}
