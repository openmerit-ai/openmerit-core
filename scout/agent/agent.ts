// One Scout conversation per Durable Object. Pi Durable runs the agent loop and
// keeps its transcript in this object's SQLite; PiHarness wakes the object to
// finish interrupted work. Each turn ends with clarifying questions or a shortlist.
import { DurableObject } from 'cloudflare:workers';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createAI } from 'agents/models/pi-ai';
import { webSearchTool } from 'agents/websearch/pi';
import { embed } from '../evidence-search.mjs';
import { loadCatalogue, type Catalogue, type CatalogueBindings } from './catalogue.ts';
import { agentModels, defaultAgentModel, openAIModelId } from './model.ts';
import { preamble, sessionSection } from './prompt.ts';
import { scoutTools, withProgress, type ToolHost } from './tools.ts';
import { turnText, type AgentState, type TurnAnswer, type TurnRequest } from './turn.ts';

export interface AgentEnv extends CatalogueBindings {
  AI: Ai;
  // openai/<id> (OpenAI with OPENAI_API_KEY), or a Workers AI (@cf/…) or AI Gateway catalogue model.
  SCOUT_AGENT_MODEL?: string;
  SCOUT_AGENT_WEB_SEARCH?: string;
}
const maxClarificationRounds = 2;

// Published catalogues change twice a day; one load serves every conversation in this isolate for a while.
let shared: { at: number; catalogue: Promise<Catalogue> } | undefined;
// Same embedding model and dimensions as the published evidence vectors.
const embedTexts = embed as (input: string[], options: { apiKey: string; timeoutMs: number }) => Promise<number[][]>;
function catalogueFor(env: AgentEnv): Promise<Catalogue> {
  if (!shared || Date.now() - shared.at > 10 * 60_000) {
    const catalogue = loadCatalogue(env, (texts, apiKey) => embedTexts(texts, { apiKey, timeoutMs: 8000 }));
    shared = { at: Date.now(), catalogue };
    catalogue.catch(() => { if (shared?.catalogue === catalogue) shared = undefined; });
  }
  return shared.catalogue;
}

export class ScoutAgent extends DurableObject<AgentEnv> {
  readonly ai = createAI({ binding: this.env.AI });
  readonly agentModels = agentModels(this.env.OPENAI_API_KEY);
  readonly registry = createRegistry();
  progressLog: string[] = [];

  readonly host: ToolHost = {
    catalogue: () => catalogueFor(this.env),
    now: () => Date.now(),
    clarificationBlocked: async () => {
      if (await this.ctx.storage.get<boolean>('skipped')) return 'The user skipped clarifying questions.';
      return ((await this.ctx.storage.get<number>('rounds')) ?? 0) >= maxClarificationRounds ? 'The clarifying questions for this conversation have been used.' : null;
    },
    answer: async answer => {
      await this.ctx.storage.put('answer', answer);
      if (answer.kind === 'clarification') await this.ctx.storage.put('rounds', ((await this.ctx.storage.get<number>('rounds')) ?? 0) + 1);
    },
    progress: step => { this.progressLog.push(step); void this.ctx.storage.put('progress', this.progressLog); },
  };

  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const tools = scoutTools(this.host);
      if (this.env.SCOUT_AGENT_WEB_SEARCH !== 'off') tools.push(withProgress(webSearchTool({ binding: this.env.AI, limit: 5 }), this.host, args => `Searching the web for “${args.query}”`));
      this.registry.install({
        name: 'scout',
        sections: [
          { key: 'preamble', render: () => preamble, tag: false },
          { key: 'today', render: () => new Date().toISOString().slice(0, 10) },
          { key: 'catalogue', render: async () => {
            const c = await this.host.catalogue(), kinds = new Map<string, number>();
            for (const m of c.models) kinds.set(m.kind ?? 'unknown', (kinds.get(m.kind ?? 'unknown') ?? 0) + 1);
            return `${c.models.length} models (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}), ${c.benchmarks.length} chat benchmarks and ${c.boards.length} leaderboards with results (catalogue ${c.version}).`;
          } },
          { key: 'session', render: async () => sessionSection({ skipped: !!(await this.ctx.storage.get<boolean>('skipped')), rounds: (await this.ctx.storage.get<number>('rounds')) ?? 0, maxRounds: maxClarificationRounds }) },
        ],
        tools,
      });
      const { models } = this.agentModels;
      models.setProvider(this.ai.provider);
      return Harness.open(storage, {
        models, registry: this.registry, onWake,
        settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 }, afterFailedRun: 'withdraw' },
        onReport: report => console.warn('scout-agent report', (report as { type?: string }).type),
      }, context);
    },
    defaults: { model: this.model(this.env.SCOUT_AGENT_MODEL || defaultAgentModel), thinkingLevel: 'low' },
  });

  model(spec: string) {
    const openai = openAIModelId(spec);
    return openai ? this.agentModels.openai(openai) : this.ai(spec as Parameters<typeof this.ai>[0]);
  }

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async state(): Promise<AgentState> {
    const [answer, turns, skipped, progress] = await Promise.all([
      this.ctx.storage.get<TurnAnswer>('answer'), this.ctx.storage.get<number>('turns'), this.ctx.storage.get<boolean>('skipped'), this.ctx.storage.get<string[]>('progress'),
    ]);
    return { busy: await this.harness.session().busy(), turns: turns ?? 0, skipped: !!skipped, progress: progress ?? [], answer: answer ?? null };
  }

  // Runs one user turn to its end. A client that disconnects can read the outcome from state().
  async turn(request: TurnRequest): Promise<AgentState> {
    const input = turnText(request);
    if (!input) throw new Error('Describe the work you want a model to do.');
    if (await this.harness.session().busy()) throw new Error('busy');
    if (request.skip) await this.ctx.storage.put('skipped', true);
    this.progressLog = [];
    await this.ctx.storage.put({ answer: null, progress: [], turns: ((await this.ctx.storage.get<number>('turns')) ?? 0) + 1 });
    const result = await this.harness.prompt(input, { operationId: crypto.randomUUID() });
    if (!(await this.ctx.storage.get<TurnAnswer>('answer'))) {
      // The model ended the run without an answer tool: keep what it said rather than nothing.
      await this.ctx.storage.put('answer', result.status === 'done' && result.text?.trim()
        ? { kind: 'message', text: result.text.trim() }
        : { kind: 'error', message: 'Scout could not finish this turn. Please try again.' });
      if (result.status !== 'done') console.warn('scout-agent turn unanswered', result.reason);
    }
    return this.state();
  }
}
