// Graders decide whether one case's output passes: exact match, a label, a JSON schema (with the
// case's expected fields), a judge rubric run by a fixed judge model, or parity with a trace case's
// recorded answer. The judge's calls are metered in the ledger under the case's key, and their cost
// is the grader's, not the candidate's. A trace case's expected value is the recorded assistant
// message; every grader compares with its text.
import { Ajv, type ValidateFunction } from "ajv";
import type { ModelClient } from "./clients.ts";
import type { Ledger } from "../engine/index.ts";
import type { Case, TaskBundle, ToolCall } from "./types.ts";

export interface GradeInput {
  bundle: TaskBundle;
  caseItem: Case;
  /** The candidate's final text. Graders never return it. */
  output: string;
  /** A trace case's tool calls in the candidate's answer; absent or empty otherwise. */
  toolCalls?: readonly ToolCall[];
  ledger: Ledger;
  /** The case's idempotency key; a grader that calls a model meters under keys below it. */
  key: string;
  signal?: AbortSignal;
}

export interface Grade {
  pass: boolean;
  /** What grading cost, such as the judge's calls; 0 for graders that call no model. */
  costUsd: number;
  costIsEstimate: boolean;
}

export interface Grader { grade(input: GradeInput): Promise<Grade> }

/** A recorded assistant message, as a trace case's `expected` holds it. */
export interface AssistantMessage { role: "assistant"; content: unknown; tool_calls?: { id?: string; type?: string; function: { name: string; arguments: string } }[] }

export const isAssistantMessage = (value: unknown): value is AssistantMessage =>
  !!value && typeof value === "object" && !Array.isArray(value) && (value as { role?: unknown }).role === "assistant";

const contentText = (content: unknown): string => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("") : "");

/** What a case expects, with a recorded assistant message read as its text. */
const expectedOf = (caseItem: Case): unknown => (isAssistantMessage(caseItem.expected) ? contentText(caseItem.expected.content) : caseItem.expected);

const free = (pass: boolean): Grade => ({ pass, costUsd: 0, costIsEstimate: false });
const normalize = (text: string, caseSensitive: boolean) => {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return caseSensitive ? collapsed : collapsed.toLowerCase();
};

