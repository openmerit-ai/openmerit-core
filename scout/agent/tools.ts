// The Scout agent's tools. Catalogue reads are replay-safe. A turn ends with
// questions, or once every planned task has a validated shortlist.
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { benchmarkLeaderboard, kinds, modelDetails, searchBenchmarks, searchCatalogue, searchModels, units, type Catalogue, type Filters } from './catalogue.ts';
import { documentTypes } from './search.ts';
import { ClarificationSchema, FiltersSchema, PlanSchema, SubmissionSchema, finalize, type Clarification, type Measurement, type Plan, type Recommendation, type TaskShortlist } from './recommendation.ts';

export type Answer = ({ kind: 'clarification' } & Clarification) | Recommendation;
// The current split of the work, with the shortlists accepted so far in this turn.
export type PlanState = Plan & { results: Array<TaskShortlist | null> };
export interface ToolHost {
  catalogue(): Promise<Catalogue>;
  now(): number;
  // Constraints the conversation imposes on every search and shortlist, such as the endpoint inventory.
  scope(): Promise<Filters>;
  // The most tasks this conversation may split the work into, or null for no limit.
  maxTasks(): Promise<number | null>;
  // Why clarifying questions are not allowed now, or null when they are.
  clarificationBlocked(): Promise<string | null>;
  plan(): Promise<PlanState | null>;
  // Aggregate results the user measured with their own evals and reported on this conversation.
  measurements(): Promise<Measurement[]>;
  savePlan(plan: PlanState): Promise<void>;
  answer(answer: Answer): Promise<void>;
  progress(step: string): void;
}

