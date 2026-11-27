import type { EciEstimate, EciRow } from "../engine/eci.ts";

/** A model the user's connections can run, placed on the ECI scale. */
export interface Candidate {
  /** `provider/id` as Pi names it, such as `openrouter/deepseek/deepseek-v4-pro` or `anthropic/claude-sonnet-5-5`. */
  model: string;
  provider: string;
  id: string;
  name: string;
  /** Epoch Capabilities Index: published, or ScoutBM's estimate from the bundled CSV. */
  eci: number;
  /** The Epoch row, or the catalogue model the estimate belongs to. */
  eciModel: string;
  eciSource: "published" | "estimated" | "calibrated";
  /** Standard error of an estimated or calibrated ECI. */
  eciError?: number;
  /** List price in USD per million input plus output tokens; null when unknown. Measured cost decides ties, not this. */
  price: number | null;
}

/** The parts of a Pi model this module reads. */
export interface RunnableModel {
  provider: string;
  id: string;
  name: string;
  cost?: { input: number; output: number };
}

export interface CandidateFilter {
  /** Connected providers to draw candidates from, in preference order when two serve the same model. */
  providers?: string[];
  /** The task calls tools: drop models known not to support tool calls. */
  tools?: boolean;
  /** `provider/id` → supports tool calls. Models missing from the map are kept. */
  toolSupport?: ReadonlyMap<string, boolean>;
  /** Drop models whose list price (input + output per million tokens) is above this. */
  maxPrice?: number;
  /** Case-insensitive substrings; a model whose `provider/id` contains any is dropped. */
  exclude?: string[];
  /** Keep only models whose `provider/id` contains one of these. */
  include?: string[];
}

/** Exact names only, ignoring case and punctuation: "GPT-6.1 Sol" = "gpt-6.1-sol", never "GPT-6.1". */
export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Aliases (`~…`, `-latest`), batch-only and free-tier variants are not separate models,
 * and free tiers are rate limited and may train on prompts.
 */
const ALIAS = /(^~|-latest$|:batch$|:free$|:extended$)/;

/**
 * Every runnable model with an ECI, ascending. A published Epoch row wins; otherwise ScoutBM's
 * estimated or calibrated ECI from the bundled CSV, matched by OpenRouter ID or exact name. Each
 * Epoch row or estimate is used by at most one model: the first connected provider, then the
 * cheapest listing. Models with neither are reported as unranked, never guessed.
 */
export function rankCandidates(models: readonly RunnableModel[], rows: readonly EciRow[], filter: CandidateFilter = {}, estimates: readonly EciEstimate[] = []) {
  const byName = new Map<string, Set<EciRow>>();
  for (const row of rows) for (const name of row.names) byName.set(nameKey(name), (byName.get(nameKey(name)) ?? new Set()).add(row));
  const providers = filter.providers ?? [...new Set(models.map(model => model.provider))];
  const lower = (list?: string[]) => list?.map(item => item.toLowerCase());
  const include = lower(filter.include), exclude = lower(filter.exclude);
  const unranked: string[] = [];
  const dropped: { model: string; reason: string }[] = [];
  const best = new Map<EciRow | EciEstimate, Candidate>();
  const estimateById = new Map(estimates.flatMap(item => [[item.catalogueModel.toLowerCase(), item], ...(item.openRouterId ? [[item.openRouterId.toLowerCase(), item] as const] : [])]));
  const estimateByName = new Map<string, Set<EciEstimate>>();
  for (const item of estimates) for (const name of [item.name, item.catalogueModel.split("/").at(-1)!]) estimateByName.set(nameKey(name), (estimateByName.get(nameKey(name)) ?? new Set()).add(item));
  for (const model of models) {
    const full = `${model.provider}/${model.id}`;
    if (!providers.includes(model.provider) || ALIAS.test(model.id)) continue;
    const id = full.toLowerCase();
    if (include && !include.some(item => id.includes(item))) continue;
    if (exclude?.some(item => id.includes(item))) { dropped.push({ model: full, reason: "excluded" }); continue; }
    if (filter.tools && filter.toolSupport?.get(full) === false) { dropped.push({ model: full, reason: "no tool calls" }); continue; }
    const price = model.cost && Number.isFinite(model.cost.input + model.cost.output) ? model.cost.input + model.cost.output : null;
    if (filter.maxPrice !== undefined && price !== null && price > filter.maxPrice) { dropped.push({ model: full, reason: `price ${price} > ${filter.maxPrice}` }); continue; }
    const names = [model.name.replace(/^[^:]+:\s*/, ""), model.name, model.id.split("/").at(-1)!];
    const matches = new Set(names.flatMap(name => [...byName.get(nameKey(name)) ?? []]));
    let row: EciRow | EciEstimate;
    let candidate: Candidate;
    if (matches.size === 1) {
      const published = [...matches][0]!;
      row = published;
      candidate = { model: full, provider: model.provider, id: model.id, name: model.name, eci: published.eci, eciModel: published.model, eciSource: "published", price };
    } else {
      const byId = model.provider === "openrouter" ? estimateById.get(model.id.toLowerCase()) : undefined;
      const byNames = new Set(names.flatMap(name => [...estimateByName.get(nameKey(name)) ?? []]));
      const estimate = byId ?? (byNames.size === 1 ? [...byNames][0]! : undefined);
      if (!estimate) { unranked.push(full); continue; }
      row = estimate;
      candidate = { model: full, provider: model.provider, id: model.id, name: model.name, eci: estimate.eci, eciModel: estimate.catalogueModel, eciSource: estimate.source, eciError: estimate.standardError, price };
    }
    const current = best.get(row);
    const better = !current
      || providers.indexOf(candidate.provider) < providers.indexOf(current.provider)
      || (candidate.provider === current.provider && (candidate.price ?? Infinity) < (current.price ?? Infinity));
    if (better) best.set(row, candidate);
  }
  return { candidates: rank([...best.values()]), unranked: unranked.sort(), dropped };
}

/** Ascending ECI; equal scores fall back to model ID purely for repeatability. */
export function rank(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.eci - b.eci || a.model.localeCompare(b.model));
}
