// The case writer: turns a task bundle into cases. The agent's examples come first, unchanged;
// then a model, through an injected completion function, writes more inputs with the answers it
// expects. Written cases that leave a placeholder empty, give a label the bundle does not have or
// repeat another case are dropped. The optional label check asks the user to confirm the written
// cases' expected answers, in the Question shape `openmerit_scout` uses.
import type { Answer, Question } from "../scout/workflow.ts";
import type { ModelClient } from "./clients.ts";
import type { Ledger } from "../engine/index.ts";
import { placeholders } from "./runner.ts";
import type { Case, CaseKind, TaskBundle } from "./types.ts";

/** One completion: the writer's system prompt and request in, the model's text out. */
export type Complete = (request: { system: string; prompt: string }) => Promise<string>;

/** A `Complete` that calls `target` through `client`, metering each call under `key/write-<n>`. */
export function completeWith(client: ModelClient, target: { endpoint: string; model: string; maxTokens?: number }, ledger: Ledger, key: string, signal?: AbortSignal): Complete {
  let calls = 0;
  return async ({ system, prompt }) => {
    const answer = await client.complete({ endpoint: target.endpoint, model: target.model, system, messages: [{ role: "user", content: prompt }], maxTokens: target.maxTokens ?? 8192 },
      { ledger, key: `${key}/write-${calls++}`, ...(signal ? { signal } : {}) });
    if (!answer.ok) throw new Error(`The case writer ${target.model} failed: ${answer.error ?? `HTTP ${answer.status}`}`);
    return answer.text;
  };
}

/** Cases written when the caller does not say; the examples come on top. */
export const WRITTEN_CASES = 12;
export const LABEL_CHECK_QUESTION = "label_check";

export const WRITER_SYSTEM = [
  "You write test cases for one model call in an application, to compare which models can do it.",
  "Write realistic inputs like the application would send, varied in content, length and difficulty, including edge cases. Do not copy the examples.",
  "For each input give the answer a correct model would give: the label, the JSON fields the input determines, or for text a short reference answer that meets every criterion.",
  "Give each case a kind: \"typical\" for an input like most production traffic, \"edge\" for an unusual or hard one, or \"guardrail\" for one that tempts the model to break a guardrail; its expected answer is what a correct model does instead.",
  "When the call offers tools, give in \"toolResults\" what each tool returns for this case, keyed by tool name, consistent with its input and expected answer; for a tool the case calls with different arguments, such as a lookup per code, give a list of {\"when\": {the call's arguments}, \"result\": ...}, with one entry without \"when\" for any other call.",
  "Reply with JSON only: {\"cases\": [{\"kind\": ..., \"input\": {...}, \"expected\": ..., \"toolResults\": {...}}]}.",
].join("\n");

function writerPrompt(bundle: TaskBundle, names: string[], count: number, guidance?: string): string {
  const output = bundle.output.kind === "label" ? `One of these labels, exactly: ${bundle.output.labels.join(", ")}. "expected" is that label.`
    : bundle.output.kind === "json" ? `JSON matching this schema:\n${JSON.stringify(bundle.output.schema)}\n"expected" is an object with only the fields whose value the input fully determines.`
      : "Free text. \"expected\" is a short reference answer a grader compares meaning against.";
  const guardrails = bundle.guardrails?.length ? Math.max(1, Math.round(count / 4)) : 0, edge = Math.max(1, Math.round(count / 4));
  return [
    `Task: ${bundle.task}${bundle.description ? `\n${bundle.description}` : ""}`,
    ...(bundle.input?.description ? [`Its input: ${bundle.input.description}`] : []),
    ...(bundle.steps?.length ? [`What the model does:\n${bundle.steps.map((item, index) => `${index + 1}. ${item.description}${item.tools?.length ? ` (tools: ${item.tools.join(", ")})` : ""}`).join("\n")}`] : []),
    ...(bundle.criteria?.length ? [`A right answer:\n${bundle.criteria.map(item => `- ${item}`).join("\n")}`] : []),
    ...(bundle.guardrails?.length ? [`Guardrails, which the model must never break:\n${bundle.guardrails.map(item => `- ${item}`).join("\n")}`] : []),
    `The application's prompt, with {{placeholders}}:\n${JSON.stringify(bundle.prompt, null, 2)}`,
    ...(bundle.tools?.length ? [`Tools the call offers, with an example of what each returns (write each case's own in toolResults):\n${JSON.stringify(bundle.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, example: tool.mockResult })), null, 2)}`] : []),
    `Output: ${output}`,
    ...(bundle.examples?.length ? [`Examples the application has:\n${JSON.stringify(bundle.examples.slice(0, 10), null, 2)}`] : []),
    ...(guidance ? [`What a person who grades this task's answers said about the last eval; write cases that follow it:\n${guidance}`] : []),
    `Write ${count} cases: about ${edge} edge${guardrails ? `, about ${guardrails} guardrail` : ""} and the rest typical. Each "input" has a string for every one of: ${names.join(", ")}.`,
  ].join("\n\n");
}

/** The cases' text from the writer's answer: the JSON object, a fenced block, or the outermost braces. */
function parseCases(text: string): unknown[] {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [text.trim(), fenced?.trim(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases)) return (value as { cases: unknown[] }).cases;
    } catch { /* next */ }
  }
  return [];
}

/** A case's input with a string for every placeholder, or null when one is missing. Extra keys are dropped. */
function inputFor(raw: unknown, names: string[]): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input: Record<string, string> = {};
  for (const name of names) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim()) input[name] = value;
    else if (typeof value === "number" || typeof value === "boolean") input[name] = String(value);
    else return null;
  }
  return input;
}

