// Graders decide whether one case's output passes: exact match, a label, a JSON schema (with the
// case's expected fields), a judge rubric run by a fixed judge model, or parity with a trace case's
// recorded answer. The judge's calls are metered in the ledger under the case's key, and their cost
// is the grader's, not the candidate's. A trace case's expected value is the recorded assistant
// message; every grader compares with its text.
import { Ajv, type ValidateFunction } from "ajv";
import type { ModelClient } from "./clients.ts";
import { redact, type Ledger } from "../engine/index.ts";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Case, TaskBundle, ToolCall } from "./types.ts";

export interface GradeInput {
  bundle: TaskBundle;
  caseItem: Case;
  /** The candidate's final text. Graders never return it. */
  output: string;
  /** Every tool call the candidate made, in order; a trace case's are those of its one answer. */
  toolCalls?: readonly ToolCall[];
  /** The case's Pi transcript: the prompt, then each answer and tool result in order. */
  transcript?: readonly PiMessage[];
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
  /** Why a failed case failed, in one redacted sentence; absent when it passed. */
  reason?: string;
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

const free = (pass: boolean, reason?: string): Grade => ({ pass, costUsd: 0, costIsEstimate: false, ...(pass || !reason ? {} : { reason: oneSentence(reason) }) });
const quote = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 59)}…` : text);
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
      return free(normalize(output, options.caseSensitive ?? false) === normalize(expected, options.caseSensitive ?? false), `Answered ${quote(output.trim())}, not the expected ${quote(expected.trim())}.`);
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
      const given = readLabel(output, bundle.output.labels);
      return free(given?.toLowerCase() === expected, given ? `Answered ${given}, expected ${expected}.` : `Named no single label (answered ${quote(output.trim())}), expected ${expected}.`);
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
      if (!parsed.ok) return free(false, "The answer is not JSON.");
      if (!validate(parsed.value)) return free(false, `The JSON does not match the schema: ${ajv.errorsText(validate.errors)}.`);
      // A recorded answer is JSON text: the candidate's must equal it, field by field.
      const recorded = isAssistantMessage(caseItem.expected) ? readJson(expectedOf(caseItem) as string) : null;
      const expected = recorded ? (recorded.ok ? recorded.value : undefined) : caseItem.expected;
      if (expected === undefined) return free(true);
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const value = parsed.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) return free(false, "The JSON is not an object.");
        const wrong = Object.entries(expected).filter(([key, item]) => !deepEqual((value as Record<string, unknown>)[key], item)).map(([key]) => key);
        return free(!wrong.length, `Wrong ${wrong.length === 1 ? "field" : "fields"} ${wrong.join(", ")}: expected ${wrong.map(key => `${key}=${JSON.stringify((expected as Record<string, unknown>)[key])}`).join(", ")}.`);
      }
      return free(deepEqual(parsed.value, expected), "The JSON differs from the expected value.");
    },
  };
}

export interface JudgeOptions {
  client: ModelClient;
  /** The fixed judge: the same model grades every candidate. */
  endpoint: string;
  model: string;
  /** What a passing answer does, in plain words; by default the task itself (`rubricFor`). */
  rubric?: string;
  /** Judge only the guardrails, when another grader already decided the rest. */
  only?: "guardrails";
  maxTokens?: number;
}

export const JUDGE_SYSTEM = [
  "You grade one answer a model gave for a task in an application.",
  "Apply the rubric and every check strictly. A reference answer, when given, shows what a right answer contains; the answer may word it differently.",
  "Reply with JSON only: {\"checks\": [{\"id\": \"C1\", \"pass\": true or false, \"reason\": \"one short sentence\"}], \"pass\": true or false, \"reason\": \"one short sentence\"}. \"checks\" has one entry per listed check; \"pass\" is true only when the answer meets the rubric and passes every check, and \"reason\" says why not when it does not.",
].join("\n");

/** The judge's rubric for a task: what it is for, from its spec, not where it was found. */
export function rubricFor(bundle: TaskBundle): string {
  const what = bundle.description?.trim() || `the task "${bundle.task}"`;
  return `The answer does what the application needs from this call: ${what}${bundle.input?.description ? ` Its input is ${bundle.input.description.replace(/\.$/, "")}.` : ""}`;
}

/** The checks a case's answer is judged on: one per criterion (C1…) and one per guardrail (G1…). */
export function checksFor(bundle: TaskBundle, only?: "guardrails"): { id: string; text: string }[] {
  return [
    ...(only ? [] : (bundle.criteria ?? []).map((text, index) => ({ id: `C${index + 1}`, text }))),
    ...(bundle.guardrails ?? []).map((text, index) => ({ id: `G${index + 1}`, text: `Never: ${text}` })),
  ];
}

export interface Verdict { pass: boolean; reason: string; failed: string[] }

/** Reads the judge's verdict; null when it gave none. A listed check it failed fails the answer. */
export function readVerdict(text: string, checks: readonly { id: string }[] = []): Verdict | null {
  const parsed = readJson(text);
  const value = parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value as { pass?: unknown; reason?: unknown; checks?: unknown } : null;
  let pass: boolean | null = typeof value?.pass === "boolean" ? value.pass : null;
  if (pass === null) {
    const match = /"?pass"?\s*[:=]\s*(true|false)/i.exec(text);
    if (match) pass = match[1]!.toLowerCase() === "true";
  }
  if (pass === null) return null;
  const listed = Array.isArray(value?.checks) ? value.checks as { id?: unknown; pass?: unknown; reason?: unknown }[] : [];
  const failed = listed.filter(item => item && item.pass === false && typeof item.id === "string" && checks.some(check => check.id === item.id));
  const reason = failed.length ? failed.map(item => `${item.id}: ${typeof item.reason === "string" ? item.reason : "failed"}`).join(" ") : typeof value?.reason === "string" ? value.reason : "";
  return { pass: pass && !failed.length, reason: oneSentence(reason), failed: failed.map(item => item.id as string) };
}

/** A grader's reason as stored: redacted, on one line, at most 200 characters. */
export const oneSentence = (text: string) => { const line = redact(text).replace(/\s+/g, " ").trim(); return line.length > 200 ? `${line.slice(0, 199)}…` : line; };

/**
 * Passes when the judge model says the output meets the task's rubric and every check: one per
 * criterion and per guardrail in the bundle's spec. Throws when the judge cannot answer.
 */
export function judge(options: JudgeOptions): Grader {
  return {
    async grade({ bundle, caseItem, output, toolCalls, ledger, key, signal }) {
      const expected = options.only ? undefined : isAssistantMessage(caseItem.expected) ? describeAnswer(contentText(caseItem.expected.content), toolCallsOf(caseItem.expected)) : caseItem.expected;
      const input = caseItem.origin === "trace" ? caseItem.input.messages ?? "" : JSON.stringify(caseItem.input, null, 2);
      const checks = checksFor(bundle, options.only);
      const prompt = [
        `Task: ${bundle.task}`,
        `Rubric: ${options.only ? "The answer breaks none of the checks below." : options.rubric ?? rubricFor(bundle)}`,
        ...(checks.length ? [`Checks:\n${checks.map(check => `${check.id}. ${check.text}`).join("\n")}`] : []),
        `Input:\n${input}`,
        ...(expected === undefined ? [] : [`Reference answer:\n${typeof expected === "string" ? expected : JSON.stringify(expected)}`]),
        `Answer to grade:\n${describeAnswer(output, toolCalls ?? [])}`,
      ].join("\n\n");
      const answer = await options.client.complete({
        endpoint: options.endpoint, model: options.model, system: JUDGE_SYSTEM, messages: [{ role: "user", content: prompt }], maxTokens: options.maxTokens ?? 2048,
      }, { ledger, key: `${key}/judge${options.only ? "-guardrails" : ""}`, ...(signal ? { signal } : {}) });
      const verdict = answer.ok ? readVerdict(answer.text, checks) : null;
      if (verdict === null) throw new Error(`The judge ${options.model} gave no verdict for case ${caseItem.id}${answer.error ? `: ${answer.error}` : ""}`);
      return { pass: verdict.pass, costUsd: answer.costUsd, costIsEstimate: answer.costIsEstimate, ...(verdict.pass ? {} : { reason: verdict.reason || "The judge failed the answer without a reason." }) };
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
        const same = toolCalls.length === recorded.length && recorded.every((call, index) => toolCalls[index]!.name === call.name && sameArguments(toolCalls[index]!.arguments, call.arguments));
        const names = (calls: readonly { name: string }[]) => calls.map(call => call.name).join(", ");
        return free(same, names(toolCalls) === names(recorded) ? `Called ${names(toolCalls)} with other arguments than the recorded call.` : `Called ${names(toolCalls) || "no tool"}, not ${names(recorded)}.`);
      }
      if (toolCalls.length) return free(false, `Called ${toolCalls.map(call => call.name).join(", ")} where the recorded answer was text.`);
      return (options.text ?? outputGrader(bundle)).grade(input);
    },
  };
}

/**
 * An agent's whole flow: passes when `output` passes the answer and every tool call in the transcript
 * ran, so none named a tool the task does not offer, had arguments its schema refuses, or reached a
 * tool with no mocked result. A model that recovers from a refused call still fails the flow.
 */
export function flow(output: Grader): Grader {
  return {
    async grade(input) {
      const refused = (input.transcript ?? []).filter(item => item.role === "toolResult" && item.isError).length;
      return refused ? free(false) : output.grade(input);
    },
  };
}

const outputGrader = (bundle: TaskBundle, judgeOptions?: JudgeOptions): Grader =>
  bundle.output.kind === "label" ? labelMatch() : bundle.output.kind === "json" ? jsonSchema() : judgeOptions ? judge(judgeOptions) : exactMatch();

/** `first`, then, when it passes, the judge on the bundle's guardrails: a right label can still break one. */
const thenGuardrails = (first: Grader, judgeOptions: JudgeOptions): Grader => ({
  async grade(input) {
    const decided = await first.grade(input);
    if (!decided.pass) return decided;
    const checked = await judge({ ...judgeOptions, only: "guardrails" }).grade(input);
    return { ...checked, costUsd: decided.costUsd + checked.costUsd, costIsEstimate: decided.costIsEstimate || checked.costIsEstimate };
  },
});

/**
 * The grader a bundle's output calls for: its labels, its JSON schema, or for text the judge when one
 * is given (on the task's rubric, its criteria and its guardrails), else an exact match. A label or
 * JSON answer that is right is also judged on the guardrails, when the spec has any and a judge is
 * given. Trace cases are graded by parity with their recorded answer.
 */
export function graderFor(bundle: TaskBundle, options: { judge?: JudgeOptions } = {}): Grader {
  const base = outputGrader(bundle, options.judge);
  const output = options.judge && bundle.output.kind !== "text" && bundle.guardrails?.length ? thenGuardrails(base, options.judge) : base;
  const trace = parity({ text: output });
  // Trace cases are graded by parity with what they recorded, other cases by the output's grader.
  return { grade: input => (input.caseItem.origin === "trace" ? trace : output).grade(input) };
}
