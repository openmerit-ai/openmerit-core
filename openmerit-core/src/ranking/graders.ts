// Graders decide whether one case's output passes: exact match, a label, a JSON schema (with the
// case's expected fields), a judge rubric run by a fixed judge model, or parity with a trace case's
// recorded answer. The judge's calls are metered in the ledger under the case's key, and their cost
// is the grader's, not the candidate's. A trace case's expected value is the recorded assistant
// message; every grader compares with its text.
import { Ajv, type ValidateFunction } from "ajv";
import type { ModelClient } from "./clients.ts";
import { redact, type Ledger } from "../engine/index.ts";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { RefusedCall } from "./runner.ts";
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
  /** The tool calls the runner refused, in order. */
  refused?: readonly RefusedCall[];
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
  /** The spec's checks (C…, G…, S…) a failed case failed; absent when the grader names none, such as a wrong label. */
  failed?: string[];
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
  /**
   * Judge only the checks, when another grader already decided the rest: `guardrails` alone after a label
   * matched, `checks` (criteria and guardrails) after a JSON answer matched its schema and expected fields.
   */
  only?: "guardrails" | "checks";
  maxTokens?: number;
}

export const JUDGE_SYSTEM = [
  "You grade one answer a model gave for a task in an application.",
  "Apply the rubric and every check strictly. A reference answer, when given, shows what a right answer contains; the answer may word it differently.",
  "When the answer is an agent's run, it lists each step in order: what the model said, each tool it called and what that tool returned, then its final answer. Facts that come from a tool's result are grounded, wherever they appear; judge the final answer against the tool results it had.",
  "Reply with JSON only: {\"checks\": [{\"id\": \"C1\", \"pass\": true or false, \"reason\": \"one short sentence\"}], \"pass\": true or false, \"reason\": \"one short sentence\"}. \"checks\" has one entry per listed check; \"pass\" is true only when the answer meets the rubric and passes every check, and \"reason\" says why not when it does not.",
].join("\n");

/** The judge's rubric for a task: what it is for, from its spec, not where it was found. */
export function rubricFor(bundle: TaskBundle): string {
  const what = bundle.description?.trim() || `the task "${bundle.task}"`;
  return `The answer does what the application needs from this call: ${what}${bundle.input?.description ? ` Its input is ${bundle.input.description.replace(/\.$/, "")}.` : ""}`;
}

/** The checks a case's answer is judged on: one per criterion (C1…) and one per guardrail (G1…). */
export function checksFor(bundle: TaskBundle, only?: JudgeOptions["only"]): { id: string; text: string }[] {
  return [
    ...(only === "guardrails" ? [] : (bundle.criteria ?? []).map((text, index) => ({ id: `C${index + 1}`, text }))),
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

/** Thrown by a grader that cannot grade a case at all, such as when the judge's provider filters it: the case is left out for every model. */
export class Ungradable extends Error {
  override readonly name = "Ungradable";
}

/**
 * Passes when the judge model says the output meets the task's rubric and every check: one per
 * criterion and per guardrail in the bundle's spec. Throws when the judge cannot answer.
 */
export function judge(options: JudgeOptions): Grader {
  return {
    async grade({ bundle, caseItem, output, toolCalls, transcript, ledger, key, signal }) {
      const expected = options.only ? undefined : isAssistantMessage(caseItem.expected) ? describeAnswer(contentText(caseItem.expected.content), toolCallsOf(caseItem.expected)) : caseItem.expected;
      const input = caseItem.origin === "trace" ? caseItem.input.messages ?? "" : JSON.stringify(caseItem.input, null, 2);
      const checks = checksFor(bundle, options.only);
      const prompt = [
        `Task: ${bundle.task}`,
        `Rubric: ${options.only === "guardrails" ? "The answer breaks none of the checks below." : options.only === "checks" ? "The answer passes every check below." : options.rubric ?? rubricFor(bundle)}`,
        ...(checks.length ? [`Checks:\n${checks.map(check => `${check.id}. ${check.text}`).join("\n")}`] : []),
        `Input:\n${input}`,
        ...(expected === undefined ? [] : [`Reference answer:\n${typeof expected === "string" ? expected : JSON.stringify(expected)}`]),
        `Answer to grade:\n${caseItem.origin !== "trace" && toolCalls?.length && transcript?.length ? describeRun(transcript, output) : describeAnswer(output, toolCalls ?? [])}`,
      ].join("\n\n");
      const answer = await options.client.complete({
        endpoint: options.endpoint, model: options.model, system: JUDGE_SYSTEM, messages: [{ role: "user", content: prompt }], maxTokens: options.maxTokens ?? 2048,
      }, { ledger, key: `${key}/judge${options.only ? `-${options.only}` : ""}`, ...(signal ? { signal } : {}) });
      // The judge's provider refused the case itself, as it does for some guardrail cases: asking again gets the same refusal.
      if (!answer.ok && /content_filter/i.test(answer.error ?? "")) throw new Ungradable(`The judge ${options.model}'s provider refused to grade case ${caseItem.id} (content filter)`);
      const verdict = answer.ok ? readVerdict(answer.text, checks) : null;
      if (verdict === null) throw new Error(`The judge ${options.model} gave no verdict for case ${caseItem.id}${answer.error ? `: ${answer.error}` : ""}`);
      return { pass: verdict.pass, costUsd: answer.costUsd, costIsEstimate: answer.costIsEstimate, ...(verdict.pass ? {} : { reason: verdict.reason || "The judge failed the answer without a reason.", ...(verdict.failed.length ? { failed: verdict.failed } : {}) }) };
    },
  };
}

const toolCallsOf = (message: AssistantMessage): ToolCall[] =>
  (message.tool_calls ?? []).map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function.name, arguments: call.function.arguments }));

