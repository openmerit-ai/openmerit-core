// Endpoint clients: model calls on OpenRouter, an OpenAI-compatible API (the CLI's `Endpoint` shape)
// or Anthropic's Messages API, made by Pi's model layer (pi-ai): its OpenAI chat completions API for
// OpenRouter and OpenAI-compatible endpoints, its Anthropic Messages API for Anthropic. Every call
// reserves its expected cost in the ledger under the caller's idempotency key once Pi has built the
// request and before anything is sent, and settles once with what the final answer cost: the cost
// OpenRouter reports, else a list-price estimate from the reported tokens or the answer's size.
// Retries and the per-attempt timeout are OpenMerit's, in the fetch Pi sends with.
import { normalizeContext, type Api, type AssistantMessage, type Context, type Message as PiMessage, type Model, type StreamFunction, type StreamOptions, type ToolCall as PiToolCall } from "@earendil-works/pi-ai";
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { loadCatalogue } from "../catalogue/catalogue.ts";
import { catalogueIndex, DEFAULT_OUTPUT_TOKENS, expectedCost, readUsage, redact, requestPrice, settledUsd, sizeEstimate, type CatalogueModel, type Funding, type Ledger, type Settlement } from "../engine/index.ts";
import { withRetries } from "../eval/proxy.ts";
import type { Completion, CompletionRequest, EndpointKind, Message, ToolCall } from "./types.ts";

/** Thrown when the ledger refuses a call's reservation: nothing was sent. */
export class BudgetRefused extends Error {
  override readonly name = "BudgetRefused";
  readonly neededUsd: number;
  constructor(reason: string, neededUsd: number) { super(reason); this.neededUsd = neededUsd; }
}

export interface EndpointConfig {
  id: string;
  kind: EndpointKind;
  /** API root. Defaults: https://openrouter.ai/api/v1 and https://api.anthropic.com/v1; required for openai-compatible. */
  baseUrl?: string;
  apiKey: string;
  funding: Funding;
  /** Models this endpoint may call, as it names them; every model when absent or "all". */
  allowedModels?: "all" | string[];
}

/** How each call is metered: the ledger, the call's idempotency key, and the caller's signal. */
export interface Meter { ledger: Ledger; key: string; signal?: AbortSignal }

/** One metered call through Pi: its answer as Pi records it, and what it cost. */
export interface ModelCall {
  /** False when the endpoint answered with an error or did not answer; `status` 0 means it did not answer. */
  ok: boolean;
  status: number;
  /** Pi's assistant message; its `stopReason` is "error" when `ok` is false. */
  message: AssistantMessage;
  usage: { input: number; output: number } | null;
  costUsd: number;
  costIsEstimate: boolean;
  latencyMs: number;
  /** The endpoint's error message, shortened, when `ok` is false. */
  error?: string;
}

export interface ModelClient {
  /** Pi's model for `model` on one of the client's endpoints, as Pi's agent loop takes it. Throws for an unknown endpoint. */
  model(endpoint: string, model: string): Model<Api>;
  /** One call with a Pi context. Throws BudgetRefused, before sending, when the ledger refuses the reservation. */
  call(request: { endpoint: string; model: string; context: Context; maxTokens?: number }, meter: Meter): Promise<ModelCall>;
  /** One call with a provider-neutral request, such as the case writer's or the judge's. Throws BudgetRefused like `call`. */
  complete(request: CompletionRequest, meter: Meter): Promise<Completion>;
}

const DEFAULT_BASE_URL: Partial<Record<EndpointKind, string>> = { openrouter: "https://openrouter.ai/api/v1", anthropic: "https://api.anthropic.com/v1" };
/** How long one attempt may wait for an answer. A ranking call's answer is short, so a model that says nothing for this long is not going to. */
export const CALL_TIMEOUT_MS = 120_000;

/** A tool's parameters as a JSON schema both APIs accept: a trace that recorded only a tool's name has `{}`. */
export const schemaOf = (parameters: object) => ("type" in parameters ? parameters : { type: "object", properties: {}, ...parameters });

const NO_USAGE: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** An assistant message Pi did not receive, such as a recorded one or a call that was refused before it was sent. */
export function assistantMessage(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: NO_USAGE, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() };
}

const parseArguments = (text: string): PiToolCall["arguments"] => {
  try { const value: unknown = JSON.parse(text || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value as PiToolCall["arguments"] : {}; } catch { return {}; }
};

/** Provider-neutral messages as Pi messages; `model` stands for the model that wrote the assistant turns. */
export function piMessages(model: Model<Api>, messages: readonly Message[]): PiMessage[] {
  const names = new Map<string, string>();
  return messages.map((message): PiMessage => {
    if (message.role === "user") return { role: "user", content: message.content, timestamp: Date.now() };
    if (message.role === "tool") {
      return { role: "toolResult", toolCallId: message.toolCallId, toolName: message.name ?? names.get(message.toolCallId) ?? "", content: [{ type: "text", text: message.content }], isError: false, timestamp: Date.now() };
    }
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    const calls = (message.toolCalls ?? []).map((call): PiToolCall => ({ type: "toolCall", id: call.id, name: call.name, arguments: parseArguments(call.arguments) }));
    return assistantMessage(model, [...(message.content ? [{ type: "text" as const, text: message.content }] : []), ...calls], calls.length ? "toolUse" : "stop");
  });
}

/** An answer's text and its tool calls, with their arguments as JSON text. */
export const textOf = (message: AssistantMessage) => message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
export const toolCallsOf = (message: AssistantMessage): ToolCall[] =>
  message.content.flatMap(part => (part.type === "toolCall" ? [{ id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) }] : []));

