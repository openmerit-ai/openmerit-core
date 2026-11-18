// Builds data/eci-estimates.csv: ScoutBM's estimated and calibrated Epoch Capabilities Index (ECI)
// for models Epoch does not score, so the package ranks them without Cloudflare R2 at runtime.
// Run by maintainers only, from openmerit-core/:
//   node scripts/build-eci-estimates.ts <catalogue.json>
// <catalogue.json> is a Scout catalogue snapshot (read-only `wrangler r2 object get
// openmerit-scout-catalogue/<recordsKey> --remote --pipe`). Ported from ScoutBM (scoutbm/eci.ts and
// scoutbm/catalogue.ts in thread T-3c01ab55):
// - estimated: catalogue scores on Epoch's own ECI component benchmarks, solved for the ECI those
//   scores imply under Epoch's item-response curves fitted on eci_benchmarks.csv;
// - calibrated: other benchmarks with at least 12 anchor models and |r| ≥ 0.6, mapped to ECI by linear
//   regression (logit for 0–1 scores), inverse-variance mean across benchmarks.
import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "../src/scout/candidates.ts";
import { parseCSV, parseEciScores, type EciRow } from "../src/engine/eci.ts";

const ECI_BENCHMARKS_URL = "https://epoch.ai/data/eci_benchmarks.csv";
const ECI_SCORES_URL = "https://epoch.ai/data/eci_scores.csv";

interface Catalogue {
  checkedAt?: string;
  publication?: { id?: string };
  models: { id: string; name: string }[];
  endpoints: { provider: string; modelId: string }[];
  observations: { benchmark: string; modelId: string; score: number; historical?: boolean; configurations?: string[] }[];
}
interface Component { difficulty: number; slope: number; sd: number; models: number }
interface Calibration { intercept: number; slope: number; sd: number; transform: (score: number) => number }

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const logit = (score: number) => { const p = Math.min(0.99, Math.max(0.01, score)); return Math.log(p / (1 - p)); };

/** Each component's difficulty and slope, by Gauss–Newton least squares with models held at their published ECI. */
export function fitComponents(text: string, scores: readonly EciRow[]): Map<string, Component> {
  const eci = new Map(scores.map(item => [item.model, item.eci]));
  const points = new Map<string, [number, number][]>();
  for (const row of parseCSV(text)) {
    const capability = eci.get(row.Model!), performance = Number(row.performance);
    if (capability === undefined || !Number.isFinite(performance)) continue;
    points.set(row.benchmark!, [...points.get(row.benchmark!) ?? [], [capability, performance]]);
  }
  const components = new Map<string, Component>();
  for (const [benchmark, data] of points) {
    if (data.length < 5) continue;
    let difficulty = mean(data.map(([c]) => c)), slope = 0.1;
    for (let iteration = 0; iteration < 300; iteration++) {
      let a = 0, b = 0, d = 0, gD = 0, gS = 0;
      for (const [c, p] of data) {
        const s = sigmoid(slope * (c - difficulty)), g = s * (1 - s), r = p - s;
        const jD = -slope * g, jS = (c - difficulty) * g;
        a += jD * jD; b += jD * jS; d += jS * jS; gD += jD * r; gS += jS * r;
      }
      const det = a * d - b * b + 1e-12;
      const stepD = clamp((d * gD - b * gS) / det, -5, 5), stepS = clamp((a * gS - b * gD) / det, -0.05, 0.05);
      difficulty += stepD; slope = Math.max(0.005, slope + stepS);
      if (Math.abs(stepD) < 1e-6 && Math.abs(stepS) < 1e-8) break;
    }
    const residual = data.reduce((sum, [c, p]) => sum + (p - sigmoid(slope * (c - difficulty))) ** 2, 0);
    components.set(benchmark, { difficulty, slope, sd: Math.max(0.01, Math.sqrt(residual / Math.max(1, data.length - 2))), models: data.length });
  }
  return components;
}

