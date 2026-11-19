// Endpoint clients: one model call on OpenRouter, an OpenAI-compatible API (the CLI's `Endpoint`
// shape) or Anthropic's Messages API. Every call reserves its expected cost in the ledger under the
// caller's idempotency key before anything is sent, and settles once with what the final answer
// cost: OpenRouter's reported cost, else a list-price estimate from the reported tokens or the
// answer's size. The retry rules, reservation and estimates are the eval proxy's.
import { loadCatalogue } from "../catalogue/catalogue.ts";
import { catalogueIndex, DEFAULT_OUTPUT_TOKENS, expectedCost, readUsage, redact, requestPrice, settledUsd, sizeEstimate, type CatalogueModel, type Funding, type Ledger, type Settlement } from "../engine/index.ts";
import { withRetries } from "../eval/proxy.ts";
import type { Completion, CompletionRequest, EndpointKind, ToolCall } from "./types.ts";

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

export interface GenerationCaptureInput {
  request: CompletionRequest;
  endpoint: EndpointConfig;
  baseUrl: string;
  completion: Completion;
}

/** AI Observability is injected by production hosts; the ranking primitive has no PostHog dependency. */
export type GenerationCapture = (input: GenerationCaptureInput) => void;
export interface ToolSpanCaptureInput { name: string; input: string; output: string }
export type ToolSpanCapture = (input: ToolSpanCaptureInput) => void;

export interface ModelClient {
  /** Throws BudgetRefused, before sending, when the ledger refuses the reservation. */
  complete(request: CompletionRequest, meter: Meter): Promise<Completion>;
  /** Records a dispatched tool run when the host configured AI Observability. */
  captureToolSpan?: ToolSpanCapture;
}

const DEFAULT_BASE_URL: Partial<Record<EndpointKind, string>> = { openrouter: "https://openrouter.ai/api/v1", anthropic: "https://api.anthropic.com/v1" };
const ANTHROPIC_VERSION = "2023-06-01";
/** How long one attempt may wait for an answer. A ranking call's answer is short, so a model that says nothing for this long is not going to. */
export const CALL_TIMEOUT_MS = 120_000;

type Json = Record<string, unknown>;

/** A tool's parameters as a JSON schema both APIs accept: a trace that recorded only a tool's name has `{}`. */
const schemaOf = (parameters: object) => ("type" in parameters ? parameters : { type: "object", properties: {}, ...parameters });

function openaiBody(endpoint: EndpointConfig, baseUrl: string, request: CompletionRequest): Json {
  const messages: Json[] = request.system ? [{ role: "system", content: request.system }] : [];
  for (const message of request.messages) {
    if (message.role === "tool") messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    else if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({ role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
    } else messages.push({ role: message.role, content: message.content });
  }
  // OpenAI's own API refuses max_tokens for reasoning models; other compatible APIs know max_tokens best.
  const limit = baseUrl.includes("api.openai.com") ? "max_completion_tokens" : "max_tokens";
  return {
    model: request.model, messages, [limit]: request.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: schemaOf(tool.parameters) } })) } : {}),
    ...(endpoint.kind === "openrouter" ? { usage: { include: true } } : {}),
  };
}

function anthropicBody(request: CompletionRequest): Json {
  const messages: { role: "user" | "assistant"; content: string | Json[] }[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      // Tool results go back in one user turn, after the assistant turn that asked for them.
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every(item => item.type === "tool_result")) last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({ role: "assistant", content: [...(message.content ? [{ type: "text", text: message.content }] : []), ...message.toolCalls.map(call => ({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments) }))] });
    } else messages.push({ role: message.role, content: message.content });
  }
  return {
    model: request.model, max_tokens: request.maxTokens ?? DEFAULT_OUTPUT_TOKENS, messages,
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: schemaOf(tool.parameters) })) } : {}),
  };
}

function parseArguments(text: string): unknown {
  try { const value: unknown = JSON.parse(text || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

interface Parsed { text: string; toolCalls: ToolCall[]; truncated: boolean; error?: string }

function parseOpenai(value: Json): Parsed {
  const choice = (value.choices as Json[] | undefined)?.[0];
  if (!choice) return { text: "", toolCalls: [], truncated: false, error: errorMessage(value) ?? "the answer has no choices" };
  const message = (choice.message ?? {}) as { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
  const content = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map(part => (part && typeof part === "object" && typeof (part as Json).text === "string" ? (part as Json).text as string : "")).join("") : "";
  const toolCalls = (message.tool_calls ?? []).map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" }));
  return { text: content, toolCalls, truncated: choice.finish_reason === "length" };
}

function parseAnthropic(value: Json): Parsed {
  if (!Array.isArray(value.content)) return { text: "", toolCalls: [], truncated: false, error: errorMessage(value) ?? "the answer has no content" };
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of value.content as Json[]) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input ?? {}) });
  }
  return { text, toolCalls, truncated: value.stop_reason === "max_tokens" };
}

function errorMessage(value: Json): string | null {
  const error = value.error as Json | string | undefined;
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : null;
  return message === null ? null : redact(message).slice(0, 300);
}

/**
 * A client for these endpoints. `model` finds a model's list prices for estimates and reservations;
 * the default looks it up in the bundled catalogue by ID or alias.
 */
