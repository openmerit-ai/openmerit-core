/** Provider-neutral model-route normalization. */

import type { ModelRoute, RouteMetadataOverride, TrialPoint } from "./types.js";

export function meritModelId(provider: string, modelId: string): string {
  if (provider === "openrouter") return modelId;
  return modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`;
}

export function modelRoute(
  provider: string,
  modelId: string,
  details: Partial<Omit<ModelRoute, "provider" | "modelId" | "meritId">> = {},
): ModelRoute {
  return {
    provider,
    modelId,
    meritId: meritModelId(provider, modelId),
    input: details.input ?? ["text"],
    ...details,
  };
}

export function legacyOpenRouterRoute(meritId: string): ModelRoute {
  return modelRoute("openrouter", meritId);
}

export function routeKey(route: ModelRoute): string {
  return `${route.provider}:${route.modelId}`;
}

/** Apply user metadata only to the exact provider route it names. */
export function applyRouteOverrides(
  routes: ModelRoute[], overrides: Record<string, RouteMetadataOverride>,
): ModelRoute[] {
  return routes.map((route) => {
    const override = overrides[routeKey(route)];
    if (!override) return route;
    return {
      ...route,
      ...(override.cost ? { cost: { ...override.cost } } : {}),
      ...(override.context_window === undefined ? {} : { contextWindow: override.context_window }),
      ...(override.max_tokens === undefined ? {} : { maxTokens: override.max_tokens }),
      ...(override.input ? { input: [...override.input] } : {}),
    };
  });
}

export function pointKey(point: Pick<TrialPoint, "model" | "route">): string {
  return point.route ? routeKey(point.route) : `openrouter:${point.model}`;
}

export function routeLabel(route: ModelRoute): string {
  return route.provider === "openrouter" ? route.meritId : `${route.meritId} via ${route.provider}`;
}

export function routePrice(route: ModelRoute): { price: number; known: boolean } {
  if (!route.cost || !Number.isFinite(route.cost.input) || !Number.isFinite(route.cost.output) ||
      route.cost.input < 0 || route.cost.output < 0)
    return { price: 0, known: false };
  return { price: Math.round(((route.cost.input + route.cost.output) / 2 + Number.EPSILON) * 1e4) / 1e4,
    known: true };
}

/** Estimate one request from Pi's dollars-per-million-token route metadata. */
export function estimateRouteCost(
  route: ModelRoute, inputTokens: number, outputTokens: number,
): { known: boolean; usd: number } {
  if (!route.cost) return { known: false, usd: 0 };
  return {
    known: true,
    usd: (route.cost.input * inputTokens + route.cost.output * outputTokens) / 1_000_000,
  };
}
