// The task bundle and case types W2 owns in the cloud build's shared contract. They are copied
// here until `src/ranking/` lands; then this file re-exports them from there.

export interface TaskBundle {
  task: string;
  description?: string;
  current: { model: string; endpoint?: string };
  /** `{{var}}` placeholders. A trace bundle has no template: each trace case carries its own request. */
  prompt: { system?: string; messages: { role: "user" | "assistant"; content: string }[] };
  tools?: { name: string; description?: string; parameters: object; mockResult?: unknown }[];
  output: { kind: "text" } | { kind: "json"; schema: object } | { kind: "label"; labels: string[] };
  examples?: { input: Record<string, string>; expected?: unknown }[];
  constraints?: { maxLatencyMs?: number; needsVision?: boolean };
  codeRefs?: { file: string; line: number; spelling: string }[];
}

export interface Case {
  id: string;
  input: Record<string, string>;
  expected?: unknown;
  origin: "example" | "written" | "trace";
  approved?: boolean;
}
