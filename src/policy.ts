/** Policy loading, validation, and the swap gate. */

import { existsSync, readFileSync } from "node:fs";
import type { GateDecision } from "./types.js";

export interface Policy {
  version: number;
  /** "recommend": never swap autonomously. "auto": swap when the gate passes. */
  mode: "recommend" | "auto";
  auto_apply: {
    enabled: boolean;
    /** Minimum expected quality gain (0..1) over the current model. */
    min_score_gain: number;
    /** Candidate blended price must be <= this multiple of current price. */
    max_price_ratio: number;
    /** Only auto-apply candidates that sit on the pareto frontier. */
    require_frontier: boolean;
  };
  budgets: {
    max_usd_per_trial: number;
    max_trials_per_day: number;
    max_usd_per_day: number;
  };
  providers: { allow: string[]; deny: string[] };
  watch: {
    catalog_interval_min: number;
    traces_interval_sec: number;
    trial_interval_min: number;
    /** Compare the completed active pi task with this many total models. */
    models_per_task: number;
  };
  fallback: {
    auto_update: boolean;
    min_score: number;
    apply_on_error: boolean;
  };
  judge_model: string | null;
  strategist_model: string | null;
  /** Global price ceiling (blended $/1M) for any considered model. */
  max_usd_per_m: number;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  mode: "auto",
  auto_apply: {
    enabled: true,
    min_score_gain: 0,
    max_price_ratio: 1000000,
    require_frontier: true,
  },
  budgets: { max_usd_per_trial: 0.25, max_trials_per_day: 20, max_usd_per_day: 5.0 },
  providers: { allow: ["*"], deny: [] },
  watch: { catalog_interval_min: 360, traces_interval_sec: 5, trial_interval_min: 30, models_per_task: 3 },
  fallback: { auto_update: true, min_score: 0.6, apply_on_error: true },
  judge_model: null,
  strategist_model: null,
  max_usd_per_m: 20.0,
};

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Load a policy file, filling defaults for missing keys. Throws on invalid JSON. */
export function loadPolicy(path: string): Policy {
  if (!existsSync(path)) return structuredClone(DEFAULT_POLICY);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const d = DEFAULT_POLICY;
  return {
    version: num(raw.version, d.version),
    mode: raw.mode === "auto" ? "auto" : "recommend",
    auto_apply: {
      enabled: Boolean(raw.auto_apply?.enabled ?? d.auto_apply.enabled),
      min_score_gain: num(raw.auto_apply?.min_score_gain, d.auto_apply.min_score_gain),
      max_price_ratio: num(raw.auto_apply?.max_price_ratio, d.auto_apply.max_price_ratio),
      require_frontier: Boolean(raw.auto_apply?.require_frontier ?? d.auto_apply.require_frontier),
    },
    budgets: {
      max_usd_per_trial: num(raw.budgets?.max_usd_per_trial, d.budgets.max_usd_per_trial),
      max_trials_per_day: num(raw.budgets?.max_trials_per_day, d.budgets.max_trials_per_day),
      max_usd_per_day: num(raw.budgets?.max_usd_per_day, d.budgets.max_usd_per_day),
    },
    providers: {
      allow: Array.isArray(raw.providers?.allow) ? raw.providers.allow.map(String) : d.providers.allow,
      deny: Array.isArray(raw.providers?.deny) ? raw.providers.deny.map(String) : d.providers.deny,
    },
    watch: {
      catalog_interval_min: num(raw.watch?.catalog_interval_min, d.watch.catalog_interval_min),
      traces_interval_sec: num(raw.watch?.traces_interval_sec, d.watch.traces_interval_sec),
      trial_interval_min: num(raw.watch?.trial_interval_min, d.watch.trial_interval_min),
      models_per_task: num(raw.watch?.models_per_task, d.watch.models_per_task),
    },
    fallback: {
      auto_update: Boolean(raw.fallback?.auto_update ?? d.fallback.auto_update),
      min_score: num(raw.fallback?.min_score, d.fallback.min_score),
      apply_on_error: Boolean(raw.fallback?.apply_on_error ?? d.fallback.apply_on_error),
    },
    judge_model: raw.judge_model ?? null,
    strategist_model: raw.strategist_model ?? null,
    max_usd_per_m: num(raw.max_usd_per_m, d.max_usd_per_m),
  };
}

/** Is a model id allowed by the provider allow/deny lists? ("*" matches all; "vendor/*" matches a vendor.) */
export function providerAllowed(policy: Policy, modelId: string): boolean {
  const vendor = modelId.split("/")[0];
  const match = (pat: string) =>
    pat === "*" || pat === modelId || (pat.endsWith("/*") && pat.slice(0, -2) === vendor);
  if (policy.providers.deny.some(match)) return false;
  return policy.providers.allow.some(match);
}

export interface GateInput {
  /** Expected quality gain over current model (candidate score - current score). */
  scoreGain: number;
  /** candidate price / current price (1 if unknown). */
  priceRatio: number;
  /** Is the candidate on the task's pareto frontier? */
  onFrontier: boolean;
  /** Candidate passes provider allow/deny. */
  providerOk: boolean;
  /** A real task trial of the current model exists. */
  baselineMeasured?: boolean;
  /** The recommendation targets one pi session. */
  sessionBound?: boolean;
}

/**
 * The swap gate: decide whether a recommendation may be applied without
 * human approval. Always returns the reasons for the decision so the
 * recommendation can explain itself.
 */
export function gate(policy: Policy, input: GateInput): GateDecision {
  const reasons: string[] = [];
  if (!input.providerOk) {
    reasons.push("provider not allowed by policy");
    return { autoApply: false, reasons };
  }
  if (input.baselineMeasured === false) {
    reasons.push("current model has no measured baseline");
    return { autoApply: false, reasons };
  }
  if (input.sessionBound === false) {
    reasons.push("recommendation is not bound to a pi session");
    return { autoApply: false, reasons };
  }
  if (policy.mode !== "auto" || !policy.auto_apply.enabled) {
    reasons.push(`policy mode is "${policy.mode}" (auto_apply ${policy.auto_apply.enabled ? "enabled" : "disabled"})`);
    return { autoApply: false, reasons };
  }
  let ok = true;
  if (input.scoreGain < policy.auto_apply.min_score_gain) {
    reasons.push(`score gain ${input.scoreGain.toFixed(3)} < min ${policy.auto_apply.min_score_gain}`);
    ok = false;
  }
  if (input.priceRatio > policy.auto_apply.max_price_ratio) {
    reasons.push(`price ratio ${input.priceRatio.toFixed(2)}x > max ${policy.auto_apply.max_price_ratio}x`);
    ok = false;
  }
  if (policy.auto_apply.require_frontier && !input.onFrontier) {
    reasons.push("candidate is not on the pareto frontier");
    ok = false;
  }
  if (ok) reasons.unshift("all auto-apply thresholds met");
  return { autoApply: ok, reasons };
}
