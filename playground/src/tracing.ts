// Langfuse tracing over OTLP/HTTP JSON (https://langfuse.com/integrations/native/opentelemetry),
// using the v4 ingestion format. Built on fetch instead of the Langfuse SDK because the SDK expects a
// Node OpenTelemetry runtime, and this Worker only needs to export complete spans after each step.
//
// Shape: each claim is a Langfuse session. Each agent run is a trace with one `agent` root span,
// one `generation` per model call and one `tool` span per tool call, rebuilt from the Pi transcript.
// The human approval and the payment form a final trace in the same session. In a scenario run, a
// claim's final agent trace also carries Langfuse experiment attributes (its dataset item is the claim).

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import pkg from "../package.json" with { type: "json" };

export type ObservationType = "span" | "generation" | "agent" | "tool" | "chain" | "guardrail" | "evaluator" | "event";

export interface TraceContext {
  traceId: string;
  /** Claim ID or enrollment application ID. */
  sessionId: string;
  userId?: string;
  traceName: string;
  tags: string[];
  metadata: Record<string, string>;
  /** Set on a claim's final agent trace in a scenario run: that trace is the claim's experiment item. */
  experiment?: ExperimentItem;
}

/**
 * Links a trace to a Langfuse experiment (dataset run) through OTel attributes, which replace the
 * deprecated `POST /api/public/dataset-run-items` (https://langfuse.com/integrations/native/opentelemetry/experiments).
 */
export interface ExperimentContext {
  id: string;
  name: string;
  datasetId: string;
  metadata: Record<string, string>;
}

export interface ExperimentItem extends ExperimentContext {
  /** Dataset item ID; Sahra uses the claim ID. */
  itemId: string;
  /** Span ID of the trace's root observation. */
  rootObservationId: string;
}

export interface SpanInput {
  spanId: string;
  parentSpanId?: string;
  name: string;
  type: ObservationType;
  startMs: number;
  endMs: number;
  input?: unknown;
  output?: unknown;
  model?: string;
  usage?: Record<string, number>;
  cost?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  metadata?: Record<string, string>;
}

/** Versions every trace carries, so Langfuse can compare runs across OpenMerit releases. */
export const VERSIONS = {
  openmerit: pkg.dependencies.openmerit,
  agents: pkg.dependencies.agents,
  pi: pkg.dependencies["@earendil-works/pi-durable"],
};

async function hex(value: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

/** Deterministic IDs, so a retried workflow step exports the same IDs instead of a second copy. */
/** Identifies one case within one scenario run; agents, traces and workflow instances use it. */
export const runKey = (caseId: string, runId: string | null | undefined): string => (runId ? `${caseId}--${runId}` : caseId);
export const traceIdFor = (key: string): Promise<string> => hex(`trace:${key}`, 32);
export const spanIdFor = (key: string): Promise<string> => hex(`span:${key}`, 16);

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { arrayValue: { values: AnyValue[] } };

function attribute(key: string, value: string | number | boolean | string[]): { key: string; value: AnyValue } {
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((item) => ({ stringValue: item })) } } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

