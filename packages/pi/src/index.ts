import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  nextImprovementAction,
  OpenMeritCoordinator,
  ProjectStore,
  type HarnessAdapter,
} from "@openmerit-v2/core";
import {
  completionToolSchemaFor,
  OPENMERIT_SCHEMA_DIALECT,
  PROTOCOL_VERSION,
  type AnyIntentResult,
  type AutomationSignal,
  type EvidenceReference,
  type HarnessDescriptor,
  type IntentKind,
  type IntentResult,
  type ImprovementStage,
  type MetricRecord,
  MetricRecordSchema,
  type OpenMeritIntent,
} from "@openmerit-v2/protocol";
import { Type } from "typebox";

const INTENT_ENTRY_TYPE = "openmerit-v2.intent";
const RESULT_ENTRY_TYPE = "openmerit-v2.result";
const INTENT_MESSAGE_TYPE = "openmerit-v2.intent-context";

export const PI_HARNESS_DESCRIPTOR: HarnessDescriptor = {
  id: "pi",
  name: "Pi coding agent",
  version: "0.87",
  protocolVersions: [PROTOCOL_VERSION],
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
  executionModes: ["interactive", "non_interactive"],
  structuredOutput: {
    schemaDialect: OPENMERIT_SCHEMA_DIALECT,
    presentation: "dynamic_tool",
    enforcement: "harness",
  },
  automation: {
    supportedSignals: [
      "product_task_completed", "metric_window_available", "scheduled_tick",
      "model_catalog_changed", "verification_window_completed",
    ],
    persistentScheduling: false,
    backgroundExecution: false,
    wakeupProvisioning: "none",
  },
};

export interface OpenMeritUiState {
  proactiveNudgesPaused: boolean;
  taskProfile: "not_configured" | "pending" | "configured";
  metricReadiness: "not_assessed" | "pending" | "assessed";
  evaluationReadiness: "not_assessed" | "pending" | "assessed";
  activeIntent: string | null;
  nextAssessment: string | null;
  lifecycleStage: ImprovementStage | "not_initialized";
}

export function createInitialUiState(): OpenMeritUiState {
  return {
    proactiveNudgesPaused: false,
    taskProfile: "not_configured",
    metricReadiness: "not_assessed",
    evaluationReadiness: "not_assessed",
    activeIntent: null,
    nextAssessment: null,
    lifecycleStage: "not_initialized",
  };
}

export function renderStatus(state: OpenMeritUiState): string {
  return [
    "OpenMerit evidence readiness",
    `task profile       : ${state.taskProfile.replaceAll("_", " ")}`,
    `metric readiness   : ${state.metricReadiness.replaceAll("_", " ")}`,
    `evaluation status  : ${state.evaluationReadiness.replaceAll("_", " ")}`,
    `active work        : ${state.activeIntent ?? "none"}`,
    `next assessment    : ${state.nextAssessment ?? "not scheduled"}`,
    `frontier lifecycle : ${state.lifecycleStage.replaceAll("_", " ")}`,
    `proactive nudges   : ${state.proactiveNudgesPaused ? "paused" : "enabled"}`,
  ].join("\n");
}

interface StoredIntentEntry {
  intent: OpenMeritIntent;
}

interface StoredResultEntry {
  result: IntentResult;
}

interface CompletionInput {
  intentId: string;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  evidence: EvidenceReference[];
  outputs?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

interface ObservationSignalInput {
  signalId: string;
  type: "metric_window_available" | "verification_window_completed";
  occurredAt?: string;
  metrics: MetricRecord[];
}

function modelCatalogFingerprint(ctx: ExtensionContext): string {
  const catalogue = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  })).sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
  return createHash("sha256").update(JSON.stringify(catalogue)).digest("hex");
}

function privateIntentMessage(intent: OpenMeritIntent): string {
  return [
    "OpenMerit has issued the typed intent below.",
    "Perform the intelligent work using the current project, session context, and available tools.",
    "Use harness-configured fast decision resources such as Jev System One aggressively for bounded ranking, triage, and judgment when available; OpenMerit does not call those services itself.",
    "You, the coding harness, own all research, evaluation design, instrumentation, measurement, Pareto calculation, and authorized configuration work. OpenMerit only validates the returned contract and evidence.",
    intent.constraints.modelMutationAllowed
      ? "This intent authorizes only the model mutation described by the active OpenMerit cycle."
      : "Do not change Pi's model or application model configuration.",
    "Before finishing, call openmerit_complete_intent exactly once with the result and durable evidence references.",
    JSON.stringify(intent),
  ].join("\n\n");
}

