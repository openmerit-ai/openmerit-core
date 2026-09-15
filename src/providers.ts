/** Provider boundary for OpenMerit's judge and strategist requests. */
import type { TaskImage } from "./task-input.js";
import type { CatalogEntry } from "./types.js";

export interface ProviderChatResult { content: string; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; }
export interface ModelProvider {
  readonly id: string;
  chat(model: string, prompt: string, maxTokens: number, temperature: number): Promise<ProviderChatResult>;
  chatWithImages(model: string, prompt: string, images: TaskImage[], maxTokens: number): Promise<ProviderChatResult>;
}

export interface CatalogProvider {
  readonly id: string;
  fetchCatalog(): Promise<Map<string, CatalogEntry>>;
}