const json = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function otlpSpan(trace: TraceContext, environment: string, span: SpanInput) {
  const attributes = [
    attribute("langfuse.observation.type", span.type),
    attribute("langfuse.trace.name", trace.traceName),
    attribute("langfuse.session.id", trace.sessionId),
    attribute("langfuse.trace.tags", trace.tags),
    attribute("langfuse.release", `openmerit@${VERSIONS.openmerit}`),
    attribute("langfuse.version", `agents@${VERSIONS.agents}+pi@${VERSIONS.pi}`),
    attribute("langfuse.environment", environment),
  ];
  if (trace.userId) attributes.push(attribute("langfuse.user.id", trace.userId));
  for (const [key, value] of Object.entries(trace.metadata)) attributes.push(attribute(`langfuse.trace.metadata.${key}`, value));
  const experiment = trace.experiment;
  if (experiment) {
    attributes.push(
      attribute("langfuse.experiment.id", experiment.id),
      attribute("langfuse.experiment.name", experiment.name),
      attribute("langfuse.experiment.dataset.id", experiment.datasetId),
      attribute("langfuse.experiment.item.id", experiment.itemId),
      attribute("langfuse.experiment.item.root_observation_id", experiment.rootObservationId),
    );
    for (const [key, value] of Object.entries(experiment.metadata)) attributes.push(attribute(`langfuse.experiment.metadata.${key}`, value));
  }
  for (const [key, value] of Object.entries(span.metadata ?? {})) attributes.push(attribute(`langfuse.observation.metadata.${key}`, value));
  if (span.input !== undefined) attributes.push(attribute("langfuse.observation.input", json(span.input)));
  if (span.output !== undefined) attributes.push(attribute("langfuse.observation.output", json(span.output)));
  if (span.model) attributes.push(attribute("langfuse.observation.model.name", span.model));
  if (span.usage) attributes.push(attribute("langfuse.observation.usage_details", json(span.usage)));
  if (span.cost) attributes.push(attribute("langfuse.observation.cost_details", json(span.cost)));
  if (span.level) attributes.push(attribute("langfuse.observation.level", span.level));
  if (span.statusMessage) attributes.push(attribute("langfuse.observation.status_message", span.statusMessage));
  return {
    traceId: trace.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: nanos(span.startMs),
    endTimeUnixNano: nanos(Math.max(span.endMs, span.startMs)),
    attributes,
    status: span.level === "ERROR" ? { code: 2, message: span.statusMessage ?? "error" } : { code: 1 },
  };
}

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL: string;
  LANGFUSE_ENVIRONMENT: string;
}

