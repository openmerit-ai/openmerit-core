// Which model runs the Scout agent. "openai/<id>" calls OpenAI's Responses API
// directly with OPENAI_API_KEY; any other value is a Workers AI ("@cf/…") or
// AI Gateway catalogue model run through the AI binding.
import type { Api, AuthContext, Model } from '@earendil-works/pi-ai';
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export const defaultAgentModel = 'openai/gpt-6-sol';

export interface AgentModels { models: MutableModels; openai: (id: string) => Model<Api> }
export function agentModels(apiKey: string | undefined): AgentModels {
  // Workers have no process environment: only the OpenAI key is visible to providers.
  const authContext: AuthContext = { env: async name => name === 'OPENAI_API_KEY' ? apiKey : undefined, fileExists: async () => false };
  const models = createModels({ authContext });
  models.setProvider(openaiProvider());
  return {
    models,
    openai: id => {
      if (!apiKey) throw new Error(`Scout agent model openai/${id} needs OPENAI_API_KEY.`);
      const model = models.getModel('openai', id);
      if (!model) throw new Error(`Unknown OpenAI model for the Scout agent: ${id}.`);
      return model;
    },
  };
}
export const openAIModelId = (spec: string): string | null => spec.startsWith('openai/') ? spec.slice('openai/'.length) : null;