export function createClient(endpoints: readonly EndpointConfig[], options: { fetch?: typeof fetch; model?: (endpointModel: string) => CatalogueModel | null; timeoutMs?: number; captureGeneration?: GenerationCapture; captureToolSpan?: ToolSpanCapture } = {}): ModelClient {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  let index: ReturnType<typeof catalogueIndex> | undefined;
  const priced = options.model ?? ((model: string) => (index ??= catalogueIndex(loadCatalogue())).find(model));
  const byId = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]));
  return {
    async complete(request, meter) {
      const endpoint = byId.get(request.endpoint);
      if (!endpoint) throw new Error(`Unknown endpoint ${request.endpoint}`);
      const baseUrl = (endpoint.baseUrl ?? DEFAULT_BASE_URL[endpoint.kind] ?? "").replace(/\/$/, "");
      if (!baseUrl) throw new Error(`Endpoint ${endpoint.id} needs a base URL`);
      const failed = (status: number, error: string, latencyMs = 0, costUsd = 0): Completion => ({ ok: false, status, text: "", toolCalls: [], truncated: false, usage: null, costUsd, costIsEstimate: false, latencyMs, error });
      if (Array.isArray(endpoint.allowedModels) && !endpoint.allowedModels.includes(request.model)) return failed(403, `${request.model} is not in ${endpoint.id}'s allowed models`);
      const capture = (completion: Completion): Completion => {
        try { options.captureGeneration?.({ request, endpoint, baseUrl, completion }); } catch { /* Analytics must never affect a model call. */ }
        return completion;
      };

      const anthropic = endpoint.kind === "anthropic";
      const body = anthropic ? anthropicBody(request) : openaiBody(endpoint, baseUrl, request);
      const sent = JSON.stringify(body);
      const sentBytes = Buffer.byteLength(sent);
      const model = priced(request.model);
      const expected = expectedCost(model, body, sentBytes);
      const reservation = await meter.ledger.reserve({ key: meter.key, usd: expected.usd, funding: endpoint.funding, model: request.model, endpoint: endpoint.id });
      if (!reservation.ok) throw new BudgetRefused(reservation.reason, reservation.neededUsd);

      const headers: Record<string, string> = anthropic
        ? { "x-api-key": endpoint.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" }
        : { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json", ...(endpoint.kind === "openrouter" ? { "x-title": "OpenMerit Ranking" } : {}) };
      const started = Date.now();
      let settled = false;
      const settle = async (cost: Settlement) => { settled = true; await meter.ledger.settle(meter.key, { ...cost, latencyMs: Date.now() - started }); };
      try {
        // Only the last attempt is charged: providers do not bill the rate limits and errors a retry discards.
        // Each attempt has its own timeout, which also covers reading the answer. An attempt that timed out is not retried.
        let attemptSignal: AbortSignal | undefined;
        const silent = () => new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`);
        let upstream: Response | Error;
        try {
          upstream = await withRetries(() => {
            const attempt = AbortSignal.timeout(timeoutMs);
            attemptSignal = meter.signal ? AbortSignal.any([meter.signal, attempt]) : attempt;
            return fetcher(`${baseUrl}${anthropic ? "/messages" : "/chat/completions"}`, { method: "POST", headers, body: sent, signal: attemptSignal })
              .catch((error: unknown) => {
                if (attempt.aborted && !meter.signal?.aborted) throw silent();
                return error instanceof Error ? error : new Error(String(error));
              });
          }, meter.signal);
        } catch (error) {
          meter.signal?.throwIfAborted();
          upstream = error instanceof Error ? error : new Error(String(error));
        }
        if (upstream instanceof Error) {
          meter.signal?.throwIfAborted();
          await settle({ actualUsd: 0, estimatedUsd: null, failed: true });
          return capture(failed(0, `${endpoint.id} did not answer (${redact(upstream.message).slice(0, 200)})`, Date.now() - started));
        }
        let text: string;
        try { text = await upstream.text(); } catch (error) {
          meter.signal?.throwIfAborted();
          // Cut off while answering: what was sent may have been billed, so the reservation stands as an estimate.
          await settle({ actualUsd: null, estimatedUsd: null, failed: true });
          return capture(failed(0, `${endpoint.id} did not answer (${attemptSignal?.aborted ? silent().message : redact(error instanceof Error ? error.message : String(error)).slice(0, 200)})`, Date.now() - started));
        }
        const latencyMs = Date.now() - started;
        const usage = readUsage(text);
        let value: Json = {};
        try { value = JSON.parse(text) as Json; } catch { /* not JSON */ }
        if (!upstream.ok) {
          await settle({ actualUsd: usage?.costUsd ?? 0, estimatedUsd: null, failed: true });
          return capture(failed(upstream.status, errorMessage(value) ?? `HTTP ${upstream.status}`, latencyMs, usage?.costUsd ?? 0));
        }
        // An answer without usage is estimated from its size; a model without a price keeps its reservation.
        const cost: Settlement = { actualUsd: usage?.costUsd ?? null, estimatedUsd: usage ? requestPrice(model, usage.input, usage.output) : sizeEstimate(model, sentBytes, Buffer.byteLength(text)) };
        await settle(cost);
        const costUsd = settledUsd(expected.usd, cost), costIsEstimate = cost.actualUsd === null;
        const parsed = anthropic ? parseAnthropic(value) : parseOpenai(value);
        const base = { usage: usage ? { input: usage.input, output: usage.output } : null, costUsd, costIsEstimate, latencyMs, status: upstream.status, text: parsed.text, toolCalls: parsed.toolCalls, truncated: parsed.truncated };
        return capture(parsed.error ? { ...base, ok: false, error: parsed.error } : { ...base, ok: true });
      } finally {
        // Cut off part-way, such as by the caller's signal: what was sent may have been billed, so the reservation stands as an estimate.
        if (!settled) await meter.ledger.settle(meter.key, { actualUsd: null, estimatedUsd: null, latencyMs: Date.now() - started, failed: true });
      }
    },
    ...(options.captureToolSpan ? { captureToolSpan: options.captureToolSpan } : {}),
  };
}
