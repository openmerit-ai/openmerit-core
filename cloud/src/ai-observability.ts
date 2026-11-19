import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { EndpointConfig, GenerationCaptureInput, ToolSpanCaptureInput } from "../../openmerit-core/src/ranking/clients.ts";

const missingConfigurationWarning = (name: string) =>
  `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`;

const key = process.env.POSTHOG_KEY;
const host = process.env.POSTHOG_HOST;
if (process.env.NODE_ENV !== "production") {
  if (!key) console.warn(missingConfigurationWarning("POSTHOG_KEY"));
  if (!host) console.warn(missingConfigurationWarning("POSTHOG_HOST"));
}

const posthog = key && host
  ? new PostHog(key, { host, privacyMode: false, enableExceptionAutocapture: false })
  : null;

const providerFor = (endpoint: EndpointConfig) => endpoint.kind === "openai-compatible" ? "openai" : endpoint.kind;

const inputFor = (request: GenerationCaptureInput["request"]) => [
  ...(request.system ? [{ role: "system", content: request.system }] : []),
  ...request.messages.map(message => ({ role: message.role === "tool" ? "user" : message.role, content: message.content })),
];

const capture = (event: "$ai_generation" | "$ai_span", properties: Record<string, unknown>) => {
  if (!posthog) return;
  queueMicrotask(() => {
    try { posthog.capture({ distinctId: String(properties.$ai_session_id), event, properties }); }
    catch { /* Analytics must never affect a model call. */ }
  });
};

/** Binds every model and mock-tool call in one Rivet workflow step to the job session and trace. */
export function aiObservability(sessionId: string, traceId: string) {
  return {
    captureGeneration(input: GenerationCaptureInput): void {
      const { request, endpoint, completion } = input;
      capture("$ai_generation", {
        $ai_trace_id: traceId,
        $ai_session_id: sessionId,
        $ai_span_id: randomUUID(),
        $ai_span_name: "model_completion",
        $ai_model: request.model,
        $ai_provider: providerFor(endpoint),
        $ai_input: inputFor(request),
        ...(completion.usage ? { $ai_input_tokens: completion.usage.input, $ai_output_tokens: completion.usage.output } : {}),
        $ai_output_choices: [{ role: "assistant", content: completion.text }],
        $ai_latency: completion.latencyMs / 1000,
        $ai_http_status: completion.status,
        $ai_is_error: !completion.ok,
        ...(completion.error ? { $ai_error: completion.error } : {}),
        ...(completion.truncated ? { $ai_stop_reason: "max_tokens" } : {}),
        ...(request.maxTokens ? { $ai_max_tokens: request.maxTokens } : {}),
        ...(request.tools?.length ? { $ai_tools: request.tools } : {}),
        ...(completion.costUsd ? { $ai_total_cost_usd: completion.costUsd, $ai_cost_passthrough: !completion.costIsEstimate } : {}),
      });
    },
    captureToolSpan(input: ToolSpanCaptureInput): void {
      capture("$ai_span", {
        $ai_trace_id: traceId,
        $ai_session_id: sessionId,
        $ai_span_id: randomUUID(),
        $ai_span_name: `tool:${input.name}`,
        $ai_input_state: input.input,
        $ai_output_state: input.output,
      });
    },
  };
}
