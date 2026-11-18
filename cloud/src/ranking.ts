// W2's `openmerit/ranking`, as the shared contract defines it: the task bundle, cases, an endpoint
// client, graders and `createMeasure`. This is a stand-in until W2's module lands: it calls every
// endpoint as OpenAI chat completions, writes cases only from the bundle's examples, and grades by
// exact match or JSON. Replace this file's body with a re-export from
// ../../openmerit-core/src/ranking/ then, and keep the names the app uses.
import type { Funding, Ledger } from "./engine.ts";

export interface TaskBundle {
  task: string;
  description?: string;
  current: { model: string; endpoint?: string };
  /** Messages may hold {{var}} placeholders that each case's input fills. */
  prompt: { system?: string; messages: { role: "user" | "assistant"; content: string }[] };
  tools?: { name: string; description?: string; parameters: object; mockResult?: unknown }[];
  output: { kind: "text" } | { kind: "json"; schema: object } | { kind: "label"; labels: string[] };
  examples?: { input: Record<string, string>; expected?: unknown }[];
  constraints?: { maxLatencyMs?: number; needsVision?: boolean };
  codeRefs?: { file: string; line: number; spelling: string }[];
}

export interface Case { id: string; input: Record<string, string>; expected?: unknown; origin: "example" | "written" | "trace"; approved?: boolean }
export type EndpointKind = "openrouter" | "openai-compatible" | "anthropic";
export interface MeasureResult { results: { caseId: string; pass: boolean }[]; costUsd: number; costIsEstimate: boolean; latencyMs: number | null }
export interface Candidate { model: string; endpoint: string }

export interface Completion { text: string; costUsd: number | null; inputTokens: number; outputTokens: number; latencyMs: number }
export interface ModelClient {
  /** Who pays for calls on this endpoint. */
  funding(endpoint: string): Funding;
  /** List-price estimate of one call, reserved before it runs. */
  estimateUsd(candidate: Candidate, inputTokens: number, outputTokens: number): number;
  complete(candidate: Candidate, request: { system?: string; messages: { role: string; content: string }[]; json: boolean }, signal?: AbortSignal): Promise<Completion>;
}
export type Grader = (output: string, item: Case, bundle: TaskBundle) => boolean;

/** An endpoint a model client may call, with its key in memory only. */
export interface ClientEndpoint { id: string; kind: EndpointKind; baseUrl: string; apiKey: string; funding: Funding }

/** The provider or the model refused the call outright: the candidate is skipped, not failed. */
export class ModelUnavailable extends Error { override readonly name = "CandidateUnavailable"; }
/** The ledger refused the reservation. */
export class SpendRefused extends Error {
  override readonly name = "SpendRefused";
  readonly reason: string;
  readonly neededUsd: number;
  constructor(reason: string, neededUsd: number) { super(reason); this.reason = reason; this.neededUsd = neededUsd; }
}

const MAX_OUTPUT_TOKENS = 512;
const approxTokens = (text: string) => Math.ceil(text.length / 4);

export const fill = (text: string, input: Record<string, string>) => text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => input[name] ?? match);

/** The cases a bundle gives: its examples first. W2's case writer adds written cases. */
export function writeCases(bundle: TaskBundle): Case[] {
  return (bundle.examples ?? []).map((example, index) => ({
    id: `ex${index + 1}`, input: example.input, origin: "example" as const,
    ...(example.expected !== undefined ? { expected: example.expected, approved: true } : {}),
  }));
}

function instructions(bundle: TaskBundle): string | null {
  if (bundle.output.kind === "label") return `Answer with exactly one of: ${bundle.output.labels.join(", ")}.`;
  if (bundle.output.kind === "json") return `Answer with JSON only, matching this schema: ${JSON.stringify(bundle.output.schema)}`;
  return null;
}

