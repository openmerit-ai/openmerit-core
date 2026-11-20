// Langfuse trace source: finds a project's tasks from its recorded generations alone, with no code
// access, and turns sampled generations into replay cases for ranking.
//
// It sends GET requests only, so a Viewer key is enough. `tasks()` reads one aggregate query.
// `replay()` reads the input and output of at most `poolSize` generations of one task; their text is
// redacted before it is returned, and nothing is stored.
//
// Replay is one model call at a time: a case is the exact request the model received in the trace,
// history included, and a candidate answers that request once. Tools are never executed; earlier
// tool results come from the trace.

import { createHash } from "node:crypto";
import { createTransport, cursorPages, type LangfuseConnection, LangfuseError, metricsRows, type TransportOptions } from "../connectors/langfuse/client.ts";
import { redact } from "../engine/redact.ts";
import type { Case, TaskBundle } from "./contract.ts";

export interface LangfuseSourceOptions extends TransportOptions {
  /** How many days of generations to read, ending now. Default 30. */
  days?: number;
  /** Only these Langfuse environments, such as ["production"]. Default: every environment. */
  environments?: readonly string[];
}

/** One task: the generations of one trace name and prompt (or generation name) on one model. */
export interface TraceTask {
  /** Stable across scans of the same project. */
  id: string;
  /** For people, such as "assess-fraud › assess-fraud-generate". */
  name: string;
  traceName: string | null;
  /** The Langfuse prompt the generations link. When set, the task groups every generation name that uses it. */
  promptName: string | null;
  generationNames: (string | null)[];
  /** The model name the generations record. */
  model: string;
  generations: number;
  /** Recorded cost over the window, or null when Langfuse recorded none. */
  costUsd: number | null;
  /** Median latency; for a task merged from several generation names, that of the busiest one. */
  p50LatencyMs: number | null;
  /** The window scaled to 30 days. */
  usage: { callsPerMonth: number; usdPerMonth: number | null };
  /** This task's part of the window's recorded generation cost, from 0 to 1. */
  costShare: number | null;
}

export interface TaskScan {
  from: string;
  to: string;
  /** Most recorded cost first, then most generations. */
  tasks: TraceTask[];
  totals: { generations: number; costUsd: number };
  /** Generations that record no model, which no task can replay. */
  withoutModel: number;
  /** Langfuse returned its row limit, so the cheapest tasks may be missing. */
  truncated: boolean;
}

