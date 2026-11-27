// Builds the model catalogue from OpenRouter's public model list, Epoch's ECI scores and the bundled
// ECI estimates. scripts/build-catalogue.ts writes data/catalogue.json with it; the hosted server
// refreshes its catalogue with fetchCatalogue once a day.
import { readFile } from "node:fs/promises";
import { CATALOGUE_FORMAT, type Catalogue, type CatalogueModel } from "../engine/catalogue.ts";
import { ECI_ATTRIBUTION, ECI_SCORES_URL, parseEciEstimates, parseEciScores } from "../engine/eci.ts";
import { rankCandidates } from "../scout/candidates.ts";

export const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const ESTIMATES = new URL("../../data/eci-estimates.csv", import.meta.url);

interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  name: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

const perMillion = (value?: string) => (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 1e6 * 1e6) / 1e6 : null);

/** The catalogue from OpenRouter's model list (its JSON text), Epoch's ECI scores (CSV) and the ECI estimates file (CSV). */
export function buildCatalogue(input: { openRouter: string; eci: string; estimates: string; now?: Date }): Catalogue {
  const openRouter = JSON.parse(input.openRouter) as { data: OpenRouterModel[] };
  const estimates = parseEciEstimates(input.estimates);
  const listed = openRouter.data.filter(model => !/(^~|-latest$|:batch$|:free$|:extended$)/.test(model.id));
  const ranked = rankCandidates(
    listed.map(model => ({ provider: "openrouter", id: model.id, name: model.name, cost: { input: perMillion(model.pricing?.prompt) ?? Number.NaN, output: perMillion(model.pricing?.completion) ?? Number.NaN } })),
    parseEciScores(input.eci), {}, estimates.estimates,
  );
  const eciById = new Map(ranked.candidates.map(item => [item.id, item]));
  const models: CatalogueModel[] = listed.map(model => {
    const eci = eciById.get(model.id);
    const bare = model.id.split("/").at(-1)!;
    const aliases = [...new Set([bare, model.canonical_slug, model.canonical_slug?.split("/").at(-1)].filter((item): item is string => !!item && item !== model.id))];
    return {
      id: model.id, name: model.name.replace(/^[^:]+:\s*/, ""), aliases,
      eci: eci ? Math.round(eci.eci * 100) / 100 : null, eciSource: eci?.eciSource ?? null, eciError: eci?.eciError ?? null, eciModel: eci?.eciModel ?? null,
      inputPerM: perMillion(model.pricing?.prompt), outputPerM: perMillion(model.pricing?.completion),
      contextLength: model.context_length ?? null,
      tools: (model.supported_parameters ?? []).includes("tools"),
      structuredOutputs: (model.supported_parameters ?? []).some(item => item === "structured_outputs" || item === "response_format"),
      vision: (model.architecture?.input_modalities ?? []).includes("image"),
      released: model.created ? new Date(model.created * 1000).toISOString().slice(0, 10) : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const generatedAt = (input.now ?? new Date()).toISOString();
  return {
    format: CATALOGUE_FORMAT,
    version: generatedAt.slice(0, 10),
    generatedAt,
    sources: [
      { name: "OpenRouter model list", url: OPENROUTER_MODELS, note: "IDs, list prices, context length, tool and image support" },
      { name: "Epoch Capabilities Index", url: ECI_SCORES_URL, note: ECI_ATTRIBUTION },
      { name: "ScoutBM ECI estimates", url: "data/eci-estimates.csv", note: estimates.provenance },
    ],
    models,
  };
}

/** Downloads OpenRouter's list and Epoch's scores and builds a fresh catalogue. */
export async function fetchCatalogue(fetchFn: typeof fetch = fetch): Promise<Catalogue> {
  const download = async (url: string) => {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.text();
  };
  const [openRouter, eci, estimates] = await Promise.all([download(OPENROUTER_MODELS), download(ECI_SCORES_URL), readFile(ESTIMATES, "utf8")]);
  return buildCatalogue({ openRouter, eci, estimates });
}
