// Guardrails at three levels: environment (a repository or workspace), agent (a group of tasks) and
// task. A level that does not set a guardrail inherits it from the level above. Constraints protect
// the customer, so a lower level can only narrow them; defaults can be replaced either way. The
// resolver reports which level set each effective value, and every setting it refused.

export type Level = "environment" | "agent" | "task";
export const LEVELS: readonly Level[] = ["environment", "agent", "task"];

export type ActionPolicy = "open_pr" | "ask_first" | "instructions_only";

export interface Guardrails {
  // Constraints: a lower level can only narrow them.
  /** Providers candidates may come from, such as `openrouter` or `workers-ai`. */
  allowedProviders?: string[];
  /** Model IDs candidates may be. */
  allowedModels?: string[];
  /** Endpoint IDs model calls may go to. */
  endpoints?: string[];
  /** Data region, such as `uae`. Once set, a lower level cannot change it. */
  region?: string;
  /** Cap on OpenMerit-paid spend, in USD. */
  spendCapUsd?: number;
  /** Cap on customer-paid spend, in USD. */
  customerSpendCapUsd?: number;
  // Defaults: a lower level can replace them either way.
  budgetUsd?: number;
  repeats?: number;
  /** 0 to 1. */
  minPassRate?: number;
  latencyMs?: number;
  watch?: boolean;
  actionPolicy?: ActionPolicy;
  /** Whether a switch without an agent eval is proposed with a warning, or not at all. */
  agentEvalRequired?: "warn" | "required";
  /** 0 to 1. */
  minAgentPassRate?: number;
}

export type GuardrailKey = keyof Guardrails;
export type GuardrailKind = "constraint" | "default";

export const GUARDRAIL_KINDS = {
  allowedProviders: "constraint", allowedModels: "constraint", endpoints: "constraint", region: "constraint", spendCapUsd: "constraint", customerSpendCapUsd: "constraint",
  budgetUsd: "default", repeats: "default", minPassRate: "default", latencyMs: "default", watch: "default", actionPolicy: "default", agentEvalRequired: "default", minAgentPassRate: "default",
} as const satisfies Record<GuardrailKey, GuardrailKind>;

export interface Rejection { key: string; level: Level; reason: string }

export interface ResolvedGuardrails {
  effective: Guardrails;
  /** The level that set each effective value. */
  from: Partial<Record<GuardrailKey, Level>>;
  /** Settings that were not applied: widening a constraint, an invalid value, or an unknown key. */
  rejected: Rejection[];
}

const LISTS = new Set<string>(["allowedProviders", "allowedModels", "endpoints"]);
const CAPS = new Set<string>(["spendCapUsd", "customerSpendCapUsd"]);

/** Why a value is not valid for its key, or null when it is. */
function invalid(key: GuardrailKey, value: unknown): string | null {
  const amount = typeof value === "number" && Number.isFinite(value) && value >= 0;
  switch (key) {
    case "allowedProviders": case "allowedModels": case "endpoints":
      return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim()) ? null : "must be a list of names";
    case "region": return typeof value === "string" && value.trim() ? null : "must be a region name";
    case "spendCapUsd": case "customerSpendCapUsd": case "budgetUsd": case "latencyMs": return amount ? null : "must be a number of at least 0";
    case "repeats": return Number.isInteger(value) && (value as number) >= 1 ? null : "must be a whole number of at least 1";
    case "minPassRate": case "minAgentPassRate": return amount && (value as number) <= 1 ? null : "must be between 0 and 1";
    case "watch": return typeof value === "boolean" ? null : "must be true or false";
    case "actionPolicy": return value === "open_pr" || value === "ask_first" || value === "instructions_only" ? null : "must be open_pr, ask_first or instructions_only";
    case "agentEvalRequired": return value === "warn" || value === "required" ? null : "must be warn or required";
  }
}

/** Why `value` would widen the constraint `current` set by `level`, or null when it narrows it or keeps it. */
function widens(key: GuardrailKey, current: unknown, value: unknown, level: Level): string | null {
  if (current === undefined) return null;
  if (LISTS.has(key)) {
    const allowed = new Set((current as string[]).map(item => item.toLowerCase()));
    const added = (value as string[]).filter(item => !allowed.has(item.toLowerCase()));
    return added.length ? `widens the ${level} level's ${key}: adds ${added.join(", ")}` : null;
  }
  if (CAPS.has(key)) return (value as number) > (current as number) ? `raises the ${level} level's ${key} of ${current as number} to ${value as number}` : null;
  return (value as string).toLowerCase() === (current as string).toLowerCase() ? null : `changes the ${level} level's ${key} ${current as string} to ${value as string}`;
}

export function resolveGuardrails(levels: Partial<Record<Level, Guardrails>>): ResolvedGuardrails {
  const effective: Record<string, unknown> = {};
  const from: Partial<Record<GuardrailKey, Level>> = {};
  const rejected: Rejection[] = [];
  for (const level of LEVELS) {
    for (const [name, value] of Object.entries(levels[level] ?? {})) {
      if (value === undefined) continue;
      if (!Object.hasOwn(GUARDRAIL_KINDS, name)) { rejected.push({ key: name, level, reason: "not a guardrail" }); continue; }
      const key = name as GuardrailKey;
      const problem = invalid(key, value) ?? (GUARDRAIL_KINDS[key] === "constraint" ? widens(key, effective[key], value, from[key]!) : null);
      if (problem) { rejected.push({ key, level, reason: problem }); continue; }
      effective[key] = Array.isArray(value) ? [...value] : value;
      from[key] = level;
    }
  }
  return { effective: effective as Guardrails, from, rejected };
}
