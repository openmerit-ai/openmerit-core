// The runner: one case of a task on one candidate, in Pi's agent loop (pi-agent-core). It fills the
// bundle's prompt with the case's input and offers the bundle's tools with their parameter schemas.
// Each tool answers from the case's mocked result for it, else the tool's own, and never reaches a
// real system. A single call is the same loop with no tools; an agent takes more turns, up to the
// task's `constraints.maxTurns` model calls, and a model still calling tools then fails the case.
// A trace case is different: it carries its recorded request in `input.messages`, which is sent as
// it is, with the bundle's tools, in one call. Its answer, tool calls included, is what is graded.
// The Pi transcript is the case's trace; the runner returns it and keeps nothing.
import { runAgentLoop, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message as PiMessage } from "@earendil-works/pi-ai";
import { piMessages, schemaOf, textOf, toolCallsOf, type ModelCall, type ModelClient } from "./clients.ts";
import type { CatalogueModel, Ledger } from "../engine/index.ts";
import type { Case, Message, TaskBundle, ToolCall } from "./types.ts";

/** Model calls one case may take when its task sets no `constraints.maxTurns`: four tool results and the answer. */
export const DEFAULT_MAX_TURNS = 5;

/** Rough tokens of one call of a task: the prompt's characters over four, and a short answer. */
export function callTokens(bundle: TaskBundle): { input: number; output: number } {
  const prompt = `${bundle.prompt.system ?? ""}${bundle.prompt.messages.map(item => item.content).join("")}${JSON.stringify(bundle.tools ?? [])}`;
  return { input: Math.ceil(prompt.length / 4) + 50, output: bundle.output.kind === "label" ? 10 : 300 };
}

/** One call's estimated cost at list price, or null when the price is unknown. */
export function callCost(model: Pick<CatalogueModel, "inputPerM" | "outputPerM"> | null, bundle: TaskBundle): number | null {
  if (!model || model.inputPerM === null || model.outputPerM === null) return null;
  const tokens = callTokens(bundle);
  return (tokens.input * model.inputPerM + tokens.output * model.outputPerM) / 1e6;
}

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
  /** Every tool call the candidate made, in order. A trace case's are those of its one answer. */
  toolCalls: ToolCall[];
  /** The Pi transcript: the system prompt, the prompt, and each answer and tool result in order. */
  transcript: PiMessage[];
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
const LLM_ROLES = new Set(["system", "user", "assistant", "toolResult"]);

/** The bundle's tools as Pi tools that answer from this case's mocked results. */
function mockedTools(bundle: TaskBundle, caseItem: Case): AgentTool[] {
  return (bundle.tools ?? []).map(tool => ({
    name: tool.name, label: tool.name, description: tool.description ?? "", parameters: schemaOf(tool.parameters),
    async execute() {
      const result = caseItem.toolResults && Object.hasOwn(caseItem.toolResults, tool.name) ? caseItem.toolResults[tool.name] : tool.mockResult;
      if (result === undefined) return { content: [{ type: "text", text: JSON.stringify({ error: `${tool.name} is not available.` }) }], details: undefined, isError: true };
      return { content: [{ type: "text", text: mocked(result) }], details: undefined };
    },
  }));
}

export async function runCase(input: {
  bundle: TaskBundle; caseItem: Case; client: ModelClient; candidate: { model: string; endpoint: string };
  ledger: Ledger; key: string; signal?: AbortSignal; maxTokens?: number;
}): Promise<CaseRun> {
  const { bundle, caseItem, client, candidate } = input;
  const trace = caseItem.origin === "trace";
  const recorded = trace ? traceRequest(caseItem) : null;
  const system = recorded ? recorded.system : bundle.prompt.system === undefined ? undefined : fill(bundle.prompt.system, caseItem.input);
  const messages: Message[] = recorded ? recorded.messages : bundle.prompt.messages.map(message => ({ role: message.role, content: fill(message.content, caseItem.input) }));
  const maxTurns = trace ? 1 : Math.max(1, bundle.constraints?.maxTurns ?? DEFAULT_MAX_TURNS);
  const model = client.model(candidate.endpoint, candidate.model);
  const prompts: AgentMessage[] = [...(system === undefined ? [] : [{ role: "system" as const, content: system, timestamp: Date.now() }]), ...piMessages(model, messages)];

  const calls: ModelCall[] = [];
  // Each model call is metered under its own key, so a replayed case is charged once.
  const streamFn: StreamFn = async (_model, context) => {
    const answer = await client.call({ endpoint: candidate.endpoint, model: candidate.model, context, ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}) },
      { ledger: input.ledger, key: `${input.key}/call-${calls.length}`, ...(input.signal ? { signal: input.signal } : {}) });
    calls.push(answer);
    const stream = createAssistantMessageEventStream();
    const message = answer.message;
    if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
    else stream.push({ type: "done", reason: message.stopReason === "pending" ? "stop" : message.stopReason, message });
    return stream;
  };
  // At the turn limit the loop runs no more tools: a trace case's tool calls are its answer, and an agent's are one call too many.
  const atLimit = () => calls.length >= maxTurns;
  const transcript = await runAgentLoop(prompts, { messages: [], tools: mockedTools(bundle, caseItem) }, {
    model, convertToLlm: items => items.filter((item): item is PiMessage => LLM_ROLES.has((item as { role: string }).role)), toolExecution: "sequential",
    beforeToolCall: async () => (atLimit() ? { block: true, reason: `Not run: the case's limit of ${maxTurns} model call${maxTurns === 1 ? "" : "s"} is reached.`, terminate: true } : undefined),
    finishTurn: () => (atLimit() ? { action: "end" } : undefined),
  }, () => {}, input.signal, streamFn) as PiMessage[];

  // The candidate's answers: the transcript also holds the prompt, such as a trace case's recorded turns.
  const answers: AssistantMessage[] = calls.map(item => item.message);
  const run: CaseRun = {
    output: null, toolCalls: answers.flatMap(toolCallsOf), transcript, calls: calls.length,
    costUsd: calls.reduce((sum, item) => sum + item.costUsd, 0), costIsEstimate: calls.some(item => item.costIsEstimate), latencyMs: calls.reduce((sum, item) => sum + item.latencyMs, 0),
  };
  const failed = calls.find(item => !item.ok);
  if (failed) return { ...run, failure: "error", status: failed.status, ...(failed.error ? { error: failed.error } : {}) };
  const last = answers.at(-1)!;
  const output = textOf(last);
  // A recorded request is replayed once: its tool calls are the answer, not a turn to continue.
  if (toolCallsOf(last).length) return trace ? { ...run, output } : { ...run, failure: "tool_loop" };
  return last.stopReason === "length" && !output.trim() ? { ...run, failure: "truncated" } : { ...run, output };
}