/** A message in OpenAI chat format, as a replay request sends it. */
export interface ReplayMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | unknown[] | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ReplaySample {
  caseId: string;
  observationId: string;
  traceId: string;
  startTime: string;
  /** Prompt version, turn depth and output kind, such as "v3 · turns 2–3 · tool call". */
  stratum: string;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface ReplaySet {
  task: TraceTask;
  bundle: TaskBundle;
  /**
   * `origin: "trace"`. `input.messages` is the recorded request as JSON (see `replayRequest`), and
   * `expected` is the assistant message the current model recorded, in the same format.
   */
  cases: Case[];
  samples: ReplaySample[];
  pool: { read: number; usable: number; unique: number };
  /** Generations left out, by reason. */
  skipped: Record<string, number>;
  /** Whether the bundle's tools come from definitions in the trace, or only from tool names in calls. */
  toolDefinitions: "recorded" | "inferred" | "none";
}

export interface ReplayOptions {
  /** Cases to return at most. Default 30. */
  count?: number;
  /** Generations to read before sampling, newest first. Default 200. */
  poolSize?: number;
}

export interface LangfuseSource {
  readonly baseUrl: string;
  tasks(): Promise<TaskScan>;
  replay(task: TraceTask, options?: ReplayOptions): Promise<ReplaySet>;
}

const DAY_MS = 86_400_000;
const ROW_LIMIT = 1000;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The request a trace case replays. */
export function replayRequest(item: Case): ReplayMessage[] {
  const messages = item.input.messages;
  if (item.origin !== "trace" || messages === undefined) throw new LangfuseError(`Case ${item.id} is not a trace replay case.`);
  return JSON.parse(messages) as ReplayMessage[];
}

export function createLangfuseSource(connection: LangfuseConnection, options: LangfuseSourceOptions = {}): LangfuseSource {
  const transport = createTransport(connection, options);
  const days = options.days ?? 30;
  if (!(days > 0)) throw new LangfuseError("days must be positive.");
  const environments = options.environments?.length ? [...options.environments] : null;
  const environmentFilter = environments ? [{ column: "environment", operator: "any of", value: environments, type: "stringOptions" }] : [];
  const window = () => ({ from: new Date(Date.now() - days * DAY_MS).toISOString(), to: new Date().toISOString() });
  const perMonth = (value: number) => (value * 30) / days;

  async function tasks(): Promise<TaskScan> {
    const { from, to } = window();
    const rows = await metricsRows(transport, {
      view: "observations",
      dimensions: [{ field: "traceName" }, { field: "name" }, { field: "promptName" }, { field: "providedModelName" }],
      metrics: [{ measure: "count", aggregation: "count" }, { measure: "totalCost", aggregation: "sum" }, { measure: "latency", aggregation: "p50" }],
      filters: [{ column: "type", operator: "=", value: "GENERATION", type: "string" }, ...environmentFilter],
      fromTimestamp: from, toTimestamp: to,
      orderBy: [{ field: "sum_totalCost", direction: "desc" }],
      config: { row_limit: ROW_LIMIT },
    });
    const groups = new Map<string, TraceTask & { busiest: number }>();
    let withoutModel = 0, generations = 0, costUsd = 0;
    for (const row of rows) {
      const count = num(row.count_count) ?? 0, cost = num(row.sum_totalCost);
      generations += count;
      costUsd += cost ?? 0;
      const model = str(row.providedModelName);
      if (!model) { withoutModel += count; continue; }
      const traceName = str(row.traceName), promptName = str(row.promptName), name = str(row.name);
      const id = `${traceName ?? "(no trace name)"} › ${promptName ? `prompt ${promptName}` : name ?? "(no name)"} @ ${model}`;
      const group = groups.get(id) ?? { id, name: id.slice(0, id.lastIndexOf(" @ ")), traceName, promptName, generationNames: [], model, generations: 0, costUsd: null, p50LatencyMs: null, usage: { callsPerMonth: 0, usdPerMonth: null }, costShare: null, busiest: -1 };
      group.generationNames.push(name);
      group.generations += count;
      if (cost !== null) group.costUsd = (group.costUsd ?? 0) + cost;
      if (count > group.busiest) { group.busiest = count; group.p50LatencyMs = num(row.p50_latency); }
      groups.set(id, group);
    }
    const list = [...groups.values()].map(({ busiest: _, ...task }) => ({
      ...task,
      usage: { callsPerMonth: Math.round(perMonth(task.generations)), usdPerMonth: task.costUsd === null ? null : perMonth(task.costUsd) },
      costShare: task.costUsd === null || costUsd === 0 ? null : task.costUsd / costUsd,
    }));
    list.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.generations - a.generations || a.id.localeCompare(b.id));
    return { from, to, tasks: list, totals: { generations, costUsd }, withoutModel, truncated: rows.length >= ROW_LIMIT };
  }

  async function replay(task: TraceTask, replayOptions: ReplayOptions = {}): Promise<ReplaySet> {
    const count = replayOptions.count ?? 30, poolSize = replayOptions.poolSize ?? 200;
    const { from, to } = window();
    const is = (column: string, value: string | null) => value === null ? { column, operator: "is null", value: "", type: "null" } : { column, operator: "=", value, type: "string" };
    const filter = [
      is("traceName", task.traceName),
      ...(task.promptName ? [is("promptName", task.promptName)] : [is("promptName", null), is("name", task.generationNames[0] ?? null)]),
      is("model", task.model),
      ...environmentFilter,
    ];
    const raw: Json[] = [];
    for await (const page of cursorPages(transport, "/api/public/v2/observations", { type: "GENERATION", fields: "core,basic,io,model,prompt,usage", limit: 50, fromStartTime: from, toStartTime: to, filter: JSON.stringify(filter) })) {
      raw.push(...page.filter(isObject));
      if (raw.length >= poolSize) break;
    }
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    const unique = new Map<string, Generation>();
    const pool = raw.slice(0, poolSize).sort((a, b) => (str(b.startTime) ?? "").localeCompare(str(a.startTime) ?? ""));
    let usable = 0;
    for (const observation of pool) {
      const generation = readGeneration(observation);
      if (typeof generation === "string") { skip(generation); continue; }
      usable += 1;
      // The same request recorded twice is one case; the newest recording is kept.
      if (unique.has(generation.key)) { skip("duplicate request"); continue; }
      unique.set(generation.key, generation);
    }
    const sampled = stratifiedSample([...unique.values()], count).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
    const cases: Case[] = sampled.map(generation => ({ id: `langfuse:${generation.id}`, input: { messages: JSON.stringify(generation.messages) }, expected: generation.output, origin: "trace" }));
    const samples: ReplaySample[] = sampled.map(generation => ({ caseId: `langfuse:${generation.id}`, observationId: generation.id, traceId: generation.traceId, startTime: generation.startTime, stratum: generation.stratum, costUsd: generation.costUsd, latencyMs: generation.latencyMs }));
    const { bundle, toolDefinitions } = bundleFor(task, sampled, days);
    return { task, bundle, cases, samples, pool: { read: pool.length, usable, unique: unique.size }, skipped, toolDefinitions };
  }

