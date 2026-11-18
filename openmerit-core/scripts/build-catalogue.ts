// Maintainers: regenerate the bundled model/evidence catalogue (data/catalogue.json).
//   node scripts/build-catalogue.ts [--openrouter models.json] [--eci eci_scores.csv]
// Without file arguments it downloads OpenRouter's public model list and Epoch's ECI scores. The
// installed package never downloads either: Scout reads only the file this script writes.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CATALOGUE_FORMAT, type Catalogue, type CatalogueModel } from "../src/engine/catalogue.ts";
import { rankCandidates } from "../src/scout/candidates.ts";
import { ECI_ATTRIBUTION, ECI_SCORES_URL, parseEciEstimates, parseEciScores } from "../src/engine/eci.ts";

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const { values } = parseArgs({ options: { openrouter: { type: "string" }, eci: { type: "string" }, out: { type: "string", default: new URL("../data/catalogue.json", import.meta.url).pathname } } });

const download = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
};

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

const openRouter = JSON.parse(values.openrouter ? await readFile(values.openrouter, "utf8") : await download(OPENROUTER_MODELS)) as { data: OpenRouterModel[] };
const eciText = values.eci ? await readFile(values.eci, "utf8") : await download(ECI_SCORES_URL);
const estimates = parseEciEstimates(await readFile(new URL("../data/eci-estimates.csv", import.meta.url), "utf8"));
const rows = parseEciScores(eciText);
const perMillion = (value?: string) => (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 1e6 * 1e6) / 1e6 : null);

const listed = openRouter.data.filter(model => !/(^~|-latest$|:batch$|:free$|:extended$)/.test(model.id));
const ranked = rankCandidates(
  listed.map(model => ({ provider: "openrouter", id: model.id, name: model.name, cost: { input: perMillion(model.pricing?.prompt) ?? Number.NaN, output: perMillion(model.pricing?.completion) ?? Number.NaN } })),
  rows, {}, estimates.estimates,
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

const generatedAt = new Date().toISOString();
const catalogue: Catalogue = {
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
await writeFile(values.out, `${JSON.stringify(catalogue, null, 1)}\n`);
const counts = { published: 0, estimated: 0, calibrated: 0 };
for (const model of models) if (model.eciSource) counts[model.eciSource]++;
process.stdout.write(`${values.out}: ${models.length} models, ${models.filter(model => model.eci !== null).length} with an ECI (${JSON.stringify(counts)})\n`);
