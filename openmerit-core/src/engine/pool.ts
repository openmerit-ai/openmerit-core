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

/** List price in USD per million input plus output tokens; null when either is unknown. */
export const blendedPrice = (model: Pick<CatalogueModel, "inputPerM" | "outputPerM">) => (model.inputPerM === null || model.outputPerM === null ? null : model.inputPerM + model.outputPerM);
