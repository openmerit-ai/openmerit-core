/** Provider-neutral model-route normalization. */

import type { CatalogEntry, ModelRoute, TrialPoint } from "./types.js";

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

export function pointKey(point: Pick<TrialPoint, "model" | "route">): string {
  return point.route ? routeKey(point.route) : `openrouter:${point.model}`;
}

export function routeLabel(route: ModelRoute): string {
  return route.provider === "openrouter" ? route.meritId : `${route.meritId} via ${route.provider}`;
}

export function routePrice(route: ModelRoute): { price: number; known: boolean } {
  if (!route.cost || !Number.isFinite(route.cost.input) || !Number.isFinite(route.cost.output))
    return { price: 0, known: false };
  return { price: Math.round(((route.cost.input + route.cost.output) / 2 + Number.EPSILON) * 1e4) / 1e4,
    known: true };
}

export function catalogEntryFromRoute(route: ModelRoute): CatalogEntry {
  const priced = routePrice(route);
  return {
    id: route.meritId,
    name: routeLabel(route),
    ctx: route.contextWindow ?? 0,
    pp: route.cost ? route.cost.input / 1e6 : 0,
    pc: route.cost ? route.cost.output / 1e6 : 0,
    price: priced.price,
    priceKnown: priced.known,
    inputModalities: route.input,
    route,
  };
}

export function routeCatalog(routes: ModelRoute[]): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const route of routes) out.set(routeKey(route), catalogEntryFromRoute(route));
  return out;
}

/** Preserve the route while enriching an OpenRouter entry with its live catalog metadata. */
export function enrichRouteEntry(entry: CatalogEntry, live?: CatalogEntry): CatalogEntry {
  if (!live) return entry;
  return { ...live, route: entry.route, id: entry.id, name: entry.name, priceKnown: true };
}