  return { baseUrl: transport.baseUrl, tasks, replay };
}

export interface Generation {
  id: string;
  traceId: string;
  startTime: string;
  messages: ReplayMessage[];
  output: ReplayMessage;
  tools: Json[];
  key: string;
  stratum: string;
  costUsd: number | null;
  latencyMs: number | null;
}

/** A usable generation, or why it is not. Its request and answer are redacted. */
export function readGeneration(observation: Json): Generation | string {
  const id = str(observation.id), traceId = str(observation.traceId), startTime = str(observation.startTime);
  if (!id || !traceId || !startTime) return "missing ID or start time";
  if (observation.level === "ERROR") return "the call failed";
  if (observation.input === null || observation.input === undefined || observation.input === "") return "no input recorded";
  const request = readRequest(observation.input);
  if (!request) return "input is not a chat request";
  const output = readOutput(observation.output);
  if (!output) return "no output";
  const end = Date.parse(str(observation.endTime) ?? ""), start = Date.parse(startTime);
  const turn = request.messages.filter(message => message.role === "assistant").length;
  const version = num(observation.promptVersion);
  const stratum = [version === null ? null : `v${version}`, turn === 0 ? "turn 1" : turn <= 2 ? "turns 2–3" : "turn 4+", output.tool_calls?.length ? "tool call" : "text"].filter(Boolean).join(" · ");
  return {
    id, traceId, startTime, messages: request.messages, output, tools: request.tools, stratum,
    key: createHash("sha256").update(JSON.stringify(request.messages)).digest("hex"),
    costUsd: num(observation.totalCost), latencyMs: Number.isFinite(end - start) ? end - start : null,
  };
}

/** Langfuse returns input and output as raw strings: JSON when the SDK recorded a structure. */
function parseRaw(value: unknown): { parsed: unknown; text: string | null } {
  if (typeof value !== "string") return { parsed: value, text: null };
  try {
    return { parsed: JSON.parse(value), text: value };
  } catch {
    return { parsed: value, text: value };
  }
}

function readRequest(input: unknown): { messages: ReplayMessage[]; tools: Json[] } | null {
  const { parsed } = parseRaw(input);
  if (typeof parsed === "string") return parsed.trim() ? { messages: [{ role: "user", content: redact(parsed) }], tools: [] } : null;
  const list = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!list?.length) return null;
  const messages: ReplayMessage[] = [];
  for (const raw of list) {
    const message = readMessage(raw);
    if (!message) return null;
    messages.push(message);
  }
  const tools = isObject(parsed) && Array.isArray(parsed.tools) ? parsed.tools.filter(isObject) : [];
  return { messages, tools };
}

function readMessage(raw: unknown): ReplayMessage | null {
  if (!isObject(raw) || typeof raw.role !== "string" || !ROLES.has(raw.role)) return null;
  const content = raw.content ?? null;
  if (content !== null && typeof content !== "string" && !Array.isArray(content)) return null;
  const message: ReplayMessage = { role: raw.role as ReplayMessage["role"], content: redactContent(content) };
  if (typeof raw.name === "string") message.name = raw.name;
  if (typeof raw.tool_call_id === "string") message.tool_call_id = raw.tool_call_id;
  if (raw.tool_calls !== undefined && raw.tool_calls !== null) {
    if (!Array.isArray(raw.tool_calls)) return null;
    const calls: NonNullable<ReplayMessage["tool_calls"]> = [];
    for (const call of raw.tool_calls) {
      if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== "string") return null;
      const args = call.function.arguments;
      calls.push({ id: str(call.id) ?? `call_${calls.length}`, type: "function", function: { name: call.function.name, arguments: redact(typeof args === "string" ? args : JSON.stringify(args ?? {})) } });
    }
    if (calls.length) message.tool_calls = calls;
  }
  return message;
}

