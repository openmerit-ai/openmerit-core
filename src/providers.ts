/** Inference boundary for OpenMerit's rubric and evaluation requests. */
import type { TaskImage } from "./task-input.js";
import type { ModelRoute } from "./types.js";

export interface ProviderChatResult {
  content: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; costUsd?: number };
}
/** Provider-neutral chat surface used by rubrics and evaluators. */
export interface MeritChatClient {
  chat(route: ModelRoute, prompt: string, maxTokens: number, temperature: number): Promise<ProviderChatResult>;
  chatWithImages(route: ModelRoute, prompt: string, images: TaskImage[], maxTokens: number): Promise<ProviderChatResult>;
}

/** Integration seam used for OpenMerit's own rubric and evaluation calls. */
export interface InferenceAdapter extends MeritChatClient {
  readonly id: string;
}
