import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ModelCaller } from "../scout/evaluators/pi.ts";
import type { Grader } from "../scout/evaluators/pi.ts";
import { candidates, connections, plan, previewDataset, run, saveDataset, type RunParams, type ScoutHost } from "../scout/service.ts";
import { SCOUT_INSTRUCTIONS } from "./instructions.ts";

export interface ScoutExtensionOptions {
  /** Whether `scout_run` may spend money: true (headless `--execute`), false (plan only) or "ask" (confirm in the UI). */
  allowSpend?: boolean | "ask";
  /** Progress lines, for example to stderr in headless runs. */
  log?: (line: string) => void;
  /** The `provider/id` Scout runs on, for the judge grader. Defaults to the session's model. */
  scoutModel?: string;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined });

const filterSchema = Type.Object({
  providers: Type.Optional(Type.Array(Type.String(), { description: "Connected Pi providers to draw candidates from, e.g. [\"openrouter\"] or [\"anthropic\"]" })),
  tools: Type.Optional(Type.Boolean({ description: "The production call uses tool calls" })),
  maxPrice: Type.Optional(Type.Number({ description: "Max list price, USD per million input+output tokens" })),
  include: Type.Optional(Type.Array(Type.String(), { description: "Keep only models whose provider/id contains one of these" })),
  exclude: Type.Optional(Type.Array(Type.String(), { description: "Drop models whose provider/id contains one of these" })),
});

const runSchema = Type.Object({
  task: Type.String({ description: "One paragraph: what the model does in production, its inputs and outputs, and what counts as correct" }),
  langfuseDataset: Type.Optional(Type.String({ description: "Existing Langfuse dataset of labelled items" })),
  datasetPath: Type.Optional(Type.String({ description: "Local JSONL of {id?, input, expectedOutput}, pushed to Langfuse before the run" })),
  evaluator: Type.Object({
    type: StringEnum(["pi", "module"] as const, { description: "pi: one model call per item through Pi; module: the project's own harness evaluator" }),
    systemPrompt: Type.Optional(Type.String({ description: "pi: the production system prompt the candidate receives" })),
    inputTemplate: Type.Optional(Type.String({ description: "pi: user message template; {{input}} is the item input" })),
    grader: Type.Optional(Type.Object({
      type: StringEnum(["exact", "contains", "json", "judge"] as const, { description: "json: every expected field must match, strings case-insensitively, arrays as sets (order ignored, same length); exact/contains: normalized text; judge: Scout's model applies the rubric" }),
      field: Type.Optional(Type.String()),
      rubric: Type.Optional(Type.String({ description: "judge: what a correct output must do" })),
    })),
    path: Type.Optional(Type.String({ description: "module: path to an evaluator module, relative to the project" })),
  }),
  filter: Type.Optional(filterSchema),
  sampleSize: Type.Optional(Type.Integer({ minimum: 2, maximum: 20 })),
  finalists: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  repeats: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Runs of every item per finalist (default 3)" })),
});

function host(ctx: ExtensionContext, options: ScoutExtensionOptions): ScoutHost {
  const registry = ctx.modelRegistry;
  const caller: ModelCaller = { getModel: (provider, id) => registry.find(provider, id), complete: (model, context, extra) => registry.complete(model, context, extra) };
  const scoutModel = options.scoutModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  return {
    caller, cwd: ctx.cwd, env: process.env, log: options.log ?? (() => {}),
    models: async () => registry.getAvailable().map(model => ({ provider: model.provider, id: model.id, name: model.name, cost: model.cost })),
    ...(scoutModel ? { scoutModel } : {}),
  };
}

function toRunParams(params: Static<typeof runSchema>): RunParams {
  const { evaluator } = params;
  let spec: RunParams["evaluator"];
  if (evaluator.type === "module") {
    if (!evaluator.path) throw new Error("evaluator.path is required for a module evaluator");
    spec = { type: "module", path: evaluator.path };
  } else {
    if (!evaluator.systemPrompt || !evaluator.grader) throw new Error("A pi evaluator needs systemPrompt and grader");
    const { type, field, rubric } = evaluator.grader;
    const grader: Grader = type === "judge" ? { type: "judge", rubric: rubric ?? "The output must agree with the expected output." }
      : type === "exact" ? { type: "exact", ...(field ? { field } : {}) }
      : type === "contains" ? { type: "contains", ...(field ? { field } : {}) } : { type: "json" };
    spec = { type: "pi", systemPrompt: evaluator.systemPrompt, grader, ...(evaluator.inputTemplate ? { inputTemplate: evaluator.inputTemplate } : {}) };
  }
  if (!params.langfuseDataset && !params.datasetPath) throw new Error("Give langfuseDataset or datasetPath");
  return {
    task: params.task, evaluator: spec,
    ...(params.langfuseDataset ? { langfuseDataset: params.langfuseDataset } : {}), ...(params.datasetPath ? { datasetPath: params.datasetPath } : {}),
    ...(params.filter ? { filter: Object.fromEntries(Object.entries(params.filter).filter(([, value]) => value !== undefined)) } : {}),
    ...(params.sampleSize ? { sampleSize: params.sampleSize } : {}), ...(params.finalists ? { finalists: params.finalists } : {}), ...(params.repeats ? { repeats: params.repeats } : {}),
  };
}

