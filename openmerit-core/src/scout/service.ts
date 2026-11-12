import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connectionFromEnv, createLangfuseConnector, type LangfuseConnector } from "../connectors/langfuse/index.ts";
import { openRouterToolSupport, rankCandidates, type CandidateFilter, type RunnableModel } from "./candidates.ts";
import { loadEci, loadEciEstimates, type EciEstimate, type EciSource } from "./eci.ts";
import { loadEvaluatorPlugin } from "./evaluators/module.ts";
import { piEvaluator, type ModelCaller, type PiTaskSpec } from "./evaluators/pi.ts";
import { runScout, type ScoutReport } from "./pipeline.ts";
import { reportMarkdown } from "./report.ts";
import { FINALISTS, SAMPLE_SIZE, type EvalItem } from "./search.ts";

/** Everything Scout's tools need from the host: Pi's models and credentials, and where to write. */
export interface ScoutHost {
  caller: ModelCaller;
  models: () => Promise<RunnableModel[]>;
  cwd: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** The model Scout itself runs on, used as the default judge. */
  scoutModel?: string;
}

let eciCache: Promise<EciSource> | null = null;
let toolCache: Promise<Map<string, boolean>> | null = null;
let estimateCache: Promise<{ provenance: string; estimates: EciEstimate[] }> | null = null;
const eci = () => (eciCache ??= loadEci().catch(error => { eciCache = null; throw error; }));
const tools = () => (toolCache ??= openRouterToolSupport().catch(error => { toolCache = null; throw error; }));

export function langfuseFromEnv(env: Record<string, string | undefined>): LangfuseConnector | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return createLangfuseConnector(connectionFromEnv(env), { environment: "openmerit" });
}