/** The expected answer in the bundle's terms, or undefined when it has none that fits. */
function expectedFor(bundle: TaskBundle, raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (bundle.output.kind === "label") {
    const label = typeof raw === "string" ? bundle.output.labels.find(item => item.toLowerCase() === raw.trim().toLowerCase()) : undefined;
    return label ? { ok: true, value: label } : { ok: false };
  }
  if (bundle.output.kind === "json") return raw && typeof raw === "object" && !Array.isArray(raw) ? { ok: true, value: raw } : { ok: false };
  return typeof raw === "string" && raw.trim() ? { ok: true, value: raw } : { ok: false };
}

const KINDS: readonly CaseKind[] = ["typical", "edge", "guardrail"];

export interface WrittenCases {
  /** The examples first, then the written cases. */
  cases: Case[];
  /** The label check, when asked for and there are written cases to check. */
  question: Question | null;
  /** Examples and written cases dropped: a missing placeholder, an expected answer that does not fit, or a repeat. */
  dropped: number;
}

/** `guidance`: what a person said about the last eval's answers, for a regenerated eval. */
export async function writeCases(input: { bundle: TaskBundle; complete: Complete; count?: number; labelCheck?: boolean; guidance?: string }): Promise<WrittenCases> {
  const { bundle } = input;
  const names = placeholders(bundle);
  const seen = new Set<string>();
  const cases: Case[] = [];
  let dropped = 0;
  const tools = new Set((bundle.tools ?? []).map(tool => tool.name));
  const add = (raw: { input?: unknown; expected?: unknown; kind?: unknown; toolResults?: unknown }, origin: "example" | "written") => {
    const values = inputFor(raw.input, names);
    const fingerprint = JSON.stringify(values && Object.entries(values).map(([key, value]) => [key, value.trim().toLowerCase()]));
    if (!values || seen.has(fingerprint)) { dropped++; return; }
    let expected: unknown;
    if (raw.expected !== undefined) {
      const fit = expectedFor(bundle, raw.expected);
      // The agent's example keeps its input when its answer does not fit; a written case without a fitting answer is useless.
      if (fit.ok) expected = fit.value;
      else if (origin === "written") { dropped++; return; }
    } else if (origin === "written") { dropped++; return; }
    seen.add(fingerprint);
    const count = cases.filter(item => item.origin === origin).length + 1;
    const kind: CaseKind | undefined = origin === "written" ? (KINDS.includes(raw.kind as CaseKind) ? raw.kind as CaseKind : "typical") : undefined;
    // A case's own tool results, for the tools the call offers; the others fall back to each tool's mocked result.
    const results = raw.toolResults && typeof raw.toolResults === "object" && !Array.isArray(raw.toolResults)
      ? Object.fromEntries(Object.entries(raw.toolResults as Record<string, unknown>).filter(([name]) => tools.has(name))) : {};
    cases.push({ id: `${origin}-${count}`, input: values, ...(expected === undefined ? {} : { expected }), origin, ...(kind ? { kind } : {}), ...(Object.keys(results).length ? { toolResults: results } : {}) });
  };
  for (const example of bundle.examples ?? []) add(example, "example");

  // A prompt without placeholders has one possible input; writing more would only repeat it.
  const wanted = names.length ? input.count ?? WRITTEN_CASES : 0;
  if (wanted > 0) {
    // One more request when the first answer gives too few usable cases.
    for (let attempt = 0; attempt < 2 && cases.filter(item => item.origin === "written").length < wanted; attempt++) {
      const missing = wanted - cases.filter(item => item.origin === "written").length;
      const text = await input.complete({ system: WRITER_SYSTEM, prompt: writerPrompt(bundle, names, missing, input.guidance) });
      for (const raw of parseCases(text)) {
        if (cases.filter(item => item.origin === "written").length >= wanted) break;
        add(raw && typeof raw === "object" ? raw as { input?: unknown; expected?: unknown; kind?: unknown; toolResults?: unknown } : {}, "written");
      }
    }
  } else if (!names.length && !cases.length) cases.push({ id: "example-1", input: {}, origin: "example" });

  return { cases, question: input.labelCheck ? labelCheck(bundle, cases) : null, dropped };
}

const shorten = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** Asks the user to tick the written cases whose expected answer is right. Null when there is nothing to check. */
export function labelCheck(bundle: TaskBundle, cases: readonly Case[]): Question | null {
  const written = cases.filter(item => item.origin === "written" && item.expected !== undefined);
  if (!written.length) return null;
  return {
    id: LABEL_CHECK_QUESTION, kind: "multi",
    prompt: `Are these expected answers right for ${bundle.task}?`,
    detail: "OpenMerit wrote these cases to measure models on. Untick any whose expected answer is wrong: those cases are dropped.",
    options: written.map(item => ({
      value: item.id,
      label: `${shorten(Object.values(item.input).join(" · ").replace(/\s+/g, " "), 100)} → ${shorten(typeof item.expected === "string" ? item.expected : JSON.stringify(item.expected), 80)}`,
    })),
    default: written.map(item => item.id),
  };
}

/** Applies the label check's answer: ticked written cases are approved, unticked ones dropped, others kept. */
export function applyLabelCheck(cases: readonly Case[], answer: Answer): Case[] {
  const ticked = new Set(Array.isArray(answer) ? answer : typeof answer === "string" ? answer.split(",").map(item => item.trim()) : []);
  return cases.flatMap(item => {
    if (item.origin !== "written" || item.expected === undefined) return [item];
    return ticked.has(item.id) ? [{ ...item, approved: true }] : [];
  });
}
