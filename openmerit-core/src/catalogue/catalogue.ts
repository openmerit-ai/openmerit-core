// The model/evidence catalogue bundled with the npm package (data/catalogue.json). Scout reads only
// this file: no hosted catalogue, no download at run time. Package updates refresh it.
import { readFileSync } from "node:fs";

export const CATALOGUE_FORMAT = 1;

export interface CatalogueModel {
  /** OpenRouter-style ID, such as `openai/gpt-6.1-sol`. */
  id: string;
  name: string;
  /** Other spellings code uses for the same model: the bare vendor ID, dated slugs. */
  aliases: string[];
  /** Epoch Capabilities Index: published, or ScoutBM's estimate. Null when neither exists. */
  eci: number | null;
  eciSource: "published" | "estimated" | "calibrated" | null;
  eciError: number | null;
  eciModel: string | null;
  /** List prices in USD per million tokens; null when unknown. */
  inputPerM: number | null;
  outputPerM: number | null;
  contextLength: number | null;
  tools: boolean;
  structuredOutputs: boolean;
  vision: boolean;
  released: string | null;
}

export interface Catalogue {
  format: number;
  /** Date of the snapshot, recorded with every run. */
  version: string;
  generatedAt: string;
  sources: { name: string; url: string; note: string }[];
  models: CatalogueModel[];
}

let cached: Catalogue | null = null;

export function loadCatalogue(path: URL = new URL("../../data/catalogue.json", import.meta.url)): Catalogue {
  if (cached && path.href.endsWith("/data/catalogue.json")) return cached;
  const catalogue = JSON.parse(readFileSync(path, "utf8")) as Catalogue;
  if (catalogue.format !== CATALOGUE_FORMAT || !Array.isArray(catalogue.models)) throw new Error(`Unsupported catalogue format in ${path.pathname}`);
  cached = catalogue;
  return catalogue;
}

/** Anthropic's API writes `claude-sonnet-5-5` where OpenRouter writes `claude-sonnet-5.5`. */
const key = (value: string) => value.toLowerCase().replace(/^openrouter\//, "").replace(/(\d)\.(\d)/g, "$1-$2");

/** Finds a catalogue model by ID or alias, ignoring case and an `openrouter/` prefix. */
export function catalogueIndex(catalogue: Catalogue) {
  const byKey = new Map<string, CatalogueModel>();
  for (const model of catalogue.models) byKey.set(key(model.id), model);
  for (const model of catalogue.models) for (const alias of model.aliases) if (!byKey.has(key(alias))) byKey.set(key(alias), model);
  return { find: (value: string) => byKey.get(key(value)) ?? null, size: byKey.size };
}

/** List price of one request, or null when a price is unknown. */
export function requestPrice(model: Pick<CatalogueModel, "inputPerM" | "outputPerM"> | null, inputTokens: number, outputTokens: number): number | null {
  if (!model || model.inputPerM === null || model.outputPerM === null) return null;
  return (inputTokens * model.inputPerM + outputTokens * model.outputPerM) / 1e6;
}
