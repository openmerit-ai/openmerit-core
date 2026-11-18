// Epoch Capabilities Index (ECI): the public, openly licensed capability ranking Scout's binary
// search orders candidates by. Ported from the ScoutBM prototype (published scores only).

export const ECI_SCORES_URL = "https://epoch.ai/data/eci_scores.csv";
export const ECI_ATTRIBUTION = "Epoch AI, 'Epoch Capabilities Index'. Published online at epoch.ai. CC BY 4.0.";

export interface EciRow {
  /** Epoch's model key. */
  model: string;
  /** Every name Epoch lists for the model: key, display name and model versions. */
  names: string[];
  eci: number;
  ciLow: number | null;
  ciHigh: number | null;
  date: string | null;
}

/** RFC 4180 fields: commas, quotes and newlines inside quoted values. */
export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter(item => item.some(Boolean));
  return body.map(cells => Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()])));
}

const num = (value: string | undefined) => (value && Number.isFinite(Number(value)) ? Number(value) : null);

export function parseEciScores(text: string): EciRow[] {
  const rows = parseCSV(text);
  const missing = ["Model", "Display name", "eci", "model_versions"].filter(name => rows[0] && !(name in rows[0]));
  if (!rows.length || missing.length) throw new Error(`Epoch eci_scores.csv is empty or missing columns: ${missing.join(", ")}`);
  const scored = rows.filter(row => row.Model && num(row.eci) !== null).map(row => ({
    model: row.Model!, eci: num(row.eci)!, ciLow: num(row.eci_ci_low), ciHigh: num(row.eci_ci_high), date: row.date || null,
    names: [...new Set([row.Model!, row["Display name"]!, ...row.model_versions!.split(",").map(item => item.trim())].filter(Boolean))],
  }));
  if (new Set(scored.map(item => item.model)).size !== scored.length) throw new Error("Duplicate Epoch ECI model rows; retry the download");
  return scored;
}

export interface EciSource {
  source: string;
  url: string;
  attribution: string;
  fetchedAt: string;
  rows: EciRow[];
}

export async function loadEci(request: typeof fetch = fetch): Promise<EciSource> {
  const response = await request(ECI_SCORES_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Epoch ECI HTTP ${response.status}; no fallback ranking is used`);
  return { source: "Epoch Capabilities Index", url: ECI_SCORES_URL, attribution: ECI_ATTRIBUTION, fetchedAt: new Date().toISOString(), rows: parseEciScores(await response.text()) };
}

/** ScoutBM's estimated or calibrated ECI for a model Epoch does not score, from the bundled CSV. */
export interface EciEstimate {
  catalogueModel: string;
  name: string;
  openRouterId: string | null;
  eci: number;
  source: "estimated" | "calibrated";
  standardError: number;
  benchmarks: string[];
}

export function parseEciEstimates(text: string): { provenance: string; estimates: EciEstimate[] } {
  const lines = text.split("\n");
  const provenance = lines.filter(line => line.startsWith("#")).map(line => line.slice(1).trim()).join(" ");
  const rows = parseCSV(lines.filter(line => !line.startsWith("#")).join("\n"));
  const estimates = rows.flatMap(row => {
    const eci = num(row.eci), standardError = num(row.standard_error);
    if (!row.catalogue_model || eci === null || (row.eci_source !== "estimated" && row.eci_source !== "calibrated")) return [];
    return [{
      catalogueModel: row.catalogue_model, name: row.name ?? row.catalogue_model, openRouterId: row.openrouter_id || null, eci,
      source: row.eci_source, standardError: standardError ?? 0, benchmarks: (row.benchmarks ?? "").split(";").map(item => item.trim()).filter(Boolean),
    } satisfies EciEstimate];
  });
  return { provenance, estimates };
}

/** The CSV shipped in the package (data/eci-estimates.csv): no network, no Cloudflare. */
export async function loadEciEstimates(): Promise<{ provenance: string; estimates: EciEstimate[] }> {
  const { readFile } = await import("node:fs/promises");
  return parseEciEstimates(await readFile(new URL("../../data/eci-estimates.csv", import.meta.url), "utf8"));
}