function auth(env: LangfuseEnv): string | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`;
}

/** Exports complete spans. Tracing never fails a claim: errors are logged and swallowed. */
export async function exportSpans(env: LangfuseEnv, trace: TraceContext, spans: SpanInput[]): Promise<void> {
  const authorization = auth(env);
  if (!authorization || !spans.length) return;
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "playground-claims")] },
        scopeSpans: [{ scope: { name: "sahra-health", version: VERSIONS.openmerit }, spans: spans.map((span) => otlpSpan(trace, env.LANGFUSE_ENVIRONMENT, span)) }],
      },
    ],
  };
  try {
    const response = await fetch(`${env.LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", "x-langfuse-ingestion-version": "4" },
      body: JSON.stringify(body),
    });
    if (!response.ok) console.error(`Langfuse export failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  } catch (error) {
    console.error("Langfuse export failed", error);
  }
}

// Pi transcript → OpenAI-style messages and observations

type ChatMessage = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; reasoning?: string };

function toChat(message: Message): ChatMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n") };
    case "assistant": {
      const reasoning = message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : [])).join("\n");
      const toolCalls = message.content.flatMap((part) => (part.type === "toolCall" ? [{ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } }] : []));
      return {
        role: "assistant",
        content: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
    }
    case "toolResult":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n") };
    default:
      return { role: "system", content: "" };
  }
}

/**
 * Rebuilds one agent run from its transcript: the `agent` root span, a `generation` per model call
 * (with the conversation so far as input, tokens and cost) and a `tool` span per tool call.
 */
export async function agentRunSpans(input: {
  key: string;
  name: string;
  instructions: string;
  prompt: string;
  model: string;
  entries: readonly EntryRecord[];
  status: string;
  reason?: string;
  text?: string;
  startedMs: number;
  endedMs: number;
  metadata: Record<string, string>;
}): Promise<SpanInput[]> {
  const rootId = await spanIdFor(`${input.key}/agent`);
  const messages = input.entries.flatMap((entry) => entry.model ?? []);
  const spans: SpanInput[] = [];
  const history: ChatMessage[] = [{ role: "system", content: input.instructions }];
  const calls = new Map<string, { name: string; arguments: unknown }>();
  let previousEnd = input.startedMs;
  let generation = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      generation += 1;
      const start = assistant.timestamp || previousEnd;
      const end = start + (assistant.durationMs ?? 0);
      for (const part of assistant.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: part.arguments });
      spans.push({
        spanId: await spanIdFor(`${input.key}/generation/${generation}`),
        parentSpanId: rootId,
        name: `${input.name}-generate`,
        type: "generation",
        startMs: start,
        endMs: end,
        input: [...history],
        output: toChat(assistant),
        model: assistant.responseModel ?? assistant.model,
        usage: { input: assistant.usage.input, output: assistant.usage.output, cache_read_input_tokens: assistant.usage.cacheRead, cache_creation_input_tokens: assistant.usage.cacheWrite, total: assistant.usage.totalTokens },
        ...(assistant.usage.cost.total ? { cost: { input: assistant.usage.cost.input, output: assistant.usage.cost.output, total: assistant.usage.cost.total } } : {}),
        level: assistant.stopReason === "error" ? "ERROR" : undefined,
        statusMessage: assistant.errorMessage,
        metadata: { stop_reason: assistant.stopReason, provider: assistant.provider },
      });
      previousEnd = end;
    } else if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      const call = calls.get(result.toolCallId);
      const end = result.timestamp || previousEnd;
      spans.push({
        spanId: await spanIdFor(`${input.key}/tool/${result.toolCallId}`),
        parentSpanId: rootId,
        name: result.toolName,
        type: "tool",
        startMs: end - (result.durationMs ?? 0),
        endMs: end,
        input: call?.arguments ?? {},
        output: toChat(result).content,
        level: result.isError ? "WARNING" : undefined,
        statusMessage: result.isError ? toChat(result).content.slice(0, 200) : undefined,
        metadata: { tool_call_id: result.toolCallId },
      });
      previousEnd = end;
    }
    history.push(toChat(message));
  }
  spans.unshift({
    spanId: rootId,
    name: input.name,
    type: "agent",
    startMs: input.startedMs,
    endMs: input.endedMs,
    input: input.prompt,
    output: input.text ?? `(${input.status}${input.reason ? `: ${input.reason}` : ""})`,
    level: input.status === "done" ? undefined : "ERROR",
    statusMessage: input.status === "done" ? undefined : input.reason,
    metadata: { ...input.metadata, model: input.model, status: input.status, generations: String(generation) },
  });
  return spans;
}

/** Tool results the harness rejected (argument validation) or that ended in a harness error: an [error] line, alone or in a <harness> block that can follow normal output. */
export const isRejectedToolOutput = (text: string): boolean => /(^|\n)\s*(<harness>\s*)?\[error\]/.test(text);

/** Task-level facts of one agent run, from its transcript: model calls and rejected tool calls. */
export function transcriptCounts(entries: readonly EntryRecord[]): { modelCalls: number; rejectedToolCalls: number } {
  const messages = entries.flatMap((entry) => entry.model ?? []);
  return {
    modelCalls: messages.filter((message) => message.role === "assistant").length,
    rejectedToolCalls: messages.filter((message) => message.role === "toolResult" && isRejectedToolOutput(toChat(message).content)).length,
  };
}

export interface ScoreInput {
  traceId: string;
  observationId?: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  comment?: string;
  metadata?: Record<string, string>;
}

/**
 * Posts a score through the scores API (scores are not OTLP spans). The score ID is derived from its
 * trace, observation and name, so a retried step or rerun of the runner updates instead of duplicating.
 */
export async function postScore(env: LangfuseEnv, score: ScoreInput): Promise<void> {
  const authorization = auth(env);
  if (!authorization) return;
  const id = await hex(`score:${score.traceId}/${score.observationId ?? ""}/${score.name}`, 32);
  const response = await fetch(`${env.LANGFUSE_BASE_URL}/api/public/scores`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify([{ id, ...score, environment: env.LANGFUSE_ENVIRONMENT }]),
  });
  // 202 accepts the batch; 207 reports rejected scores with a 2xx status.
  if (!response.ok || response.status === 207) throw new Error(`Langfuse score failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}