const normalize = (value: string) => value.trim().replace(/^["'`]+|["'`.]+$/g, "").toLowerCase();

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Exact match for labels and text, equal JSON for JSON output. A case without an expected value fails. */
export const defaultGrader: Grader = (output, item, bundle) => {
  if (item.expected === undefined) return false;
  if (bundle.output.kind === "json") {
    const text = output.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return deepEqual(JSON.parse(text), item.expected); } catch { return false; }
  }
  return normalize(output) === normalize(String(item.expected));
};

export function createMeasure(input: { bundle: TaskBundle; cases: Case[]; client: ModelClient; grader: Grader; ledger: Ledger; signal?: AbortSignal }) {
  const byId = new Map(input.cases.map(item => [item.id, item]));
  const extra = instructions(input.bundle);
  return async (candidate: Candidate, caseIds: string[]): Promise<MeasureResult> => {
    const results: MeasureResult["results"] = [];
    let costUsd = 0, costIsEstimate = false, latency = 0;
    for (const caseId of caseIds) {
      const item = byId.get(caseId);
      if (!item) throw new Error(`Unknown case ${caseId}`);
      const system = [input.bundle.prompt.system && fill(input.bundle.prompt.system, item.input), extra].filter(Boolean).join("\n\n") || undefined;
      const messages = input.bundle.prompt.messages.map(message => ({ role: message.role, content: fill(message.content, item.input) }));
      const estimate = input.client.estimateUsd(candidate, approxTokens(`${system ?? ""}${messages.map(message => message.content).join("")}`), MAX_OUTPUT_TOKENS);
      const key = `${candidate.endpoint}/${candidate.model}/${caseId}`;
      const reserved = await input.ledger.reserve({ key, usd: estimate, funding: input.client.funding(candidate.endpoint), model: candidate.model, endpoint: candidate.endpoint });
      if (!reserved.ok) throw new SpendRefused(reserved.reason, reserved.neededUsd);
      let completion: Completion;
      try {
        completion = await input.client.complete(candidate, { ...(system ? { system } : {}), messages, json: input.bundle.output.kind === "json" }, input.signal);
      } catch (error) {
        // A call that never reached the model costs nothing; one cut off later may have.
        if (error instanceof ModelUnavailable) await input.ledger.release(key);
        else await input.ledger.settle(key, { actualUsd: null, estimatedUsd: estimate, failed: true });
        throw error;
      }
      await input.ledger.settle(key, { actualUsd: completion.costUsd, estimatedUsd: estimate, latencyMs: completion.latencyMs });
      costUsd += completion.costUsd ?? estimate;
      costIsEstimate ||= completion.costUsd === null;
      latency += completion.latencyMs;
      results.push({ caseId, pass: input.grader(completion.text, item, input.bundle) });
    }
    return { results, costUsd, costIsEstimate, latencyMs: caseIds.length ? Math.round(latency / caseIds.length) : null };
  };
}

/** Calls each endpoint's OpenAI-compatible chat completions API. OpenRouter reports each call's cost in its usage. */
export function createModelClient(input: {
  endpoints: readonly ClientEndpoint[];
  price: (candidate: Candidate) => { inputPerM: number; outputPerM: number } | null;
  fetch?: typeof fetch;
}): ModelClient {
  const request = input.fetch ?? fetch;
  const endpoint = (id: string) => input.endpoints.find(item => item.id === id) ?? (() => { throw new ModelUnavailable(`No endpoint ${id}`); })();
  return {
    funding: id => endpoint(id).funding,
    estimateUsd: (candidate, inputTokens, outputTokens) => {
      const price = input.price(candidate);
      return price ? (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1e6 : 0.01;
    },
    complete: async (candidate, body, signal) => {
      const target = endpoint(candidate.endpoint);
      const started = Date.now();
      const response = await request(`${target.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify({
          model: candidate.model, max_tokens: MAX_OUTPUT_TOKENS,
          messages: [...(body.system ? [{ role: "system", content: body.system }] : []), ...body.messages],
          ...(body.json ? { response_format: { type: "json_object" } } : {}),
          ...(target.kind === "openrouter" ? { usage: { include: true } } : {}),
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      if ([400, 403, 404, 422].includes(response.status)) throw new ModelUnavailable(`${candidate.model} on ${candidate.endpoint}: HTTP ${response.status}`);
      if (!response.ok) throw new Error(`${candidate.model} on ${candidate.endpoint}: HTTP ${response.status}`);
      const data = await response.json() as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
        inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    },
  };
}