/** OpenMerit Scout inside Pi: model-recommendation tools, a `/scout` command and Scout's instructions. */
export function createScoutExtension(options: ScoutExtensionOptions = {}): ExtensionFactory {
  const allowSpend = options.allowSpend ?? "ask";
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "scout_connections",
      label: "Scout connections",
      description: "Lists the model providers OpenMerit can run (API keys and subscriptions connected in Pi) and the Langfuse project and datasets.",
      promptSnippet: "See which model providers and Langfuse datasets Scout can use",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) { return json(await connections(host(ctx, options))); },
    });
    pi.registerTool({
      name: "scout_candidates",
      label: "Scout candidates",
      description: "Ranks the runnable models by the Epoch Capabilities Index (ECI), weakest first, after the filter: Epoch's published score, or ScoutBM's estimated/calibrated ECI bundled with the package. Shows how many candidates the binary search will cover.",
      promptSnippet: "Rank runnable candidate models by public capability (ECI)",
      parameters: filterSchema,
      async execute(_id, params, _signal, _update, ctx) {
        const filter = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
        const ranked = await candidates(host(ctx, options), filter);
        const short = (list: typeof ranked.candidates) => list.map(item => `${item.model} ECI ${item.eci.toFixed(1)}${item.eciSource === "published" ? "" : ` (${item.eciSource} ±${item.eciError?.toFixed(1)})`} $${item.price?.toFixed(2) ?? "?"}/M`);
        return json({ count: ranked.candidates.length, counts: ranked.counts, weakest: short(ranked.candidates.slice(0, 8)), strongest: short(ranked.candidates.slice(-8)), unranked: ranked.unranked.length, dropped: ranked.dropped.length, eci: ranked.eci });
      },
    });
    pi.registerTool({
      name: "scout_dataset",
      label: "Scout dataset",
      description: "Previews a labelled eval dataset: a Langfuse dataset by name or a local JSONL of {id?, input, expectedOutput}. Scout needs at least 5 labelled items.",
      promptSnippet: "Preview a labelled eval dataset (Langfuse or local JSONL)",
      parameters: Type.Object({ langfuseDataset: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }),
      async execute(_id, params, _signal, _update, ctx) {
        return json(await previewDataset(host(ctx, options), { ...(params.langfuseDataset ? { langfuseDataset: params.langfuseDataset } : {}), ...(params.path ? { path: params.path } : {}) }));
      },
    });
    pi.registerTool({
      name: "scout_save_dataset",
      label: "Scout save dataset",
      description: "Saves labelled items Scout drafted from the codebase (fixtures, tests, examples) to .openmerit/datasets/<name>.jsonl. Each item is marked as a Scout draft; label only what the code or fixtures state.",
      promptSnippet: "Save drafted labelled items as a local eval dataset",
      parameters: Type.Object({
        name: Type.String(),
        items: Type.Array(Type.Object({ id: Type.Optional(Type.String()), input: Type.Unknown(), expectedOutput: Type.Unknown() }), { minItems: 1 }),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        return json(await saveDataset(host(ctx, options), params.name, params.items.map(item => ({ ...(item.id ? { id: item.id } : {}), input: item.input, expectedOutput: item.expectedOutput }))));
      },
    });
    pi.registerTool({
      name: "scout_run",
      label: "Scout run",
      description: "Runs Scout Model Binary Search: ECI-ranked candidates, 5 sampled items per probe (pass = 5/5), 5 finalists on every item 3 times, each recorded as a Langfuse experiment; the winner is read back from Langfuse. Spends provider credit; without approval it returns the plan only.",
      promptSnippet: "Binary-search the candidates on labelled items and pick the winner from Langfuse",
      executionMode: "sequential",
      parameters: runSchema,
      async execute(_id, params, signal, onUpdate, ctx) {
        const scoutHost = host(ctx, options);
        const runParams = toRunParams(params);
        const planned = await plan(scoutHost, runParams);
        const summary = { candidates: planned.ranked.candidates.length, datasetSize: planned.datasetSize, estimatedEvaluations: planned.estimate.evaluations, filter: planned.filter, evaluator: planned.plugin?.name ?? "pi" };
        let approved = allowSpend === true;
        if (allowSpend === "ask" && ctx.hasUI) approved = await ctx.ui.confirm("Run Scout?", `About ${summary.estimatedEvaluations} evaluations over ${summary.candidates} candidates on ${summary.datasetSize} items. This spends provider credit.`);
        if (!approved) return json({ status: "plan_only", ...summary, note: "Not run: spending was not approved. Rerun headless with --execute, or approve in the dialog." });
        const progress = (line: string) => { scoutHost.log(line); onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }); };
        const result = await run({ ...scoutHost, log: progress }, runParams, signal);
        return { content: [{ type: "text", text: `${result.markdown}\nReport files: ${result.files.markdown}, ${result.files.json}` }], details: undefined };
      },
    });

    pi.registerCommand("scout", {
      description: "Ask OpenMerit Scout which model to use for a task",
      handler: async (args) => { pi.sendUserMessage(`Use OpenMerit Scout to recommend a model for this task: ${args || "the model calls in this codebase"}`); },
    });

    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.openmerit_scout = SCOUT_INSTRUCTIONS;
    });
  };
}

export default createScoutExtension();
