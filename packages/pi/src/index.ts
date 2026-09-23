import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { StringEnum, type ImageContent } from "@earendil-works/pi-ai";
import {
  nextImprovementAction,
  OpenMeritCoordinator,
  ProjectStore,
  type HarnessAdapter,
} from "../../core/src/index.ts";
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
  type JsonValue,
  type MetricRecord,
  MetricRecordSchema,
  type OpenMeritIntent,
} from "../../protocol/src/index.ts";
import { Type } from "typebox";

const INTENT_ENTRY_TYPE = "openmerit.intent";
const RESULT_ENTRY_TYPE = "openmerit.result";
const INTENT_MESSAGE_TYPE = "openmerit.intent-context";

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
  applicationTarget: "not_detected" | "detected" | "confirmed";
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
    applicationTarget: "not_detected",
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
    `application target : ${state.applicationTarget.replaceAll("_", " ")}`,
    `task profile       : ${state.taskProfile.replaceAll("_", " ")}`,
    `metric readiness   : ${state.metricReadiness.replaceAll("_", " ")}`,
    `evaluation status  : ${state.evaluationReadiness.replaceAll("_", " ")}`,
    `active work        : ${state.activeIntent ?? "none"}`,
    `next assessment    : ${state.nextAssessment ?? "not scheduled"}`,
    `frontier lifecycle : ${state.lifecycleStage.replaceAll("_", " ")}`,
    `proactive nudges   : ${state.proactiveNudgesPaused ? "paused" : "enabled"}`,
  ].join("\n");
}

export interface DetectedApplicationLlmTarget {
  readonly id: string;
  readonly kind: "application_llm_call";
  readonly name: string;
  readonly applicationId: string;
  readonly callSites: readonly string[];
  readonly routeKey: string;
}