export async function connections(host: ScoutHost) {
  const models = await host.models();
  const providers: Record<string, number> = {};
  for (const model of models) providers[model.provider] = (providers[model.provider] ?? 0) + 1;
  const lf = langfuseFromEnv(host.env);
  let langfuse: { connected: boolean; project?: string; baseUrl?: string; datasets?: string[]; error?: string } = { connected: false };
  if (lf) {
    try {
      const project = await lf.check();
      langfuse = { connected: true, project: project.projectName, baseUrl: project.baseUrl, datasets: (await lf.listDatasets()).map(item => item.name) };
    } catch (error) {
      langfuse = { connected: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { providers, scoutModel: host.scoutModel ?? null, langfuse };
}

export async function candidates(host: ScoutHost, filter: CandidateFilter) {
  const [source, support, bundled] = await Promise.all([eci(), filter.tools ? tools() : Promise.resolve(undefined), estimateCache ??= loadEciEstimates()]);
  const ranked = rankCandidates(await host.models(), source.rows, { ...filter, ...(support ? { toolSupport: support } : {}) }, bundled.estimates);
  const bySource = (name: string) => ranked.candidates.filter(item => item.eciSource === name).length;
  return {
    ...ranked,
    eci: { source: source.source, url: source.url, attribution: source.attribution, fetchedAt: source.fetchedAt, rows: source.rows.length, estimates: { file: "data/eci-estimates.csv", rows: bundled.estimates.length, provenance: bundled.provenance } },
    counts: { published: bySource("published"), estimated: bySource("estimated"), calibrated: bySource("calibrated"), unranked: ranked.unranked.length },
  };
}

/** A stable ID from the item's input, so re-saving a file keeps its Langfuse item IDs. */
const itemId = (input: unknown) => `item-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12)}`;

/** JSONL or a JSON array of `{ id?, input, expectedOutput, metadata? }`. */
export async function readDatasetFile(path: string): Promise<EvalItem[]> {
  const text = await readFile(path, "utf8");
  const rows: unknown[] = text.trim().startsWith("[") ? JSON.parse(text) as unknown[] : text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
  return rows.map((row, index) => {
    const item = row as { id?: unknown; input?: unknown; expectedOutput?: unknown; expected_output?: unknown; metadata?: unknown };
    const expectedOutput = item.expectedOutput ?? item.expected_output;
    if (item.input === undefined || expectedOutput === undefined) throw new Error(`${path} item ${index + 1} needs input and expectedOutput`);
    return {
      id: typeof item.id === "string" && item.id ? item.id : itemId(item.input), input: item.input, expectedOutput,
      ...(item.metadata && typeof item.metadata === "object" ? { metadata: item.metadata as Record<string, unknown> } : {}),
    };
  });
}

export async function previewDataset(host: ScoutHost, source: { langfuseDataset?: string; path?: string }) {
  let items: EvalItem[];
  if (source.langfuseDataset) {
    const lf = langfuseFromEnv(host.env);
    if (!lf) throw new Error("Langfuse is not connected: set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL");
    items = await lf.getDatasetItems(source.langfuseDataset);
  } else if (source.path) items = await readDatasetFile(resolve(host.cwd, source.path));
  else throw new Error("Give a Langfuse dataset name or a dataset file path");
  const clip = (value: unknown) => { const text = JSON.stringify(value); return text.length > 600 ? `${text.slice(0, 600)}…` : text; };
  return { size: items.length, enoughForScout: items.length >= SAMPLE_SIZE, items: items.slice(0, 3).map(item => ({ id: item.id, input: clip(item.input), expectedOutput: clip(item.expectedOutput) })) };
}

export async function saveDataset(host: ScoutHost, name: string, items: { id?: string; input: unknown; expectedOutput: unknown; metadata?: Record<string, unknown> }[]) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("Dataset names are lowercase letters, digits and hyphens");
  const dir = join(host.cwd, ".openmerit", "datasets");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const rows = items.map(item => ({ id: item.id ?? itemId(item.input), input: item.input, expectedOutput: item.expectedOutput, metadata: { ...item.metadata, labelledBy: "openmerit-scout-draft" } }));
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  return { path, items: rows.length };
}

export interface RunParams {
  task: string;
  langfuseDataset?: string;
  datasetPath?: string;
  /** Langfuse dataset name for a local file; defaults to the file name. */
  datasetName?: string;
  evaluator: ({ type: "pi" } & PiTaskSpec) | { type: "module"; path: string };
  filter?: CandidateFilter;
  sampleSize?: number;
  finalists?: number;
  repeats?: number;
  judgeModel?: string;
  /** Without Langfuse the run is local only, which the report says. */
  requireLangfuse?: boolean;
}

/** A rough count of evaluations, so a host can ask before spending. */
export function estimate(candidateCount: number, datasetSize: number, sampleSize = SAMPLE_SIZE, finalists = FINALISTS, repeats = 3, challengers = 3) {
  const probes = Math.ceil(Math.log2(candidateCount + 1));
  const screens = Math.min(finalists - 1 + 2 + challengers, Math.max(0, candidateCount - probes));
  return { candidates: candidateCount, probes, evaluations: (probes + screens) * sampleSize + Math.min(finalists + challengers, candidateCount) * datasetSize * repeats, note: "upper estimate: challengers run only when cheaper, stronger untested models exist" };
}

export async function plan(host: ScoutHost, params: RunParams) {
  const plugin = params.evaluator.type === "module" ? await loadEvaluatorPlugin(params.evaluator.path, host.cwd) : null;
  const filter: CandidateFilter = { ...params.filter, ...(plugin?.providers && !params.filter?.providers ? { providers: plugin.providers } : {}), ...(plugin?.tools ? { tools: true } : {}) };
  const ranked = await candidates(host, filter);
  const size = params.langfuseDataset || params.datasetPath ? (await previewDataset(host, { ...(params.langfuseDataset ? { langfuseDataset: params.langfuseDataset } : {}), ...(params.datasetPath ? { path: params.datasetPath } : {}) })).size : 0;
  return { plugin, filter, ranked, datasetSize: size, estimate: estimate(ranked.candidates.length, size, params.sampleSize, params.finalists, params.repeats) };
}

export async function run(host: ScoutHost, params: RunParams, signal?: AbortSignal): Promise<{ report: ScoutReport; markdown: string; files: { json: string; markdown: string } }> {
  const { plugin, ranked } = await plan(host, params);
  const lf = langfuseFromEnv(host.env);
  if (!lf && params.requireLangfuse !== false) throw new Error("Scout picks the winner from Langfuse experiments: set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (self-hosted works), or pass requireLangfuse: false for a local-only run");
  const evaluate = plugin
    ? await plugin.create({ env: host.env, log: host.log })
    : piEvaluator(host.caller, params.evaluator as PiTaskSpec, { ...(params.judgeModel ?? host.scoutModel ? { judgeModel: (params.judgeModel ?? host.scoutModel)! } : {}) });
  const dataset = params.langfuseDataset
    ? { langfuseDataset: params.langfuseDataset }
    : { local: { name: params.datasetName ?? params.datasetPath!.split("/").at(-1)!.replace(/\.(jsonl|json)$/, ""), description: `Labelled items for: ${params.task.slice(0, 200)}`, items: await readDatasetFile(resolve(host.cwd, params.datasetPath!)) } };
  const credits = async () => {
    if (!host.env.OPENROUTER_API_KEY) return null;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${host.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
      return response.ok ? ((await response.json()) as { data?: { total_usage?: number } }).data?.total_usage ?? null : null;
    } catch { return null; }
  };
  const before = await credits();
  const report = await runScout({
    task: params.task, dataset, candidates: ranked.candidates, evaluate, langfuse: lf, log: host.log,
    ...(plugin?.passScore ? { passScore: plugin.passScore } : {}), ...(plugin?.role ? { role: plugin.role } : {}), ...(plugin?.concurrency ? { concurrency: plugin.concurrency } : {}),
    ...(params.sampleSize ? { sampleSize: params.sampleSize } : {}), ...(params.finalists ? { finalists: params.finalists } : {}), ...(params.repeats ? { repeats: params.repeats } : {}), ...(signal ? { signal } : {}),
  });
  const after = before === null ? null : await credits();
  if (before !== null && after !== null) report.spend.openRouterCreditsUsd = after - before;
  const dir = join(host.cwd, ".openmerit", "runs", report.runId);
  await mkdir(dir, { recursive: true });
  const markdown = reportMarkdown(report);
  const files = { json: join(dir, "report.json"), markdown: join(dir, "report.md") };
  await writeFile(files.json, `${JSON.stringify({ ...report, unranked: ranked.unranked, dropped: ranked.dropped }, null, 2)}\n`);
  await writeFile(files.markdown, markdown);
  return { report, markdown, files };
}
