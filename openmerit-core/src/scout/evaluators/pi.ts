import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { Candidate } from "../candidates.ts";
import { setTimeout as delay } from "node:timers/promises";
import { CandidateUnavailable, type EvalItem, type Evaluate, type Outcome } from "../search.ts";

/** What the Pi evaluator needs from Pi: a `ModelRuntime`, or an extension's `ctx.modelRegistry` through `fromRegistry`. */
export interface ModelCaller {
  getModel(provider: string, id: string): Model<Api> | undefined;
  complete(model: Model<Api>, context: Context, options?: { signal?: AbortSignal; maxTokens?: number; apiKey?: string }): Promise<AssistantMessage>;
}

export type Grader =
  /** Normalized text equality with `expectedOutput` (or `expectedOutput[field]`). */
  | { type: "exact"; field?: string }
  /** The output contains the expected text, case-insensitively. */
  | { type: "contains"; field?: string }
  /** The output's JSON contains every expected field with an equal value (strings compared case-insensitively, arrays as sets). */
  | { type: "json" }
  /** A judge model answers PASS or FAIL for the output against the expected output and rubric. */
  | { type: "judge"; rubric: string; model?: string };

export interface PiTaskSpec {
  /** The candidate's system prompt: the instructions the production model receives. */
  systemPrompt: string;
  /** Optional template for the user message; `{{input}}` is the item's input as text or JSON. */
  inputTemplate?: string;
  grader: Grader;
  maxTokens?: number;
}

const text = (message: AssistantMessage) => message.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();

/** The first JSON object or array in a reply, with code fences removed. */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
  const start = fenced.search(/[[{]/);
  if (start < 0) return undefined;
  for (let end = fenced.length; end > start; end--) {
    try { return JSON.parse(fenced.slice(start, end)); } catch { /* shorten */ }
  }
  return undefined;
}

/** Every expected field matches: objects by key, arrays as sets, strings case-insensitively. */
export function jsonMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "string" && typeof actual === "string") return normalize(expected) === normalize(actual);
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every(item => actual.some(other => jsonMatches(item, other)));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => jsonMatches(value, (actual as Record<string, unknown>)[key]));
}

const field = (expected: unknown, name?: string) =>
  asText(name && expected && typeof expected === "object" ? (expected as Record<string, unknown>)[name] : expected);

/** Messages with a provider error are infrastructure failures, not quality verdicts. */
function ensureOk(message: AssistantMessage, what: string) {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`${what}: ${message.errorMessage ?? message.stopReason}`);
}

const status = (message: AssistantMessage) => Number(/^(\d{3})\b/.exec(message.errorMessage ?? "")?.[1] ?? 0);

/**
 * One call with retries for transient provider errors (429, 5xx, network), waiting 5, 20 and 60 s.
 * A model the provider rejects (400, 404) or the balance cannot cover (402) is unavailable, not failed.
 */
async function call(caller: ModelCaller, model: Model<Api>, context: Context, options: { signal?: AbortSignal; maxTokens?: number }, what: string, unavailable: boolean, waits: readonly number[]) {
  for (const wait of [...waits, -1]) {
    const reply = await caller.complete(model, context, options);
    if (reply.stopReason !== "error") return reply;
    const code = status(reply);
    if (unavailable && [400, 402, 404, 413, 422].includes(code)) throw new CandidateUnavailable(`${what}: ${(reply.errorMessage ?? "").slice(0, 240)}`);
    if (wait < 0 || (code !== 0 && code !== 429 && code < 500)) return reply;
    await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
  }
  throw new Error("unreachable");
}

function resolve(caller: ModelCaller, ref: string): Model<Api> {
  const slash = ref.indexOf("/");
  const model = slash > 0 ? caller.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
  if (!model) throw new Error(`Model ${ref} is not available with the connected providers`);
  return model;
}

/**
 * Runs each item as one model call through Pi, so any provider Pi connects (API key or
 * subscription) can be a candidate, then grades the reply. Tool-using agents need an
 * evaluator module that runs the real harness instead.
 */
export function piEvaluator(caller: ModelCaller, spec: PiTaskSpec, options: { judgeModel?: string; retryDelaysMs?: number[] } = {}): Evaluate {
  const waits = options.retryDelaysMs ?? [5_000, 20_000, 60_000];
  return async (candidate: Candidate, item: EvalItem, context): Promise<Omit<Outcome, "itemId">> => {
    const model = resolve(caller, candidate.model);
    const input = asText(item.input);
    const user = spec.inputTemplate ? spec.inputTemplate.replaceAll("{{input}}", input) : input;
    const reply = await call(caller, model, { systemPrompt: spec.systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { ...(context.signal ? { signal: context.signal } : {}), maxTokens: spec.maxTokens ?? 4096 }, candidate.model, true, waits);
    ensureOk(reply, candidate.model);
    const output = text(reply);
    const usage = { input: reply.usage.input, output: reply.usage.output, total: reply.usage.totalTokens };
    const graded = await grade(spec.grader, item, output, caller, options.judgeModel, waits, context.signal);
    return { pass: graded.pass, comment: graded.comment, output, costUsd: reply.usage.cost.total, usage, ...(reply.durationMs ? { latencyMs: reply.durationMs } : {}) };
  };
}

async function grade(grader: Grader, item: EvalItem, output: string, caller: ModelCaller, judgeModel: string | undefined, waits: readonly number[], signal?: AbortSignal) {
  switch (grader.type) {
    case "exact": {
      const expected = field(item.expectedOutput, grader.field);
      return { pass: normalize(output) === normalize(expected), comment: `expected "${expected.slice(0, 80)}"` };
    }
    case "contains": {
      const expected = field(item.expectedOutput, grader.field);
      return { pass: normalize(output).includes(normalize(expected)), comment: `expected to contain "${expected.slice(0, 80)}"` };
    }
    case "json": {
      const parsed = extractJson(output);
      if (parsed === undefined) return { pass: false, comment: "reply has no JSON" };
      const pass = jsonMatches(item.expectedOutput, parsed);
      return { pass, comment: pass ? "every expected field matches" : `expected ${JSON.stringify(item.expectedOutput).slice(0, 160)}` };
    }
    case "judge": {
      const ref = grader.model ?? judgeModel;
      if (!ref) throw new Error("The judge grader needs a judge model (--judge-model or the Scout model)");
      const verdict = await call(caller, resolve(caller, ref), {
        systemPrompt: "You grade one model output against a labelled expected output. Reply with JSON only: {\"pass\": true|false, \"reason\": \"<one sentence>\"}. Pass only if the output satisfies the rubric and agrees with the expected output on every point the rubric names.",
        messages: [{ role: "user", content: `Rubric:\n${grader.rubric}\n\nInput:\n${asText(item.input)}\n\nExpected output:\n${asText(item.expectedOutput)}\n\nModel output:\n${output}`, timestamp: Date.now() }],
      }, { ...(signal ? { signal } : {}), maxTokens: 1024 }, `judge ${ref}`, false, waits);
      ensureOk(verdict, `judge ${ref}`);
      const parsed = extractJson(text(verdict)) as { pass?: unknown; reason?: unknown } | undefined;
      if (typeof parsed?.pass !== "boolean") throw new Error(`Judge ${ref} returned no verdict`);
      return { pass: parsed.pass, comment: `judge: ${typeof parsed.reason === "string" ? parsed.reason : ""}` };
    }
  }
}
