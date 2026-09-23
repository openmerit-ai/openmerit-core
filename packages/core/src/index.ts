import type {
  AnyIntentResult,
  AutomationPlan,
  AutomationSignal,
  AutomationSignalType,
  CandidateAssessment,
  DominanceComparison,
  FrontierSnapshot,
  HarnessCapability,
  HarnessDescriptor,
  HarnessDispatchReceipt,
  HarnessWakeupRequest,
  MetricObjective,
  MetricId,
  MetricRecord,
  TaskProfile,
  ImprovementCycleState,
  IntentLifecycleUpdate,
  IntentKind,
  IntentOutputMap,
  OpenMeritIntent,
  OpenMeritProjectConfig,
  OpenMeritProjectState,
  ObservabilityCoverage,
  JsonValue,
  SupervisedGraduationPolicy,
} from "../../protocol/src/index.ts";
import {
  METRIC_CATALOG,
  OPENMERIT_SCHEMA_DIALECT,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  validateIntentOutputSchema,
} from "../../protocol/src/index.ts";
import type { OpenMeritStore } from "./store.ts";

export {
  OPENMERIT_DIRECTORY,
  ProjectStore,
  type AuditEventExporter,
  type OpenMeritStore,
  type ProjectStoreOptions,
} from "./store.ts";

export interface HarnessAdapter {
  readonly descriptor: HarnessDescriptor;
  dispatch(intent: OpenMeritIntent): Promise<HarnessDispatchReceipt>;
  scheduleWakeup?(request: HarnessWakeupRequest): Promise<HarnessDispatchReceipt>;
}

export interface IntentFactoryOptions {
  readonly taskProfileId?: string;
  readonly authorizationPolicyId?: string;
  readonly policy?: SupervisedGraduationPolicy;
  readonly id?: string;
  readonly requestedAt?: string;
  readonly evaluationSpend?: number;
  readonly targetId?: string;
  readonly additionalConstraints?: Readonly<Record<string, JsonValue>>;
}

const outcomes: Readonly<Record<IntentKind, string>> = {
  establish_evals: "Identify the real application LLM call or shared application route under evaluation, ask the user to confirm that target and the task objectives, evaluation budget, check cadence, thresholds, scheduling mode, and automation permissions. Build runnable task-specific evaluation cases and application-call collectors for every required metric. Execute a representative smoke run through the same application authentication and runtime path, run the grader, and inspect actual quality, cost, token, latency, and other required outputs. Preserve the commands and resulting artifacts as setup evidence. Mark any metric missing if its collector or grader cannot produce a value; do not declare coverage ready based only on code existing. Do not count a setup smoke run as a production baseline sample. Return the confirmed taskProfile and policy. During setup, research a preliminary model shortlist with current sourced price estimates and reputation; report an empty list if no credible leads are available. These are research priors only: do not treat them as measured task results or change model configuration. The coding harness model is not an evaluation target.",
  instrument_observability: "Establish the missing observability required by the confirmed task profile. Exercise each collector and task-specific grader through a representative application run with the same authentication and runtime path, inspect actual metric outputs, and preserve verification artifacts. Report a metric covered only if that path produced its value; otherwise keep it missing. Do not count a setup smoke run as a production baseline sample.",
  run_assessment: "Assess existing application-target baseline metric windows against every required metric and sample threshold. Do not synthesize samples, count setup smoke runs as production data, or wait for new data during this check. If a required window is absent or immature, promptly return baselineEvidenceSufficient false with measured, missing, and insufficient-evidence metrics explicitly and cite the records inspected.",
  discover_candidates: "Refresh the preliminary model leads collected at setup and discover other credible candidates for the confirmed task profile using current capability, reputation, price, availability, and benchmark signals without exceeding the approved evaluation budget. Preliminary leads are research priors, not measured task evidence.",
  run_challenger_trials: "Run comparable controlled challenger trials under the approved budget and return candidate assessments with durable evidence.",
  calculate_frontier: "Calculate the Pareto frontier using the OpenMerit conformance definition, explain every candidate classification, and return a FrontierSnapshot with calculation evidence.",
  investigate_regression: "Investigate the observed regression and return its likely cause, affected metrics, and supporting evidence.",
  apply_model_swap: "Apply the approved model change only to the bound application LLM target and return proof of the resulting application configuration. Never change the coding harness model and do not broaden the authorized change.",
  verify_model_swap: "Verify the applied model against the approved post-swap evaluation window and report any material regression.",
  rollback_model_swap: "Restore the previously verified model configuration and validate the rollback.",
};

export function createOpenMeritIntent(kind: IntentKind, options: IntentFactoryOptions = {}): OpenMeritIntent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: options.id ?? `intent-${crypto.randomUUID()}`,
    kind,
    ...(options.targetId ? { targetId: options.targetId } : {}),
    taskProfileId: options.taskProfileId ?? "current-project",
    authorizationPolicyId: options.authorizationPolicyId ?? "observe-and-evaluate-only",
    requestedOutcome: outcomes[kind],
    constraints: {
      modelMutationAllowed: kind === "apply_model_swap" || kind === "rollback_model_swap",
      harnessModelMutationAllowed: false,
      mutationTarget: "application_llm_call",
      requireVerifiedArtifacts: true,
      distinguishSingleRunFromMultiRunClaims: true,
      ...(options.policy ? { evaluationBudget: options.policy.evaluationBudget as unknown as JsonValue } : {}),
      ...(options.policy ? {
        evaluationSpend: options.evaluationSpend ?? 0,
        remainingEvaluationBudget: Math.max(
          0,
          options.policy.evaluationBudget.maximumSpend - (options.evaluationSpend ?? 0),
        ),
      } : {}),
      ...(options.policy ? { checkPolicy: options.policy.checkPolicy as unknown as JsonValue } : {}),
      ...(options.additionalConstraints ?? {}),
    },
    requiredEvidence: kind === "establish_evals"
      ? [
          { id: "task-profile", description: "The inferred task profile and the user constraints it represents." },
          { id: "application-target", description: "The user-confirmed application LLM call or shared route, including stable call-site and route identifiers." },
          { id: "evaluation-artifacts", description: "Runnable evaluation artifacts and verification results." },
          { id: "observability-coverage", description: "The observable metrics and explicit coverage gaps." },
          { id: "preliminary-model-research", description: "Sources for preliminary model pricing and reputation, or an explanation that no credible leads were found." },
        ]
      : kind === "calculate_frontier"
        ? [
            { id: "frontier-snapshot", description: "A complete harness-calculated FrontierSnapshot." },
            { id: "frontier-calculation", description: "Durable evidence of the frontier calculation." },
          ]
        : [
            { id: "assessment-results", description: "Assessment results tied to the active task profile." },
            { id: "metric-coverage", description: "Observed, derived, and insufficient-evidence metric states." },
          ],
    requestedAt: options.requestedAt ?? new Date().toISOString(),
  };
}

export function missingHarnessCapabilities(
  descriptor: HarnessDescriptor,
  kind: IntentKind,
): readonly HarnessCapability[] {
  if (!descriptor.protocolVersions.includes(PROTOCOL_VERSION)) return REQUIRED_CAPABILITIES[kind];
  const available = new Set(descriptor.capabilities);
  return REQUIRED_CAPABILITIES[kind].filter((capability) => !available.has(capability));
}

export function validateHarnessDescriptor(descriptor: HarnessDescriptor): VerificationResult {
  const errors: string[] = [];
  if (!descriptor.id.trim()) errors.push("harness ID is required");
  if (!descriptor.name.trim()) errors.push("harness name is required");
  if (!descriptor.version.trim()) errors.push("harness version is required");
  if (!descriptor.protocolVersions.includes(PROTOCOL_VERSION)) {
    errors.push(`harness does not support OpenMerit protocol ${PROTOCOL_VERSION}`);
  }
  if (new Set(descriptor.capabilities).size !== descriptor.capabilities.length) {
    errors.push("harness capabilities contain duplicates");
  }
  if (descriptor.executionModes.length === 0) errors.push("at least one execution mode is required");
  if (!descriptor.structuredOutput) {
    errors.push("harness must declare structured-output behavior");
  } else if (descriptor.structuredOutput.schemaDialect !== OPENMERIT_SCHEMA_DIALECT) {
    errors.push(`harness does not support OpenMerit schema dialect ${OPENMERIT_SCHEMA_DIALECT}`);
  }
  if (!descriptor.automation || descriptor.automation.supportedSignals.length === 0) {
    errors.push("harness must declare at least one supported automation signal");
  } else if (descriptor.automation.persistentScheduling && descriptor.automation.wakeupProvisioning === "none") {
    errors.push("persistent scheduling requires a wakeup provisioning mechanism");
  }
  return { valid: errors.length === 0, errors };
}

export async function dispatchToHarness(
  adapter: HarnessAdapter,
  intent: OpenMeritIntent,
): Promise<HarnessDispatchReceipt> {
  const descriptorValidation = validateHarnessDescriptor(adapter.descriptor);
  if (!descriptorValidation.valid) {
    return { accepted: false, reason: descriptorValidation.errors.join("; ") };
  }
  const missing = missingHarnessCapabilities(adapter.descriptor, intent.kind);
  if (missing.length) {
    return { accepted: false, reason: `Harness lacks required capabilities: ${missing.join(", ")}` };
  }
  return adapter.dispatch(intent);
}

