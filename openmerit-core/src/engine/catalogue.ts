// Catalogue types and lookups: the models Scout can rank, their ECI and list prices. Pure, so the
// CLI (which bundles data/catalogue.json) and the cloud app (which refreshes it daily) share them.

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

/** Anthropic's API writes `claude-sonnet-5-5` where OpenRouter writes `claude-sonnet-5.5`. */
const key = (value: string) => value.toLowerCase().replace(/^openrouter\//, "").replace(/(\d)\.(\d)/g, "$1-$2");

/**
 * The same model as applications and SDKs often write it, to try when the exact ID is not in the catalogue:
 * without a `provider:` prefix (LangChain, pydantic-ai: `openai:gpt-4.1`, `google_genai:gemini-3.5-flash`),
 * an SDK route (`azure/`, `gemini/`, `models/`), Bedrock's region and vendor parts and version suffix
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), then without a snapshot date or `-latest`.
 */
function variants(value: string): string[] {
  const bare = value
    .replace(/^[a-z][a-z_-]*:(?!\/)/i, "")
    .replace(/^(?:azure|azure_ai|gemini|vertex_ai|bedrock|models|groq|together_ai|fireworks_ai|mistral|deepseek|xai)\//i, "")
    .replace(/^(?:[a-z]{2}\.)?(?:anthropic|amazon|meta|mistral|cohere)\.(?=[a-z])/i, "").replace(/-v\d+(?::\d+)?$/i, "");
  return [bare, bare.replace(/-(?:20\d{6}|20\d{2}-\d{2}-\d{2})$/, "").replace(/-latest$/i, "")];
}

/** Finds a catalogue model by ID or alias, ignoring case and an `openrouter/` prefix, then by the forms `variants` lists. */
export function catalogueIndex(catalogue: Catalogue) {
  const byKey = new Map<string, CatalogueModel>();
  for (const model of catalogue.models) byKey.set(key(model.id), model);
  for (const model of catalogue.models) for (const alias of model.aliases) if (!byKey.has(key(alias))) byKey.set(key(alias), model);
  const find = (value: string) => byKey.get(key(value)) ?? variants(value).map(item => byKey.get(key(item))).find(Boolean) ?? null;
  return { find, size: byKey.size };
}

/** List price of one request, or null when a price is unknown. */
export function requestPrice(model: Pick<CatalogueModel, "inputPerM" | "outputPerM"> | null, inputTokens: number, outputTokens: number): number | null {
  if (!model || model.inputPerM === null || model.outputPerM === null) return null;
  return (inputTokens * model.inputPerM + outputTokens * model.outputPerM) / 1e6;
}
