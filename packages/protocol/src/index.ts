export const PROTOCOL_VERSION = "0.1" as const;

export {
  ApplicationLlmTargetSchema,
  CandidateAssessmentSchema,
  CandidateDescriptorSchema,
  completionToolSchemaFor,
  EvidenceReferenceSchema,
  FrontierRecommendationSchema,
  FrontierSnapshotSchema,
  INTENT_OUTPUT_SCHEMAS,
  intentOutputSchemaFor,
  MetricObjectiveSchema,
  MetricRecordSchema,
  ObservabilityCoverageSchema,
  OPENMERIT_RESULT_SCHEMA_VERSION,
  OPENMERIT_SCHEMA_DIALECT,
  SupervisedGraduationPolicySchema,
  TaskProfileSchema,
  validateIntentOutputSchema,
} from "./schemas.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type IntentKind =
  | "establish_evals"
  | "instrument_observability"
  | "run_assessment"
  | "discover_candidates"
  | "run_challenger_trials"
  | "calculate_frontier"
  | "investigate_regression"
  | "apply_model_swap"
  | "verify_model_swap"
  | "rollback_model_swap";

export type HarnessCapability =
  | "user_confirmation"
  | "evaluation_authoring"
  | "observability_instrumentation"
  | "production_observation"
  | "candidate_discovery"
  | "challenger_execution"
  | "frontier_calculation"
  | "model_mutation"
  | "post_swap_verification"
  | "rollback";

export interface HarnessDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly protocolVersions: readonly string[];
  readonly capabilities: readonly HarnessCapability[];
  readonly executionModes: readonly ("interactive" | "non_interactive" | "remote")[];
  readonly structuredOutput: {
    readonly schemaDialect: typeof import("./schemas.ts").OPENMERIT_SCHEMA_DIALECT;
    readonly presentation: "dynamic_tool" | "static_tool_union" | "adapter_validation";
    readonly enforcement: "provider_and_harness" | "harness" | "adapter";
  };
  readonly automation: {
    readonly supportedSignals: readonly AutomationSignalType[];
    readonly persistentScheduling: boolean;
    readonly backgroundExecution: boolean;
    readonly wakeupProvisioning: "none" | "native" | "infrastructure_change";
  };
}

export interface HarnessDispatchReceipt {
  readonly accepted: boolean;
  readonly harnessJobId?: string;
  readonly reason?: string;
}

export interface EvaluationBudget {
  readonly currency: string;
  readonly maximumSpend: number;
  readonly maximumCandidateCount?: number;
  readonly maximumRunsPerCandidate?: number;
  readonly expiresAt?: string;
}

export interface SupervisedGraduationPolicy {
  readonly mode: "supervised_graduation";
  readonly evaluationBudget: EvaluationBudget;
  readonly automaticSwapsEnabled: boolean;
  readonly confirmationRequiredUntilVerifiedSwaps: number;
  readonly requirePostSwapVerification: true;
  readonly rollbackOnRegression: boolean;
  readonly checkPolicy: AutomationCheckPolicy;
}

export interface CheckCadence {
  readonly afterCompletedTasks?: number;
  readonly afterElapsedSeconds?: number;
}

export interface MetricRegressionThreshold {
  readonly metricId: MetricId;
  /** Fractional deterioration from the last measured value; 0.1 means 10%. */
  readonly relativeChangeAtLeast: number;
}

export interface AutomationCheckPolicy {
  readonly baselineAssessment: CheckCadence;
  readonly frontierReassessment: CheckCadence & {
    readonly onModelCatalogChange: boolean;
  };
  readonly regressionCheck: CheckCadence & {
    readonly thresholds: readonly MetricRegressionThreshold[];
  };
  readonly postSwapVerification: CheckCadence;
  readonly cooldownSeconds: number;
  readonly execution: {
    readonly mode: "active_session_only" | "persistent";
    readonly infrastructureChangesAllowed: boolean;
  };
}

export type IntentStatus =
  | "requested"
  | "accepted"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TerminalIntentStatus = Extract<
  IntentStatus,
  "succeeded" | "failed" | "cancelled"
>;

