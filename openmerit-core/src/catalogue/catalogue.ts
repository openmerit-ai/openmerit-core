// The model/evidence catalogue bundled with the npm package (data/catalogue.json). Scout reads only
// this file: no hosted catalogue, no download at run time. Package updates refresh it.
import { readFileSync } from "node:fs";
import { CATALOGUE_FORMAT, type Catalogue } from "../engine/catalogue.ts";

let cached: Catalogue | null = null;

export function loadCatalogue(path: URL = new URL("../../data/catalogue.json", import.meta.url)): Catalogue {
  if (cached && path.href.endsWith("/data/catalogue.json")) return cached;
  const catalogue = JSON.parse(readFileSync(path, "utf8")) as Catalogue;
  if (catalogue.format !== CATALOGUE_FORMAT || !Array.isArray(catalogue.models)) throw new Error(`Unsupported catalogue format in ${path.pathname}`);
  cached = catalogue;
  return catalogue;
}
