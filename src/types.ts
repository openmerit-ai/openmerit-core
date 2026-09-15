/** Shared types for the openmerit core. */

/** A single measured point for a model on a task. */
export interface TrialPoint {
  /** OpenRouter-style "vendor/model" id. */
  model: string;
  /** Judged quality 0..1. */
  score: number;
  /** Blended $ per 1M tokens at time of trial. */
  price: number;
  /** Observed end-to-end latency, if measured. */
  latencyMs?: number;
  /** ISO timestamp. */
  ts: string;
  /** Where this point came from. */
  source: "shadow_trial" | "pi_trial" | "trace" | "benchmark";
  /** One-line justification (judge/strategist). */
  why?: string;
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

/** Gate decision from the policy engine. */
export interface GateDecision {
  autoApply: boolean;
  reasons: string[];
}

/** A recommendation emitted to the main harness. */
export interface Recommendation {
  id: string;
  ts: string;
  taskKey: string;
  taskLabel: string;
  /** Target pi session for automatic swaps. */
  sessionFile?: string | null;
  currentModel: string | null;
  recommended: { model: string; reason: string };
  fallback: { model: string; reason: string } | null;
  evidence: {
    scoreGain: number;
    priceRatio: number;
    onFrontier: boolean;
    trials: number;
  };
  policy: GateDecision;
  status: "pending" | "applied" | "dismissed" | "expired";
}

/** OpenRouter catalog entry (normalized). */
export interface CatalogEntry {
  id: string;
  name: string;
  ctx: number;
  /** $/token prompt. */
  pp: number;
  /** $/token completion. */
  pc: number;
  /** Blended $/1M tokens. */
  price: number;
  /** Unix seconds, when the model was added to the catalog (if known). */
  created?: number;
}

/** Observation extracted from a main-harness session trace. */
export interface TaskObservation {
  taskKey: string;
  taskLabel: string;
  model: string | null;
  costUsd: number;
  tokens: number;
  latencyMs: number | null;
  errors: number;
  ts: string;
  sessionFile: string;
}