export interface EvidenceRequirement {
  readonly id: string;
  readonly description: string;
  readonly metricProfileId?: string;
}

/**
 * A durable, harness-neutral request for intelligent work.
 *
 * `requestedOutcome` says what must be true when the work is complete.
 * `constraints` carries JSON-safe task constraints without prescribing how a
 * harness should satisfy them.
 */
export interface OpenMeritIntent {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly kind: IntentKind;
  readonly targetId?: string;
  readonly taskProfileId: string;
  readonly authorizationPolicyId: string;
  readonly requestedOutcome: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly requestedAt: string;
}

export interface IntentLifecycleUpdate {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly intentId: string;
  readonly status: IntentStatus;
  readonly occurredAt: string;
  readonly message?: string;
  readonly progress?: {
    readonly completed: number;
    readonly total?: number;
    readonly unit?: string;
  };
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type EvidenceSource =
  | "harness_trace"
  | "evaluation_artifact"
  | "observability_record"
  | "external_source"
  | "user_feedback";

/** A stable pointer to evidence stored outside the protocol message. */
export interface EvidenceReference {
  readonly id: string;
  readonly source: EvidenceSource;
  readonly uri: string;
  readonly mediaType?: string;
  readonly digest?: string;
}

interface IntentResultBase {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly intentId: string;
  readonly completedAt: string;
  readonly summary: string;
  readonly evidence: readonly EvidenceReference[];
}

export type IntentResult<K extends IntentKind = IntentKind> = IntentResultBase & (
  | {
      readonly status: "succeeded";
      readonly outputs: IntentOutputMap[K];
      readonly error?: never;
    }
  | {
      readonly status: "failed";
      readonly outputs?: Readonly<Record<string, JsonValue>>;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: Readonly<Record<string, JsonValue>>;
      };
    }
  | {
      readonly status: "cancelled";
      readonly outputs?: Readonly<Record<string, JsonValue>>;
      readonly error?: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: Readonly<Record<string, JsonValue>>;
      };
    }
);

export type MetricId =
  | "task_quality"
  | "task_success"
  | "consistency"
  | "instruction_following"
  | "tool_use_performance"
  | "structured_output_reliability"
  | "hallucination_rate"
  | "reasoning_efficiency"
  | "input_token_consumption"
  | "output_token_consumption"
  | "total_task_cost"
  | "cost_per_successful_task"
  | "time_to_first_useful_output"
  | "end_to_end_task_latency"
  | "throughput"
  | "retry_rate"
  | "agent_steps"
  | "recovery_ability"
  | "context_handling"
  | "retrieval_use_quality"
  | "long_horizon_performance"
  | "human_intervention_rate"
  | "preference_fit";

export type MetricDirection = "maximize" | "minimize";
export type MetricScope = "single_run" | "sample_window";
export type MetricState =
  | "measured"
  | "not_applicable"
  | "not_configured"
  | "insufficient_evidence";
export type MeasurementMethod =
  | "observed"
  | "derived"
  | "evaluator"
  | "human"
  | "external";

export interface MetricDefinition {
  readonly id: MetricId;
  readonly label: string;
  readonly direction: MetricDirection;
  readonly defaultUnit: string;
  readonly requiresRepeatedRuns: boolean;
}