/** Pi's error text without its status prefix, with a JSON error body read as its message. */
function errorText(text: string): string {
  const body = text.replace(/^\d{3}\s*:?\s*/, "");
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof value.error === "string" ? value.error : typeof value.error?.message === "string" ? value.error.message : typeof value.message === "string" ? value.message : null;
    if (message) return redact(message).slice(0, 300);
  } catch { /* not JSON */ }
  return redact(body).slice(0, 300);
}

/**
 * A client for these endpoints. `model` finds a model's list prices for estimates and reservations;
 * the default looks it up in the bundled catalogue by ID or alias. `fetch` is what Pi sends with.
 */
export function createClient(endpoints: readonly EndpointConfig[], options: { fetch?: typeof fetch; model?: (endpointModel: string) => CatalogueModel | null; timeoutMs?: number } = {}): ModelClient {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  let index: ReturnType<typeof catalogueIndex> | undefined;
  const priced = options.model ?? ((model: string) => (index ??= catalogueIndex(loadCatalogue())).find(model));
  const byId = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]));
  const endpointOf = (id: string) => {
    const endpoint = byId.get(id);
    if (!endpoint) throw new Error(`Unknown endpoint ${id}`);
    const baseUrl = (endpoint.baseUrl ?? DEFAULT_BASE_URL[endpoint.kind] ?? "").replace(/\/$/, "");
    if (!baseUrl) throw new Error(`Endpoint ${endpoint.id} needs a base URL`);
    return { endpoint, baseUrl };
  };

  const model = (id: string, name: string): Model<Api> => {
    const { endpoint, baseUrl } = endpointOf(id);
    const price = priced(name);
    const anthropic = endpoint.kind === "anthropic";
    return {
      id: name, name, provider: endpoint.kind === "openai-compatible" ? endpoint.id : endpoint.kind,
      // Pi's Anthropic client adds /v1 itself.
      api: anthropic ? "anthropic-messages" : "openai-completions", baseUrl: anthropic ? baseUrl.replace(/\/v1$/, "") : baseUrl,
      input: ["text"], reasoning: false, contextWindow: price?.contextLength ?? 128_000, maxTokens: DEFAULT_OUTPUT_TOKENS,
      cost: { input: price?.inputPerM ?? 0, output: price?.outputPerM ?? 0, cacheRead: 0, cacheWrite: 0 },
      // OpenAI's own API takes max_completion_tokens and `store`; other compatible APIs know max_tokens best.
      ...(anthropic || baseUrl.includes("api.openai.com") ? {} : { compat: { maxTokensField: "max_tokens", supportsStore: false } }),
    } as Model<Api>;
  };

  const call: ModelClient["call"] = async (request, meter) => {
    const { endpoint } = endpointOf(request.endpoint);
    const target = model(request.endpoint, request.model);
    const started = Date.now();
    const failed = (status: number, error: string, latencyMs = 0, message = assistantMessage(target, [], "error", error)): ModelCall =>
      ({ ok: false, status, message: { ...message, stopReason: "error", errorMessage: error }, usage: null, costUsd: 0, costIsEstimate: false, latencyMs, error });
    if (Array.isArray(endpoint.allowedModels) && !endpoint.allowedModels.includes(request.model)) return failed(403, `${request.model} is not in ${endpoint.id}'s allowed models`);

    const price = priced(request.model);
    let expectedUsd = 0, sentBytes = 0, reserved = false, refused: BudgetRefused | null = null;
    let settled = false;
    const settle = async (cost: Settlement) => { settled = true; await meter.ledger.settle(meter.key, { ...cost, latencyMs: Date.now() - started }); };
    // The status of the attempt kept; 0 until an attempt is answered.
    let status = 0, attempt: AbortSignal | undefined, unreachable: string | null = null;
    // The kept answer as sent, read beside Pi: a cost the endpoint reports, which Pi reads only from OpenRouter.
    let body: Promise<string> = Promise.resolve("");
    const silent = () => new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    // Only the last attempt is charged: providers do not bill the rate limits and errors a retry discards.
    // Each attempt has its own timeout, which also covers reading the answer. An attempt that timed out is not retried.
    const metered: typeof fetch = async (url, init) => {
      let upstream: Response | Error;
      try {
        upstream = await withRetries(() => {
          const timeout = attempt = AbortSignal.timeout(timeoutMs);
          return fetcher(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout }).catch((error: unknown) => {
            if (timeout.aborted && !meter.signal?.aborted) throw silent();
            return error instanceof Error ? error : new Error(String(error));
          });
        }, meter.signal);
      } catch (error) { upstream = error instanceof Error ? error : new Error(String(error)); }
      if (upstream instanceof Error) { unreachable = upstream.message; throw upstream; }
      status = upstream.status;
      body = upstream.clone().text().catch(() => "");
      return upstream;
    };
    // Each Pi API module types its own model; `target.api` picks the one that takes it.
    const stream = (target.api === "anthropic-messages" ? anthropicMessages : openaiCompletions) as StreamFunction<Api, StreamOptions>;
    try {
      const message = await stream(target, normalizeContext(request.context), {
        apiKey: endpoint.apiKey, fetch: metered, maxTokens: request.maxTokens ?? DEFAULT_OUTPUT_TOKENS, maxRetries: 0, cacheRetention: "none",
        ...(meter.signal ? { signal: meter.signal } : {}),
        ...(endpoint.kind === "openrouter" ? { headers: { "x-title": "OpenMerit Ranking" } } : {}),
        // Pi has built the request: reserve its expected cost before it is sent.
        onPayload: async payload => {
          const body = { ...(payload as Record<string, unknown>), ...(endpoint.kind === "openrouter" ? { usage: { include: true } } : {}) };
          sentBytes = Buffer.byteLength(JSON.stringify(body));
          expectedUsd = expectedCost(price, body, sentBytes).usd;
          const reservation = await meter.ledger.reserve({ key: meter.key, usd: expectedUsd, funding: endpoint.funding, model: request.model, endpoint: endpoint.id });
          if (!reservation.ok) { refused = new BudgetRefused(reservation.reason, reservation.neededUsd); throw refused; }
          reserved = true;
          return body;
        },
      }).result();
      const latencyMs = Date.now() - started;
      if (refused) throw refused;
      if (!reserved) return failed(0, `${endpoint.id} could not be called (${redact(message.errorMessage ?? "Pi did not build the request").slice(0, 200)})`, latencyMs);
      meter.signal?.throwIfAborted();
      const reason = message.errorMessage ?? message.stopReason;
      const answered = message.stopReason !== "error" && message.stopReason !== "aborted";
      const timedOut = !answered && !!attempt?.aborted;
      if (timedOut || status === 0) {
        // Cut off while answering: what was sent may have been billed, so the reservation stands as an estimate.
        await settle(status ? { actualUsd: null, estimatedUsd: null, failed: true } : { actualUsd: 0, estimatedUsd: null, failed: true });
        return failed(0, `${endpoint.id} did not answer (${timedOut ? silent().message : redact(unreachable ?? reason).slice(0, 200)})`, latencyMs, message);
      }
      const billed = (usage: AssistantMessage["usage"]) => (usage.cost.totalFromProvider ? usage.cost.total : null);
      if (status >= 400) {
        const charged = readUsage(await body)?.costUsd ?? 0;
        await settle({ actualUsd: charged, estimatedUsd: null, failed: true });
        return { ...failed(status, errorText(reason), latencyMs, message), costUsd: charged };
      }
      const usage = message.usage, input = usage.input + usage.cacheRead + usage.cacheWrite;
      const reported = input + usage.output > 0;
      const actualUsd = billed(usage) ?? readUsage(await body)?.costUsd ?? null;
      // An answer without usage is estimated from its size; a model without a price keeps its reservation.
      const cost: Settlement = {
        actualUsd,
        estimatedUsd: reported ? requestPrice(price, input, usage.output) : sizeEstimate(price, sentBytes, Buffer.byteLength(JSON.stringify(message.content))),
      };
      await settle(answered || reported ? cost : { actualUsd: null, estimatedUsd: null, failed: true });
      const costUsd = settledUsd(expectedUsd, answered || reported ? cost : { actualUsd: null, estimatedUsd: null }), costIsEstimate = actualUsd === null;
      const base = { status, message, usage: reported ? { input, output: usage.output } : null, costUsd, costIsEstimate, latencyMs };
      return answered ? { ...base, ok: true } : { ...base, ok: false, error: errorText(reason) };
    } finally {
      // Cut off part-way, such as by the caller's signal: what was sent may have been billed, so the reservation stands as an estimate.
      if (reserved && !settled) await meter.ledger.settle(meter.key, { actualUsd: null, estimatedUsd: null, latencyMs: Date.now() - started, failed: true });
    }
  };

  return {
    model,
    call,
    async complete(request, meter) {
      const target = model(request.endpoint, request.model);
      const context: Context = {
        ...(request.system ? { systemPrompt: request.system } : {}),
        messages: piMessages(target, request.messages),
        ...(request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description ?? "", parameters: schemaOf(tool.parameters) })) } : {}),
      };
      const answer = await call({ endpoint: request.endpoint, model: request.model, context, ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}) }, meter);
      const base = { status: answer.status, text: textOf(answer.message), toolCalls: toolCallsOf(answer.message), truncated: answer.message.stopReason === "length", usage: answer.usage, costUsd: answer.costUsd, costIsEstimate: answer.costIsEstimate, latencyMs: answer.latencyMs };
      return answer.ok ? { ...base, ok: true } : { ...base, ok: false, ...(answer.error ? { error: answer.error } : {}) };
    },
  };
}