function piHarnessAdapter(pi: ExtensionAPI): HarnessAdapter {
  return {
    descriptor: PI_HARNESS_DESCRIPTOR,
    async dispatch(intent) {
      pi.appendEntry(INTENT_ENTRY_TYPE, { intent } satisfies StoredIntentEntry);
      pi.sendMessage(
        {
          customType: INTENT_MESSAGE_TYPE,
          content: privateIntentMessage(intent),
          display: false,
          details: { intentId: intent.id, kind: intent.kind },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return { accepted: true, harnessJobId: intent.id };
    },
  };
}

function restoreState(ctx: ExtensionContext, state: OpenMeritUiState): void {
  state.activeIntent = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === INTENT_ENTRY_TYPE) {
      const stored = entry.data as StoredIntentEntry | undefined;
      if (stored?.intent?.id) state.activeIntent = stored.intent.id;
    }
    if (entry.customType === RESULT_ENTRY_TYPE) {
      const stored = entry.data as StoredResultEntry | undefined;
      if (stored?.result?.intentId === state.activeIntent) state.activeIntent = null;
    }
  }
}

async function dispatchIntent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: OpenMeritUiState,
  store: ProjectStore,
  kind: IntentKind,
  prepareCompletionTool: (kind: IntentKind) => void,
): Promise<void> {
  if (state.activeIntent) {
    ctx.ui.notify(`openmerit: work is already active (${state.activeIntent})`, "warning");
    return;
  }

  prepareCompletionTool(kind);
  const issued = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).issue(kind);
  const { intent } = issued;
  state.activeIntent = intent.id;
  if (kind === "establish_evals") {
    state.taskProfile = "pending";
    state.metricReadiness = "pending";
    state.evaluationReadiness = "pending";
  } else {
    state.metricReadiness = "pending";
  }

  state.lifecycleStage = issued.state.cycle.stage;
  const label = kind === "establish_evals" ? "setup" : kind.replaceAll("_", " ");
  ctx.ui.notify(`openmerit: ${label} started (${intent.id})`, "info");
}

async function reportAutomationSignal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: OpenMeritUiState,
  store: ProjectStore,
  signal: AutomationSignal,
  prepareCompletionTool: (kind: IntentKind) => void,
): Promise<void> {
  const result = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).recordAutomationSignal(signal);
  if (result.decision.action === "issue_intent" && !state.activeIntent) {
    await dispatchIntent(pi, ctx, state, store, result.decision.intentKind, prepareCompletionTool);
  }
}