export const METRIC_CATALOG: readonly MetricDefinition[] = [
  { id: "task_quality", label: "Task quality", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "task_success", label: "Task success rate", direction: "maximize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "consistency", label: "Consistency", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: true },
  { id: "instruction_following", label: "Instruction following", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "tool_use_performance", label: "Tool-use performance", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "structured_output_reliability", label: "Structured-output reliability", direction: "maximize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "hallucination_rate", label: "Hallucination rate", direction: "minimize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "reasoning_efficiency", label: "Reasoning efficiency", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "input_token_consumption", label: "Input-token consumption", direction: "minimize", defaultUnit: "tokens", requiresRepeatedRuns: false },
  { id: "output_token_consumption", label: "Output-token consumption", direction: "minimize", defaultUnit: "tokens", requiresRepeatedRuns: false },
  { id: "total_task_cost", label: "Total task cost", direction: "minimize", defaultUnit: "usd", requiresRepeatedRuns: false },
  { id: "cost_per_successful_task", label: "Cost per successful task", direction: "minimize", defaultUnit: "usd", requiresRepeatedRuns: true },
  { id: "time_to_first_useful_output", label: "Time to first useful output", direction: "minimize", defaultUnit: "milliseconds", requiresRepeatedRuns: false },
  { id: "end_to_end_task_latency", label: "End-to-end task latency", direction: "minimize", defaultUnit: "milliseconds", requiresRepeatedRuns: false },
  { id: "throughput", label: "Throughput under workload", direction: "maximize", defaultUnit: "tasks_per_hour", requiresRepeatedRuns: true },
  { id: "retry_rate", label: "Retry rate", direction: "minimize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "agent_steps", label: "Agent steps", direction: "minimize", defaultUnit: "count", requiresRepeatedRuns: false },
  { id: "recovery_ability", label: "Recovery ability", direction: "maximize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "context_handling", label: "Context handling", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "retrieval_use_quality", label: "Retrieval-use quality", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: false },
  { id: "long_horizon_performance", label: "Long-horizon performance", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: true },
  { id: "human_intervention_rate", label: "Human intervention rate", direction: "minimize", defaultUnit: "ratio", requiresRepeatedRuns: true },
  { id: "preference_fit", label: "Preference and style fit", direction: "maximize", defaultUnit: "score", requiresRepeatedRuns: true },
] as const;

export interface MetricRecord {
  readonly targetId: string;
  readonly metricId: MetricId;
  readonly state: MetricState;
  readonly scope: MetricScope;
  readonly direction: MetricDirection;
  readonly method: MeasurementMethod;
  readonly value?: number;
  readonly unit: string;
  readonly sampleCount: number;
  readonly interval?: {
    readonly lower: number;
    readonly upper: number;
    readonly confidenceLevel?: number;
  };
  readonly window?: {
    readonly startedAt: string;
    readonly endedAt: string;
  };
  readonly evidence: readonly EvidenceReference[];
  readonly note?: string;
}

export interface MetricObjective {
  readonly metricId: MetricId;
  readonly required: boolean;
  readonly minimumSamples: number;
  readonly tolerance: number;
  readonly constraint?: {
    readonly operator: "at_least" | "at_most";
    readonly value: number;
  };
}

/** A user-confirmed application LLM route. The coding harness itself is never an evaluation target. */
export interface ApplicationLlmTarget {
  readonly id: string;
  readonly kind: "application_llm_call";
  readonly name: string;
  readonly applicationId: string;
  readonly callSites: readonly string[];
  readonly routeKey: string;
  readonly confirmedAt: string;
}

export interface TaskProfile {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly goal: string;
  readonly applicationTarget: ApplicationLlmTarget;
  readonly objectives: readonly MetricObjective[];
  readonly createdAt: string;
  readonly confirmedAt?: string;
}

export type ObservabilityReadinessStatus = "ready" | "incomplete";

export interface ObservabilityCoverage {
  readonly targetId: string;
  readonly status: ObservabilityReadinessStatus;
  readonly requiredMetricIds: readonly MetricId[];
  readonly coveredMetricIds: readonly MetricId[];
  readonly missingMetricIds: readonly MetricId[];
  readonly checkedAt: string;
}

export interface CandidateAssessment {
  readonly id: string;
  readonly targetId: string;
  readonly taskProfileId: string;
  readonly taskProfileRevision: number;
  readonly candidateId: string;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly productRevision: string;
  readonly harnessId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly metrics: readonly MetricRecord[];
}

export type ComparisonState = "dominates" | "does_not_dominate" | "unresolved";

export interface DominanceComparison {
  readonly candidateId: string;
  readonly otherCandidateId: string;
  readonly state: ComparisonState;
  readonly reasons: readonly string[];
}

export interface FrontierSnapshot {
  readonly id: string;
  readonly targetId: string;
  readonly taskProfileId: string;
  readonly taskProfileRevision: number;
  readonly productRevision: string;
  readonly createdAt: string;
  readonly frontierCandidateIds: readonly string[];
  readonly dominatedCandidateIds: readonly string[];
  readonly ineligibleCandidateIds: readonly string[];
  readonly unresolvedCandidateIds: readonly string[];
  readonly comparisons: readonly DominanceComparison[];
  readonly assessmentIds: readonly string[];
  readonly calculationEvidence: readonly EvidenceReference[];
}

export interface FrontierRecommendation {
  readonly targetId: string;
  readonly frontierSnapshotId: string;
  readonly selectedCandidateId: string;
  readonly currentCandidateId: string;
  readonly reasons: readonly string[];
  readonly preferenceEvidence: readonly EvidenceReference[];
}

export interface CandidateDescriptor {
  readonly targetId: string;
  readonly candidateId: string;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly reasons: readonly string[];
}

export interface IntentOutputMap {
  readonly establish_evals: {
    readonly taskProfile: TaskProfile;
    readonly policy: SupervisedGraduationPolicy;
    readonly observability: ObservabilityCoverage;
  };
  readonly instrument_observability: {
    readonly targetId: string;
    readonly coveredMetricIds: readonly MetricId[];
    readonly missingMetricIds: readonly MetricId[];
  };
  readonly run_assessment: {
    readonly targetId: string;
    readonly baselineEvidenceSufficient: boolean;
    readonly metrics: readonly MetricRecord[];
  };
  readonly discover_candidates: {
    readonly targetId: string;
    readonly candidates: readonly CandidateDescriptor[];
  };
  readonly run_challenger_trials: {
    readonly targetId: string;
    readonly assessments: readonly CandidateAssessment[];
  };
  readonly calculate_frontier: {
    readonly targetId: string;
    readonly assessments: readonly CandidateAssessment[];
    readonly frontierSnapshot: FrontierSnapshot;
    readonly recommendation?: FrontierRecommendation;
  };
  readonly investigate_regression: {
    readonly targetId: string;
    readonly regressionDetected: boolean;
    readonly affectedMetricIds: readonly MetricId[];
    readonly likelyCause?: string;
  };
  readonly apply_model_swap: {
    readonly targetId: string;
    readonly appliedCandidateId: string;
    readonly previousCandidateId?: string;
  };
  readonly verify_model_swap: {
    readonly targetId: string;
    readonly verified: boolean;
    readonly regressionDetected: boolean;
  };
  readonly rollback_model_swap: {
    readonly targetId: string;
    readonly restoredCandidateId: string;
  };
}

export type AnyIntentResult = {
  readonly [K in IntentKind]: IntentResult<K>;
}[IntentKind];

export const REQUIRED_CAPABILITIES: Readonly<Record<IntentKind, readonly HarnessCapability[]>> = {
  establish_evals: ["user_confirmation", "evaluation_authoring", "observability_instrumentation"],
  instrument_observability: ["observability_instrumentation"],
  run_assessment: ["production_observation"],
  discover_candidates: ["candidate_discovery"],
  run_challenger_trials: ["challenger_execution"],
  calculate_frontier: ["frontier_calculation"],
  investigate_regression: ["production_observation"],
  apply_model_swap: ["model_mutation"],
  verify_model_swap: ["post_swap_verification"],
  rollback_model_swap: ["rollback"],
} as const;

export type ImprovementStage =
  | "unconfigured"
  | "establishing_evidence"
  | "collecting_baseline"
  | "baseline_ready"
  | "discovering_candidates"
  | "candidates_ready"
  | "running_challenger_trials"
  | "challengers_ready"
  | "calculating_frontier"
  | "frontier_ready"
  | "awaiting_swap_approval"
  | "swap_approved"
  | "applying_swap"
  | "swap_applied"
  | "verifying_swap"
  | "swap_verified"
  | "verification_failed"
  | "rolling_back"
  | "monitoring";

export interface ImprovementCycleState {
  readonly id: string;
  readonly targetId?: string;
  readonly taskProfileId?: string;
  readonly stage: ImprovementStage;
  readonly activeCandidateId?: string;
  readonly previousCandidateId?: string;
  readonly proposedCandidateId?: string;
  readonly verifiedSwapCount: number;
  readonly baselineEvidenceSufficient: boolean;
  readonly observabilityReady?: boolean;
  readonly policy?: SupervisedGraduationPolicy;
}

export interface OpenMeritProjectConfig {
  readonly schemaVersion: 1;
  readonly activeTaskProfileId?: string;
  readonly taskProfiles: readonly TaskProfile[];
  readonly policy?: SupervisedGraduationPolicy;
}

export interface OpenMeritProjectState {
  readonly schemaVersion: 1;
  readonly cycle: ImprovementCycleState;
  readonly activeIntent?: OpenMeritIntent;
  readonly lastResult?: IntentResult;
  readonly observability?: ObservabilityCoverage;
  readonly automation: {
    readonly setupNudgeShown: boolean;
    readonly observedCompletedTasks: number;
    readonly lastAssessmentTaskCount: number;
    readonly modelCatalogFingerprint?: string;
    readonly modelCatalogChangedAt?: string;
    readonly processedSignalIds?: readonly string[];
    readonly pendingIntentKind?: IntentKind;
    readonly pendingIntentReason?: string;
    readonly lastAssessmentAt?: string;
    readonly lastReassessmentTaskCount?: number;
    readonly lastReassessmentAt?: string;
    readonly lastRegressionCheckTaskCount?: number;
    readonly lastRegressionCheckAt?: string;
    readonly swapAppliedTaskCount?: number;
    readonly swapAppliedAt?: string;
    readonly lastVerificationAt?: string;
    readonly latestMetricValues?: Readonly<Partial<Record<MetricId, number>>>;
    /** Spend from controlled challenger trials; ordinary product work is excluded. */
    readonly evaluationSpend?: number;
  };
  readonly updatedAt: string;
}

export type AuditEventType =
  | "project_initialized"
  | "intent_requested"
  | "intent_progressed"
  | "intent_completed"
  | "requirements_confirmation_required"
  | "swap_confirmation_required"
  | "frontier_verified"
  | "frontier_rejected"
  | "cycle_advanced"
  | "setup_nudged"
  | "task_observed"
  | "model_catalog_changed"
  | "automation_signal_recorded"
  | "automation_signal_duplicate"
  | "automation_check_due"
  | "observability_readiness_checked";

interface AutomationSignalBase {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly occurredAt: string;
  readonly targetId: string;
  readonly evidence?: readonly EvidenceReference[];
}

export type AutomationSignal =
  | (AutomationSignalBase & {
      readonly type: "product_task_completed";
      /** The model used by the application target, never the coding harness model. */
      readonly modelId: string;
      /** Provider telemetry captured from the application LLM call. */
      readonly telemetry?: {
        readonly startedAt: string;
        readonly completedAt: string;
        readonly durationMs: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens: number;
        readonly cost: number;
        readonly currency: "USD";
      };
    })
  | (AutomationSignalBase & {
      readonly type: "metric_window_available";
      readonly metrics: readonly MetricRecord[];
    })
  | (AutomationSignalBase & {
      readonly type: "scheduled_tick";
    })
  | (AutomationSignalBase & {
      readonly type: "model_catalog_changed";
      readonly fingerprint: string;
    })
  | (AutomationSignalBase & {
      readonly type: "verification_window_completed";
      readonly metrics?: readonly MetricRecord[];
    });

export type AutomationSignalType = AutomationSignal["type"];

export interface HarnessWakeupRequest {
  readonly at: string;
  readonly signal: "scheduled_tick";
  readonly reason: string;
}

export interface AutomationPlan {
  readonly mode: AutomationCheckPolicy["execution"]["mode"];
  readonly requiredSignals: readonly AutomationSignalType[];
  readonly nextWakeupAt?: string;
  readonly scheduling: "native" | "active_session_fallback" | "external_scheduler_required";
  readonly gaps: readonly string[];
}

export interface OpenMeritAuditEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: AuditEventType;
  readonly occurredAt: string;
  readonly cycleId: string;
  readonly intentId?: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface EvidenceManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly taskProfileId: string;
  readonly references: readonly EvidenceReference[];
}

const terminalStatuses: ReadonlySet<IntentStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalIntentStatus(
  status: IntentStatus,
): status is TerminalIntentStatus {
  return terminalStatuses.has(status);
}
