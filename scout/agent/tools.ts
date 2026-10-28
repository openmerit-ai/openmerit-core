// The Scout agent's tools. Catalogue reads are replay-safe; the two answer
// tools end the run, so a turn ends with questions or a validated shortlist.
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { benchmarkLeaderboard, modelDetails, searchBenchmarks, searchModels, type Catalogue } from './catalogue.ts';
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
const Leaderboard = Type.Object({
  benchmark: Type.String({ description: 'Benchmark ID from search_benchmarks.' }),
  filters: Type.Optional(FiltersSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
const SearchModels = Type.Object({
  query: Type.Optional(Type.String({ description: 'Words that must all appear in the model ID, name or maker, e.g. "claude" or "qwen coder".' })),
  filters: Type.Optional(FiltersSchema),
  sortBy: Type.Optional(Type.Union([Type.Literal('benchmark'), Type.Literal('price'), Type.Literal('speed'), Type.Literal('recency')])),
  benchmark: Type.Optional(Type.String({ description: 'Benchmark ID; adds each model\'s score and rank, and sorts by it unless sortBy says otherwise.' })),
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
  const leaderboardTool: ToolRegistration<typeof Leaderboard> = {
    name: 'benchmark_leaderboard', replay: 'safe',
    description: 'Scores of catalogued models on one benchmark, best first, optionally restricted to models meeting hard constraints. Ranks are among all measured models.',
    parameters: Leaderboard,
    async execute({ benchmark, filters, limit }) {
      const catalogue = await host.catalogue();
      host.progress(`Reading the ${catalogue.benchmarks.find(b => b.id === benchmark)?.name ?? benchmark} leaderboard`);
      try { return text(benchmarkLeaderboard(catalogue, benchmark, filters, limit)); } catch (error) { return failure((error as Error).message); }
    },
  };
  const searchModelsTool: ToolRegistration<typeof SearchModels> = {
    name: 'search_models', replay: 'safe',
    description: 'Search the model catalogue with hard constraints. Each result has its cheapest eligible route price (USD per 1M tokens), reference speed, release date, context window and modalities. Sort by benchmark, price, speed or recency to find the leaders on each axis.',
    parameters: SearchModels,
    async execute(args) {
      host.progress(args.query ? `Searching models for ${quote(args.query)}` : `Searching models by ${args.sortBy ?? (args.benchmark ? 'benchmark' : 'constraints')}`);
      try { return text(searchModels(await host.catalogue(), args)); } catch (error) { return failure((error as Error).message); }
    },
  };
  const detailsTool: ToolRegistration<typeof Details> = {
    name: 'get_model_details', replay: 'safe',
    description: 'Full records for up to eight models: routes and prices, parameters, reference speed, release date and every benchmark result with its rank. Use it on finalists before recommending them, and cite benchmark IDs from it.',
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
    description: 'End this turn with your shortlist of five models, best overall first. The shortlist is checked against the catalogue and the hard constraints; cost, latency and recency are computed from catalogue data for the workload you estimate. If it is rejected, fix the listed problems and submit again.',
    parameters: SubmissionSchema,
    async execute(args) {
      host.progress('Checking the shortlist');
      let result: Recommendation;
      try { result = finalize(await host.catalogue(), args, host.now()); } catch (error) { return failure((error as Error).message); }
      await host.answer(result);
      return { ...text('Recommendation shown to the user. Stop here.'), control: { terminate: true } };
    },
  };
  return [searchBenchmarksTool, leaderboardTool, searchModelsTool, detailsTool, askTool, submitTool] as ToolRegistration[];
}

// Reports progress for a tool provided by another package, such as web search.
export function withProgress<T extends ToolRegistration>(tool: T, host: ToolHost, step: (args: Parameters<T['execute']>[0]) => string): T {
  return { ...tool, execute: (args, api, context) => { host.progress(step(args)); return tool.execute(args, api, context); } };
}