const DETECTION_IGNORES = new Set([
  ".git", ".openmerit", "node_modules", "dist", "build", "coverage", ".next", "vendor", "tests", "test", "__tests__",
]);
const DETECTION_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt"]);
const APPLICATION_CALL_PATTERNS = [
  { provider: "openai-compatible", pattern: /\b(?:chat\.completions|responses)\.create\s*\(/ },
  { provider: "anthropic", pattern: /\bmessages\.create\s*\(/ },
  { provider: "google", pattern: /\bgenerateContent(?:Stream)?\s*\(/ },
  { provider: "vercel-ai", pattern: /\b(?:generateText|streamText|generateObject|streamObject)\s*\(/ },
  { provider: "langchain", pattern: /\b(?:ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI)\s*\(/ },
  { provider: "openrouter", pattern: /openrouter\.ai\/api\/v1\/(?:chat\/completions|responses)/ },
] as const;

function extensionOf(path: string): string {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

/** Bounded, adapter-local detection. It requires an actual application call pattern, not only an SDK dependency. */
export function detectApplicationLlmTargets(projectRoot: string): readonly DetectedApplicationLlmTarget[] {
  const files: string[] = [];
  const pending = [projectRoot];
  while (pending.length && files.length < 500) {
    const directory = pending.shift()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(directory, { withFileTypes: true }) as never;
    } catch {
      continue;
    }
    for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
      if (DETECTION_IGNORES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && DETECTION_EXTENSIONS.has(extensionOf(path))) files.push(path);
      if (files.length >= 500) break;
    }
  }

  const applicationId = basename(projectRoot);
  const targets: DetectedApplicationLlmTarget[] = [];
  for (const path of files) {
    let source: string;
    try {
      if (statSync(path).size > 1_000_000) continue;
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const { provider, pattern } of APPLICATION_CALL_PATTERNS) {
      const match = pattern.exec(source);
      if (!match) continue;
      const projectPath = relative(projectRoot, path).replaceAll("\\", "/");
      const line = source.slice(0, match.index).split("\n").length;
      const identity = `${applicationId}:${projectPath}:${provider}`;
      targets.push({
        id: `app-llm-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`,
        kind: "application_llm_call",
        name: `${provider} application call in ${projectPath}`,
        applicationId,
        callSites: [`${projectPath}:${line}`],
        routeKey: `${projectPath}#${provider}`,
      });
    }
  }
  return targets;
}

function detectedTargetsConstraint(targets: readonly DetectedApplicationLlmTarget[]): JsonValue {
  return targets.map((target) => ({
    id: target.id,
    kind: target.kind,
    name: target.name,
    applicationId: target.applicationId,
    callSites: [...target.callSites],
    routeKey: target.routeKey,
  }));
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
  type: "product_task_completed" | "metric_window_available" | "verification_window_completed";
  occurredAt?: string;
  targetId: string;
  metrics?: MetricRecord[];
  modelId?: string;
  evidence?: EvidenceReference[];
  telemetry?: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    currency: "USD";
  };
}

function validateReportedMetrics(metrics: readonly MetricRecord[], targetId: string): void {
  for (const metric of metrics) {
    if (metric.targetId !== targetId) {
      throw new Error(`${metric.metricId} target does not match the reported application LLM target.`);
    }
    if (metric.state === "measured" && (!metric.evidence.length || metric.value === undefined)) {
      throw new Error(`Measured metric ${metric.metricId} requires a numeric value and evidence.`);
    }
    if (metric.metricId === "tool_use_performance" && metric.state === "measured" &&
        !metric.evidence.some((item) => item.source === "harness_trace")) {
      throw new Error("tool_use_performance requires harness-trace evidence; test coverage is not tool-use evidence.");
    }
  }
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
    "The system under test is the user-confirmed application LLM target. Pi's own model, tokens, cost, latency, and session are orchestration data and must never be submitted as application evidence.",
    intent.targetId
      ? `Every result and metric must reference application target ${intent.targetId}.`
      : "Before setup succeeds, identify an actual application LLM call or shared application route and ask the user to confirm its stable target ID, call sites, and route key.",
    "Instrument every required metric selected by the user. Report explicit covered and missing metric IDs; never describe observability as ready while a required metric is missing.",
    "Capture cost, token use, and task latency from the application LLM provider or application observability. Do not substitute Pi provider telemetry or zero for unavailable application telemetry.",
    "Tool-use performance must be derived from tool-call traces and outcomes; code coverage is not tool-use evidence.",
    intent.constraints.modelMutationAllowed
      ? `This intent authorizes only the application model mutation for target ${intent.targetId ?? "(missing target)"}. Never change Pi's model.`
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

async function dispatchIntent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: OpenMeritUiState,
  store: ProjectStore,
  kind: IntentKind,
  prepareCompletionTool: (kind: IntentKind) => void,
  additionalConstraints?: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  if (state.activeIntent) {
    ctx.ui.notify(`openmerit: work is already active (${state.activeIntent})`, "warning");
    return;
  }

  prepareCompletionTool(kind);
  const issued = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).issue(kind, { additionalConstraints });
  const { intent } = issued;
  state.activeIntent = intent.id;
  if (kind === "establish_evals") {
    state.applicationTarget = "detected";
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
  const queuedUserInputs: Array<{ text: string; images?: ImageContent[] }> = [];

  const releaseQueuedUserInput = (): void => {
    if (state.activeIntent || !queuedUserInputs.length) return;
    const queued = queuedUserInputs.splice(0);
    const text = queued.map((item) => item.text).join("\n\n");
    const images = queued.flatMap((item) => item.images ?? []);
    pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { deliverAs: "followUp" });
  };

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
          state.applicationTarget = "confirmed";
          state.taskProfile = "configured";
          state.metricReadiness = nextState.observability?.status === "ready" ? "assessed" : "pending";
          state.evaluationReadiness = "assessed";
        } else if (input.status === "succeeded" && intentKind === "instrument_observability") {
          state.metricReadiness = nextState.observability?.status === "ready" ? "assessed" : "pending";
        }

        if (input.status === "succeeded" && !state.proactiveNudgesPaused) {
          const decision = nextImprovementAction(nextState.cycle);
          if (decision.action === "issue_intent") {
            await dispatchIntent(pi, ctx, state, store, decision.intentKind, registerCompletionTool);
          } else if (decision.action === "await_user") {
            ctx.ui.notify(`openmerit: ${decision.reason}`, "warning");
          }
        }
        // A successful result can immediately issue another OpenMerit intent
        // (for example, setup -> instrumentation). Release product work only
        // after that chain has no active follow-up.
        releaseQueuedUserInput();

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
    description: "Report a verified application LLM task, observability metric window, or completed post-swap verification window to OpenMerit.",
    promptSnippet: "Report verified application-target OpenMerit signals",
    promptGuidelines: [
      "Use stable signalId values so retried deliveries remain idempotent.",
      "Every signal and metric must reference the confirmed application LLM target.",
      "Report only application-provider telemetry and measured metrics backed by referenced application observability or evaluation artifacts. Never report Pi's own model usage.",
    ],
    parameters: Type.Object({
      signalId: Type.String({ minLength: 1 }),
      type: StringEnum(["product_task_completed", "metric_window_available", "verification_window_completed"] as const),
      occurredAt: Type.Optional(Type.String({ minLength: 1 })),
      targetId: Type.String({ minLength: 1 }),
      metrics: Type.Optional(Type.Array(MetricRecordSchema)),
      modelId: Type.Optional(Type.String({ minLength: 1 })),
      evidence: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        source: StringEnum(["harness_trace", "evaluation_artifact", "observability_record", "external_source", "user_feedback"] as const),
        uri: Type.String({ minLength: 1 }),
        mediaType: Type.Optional(Type.String({ minLength: 1 })),
        digest: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }))),
      telemetry: Type.Optional(Type.Object({
        startedAt: Type.String({ minLength: 1 }),
        completedAt: Type.String({ minLength: 1 }),
        durationMs: Type.Number({ minimum: 0 }),
        inputTokens: Type.Number({ minimum: 0 }),
        outputTokens: Type.Number({ minimum: 0 }),
        cacheReadTokens: Type.Number({ minimum: 0 }),
        cacheWriteTokens: Type.Number({ minimum: 0 }),
        cost: Type.Number({ minimum: 0 }),
        currency: Type.Literal("USD"),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, input: ObservationSignalInput, _signal, _onUpdate, ctx) {
      store ??= new ProjectStore(ctx.cwd);
      if (input.type === "product_task_completed") {
        if (!input.modelId || !input.evidence?.length) {
          throw new Error("A completed application task requires the application modelId and durable evidence.");
        }
        await reportAutomationSignal(pi, ctx, state, store, {
          protocolVersion: PROTOCOL_VERSION,
          id: input.signalId,
          type: input.type,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          targetId: input.targetId,
          modelId: input.modelId,
          evidence: input.evidence,
          ...(input.telemetry ? { telemetry: input.telemetry } : {}),
        }, registerCompletionTool);
      } else {
        if (!input.metrics) throw new Error(`${input.type} requires application-target metrics.`);
        validateReportedMetrics(input.metrics, input.targetId);
        await reportAutomationSignal(pi, ctx, state, store, {
          protocolVersion: PROTOCOL_VERSION,
          id: input.signalId,
          type: input.type,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          targetId: input.targetId,
          metrics: input.metrics,
        }, registerCompletionTool);
      }
      return {
        content: [{ type: "text", text: `Recorded OpenMerit automation signal ${input.signalId}.` }],
        details: { signalId: input.signalId, type: input.type },
      };
    },
  });

  pi.on("input", (event, ctx) => {
    if (!state.activeIntent || event.source !== "interactive" || ctx.isIdle()) return;
    queuedUserInputs.push({ text: event.text, ...(event.images ? { images: event.images } : {}) });
    ctx.ui.notify(`openmerit: queued your request until active setup work finishes (${state.activeIntent})`, "info");
    return { action: "handled" };
  });

  pi.on("session_start", async (_event, ctx) => {
    store = new ProjectStore(ctx.cwd);
    let projectState = await store.readState();
    if (projectState) {
      state.lifecycleStage = projectState.cycle.stage;
      state.activeIntent = projectState.activeIntent?.id ?? null;
      if (projectState.activeIntent) registerCompletionTool(projectState.activeIntent.kind);
      state.applicationTarget = projectState.cycle.targetId ? "confirmed" : "not_detected";
      state.taskProfile = projectState.cycle.taskProfileId ? "configured" : "not_configured";
      state.metricReadiness = projectState.observability?.status === "ready" ? "assessed" : "pending";
      state.evaluationReadiness = projectState.cycle.taskProfileId ? "assessed" : "not_assessed";
      if (!projectState.cycle.targetId) {
        ctx.ui.notify("openmerit: existing state has no confirmed application LLM target; automation is blocked until /openmerit setup succeeds", "warning");
        return;
      }
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
        targetId: projectState.cycle.targetId,
        fingerprint,
      }, registerCompletionTool);
      if (!state.activeIntent) {
        await reportAutomationSignal(pi, ctx, state, store, {
          protocolVersion: PROTOCOL_VERSION,
          id: `signal-${crypto.randomUUID()}`,
          type: "scheduled_tick",
          occurredAt: new Date().toISOString(),
          targetId: projectState.cycle.targetId,
        }, registerCompletionTool);
      }
    } else if (ctx.hasUI && !state.proactiveNudgesPaused) {
      const detectedApplicationTargets = detectApplicationLlmTargets(ctx.cwd);
      if (detectedApplicationTargets.length) {
        ctx.ui.notify(`openmerit: detected ${detectedApplicationTargets.length} application LLM target candidate(s); asking Pi to confirm the target before setup`, "info");
        await dispatchIntent(pi, ctx, state, store, "establish_evals", registerCompletionTool, {
          applicationTargetRequired: true,
          detectedApplicationTargets: detectedTargetsConstraint(detectedApplicationTargets),
        });
      } else {
        ctx.ui.notify("openmerit: no application LLM call detected; automatic setup remains idle (use /openmerit setup to inspect manually)", "info");
      }
    }
    if (projectState?.activeIntent) {
      ctx.ui.notify(
        `openmerit: recovered interrupted work (${projectState.activeIntent.id}); use /openmerit cancel to abandon it`,
        "warning",
      );
    }
  });

  pi.registerCommand("openmerit", {
    description: "OpenMerit: status, setup, assess, frontier, approve, cancel, pause/resume, logs, doctor",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";

      switch (subcommand) {
        case "status":
          ctx.ui.notify(renderStatus(state), "info");
          return;
        case "setup":
          store ??= new ProjectStore(ctx.cwd);
          await dispatchIntent(pi, ctx, state, store, "establish_evals", registerCompletionTool, {
            applicationTargetRequired: true,
            detectedApplicationTargets: detectedTargetsConstraint(detectApplicationLlmTargets(ctx.cwd)),
          });
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
        case "cancel": {
          store ??= new ProjectStore(ctx.cwd);
          const projectState = await store.readState();
          if (!projectState?.activeIntent) {
            ctx.ui.notify("openmerit: there is no active work to cancel", "warning");
            return;
          }
          const cancelled = await new OpenMeritCoordinator(store, piHarnessAdapter(pi)).acceptResult({
            protocolVersion: PROTOCOL_VERSION,
            intentId: projectState.activeIntent.id,
            status: "cancelled",
            completedAt: new Date().toISOString(),
            summary: "Cancelled explicitly by the user after an interrupted harness run.",
            evidence: [],
          } as AnyIntentResult);
          state.activeIntent = null;
          state.lifecycleStage = cancelled.state.cycle.stage;
          registerCompletionTool();
          releaseQueuedUserInput();
          ctx.ui.notify(`openmerit: cancelled ${projectState.activeIntent.id}`, "info");
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
              `audit log          : ${store?.eventsPath ?? `${ctx.cwd}/.openmerit/events.jsonl`}`,
              "Pi model mutation : prohibited",
              "application swap  : target-bound after approval",
              "persistent schedule: unavailable (active-session ticks only)",
              `interactive UI     : ${ctx.hasUI ? "available" : "unavailable"}`,
            ].join("\n"),
            "info",
          );
          return;
        case "logs":
          store ??= new ProjectStore(ctx.cwd);
          ctx.ui.notify(
            [
              "OpenMerit observability files",
              `audit events : ${store.eventsPath}`,
              `export errors: ${store.exportErrorsPath}`,
              `evidence     : ${store.evidenceDirectory}`,
              `state        : ${store.statePath}`,
            ].join("\n"),
            "info",
          );
          return;
        default:
          ctx.ui.notify(
            "openmerit: usage: /openmerit [status|setup|assess|frontier|approve|cancel|pause|resume|logs|doctor]",
            "warning",
          );
      }
    },
  });
}
