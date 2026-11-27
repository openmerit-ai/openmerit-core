// Maintainers: regenerate the bundled model/evidence catalogue (data/catalogue.json).
//   node scripts/build-catalogue.ts [--openrouter models.json] [--eci eci_scores.csv]
// Without file arguments it downloads OpenRouter's public model list and Epoch's ECI scores. The
// installed package never downloads either: Scout reads only the file this script writes.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildCatalogue, OPENROUTER_MODELS } from "../src/catalogue/build.ts";
import { ECI_SCORES_URL } from "../src/engine/eci.ts";

const { values } = parseArgs({ options: { openrouter: { type: "string" }, eci: { type: "string" }, out: { type: "string", default: new URL("../data/catalogue.json", import.meta.url).pathname } } });

const download = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
};

const catalogue = buildCatalogue({
  openRouter: values.openrouter ? await readFile(values.openrouter, "utf8") : await download(OPENROUTER_MODELS),
  eci: values.eci ? await readFile(values.eci, "utf8") : await download(ECI_SCORES_URL),
  estimates: await readFile(new URL("../data/eci-estimates.csv", import.meta.url), "utf8"),
});
await writeFile(values.out, `${JSON.stringify(catalogue, null, 1)}\n`);
const counts = { published: 0, estimated: 0, calibrated: 0 };
for (const model of catalogue.models) if (model.eciSource) counts[model.eciSource]++;
process.stdout.write(`${values.out}: ${catalogue.models.length} models, ${catalogue.models.filter(model => model.eci !== null).length} with an ECI (${JSON.stringify(counts)})\n`);
