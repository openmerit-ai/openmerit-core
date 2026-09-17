/** Shared types for the openmerit core. */

/** A concrete way to execute one logical model through a harness/provider. */
export interface ModelRoute {
  /** Provider configured in the harness, for example openrouter or anthropic. */
  provider: string;
  /** Provider-native model id passed to the harness. */
  modelId: string;
  /** Stable vendor/model identity used to compare equivalent models. */
  meritId: string;
  input: ("text" | "image")[];
  /** Pi-style dollars per million tokens. Missing means pricing is unknown. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
}

/** User-supplied metadata for one exact provider:modelId route. */
export interface RouteMetadataOverride {
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  context_window?: number;
  max_tokens?: number;
  input?: ("text" | "image")[];
}

/** A single measured point for a model on a task. */
export interface TrialPoint {
  schemaVersion?: 1;
  /** OpenRouter-style "vendor/model" id. */
  model: string;
  /** Exact provider route used. Missing on legacy 0.1.0/0.1.1 records. */
  route?: ModelRoute;
  /** Judged quality 0..1. */
  score: number;
  /** Blended $ per 1M tokens at time of trial. */
  price: number;
  /** False when price is a placeholder because the route exposed no pricing. */
  priceKnown?: boolean;
  /** Observed end-to-end latency, if measured. */
  latencyMs?: number;
  /** ISO timestamp. */
  ts: string;
  /** Where this point came from. */
  source: "shadow_trial" | "pi_trial" | "trace" | "benchmark";
  /** One-line evaluation justification. */
  why?: string;
  /** Tool activity observed during a Pi candidate run. */
  toolCalls?: number;
  toolErrors?: number;
  changedFiles?: number;
  /** Exact task and session that produced this measurement. */
  taskKey?: string;
  taskLabel?: string;
  sessionFile?: string;
}

/** Per-task pareto state. */
export interface Frontier {
  /** Stable task signature (hash). */
  taskKey: string;
  /** Human-readable snippet of the task. */
  taskLabel: string;
  /** All measured points (any source). */
  points: TrialPoint[];
  /** Models on the pareto frontier, cheapest first. */
  frontier: string[];
  /** Highest-scoring model (tie-break: cheaper). */
  bestFit?: string;
  /** Vetted fallback model. */
  fallback?: string;
  updatedAt: string;
}

/** Versioned benchmark definition for one measurable task invocation. */
export interface BenchmarkDefinition {
  schemaVersion: 1;
  id: string;
  taskKey: string;
  taskLabel: string;
  instructions: string;
  evaluator?: { kind: "rubric" | "validator" | "human"; definition: string };
  inputModalities: ("text" | "image" | "file")[];
  createdAt: string;
  updatedAt: string;
}

/** A durable request for a harness or external scheduler to refresh a benchmark. */
export interface BenchmarkJob {
  schemaVersion: 1;
  id: string;
  benchmarkId: string;
  trigger: "manual" | "interval" | "route_changed" | "route_deprecated";
  schedule?: { everyMinutes: number };
  action: "report" | "ask_harness" | "open_pr" | "apply";
  enabled: boolean;
  /** Optional harness-owned task locator used by refresh runners. */
  taskKey?: string;
  sessionFile?: string;
  route?: ModelRoute;
  routes?: ModelRoute[];
  cwd?: string;
  lastRunAt?: string;
  updatedAt: string;
}

/** Gate decision from the policy engine. */
export interface GateDecision {
  autoApply: boolean;
  reasons: string[];
}

/** A recommendation emitted to the main harness. */
export interface Recommendation {
  schemaVersion?: 1;
  id: string;
  ts: string;
  taskKey: string;
  taskLabel: string;
  /** Target pi session for automatic swaps. */
  sessionFile?: string | null;
  currentModel: string | null;
  currentRoute?: ModelRoute | null;
  recommended: { model: string; route?: ModelRoute; reason: string };
  fallback: { model: string; route?: ModelRoute; reason: string } | null;
  evidence: {
    scoreGain: number;
    priceRatio: number;
    priceKnown?: boolean;
    onFrontier: boolean;
    trials: number;
  };
  policy: GateDecision;
  status: "pending" | "applied" | "dismissed" | "expired";
}
