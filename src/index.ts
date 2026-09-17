/** Public integration API for non-Pi harness plugins. */
export { compareSettledTask } from "./comparison.js";
export type {
  HarnessAdapter, HarnessInvocation, HarnessRun, HarnessScore, HarnessTask, SettledHarnessTask,
} from "./harness.js";
export type { MeritChatClient, InferenceAdapter, ProviderChatResult } from "./providers.js";
export type { ModelRoute, Recommendation, TrialPoint, Frontier } from "./types.js";
export type { Policy } from "./policy.js";
export { OpenRouterBenchmarkSource, publicPriorModels } from "./public-benchmarks.js";
