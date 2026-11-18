// A task's candidate models: the catalogue over OpenRouter and the account's own endpoints,
// filtered by the task's needs and guardrails, as a ladder for the search. The provisional pick
// comes from the same pool, by catalogue evidence alone.
import { blendedPrice, catalogueIndex, ladder, pool, type Catalogue, type CatalogueModel, type Funding, type Guardrails, type Ranked } from "./engine.ts";
import type { EndpointKind, TaskBundle } from "./ranking.ts";

/** An endpoint as a job sees it, without its key. */
export interface EndpointInfo { id: string; kind: EndpointKind; baseUrl: string; allowedModels: string[] | "all"; funding: Funding }

export interface Option {
  /** The model: its catalogue ID, or `<endpoint>/<model>` for a model outside the catalogue. */
  key: string;
  model: string;
  endpoint: string;
  /** The model as the endpoint names it. */
  endpointModel: string;
  eci: number | null;
  /** Blended list price per million tokens; null when unknown. */
  price: number | null;
  funding: Funding;
  inCatalogue: boolean;
}

export interface Pool { baseline: Option | null; ranked: (Option & Ranked)[]; unplaced: Option[]; notices: string[] }

export const OPENROUTER = "openrouter";

function optionFor(endpoint: EndpointInfo, model: CatalogueModel | null, endpointModel: string): Option {
  return {
    key: model?.id ?? `${endpoint.id}/${endpointModel}`, model: model?.id ?? endpointModel, endpoint: endpoint.id, endpointModel,
    eci: model?.eci ?? null, price: model ? blendedPrice(model) : null, funding: endpoint.funding, inCatalogue: model !== null,
  };
}

/** Every model an endpoint offers. OpenRouter serves the whole catalogue; other endpoints serve the models the customer listed. */
function offered(endpoint: EndpointInfo, catalogue: Catalogue): Option[] {
  const index = catalogueIndex(catalogue);
  if (endpoint.kind === "openrouter") {
    const models = endpoint.allowedModels === "all" ? catalogue.models : endpoint.allowedModels.map(id => index.find(id)).filter((item): item is CatalogueModel => item !== null);
    return models.map(model => optionFor(endpoint, model, model.id));
  }
  if (endpoint.allowedModels === "all") return [];
  return endpoint.allowedModels.map(id => optionFor(endpoint, index.find(id) ?? (endpoint.kind === "anthropic" ? index.find(`anthropic/${id}`) : null), id));
}

const lower = (items: readonly string[]) => new Set(items.map(item => item.toLowerCase()));

/** Endpoints the guardrails let this task call. */
export function allowedEndpoints(endpoints: readonly EndpointInfo[], guardrails: Guardrails, notices: string[]): EndpointInfo[] {
  let allowed = [...endpoints];
  if (guardrails.endpoints) { const ids = lower(guardrails.endpoints); allowed = allowed.filter(item => ids.has(item.id.toLowerCase())); }
  if (guardrails.allowedProviders) { const names = lower(guardrails.allowedProviders); allowed = allowed.filter(item => names.has(item.id.toLowerCase()) || names.has(item.kind)); }
  if (guardrails.region && allowed.some(item => item.id === OPENROUTER)) {
    // OpenRouter routes to providers in many regions, so it cannot promise one.
    allowed = allowed.filter(item => item.id !== OPENROUTER);
    notices.push(`The ${guardrails.region} data-region guardrail leaves OpenRouter out: only your own endpoints are measured.`);
  }
  return allowed;
}

