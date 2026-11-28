// A task's candidate models: the catalogue over OpenRouter and the account's own endpoints,
// filtered by the task's needs and guardrails, as a ladder for the search. The provisional pick
// comes from the same pool, by catalogue evidence alone.
import { blendedPrice, catalogueIndex, eligible, ladder, pool, provisionalPick as pickFromCatalogue, type Catalogue, type CatalogueModel, type Funding, type Guardrails, type Provisional, type Ranked } from "../engine/index.ts";
import { callCost, type EndpointKind, type TaskBundle } from "../ranking/index.ts";

export type { Provisional };

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

/**
 * Every model an endpoint offers. OpenRouter serves the whole catalogue's ranked models: one without
 * an ECI has no place in the search, so it is left out, as the CLI leaves it out. A model the
 * customer lists by name, on their own endpoint or in an OpenRouter list, is offered either way and
 * is measured as a challenger when it has no ECI.
 */
function offered(endpoint: EndpointInfo, catalogue: Catalogue): Option[] {
  const index = catalogueIndex(catalogue);
  if (endpoint.kind === "openrouter") {
    const models = endpoint.allowedModels === "all" ? catalogue.models.filter(model => model.eci !== null) : endpoint.allowedModels.map(id => index.find(id)).filter((item): item is CatalogueModel => item !== null);
    return models.map(model => optionFor(endpoint, model, model.id));
  }
  if (endpoint.allowedModels === "all") return [];
  return endpoint.allowedModels.map(id => optionFor(endpoint, index.find(id) ?? (endpoint.kind === "anthropic" ? index.find(`anthropic/${id}`) : null), id));
}

const lower = (items: readonly string[]) => new Set(items.map(item => item.toLowerCase()));

export const regionNotice = (region: string) => `The ${region} data-region guardrail leaves OpenRouter out: only your own endpoints are measured.`;

/** Endpoints the guardrails let this task call. */
export function allowedEndpoints(endpoints: readonly EndpointInfo[], guardrails: Guardrails, notices: string[]): EndpointInfo[] {
  let allowed = [...endpoints];
  if (guardrails.endpoints) { const ids = lower(guardrails.endpoints); allowed = allowed.filter(item => ids.has(item.id.toLowerCase())); }
  if (guardrails.allowedProviders) { const names = lower(guardrails.allowedProviders); allowed = allowed.filter(item => names.has(item.id.toLowerCase()) || names.has(item.kind)); }
  if (guardrails.region && allowed.some(item => item.id === OPENROUTER)) {
    // OpenRouter routes to providers in many regions, so it cannot promise one.
    allowed = allowed.filter(item => item.id !== OPENROUTER);
    notices.push(regionNotice(guardrails.region));
  }
  return allowed;
}

/**
 * The job's pool. `wide`, for the criteria bar once a person marked the current model's own answers
 * wrong: every eligible model whatever its price, as the CLI's wide pool, but the current model, which
 * runs as the baseline.
 */
export function buildPool(input: { catalogue: Catalogue; endpoints: readonly EndpointInfo[]; bundle: TaskBundle; guardrails: Guardrails; wide?: boolean }): Pool {
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
    // openmerit/engine's rule, as the CLI applies it; a model outside the catalogue is placed by measurement only.
    const model = option.inCatalogue ? index.find(option.model) : null;
    if (input.wide) return !model || (model.id !== current?.id && eligible(model, null, needs));
    return !model || eligible(model, current, needs);
  };
  const needs = { tools: !!bundle.tools?.length, vision: !!bundle.constraints?.needsVision, structuredOutput: bundle.output.kind === "json" };
  const endpoints = allowedEndpoints(input.endpoints, guardrails, notices);
  const options = pool(endpoints, endpoint => offered(endpoint, catalogue), option => option.key).filter(fits);
  if (endpoints.some(item => item.kind === "openrouter" && item.allowedModels === "all")) {
    const unranked = catalogue.models.filter(model => model.eci === null && model.id !== current?.id).length;
    if (unranked) notices.push(`${unranked} catalogue model${unranked === 1 ? "" : "s"} without an ECI left out: the search places models by their capability index.`);
  }
  const { ranked, unplaced } = ladder(options);
  if (unplaced.length) notices.push(`${unplaced.length} model${unplaced.length === 1 ? " has" : "s have"} no capability index, so ${unplaced.length === 1 ? "it is" : "they are"} measured as challengers and placed by measurement only.`);
  return { baseline, ranked, unplaced, notices };
}

/**
 * The models a catalogue refresh could bring into a search: new ones, ones that got an ECI, and ones whose list price
 * fell. A price rise or a dropped model only makes a past result more true, so it starts nothing.
 */
export function catalogueChanges(before: Catalogue, after: Catalogue): string[] {
  const old = new Map(before.models.map(model => [model.id, model]));
  return after.models.filter(model => {
    const was = old.get(model.id);
    if (!was) return true;
    if (was.eci === null && model.eci !== null) return true;
    const [price, wasPrice] = [blendedPrice(model), blendedPrice(was)];
    return price !== null && (wasPrice === null || price < wasPrice);
  }).map(model => model.id);
}

/**
 * The changed models that could beat what a watched task has now: in the pool a job would search, with the same
 * endpoints, guardrails and needs; rated at least as capable as the current model (ECI), when the catalogue rates it;
 * and cheaper per token than its pick, or than its current model when it has none. `wide` is the criteria bar's pool,
 * which has no price ceiling but the pick's.
 */
export function couldBeat(input: { catalogue: Catalogue; endpoints: readonly EndpointInfo[]; bundle: TaskBundle; guardrails: Guardrails; wide: boolean; pick: string | null; changed: readonly string[] }): string[] {
  const changed = new Set(input.changed);
  if (!changed.size) return [];
  const index = catalogueIndex(input.catalogue);
  const floor = index.find(input.bundle.current.model)?.eci ?? null;
  const pick = input.pick ? index.find(input.pick) : null;
  const ceiling = pick ? blendedPrice(pick) : null;
  const { ranked, unplaced } = buildPool(input);
  return [...ranked, ...unplaced]
    .filter(option => option.inCatalogue && changed.has(option.model) && option.model !== pick?.id
      && (floor === null || (option.eci !== null && option.eci >= floor))
      && (ceiling === null || (option.price !== null && option.price < ceiling)))
    .map(option => option.model);
}

/** The cheapest pool model the catalogue rates at least as capable as the current one; else the current model. openmerit/engine's rule. */
export function provisionalPick(catalogue: Catalogue, candidates: Pool, bundle: TaskBundle): Provisional {
  const index = catalogueIndex(catalogue);
  return pickFromCatalogue({ current: bundle.current.model, baseline: candidates.baseline, ranked: candidates.ranked, defaultEndpoint: OPENROUTER, costPerCall: model => callCost(index.find(model), bundle) });
}
