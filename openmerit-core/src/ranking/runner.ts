// The single-call runner: fills the bundle's prompt with one case's input, offers the bundle's
// tools, and answers each tool call with the tool's mocked result until the model answers in text.
// A model that keeps calling tools stops after MAX_TOOL_ROUNDS answers, and the case fails.
// A trace case is different: it carries its recorded request in `input.messages`, which is sent as
// it is, with the bundle's tools, in one call. Its answer, tool calls included, is what is graded.
import type { Meter, ModelClient } from "./clients.ts";
import type { Ledger } from "../engine/index.ts";
import type { Case, Message, TaskBundle, ToolCall } from "./types.ts";

/** Tool results the runner sends back before it gives up on a case. */
export const MAX_TOOL_ROUNDS = 4;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** The `{{var}}` names the bundle's prompt uses, in order of first use. */
export function placeholders(bundle: TaskBundle): string[] {
  const names = new Set<string>();
  for (const text of [bundle.prompt.system ?? "", ...bundle.prompt.messages.map(message => message.content)]) for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

export function fill(template: string, input: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = input[name];
    if (value === undefined) throw new Error(`No value for {{${name}}}`);
    return value;
  });
}

const text = (content: unknown): string => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("") : "");

/**
 * A trace case's recorded request (OpenAI chat messages in JSON) as the runner sends it: system and
 * developer messages become the system prompt; parts other than text, such as images, are left out.
 */
export function traceRequest(caseItem: Case): { system?: string; messages: Message[] } {
  let raw: unknown;
  try { raw = JSON.parse(caseItem.input.messages ?? ""); } catch { raw = null; }
  if (!Array.isArray(raw)) throw new Error(`Trace case ${caseItem.id} has no recorded messages`);
  const system: string[] = [];
  const messages: Message[] = [];
  for (const item of raw as { role?: unknown; content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: unknown; name?: unknown }[]) {
    if (item.role === "system" || item.role === "developer") system.push(text(item.content));
    else if (item.role === "user") messages.push({ role: "user", content: text(item.content) });
    else if (item.role === "assistant") {
      const toolCalls = (item.tool_calls ?? []).map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" }));
      messages.push({ role: "assistant", content: text(item.content), ...(toolCalls.length ? { toolCalls } : {}) });
    } else if (item.role === "tool") messages.push({ role: "tool", toolCallId: String(item.tool_call_id ?? ""), ...(typeof item.name === "string" ? { name: item.name } : {}), content: text(item.content) });
  }
  return { ...(system.length ? { system: system.join("\n\n") } : {}), messages };
}

export type CaseFailure = "error" | "tool_loop" | "truncated";

export interface CaseRun {
  /** The model's final text; null when the case failed before one. */
  output: string | null;
  /** A trace case's tool calls in its one answer; empty otherwise. */
  toolCalls: ToolCall[];
  failure?: CaseFailure;
  /** The endpoint's status and error when `failure` is "error"; status 0 means it did not answer. */
  status?: number;
  error?: string;
  calls: number;
  costUsd: number;
  costIsEstimate: boolean;
  latencyMs: number;
}

const mocked = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export async function runCase(input: {
  bundle: TaskBundle; caseItem: Case; client: ModelClient; candidate: { model: string; endpoint: string };
  ledger: Ledger; key: string; signal?: AbortSignal; maxTokens?: number; maxToolRounds?: number;
}): Promise<CaseRun> {
  const { bundle, caseItem } = input;
  const trace = caseItem.origin === "trace";
  const recorded = trace ? traceRequest(caseItem) : null;
  const system = recorded ? recorded.system : bundle.prompt.system === undefined ? undefined : fill(bundle.prompt.system, caseItem.input);
  const messages: Message[] = recorded ? recorded.messages : bundle.prompt.messages.map(message => ({ role: message.role, content: fill(message.content, caseItem.input) }));
  const tools = bundle.tools?.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters }));
  const rounds = input.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const run: CaseRun = { output: null, toolCalls: [], calls: 0, costUsd: 0, costIsEstimate: false, latencyMs: 0 };
  for (let round = 0; ; round++) {
    const meter: Meter = { ledger: input.ledger, key: `${input.key}/call-${round}`, ...(input.signal ? { signal: input.signal } : {}) };
    const answer = await input.client.complete({
      endpoint: input.candidate.endpoint, model: input.candidate.model, messages,
      ...(system !== undefined ? { system } : {}), ...(tools?.length ? { tools } : {}), ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    }, meter);
    run.calls++;
    run.costUsd += answer.costUsd;
    run.costIsEstimate ||= answer.costIsEstimate;
    run.latencyMs += answer.latencyMs;
    if (!answer.ok) return { ...run, failure: "error", status: answer.status, ...(answer.error ? { error: answer.error } : {}) };
    // A recorded request is replayed once: its tool calls are the answer, not a turn to continue.
    if (trace && answer.toolCalls.length) return { ...run, output: answer.text, toolCalls: answer.toolCalls };
    if (!answer.toolCalls.length) return answer.truncated && !answer.text.trim() ? { ...run, failure: "truncated" } : { ...run, output: answer.text };
    if (round >= rounds) return { ...run, failure: "tool_loop" };
    messages.push({ role: "assistant", content: answer.text, toolCalls: answer.toolCalls });
    for (const call of answer.toolCalls) {
      const tool = bundle.tools?.find(item => item.name === call.name);
      const content = !tool ? JSON.stringify({ error: `There is no tool named ${call.name}.` })
        : tool.mockResult === undefined ? JSON.stringify({ error: `${call.name} is not available.` }) : mocked(tool.mockResult);
      try { input.client.captureToolSpan?.({ name: call.name, input: call.arguments, output: content }); }
      catch { /* Analytics must never affect a model call. */ }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
}