const text = (value: unknown): ToolExecutionResult => ({ output: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const failure = (message: string): ToolExecutionResult => ({ output: [{ type: 'text', text: message }], isError: true });
const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;

const SearchBenchmarks = Type.Object({
  query: Type.String({ description: 'Describe the work and the quality you need, e.g. "extract fields from scanned invoices into JSON".' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const SearchCatalogue = Type.Object({
  query: Type.String({ description: 'Free text: what the work is or a name, e.g. "transcribe Hindi call-centre audio" or "whisper".' }),
  mode: Type.Optional(StringEnum(['hybrid', 'bm25', 'embedding'] as const, { description: 'hybrid (default): keywords and meaning combined; bm25: exact words only; embedding: meaning only.' })),
  types: Type.Optional(Type.Array(StringEnum(documentTypes), { description: 'Only these result types: model, benchmark (chat benchmarks), board (leaderboards of any kind, including MTEB).' })),
  kind: Type.Optional(StringEnum(kinds, { description: 'Only results for this kind of model.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
});
const Leaderboard = Type.Object({
  benchmark: Type.String({ description: 'Benchmark ID from search_benchmarks, or a leaderboard (board) ID from search_catalogue or get_model_details.' }),
  filters: Type.Optional(FiltersSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
const SearchModels = Type.Object({
  query: Type.Optional(Type.String({ description: 'Words that must all appear in the model ID, name or maker, e.g. "claude" or "qwen coder". Not a task description: use search_catalogue for that.' })),
  filters: Type.Optional(FiltersSchema),
  sortBy: Type.Optional(Type.Union([Type.Literal('benchmark'), Type.Literal('price'), Type.Literal('speed'), Type.Literal('recency')])),
  priceUnit: Type.Optional(StringEnum(units, { description: 'Unit to compare when sorting by price: token, image, second, character, page or request. Defaults to the usual unit of filters.kind, else token.' })),
  benchmark: Type.Optional(Type.String({ description: 'Benchmark or leaderboard ID; adds each model\'s score and rank, and sorts by it unless sortBy says otherwise.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
});
const Details = Type.Object({
  modelIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  filters: Type.Optional(FiltersSchema),
});

export function scoutTools(host: ToolHost): ToolRegistration[] {
  const searchBenchmarksTool: ToolRegistration<typeof SearchBenchmarks> = {
    name: 'search_benchmarks', replay: 'safe',
    description: 'Semantic (embedding) search over the methodologies of every benchmark in the catalogue. Returns benchmarks whose measured work resembles the query, with how many models each has results for. Use it to find the evidence that applies to each step of the work.',
    parameters: SearchBenchmarks,
    async execute({ query, limit }) {
      host.progress(`Finding benchmarks for ${quote(query)}`);
      const catalogue = await host.catalogue();
      return text(searchBenchmarks(catalogue, await catalogue.semanticBenchmarks(query, limit ?? 10)));
    },
  };
  const searchCatalogueTool: ToolRegistration<typeof SearchCatalogue> = {
    name: 'search_catalogue', replay: 'safe',
    description: 'Free-text search over every model (all kinds), chat benchmark and leaderboard in the catalogue. Returns IDs the other tools accept, each with its type, kind and which field matched (name, aliases, description, or meaning for embedding matches). Use it to discover what exists for a task described in words; use search_models to filter and sort by hard constraints.',
    parameters: SearchCatalogue,
    async execute(args) {
      host.progress(`Searching the catalogue for ${quote(args.query)}`);
      return text(await searchCatalogue(await host.catalogue(), args));
    },
  };
  const leaderboardTool: ToolRegistration<typeof Leaderboard> = {
    name: 'benchmark_leaderboard', replay: 'safe',
    description: 'Scores of catalogued models on one benchmark or leaderboard, best first, optionally restricted to models meeting hard constraints. Benchmark ranks are among catalogued models; leaderboard ranks are among every result on that board, in its own direction (higherIsBetter).',
    parameters: Leaderboard,
    async execute({ benchmark, filters, limit }) {
      const catalogue = await host.catalogue();
      host.progress(`Reading the ${catalogue.benchmarks.find(b => b.id === benchmark)?.name ?? benchmark} leaderboard`);
      try { return text(benchmarkLeaderboard(catalogue, benchmark, { ...filters, ...await host.scope() }, limit)); } catch (error) { return failure((error as Error).message); }
    },
  };
  const searchModelsTool: ToolRegistration<typeof SearchModels> = {
    name: 'search_models', replay: 'safe',
    description: 'Structured model search: filter by hard constraints (including kind) and sort by benchmark or leaderboard rank, price, speed or recency to find the leaders on each axis. Each result has its kind, the cheapest eligible route price in each unit it is billed in (per 1M tokens, per image, per second, per 1M characters, per page or per request), reference speed, release date, context window and modalities. Price sorting compares one unit only.',
    parameters: SearchModels,
    async execute(args) {
      host.progress(args.query ? `Searching models for ${quote(args.query)}` : `Searching models by ${args.sortBy ?? (args.benchmark ? 'benchmark' : 'constraints')}`);
      try { return text(searchModels(await host.catalogue(), { ...args, filters: { ...args.filters, ...await host.scope() } })); } catch (error) { return failure((error as Error).message); }
    },
  };
  const detailsTool: ToolRegistration<typeof Details> = {
    name: 'get_model_details', replay: 'safe',
    description: 'Full records for up to eight models of any kind: routes with unit prices, parameters, reference speed, release date, every benchmark result with its rank, and leaderboard results (media, speech, embedding, MTEB) with metric, direction and rank. Use it on finalists before recommending them, and cite benchmark or leaderboard IDs from it.',
    parameters: Details,
    async execute({ modelIds, filters }) {
      host.progress(`Comparing ${modelIds.length} ${modelIds.length === 1 ? 'model' : 'models'}`);
      return text(modelDetails(await host.catalogue(), modelIds, { ...filters, ...await host.scope() }));
    },
  };
  const askTool: ToolRegistration<typeof ClarificationSchema> = {
    name: 'ask_clarifying_questions', replay: 'safe',
    description: 'End this turn by showing the user your task brief and up to four questions about the components that are missing and would change the shortlist. The user edits the brief in place to answer, or skips, in their next message.',
    parameters: ClarificationSchema,
    async execute(args) {
      const blocked = await host.clarificationBlocked();
      if (blocked) return failure(`${blocked} Do not ask questions. Make reasonable assumptions, list them, and submit a recommendation.`);
      await host.answer({ kind: 'clarification', ...args });
      return { ...text('Questions shown to the user. Stop here.'), control: { terminate: true } };
    },
  };
  const planTool: ToolRegistration<typeof PlanSchema> = {
    name: 'plan_tasks', replay: 'safe',
    description: 'Record how the work splits into tasks, one per model it needs, with the settled brief and your assumptions. Call it before researching; call it again to change the split, which discards the shortlists accepted so far.',
    parameters: PlanSchema,
    async execute(args) {
      const limit = await host.maxTasks();
      if (limit !== null && args.tasks.length > limit) return failure(`This conversation allows at most ${limit} tasks. Group steps that one model can perform together until the plan has at most ${limit}, and mention the grouping in your assumptions.`);
      const titles = args.tasks.map(t => t.title.trim().toLowerCase());
      if (new Set(titles).size !== titles.length) return failure('Give every task a different title.');
      await host.savePlan({ ...args, results: args.tasks.map(() => null) });
      host.progress(args.tasks.length === 1 ? 'Planning one task' : `Splitting the work into ${args.tasks.length} tasks`);
      return text(`Plan recorded. Research each task, then call submit_recommendation once per task:\n${args.tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}`);
    },
  };
  const submitTool: ToolRegistration<typeof SubmissionSchema> = {
    name: 'submit_recommendation', replay: 'safe',
    description: 'Submit the shortlist for one planned task: a priority, a quality bar and up to ten assessed candidates of any kind. Scout keeps the candidates at or above the bar, ranks them by the priority (by default cost, cheapest first) and shows the top five (fewer when fewer reach the bar). It is checked against the catalogue and the hard constraints; cost, latency and recency are computed from catalogue prices for the per-task workload you estimate in billing units (tokens, images, seconds of audio or video, characters, pages, requests). If it is rejected, fix the listed problems and submit again. The turn ends once every task has an accepted shortlist.',
    parameters: SubmissionSchema,
    async execute(args) {
      const plan = await host.plan();
      if (!plan) return failure('Call plan_tasks first to split the work into tasks.');
      const task = plan.tasks[args.task - 1];
      if (!task) return failure(`The plan has ${plan.tasks.length} ${plan.tasks.length === 1 ? 'task' : 'tasks'}; use a task number from 1 to ${plan.tasks.length}.`);
      host.progress(plan.tasks.length === 1 ? 'Checking the shortlist' : `Checking the shortlist for ${quote(task.title)}`);
      let result: TaskShortlist;
      try { result = finalize(await host.catalogue(), args, host.now(), await host.scope(), { task, measurements: await host.measurements() }); } catch (error) { return failure((error as Error).message); }
      plan.results[args.task - 1] = result;
      await host.savePlan(plan);
      const remaining = plan.tasks.flatMap((t, i) => plan.results[i] ? [] : [`${i + 1}. ${t.title}`]);
      if (remaining.length) return text(`Task ${args.task} accepted. Still to submit:\n${remaining.join('\n')}`);
      const catalogue = await host.catalogue();
      await host.answer({ kind: 'recommendation', brief: plan.brief, assumptions: plan.assumptions, catalogueVersion: catalogue.version,
        tasks: plan.tasks.map((t, i) => ({ ...t, ...(plan.results[i] as TaskShortlist) })) });
      return { ...text('Recommendation shown to the user. Stop here.'), control: { terminate: true } };
    },
  };
  return [searchCatalogueTool, searchBenchmarksTool, leaderboardTool, searchModelsTool, detailsTool, askTool, planTool, submitTool] as ToolRegistration[];
}

// Reports progress for a tool provided by another package, such as web search.
export function withProgress<T extends ToolRegistration>(tool: T, host: ToolHost, step: (args: Parameters<T['execute']>[0]) => string): T {
  return { ...tool, execute: (args, api, context) => { host.progress(step(args)); return tool.execute(args, api, context); } };
}
