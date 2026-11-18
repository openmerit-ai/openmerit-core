// The Ranking primitive's data: what a coding agent sends about one task (the bundle), the cases
// OpenMerit measures it on, and the provider-neutral model call the endpoint clients send.

/** One model invocation in an application, as the coding agent describes it. */
export interface TaskBundle {
  task: string;
  description?: string;
  current: { model: string; endpoint?: string };
  /** The prompt the application sends, with `{{var}}` placeholders that each case's input fills. */
  prompt: { system?: string; messages: { role: "user" | "assistant"; content: string }[] };
  /** Tools the call offers. The runner answers a call to one with its mocked result. */
  tools?: { name: string; description?: string; parameters: object; mockResult?: unknown }[];
  output: { kind: "text" } | { kind: "json"; schema: object } | { kind: "label"; labels: string[] };
  /** Inputs the agent found, such as in tests or fixtures; they become the first cases. */
  examples?: { input: Record<string, string>; expected?: unknown }[];
  constraints?: { maxLatencyMs?: number; needsVision?: boolean };
  codeRefs?: { file: string; line: number; spelling: string }[];
}

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
  /** True once the user confirmed the expected answer in the label check. */
  approved?: boolean;
}

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
