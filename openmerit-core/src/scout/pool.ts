// The repository's candidate pool: which catalogue models each configured endpoint may run.
import { catalogueIndex, type Catalogue, type CatalogueModel } from "../catalogue/catalogue.ts";
import type { Endpoint } from "../state/config.ts";

export interface PoolModel { endpoint: Endpoint; endpointModel: string; model: CatalogueModel }

/** How an endpoint names a catalogue model: OpenRouter uses catalogue IDs; OpenAI drops the `openai/` vendor prefix. */
export function endpointModelId(endpoint: Endpoint, model: CatalogueModel): string | null {
  if (endpoint.kind === "openrouter") return model.id;
  if (endpoint.kind === "openai") return model.id.startsWith("openai/") ? model.id.slice("openai/".length) : null;
  return null;
}

/** Every model an endpoint may run under the repository's allowed list. */
export function endpointPool(endpoint: Endpoint, catalogue: Catalogue): PoolModel[] {
  const index = catalogueIndex(catalogue);
  if (endpoint.allowedModels === "all") {
    if (endpoint.kind === "openai-compatible") return [];
    return catalogue.models.flatMap(model => {
      const endpointModel = endpointModelId(endpoint, model);
      return endpointModel ? [{ endpoint, endpointModel, model }] : [];
    });
  }
  return endpoint.allowedModels.flatMap(id => {
    const model = index.find(id) ?? index.find(`${endpoint.kind === "openai" ? "openai/" : ""}${id}`);
    if (!model) return [];
    const endpointModel = endpoint.kind === "openai-compatible" ? id : endpointModelId(endpoint, model);
    return endpointModel ? [{ endpoint, endpointModel, model }] : [];
  });
}

export function pool(endpoints: readonly Endpoint[], catalogue: Catalogue): PoolModel[] {
  const seen = new Set<string>();
  return endpoints.flatMap(endpoint => endpointPool(endpoint, catalogue)).filter(item => !seen.has(item.model.id) && seen.add(item.model.id));
}

/** The proxy's pool check for one endpoint: catalogue model, null for an allowed model without a catalogue entry, undefined when not allowed. */
export function allowedOn(endpoint: Endpoint, catalogue: Catalogue): (endpointModel: string) => CatalogueModel | null | undefined {
  const allowed = new Map(endpointPool(endpoint, catalogue).map(item => [item.endpointModel.toLowerCase(), item.model]));
  const explicit = endpoint.allowedModels === "all" ? null : new Set(endpoint.allowedModels.map(item => item.toLowerCase()));
  return model => allowed.get(model.toLowerCase()) ?? (explicit?.has(model.toLowerCase()) ? null : undefined);
}

/** The endpoint that would run the current (baseline) model: the first one that may run it. */
export function baselineEndpoint(endpoints: readonly Endpoint[], catalogue: Catalogue, modelId: string): PoolModel | null {
  for (const endpoint of endpoints) {
    const match = endpointPool(endpoint, catalogue).find(item => item.model.id === modelId);
    if (match) return match;
  }
  // The baseline must run even when the allowed list leaves it out: it is the model already in production.
  const model = catalogue.models.find(item => item.id === modelId);
  for (const endpoint of endpoints) {
    const endpointModel = model ? endpointModelId(endpoint, model) : null;
    if (model && endpointModel) return { endpoint, endpointModel, model };
  }
  return null;
}

export const blendedPrice = (model: CatalogueModel) => (model.inputPerM === null || model.outputPerM === null ? null : model.inputPerM + model.outputPerM);
