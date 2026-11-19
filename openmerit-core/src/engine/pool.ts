// The candidate pool as a ladder for the search: options from every allowed endpoint, the first
// endpoint keeping a model two of them serve, ordered weakest to strongest by ECI. Options without
// an ECI, such as a fine-tune or a model outside the catalogue, stay apart: the search cannot place
// them, so they are measured as challengers.
import type { CatalogueModel } from "./catalogue.ts";
import { order, type Ranked, type Rung } from "./search.ts";

/** Each endpoint's options in endpoint order; an option two endpoints offer stays with the first, the preferred one. */
export function pool<E, T>(endpoints: readonly E[], optionsOn: (endpoint: E) => readonly T[], key: (option: T) => string): T[] {
  const seen = new Set<string>();
  return endpoints.flatMap(endpoint => optionsOn(endpoint)).filter(option => !seen.has(key(option)) && seen.add(key(option)));
}

/** Options with an ECI as a ladder (`order`), and those without, which only measurement places. */
export function ladder<T extends Rung & { eci: number | null }>(options: readonly T[]): { ranked: (T & Ranked)[]; unplaced: T[] } {
  const placed = (option: T): option is T & Ranked => option.eci !== null;
  return { ranked: order(options.filter(placed)), unplaced: options.filter(option => !placed(option)) };
}

/** What a task needs from a model. */
export interface Needs { tools?: boolean; vision?: boolean; structuredOutput?: boolean }

/**
 * Whether a catalogue model may replace the current one: it is another model, has a list price above
 * zero (free tiers are rate limited and may train on prompts), costs less than the current model when
 * that price is known, and supports what the task needs. A model outside the catalogue, such as a
 * customer's fine-tune, is not judged here: only measurement can place it.
 */
export function eligible(model: CatalogueModel, current: Pick<CatalogueModel, "id" | "inputPerM" | "outputPerM"> | null, needs: Needs): boolean {
  const price = blendedPrice(model);
  if (model.id === current?.id || price === null || price <= 0) return false;
  const ceiling = current ? blendedPrice(current) : null;
  if (ceiling !== null && price >= ceiling) return false;
  if (needs.tools && !model.tools) return false;
  if (needs.vision && !model.vision) return false;
  if (needs.structuredOutput && !model.structuredOutputs) return false;
  return true;
}

/** List price in USD per million input plus output tokens; null when either is unknown. */
export const blendedPrice = (model: Pick<CatalogueModel, "inputPerM" | "outputPerM">) => (model.inputPerM === null || model.outputPerM === null ? null : model.inputPerM + model.outputPerM);
