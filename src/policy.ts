/** Policy loading, validation, and the swap gate. */

import { existsSync, readFileSync } from "node:fs";
import type { GateDecision, RouteMetadataOverride } from "./types.js";

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
  comparison: {
    /** Compare the completed active task with this many total routes, including baseline. */
    max_routes: number;
  };
  fallback: {
    auto_update: boolean;
    min_score: number;
    apply_on_error: boolean;
  };
  evaluator_model: string | null;
  /** Global price ceiling (blended $/1M) for any considered model. */
  max_usd_per_m: number;
  /** Exact provider:modelId metadata for routes whose registry data is incomplete. */
  route_overrides: Record<string, RouteMetadataOverride>;
  /** Provider-registration extension files explicitly allowed in isolated Pi subprocesses. */
  pi: { provider_extensions: string[] };
}

export const DEFAULT_POLICY: Policy = {
  version: 3,
  mode: "recommend",
  auto_apply: {
    enabled: false,
    min_score_gain: 0.1,
    max_price_ratio: 1.5,
    require_frontier: true,
  },
  budgets: { max_usd_per_trial: 0.25, max_trials_per_day: 20, max_usd_per_day: 5.0 },
  providers: { allow: ["*"], deny: [] },
  comparison: { max_routes: 3 },
  fallback: { auto_update: true, min_score: 0.6, apply_on_error: true },
  evaluator_model: null,
  max_usd_per_m: 20.0,
  route_overrides: {},
  pi: { provider_extensions: [] },
};

function finiteAtLeast(value: unknown, min: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min)
    throw new Error(`${label} must be a finite number >= ${min}`);
  return value;
}

