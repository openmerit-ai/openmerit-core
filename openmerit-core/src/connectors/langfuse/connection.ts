// The Langfuse connection the cloud app runs, read-only: it lists a project's tasks from its
// generations, and reads what one task's evaluation needs to build its cases:
// - dataset items with expected outputs, when an experiment ran the task on a dataset with one
//   generation of the task per item: each case replays that generation's request and expects the
//   item's expected output;
// - otherwise, or to make up the count, production generations of the task's current model, each
//   replayed and compared with the answer the current model recorded (W5's trace source).
// Unlike the CLI's connector (index.ts), which never reads inputs or outputs, it reads the requests
// and answers of the generations and dataset items it uses, at most `count` of each, and redacts
// them before returning them. It never writes to Langfuse: a change is proposed, and a person makes it.

import { createHash } from "node:crypto";
import type { EditTarget, ProposedChange } from "../../engine/change.ts";
import type { ChangePort, Connector, ListedTask } from "../../engine/connector.ts";
import type { EvidencePart, Source } from "../../engine/evidence.ts";
import { redact } from "../../engine/redact.ts";
import type { Case, TaskBundle } from "../../ranking/index.ts";
import { createLangfuseSource, readGeneration, type TraceTask } from "../../sources/langfuse.ts";
import { createTransport, cursorPages, type LangfuseConnection, LangfuseError, metricsRows, type TransportOptions } from "./client.ts";
import { createLangfuseConnector } from "./index.ts";

export { LangfuseError, type LangfuseConnection } from "./client.ts";

/** The listing's window, in days. */
export const DAYS = 30;
/** Cases one evaluation reads at most. */
export const CASES = 20;
/** Dataset cases enough to evaluate on them alone, without replayed generations. */
export const MIN_DATASET_CASES = 5;
/** Experiments checked for one that ran the task on a dataset, newest first. */
const EXPERIMENTS_CHECKED = 5;
/** Experiment items read to find the experiments, newest first. */
const EXPERIMENT_ITEMS_READ = 1000;

/**
 * One task: the generations of one name in traces of one name, or of one managed prompt's version,
 * whatever models they ran on. Its current model is the one with the most of them in the window.
 */
export interface LangfuseTask {
  /** Stable across listings of the same project. */
  id: string;
  /** For people, such as "assess-fraud › assess-fraud-generate" or "prompt summarize v3". */
  name: string;
  traceName: string | null;
  generationName: string | null;
  promptName: string | null;
  promptVersion: number | null;
  model: string;
  /** Calls and recorded cost over the window, on every model. */
  generations: number;
  costUsd: number | null;
  /** Most calls first. */
  models: { model: string; generations: number; costUsd: number | null }[];
  /** Why it is listed but not evaluated, or null. */
  skipped: string | null;
}

export interface LangfuseListing {
  projectId: string;
  projectName: string;
  /** Most recorded cost first, then most calls. */
  tasks: LangfuseTask[];
  /** Langfuse returned its row limit, so the cheapest tasks may be missing. */
  truncated: boolean;
}

