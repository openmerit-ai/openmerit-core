import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RunnableModel } from "../scout/candidates.ts";
import type { ModelCaller } from "../scout/evaluators/pi.ts";

/**
 * OpenMerit's changes to a stock Pi process, applied before Pi reads its environment:
 * - its own agent directory (~/.openmerit/agent, or $OPENMERIT_HOME/agent), so OpenMerit's
 *   logins and settings never touch a separate Pi installation; PI_CODING_AGENT_DIR still wins;
 * - a Claude Code subscription token (CLAUDE_CODE_OAUTH_TOKEN) works as the Anthropic
 *   subscription credential when no Anthropic key or token is set;
 * - Pi's own update check is off, because this package pins Pi.
 */
export function configureHarness(env: Record<string, string | undefined> = process.env): { agentDir: string } {
  env.PI_CODING_AGENT_DIR ??= join(env.OPENMERIT_HOME ?? join(homedir(), ".openmerit"), "agent");
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_OAUTH_TOKEN && !env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  env.PI_SKIP_VERSION_CHECK ??= "1";
  return { agentDir: env.PI_CODING_AGENT_DIR };
}

/** Scout runs on the strongest connected general model unless the user names one. */
const SCOUT_MODEL_PREFERENCE = [
  "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol", "openai/gpt-6-sol",
  "openrouter/anthropic/claude-opus-5.5", "openrouter/anthropic/claude-sonnet-5.5", "openrouter/openai/gpt-6.1-sol",
];

export async function openRuntime(): Promise<{ runtime: ModelRuntime; caller: ModelCaller; models: () => Promise<RunnableModel[]> }> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
  const caller: ModelCaller = { getModel: (provider, id) => runtime.getModel(provider, id), complete: (model, context, extra) => runtime.complete(model, context, extra) };
  const models = async () => (await runtime.getAvailable()).map(model => ({ provider: model.provider, id: model.id, name: model.name, cost: model.cost }));
  return { runtime, caller, models };
}

export async function pickScoutModel(runtime: ModelRuntime, requested?: string) {
  const available = await runtime.getAvailable();
  const ref = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
  if (requested) {
    const model = available.find(item => ref(item) === requested);
    if (!model) throw new Error(`Scout model ${requested} is not available with the connected providers. Run \`openmerit status\`.`);
    return model;
  }
  for (const wanted of SCOUT_MODEL_PREFERENCE) {
    const model = available.find(item => ref(item) === wanted);
    if (model) return model;
  }
  const model = available[0];
  if (!model) throw new Error("No model provider is connected. Set an API key (for example OPENROUTER_API_KEY or ANTHROPIC_API_KEY) or run `openmerit login` for a subscription.");
  return model;
}
