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

// Scenario runs may override the recorded choice per agent, to compare Scout's candidates.

export type ModelOverride = NonNullable<ModelChoice["model"]>;
export type ModelOverrides = Partial<Record<AgentRole, ModelOverride>>;

export const AGENT_ROLES = Object.keys(AGENT_MODELS) as AgentRole[];

function parseModel(value: string): ModelOverride {
  const [provider, ...id] = value.trim().split("/");
  if ((provider !== "openrouter" && provider !== "cloudflare") || !id.join("/")) throw new Error(`A model is openrouter/<id> or cloudflare/<id>, not "${value}"`);
  return { provider, id: id.join("/") };
}

/**
 * Parses `--model`: `openrouter/<id>` runs every agent on that model; `intake=openrouter/<id>,coding=...`
 * overrides only the named agents. Agents not named keep their recorded choice.
 */
export function parseModelFlag(value: string | undefined): ModelOverrides {
  if (!value) return {};
  if (!value.includes("=")) {
    const model = parseModel(value);
    return Object.fromEntries(AGENT_ROLES.map((role) => [role, model]));
  }
  const overrides: ModelOverrides = {};
  for (const part of value.split(",")) {
    const [role = "", model = "", ...extra] = part.split("=").map((item) => item.trim());
    if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`Unknown agent "${role}" in --model; agents are ${AGENT_ROLES.join(", ")}`);
    if (extra.length || !model) throw new Error(`Write each assignment as <agent>=<provider>/<id>, not "${part}"`);
    if (overrides[role as AgentRole]) throw new Error(`Agent ${role} is named twice in --model`);
    overrides[role as AgentRole] = parseModel(model);
  }
  return overrides;
}

/** The model each agent runs with these overrides, as `provider/id` (or "none"). */
export function effectiveModels(overrides: ModelOverrides): Record<AgentRole, string> {
  return Object.fromEntries(AGENT_ROLES.map((role) => [role, modelLabel({ model: overrides[role] ?? AGENT_MODELS[role].model, decision: "" }) ?? "none"])) as Record<AgentRole, string>;
}

/**
 * A short label for a run's overrides: "recorded" without any, the model's last path segment when every
 * agent runs one model, else `intake+coding=<model>` groups joined by commas.
 */
export function overridesLabel(overrides: ModelOverrides): string {
  const groups = new Map<string, AgentRole[]>();
  for (const role of AGENT_ROLES) {
    const model = overrides[role];
    const key = model && `${model.provider}/${model.id}`;
    if (key) groups.set(key, [...(groups.get(key) ?? []), role]);
  }
  if (!groups.size) return "recorded";
  const short = (id: string): string => id.split("/").at(-1) ?? id;
  const [only] = groups;
  if (groups.size === 1 && only && only[1].length === AGENT_ROLES.length) return short(only[0]);
  return [...groups].map(([id, roles]) => `${roles.join("+")}=${short(id)}`).join(",");
}