export default function openMeritExtension(pi: ExtensionAPI): void {
  const state = createInitialUiState();
  let store: ProjectStore | undefined;
  let suppressNextSettledObservation = false;

  const registerCompletionTool = (kind?: IntentKind): void => {
    const parameters = kind
      ? completionToolSchemaFor(kind)
      : Type.Object({
          intentId: Type.String(),
          status: StringEnum(["failed", "cancelled"] as const),
          summary: Type.String(),
          evidence: Type.Array(Type.Object({
            id: Type.String(),
            source: StringEnum([
              "harness_trace", "evaluation_artifact", "observability_record", "external_source", "user_feedback",
            ] as const),
            uri: Type.String(),
            mediaType: Type.Optional(Type.String()),
            digest: Type.Optional(Type.String()),
          })),
          errorCode: Type.Optional(Type.String()),
          errorMessage: Type.Optional(Type.String()),
          retryable: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false });

    pi.registerTool({
      name: "openmerit_complete_intent",
      label: "Complete OpenMerit Intent",
      description: kind
        ? `Complete the active ${kind} OpenMerit intent with its required structured output and durable evidence references.`
        : "Complete the active OpenMerit intent. A successful result is available only after an intent-specific schema is activated.",
      promptSnippet: "Complete the active OpenMerit intent with structured evidence",
      promptGuidelines: [
        "Call openmerit_complete_intent exactly once after completing OpenMerit-requested work.",
        "Never use openmerit_complete_intent to claim success without verified evidence references.",
        "A succeeded result must include intent-specific outputs and at least one evidence reference; failed or cancelled results may omit outputs and use an empty evidence list.",
      ],
      parameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, input: CompletionInput, _signal, _onUpdate, ctx) {
        if (!state.activeIntent) throw new Error("No OpenMerit intent is active.");
        if (input.intentId !== state.activeIntent) {
          throw new Error(`Intent ${input.intentId} is not active.`);
        }
        if (input.status === "succeeded" && input.evidence.length === 0) {
          throw new Error("A successful OpenMerit intent requires at least one evidence reference.");
        }

        store ??= new ProjectStore(ctx.cwd);
        const outputs = input.outputs ?? {};

        const result = {
          protocolVersion: PROTOCOL_VERSION,
          intentId: input.intentId,
          status: input.status,
          completedAt: new Date().toISOString(),
          summary: input.summary,
          evidence: input.evidence,
          outputs,
          ...(input.status === "failed"
            ? {
                error: {
                  code: input.errorCode ?? "harness_work_failed",
                  message: input.errorMessage ?? input.summary,
                  retryable: input.retryable ?? false,
                },
              }
            : {}),
        } as unknown as AnyIntentResult;

        const accepted = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).acceptResult(result);
        pi.appendEntry(RESULT_ENTRY_TYPE, { result } satisfies StoredResultEntry);
        suppressNextSettledObservation = true;
        const { intentKind, state: nextState } = accepted;
        const stage = nextState.cycle.stage;
        state.activeIntent = null;
        state.lifecycleStage = stage;
        registerCompletionTool();
        state.nextAssessment = accepted.automation.plan.nextWakeupAt ??
          (accepted.automation.plan.scheduling === "external_scheduler_required" ? "external scheduler required" : "signal driven");
        if (accepted.automation.plan.gaps.length) {
          ctx.ui.notify(`openmerit automation: ${accepted.automation.plan.gaps.join(" ")}`, "warning");
        }
        if (input.status === "succeeded" && intentKind === "establish_evals") {
          state.taskProfile = "configured";
          state.metricReadiness = "assessed";
          state.evaluationReadiness = "assessed";
        }

        if (input.status === "succeeded" && !state.proactiveNudgesPaused) {
          const decision = nextImprovementAction(nextState.cycle);
          if (decision.action === "issue_intent") {
            await dispatchIntent(pi, ctx, state, store, decision.intentKind, registerCompletionTool);
          } else if (decision.action === "await_user") {
            ctx.ui.notify(`openmerit: ${decision.reason}`, "warning");
          }
        }

        return {
          content: [{ type: "text", text: `Recorded OpenMerit intent ${input.intentId} as ${input.status}.` }],
          details: { result },
        };
      },
    });
  };

  registerCompletionTool();

  pi.registerTool({
    name: "openmerit_report_signal",
    label: "Report OpenMerit Signal",
    description: "Report a verified observability metric window or completed post-swap verification window to OpenMerit.",
    promptSnippet: "Report verified OpenMerit observability signals",
    promptGuidelines: [
      "Use stable signalId values so retried deliveries remain idempotent.",
      "Report only measured metrics backed by the referenced observability or evaluation artifacts.",
    ],
    parameters: Type.Object({
      signalId: Type.String({ minLength: 1 }),
      type: StringEnum(["metric_window_available", "verification_window_completed"] as const),
      occurredAt: Type.Optional(Type.String({ minLength: 1 })),
      metrics: Type.Array(MetricRecordSchema),
    }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, input: ObservationSignalInput, _signal, _onUpdate, ctx) {
      store ??= new ProjectStore(ctx.cwd);
      await reportAutomationSignal(pi, ctx, state, store, {
        protocolVersion: PROTOCOL_VERSION,
        id: input.signalId,
        type: input.type,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        metrics: input.metrics,
      }, registerCompletionTool);
      return {
        content: [{ type: "text", text: `Recorded OpenMerit automation signal ${input.signalId}.` }],
        details: { signalId: input.signalId, type: input.type },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    store = new ProjectStore(ctx.cwd);
    let projectState = await store.readState();
    if (projectState) {
      state.lifecycleStage = projectState.cycle.stage;
      state.activeIntent = projectState.activeIntent?.id ?? null;
      if (projectState.activeIntent) registerCompletionTool(projectState.activeIntent.kind);
      state.taskProfile = projectState.cycle.taskProfileId ? "configured" : "not_configured";
      const automation = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).reconcileAutomation();
      state.nextAssessment = automation.plan.nextWakeupAt ??
        (automation.plan.scheduling === "external_scheduler_required" ? "external scheduler required" : "signal driven");
      if (automation.plan.gaps.length) {
        ctx.ui.notify(`openmerit automation: ${automation.plan.gaps.join(" ")}`, "warning");
      }
      const fingerprint = modelCatalogFingerprint(ctx);
      await reportAutomationSignal(pi, ctx, state, store, {
        protocolVersion: PROTOCOL_VERSION,
        id: `signal-${crypto.randomUUID()}`,
        type: "model_catalog_changed",
        occurredAt: new Date().toISOString(),
        fingerprint,
      }, registerCompletionTool);
      if (!state.activeIntent) {
        await reportAutomationSignal(pi, ctx, state, store, {
          protocolVersion: PROTOCOL_VERSION,
          id: `signal-${crypto.randomUUID()}`,
          type: "scheduled_tick",
          occurredAt: new Date().toISOString(),
        }, registerCompletionTool);
      }
    } else if (ctx.hasUI && !state.proactiveNudgesPaused) {
      ctx.ui.notify("openmerit: no frontier profile found; asking Pi to establish evals and observability", "info");
      await dispatchIntent(pi, ctx, state, store, "establish_evals", registerCompletionTool);
    }
    restoreState(ctx, state);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (suppressNextSettledObservation) {
      suppressNextSettledObservation = false;
      return;
    }
    store ??= new ProjectStore(ctx.cwd);
    const current = await store.readState();
    if (!current || current.activeIntent) return;
    await reportAutomationSignal(pi, ctx, state, store, {
      protocolVersion: PROTOCOL_VERSION,
      id: `signal-${crypto.randomUUID()}`,
      type: "product_task_completed",
      occurredAt: new Date().toISOString(),
      modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      contextTokens: ctx.getContextUsage()?.tokens ?? null,
    }, registerCompletionTool);
  });

  pi.registerCommand("openmerit", {
    description: "OpenMerit: status, setup, assess, frontier, approve, pause/resume, doctor",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";

      switch (subcommand) {
        case "status":
          ctx.ui.notify(renderStatus(state), "info");
          return;
        case "setup":
          store ??= new ProjectStore(ctx.cwd);
          await dispatchIntent(pi, ctx, state, store, "establish_evals", registerCompletionTool);
          return;
        case "assess":
          store ??= new ProjectStore(ctx.cwd);
          await dispatchIntent(pi, ctx, state, store, "run_assessment", registerCompletionTool);
          return;
        case "frontier":
          store ??= new ProjectStore(ctx.cwd);
          await dispatchIntent(pi, ctx, state, store, "calculate_frontier", registerCompletionTool);
          return;
        case "approve": {
          store ??= new ProjectStore(ctx.cwd);
          const projectState = await store.readState();
          if (!projectState?.cycle.proposedCandidateId || projectState.cycle.stage !== "frontier_ready") {
            ctx.ui.notify("openmerit: there is no verified model proposal awaiting approval", "warning");
            return;
          }
          const now = new Date().toISOString();
          await store.writeState({
            ...projectState,
            cycle: { ...projectState.cycle, stage: "swap_approved" },
            updatedAt: now,
          });
          await store.appendEvent({
            schemaVersion: 1,
            id: `event-${crypto.randomUUID()}`,
            type: "cycle_advanced",
            occurredAt: now,
            cycleId: projectState.cycle.id,
            data: { stage: "swap_approved", candidateId: projectState.cycle.proposedCandidateId },
          });
          state.lifecycleStage = "swap_approved";
          await dispatchIntent(pi, ctx, state, store, "apply_model_swap", registerCompletionTool);
          return;
        }
        case "pause":
          state.proactiveNudgesPaused = true;
          ctx.ui.notify("openmerit: proactive nudges paused", "info");
          return;
        case "resume":
          state.proactiveNudgesPaused = false;
          ctx.ui.notify("openmerit: proactive nudges resumed", "info");
          return;
        case "doctor":
          ctx.ui.notify(
            [
              "OpenMerit doctor",
              "Pi adapter        : loaded",
              "intent executor   : connected",
              "model mutation    : disabled",
              "persistent schedule: unavailable (active-session ticks only)",
              `interactive UI     : ${ctx.hasUI ? "available" : "unavailable"}`,
            ].join("\n"),
            "info",
          );
          return;
        default:
          ctx.ui.notify(
            "openmerit: usage: /openmerit [status|setup|assess|frontier|approve|pause|resume|doctor]",
            "warning",
          );
      }
    },
  });
}
