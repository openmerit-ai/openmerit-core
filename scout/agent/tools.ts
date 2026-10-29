// The Scout agent's tools. Catalogue reads are replay-safe; the two answer
// tools end the run, so a turn ends with questions or a validated shortlist.
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { benchmarkLeaderboard, kinds, modelDetails, searchBenchmarks, searchCatalogue, searchModels, units, type Catalogue } from './catalogue.ts';
import { documentTypes } from './search.ts';
import { ClarificationSchema, FiltersSchema, SubmissionSchema, finalize, type Clarification, type Recommendation } from './recommendation.ts';

export type Answer = ({ kind: 'clarification' } & Clarification) | Recommendation;
export interface ToolHost {
  catalogue(): Promise<Catalogue>;
  now(): number;
  // Why clarifying questions are not allowed now, or null when they are.
  clarificationBlocked(): Promise<string | null>;
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
      try { return text(benchmarkLeaderboard(catalogue, benchmark, filters, limit)); } catch (error) { return failure((error as Error).message); }
    },
  };
  const searchModelsTool: ToolRegistration<typeof SearchModels> = {
    name: 'search_models', replay: 'safe',
    description: 'Structured model search: filter by hard constraints (including kind) and sort by benchmark or leaderboard rank, price, speed or recency to find the leaders on each axis. Each result has its kind, the cheapest eligible route price in each unit it is billed in (per 1M tokens, per image, per second, per 1M characters, per page or per request), reference speed, release date, context window and modalities. Price sorting compares one unit only.',
    parameters: SearchModels,
    async execute(args) {
      host.progress(args.query ? `Searching models for ${quote(args.query)}` : `Searching models by ${args.sortBy ?? (args.benchmark ? 'benchmark' : 'constraints')}`);
      try { return text(searchModels(await host.catalogue(), args)); } catch (error) { return failure((error as Error).message); }
    },
  };
  const detailsTool: ToolRegistration<typeof Details> = {
    name: 'get_model_details', replay: 'safe',
    description: 'Full records for up to eight models of any kind: routes with unit prices, parameters, reference speed, release date, every benchmark result with its rank, and leaderboard results (media, speech, embedding, MTEB) with metric, direction and rank. Use it on finalists before recommending them, and cite benchmark or leaderboard IDs from it.',
    parameters: Details,
    async execute({ modelIds, filters }) {
      host.progress(`Comparing ${modelIds.length} ${modelIds.length === 1 ? 'model' : 'models'}`);
      return text(modelDetails(await host.catalogue(), modelIds, filters));
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
  const submitTool: ToolRegistration<typeof SubmissionSchema> = {
    name: 'submit_recommendation', replay: 'safe',
    description: 'End this turn with your shortlist of five models of any kind, best overall first (fewer only when fewer meet the hard constraints). The shortlist is checked against the catalogue and the hard constraints; cost, latency and recency are computed from catalogue prices for the per-task workload you estimate in billing units (tokens, images, seconds of audio or video, characters, pages, requests). If it is rejected, fix the listed problems and submit again.',
    parameters: SubmissionSchema,
    async execute(args) {
      host.progress('Checking the shortlist');
      let result: Recommendation;
      try { result = finalize(await host.catalogue(), args, host.now()); } catch (error) { return failure((error as Error).message); }
      await host.answer(result);
      return { ...text('Recommendation shown to the user. Stop here.'), control: { terminate: true } };
    },
  };
  return [searchCatalogueTool, searchBenchmarksTool, leaderboardTool, searchModelsTool, detailsTool, askTool, submitTool] as ToolRegistration[];
}

// Reports progress for a tool provided by another package, such as web search.
export function withProgress<T extends ToolRegistration>(tool: T, host: ToolHost, step: (args: Parameters<T['execute']>[0]) => string): T {
  return { ...tool, execute: (args, api, context) => { host.progress(step(args)); return tool.execute(args, api, context); } };
}
