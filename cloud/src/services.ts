// What the actors need from the process they run in: configuration, billing, the catalogue snapshot
// and outbound fetch. Actor definitions are module-level, so the server sets these once at startup.
import { loadCatalogue, type AgentRun, type Catalogue } from "./engine.ts";
import type { Billing } from "./billing.ts";
import type { Config } from "./config.ts";

export interface Services {
  config: Config;
  billing: Billing | null;
  /** The catalogue the catalogue actor starts from: openmerit-core's bundled snapshot. */
  bundledCatalogue: () => Catalogue;
  /** Fetches a fresh catalogue; null keeps the current one. */
  refreshCatalogue: (() => Promise<Catalogue>) | null;
  /** Fetch for model calls and endpoint checks. */
  fetch: typeof fetch;
  /**
   * Runs an account's agent end to end on its agent cases, with some tasks switched. Null when the
   * agent has no eval, which the agent-eval guardrail then decides about. No source provides agent
   * cases yet; the job calls this through the engine's `checkAgent` rule.
   */
  agentEval: (input: { accountId: string; environment: string; agent: string }) => ((assignment: ReadonlyMap<string, { model: string; endpoint: string }>) => Promise<AgentRun>) | null;
}

let current: Services | null = null;

export function setServices(services: Services): void { current = services; }
export function services(): Services {
  if (!current) throw new Error("services() before setServices(): the server sets them at startup");
  return current;
}

export const bundledCatalogue = () => loadCatalogue();