function optionalNumber(
  value: unknown, fallback: number, min: number, label: string, max = Number.POSITIVE_INFINITY,
): number {
  if (value === undefined) return fallback;
  const result = finiteAtLeast(value, min, label);
  if (result > max) throw new Error(`${label} must be <= ${max}`);
  return result;
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function stringList(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}

function optionalModel(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be null or a model/route id`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  const result = finiteAtLeast(value, 1, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function integerAtLeast(value: unknown, min: number, label: string): number {
  const result = finiteAtLeast(value, min, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function positiveIntegerOrZero(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const result = finiteAtLeast(value, 0, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function routeOverrides(value: unknown): Record<string, RouteMetadataOverride> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("route_overrides must be an object keyed by provider:modelId");
  const result: Record<string, RouteMetadataOverride> = {};
  for (const [key, raw] of Object.entries(value)) {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator === key.length - 1)
      throw new Error(`route override ${key} must use provider:modelId`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`route override ${key} must be an object`);
    const input = (raw as { input?: unknown }).input;
    if (input !== undefined && (!Array.isArray(input) || input.length === 0 ||
        input.some((item) => item !== "text" && item !== "image")))
      throw new Error(`route override ${key}.input must contain only text or image`);
    const cost = (raw as { cost?: unknown }).cost;
    let normalizedCost: RouteMetadataOverride["cost"];
    if (cost !== undefined) {
      if (!cost || typeof cost !== "object" || Array.isArray(cost))
        throw new Error(`route override ${key}.cost must be an object`);
      const c = cost as Record<string, unknown>;
      normalizedCost = {
        input: finiteAtLeast(c.input, 0, `route override ${key}.cost.input`),
        output: finiteAtLeast(c.output, 0, `route override ${key}.cost.output`),
        ...(c.cacheRead === undefined ? {} : {
          cacheRead: finiteAtLeast(c.cacheRead, 0, `route override ${key}.cost.cacheRead`),
        }),
        ...(c.cacheWrite === undefined ? {} : {
          cacheWrite: finiteAtLeast(c.cacheWrite, 0, `route override ${key}.cost.cacheWrite`),
        }),
      };
    }
    const contextWindow = (raw as { context_window?: unknown }).context_window;
    const maxTokens = (raw as { max_tokens?: unknown }).max_tokens;
    result[key] = {
      ...(normalizedCost ? { cost: normalizedCost } : {}),
      ...(contextWindow === undefined ? {} : {
        context_window: positiveInteger(contextWindow, `route override ${key}.context_window`),
      }),
      ...(maxTokens === undefined ? {} : {
        max_tokens: positiveInteger(maxTokens, `route override ${key}.max_tokens`),
      }),
      ...(input === undefined ? {} : { input: [...new Set(input)] as ("text" | "image")[] }),
    };
  }
  return result;
}

function providerExtensions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error("pi.provider_extensions must be an array of non-empty file paths");
  return [...new Set(value.map((item) => String(item).trim()))];
}

/** Load a policy file, filling defaults for missing keys. Throws on invalid JSON. */
export function loadPolicy(path: string): Policy {
  if (!existsSync(path)) return structuredClone(DEFAULT_POLICY);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("policy must be a JSON object");
  const raw = parsed as Record<string, any>;
  const d = DEFAULT_POLICY;
  const legacyMaxRoutes = raw.watch?.models_per_task;
  return {
    version: raw.version === undefined ? d.version : positiveInteger(raw.version, "version"),
    mode: raw.mode === "auto" ? "auto" : "recommend",
    auto_apply: {
      enabled: booleanValue(raw.auto_apply?.enabled, d.auto_apply.enabled, "auto_apply.enabled"),
      min_score_gain: optionalNumber(raw.auto_apply?.min_score_gain, d.auto_apply.min_score_gain,
        0, "auto_apply.min_score_gain", 1),
      max_price_ratio: optionalNumber(raw.auto_apply?.max_price_ratio, d.auto_apply.max_price_ratio,
        0, "auto_apply.max_price_ratio"),
      require_frontier: booleanValue(raw.auto_apply?.require_frontier,
        d.auto_apply.require_frontier, "auto_apply.require_frontier"),
    },
    budgets: {
      max_usd_per_trial: optionalNumber(raw.budgets?.max_usd_per_trial,
        d.budgets.max_usd_per_trial, 0, "budgets.max_usd_per_trial"),
      max_trials_per_day: positiveIntegerOrZero(raw.budgets?.max_trials_per_day,
        d.budgets.max_trials_per_day, "budgets.max_trials_per_day"),
      max_usd_per_day: optionalNumber(raw.budgets?.max_usd_per_day,
        d.budgets.max_usd_per_day, 0, "budgets.max_usd_per_day"),
    },
    providers: {
      allow: stringList(raw.providers?.allow, d.providers.allow, "providers.allow"),
      deny: stringList(raw.providers?.deny, d.providers.deny, "providers.deny"),
    },
    comparison: {
      max_routes: integerAtLeast(raw.comparison?.max_routes ?? legacyMaxRoutes ?? d.comparison.max_routes,
        2, "comparison.max_routes"),
    },
    fallback: {
      auto_update: booleanValue(raw.fallback?.auto_update, d.fallback.auto_update, "fallback.auto_update"),
      min_score: optionalNumber(raw.fallback?.min_score, d.fallback.min_score, 0, "fallback.min_score", 1),
      apply_on_error: booleanValue(raw.fallback?.apply_on_error,
        d.fallback.apply_on_error, "fallback.apply_on_error"),
    },
    evaluator_model: optionalModel(
      raw.evaluator_model !== undefined ? raw.evaluator_model : raw.judge_model,
      "evaluator_model",
    ),
    max_usd_per_m: optionalNumber(raw.max_usd_per_m, d.max_usd_per_m, 0, "max_usd_per_m"),
    route_overrides: routeOverrides(raw.route_overrides),
    pi: { provider_extensions: providerExtensions(raw.pi?.provider_extensions) },
  };
}

/** Match either a logical vendor/model id or its concrete route provider. */
export function providerAllowed(policy: Policy, modelId: string, routeProvider?: string): boolean {
  const vendor = modelId.split("/")[0];
  const match = (pat: string) =>
    pat === "*" || pat === modelId || pat === routeProvider ||
    (pat.endsWith("/*") && (pat.slice(0, -2) === vendor || pat.slice(0, -2) === routeProvider));
  if (policy.providers.deny.some(match)) return false;
  return policy.providers.allow.some(match);
}

export interface GateInput {
  /** Expected quality gain over current model (candidate score - current score). */
  scoreGain: number;
  /** candidate price / current price (1 if unknown). */
  priceRatio: number;
  /** Both candidate and baseline exposed trustworthy pricing. */
  priceKnown?: boolean;
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
  if (input.priceKnown === false) {
    reasons.push("candidate or current-model price is unknown");
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