export function buildPool(input: { catalogue: Catalogue; endpoints: readonly EndpointInfo[]; bundle: TaskBundle; guardrails: Guardrails }): Pool {
  const notices: string[] = [];
  const { catalogue, bundle, guardrails } = input;
  const index = catalogueIndex(catalogue);
  const current = index.find(bundle.current.model);
  const baselineEndpoint = input.endpoints.find(item => item.id === bundle.current.endpoint) ?? input.endpoints.find(item => item.id === OPENROUTER) ?? null;
  // The current model runs where the app runs it, even when the allowed lists leave it out: it is already in production.
  const baseline = baselineEndpoint ? optionFor(baselineEndpoint, current, baselineEndpoint.kind === "openrouter" ? current?.id ?? bundle.current.model : bundle.current.model) : null;
  if (!current) notices.push(`${bundle.current.model} is not in the catalogue, so its price and capability index are unknown.`);

  const models = guardrails.allowedModels ? lower(guardrails.allowedModels) : null;
  const fits = (option: Option) => {
    if (option.key === baseline?.key) return false;
    if (models && !models.has(option.model.toLowerCase()) && !models.has(option.endpointModel.toLowerCase())) return false;
    const model = option.inCatalogue ? index.find(option.model) : null;
    if (model) {
      if (bundle.tools?.length && !model.tools) return false;
      if (bundle.constraints?.needsVision && !model.vision) return false;
      if (bundle.output.kind === "json" && !model.structuredOutputs) return false;
    }
    // Only cheaper models are candidates, when both prices are known.
    return option.price === null || baseline?.price == null || option.price < baseline.price;
  };
  const options = pool(allowedEndpoints(input.endpoints, guardrails, notices), endpoint => offered(endpoint, catalogue), option => option.key).filter(fits);
  const { ranked, unplaced } = ladder(options);
  if (unplaced.length) notices.push(`${unplaced.length} model${unplaced.length === 1 ? " has" : "s have"} no capability index, so ${unplaced.length === 1 ? "it is" : "they are"} measured as challengers and placed by measurement only.`);
  return { baseline, ranked, unplaced, notices };
}

export interface Provisional { model: string; endpoint: string; reason: string; estCostPerCallUsd: number | null }

/** Rough tokens of one call: the prompt's characters over four, and a short answer. */
export function callTokens(bundle: TaskBundle): { input: number; output: number } {
  const prompt = `${bundle.prompt.system ?? ""}${bundle.prompt.messages.map(item => item.content).join("")}${JSON.stringify(bundle.tools ?? [])}`;
  return { input: Math.ceil(prompt.length / 4) + 50, output: bundle.output.kind === "label" ? 10 : 300 };
}

export function callCost(model: CatalogueModel | null, bundle: TaskBundle): number | null {
  if (!model || model.inputPerM === null || model.outputPerM === null) return null;
  const tokens = callTokens(bundle);
  return (tokens.input * model.inputPerM + tokens.output * model.outputPerM) / 1e6;
}

/** The cheapest model in the pool that the catalogue rates at least as capable as the current one; else the current model. */
export function provisionalPick(catalogue: Catalogue, candidates: Pool, bundle: TaskBundle): Provisional {
  const index = catalogueIndex(catalogue);
  const baseline = candidates.baseline;
  const keep = (reason: string): Provisional => ({ model: bundle.current.model, endpoint: baseline?.endpoint ?? OPENROUTER, reason, estCostPerCallUsd: callCost(index.find(bundle.current.model), bundle) });
  if (!baseline || baseline.eci === null) return keep("The catalogue has no capability index for the current model, so only measurement can find a cheaper one. Keep it for now.");
  const pick = candidates.ranked.filter(item => item.eci >= baseline.eci! && item.price !== null).sort((a, b) => a.price! - b.price! || b.eci - a.eci)[0];
  if (!pick) return keep("No cheaper allowed model rates as capable as the current one in the catalogue. Keep it for now.");
  return {
    model: pick.model, endpoint: pick.endpoint, estCostPerCallUsd: callCost(index.find(pick.model), bundle),
    reason: `Catalogue estimate, not yet measured: ECI ${pick.eci} against ${baseline.eci} for ${bundle.current.model}, at $${pick.price!.toFixed(2)} against $${baseline.price?.toFixed(2) ?? "?"} per million input and output tokens. The measured result replaces it.`,
  };
}