/** Passes when the output equals the case's expected text, ignoring surrounding and repeated whitespace (and case, unless `caseSensitive`). */
export function exactMatch(options: { caseSensitive?: boolean } = {}): Grader {
  return {
    async grade({ caseItem, output }) {
      const expected = expectedOf(caseItem);
      if (typeof expected !== "string") throw new Error(`Case ${caseItem.id} has no expected text for an exact match`);
      return free(normalize(output, options.caseSensitive ?? false) === normalize(expected, options.caseSensitive ?? false));
    },
  };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The bundle's label the output gives: the whole output, without quotes, Markdown or a final full stop,
 * or else the one label it names as a whole word. Null when it names none or more than one.
 */
export function readLabel(output: string, labels: readonly string[]): string | null {
  const bare = output.trim().replace(/^[\s"'`*_]+|[\s"'`*_.!]+$/g, "").toLowerCase();
  const exact = labels.find(label => label.toLowerCase() === bare);
  if (exact) return exact;
  const named = labels.filter(label => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escape(label.toLowerCase())}($|[^\\p{L}\\p{N}_-])`, "u").test(output.toLowerCase()));
  return named.length === 1 ? named[0]! : null;
}

/** Passes when the output gives exactly the case's expected label. */
export function labelMatch(): Grader {
  return {
    async grade({ bundle, caseItem, output }) {
      if (bundle.output.kind !== "label") throw new Error("labelMatch needs a bundle whose output is a label");
      const recorded = expectedOf(caseItem);
      if (typeof recorded !== "string") throw new Error(`Case ${caseItem.id} has no expected label`);
      // A recorded answer is itself read as a label, so "Billing." expects billing.
      const expected = (isAssistantMessage(caseItem.expected) ? readLabel(recorded, bundle.output.labels) ?? recorded : recorded).toLowerCase();
      return free(readLabel(output, bundle.output.labels)?.toLowerCase() === expected);
    },
  };
}

/** The JSON value in a model's answer: the whole text, a fenced block, or the outermost object or array. */
export function readJson(output: string): { ok: true; value: unknown } | { ok: false } {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(output)?.[1];
  const tries = [output.trim(), fenced?.trim()];
  const open = output.search(/[{[]/), close = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
  if (open >= 0 && close > open) tries.push(output.slice(open, close + 1));
  for (const text of tries) {
    if (!text) continue;
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { /* next */ }
  }
  return { ok: false };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a as object);
  return keys.length === Object.keys(b as object).length && keys.every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Passes when the output is JSON that the bundle's schema accepts and that matches the case's expected
 * value: every field an expected object names must be equal, other fields may be anything.
 */
export function jsonSchema(): Grader {
  const ajv = new Ajv({ strict: false, allErrors: false });
  const compiled = new WeakMap<object, ValidateFunction>();
  return {
    async grade({ bundle, caseItem, output }) {
      if (bundle.output.kind !== "json") throw new Error("jsonSchema needs a bundle whose output is JSON");
      const schema = bundle.output.schema;
      let validate = compiled.get(schema);
      if (!validate) { validate = ajv.compile(schema); compiled.set(schema, validate); }
      const parsed = readJson(output);
      if (!parsed.ok || !validate(parsed.value)) return free(false);
      // A recorded answer is JSON text: the candidate's must equal it, field by field.
      const recorded = isAssistantMessage(caseItem.expected) ? readJson(expectedOf(caseItem) as string) : null;
      const expected = recorded ? (recorded.ok ? recorded.value : undefined) : caseItem.expected;
      if (expected === undefined) return free(true);
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const value = parsed.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) return free(false);
        return free(Object.entries(expected).every(([key, item]) => deepEqual((value as Record<string, unknown>)[key], item)));
      }
      return free(deepEqual(parsed.value, expected));
    },
  };
}

export interface JudgeOptions {
  client: ModelClient;
  /** The fixed judge: the same model grades every candidate. */
  endpoint: string;
  model: string;
  /** What a passing answer does, in plain words. */
  rubric: string;
  maxTokens?: number;
}

export const JUDGE_SYSTEM = [
  "You grade one answer a model gave for a task in an application.",
  "Apply the rubric strictly. A reference answer, when given, shows what a right answer contains; the answer may word it differently.",
  "Reply with JSON only: {\"pass\": true or false, \"reason\": \"one short sentence\"}.",
].join("\n");

/** Reads the judge's verdict; null when it gave none. */
export function readVerdict(text: string): boolean | null {
  const parsed = readJson(text);
  if (parsed.ok && parsed.value && typeof parsed.value === "object" && typeof (parsed.value as { pass?: unknown }).pass === "boolean") return (parsed.value as { pass: boolean }).pass;
  const match = /"?pass"?\s*[:=]\s*(true|false)/i.exec(text);
  return match ? match[1]!.toLowerCase() === "true" : null;
}

/** Passes when the judge model says the output meets the rubric. Throws when the judge cannot answer. */
export function judge(options: JudgeOptions): Grader {
  return {
    async grade({ bundle, caseItem, output, toolCalls, ledger, key, signal }) {
      const expected = isAssistantMessage(caseItem.expected) ? describeAnswer(contentText(caseItem.expected.content), toolCallsOf(caseItem.expected)) : caseItem.expected;
      const input = caseItem.origin === "trace" ? caseItem.input.messages ?? "" : JSON.stringify(caseItem.input, null, 2);
      const prompt = [
        `Task: ${bundle.task}${bundle.description ? ` (${bundle.description})` : ""}`,
        `Rubric: ${options.rubric}`,
        `Input:\n${input}`,
        ...(expected === undefined ? [] : [`Reference answer:\n${typeof expected === "string" ? expected : JSON.stringify(expected)}`]),
        `Answer to grade:\n${describeAnswer(output, toolCalls ?? [])}`,
      ].join("\n\n");
      const answer = await options.client.complete({
        endpoint: options.endpoint, model: options.model, system: JUDGE_SYSTEM, messages: [{ role: "user", content: prompt }], maxTokens: options.maxTokens ?? 2048,
      }, { ledger, key: `${key}/judge`, ...(signal ? { signal } : {}) });
      const verdict = answer.ok ? readVerdict(answer.text) : null;
      if (verdict === null) throw new Error(`The judge ${options.model} gave no verdict for case ${caseItem.id}${answer.error ? `: ${answer.error}` : ""}`);
      return { pass: verdict, costUsd: answer.costUsd, costIsEstimate: answer.costIsEstimate };
    },
  };
}

const toolCallsOf = (message: AssistantMessage): ToolCall[] =>
  (message.tool_calls ?? []).map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function.name, arguments: call.function.arguments }));

/** An answer as the judge reads it: its text, then any tool calls. */
const describeAnswer = (text: string, toolCalls: readonly ToolCall[]) =>
  [text, ...toolCalls.map(call => `Calls tool ${call.name} with ${call.arguments}`)].filter(Boolean).join("\n");

const sameArguments = (a: string, b: string) => {
  try { return deepEqual(JSON.parse(a || "{}"), JSON.parse(b || "{}")); } catch { return a.trim() === b.trim(); }
};

/**
 * Parity with a trace case's recorded answer. When the recorded answer called tools, the candidate
 * must call the same tools, in order, with equal arguments. When it answered in text, the candidate
 * must answer in text too, and `text` grades that answer against the recorded one (the bundle's
 * output grader by default).
 */
export function parity(options: { text?: Grader } = {}): Grader {
  return {
    async grade(input) {
      const { bundle, caseItem, toolCalls = [] } = input;
      if (!isAssistantMessage(caseItem.expected)) throw new Error(`Case ${caseItem.id} has no recorded answer to compare with`);
      const recorded = toolCallsOf(caseItem.expected);
      if (recorded.length) {
        return free(toolCalls.length === recorded.length && recorded.every((call, index) => toolCalls[index]!.name === call.name && sameArguments(toolCalls[index]!.arguments, call.arguments)));
      }
      if (toolCalls.length) return free(false);
      return (options.text ?? outputGrader(bundle)).grade(input);
    },
  };
}

const outputGrader = (bundle: TaskBundle, judgeOptions?: JudgeOptions): Grader =>
  bundle.output.kind === "label" ? labelMatch() : bundle.output.kind === "json" ? jsonSchema() : judgeOptions ? judge(judgeOptions) : exactMatch();

/**
 * The grader a bundle's output calls for: its labels, its JSON schema, or for text the judge when one
 * is given, else an exact match. Trace cases are graded by parity with their recorded answer.
 */
export function graderFor(bundle: TaskBundle, options: { judge?: JudgeOptions } = {}): Grader {
  const output = outputGrader(bundle, options.judge);
  const trace = parity({ text: output });
  // Trace cases are graded by parity with what they recorded, other cases by the output's grader.
  return { grade: input => (input.caseItem.origin === "trace" ? trace : output).grade(input) };
}