/** What one evaluation runs on: the bundle and its cases, and the evidence they came from. */
export interface LangfuseCases {
  bundle: TaskBundle;
  /** Dataset cases first. Every case is a recorded request (`origin: "trace"`); `expected` is an assistant message. */
  cases: Case[];
  dataset: { experiment: string; items: number } | null;
  replayed: number;
  /** Generations and items left out, by reason. */
  skipped: Record<string, number>;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const DAY_MS = 86_400_000;
const ROW_LIMIT = 1000;
const generationFilter = { column: "type", operator: "=", value: "GENERATION", type: "string" };

/** Refuses a key pair that can write, and names the project it reads. */
export async function checkKey(connection: LangfuseConnection, options: TransportOptions = {}): Promise<{ projectId: string; projectName: string }> {
  const connector = createLangfuseConnector(connection, options);
  const project = await connector.check();
  await connector.verifyViewer();
  return { projectId: project.projectId, projectName: project.projectName };
}

const taskId = (key: string) => `lf_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

/** The project's tasks over the last 30 days, from one aggregate query: no inputs or outputs. */
export async function listTasks(connection: LangfuseConnection, options: TransportOptions = {}): Promise<LangfuseListing> {
  const transport = createTransport(connection, options);
  const project = await createLangfuseConnector(connection, options).check();
  const to = new Date(), from = new Date(to.getTime() - DAYS * DAY_MS);
  const rows = await metricsRows(transport, {
    view: "observations",
    dimensions: [{ field: "traceName" }, { field: "name" }, { field: "promptName" }, { field: "promptVersion" }, { field: "providedModelName" }],
    metrics: [{ measure: "count", aggregation: "count" }, { measure: "totalCost", aggregation: "sum" }],
    filters: [generationFilter], fromTimestamp: from.toISOString(), toTimestamp: to.toISOString(),
    orderBy: [{ field: "sum_totalCost", direction: "desc" }], config: { row_limit: ROW_LIMIT },
  });
  const groups = new Map<string, LangfuseTask>();
  for (const row of rows) {
    const traceName = str(row.traceName), generationName = str(row.name), promptName = str(row.promptName), promptVersion = num(row.promptVersion);
    const key = promptName ? `prompt\u0000${promptName}\u0000${promptVersion ?? ""}` : `generation\u0000${traceName ?? ""}\u0000${generationName ?? ""}`;
    const task = groups.get(key) ?? {
      id: taskId(key), name: promptName ? `prompt ${promptName}${promptVersion === null ? "" : ` v${promptVersion}`}` : `${traceName ?? "(no trace name)"} › ${generationName ?? "(no name)"}`,
      traceName, generationName: promptName ? null : generationName, promptName, promptVersion, model: "", generations: 0, costUsd: null, models: [], skipped: null,
    };
    const count = num(row.count_count) ?? 0, cost = num(row.sum_totalCost), model = str(row.providedModelName);
    task.generations += count;
    if (cost !== null) task.costUsd = (task.costUsd ?? 0) + cost;
    if (model) {
      const known = task.models.find(item => item.model === model);
      if (known) { known.generations += count; if (cost !== null) known.costUsd = (known.costUsd ?? 0) + cost; }
      else task.models.push({ model, generations: count, costUsd: cost });
    }
    groups.set(key, task);
  }
  const tasks = [...groups.values()].map(task => {
    const models = [...task.models].sort((a, b) => b.generations - a.generations || a.model.localeCompare(b.model));
    const model = models[0]?.model ?? "";
    const skipped = !model ? "no model recorded" : !task.promptName && !task.generationName ? "generations without a name" : null;
    return { ...task, models, model, skipped };
  });
  tasks.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.generations - a.generations || a.id.localeCompare(b.id));
  return { projectId: project.projectId, projectName: project.projectName, tasks, truncated: rows.length >= ROW_LIMIT };
}

/** The task as W5's trace source groups it: its current model's generations. */
function traceTask(task: LangfuseTask): TraceTask {
  const current = task.models.find(item => item.model === task.model);
  return {
    id: task.id, name: task.name, traceName: task.traceName, promptName: task.promptName, generationNames: [task.generationName], model: task.model,
    generations: current?.generations ?? task.generations, costUsd: current?.costUsd ?? null, p50LatencyMs: null,
    usage: { callsPerMonth: Math.round(((current?.generations ?? 0) * 30) / DAYS), usdPerMonth: current?.costUsd === null || current?.costUsd === undefined ? null : (current.costUsd * 30) / DAYS }, costShare: null,
  };
}

const matches = (task: LangfuseTask, observation: Json) => (task.promptName
  ? str(observation.promptName) === task.promptName && (task.promptVersion === null || num(observation.promptVersion) === task.promptVersion)
  : str(observation.name) === task.generationName);

/**
 * Dataset cases: the newest experiment whose traces each hold exactly one generation of the task.
 * An agent's run with several of them answers the item only at the end, so it has no single call to replay.
 */
async function datasetCases(connection: LangfuseConnection, task: LangfuseTask, count: number, options: TransportOptions): Promise<{ experiment: string; cases: Case[]; skipped: Record<string, number> } | null> {
  const transport = createTransport(connection, options);
  const since = new Date(Date.now() - DAYS * DAY_MS).toISOString();
  const experiments = new Map<string, { at: string; items: { itemId: string; traceId: string }[] }>();
  let read = 0;
  for await (const page of cursorPages(transport, "/api/public/experiment-items", { fields: "core", limit: 100, fromStartTime: since })) {
    for (const raw of page) {
      const name = isObject(raw) ? str(raw.experimentName) : null, itemId = isObject(raw) ? str(raw.experimentItemId) : null, traceId = isObject(raw) ? str(raw.traceId) : null;
      if (!name || !itemId || !traceId) continue;
      const experiment = experiments.get(name) ?? { at: "", items: [] };
      const at = str((raw as Json).startTime) ?? "";
      if (at > experiment.at) experiment.at = at;
      if (!experiment.items.some(item => item.itemId === itemId)) experiment.items.push({ itemId, traceId });
      experiments.set(name, experiment);
    }
    read += page.length;
    if (read >= EXPERIMENT_ITEMS_READ) break;
  }
  const generationsOf = async (traceId: string, fields: string): Promise<Json[]> => {
    const filter = [{ column: "traceId", operator: "=", value: traceId, type: "string" }];
    const data = (await transport.request<{ data?: unknown }>("GET", "/api/public/v2/observations", { query: { type: "GENERATION", fields, limit: 50, fromStartTime: since, filter: JSON.stringify(filter) } })).data;
    return Array.isArray(data?.data) ? data.data.filter(isObject).filter(item => matches(task, item)) : [];
  };
  const newest = [...experiments].sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, EXPERIMENTS_CHECKED);
  for (const [name, experiment] of newest) {
    if ((await generationsOf(experiment.items[0]!.traceId, "core,basic")).length !== 1) continue;
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    const cases: Case[] = [];
    for (const item of experiment.items) {
      if (cases.length >= count) break;
      const datasetItem = (await transport.request<Json>("GET", `/api/public/dataset-items/${encodeURIComponent(item.itemId)}`, { allowNotFound: true })).data;
      const expected = datasetItem?.expectedOutput;
      if (expected === undefined || expected === null || expected === "") { skip("dataset item without an expected output"); continue; }
      const found = await generationsOf(item.traceId, "core,basic,io,model,prompt");
      if (found.length !== 1) { skip("trace without exactly one generation of the task"); continue; }
      const generation = readGeneration(found[0]!);
      if (typeof generation === "string") { skip(generation); continue; }
      const text = typeof expected === "string" ? expected : JSON.stringify(expected);
      cases.push({ id: `langfuse-item:${item.itemId}`, input: { messages: JSON.stringify(generation.messages) }, expected: { role: "assistant", content: redact(text) }, origin: "trace" });
    }
    if (cases.length) return { experiment: name, cases, skipped };
  }
  return null;
}

/** The task's cases, strongest first: dataset items with expected outputs, then replayed generations. */
export async function readCases(connection: LangfuseConnection, task: LangfuseTask, options: TransportOptions & { count?: number } = {}): Promise<LangfuseCases> {
  if (task.skipped) throw new LangfuseError(`${task.name} cannot be evaluated: ${task.skipped}.`);
  const count = options.count ?? CASES;
  const dataset = await datasetCases(connection, task, count, options);
  const left = !dataset || dataset.cases.length < MIN_DATASET_CASES ? count - (dataset?.cases.length ?? 0) : 0;
  const replay = left ? await createLangfuseSource(connection, { ...options, days: DAYS }).replay(traceTask(task), { count: left }) : null;
  // A prompt version's task replays only that version's generations.
  const version = task.promptVersion === null ? null : `v${task.promptVersion}`;
  const kept = new Set((replay?.samples ?? []).filter(sample => version === null || sample.stratum.split(" · ")[0] === version).map(sample => sample.caseId));
  const replayed = (replay?.cases ?? []).filter(item => kept.has(item.id));
  const cases = [...(dataset?.cases ?? []), ...replayed];
  if (!cases.length) throw new LangfuseError(`Langfuse has no recorded request of ${task.name} on ${task.model} in the last ${DAYS} days that OpenMerit can replay (${Object.entries(replay?.skipped ?? {}).map(([reason, n]) => `${n} ${reason}`).join(", ") || "no generations with their input and output"}).`);
  const skipped = { ...replay?.skipped };
  for (const [reason, n] of Object.entries(dataset?.skipped ?? {})) skipped[reason] = (skipped[reason] ?? 0) + n;
  const bundle: TaskBundle = replay?.bundle ?? { task: task.name, description: `Langfuse ${task.name} on ${task.model}: dataset items run in experiment "${dataset!.experiment}".`, current: { model: task.model }, prompt: { messages: [] }, output: { kind: "text" } };
  // Graded as JSON when every expected answer is a JSON object, the dataset's included.
  const json = cases.every(item => { const answer = item.expected as { content?: unknown; tool_calls?: unknown[] }; return !answer.tool_calls?.length && typeof answer.content === "string" && isJsonObject(answer.content); });
  return { bundle: { ...bundle, output: json ? { kind: "json", schema: { type: "object" } } : bundle.output.kind === "json" ? { kind: "text" } : bundle.output }, cases, dataset: dataset ? { experiment: dataset.experiment, items: dataset.cases.length } : null, replayed: replayed.length, skipped };
}

const isJsonObject = (text: string) => { try { return isObject(JSON.parse(text)); } catch { return false; } };

const source = (task: LangfuseTask, detail: string): Source => ({ connector: "langfuse", detail: detail || task.name });

/** What the cases came from, for the report's "Based on" lines. */
export function caseEvidence(task: LangfuseTask, read: Pick<LangfuseCases, "dataset" | "replayed" | "bundle">): EvidencePart {
  const text = read.bundle.output.kind === "text";
  return {
    graders: [
      ...(read.dataset ? [{ value: { kind: "expected_output" as const, description: `the expected outputs of ${read.dataset.items} dataset items${text ? ", compared by a judge" : ""}` }, source: source(task, `experiment "${read.dataset.experiment}"`) }] : []),
      ...(read.replayed ? [{ value: { kind: "parity" as const, description: `parity with the answers ${task.model} recorded${text ? ", compared by a judge" : ""}` }, source: source(task, task.name) }] : []),
    ],
    cases: [
      ...(read.dataset ? [{ value: { kind: "real" as const, count: read.dataset.items, description: `${read.dataset.items} dataset items run in experiment "${read.dataset.experiment}"` }, source: source(task, task.name) }] : []),
      ...(read.replayed ? [{ value: { kind: "real" as const, count: read.replayed, description: `${read.replayed} recorded production calls, replayed` }, source: source(task, task.name) }] : []),
    ],
  };
}

/** Where the change is made: the prompt's config when Langfuse manages the prompt, else where the application calls the model. */
export function proposeChange(task: Pick<LangfuseTask, "name" | "traceName" | "generationName" | "promptName" | "promptVersion">, target: Pick<EditTarget, "model">, links: { baseUrl: string; projectId: string } | null = null): ProposedChange & { text: string; link: string | null } {
  const what = task.promptName ? `prompt ${task.promptName}` : task.generationName ?? task.name;
  const text = `Set ${what} to \`${target.model}\``;
  const instructions = task.promptName
    ? `In Langfuse, set the model in the config of prompt "${task.promptName}"${task.promptVersion === null ? "" : ` (version ${task.promptVersion})`} to ${target.model}, or where your application sets the model for that prompt. OpenMerit does not change it.`
    : `Where your application makes the "${task.generationName}" call${task.traceName ? ` in "${task.traceName}"` : ""}, set the model to ${target.model}. OpenMerit does not change it.`;
  const link = task.promptName && links ? `${links.baseUrl}/project/${encodeURIComponent(links.projectId)}/prompts/${encodeURIComponent(task.promptName)}` : null;
  return { edits: [], instructions, text, link };
}