export function startedStage(kind: IntentKind): ImprovementCycleState["stage"] {
  switch (kind) {
    case "establish_evals":
    case "instrument_observability": return "establishing_evidence";
    case "run_assessment": return "collecting_baseline";
    case "discover_candidates": return "discovering_candidates";
    case "run_challenger_trials": return "running_challenger_trials";
    case "calculate_frontier": return "calculating_frontier";
    case "apply_model_swap": return "applying_swap";
    case "verify_model_swap": return "verifying_swap";
    case "rollback_model_swap": return "rolling_back";
    case "investigate_regression": return "monitoring";
  }
}

export function completedStage(kind: IntentKind, succeeded: boolean): ImprovementCycleState["stage"] {
  if (!succeeded) return kind === "verify_model_swap" ? "verification_failed" : "monitoring";
  switch (kind) {
    case "establish_evals":
    case "instrument_observability": return "collecting_baseline";
    case "run_assessment": return "baseline_ready";
    case "discover_candidates": return "candidates_ready";
    case "run_challenger_trials": return "challengers_ready";
    case "calculate_frontier": return "frontier_ready";
    case "apply_model_swap": return "swap_applied";
    case "verify_model_swap": return "swap_verified";
    case "rollback_model_swap":
    case "investigate_regression": return "monitoring";
  }
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ResultInterpretation extends VerificationResult {
  readonly nextStage?: ImprovementCycleState["stage"];
  readonly config?: OpenMeritProjectConfig;
  readonly cyclePatch?: Partial<ImprovementCycleState>;
}

const knownMetricIds = new Set(METRIC_CATALOG.map((metric) => metric.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSetupOutput(output: unknown): string[] {
  if (!isRecord(output) || !isRecord(output.taskProfile) || !isRecord(output.policy)) {
    return ["setup output requires taskProfile and policy"];
  }
  const profile = output.taskProfile;
  const policy = output.policy;
  const errors: string[] = [];
  if (typeof profile.id !== "string" || typeof profile.name !== "string" ||
      typeof profile.goal !== "string" || !Number.isInteger(profile.revision) ||
      typeof profile.confirmedAt !== "string" || !Array.isArray(profile.objectives) ||
      profile.objectives.length === 0) {
    errors.push("taskProfile must be confirmed and contain at least one objective");
  } else {
    for (const objective of profile.objectives) {
      if (!isRecord(objective) || typeof objective.metricId !== "string" ||
          !knownMetricIds.has(objective.metricId as never) || typeof objective.required !== "boolean" ||
          !Number.isInteger(objective.minimumSamples) || (objective.minimumSamples as number) < 1 ||
          typeof objective.tolerance !== "number") {
        errors.push("taskProfile contains an invalid metric objective");
        break;
      }
    }
  }
  if (!isRecord(profile.applicationTarget) || profile.applicationTarget.kind !== "application_llm_call" ||
      typeof profile.applicationTarget.id !== "string" || !profile.applicationTarget.id.trim() ||
      typeof profile.applicationTarget.applicationId !== "string" || !profile.applicationTarget.applicationId.trim() ||
      typeof profile.applicationTarget.routeKey !== "string" || !profile.applicationTarget.routeKey.trim() ||
      typeof profile.applicationTarget.confirmedAt !== "string" ||
      !Array.isArray(profile.applicationTarget.callSites) || profile.applicationTarget.callSites.length === 0 ||
      profile.applicationTarget.callSites.some((callSite) => typeof callSite !== "string" || !callSite.trim())) {
    errors.push("taskProfile requires a user-confirmed application LLM target with stable call sites and route key");
  }
  const budget = policy.evaluationBudget;
  if (policy.mode !== "supervised_graduation" || !isRecord(budget) ||
      typeof budget.currency !== "string" || typeof budget.maximumSpend !== "number" ||
      budget.maximumSpend < 0 || typeof policy.automaticSwapsEnabled !== "boolean" ||
      !Number.isInteger(policy.confirmationRequiredUntilVerifiedSwaps) ||
      policy.requirePostSwapVerification !== true || typeof policy.rollbackOnRegression !== "boolean") {
    errors.push("policy must be a valid supervised-graduation policy with an evaluation budget");
  }
  if (!isRecord(output.observability)) {
    errors.push("setup output requires an observability coverage report");
  } else if (Array.isArray(profile.objectives)) {
    errors.push(...validateObservabilityCoverage(
      profile as unknown as TaskProfile,
      output.observability as unknown as ObservabilityCoverage,
      false,
    ));
  }
  if (Array.isArray(output.preliminaryModelLeads) && isRecord(profile.applicationTarget)) {
    const seen = new Set<string>();
    for (const lead of output.preliminaryModelLeads) {
      if (!isRecord(lead)) continue;
      errors.push(...validateTargetId(lead.targetId, profile.applicationTarget.id as string, `preliminary lead ${String(lead.modelId)}`));
      const identity = `${String(lead.modelId)}@${String(lead.modelVersion ?? "")}`;
      if (seen.has(identity)) errors.push(`duplicate preliminary model lead ${identity}`);
      seen.add(identity);
    }
  }
  return errors;
}

export function validateObservabilityCoverage(
  profile: TaskProfile,
  coverage: ObservabilityCoverage,
  requireReady: boolean,
): readonly string[] {
  const required = new Set(profile.objectives.filter((item) => item.required).map((item) => item.metricId));
  const declaredRequired = new Set(coverage.requiredMetricIds);
  const covered = new Set(coverage.coveredMetricIds);
  const missing = new Set(coverage.missingMetricIds);
  const errors: string[] = [];
  if (coverage.targetId !== profile.applicationTarget.id) {
    errors.push("observability target does not match the confirmed application LLM target");
  }
  for (const metricId of required) {
    if (!declaredRequired.has(metricId)) errors.push(`observability omits required metric ${metricId}`);
    if (!covered.has(metricId) && !missing.has(metricId)) errors.push(`observability does not classify required metric ${metricId}`);
  }
  for (const metricId of covered) {
    if (missing.has(metricId)) errors.push(`observability marks ${metricId} as both covered and missing`);
  }
  const requiredMissing = [...required].filter((metricId) => !covered.has(metricId));
  const expectedStatus = requiredMissing.length === 0 ? "ready" : "incomplete";
  if (coverage.status !== expectedStatus) errors.push(`observability status must be ${expectedStatus}`);
  if (requireReady && requiredMissing.length) {
    errors.push(`required observability remains missing: ${requiredMissing.join(", ")}`);
  }
  return errors;
}

function activeTarget(config: OpenMeritProjectConfig): TaskProfile["applicationTarget"] | undefined {
  return config.taskProfiles.find((item) => item.id === config.activeTaskProfileId)?.applicationTarget;
}

function validateTargetId(actual: unknown, expected: string, subject: string): string[] {
  return actual === expected ? [] : [`${subject} target does not match the confirmed application LLM target`];
}

function validateMetricTargets(metrics: readonly MetricRecord[], targetId: string, subject: string): string[] {
  return metrics.flatMap((metric) => validateTargetId(metric.targetId, targetId, `${subject} metric ${metric.metricId}`));
}

export function interpretIntentResult(
  intent: OpenMeritIntent,
  result: AnyIntentResult,
  cycle: ImprovementCycleState,
  config: OpenMeritProjectConfig,
): ResultInterpretation {
  const errors: string[] = [];
  if (result.protocolVersion !== PROTOCOL_VERSION) errors.push("result protocol version does not match");
  if (result.intentId !== intent.id) errors.push("result intent ID does not match");
  if (result.status === "succeeded" && result.evidence.length === 0) errors.push("successful result requires evidence");
  if (result.status !== "succeeded") {
    return {
      valid: errors.length === 0,
      errors,
      nextStage: completedStage(intent.kind, false),
    };
  }

  const output: unknown = result.outputs;
  errors.push(...validateIntentOutputSchema(intent.kind, output).map((error) => `result outputs ${error}`));
  const target = activeTarget(config);
  if (intent.kind !== "establish_evals") {
    if (!target) errors.push("no confirmed application LLM target exists");
    else errors.push(...validateTargetId(intent.targetId, target.id, "intent"));
  }
  if (errors.length) {
    return { valid: false, errors, nextStage: completedStage(intent.kind, false) };
  }
  let nextStage = completedStage(intent.kind, true);
  let nextConfig: OpenMeritProjectConfig | undefined;
  let cyclePatch: Partial<ImprovementCycleState> | undefined;

  switch (intent.kind) {
    case "establish_evals": {
      errors.push(...validateSetupOutput(output));
      if (!errors.length && isRecord(output)) {
        const taskProfile = output.taskProfile as unknown as TaskProfile;
        const policy = output.policy as unknown as SupervisedGraduationPolicy;
        const observability = output.observability as unknown as ObservabilityCoverage;
        const preliminaryModelLeads = (output.preliminaryModelLeads ?? []) as unknown as NonNullable<IntentOutputMap["establish_evals"]["preliminaryModelLeads"]>;
        nextConfig = {
          schemaVersion: 1,
          activeTaskProfileId: taskProfile.id,
          taskProfiles: [...config.taskProfiles.filter((item) => item.id !== taskProfile.id), taskProfile],
          policy,
          preliminaryModelLeads,
        };
        cyclePatch = {
          targetId: taskProfile.applicationTarget.id,
          taskProfileId: taskProfile.id,
          policy,
          baselineEvidenceSufficient: false,
          observabilityReady: observability.status === "ready",
        };
        if (observability.status !== "ready") nextStage = "establishing_evidence";
      }
      break;
    }
    case "instrument_observability":
      if (!isRecord(output) || !Array.isArray(output.coveredMetricIds) || !Array.isArray(output.missingMetricIds)) {
        errors.push("observability result requires coveredMetricIds and missingMetricIds");
      } else {
        const profile = config.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
        if (!profile) errors.push("no confirmed task profile exists for observability verification");
        else {
          errors.push(...validateTargetId(output.targetId, profile.applicationTarget.id, "observability result"));
          const coverage: ObservabilityCoverage = {
            targetId: profile.applicationTarget.id,
            status: output.missingMetricIds.length ? "incomplete" : "ready",
            requiredMetricIds: profile.objectives.filter((item) => item.required).map((item) => item.metricId),
            coveredMetricIds: output.coveredMetricIds as MetricId[],
            missingMetricIds: output.missingMetricIds as MetricId[],
            checkedAt: result.completedAt,
          };
          errors.push(...validateObservabilityCoverage(profile, coverage, true));
          cyclePatch = { observabilityReady: errors.length === 0 };
        }
      }
      break;
    case "run_assessment":
      if (!isRecord(output) || typeof output.baselineEvidenceSufficient !== "boolean" || !Array.isArray(output.metrics)) {
        errors.push("assessment result requires baselineEvidenceSufficient");
      } else {
        if (target) {
          errors.push(...validateTargetId(output.targetId, target.id, "baseline assessment"));
          errors.push(...validateMetricTargets(output.metrics as unknown as MetricRecord[], target.id, "baseline assessment"));
          const profile = config.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
          if (output.baselineEvidenceSufficient) {
            errors.push(...baselineReadinessErrors(profile, output.metrics as unknown as MetricRecord[]));
          }
        }
        cyclePatch = { baselineEvidenceSufficient: output.baselineEvidenceSufficient };
        if (!output.baselineEvidenceSufficient) nextStage = "collecting_baseline";
      }
      break;
    case "discover_candidates":
      if (!isRecord(output) || !Array.isArray(output.candidates)) errors.push("candidate discovery requires candidates");
      else if (target) {
        errors.push(...validateTargetId(output.targetId, target.id, "candidate discovery"));
        for (const candidate of output.candidates) {
          if (isRecord(candidate)) errors.push(...validateTargetId(candidate.targetId, target.id, `candidate ${String(candidate.candidateId)}`));
        }
      }
      break;
    case "run_challenger_trials":
      if (!isRecord(output) || !Array.isArray(output.assessments)) {
        errors.push("challenger trials require assessments");
      } else {
        if (target) errors.push(...validateTargetId(output.targetId, target.id, "challenger trials"));
        for (const assessment of output.assessments as unknown as CandidateAssessment[]) {
          if (target) {
            errors.push(...validateTargetId(assessment.targetId, target.id, `challenger assessment ${assessment.id}`));
            errors.push(...validateMetricTargets(assessment.metrics, target.id, `challenger assessment ${assessment.id}`));
          }
          const costs = assessment.metrics.filter((metric) =>
            metric.metricId === "total_task_cost" && metric.state === "measured" &&
            metric.value !== undefined && metric.value >= 0 && metric.evidence.length > 0
          );
          if (costs.length !== 1) {
            errors.push(`challenger assessment ${assessment.id} requires exactly one measured total_task_cost with evidence`);
          }
        }
      }
      break;
    case "calculate_frontier": {
      if (!isRecord(output) || !Array.isArray(output.assessments) || !isRecord(output.frontierSnapshot)) {
        errors.push("frontier result requires assessments and frontierSnapshot");
        break;
      }
      const profile = config.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
      if (!profile) {
        errors.push("no confirmed task profile exists for frontier verification");
        break;
      }
      errors.push(...validateTargetId(output.targetId, profile.applicationTarget.id, "frontier result"));
      const verification = verifyFrontierSnapshot(
        profile,
        output.assessments as unknown as CandidateAssessment[],
        output.frontierSnapshot as unknown as FrontierSnapshot,
      );
      errors.push(...verification.errors);
      if (output.recommendation !== undefined) {
        if (!isRecord(output.recommendation) || typeof output.recommendation.selectedCandidateId !== "string") {
          errors.push("frontier recommendation is invalid");
        } else if (!(output.frontierSnapshot as unknown as FrontierSnapshot).frontierCandidateIds.includes(
          output.recommendation.selectedCandidateId as string,
        )) {
          errors.push("recommended candidate is not on the verified frontier");
        } else if (output.recommendation.targetId !== profile.applicationTarget.id) {
          errors.push("frontier recommendation target does not match the confirmed application LLM target");
        } else {
          cyclePatch = { proposedCandidateId: output.recommendation.selectedCandidateId as string };
        }
      }
      break;
    }
    case "investigate_regression":
      if (!isRecord(output) || typeof output.regressionDetected !== "boolean" || !Array.isArray(output.affectedMetricIds)) {
        errors.push("regression result requires regressionDetected and affectedMetricIds");
      } else if (target) errors.push(...validateTargetId(output.targetId, target.id, "regression investigation"));
      break;
    case "apply_model_swap":
      if (!isRecord(output) || typeof output.appliedCandidateId !== "string") {
        errors.push("swap result requires appliedCandidateId");
      } else if (target && output.targetId !== target.id) {
        errors.push("swap target does not match the confirmed application LLM target");
      } else if (cycle.proposedCandidateId && output.appliedCandidateId !== cycle.proposedCandidateId) {
        errors.push("applied candidate does not match the authorized proposal");
      } else {
        cyclePatch = {
          previousCandidateId: cycle.activeCandidateId,
          activeCandidateId: output.appliedCandidateId,
        };
      }
      break;
    case "verify_model_swap":
      if (!isRecord(output) || typeof output.verified !== "boolean" || typeof output.regressionDetected !== "boolean") {
        errors.push("swap verification requires verified and regressionDetected");
      } else if (target && output.targetId !== target.id) {
        errors.push("swap verification target does not match the confirmed application LLM target");
      } else if (!output.verified || output.regressionDetected) {
        nextStage = "verification_failed";
      } else {
        cyclePatch = { verifiedSwapCount: cycle.verifiedSwapCount + 1 };
      }
      break;
    case "rollback_model_swap":
      if (!isRecord(output) || typeof output.restoredCandidateId !== "string") {
        errors.push("rollback result requires restoredCandidateId");
      } else if (target && output.targetId !== target.id) {
        errors.push("rollback target does not match the confirmed application LLM target");
      } else if (cycle.previousCandidateId && output.restoredCandidateId !== cycle.previousCandidateId) {
        errors.push("rollback did not restore the previous verified candidate");
      } else {
        cyclePatch = { activeCandidateId: output.restoredCandidateId };
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length ? {} : { nextStage, config: nextConfig, cyclePatch }),
  };
}

export type OrchestrationDecision =
  | { readonly action: "issue_intent"; readonly intentKind: IntentKind; readonly reason: string }
  | { readonly action: "await_user"; readonly reason: string }
  | { readonly action: "observe"; readonly reason: string };

export function nextImprovementAction(state: ImprovementCycleState): OrchestrationDecision {
  switch (state.stage) {
    case "unconfigured":
      return { action: "issue_intent", intentKind: "establish_evals", reason: "Task profile, evaluations, and observability are not configured." };
    case "establishing_evidence":
      return state.observabilityReady
        ? { action: "observe", reason: "The harness is establishing evaluations and observability." }
        : { action: "issue_intent", intentKind: "instrument_observability", reason: "Required metric instrumentation is incomplete." };
    case "collecting_baseline":
      return state.baselineEvidenceSufficient
        ? { action: "issue_intent", intentKind: "discover_candidates", reason: "The baseline is ready for candidate discovery." }
        : { action: "observe", reason: "Continue collecting baseline production evidence." };
    case "baseline_ready":
      return { action: "issue_intent", intentKind: "discover_candidates", reason: "The baseline is ready for budgeted candidate discovery." };
    case "discovering_candidates":
    case "running_challenger_trials":
    case "calculating_frontier":
    case "applying_swap":
    case "verifying_swap":
    case "rolling_back":
      return { action: "observe", reason: "Harness work is in progress." };
    case "candidates_ready":
      return { action: "issue_intent", intentKind: "run_challenger_trials", reason: "Candidate models are ready for controlled comparison." };
    case "challengers_ready":
      return { action: "issue_intent", intentKind: "calculate_frontier", reason: "Comparable challenger evidence is ready." };
    case "frontier_ready": {
      if (!state.proposedCandidateId || state.proposedCandidateId === state.activeCandidateId) {
        return { action: "observe", reason: "The harness did not identify a materially better frontier candidate." };
      }
      if (!state.policy) return { action: "await_user", reason: "A swap policy must be approved before changing the model." };
      const graduated = state.policy.automaticSwapsEnabled &&
        state.verifiedSwapCount >= state.policy.confirmationRequiredUntilVerifiedSwaps;
      return graduated
        ? { action: "issue_intent", intentKind: "apply_model_swap", reason: "Bounded automatic swapping is enabled and the graduation threshold is satisfied." }
        : { action: "await_user", reason: "User confirmation is required for this model swap." };
    }
    case "awaiting_swap_approval":
      return { action: "await_user", reason: "Waiting for the user to approve or reject the proposed model swap." };
    case "swap_approved":
      return { action: "issue_intent", intentKind: "apply_model_swap", reason: "The user approved the proposed model swap." };
    case "swap_applied":
      return { action: "observe", reason: "Collect the user-confirmed post-swap verification window before verification." };
    case "swap_verified":
    case "monitoring":
      return { action: "observe", reason: "Monitor production evidence until reassessment is due." };
    case "verification_failed":
      return state.policy?.rollbackOnRegression
        ? { action: "issue_intent", intentKind: "rollback_model_swap", reason: "Post-swap verification detected a regression and rollback is required." }
        : { action: "await_user", reason: "Post-swap verification failed and automatic rollback is not authorized." };
  }
}

type Bounds = { lower: number; upper: number };
type Feasibility = "eligible" | "ineligible" | "unresolved";

function metricFor(assessment: CandidateAssessment, objective: MetricObjective): MetricRecord | undefined {
  return assessment.metrics.find((metric) => metric.metricId === objective.metricId);
}

function bounds(metric: MetricRecord): Bounds | undefined {
  if (metric.state !== "measured" || metric.value === undefined) return undefined;
  return metric.interval ?? { lower: metric.value, upper: metric.value };
}

function readinessErrors(profile: TaskProfile, assessment: CandidateAssessment): string[] {
  const errors: string[] = [];
  if (assessment.targetId !== profile.applicationTarget.id) {
    errors.push("assessment target does not match the confirmed application LLM target");
  }
  for (const objective of profile.objectives) {
    if (!objective.required) continue;
    const metric = metricFor(assessment, objective);
    if (!metric) errors.push(`${objective.metricId}: missing`);
    else if (metric.state !== "measured") errors.push(`${objective.metricId}: ${metric.state}`);
    else if (metric.value === undefined) errors.push(`${objective.metricId}: no numeric value`);
    else if (metric.sampleCount < objective.minimumSamples) {
      errors.push(`${objective.metricId}: ${metric.sampleCount}/${objective.minimumSamples} samples`);
    }
  }
  return errors;
}

function baselineReadinessErrors(profile: TaskProfile | undefined, metrics: readonly MetricRecord[]): string[] {
  if (!profile) return ["confirmed task profile is missing"];
  const errors: string[] = [];
  if (!profile.objectives.some((objective) => objective.required)) {
    errors.push("task profile has no required metric objectives");
  }
  for (const objective of profile.objectives) {
    if (!objective.required) continue;
    const metric = metrics.find((item) => item.metricId === objective.metricId &&
      item.targetId === profile.applicationTarget.id);
    if (!metric) errors.push(`${objective.metricId}: missing`);
    else if (metric.state !== "measured") errors.push(`${objective.metricId}: ${metric.state}`);
    else if (metric.value === undefined || !Number.isFinite(metric.value)) errors.push(`${objective.metricId}: no finite numeric value`);
    else if (metric.sampleCount < objective.minimumSamples) {
      errors.push(`${objective.metricId}: ${metric.sampleCount}/${objective.minimumSamples} samples`);
    } else if (!metric.evidence.length) errors.push(`${objective.metricId}: no evidence reference`);
  }
  return errors;
}

function baselineAssessmentErrors(
  state: OpenMeritProjectState,
  profile: TaskProfile | undefined,
  metrics: readonly MetricRecord[],
): string[] {
  return [
    ...(state.cycle.observabilityReady ? [] : ["required evaluation and observability setup is not ready"]),
    ...baselineReadinessErrors(profile, metrics),
  ];
}

function updatedBaselineWindows(
  previous: readonly MetricRecord[] | undefined,
  signal: AutomationSignal,
): readonly MetricRecord[] {
  if (signal.type !== "metric_window_available") return previous ?? [];
  const windows = new Map((previous ?? []).map((metric) => [metric.metricId, metric]));
  for (const metric of signal.metrics) windows.set(metric.metricId, metric);
  return [...windows.values()];
}

function feasibility(profile: TaskProfile, assessment: CandidateAssessment): Feasibility {
  if (readinessErrors(profile, assessment).length) return "unresolved";
  let unresolved = false;
  for (const objective of profile.objectives) {
    if (!objective.constraint) continue;
    const range = bounds(metricFor(assessment, objective)!)!;
    if (objective.constraint.operator === "at_least") {
      if (range.upper < objective.constraint.value) return "ineligible";
      if (range.lower < objective.constraint.value) unresolved = true;
    } else {
      if (range.lower > objective.constraint.value) return "ineligible";
      if (range.upper > objective.constraint.value) unresolved = true;
    }
  }
  return unresolved ? "unresolved" : "eligible";
}

function expectedComparison(
  profile: TaskProfile,
  candidate: CandidateAssessment,
  other: CandidateAssessment,
): DominanceComparison {
  const reasons: string[] = [];
  let strictlyBetter = false;
  let uncertain = false;

  for (const objective of profile.objectives) {
    const aMetric = metricFor(candidate, objective);
    const bMetric = metricFor(other, objective);
    const a = aMetric && bounds(aMetric);
    const b = bMetric && bounds(bMetric);
    if (!aMetric || !bMetric || !a || !b || aMetric.unit !== bMetric.unit || aMetric.direction !== bMetric.direction) {
      return {
        candidateId: candidate.candidateId,
        otherCandidateId: other.candidateId,
        state: "unresolved",
        reasons: [`${objective.metricId}: incompatible or insufficient evidence`],
      };
    }

    const tolerance = objective.tolerance;
    if (aMetric.direction === "maximize") {
      if (a.lower + tolerance >= b.upper) {
        if (a.lower > b.upper + tolerance) strictlyBetter = true;
      } else if (a.upper + tolerance < b.lower) {
        reasons.push(`${objective.metricId}: proven worse`);
        return { candidateId: candidate.candidateId, otherCandidateId: other.candidateId, state: "does_not_dominate", reasons };
      } else uncertain = true;
    } else {
      if (a.upper <= b.lower + tolerance) {
        if (a.upper + tolerance < b.lower) strictlyBetter = true;
      } else if (a.lower > b.upper + tolerance) {
        reasons.push(`${objective.metricId}: proven worse`);
        return { candidateId: candidate.candidateId, otherCandidateId: other.candidateId, state: "does_not_dominate", reasons };
      } else uncertain = true;
    }
  }

  if (uncertain) {
    return {
      candidateId: candidate.candidateId,
      otherCandidateId: other.candidateId,
      state: "unresolved",
      reasons: ["one or more objective intervals do not establish ordering"],
    };
  }
  if (!strictlyBetter) {
    return {
      candidateId: candidate.candidateId,
      otherCandidateId: other.candidateId,
      state: "does_not_dominate",
      reasons: ["no objective is materially better"],
    };
  }
  return {
    candidateId: candidate.candidateId,
    otherCandidateId: other.candidateId,
    state: "dominates",
    reasons: ["proven no worse on every objective and materially better on at least one"],
  };
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
}

export function verifyFrontierSnapshot(
  profile: TaskProfile,
  assessments: readonly CandidateAssessment[],
  snapshot: FrontierSnapshot,
): VerificationResult {
  const errors: string[] = [];
  const byCandidate = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));

  if (snapshot.taskProfileId !== profile.id || snapshot.taskProfileRevision !== profile.revision) {
    errors.push("snapshot task profile does not match");
  }
  if (snapshot.targetId !== profile.applicationTarget.id) {
    errors.push("snapshot target does not match the confirmed application LLM target");
  }
  if (snapshot.calculationEvidence.length === 0) errors.push("calculation evidence is required");
  if (!sameMembers(snapshot.assessmentIds, assessments.map((assessment) => assessment.id))) {
    errors.push("snapshot assessment IDs do not match the supplied assessments");
  }

  const eligible: CandidateAssessment[] = [];
  const expectedIneligible: string[] = [];
  const expectedUnresolved = new Set<string>();
  for (const assessment of assessments) {
    if (assessment.targetId !== profile.applicationTarget.id) {
      errors.push(`${assessment.candidateId}: application target mismatch`);
      continue;
    }
    errors.push(...validateMetricTargets(assessment.metrics, profile.applicationTarget.id, assessment.candidateId));
    if (assessment.taskProfileId !== profile.id || assessment.taskProfileRevision !== profile.revision) {
      errors.push(`${assessment.candidateId}: task profile revision mismatch`);
      continue;
    }
    if (assessment.productRevision !== snapshot.productRevision) {
      errors.push(`${assessment.candidateId}: product revision mismatch`);
      continue;
    }
    const state = feasibility(profile, assessment);
    if (state === "eligible") eligible.push(assessment);
    else if (state === "ineligible") expectedIneligible.push(assessment.candidateId);
    else expectedUnresolved.add(assessment.candidateId);
  }

  const expectedDominated = new Set<string>();
  const expectedComparisons: DominanceComparison[] = [];
  for (const candidate of eligible) {
    for (const other of eligible) {
      if (candidate.candidateId === other.candidateId) continue;
      const comparison = expectedComparison(profile, candidate, other);
      expectedComparisons.push(comparison);
      if (comparison.state === "dominates") expectedDominated.add(other.candidateId);
      if (comparison.state === "unresolved") {
        expectedUnresolved.add(candidate.candidateId);
        expectedUnresolved.add(other.candidateId);
      }
    }
  }

  for (const expected of expectedComparisons) {
    const actual = snapshot.comparisons.find((comparison) =>
      comparison.candidateId === expected.candidateId && comparison.otherCandidateId === expected.otherCandidateId);
    if (!actual) errors.push(`missing comparison ${expected.candidateId} -> ${expected.otherCandidateId}`);
    else if (actual.state !== expected.state) {
      errors.push(`comparison ${expected.candidateId} -> ${expected.otherCandidateId} should be ${expected.state}, got ${actual.state}`);
    } else if (actual.reasons.length === 0) {
      errors.push(`comparison ${expected.candidateId} -> ${expected.otherCandidateId} requires reasons`);
    }
  }

  const expectedFrontier = eligible
    .map((assessment) => assessment.candidateId)
    .filter((candidateId) => !expectedDominated.has(candidateId) && !expectedUnresolved.has(candidateId));

  if (!sameMembers(snapshot.frontierCandidateIds, expectedFrontier)) errors.push("frontier candidate set is incorrect");
  if (!sameMembers(snapshot.dominatedCandidateIds, [...expectedDominated])) errors.push("dominated candidate set is incorrect");
  if (!sameMembers(snapshot.ineligibleCandidateIds, expectedIneligible)) errors.push("ineligible candidate set is incorrect");
  if (!sameMembers(snapshot.unresolvedCandidateIds, [...expectedUnresolved])) errors.push("unresolved candidate set is incorrect");

  const allKnown = new Set(byCandidate.keys());
  for (const id of [
    ...snapshot.frontierCandidateIds,
    ...snapshot.dominatedCandidateIds,
    ...snapshot.ineligibleCandidateIds,
    ...snapshot.unresolvedCandidateIds,
  ]) {
    if (!allKnown.has(id)) errors.push(`unknown candidate ${id}`);
  }

  return { valid: errors.length === 0, errors };
}

export interface IssuedIntent {
  readonly intent: OpenMeritIntent;
  readonly state: OpenMeritProjectState;
  readonly receipt: HarnessDispatchReceipt;
}

export interface CoordinatorIssueOptions {
  readonly additionalConstraints?: Readonly<Record<string, JsonValue>>;
}

export interface AcceptedIntentResult {
  readonly intentKind: IntentKind;
  readonly state: OpenMeritProjectState;
  readonly interpretation: ResultInterpretation;
  readonly automation: {
    readonly plan: AutomationPlan;
    readonly receipt?: HarnessDispatchReceipt;
  };
}

export interface ObservationResult {
  readonly state: OpenMeritProjectState;
  readonly assessmentDue: boolean;
}

export interface CatalogChangeResult {
  readonly state: OpenMeritProjectState;
  readonly changed: boolean;
  readonly reassessmentDue: boolean;
}

export interface AutomationSignalResult {
  readonly state: OpenMeritProjectState;
  readonly duplicate: boolean;
  readonly decision: OrchestrationDecision;
}

const MAX_PROCESSED_SIGNAL_IDS = 256;

function nextAt(anchor: string, seconds?: number): string | undefined {
  if (seconds === undefined) return undefined;
  return new Date(Date.parse(anchor) + seconds * 1000).toISOString();
}

function earliest(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function buildAutomationPlan(
  state: OpenMeritProjectState,
  descriptor: HarnessDescriptor,
): AutomationPlan {
  if (state.automation.paused) {
    return {
      mode: state.cycle.policy?.checkPolicy.execution.mode ?? "active_session_only",
      requiredSignals: [],
      scheduling: "active_session_fallback",
      gaps: ["Proactive OpenMerit checks are paused."],
    };
  }
  const policy = state.cycle.policy?.checkPolicy;
  if (!policy) {
    return {
      mode: "active_session_only",
      requiredSignals: [],
      scheduling: "active_session_fallback",
      gaps: ["No user-confirmed automation policy exists."],
    };
  }

  const required = new Set<AutomationSignalType>();
  const cadences = [
    policy.baselineAssessment,
    policy.frontierReassessment,
    policy.regressionCheck,
    policy.postSwapVerification,
  ];
  if (cadences.some((cadence) => cadence.afterCompletedTasks !== undefined)) required.add("product_task_completed");
  if (cadences.some((cadence) => cadence.afterElapsedSeconds !== undefined)) required.add("scheduled_tick");
  if (policy.frontierReassessment.onModelCatalogChange) required.add("model_catalog_changed");
  if (policy.regressionCheck.thresholds.length) required.add("metric_window_available");
  if (policy.postSwapVerification.afterCompletedTasks === undefined &&
      policy.postSwapVerification.afterElapsedSeconds === undefined) {
    required.add("verification_window_completed");
  }

  const nextWakeupAt = state.cycle.stage === "collecting_baseline"
    ? nextAt(state.automation.lastAssessmentAt ?? state.automation.baselineStartedAt ?? state.lastResult?.completedAt ?? state.updatedAt,
      policy.baselineAssessment.afterElapsedSeconds)
    : ["monitoring", "swap_verified"].includes(state.cycle.stage)
      ? earliest([
          nextAt(state.automation.lastReassessmentAt ?? state.updatedAt, policy.frontierReassessment.afterElapsedSeconds),
          nextAt(state.automation.lastRegressionCheckAt ?? state.updatedAt, policy.regressionCheck.afterElapsedSeconds),
        ])
      : state.cycle.stage === "swap_applied"
        ? nextAt(state.automation.swapAppliedAt ?? state.updatedAt, policy.postSwapVerification.afterElapsedSeconds)
        : undefined;

  const supported = new Set(descriptor.automation.supportedSignals);
  const gaps = [...required]
    .filter((signal) => !supported.has(signal))
    .map((signal) => `Harness does not report ${signal}.`);
  let scheduling: AutomationPlan["scheduling"] = "active_session_fallback";
  if (policy.execution.mode === "persistent") {
    scheduling = descriptor.automation.persistentScheduling && descriptor.automation.backgroundExecution
      ? "native"
      : "external_scheduler_required";
    if (scheduling === "external_scheduler_required") {
      gaps.push("Persistent scheduling or background execution is unavailable; configure an external scheduler.");
    }
    if (descriptor.automation.wakeupProvisioning === "infrastructure_change" &&
        !policy.execution.infrastructureChangesAllowed) {
      scheduling = "external_scheduler_required";
      gaps.push("Wakeup provisioning requires an infrastructure change that the user has not authorized.");
    }
  }

  return {
    mode: policy.execution.mode,
    requiredSignals: [...required],
    ...(nextWakeupAt ? { nextWakeupAt } : {}),
    scheduling,
    gaps,
  };
}

function cadenceDue(
  cadence: { readonly afterCompletedTasks?: number; readonly afterElapsedSeconds?: number },
  completedTasks: number,
  lastTaskCount: number,
  lastAt: string,
  now: string,
): boolean {
  const taskDue = cadence.afterCompletedTasks !== undefined &&
    completedTasks - lastTaskCount >= cadence.afterCompletedTasks;
  const elapsedDue = cadence.afterElapsedSeconds !== undefined &&
    Date.parse(now) - Date.parse(lastAt) >= cadence.afterElapsedSeconds * 1000;
  return taskDue || elapsedDue;
}

function regressionMetric(
  signal: AutomationSignal,
  previous: Readonly<Partial<Record<MetricId, number>>>,
  policy: SupervisedGraduationPolicy,
): MetricId | undefined {
  if (signal.type !== "metric_window_available") return undefined;
  const directions = new Map(METRIC_CATALOG.map((metric) => [metric.id, metric.direction]));
  for (const threshold of policy.checkPolicy.regressionCheck.thresholds) {
    const current = signal.metrics.find((metric) =>
      metric.metricId === threshold.metricId && metric.state === "measured" && metric.value !== undefined);
    const prior = previous[threshold.metricId];
    if (!current || current.value === undefined || prior === undefined) continue;
    const denominator = Math.max(Math.abs(prior), Number.EPSILON);
    const deterioration = directions.get(threshold.metricId) === "minimize"
      ? (current.value - prior) / denominator
      : (prior - current.value) / denominator;
    if (deterioration >= threshold.relativeChangeAtLeast) return threshold.metricId;
  }
  return undefined;
}

function dueDecision(
  state: OpenMeritProjectState,
  signal: AutomationSignal,
  now: string,
): OrchestrationDecision {
  if (state.automation.paused) return { action: "observe", reason: "Proactive OpenMerit checks are paused." };
  if (state.activeIntent) return { action: "observe", reason: "Harness work is already active." };
  if (state.automation.pendingIntentKind) {
    return {
      action: "issue_intent",
      intentKind: state.automation.pendingIntentKind,
      reason: state.automation.pendingIntentReason ?? "A previously detected automation check remains due.",
    };
  }
  const policy = state.cycle.policy;
  if (!policy) return { action: "observe", reason: "No user-confirmed automation policy exists." };
  const completed = state.automation.observedCompletedTasks;
  const cooldownAnchor = [state.automation.lastReassessmentAt, state.automation.lastRegressionCheckAt]
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const cooldownSatisfied = !cooldownAnchor ||
    Date.parse(now) - Date.parse(cooldownAnchor) >= policy.checkPolicy.cooldownSeconds * 1000;

  if (state.cycle.stage === "collecting_baseline" && cadenceDue(
    policy.checkPolicy.baselineAssessment,
    completed,
    state.automation.lastAssessmentTaskCount,
    state.automation.lastAssessmentAt ?? state.automation.baselineStartedAt ?? state.lastResult?.completedAt ?? state.updatedAt,
    now,
  )) {
    return { action: "issue_intent", intentKind: "run_assessment", reason: "The user-confirmed baseline assessment cadence is due." };
  }

  if (["monitoring", "swap_verified"].includes(state.cycle.stage) && cooldownSatisfied) {
    const regressedMetric = regressionMetric(signal, state.automation.latestMetricValues ?? {}, policy);
    if (regressedMetric) {
      return { action: "issue_intent", intentKind: "investigate_regression", reason: `${regressedMetric} crossed its user-confirmed regression threshold.` };
    }
    if (cadenceDue(
      policy.checkPolicy.regressionCheck,
      completed,
      state.automation.lastRegressionCheckTaskCount ?? 0,
      state.automation.lastRegressionCheckAt ?? state.updatedAt,
      now,
    )) {
      return { action: "issue_intent", intentKind: "investigate_regression", reason: "The user-confirmed regression check cadence is due." };
    }
    if (signal.type === "model_catalog_changed" && policy.checkPolicy.frontierReassessment.onModelCatalogChange &&
        state.automation.modelCatalogFingerprint !== undefined &&
        state.automation.modelCatalogFingerprint !== signal.fingerprint) {
      return { action: "issue_intent", intentKind: "discover_candidates", reason: "The model catalogue changed and the user enabled catalogue-triggered reassessment." };
    }
    if (cadenceDue(
      policy.checkPolicy.frontierReassessment,
      completed,
      state.automation.lastReassessmentTaskCount ?? 0,
      state.automation.lastReassessmentAt ?? state.updatedAt,
      now,
    )) {
      return { action: "issue_intent", intentKind: "discover_candidates", reason: "The user-confirmed frontier reassessment cadence is due." };
    }
  }

  if (state.cycle.stage === "swap_applied" &&
      (signal.type === "verification_window_completed" || cadenceDue(
        policy.checkPolicy.postSwapVerification,
        completed,
        state.automation.swapAppliedTaskCount ?? completed,
        state.automation.swapAppliedAt ?? state.updatedAt,
        now,
      ))) {
    return { action: "issue_intent", intentKind: "verify_model_swap", reason: "The user-confirmed post-swap verification window is complete." };
  }

  return { action: "observe", reason: "No user-confirmed automation check is due." };
}

function auditSignalData(signal: AutomationSignal): Readonly<Record<string, JsonValue>> {
  switch (signal.type) {
    case "product_task_completed":
      return {
        targetId: signal.targetId,
        modelId: signal.modelId,
        ...(signal.telemetry ? { telemetry: signal.telemetry as unknown as JsonValue } : {}),
        evidenceIds: (signal.evidence ?? []).map((item) => item.id),
      };
    case "metric_window_available":
    case "verification_window_completed":
      return {
        targetId: signal.targetId,
        metrics: (signal.metrics ?? []).map((metric) => ({
          targetId: metric.targetId,
          metricId: metric.metricId,
          state: metric.state,
          scope: metric.scope,
          direction: metric.direction,
          method: metric.method,
          value: metric.value ?? null,
          unit: metric.unit,
          sampleCount: metric.sampleCount,
          ...(metric.interval ? { interval: metric.interval } : {}),
          ...(metric.window ? { window: metric.window } : {}),
          evidenceIds: metric.evidence.map((item) => item.id),
        })),
      };
    case "model_catalog_changed":
      return { targetId: signal.targetId, fingerprint: signal.fingerprint };
    case "scheduled_tick":
      return { targetId: signal.targetId };
  }
}

/** Harness-neutral durable coordinator. Adapters transport jobs; this class owns lifecycle state. */
export class OpenMeritCoordinator {
  private readonly store: OpenMeritStore;
  private readonly adapter: HarnessAdapter;

  constructor(
    store: OpenMeritStore,
    adapter: HarnessAdapter,
  ) {
    this.store = store;
    this.adapter = adapter;
  }

  async issue(kind: IntentKind, options: CoordinatorIssueOptions = {}): Promise<IssuedIntent> {
    const missing = missingHarnessCapabilities(this.adapter.descriptor, kind);
    if (missing.length) throw new Error(`Harness lacks required capabilities: ${missing.join(", ")}`);

    const config = await this.store.readConfig() ?? { schemaVersion: 1, taskProfiles: [] };
    const existing = await this.store.readState();
    if (existing?.activeIntent) throw new Error(`OpenMerit intent ${existing.activeIntent.id} is already active.`);
    if (kind === "run_challenger_trials" && config.policy) {
      const spent = existing?.automation.evaluationSpend ?? 0;
      const limit = config.policy.evaluationBudget.maximumSpend;
      if (spent >= limit) {
        throw new Error(
          `Evaluation budget exhausted: ${spent.toFixed(6)} ${config.policy.evaluationBudget.currency} spent of ${limit.toFixed(6)}.`,
        );
      }
    }

    const targetId = activeTarget(config)?.id;
    const confirmedProfile = config.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
    if (kind !== "establish_evals" && !targetId) {
      throw new Error(`OpenMerit cannot issue ${kind} without a confirmed application LLM target.`);
    }
    const intent = createOpenMeritIntent(kind, {
      taskProfileId: config.activeTaskProfileId,
      policy: config.policy,
      evaluationSpend: existing?.automation.evaluationSpend,
      targetId,
      additionalConstraints: {
        ...options.additionalConstraints,
        ...(confirmedProfile ? { taskProfile: confirmedProfile as unknown as JsonValue } : {}),
        ...(kind === "discover_candidates"
          ? { preliminaryModelLeads: (config.preliminaryModelLeads ?? []) as unknown as JsonValue }
          : {}),
      },
    });
    const now = new Date().toISOString();
    const state: OpenMeritProjectState = existing
      ? {
          ...existing,
          cycle: { ...existing.cycle, stage: startedStage(kind) },
          activeIntent: intent,
          automation: {
            ...existing.automation,
            ...(existing.automation.pendingIntentKind === kind
              ? { pendingIntentKind: undefined, pendingIntentReason: undefined }
              : {}),
          },
          updatedAt: now,
        }
      : {
          schemaVersion: 1,
          cycle: {
            id: `cycle-${crypto.randomUUID()}`,
            stage: startedStage(kind),
            verifiedSwapCount: 0,
            baselineEvidenceSufficient: false,
            observabilityReady: false,
          },
          activeIntent: intent,
          automation: {
            setupNudgeShown: kind === "establish_evals",
            observedCompletedTasks: 0,
            lastAssessmentTaskCount: 0,
            processedSignalIds: [],
          },
          updatedAt: now,
        };

    if (existing) await this.store.writeState(state);
    else {
      await this.store.initialize(config, state);
      await this.store.appendEvent({
        schemaVersion: 1,
        id: `event-${crypto.randomUUID()}`,
        type: "project_initialized",
        occurredAt: now,
        cycleId: state.cycle.id,
        data: { harnessId: this.adapter.descriptor.id },
      });
    }
    await this.store.appendEvent({
      schemaVersion: 1,
      id: `event-${crypto.randomUUID()}`,
      type: "intent_requested",
      occurredAt: now,
      cycleId: state.cycle.id,
      intentId: intent.id,
      data: { kind, harnessId: this.adapter.descriptor.id },
    });

    const receipt = await dispatchToHarness(this.adapter, intent);
    if (!receipt.accepted) {
      await this.store.writeState({
        ...state,
        cycle: { ...state.cycle, stage: existing?.cycle.stage ?? "unconfigured" },
        activeIntent: undefined,
        automation: {
          ...state.automation,
          pendingIntentKind: kind,
          pendingIntentReason: "Harness dispatch failed; the due intent remains pending.",
        },
        updatedAt: new Date().toISOString(),
      });
      throw new Error(receipt.reason ?? "Harness rejected the OpenMerit intent.");
    }
    return { intent, state, receipt };
  }

  async reconcileAutomation(now = new Date().toISOString()): Promise<{
    readonly plan: AutomationPlan;
    readonly receipt?: HarnessDispatchReceipt;
  }> {
    const state = await this.store.readState();
    if (!state) throw new Error("OpenMerit project is not initialized.");
    const plan = buildAutomationPlan(state, this.adapter.descriptor);
    if (plan.scheduling !== "native" || !plan.nextWakeupAt || Date.parse(plan.nextWakeupAt) <= Date.parse(now)) {
      return { plan };
    }
    if (!this.adapter.scheduleWakeup) {
      return {
        plan: {
          ...plan,
          scheduling: "external_scheduler_required",
          gaps: [...plan.gaps, "Harness declared native scheduling but did not implement scheduleWakeup."],
        },
      };
    }
    const receipt = await this.adapter.scheduleWakeup({
      at: plan.nextWakeupAt,
      signal: "scheduled_tick",
      reason: "Wake the harness so OpenMerit can evaluate the user-confirmed check policy.",
    });
    if (!receipt.accepted) {
      return {
        plan: {
          ...plan,
          scheduling: "external_scheduler_required",
          gaps: [...plan.gaps, `Harness wakeup provisioning failed: ${receipt.reason ?? "unknown reason"}`],
        },
        receipt,
      };
    }
    return { plan, receipt };
  }

  async acceptResult(result: AnyIntentResult): Promise<AcceptedIntentResult> {
    const state = await this.store.readState();
    if (!state?.activeIntent) throw new Error("No durable OpenMerit intent is active.");
    const config = await this.store.readConfig() ?? { schemaVersion: 1, taskProfiles: [] };
    const interpretation = interpretIntentResult(state.activeIntent, result, state.cycle, config);
    if (!interpretation.valid || !interpretation.nextStage) {
      throw new Error(`OpenMerit rejected the harness result: ${interpretation.errors.join("; ")}`);
    }

    if (interpretation.config) await this.store.writeConfig(interpretation.config);
    const now = new Date().toISOString();
    const evaluationSpend = result.status === "succeeded" && state.activeIntent.kind === "run_challenger_trials"
      ? (result.outputs as IntentOutputMap["run_challenger_trials"]).assessments.reduce(
          (sum, assessment) => sum + assessment.metrics
            .filter((metric) => metric.metricId === "total_task_cost" && metric.state === "measured")
            .reduce((metricSum, metric) => metricSum + (metric.value ?? 0), 0),
          state.automation.evaluationSpend ?? 0,
        )
      : state.automation.evaluationSpend;
    if (config.policy && evaluationSpend !== undefined &&
        evaluationSpend > config.policy.evaluationBudget.maximumSpend) {
      throw new Error(
        `OpenMerit rejected challenger results: evaluation spend ${evaluationSpend.toFixed(6)} ` +
        `${config.policy.evaluationBudget.currency} exceeds the approved limit ` +
        `${config.policy.evaluationBudget.maximumSpend.toFixed(6)}.`,
      );
    }
    let observability = state.observability;
    if (result.status === "succeeded" && state.activeIntent.kind === "establish_evals") {
      observability = (result.outputs as IntentOutputMap["establish_evals"]).observability;
    } else if (result.status === "succeeded" && state.activeIntent.kind === "instrument_observability") {
      const profile = config.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
      if (profile) {
        const output = result.outputs as IntentOutputMap["instrument_observability"];
        const requiredMetricIds = profile.objectives.filter((item) => item.required).map((item) => item.metricId);
        observability = {
          targetId: profile.applicationTarget.id,
          status: "ready",
          requiredMetricIds,
          coveredMetricIds: output.coveredMetricIds,
          missingMetricIds: output.missingMetricIds,
          checkedAt: result.completedAt,
        };
      }
    }
    const nextState: OpenMeritProjectState = {
      ...state,
      cycle: {
        ...state.cycle,
        stage: interpretation.nextStage,
        ...interpretation.cyclePatch,
      },
      activeIntent: undefined,
      lastResult: result,
      ...(observability ? { observability } : {}),
      automation: {
        ...state.automation,
        ...(result.status === "succeeded" && ["establish_evals", "instrument_observability"].includes(state.activeIntent.kind) &&
          interpretation.nextStage === "collecting_baseline"
          ? {
              baselineStartedAt: now,
              lastAssessmentAt: undefined,
              lastAssessmentTaskCount: state.automation.observedCompletedTasks,
              baselineMetricWindows: [],
            }
          : {}),
        ...(evaluationSpend !== undefined ? { evaluationSpend } : {}),
        ...(state.activeIntent.kind === "run_assessment"
          ? { lastAssessmentTaskCount: state.automation.observedCompletedTasks, lastAssessmentAt: now }
          : {}),
        ...(state.activeIntent.kind === "calculate_frontier"
          ? { lastReassessmentTaskCount: state.automation.observedCompletedTasks, lastReassessmentAt: now }
          : {}),
        ...(state.activeIntent.kind === "investigate_regression"
          ? { lastRegressionCheckTaskCount: state.automation.observedCompletedTasks, lastRegressionCheckAt: now }
          : {}),
        ...(state.activeIntent.kind === "apply_model_swap"
          ? { swapAppliedTaskCount: state.automation.observedCompletedTasks, swapAppliedAt: now }
          : {}),
        ...(state.activeIntent.kind === "verify_model_swap" ? { lastVerificationAt: now } : {}),
      },
      updatedAt: now,
    };
    await this.store.writeState(nextState);
    if (result.evidence.length && nextState.cycle.taskProfileId) {
      await this.store.writeEvidenceManifest({
        schemaVersion: 1,
        id: `manifest-${result.intentId}`,
        createdAt: now,
        taskProfileId: nextState.cycle.taskProfileId,
        references: result.evidence,
      });
    }
    await this.store.appendEvent({
      schemaVersion: 1,
      id: `event-${crypto.randomUUID()}`,
      type: "intent_completed",
      occurredAt: now,
      cycleId: nextState.cycle.id,
      intentId: result.intentId,
      data: {
        kind: state.activeIntent.kind,
        status: result.status,
        nextStage: interpretation.nextStage,
        harnessId: this.adapter.descriptor.id,
        summary: result.summary,
        evidence: result.evidence.map((item) => ({ id: item.id, source: item.source })),
      },
    });
    if (observability && (state.activeIntent.kind === "establish_evals" || state.activeIntent.kind === "instrument_observability")) {
      await this.store.appendEvent({
        schemaVersion: 1,
        id: `event-${crypto.randomUUID()}`,
        type: "observability_readiness_checked",
        occurredAt: now,
        cycleId: nextState.cycle.id,
        intentId: result.intentId,
        data: {
          targetId: observability.targetId,
          status: observability.status,
          requiredMetricIds: observability.requiredMetricIds,
          coveredMetricIds: observability.coveredMetricIds,
          missingMetricIds: observability.missingMetricIds,
        },
      });
    }
    const automation = await this.reconcileAutomation(now);
    return { intentKind: state.activeIntent.kind, state: nextState, interpretation, automation };
  }

  async recordLifecycle(update: IntentLifecycleUpdate): Promise<void> {
    const state = await this.store.readState();
    if (!state?.activeIntent || state.activeIntent.id !== update.intentId) {
      throw new Error(`Lifecycle update ${update.intentId} does not match the active intent.`);
    }
    await this.store.appendEvent({
      schemaVersion: 1,
      id: `event-${crypto.randomUUID()}`,
      type: "intent_progressed",
      occurredAt: update.occurredAt,
      cycleId: state.cycle.id,
      intentId: update.intentId,
      data: {
        status: update.status,
        ...(update.message ? { message: update.message } : {}),
        ...(update.progress ? { progress: update.progress } : {}),
        ...(update.details ? { details: update.details } : {}),
      },
    });
  }

  async recordTaskObservation(
    details: Readonly<Record<string, JsonValue>> = {},
  ): Promise<ObservationResult> {
    const now = new Date().toISOString();
    const state = await this.store.readState();
    if (!state?.cycle.targetId) throw new Error("A confirmed application LLM target is required.");
    const result = await this.recordAutomationSignal({
      protocolVersion: PROTOCOL_VERSION,
      id: `legacy-task-${crypto.randomUUID()}`,
      type: "product_task_completed",
      occurredAt: now,
      targetId: state.cycle.targetId,
      modelId: typeof details.modelId === "string" ? details.modelId : "unknown",
    });
    return {
      state: result.state,
      assessmentDue: result.state.automation.lastAssessmentAt === now,
    };
  }

  async assessBaseline(now = new Date().toISOString()): Promise<{
    readonly state: OpenMeritProjectState;
    readonly errors: readonly string[];
    readonly decision: OrchestrationDecision;
  }> {
    const state = await this.store.readState();
    if (!state || state.cycle.stage !== "collecting_baseline" || state.activeIntent) {
      throw new Error("Baseline assessment requires an idle collecting-baseline cycle.");
    }
    const config = await this.store.readConfig();
    const profile = config?.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
    const errors = baselineAssessmentErrors(state, profile, state.automation.baselineMetricWindows ?? []);
    const sufficient = errors.length === 0;
    const decision: OrchestrationDecision = sufficient
      ? { action: "issue_intent", intentKind: "discover_candidates", reason: "Required baseline metric windows meet the confirmed sample thresholds; discover candidates." }
      : { action: "observe", reason: `Baseline evidence remains insufficient: ${errors.join("; ")}.` };
    const nextState: OpenMeritProjectState = {
      ...state,
      cycle: { ...state.cycle, baselineEvidenceSufficient: sufficient, stage: sufficient ? "baseline_ready" : "collecting_baseline" },
      automation: {
        ...state.automation,
        lastAssessmentAt: now,
        lastAssessmentTaskCount: state.automation.observedCompletedTasks,
        pendingIntentKind: decision.action === "issue_intent" ? decision.intentKind : undefined,
        pendingIntentReason: decision.action === "issue_intent" ? decision.reason : undefined,
      },
      updatedAt: now,
    };
    await this.store.writeState(nextState);
    await this.store.appendEvent({
      schemaVersion: 1, id: `event-${crypto.randomUUID()}`, type: "baseline_sufficiency_checked",
      occurredAt: now, cycleId: state.cycle.id,
      data: { sufficient, errors, metricIds: (state.automation.baselineMetricWindows ?? []).map((metric) => metric.metricId), source: "manual" },
    });
    return { state: nextState, errors, decision };
  }

  async recordAutomationSignal(signal: AutomationSignal): Promise<AutomationSignalResult> {
    const state = await this.store.readState();
    if (!state) throw new Error("OpenMerit project is not initialized.");
    if (signal.protocolVersion !== PROTOCOL_VERSION) throw new Error("Automation signal protocol version does not match.");
    if (!signal.id.trim()) throw new Error("Automation signal ID is required.");
    if (!state.cycle.targetId || signal.targetId !== state.cycle.targetId) {
      throw new Error("Automation signal target does not match the confirmed application LLM target.");
    }
    if (signal.type === "metric_window_available" || signal.type === "verification_window_completed") {
      const mismatched = (signal.metrics ?? []).find((metric) => metric.targetId !== state.cycle.targetId);
      if (mismatched) throw new Error(`Metric ${mismatched.metricId} target does not match the confirmed application LLM target.`);
    }
    const processed = state.automation.processedSignalIds ?? [];
    if (processed.includes(signal.id)) {
      await this.store.appendEvent({
        schemaVersion: 1,
        id: `event-${crypto.randomUUID()}`,
        type: "automation_signal_duplicate",
        occurredAt: signal.occurredAt,
        cycleId: state.cycle.id,
        data: { signalId: signal.id, signalType: signal.type },
      });
      return { state, duplicate: true, decision: dueDecision(state, signal, signal.occurredAt) };
    }

    const completedTasks = state.automation.observedCompletedTasks +
      (signal.type === "product_task_completed" ? 1 : 0);
    const baselineMetricWindows = state.cycle.stage === "collecting_baseline"
      ? updatedBaselineWindows(state.automation.baselineMetricWindows, signal)
      : state.automation.baselineMetricWindows ?? [];
    const decisionState: OpenMeritProjectState = {
      ...state,
      automation: { ...state.automation, observedCompletedTasks: completedTasks, baselineMetricWindows },
    };
    const due = dueDecision(decisionState, signal, signal.occurredAt);
    const baselineCheckDue = due.action === "issue_intent" && due.intentKind === "run_assessment";
    const config = baselineCheckDue ? await this.store.readConfig() : undefined;
    const profile = config?.taskProfiles.find((item) => item.id === config.activeTaskProfileId);
    const baselineErrors = baselineCheckDue ? baselineAssessmentErrors(state, profile, baselineMetricWindows) : [];
    const baselineReady = baselineCheckDue && baselineErrors.length === 0;
    const decision: OrchestrationDecision = baselineCheckDue
      ? baselineReady
        ? { action: "issue_intent", intentKind: "discover_candidates", reason: "Required baseline metric windows meet the confirmed sample thresholds; discover candidates." }
        : { action: "observe", reason: `Baseline evidence remains insufficient: ${baselineErrors.join("; ")}.` }
      : due;
    const latestMetricValues = { ...(state.automation.latestMetricValues ?? {}) };
    if (signal.type === "product_task_completed" && signal.telemetry) {
      latestMetricValues.input_token_consumption = signal.telemetry.inputTokens;
      latestMetricValues.output_token_consumption = signal.telemetry.outputTokens;
      latestMetricValues.total_task_cost = signal.telemetry.cost;
      latestMetricValues.end_to_end_task_latency = signal.telemetry.durationMs;
    }
    if (signal.type === "metric_window_available" || signal.type === "verification_window_completed") {
      for (const metric of signal.metrics ?? []) {
        if (metric.state === "measured" && metric.value !== undefined) latestMetricValues[metric.metricId] = metric.value;
      }
    }
    const nextState: OpenMeritProjectState = {
      ...decisionState,
      cycle: baselineCheckDue
        ? { ...decisionState.cycle, baselineEvidenceSufficient: baselineReady, stage: baselineReady ? "baseline_ready" : "collecting_baseline" }
        : decisionState.cycle,
      automation: {
        ...decisionState.automation,
        processedSignalIds: [...processed, signal.id].slice(-MAX_PROCESSED_SIGNAL_IDS),
        latestMetricValues,
        ...(baselineCheckDue ? {
          lastAssessmentAt: signal.occurredAt,
          lastAssessmentTaskCount: completedTasks,
          pendingIntentKind: decision.action === "issue_intent" ? decision.intentKind : undefined,
          pendingIntentReason: decision.action === "issue_intent" ? decision.reason : undefined,
        } : {}),
        ...(signal.type === "model_catalog_changed" ? {
          modelCatalogFingerprint: signal.fingerprint,
          ...(state.automation.modelCatalogFingerprint && state.automation.modelCatalogFingerprint !== signal.fingerprint
            ? { modelCatalogChangedAt: signal.occurredAt }
            : {}),
        } : {}),
        ...(decision.action === "issue_intent" ? {
          pendingIntentKind: decision.intentKind,
          pendingIntentReason: decision.reason,
        } : {}),
      },
      updatedAt: signal.occurredAt,
    };
    await this.store.writeState(nextState);
    await this.store.appendEvent({
      schemaVersion: 1,
      id: `event-${crypto.randomUUID()}`,
      type: "automation_signal_recorded",
      occurredAt: signal.occurredAt,
      cycleId: state.cycle.id,
      data: {
        signalId: signal.id,
        signalType: signal.type,
        decision: decision.action,
        decisionReason: decision.reason,
        ...auditSignalData(signal),
      },
    });
    if (baselineCheckDue) {
      await this.store.appendEvent({
        schemaVersion: 1,
        id: `event-${crypto.randomUUID()}`,
        type: "baseline_sufficiency_checked",
        occurredAt: signal.occurredAt,
        cycleId: state.cycle.id,
        data: {
          sufficient: baselineReady,
          errors: baselineErrors,
          metricIds: baselineMetricWindows.map((metric) => metric.metricId),
          sourceSignalId: signal.id,
        },
      });
    }
    if (decision.action === "issue_intent") {
      await this.store.appendEvent({
        schemaVersion: 1,
        id: `event-${crypto.randomUUID()}`,
        type: "automation_check_due",
        occurredAt: signal.occurredAt,
        cycleId: state.cycle.id,
        data: { signalId: signal.id, intentKind: decision.intentKind, reason: decision.reason },
      });
    }
    return { state: nextState, duplicate: false, decision };
  }

  async recordModelCatalogFingerprint(fingerprint: string): Promise<CatalogChangeResult> {
    const state = await this.store.readState();
    if (!state) throw new Error("OpenMerit project is not initialized.");
    if (!state.cycle.targetId) throw new Error("A confirmed application LLM target is required.");
    const previousFingerprint = state.automation.modelCatalogFingerprint;
    const changed = previousFingerprint !== undefined && previousFingerprint !== fingerprint;
    if (previousFingerprint === fingerprint) {
      return { state, changed: false, reassessmentDue: false };
    }
    const now = new Date().toISOString();
    const result = await this.recordAutomationSignal({
      protocolVersion: PROTOCOL_VERSION,
      id: `legacy-catalog-${crypto.randomUUID()}`,
      type: "model_catalog_changed",
      occurredAt: now,
      targetId: state.cycle.targetId,
      fingerprint,
    });
    return {
      state: result.state,
      changed,
      reassessmentDue: result.decision.action === "issue_intent" && result.decision.intentKind === "discover_candidates",
    };
  }
}