/** The ECI a model's component scores imply: weighted least squares, solved by Gauss–Newton. */
export function estimateEci(scores: ReadonlyMap<string, number>, components: ReadonlyMap<string, Component>) {
  let capability = 150, information = 0;
  for (let iteration = 0; iteration < 200; iteration++) {
    let gradient = 0;
    information = 0;
    for (const [benchmark, performance] of scores) {
      const component = components.get(benchmark);
      if (!component) continue;
      const s = sigmoid(component.slope * (capability - component.difficulty)), g = component.slope * s * (1 - s), weight = 1 / component.sd ** 2;
      gradient += weight * g * (performance - s); information += weight * g * g;
    }
    if (information < 1e-9) return null;
    const step = clamp(gradient / information, -8, 8);
    capability += step;
    if (Math.abs(step) < 1e-6) break;
  }
  return Number.isFinite(capability) ? { eci: capability, standardError: 1 / Math.sqrt(information) } : null;
}

const MIN_ANCHORS = 12, MIN_CORRELATION = 0.6;

export function calibrate(scores: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>, anchors: ReadonlyMap<string, number>): Map<string, Calibration> {
  const calibrations = new Map<string, Calibration>();
  for (const [benchmark, byModel] of scores) {
    const all = [...byModel.values()].flat();
    const transform = all.every(score => score >= 0 && score <= 1) ? logit : (score: number) => score;
    const points = [...byModel].filter(([model]) => anchors.has(model)).map(([model, values]) => [transform(mean(values)), anchors.get(model)!] as const);
    if (points.length < MIN_ANCHORS) continue;
    const mx = mean(points.map(([x]) => x)), my = mean(points.map(([, y]) => y));
    const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0), syy = points.reduce((sum, [, y]) => sum + (y - my) ** 2, 0);
    if (sxx === 0 || syy === 0) continue;
    const sxy = points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0);
    if (Math.abs(sxy / Math.sqrt(sxx * syy)) < MIN_CORRELATION) continue;
    const slope = sxy / sxx, intercept = my - slope * mx;
    const residual = points.reduce((sum, [x, y]) => sum + (y - intercept - slope * x) ** 2, 0);
    calibrations.set(benchmark, { intercept, slope, sd: Math.max(0.5, Math.sqrt(residual / (points.length - 2))), transform });
  }
  return calibrations;
}

export function calibratedEci(model: string, scores: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>, calibrations: ReadonlyMap<string, Calibration>) {
  const estimates: { eci: number; weight: number; benchmark: string; sd: number }[] = [];
  for (const [benchmark, calibration] of calibrations) {
    const values = scores.get(benchmark)?.get(model);
    if (!values?.length) continue;
    estimates.push({ eci: calibration.intercept + calibration.slope * calibration.transform(mean(values)), weight: calibration.sd ** -2, benchmark, sd: calibration.sd });
  }
  if (!estimates.length) return null;
  const total = estimates.reduce((sum, item) => sum + item.weight, 0);
  // Related boards are not independent: the error is the best single benchmark's, not a pooled one.
  return { eci: estimates.reduce((sum, item) => sum + item.eci * item.weight, 0) / total, standardError: Math.min(...estimates.map(item => item.sd)), benchmarks: estimates.map(item => item.benchmark).sort() };
}

/** Catalogue benchmarks from other sources that run the same test as an ECI component. */
const COMPONENT_ALIASES: Record<string, string> = { "vendor:gpqa": "GPQA diamond", "aa:gpqa": "GPQA diamond", "vendor:mmlu": "MMLU" };

