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
  /** A user's GitHub token from their GitHub sign-in (Auth.githubToken); null without one or without sign-in. */
  githubToken: (userId: string) => Promise<string | null>;
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

/** What a job start returns when OpenMerit's own model key does not work: nothing ran, so nothing is spent or counted. */
export const MODEL_KEY_REFUSAL = "OpenMerit's model key is not working, so this evaluation did not start. Nothing was spent, and it does not count as an evaluation.";
const KEY_OK_MS = 60_000;
let keyOkAt = 0;

/**
 * Checks OpenMerit's OpenRouter key before a job starts, with OpenRouter's free `GET /key`, so a job
 * whose model calls would all fail does not start. A key OpenRouter refuses (401 or 403) refuses the
 * job with MODEL_KEY_REFUSAL. An unconfigured key is left to the job, which says so; an unreachable
 * OpenRouter does not refuse, since a model call may still succeed. A working key is trusted for a minute.
 */
export async function modelKeyRefusal(): Promise<string | null> {
  const { config, fetch } = services();
  if (!config.openrouter.apiKey || Date.now() - keyOkAt < KEY_OK_MS) return null;
  try {
    const response = await fetch(`${config.openrouter.baseUrl}/key`, { headers: { authorization: `Bearer ${config.openrouter.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return MODEL_KEY_REFUSAL;
    if (response.ok) keyOkAt = Date.now();
  } catch {
    // OpenRouter unreachable: the job's own calls report it.
  }
  return null;
}