/** An answer as the judge reads it: its text, then any tool calls. */
const describeAnswer = (text: string, toolCalls: readonly ToolCall[]) =>
  [text, ...toolCalls.map(call => `Calls tool ${call.name} with ${call.arguments}`)].filter(Boolean).join("\n");

/** At most this much of one tool result goes to the judge. */
const TOOL_RESULT_CHARS = 2000;
const partsText = (content: unknown) => (Array.isArray(content) ? content.flatMap(part => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : [])).join("") : typeof content === "string" ? content : "");

/**
 * An agent's run as the judge reads it: after the prompt, each turn in order, with what it said, the
 * tools it called and what each returned, then its final answer. Without the tool results the judge
 * cannot tell an answer grounded in them from an invented one, and fails right answers.
 */
function describeRun(transcript: readonly PiMessage[], output: string): string {
  const lastPrompt = transcript.reduce((at, item, index) => (item.role === "user" ? index : at), -1);
  const lines: string[] = [];
  for (const item of transcript.slice(lastPrompt + 1)) {
    if (item.role === "assistant") {
      for (const part of item.content) {
        if (part.type === "text" && part.text.trim()) lines.push(`Says: ${part.text.trim()}`);
        if (part.type === "toolCall") lines.push(`Calls tool ${part.name} with ${JSON.stringify(part.arguments)}`);
      }
    } else if (item.role === "toolResult") {
      const text = partsText(item.content);
      lines.push(`Tool ${item.toolName} ${item.isError ? "failed" : "returned"}: ${text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS - 1)}…` : text}`);
    }
  }
  return [...lines, `Final answer: ${output.trim() || "(none)"}`].join("\n");
}

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

/** One step check (S1…): a spec step that must happen, or that must come after earlier steps. Numbers are 1-based, as in `after`. */
export interface StepCheck { id: string; step: number; description: string; tools: string[]; required: boolean; after: number[] }

/**
 * The step checks a bundle's spec asks for: one per step that is `required` or has `after`, named S
 * and its step number. A step that lists no tools cannot be seen in a transcript, so it is returned
 * in `unchecked` instead, and never fails a case.
 */
export function stepChecksFor(bundle: TaskBundle): { checks: StepCheck[]; unchecked: StepCheck[] } {
  const all = (bundle.steps ?? []).flatMap((step, index): StepCheck[] => {
    const after = (step.after ?? []).filter(number => Number.isInteger(number) && number >= 1 && number <= index);
    return step.required || after.length ? [{ id: `S${index + 1}`, step: index + 1, description: step.description, tools: step.tools ?? [], required: !!step.required, after }] : [];
  });
  return { checks: all.filter(check => check.tools.length), unchecked: all.filter(check => !check.tools.length) };
}

/** The checks a case is graded on, for the report's "Based on": C… and G… by the judge, S… on each case's tool calls. */
export function checksBasedOn(bundle: TaskBundle): string | null {
  const ids = (prefix: string, count: number) => (count === 1 ? `${prefix}1` : `${prefix}1–${prefix}${count}`);
  const { checks, unchecked } = stepChecksFor(bundle);
  const parts = [
    ...(bundle.criteria?.length ? [`${ids("C", bundle.criteria.length)} (criteria)`] : []),
    ...(bundle.guardrails?.length ? [`${ids("G", bundle.guardrails.length)} (guardrails)`] : []),
    ...(checks.length ? [`${checks.map(check => check.id).join(", ")} (the spec's steps, on each case's tool calls)`] : []),
  ];
  const note = unchecked.length ? ` ${unchecked.map(check => check.id).join(", ")} ${unchecked.length === 1 ? "lists" : "list"} no tools, so ${unchecked.length === 1 ? "it is" : "they are"} not checked.` : "";
  return parts.length || note ? `Checks: ${parts.join("; ") || "none"}.${note}` : null;
}

/**
 * The first failed step check on the tool calls that answered, as "S2: …"; null when all pass. A step
 * happens at its first answered call to one of its tools. A step with `after` must have a call after
 * each earlier step it names has happened; an earlier step that lists no tools cannot be ordered.
 */
function failedStep(bundle: TaskBundle, checks: readonly StepCheck[], answered: readonly ToolCall[]): string | null {
  const steps = bundle.steps ?? [];
  const toolsOf = (number: number) => steps[number - 1]?.tools ?? [];
  const firstOf = (number: number) => answered.findIndex(call => toolsOf(number).includes(call.name));
  for (const check of checks) {
    const calls = answered.flatMap((call, index) => (check.tools.includes(call.name) ? [index] : []));
    if (!calls.length) {
      if (check.required) return `${check.id}: it never called ${check.tools.join(" or ")} (${check.description}).`;
      continue;
    }
    for (const number of check.after) {
      if (!toolsOf(number).length) continue;
      const before = firstOf(number);
      if (before < 0 || before > calls.at(-1)!) return `${check.id}: it called ${check.tools.join(" or ")} before step ${number} (${steps[number - 1]!.description}).`;
    }
  }
  return null;
}

/**
 * An agent's whole flow, from the case's transcript:
 * - a call to a tool the task does not offer fails the case: the model invented a tool;
 * - a call whose arguments the tool's schema refuses, or that no `when` of its mock matches, does not
 *   fail it alone: the error went back as the tool's result, as a real API's would, and the case can
 *   still pass if the model then calls that tool again and it answers. One it never fixed fails it;
 * - every step check (S…) from the spec must pass;
 * then `output` grades the answer. A call to a tool with no mocked result is the eval's defect, not
 * the model's: `invalidCases` leaves such cases out before anything runs.
 */
export function flow(output: Grader): Grader {
  return {
    async grade(input) {
      const refused = input.refused ?? [];
      const invented = refused.find(call => call.kind === "unknown_tool");
      if (invented) return free(false, `It called ${invented.tool}, a tool the task does not offer.`);
      const calls = input.toolCalls ?? [], ids = new Set(refused.map(call => call.id));
      const answered = calls.filter(call => !ids.has(call.id));
      // A refused call is fixed by a later call to the same tool that answered.
      const unfixed = refused.find(call => {
        const at = calls.findIndex(item => item.id === call.id);
        return !calls.some((later, index) => index > at && later.name === call.tool && !ids.has(later.id));
      });
      if (unfixed) {
        return free(false, unfixed.kind === "invalid_arguments" ? `Its call to ${unfixed.tool} was refused for its arguments, and it never called it again correctly.`
          : unfixed.kind === "no_match" ? `Its call to ${unfixed.tool} found nothing for its arguments, and it never called it again with ones that did.` : `It called ${unfixed.tool}, which the eval has no mocked result for.`);
      }
      const step = failedStep(input.bundle, stepChecksFor(input.bundle).checks, answered);
      if (step) return { ...free(false, step), failed: [step.split(":")[0]!] };
      return output.grade(input);
    },
  };
}

const outputGrader = (bundle: TaskBundle, judgeOptions?: JudgeOptions): Grader =>
  bundle.output.kind === "label" ? labelMatch() : bundle.output.kind === "json" ? jsonSchema() : judgeOptions ? judge(judgeOptions) : exactMatch();

/**
 * `first`, then, when it passes, the judge on the bundle's checks: a right label can still break a guardrail, and
 * a JSON answer that matches its schema and the fields a case expects can still miss a criterion.
 */
const thenChecks = (first: Grader, judgeOptions: JudgeOptions, only: NonNullable<JudgeOptions["only"]>): Grader => ({
  async grade(input) {
    const decided = await first.grade(input);
    if (!decided.pass) return decided;
    const checked = await judge({ ...judgeOptions, only }).grade(input);
    return { ...checked, costUsd: decided.costUsd + checked.costUsd, costIsEstimate: decided.costIsEstimate || checked.costIsEstimate };
  },
});

/**
 * The grader a bundle's output calls for: its labels, its JSON schema, or for text the judge when one
 * is given (on the task's rubric, its criteria and its guardrails), else an exact match. When a judge
 * is given, a label that is right is also judged on the spec's guardrails, and a JSON answer that is
 * right on its criteria and guardrails. Trace cases are graded by parity with their recorded answer.
 */
export function graderFor(bundle: TaskBundle, options: { judge?: JudgeOptions } = {}): Grader {
  const base = outputGrader(bundle, options.judge);
  const only = bundle.output.kind === "json" ? "checks" : "guardrails";
  const output = options.judge && bundle.output.kind !== "text" && checksFor(bundle, only).length ? thenChecks(base, options.judge, only) : base;
  const trace = parity({ text: output });
  // Trace cases are graded by parity with what they recorded, other cases by the output's grader.
  return { grade: input => (input.caseItem.origin === "trace" ? trace : output).grade(input) };
}