const csvField = (value: string | number) => { const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node scripts/build-eci-estimates.ts <scout-catalogue.json>");
  const catalogue = JSON.parse(await readFile(path, "utf8")) as Catalogue;
  const get = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`${url} HTTP ${response.status}`); return response.text(); };
  const [scoresText, benchmarksText] = await Promise.all([get(ECI_SCORES_URL), get(ECI_BENCHMARKS_URL)]);
  const rows = parseEciScores(scoresText);
  const components = fitComponents(benchmarksText, rows);

  const rowsByName = new Map<string, Set<EciRow>>();
  for (const row of rows) for (const name of row.names) rowsByName.set(nameKey(name), (rowsByName.get(nameKey(name)) ?? new Set()).add(row));
  const names = new Map<string, Set<string>>();
  for (const model of catalogue.models) names.set(model.id, new Set([model.name, model.id.split("/").at(-1) ?? ""].filter(Boolean)));
  const component = new Map<string, Map<string, number[]>>();
  const other = new Map<string, Map<string, number[]>>();
  for (const item of catalogue.observations) {
    if (item.historical || !Number.isFinite(item.score)) continue;
    const epoch = item.benchmark.startsWith("epoch:");
    if (epoch) for (const name of item.configurations ?? []) names.get(item.modelId)?.add(name);
    const benchmark = epoch ? item.benchmark.slice("epoch:".length) : COMPONENT_ALIASES[item.benchmark];
    if (!benchmark || !components.has(benchmark)) {
      const scores = other.get(item.benchmark) ?? new Map<string, number[]>();
      scores.set(item.modelId, [...scores.get(item.modelId) ?? [], item.score]);
      other.set(item.benchmark, scores);
      continue;
    }
    if (!(item.score >= 0 && item.score <= 1)) continue;
    const scores = component.get(item.modelId) ?? new Map<string, number[]>();
    scores.set(benchmark, [...scores.get(benchmark) ?? [], item.score]);
    component.set(item.modelId, scores);
  }

  // A model with exactly one Epoch row, not claimed by another catalogue model, ranks on the published ECI at runtime.
  const matched = new Map<string, EciRow>();
  for (const model of catalogue.models) {
    const found = new Set([...names.get(model.id) ?? []].flatMap(name => [...rowsByName.get(nameKey(name)) ?? []]));
    if (found.size === 1) matched.set(model.id, [...found][0]!);
  }
  const claims = new Map<EciRow, number>();
  for (const row of matched.values()) claims.set(row, (claims.get(row) ?? 0) + 1);
  const anchors = new Map([...matched].map(([model, row]) => [model, row.eci]));
  const calibrations = calibrate(other, anchors);

  const openRouter = new Set(catalogue.endpoints.filter(endpoint => endpoint.provider === "OpenRouter").map(endpoint => endpoint.modelId));
  const lines: string[] = [];
  const counts = { published: 0, estimated: 0, calibrated: 0, unranked: 0 };
  for (const model of catalogue.models) {
    const row = matched.get(model.id);
    if (row && claims.get(row) === 1) { counts.published++; continue; }
    const scores = new Map([...component.get(model.id) ?? []].map(([benchmark, values]) => [benchmark, mean(values)]));
    const estimate = scores.size ? estimateEci(scores, components) : null;
    const calibrated = estimate ? null : calibratedEci(model.id, other, calibrations);
    const value = estimate ? { ...estimate, source: "estimated", benchmarks: [...scores.keys()].sort() } : calibrated ? { ...calibrated, source: "calibrated" } : null;
    if (!value) { counts.unranked++; continue; }
    counts[value.source as "estimated" | "calibrated"]++;
    lines.push([model.id, model.name, openRouter.has(model.id) ? model.id : "", value.eci.toFixed(2), value.source, value.standardError.toFixed(2), value.benchmarks.join("; ")].map(csvField).join(","));
  }
  const header = "catalogue_model,name,openrouter_id,eci,eci_source,standard_error,benchmarks";
  const provenance = `# ScoutBM ECI estimates. Catalogue ${catalogue.publication?.id ?? "unknown"} checked ${catalogue.checkedAt ?? "unknown"}; Epoch ECI fetched ${new Date().toISOString()} (${ECI_SCORES_URL}, ${ECI_BENCHMARKS_URL}; CC BY 4.0). Regenerate with scripts/build-eci-estimates.ts.`;
  await writeFile(new URL("../data/eci-estimates.csv", import.meta.url), `${provenance}\n${header}\n${lines.sort().join("\n")}\n`);
  process.stdout.write(`${JSON.stringify({ components: components.size, calibrations: calibrations.size, ...counts })}\n`);
}

await main();