/** The connection as the core's flow sees it: list, evidence and change; it measures through OpenMerit's model clients. */
export function langfuse(input: { tasks: readonly LangfuseTask[]; links?: { baseUrl: string; projectId: string } }): Omit<Connector, "list" | "evidence" | "change"> & { list: () => ListedTask[]; evidence: (taskId: string) => EvidencePart; change: ChangePort } {
  const find = (id: string) => input.tasks.find(task => task.id === id || task.name === id);
  return {
    id: "langfuse", capabilities: ["list", "evidence", "change"], writes: false,
    list: () => input.tasks.map(task => ({ name: task.name, currentModel: task.model || null, ...(task.skipped ? { skipped: task.skipped } : {}) })),
    evidence: id => {
      const task = find(id);
      if (!task) return {};
      return { priority: task.costUsd ? [{ value: { kind: "spend", usdPerMonth: (task.costUsd * 30) / DAYS }, source: source(task, `$${task.costUsd.toFixed(2)} of recorded cost in the last ${DAYS} days`) }] : [{ value: { kind: "request" }, source: source(task, task.name) }] };
    },
    change: { propose: (id, target) => proposeChange(find(id) ?? { name: id, traceName: null, generationName: id, promptName: null, promptVersion: null }, target, input.links ?? null) },
  };
}
