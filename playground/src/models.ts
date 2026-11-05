// The application model for each agent. Set a model only after consulting Scout and recording the
// decision in MODEL-DECISIONS.md. `null` means no decision yet: the agent refuses to run.

export type AgentRole = "enrollment" | "intake" | "coding" | "adjudication" | "fraud";

export interface ModelChoice {
  /** A pi-ai provider (`openrouter` or `cloudflare` for Workers AI) and its model ID, or null until a decision is recorded. */
  model: { provider: "openrouter" | "cloudflare"; id: string } | null;
  /** Heading of the MODEL-DECISIONS.md entry that chose it. */
  decision: string;
}

// Scout endpoint openrouter:chat:anthropic/claude-sonnet-5.5 (its rank 4, chosen for quality).
const SONNET: ModelChoice = {
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" },
  decision: "4 Nov 2026: first model choice for all five agents (openmerit 0.3.0)",
};

export const AGENT_MODELS: Record<AgentRole, ModelChoice> = {
  enrollment: SONNET,
  intake: SONNET,
  coding: SONNET,
  adjudication: SONNET,
  fraud: SONNET,
};

export const modelLabel = (choice: ModelChoice): string | null => (choice.model ? `${choice.model.provider}/${choice.model.id}` : null);