function readOutput(output: unknown): ReplayMessage | null {
  const { parsed, text } = parseRaw(output);
  const candidate = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  let message: ReplayMessage | null = null;
  if (typeof candidate === "string") message = { role: "assistant", content: redact(candidate) };
  else if (isObject(candidate) && ("content" in candidate || "tool_calls" in candidate) && (candidate.role === undefined || candidate.role === "assistant")) message = readMessage({ ...candidate, role: "assistant" });
  // Any other JSON is the model's own structured answer, recorded as text.
  else if (text !== null) message = { role: "assistant", content: redact(text) };
  if (!message || (!message.tool_calls?.length && !textOf(message.content).trim())) return null;
  return message;
}

function redactContent(content: string | unknown[] | null): string | unknown[] | null {
  if (typeof content === "string") return redact(content);
  if (!content) return content;
  return content.map(part => (isObject(part) && typeof part.text === "string" ? { ...part, text: redact(part.text) } : part));
}

function textOf(content: ReplayMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map(part => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/**
 * Up to `count` generations: every stratum gets an equal share (or all it has), and within a
 * stratum the picks are spread evenly over time. Deterministic for the same pool.
 */
function stratifiedSample(generations: Generation[], count: number): Generation[] {
  const strata = new Map<string, Generation[]>();
  for (const generation of generations) strata.set(generation.stratum, [...(strata.get(generation.stratum) ?? []), generation]);
  const groups = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id)));
  const shares = groups.map(() => 0);
  for (let left = Math.min(count, generations.length); left > 0;) {
    for (let i = 0; i < groups.length && left > 0; i += 1) if (shares[i]! < groups[i]!.length) { shares[i]! += 1; left -= 1; }
  }
  return groups.flatMap((list, i) => Array.from({ length: shares[i]! }, (_, j) => list[Math.floor(((j + 0.5) * list.length) / shares[i]!)]!));
}

function bundleFor(task: TraceTask, sampled: Generation[], days: number): { bundle: TaskBundle; toolDefinitions: ReplaySet["toolDefinitions"] } {
  const systems = new Set(sampled.map(generation => generation.messages[0]).map(first => (first && (first.role === "system" || first.role === "developer") ? textOf(first.content) : "")));
  const system = systems.size === 1 ? [...systems][0] : "";

  const recorded = new Map<string, NonNullable<TaskBundle["tools"]>[number]>();
  for (const tool of sampled.flatMap(generation => generation.tools)) {
    const definition = isObject(tool.function) ? tool.function : tool;
    const name = str(definition.name);
    if (!name || recorded.has(name)) continue;
    const parameters = definition.parameters ?? definition.input_schema;
    recorded.set(name, { name, ...(typeof definition.description === "string" ? { description: definition.description } : {}), parameters: isObject(parameters) ? parameters : {} });
  }
  const called = new Set(sampled.flatMap(generation => [...generation.messages, generation.output].flatMap(message => message.tool_calls ?? []).map(call => call.function.name)));
  const tools = recorded.size ? [...recorded.values()] : [...called].sort().map(name => ({ name, parameters: {} }));
  const toolDefinitions = recorded.size ? "recorded" : called.size ? "inferred" : "none";

  const outputs = sampled.map(generation => generation.output);
  const json = outputs.length > 0 && outputs.every(output => !output.tool_calls?.length && isObject(parseRaw(textOf(output.content)).parsed));
  const needsVision = sampled.some(generation => generation.messages.some(message => Array.isArray(message.content) && message.content.some(part => isObject(part) && (part.type === "image_url" || part.type === "image" || part.type === "input_image"))));
  const cost = task.costUsd === null ? "no recorded cost" : `$${task.costUsd.toFixed(2)}`;
  const names = task.promptName ? `generations linked to prompt "${task.promptName}"` : `generations named "${task.generationNames[0] ?? ""}"`;

  const bundle: TaskBundle = {
    task: task.name,
    description: `Langfuse ${names}${task.traceName ? ` in traces named "${task.traceName}"` : ""} on ${task.model}: ${task.generations} calls and ${cost} in ${days} days. Each case replays one recorded call with the history the trace recorded; tools are not executed.`,
    current: { model: task.model },
    prompt: { ...(system ? { system } : {}), messages: [] },
    ...(tools.length ? { tools } : {}),
    output: json ? { kind: "json", schema: { type: "object" } } : { kind: "text" },
    ...(needsVision ? { constraints: { needsVision } } : {}),
  };
  return { bundle, toolDefinitions };
}
