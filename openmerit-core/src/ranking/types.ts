// The Ranking primitive's data: what a coding agent sends about one task (the bundle), the cases
// OpenMerit measures it on, and the provider-neutral model call the endpoint clients send.

/** One model invocation in an application, as the coding agent describes it. */
export interface TaskBundle {
  task: string;
  description?: string;
  current: { model: string; endpoint?: string };
  /** The prompt the application sends, with `{{var}}` placeholders that each case's input fills. */
  prompt: { system?: string; messages: { role: "user" | "assistant"; content: string }[] };
  /** Tools the call offers. The runner answers a call to one with the case's mocked result for it, else this `mockResult`. */
  tools?: { name: string; description?: string; parameters: object; mockResult?: unknown }[];
  output: { kind: "text" } | { kind: "json"; schema: object } | { kind: "label"; labels: string[] };
  /** Inputs the agent found, such as in tests or fixtures; they become the first cases. */
  examples?: { input: Record<string, string>; expected?: unknown }[];
  /** `maxTurns`: the most model calls one case may take, 5 when absent; a case still calling tools then fails. A trace case takes 1. */
  constraints?: { maxLatencyMs?: number; needsVision?: boolean; maxTurns?: number };
  codeRefs?: { file: string; line: number; spelling: string }[];
  // The task spec a review of the code writes: input, steps, output (above), criteria and guardrails.
  /** What the call's input is and how it varies in production, such as "a customer's support email, often forwarded". */
  input?: { description: string };
  /** What the model does, in order, with the tools each step uses and the access they have. */
  steps?: { description: string; tools?: string[]; access?: "none" | "read" | "write" }[];
  /** What a right answer does, one statement each. Each is one judge check on every case. */
  criteria?: string[];
  /** What the call must never do, such as promise a refund or reveal another customer's data. One judge check each, on every case. */
  guardrails?: string[];
}

/** How a written case tests the task: a typical input, an edge case, or one that tempts the model past a guardrail. */
export type CaseKind = "typical" | "edge" | "guardrail";

export interface Case {
  id: string;
  /**
   * A value for every `{{var}}` in the bundle's prompt. A trace case instead has `messages`: the recorded
   * request as JSON OpenAI chat messages, which the runner sends as they are.
   */
  input: Record<string, string>;
  /**
   * The right label, the JSON fields that must match, the exact text, or a reference answer for the judge.
   * A trace case's is the assistant message the current model recorded, `{ role, content, tool_calls? }`.
   */
  expected?: unknown;
  origin: "example" | "written" | "trace";
  /** A written case's kind; examples and traces have none. */
  kind?: CaseKind;
  /** Mocked tool results for this case, by tool name; a tool without one answers with its `mockResult`. */
  toolResults?: Record<string, unknown>;
  /** True once the user confirmed the expected answer in the label check. */
  approved?: boolean;
}

/** The kind of case a pass rate is reported by: a written case's kind, else its origin. */
export const caseKind = (item: Pick<Case, "kind" | "origin">): string => item.kind ?? item.origin;

export type EndpointKind = "openrouter" | "openai-compatible" | "anthropic";

export interface ToolCall { id: string; name: string; arguments: string }

/** A provider-neutral message. `tool` answers one of the assistant's tool calls. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name?: string; content: string };

export interface CompletionRequest {
  /** The endpoint ID the client was configured with, such as "openrouter". */
  endpoint: string;
  /** The model as the endpoint names it, such as `openai/gpt-5-mini` on OpenRouter or `gpt-5-mini` on OpenAI. */
  model: string;
  system?: string;
  messages: Message[];
  tools?: { name: string; description?: string; parameters: object }[];
  maxTokens?: number;
}

export interface Completion {
  /** False when the endpoint answered with an error or did not answer; `status` 0 means it did not answer. */
  ok: boolean;
  status: number;
  text: string;
  toolCalls: ToolCall[];
  /** The answer stopped at the output token limit. */
  truncated: boolean;
  usage: { input: number; output: number } | null;
  /** What the call cost: provider-reported where available, else a list-price estimate. */
  costUsd: number;
  costIsEstimate: boolean;
  latencyMs: number;
  /** The endpoint's error message, shortened, when `ok` is false. */
  error?: string;
}
