// The agent's two answers to a turn: clarifying questions about the task brief,
// or a shortlist for each task the work splits into. The model chooses and justifies; this module checks the choice
// against the catalogue and computes every number shown for cost, latency and
// recency, so a figure on screen always comes from source data.
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import { eligibleEndpoints, kinds, standings, unitLabels, violation, type Catalogue, type Endpoint, type Filters, type ModelRecord, type Rate } from './catalogue.ts';

export const components = ['input', 'work', 'output', 'criteria', 'constraints'] as const;
export type Component = typeof components[number];

const Part = (description: string) => Type.Object({
  text: Type.String({ description: `${description} Only what is known, in a few plain words; never write "unspecified" or list unknowns. Empty when nothing is known.` }),
  source: StringEnum(['stated', 'assumed', 'missing'], { description: 'stated: the user said it; assumed: your inference, to confirm; missing: unknown.' }),
});
export const BriefSchema = Type.Object({
  input: Part('What the model receives: data type, modality, size and format.'),
  work: Part('The steps or tasks the model performs, in order.'),
  output: Part('What the model must produce: format, schema, length, modality.'),
  criteria: Part('How success is judged: quality bar, evaluations, metrics, and which of quality, cost, latency and recency matter most. Only what the user explicitly said; otherwise empty and missing, never assumed.'),
  constraints: Part('Guardrails and hard limits: budget, latency ceilings, hosting, providers, data residency, open weights, licensing, safety. Only what the user explicitly said; otherwise empty and missing, never assumed.'),
}, { description: 'The task brief: the five components of the request.' });
export type Brief = Static<typeof BriefSchema>;

export const FiltersSchema = Type.Object({
  kind: Type.Optional(StringEnum(kinds, { description: 'Only models of this kind: chat (LLMs), embedding, rerank, image (generation/editing), video, speech (text to speech), transcription (speech to text), decision, ocr, moderation, 3d, music.' })),
  inputs: Type.Optional(Type.Array(Type.String(), { description: 'Required input modalities: text, image, audio, video, file.' })),
  outputs: Type.Optional(Type.Array(Type.String(), { description: 'Required output modalities: text, image, audio.' })),
  parameters: Type.Optional(Type.Array(Type.String(), { description: 'Required API features, e.g. tools, structured_outputs, response_format, reasoning.' })),
  providers: Type.Optional(Type.Array(Type.String(), { description: 'Only these model makers or hosts (substring match).' })),
  excludeProviders: Type.Optional(Type.Array(Type.String())),
  minContext: Type.Optional(Type.Integer({ minimum: 1, description: 'Minimum context window in tokens.' })),
  maxInputPrice: Type.Optional(Type.Number({ minimum: 0, description: 'USD per million input tokens.' })),
  maxOutputPrice: Type.Optional(Type.Number({ minimum: 0, description: 'USD per million output tokens.' })),
  openWeights: Type.Optional(Type.Boolean()),
  releasedAfter: Type.Optional(Type.String({ description: 'YYYY-MM-DD.' })),
}, { description: 'Hard constraints. Only set what the brief requires; never use these for preferences.' });

export const ClarificationSchema = Type.Object({
  brief: BriefSchema,
  questions: Type.Array(Type.Object({
    component: StringEnum(components),
    question: Type.String({ description: 'One short question.' }),
  }), { minItems: 1, maxItems: 4 }),
});
export type Clarification = Static<typeof ClarificationSchema>;

// Per-task quantities in the units models are billed in. Cost is computed from
// catalogue prices for whichever of these a route charges.
export const WorkloadSchema = Type.Object({
  inputTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'Input tokens per task, including prompts, documents and images sent to a token-billed model.' })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'Output tokens per task, including visible reasoning.' })),
  images: Type.Optional(Type.Integer({ minimum: 0, description: 'Images generated or edited per task.' })),
  imageOutputTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'Output tokens per generated image, for image models billed per image token instead of per image (about 1,300 for a 1024×1024 image). Set it with images whenever a shortlisted image model has only token prices.' })),
  audioSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Seconds of audio transcribed or generated per task.' })),
  videoSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Seconds of video generated or processed per task.' })),
  characters: Type.Optional(Type.Integer({ minimum: 0, description: 'Characters of text per task for character-billed models, such as text to speech.' })),
  pages: Type.Optional(Type.Integer({ minimum: 0, description: 'Document pages per task for page-billed models, such as OCR.' })),
  requests: Type.Optional(Type.Integer({ minimum: 0, description: 'Only for models billed per request, such as a rerank query; leave unset for models billed in tokens, seconds, images, characters or pages.' })),
}, { description: 'Estimated work per task. Give every quantity the task involves; set at least one.' });
export type Workload = Static<typeof WorkloadSchema>;
// imageOutputTokens is not billed on its own: it prices images on token-billed routes.
type Quantity = Exclude<keyof Workload, 'imageOutputTokens'>;
const quantities: Quantity[] = ['inputTokens', 'outputTokens', 'images', 'audioSeconds', 'videoSeconds', 'characters', 'pages', 'requests'];

// The work split into tasks, each served by a separately chosen model. Written
// once the brief is settled; every task then gets its own validated shortlist.
// A task is one model call. An agent runs several calls, possibly on different
// models; the agents together are the environment the brief describes.
export const PlanSchema = Type.Object({
  brief: BriefSchema,
  assumptions: Type.Array(Type.String(), { description: 'Assumptions you made in place of missing information.' }),
  tasks: Type.Array(Type.Object({
    title: Type.String({ description: 'Short name for the task, such as "Transcribe calls" or "Classify tickets".' }),
    work: Type.String({ description: 'What the model does in this task, in one or two sentences.' }),
    input: Type.String({ description: 'What this task\'s model receives.' }),
    output: Type.String({ description: 'What this task\'s model produces.' }),
    agent: Type.Optional(Type.String({ description: 'The agent this call belongs to, when the work is an agent that makes several model calls (with tools, guardrails or retries), such as "Adjudication agent". Omit for a standalone call.' })),
    callsPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: 'How many times one run of that agent makes this call, including tool-call rounds and retries. Omit for a single call.' })),
  }), { minItems: 1, description: 'One entry per model the work needs, in the order they run.' }),
});
export type Plan = Static<typeof PlanSchema>;
export type TaskPlan = Plan['tasks'][number];

// The axes a shortlist is compared and ranked on. Cost is the default priority:
// models that hold the task's quality bar, cheapest first. Latency is shown but never ranks:
// few sources measure it, and it depends on the endpoint and reasoning setting.
export const axes = ['cost', 'quality', 'recency'] as const;
export type Axis = typeof axes[number];

// The levels an application's results are measured at: one model call, one agent run, or the whole environment.
export const levels = ['task', 'agent', 'environment'] as const;
export type Level = typeof levels[number];

// What a result measures: quality (the default), or what the work cost in USD or took in seconds:
// per model call at the task level, per agent run at the agent level, per outcome at the environment level.
export const measureKinds = ['quality', 'usd', 'seconds'] as const;
export type MeasureKind = typeof measureKinds[number];

// An aggregate result the customer measured with their own evals and reported on a conversation.
// Only aggregates reach Scout, never the inputs or outputs they were measured on.
// They are stored with the conversation and inform only that user's recommendations.
export interface Measurement {
  id: string; // m1, m2, … in the order Scout received them
  level: Level;
  kind: MeasureKind;
  task: string | null; // the plan task title it measures, when it measures one task
  scope: string; // what was measured, in the user's words, such as "adjudication agent"
  model: string; // catalogue model ID or endpoint ID
  metric: string;
  value: number;
  higherIsBetter: boolean;
  samples: number;
  source: string; // where it was measured, such as "Langfuse experiment claims-2026-11"
}
export type MeasurementInput = Omit<Measurement, 'id'>;

// How to measure the shortlist with the customer's own evals before choosing.
export const EvaluationSchema = Type.Object({
  checks: Type.Array(Type.Object({
    level: StringEnum(levels, { description: 'task: one model call; agent: one run of the agent; environment: the end-to-end outcome across agents and controls.' }),
    metric: Type.String({ description: 'What to measure, such as "tool arguments valid" or "line decisions correct".' }),
    how: Type.String({ description: 'How to measure it with the user\'s existing evals or labels, in one sentence.' }),
  }), { minItems: 1, maxItems: 6 }),
  samples: Type.Integer({ minimum: 1, maximum: 100000, description: 'Labelled examples per candidate that would separate the shortlist for this repeated work.' }),
  stopEarly: Type.String({ description: 'When to stop measuring a candidate that is clearly losing, in one sentence.' }),
}, { description: 'How the user should measure this task\'s shortlist with their own evals before choosing: add the candidates as runs of evals they already have rather than building new ones.' });
export type Evaluation = Static<typeof EvaluationSchema>;

export const SubmissionSchema = Type.Object({
  task: Type.Integer({ minimum: 1, description: 'Task number from plan_tasks, starting at 1.' }),
  priority: Type.Optional(StringEnum(axes, { description: 'How to rank the shortlist. cost (the default): models that hold the task\'s quality bar, cheapest first. Use quality only when the user explicitly asks for the best quality, recency only when they ask for the newest.' })),
  filters: Type.Optional(FiltersSchema),
  workload: WorkloadSchema,
  summary: Type.String({ description: 'When there are no candidates, explain why. Otherwise leave empty: Scout builds the summary from the first model after ranking, using its rationale and watchOut.' }),
  qualityBar: Type.Integer({ minimum: 0, maximum: 100, description: 'The lowest quality estimate at which a model still does THIS task to the brief\'s standard. Candidates below it are never shown.' }),
  candidates: Type.Array(Type.Object({
    modelId: Type.String({ description: 'Model ID from the catalogue tools.' }),
    quality: Type.Integer({ minimum: 0, maximum: 100, description: 'Your quality estimate for THIS task, from the user\'s measured results when there are any, else the cited benchmark standings.' }),
    evidence: Type.Array(Type.String(), { description: 'Benchmark or leaderboard IDs from this model\'s get_model_details results, and measured:<id> for the user\'s measured results on this model, that support the quality estimate.' }),
    rationale: Type.String({ description: 'One or two sentences on why this model fits the task.' }),
    watchOut: Type.Optional(Type.String({ description: 'The main risk or limitation.' })),
  }), { maxItems: 10, description: 'Up to ten models you assessed for this task, in any order. Scout keeps those at or above the quality bar, ranks them by the priority and shows the top five, so include every model that could lead on it. Fewer only when fewer meet the hard constraints, and empty when none do.' }),
  evaluation: EvaluationSchema,
});
export type Submission = Static<typeof SubmissionSchema>;

export interface RecommendedModel {
  rank: number; id: string; name: string; provider: string; rationale: string; watchOut: string | null;
  // measured: the estimate rests on the user's own measured results, not only public benchmarks.
  quality: { score: number; measured: boolean; evidence: Array<{ benchmark: string; name: string; score: number | null; rank: number; of: number }> };
  // Cost of 1,000 tasks on the eligible route that prices the most workload quantities, then the cheapest.
  // endpointId and providerModelId identify that route and the model ID its API expects.
  // Token prices are kept for the shortlist table; rates lists every price used; unpriced lists quantities the route does not bill.
  // usdPer1kAgentRuns: the same route's cost of 1,000 runs of the task's agent, when one run makes the call several times.
  // calibration: the estimate was scaled by the median ratio of measured to estimated cost on this task (results are the measured:<id> used).
  // measured: the user's own measured cost for this task, which ranks ahead of the catalogue estimate (result is its measured:<id>).
  cost: { usdPer1kTasks: number; usdPer1kAgentRuns?: number; calibration?: { factor: number; results: string[] }; measured?: { usdPer1kTasks: number; usdPer1kAgentRuns?: number; result: string }; route: string; endpointId: string; providerModelId: string; inputPerMillion: number | null; outputPerMillion: number | null; rates: Array<{ unit: string; kind: string; amount: number }>; unpriced: Quantity[] } | null;
  latency: { seconds: number; firstTokenSeconds: number; tokensPerSecond: number; source: string | null } | null;
  recency: { released: string; ageDays: number } | null;
  best: Axis[];
}
export interface TaskShortlist { summary: string; workload: Workload; priority: Axis; qualityBar: number; models: RecommendedModel[]; evaluation: Evaluation }
export type TaskRecommendation = TaskPlan & TaskShortlist;
export interface Recommendation {
  kind: 'recommendation'; brief: Brief; assumptions: string[]; catalogueVersion: string; tasks: TaskRecommendation[];
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
// The axis leaders among the shortlist; ties share the label, unknown values never lead.
function leaders(models: RecommendedModel[]): void {
  const lead = (axis: Axis, value: (m: RecommendedModel) => number | null, higher: boolean) => {
    const known = models.map(value).filter((v): v is number => v !== null);
    if (known.length < 2) return;
    const best = higher ? Math.max(...known) : Math.min(...known);
    for (const m of models) if (value(m) === best) m.best.push(axis);
  };
  lead('quality', m => m.quality.score, true);
  // Only a cost covering the whole workload can lead. When the user measured cost, only measured cost can:
  // estimates often share one route price and are not comparable with what the user pays.
  const measured = models.some(m => m.cost?.measured);
  lead('cost', m => measured ? m.cost?.measured?.usdPer1kTasks ?? null : m.cost && !m.cost.unpriced.length ? m.cost.usdPer1kTasks : null, false);
  lead('recency', m => m.recency ? -m.recency.ageDays : null, true);
}

// The price a route charges per unit of one workload quantity, from its rates.
// Generic per-second input/output rates apply to audio or video by the model's kind.
const audioKinds = new Set(['transcription', 'speech', 'music']);
function charges(q: Quantity, rates: readonly Rate[], kind: string | null): Rate[] {
  const of = (unit: Rate['unit'], ...names: string[]) => rates.filter(r => r.unit === unit && (!names.length || names.includes(r.kind)));
  switch (q) {
    case 'inputTokens': return of('token', 'input');
    case 'outputTokens': return of('token', 'output');
    case 'images': { const out = of('image', 'output_image', 'output'); return out.length ? out : of('image', 'input_image', 'input'); }
    case 'audioSeconds': return of('second', 'input_audio', 'output_audio', ...(kind && audioKinds.has(kind) ? ['input', 'output'] : []));
    case 'videoSeconds': return of('second', 'input_video', 'output_video', ...(kind === 'video' ? ['input', 'output'] : []));
    case 'characters': return of('character');
    case 'pages': return of('page');
    case 'requests': return of('request');
  }
}
// The quantities each kind is chiefly billed for; other kinds are billed for tokens.
const primary: Record<string, Quantity[]> = {
  image: ['images'], video: ['videoSeconds'], transcription: ['audioSeconds'], speech: ['characters', 'audioSeconds'], music: ['audioSeconds'], ocr: ['pages'], '3d': ['requests'],
};
// Token and character prices are per million.
const perUnit = (r: Rate) => r.unit === 'token' || r.unit === 'character' ? r.amount / 1e6 : r.amount;
export function routeCost(route: Endpoint, kind: string | null, w: Workload) {
  let usd = 0; const used: Rate[] = [], unpriced: Quantity[] = [];
  for (const q of quantities) {
    const amount = w[q]; if (!amount) continue;
    const rates = charges(q, route.rates, kind);
    if (!rates.length) { unpriced.push(q); continue; }
    for (const r of rates) { usd += amount * perUnit(r); used.push(r); }
  }
  // A route without a per-image price bills images by their output tokens.
  const imageToken = route.rates.find(r => r.unit === 'token' && r.kind === 'output_image'), at = unpriced.indexOf('images');
  if (at >= 0 && imageToken && w.images && w.imageOutputTokens) { usd += w.images * w.imageOutputTokens * perUnit(imageToken); used.push(imageToken); unpriced.splice(at, 1); }
  return { usd, used, unpriced };
}

// The user's measured results on one catalogue model: reported by its model ID or one of its endpoint IDs.
export const measuredOn = (m: ModelRecord, results: readonly Measurement[]) => results.filter(r => r.model === m.id || m.endpoints.some(e => e.id === r.model));
const sameTitle = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// Validates one task's submitted shortlist. Errors are written for the agent, which can
// correct the submission and try again; nothing invalid reaches the user. Scope
// holds constraints the conversation imposes, such as the endpoint inventory. The
// context is the planned task and the user's measured results: a candidate the user
// measured on this task must rest on that result, because it outranks any benchmark.
export function finalize(catalogue: Catalogue, s: Submission, now: number, scope: Filters = {}, context: { task?: TaskPlan; measurements?: readonly Measurement[] } = {}): TaskShortlist {
  const filters: Filters = { ...s.filters, ...scope }, byId = new Map(catalogue.models.map(m => [m.id, m]));
  const problems: string[] = [], seen = new Set<string>();
  const results = context.measurements ?? [], measurement = new Map(results.map(r => [`measured:${r.id}`, r]));
  const agentic = new Set(catalogue.benchmarks.filter(b => b.tags.includes('tools') || b.tags.includes('agents')).map(b => b.id));
  if (!quantities.some(q => (s.workload[q] ?? 0) > 0)) problems.push('The workload is empty: estimate at least one per-task quantity, such as inputTokens and outputTokens, images or audioSeconds.');
  for (const r of s.candidates) {
    const m = byId.get(r.modelId);
    if (!m) { problems.push(`${r.modelId} is not in the catalogue; use an exact ID from search_models or search_catalogue.`); continue; }
    if (seen.has(m.id)) problems.push(`${m.id} is listed twice.`);
    seen.add(m.id);
    const why = violation(m, filters);
    if (why) problems.push(`${m.id} breaks the hard constraints: ${why}.`);
    // A citation must be this model's own benchmark or leaderboard result, or the user's measured result on it.
    const own = measuredOn(m, results);
    const measured = new Set([...m.evidence.map(e => e.benchmark), ...m.boards.map(b => b.board), ...own.map(x => `measured:${x.id}`)]);
    const missing = r.evidence.filter(id => !measured.has(id));
    if (missing.length) problems.push(`${m.id} has no results on ${missing.join(', ')}; cite only benchmark or leaderboard IDs from its get_model_details results, or measured:<id> for the user's results on this model.`);
    const uncited = own.filter(x => x.kind === 'quality' && sameTitle(x.task, context.task?.title) && !r.evidence.includes(`measured:${x.id}`));
    if (uncited.length) problems.push(`The user measured ${m.id} on this task (${uncited.map(x => `measured:${x.id}`).join(', ')}); cite those results and base its quality estimate on them.`);
    // An agent's call fails on a malformed tool call as surely as on a wrong answer, so domain benchmarks alone cannot put it over the bar.
    if (context.task?.agent && r.quality >= s.qualityBar && !r.evidence.some(id => measurement.get(id)?.kind === 'quality' || agentic.has(id)))
      problems.push(`${m.id} reaches the quality bar for an agent's call without evidence of tool calling: cite a tools or agents benchmark from its get_model_details results, or the user's measured result, or estimate it below the bar.`);
  }
  const eligible = catalogue.models.filter(m => violation(m, filters) === null).length;
  const qualifying = s.candidates.filter(r => r.quality >= s.qualityBar);
  // An environment result also measures every other agent, so a miss there need not be this task's model.
  // A candidate whose own task- and agent-level quality results on this task match a qualifying candidate's cannot be dropped below the bar.
  const ownQuality = (id: string) => { const m = byId.get(id); return m ? measuredOn(m, results).filter(x => x.kind === 'quality' && x.level !== 'environment' && sameTitle(x.task, context.task?.title)) : []; };
  const peers = qualifying.flatMap(r => ownQuality(r.modelId));
  for (const r of s.candidates.filter(r => r.quality < s.qualityBar)) {
    const own = ownQuality(r.modelId);
    const matched = own.length > 0 && own.every(x => peers.some(y => y.metric === x.metric && y.level === x.level && (x.higherIsBetter ? x.value >= y.value : x.value <= y.value)));
    if (matched) problems.push(`${r.modelId} is below the bar, but its task- and agent-level results on this task (${own.map(x => `measured:${x.id}`).join(', ')}) match a candidate at or above it. Environment-level results include the other agents, so they do not show this model fell short: estimate it from its own results, or cite one that shows it is worse.`);
  }
  // Five assessed candidates keep cheaper models from being left out; fewer may reach the bar, so the bar never has to drop to fill the list.
  if (!problems.length && s.candidates.length < Math.min(5, eligible)) problems.push(`Assess at least five candidates; ${s.candidates.length} submitted, and ${eligible} models meet the constraints${filters.kind ? '' : ' (set filters.kind when the task needs one kind of model)'}. Assess more models that can do this task.`);
  if (!problems.length && eligible && !qualifying.length) problems.push(`No candidate reaches the quality bar of ${s.qualityBar}. Assess stronger models that can do this task.`);
  if (problems.length) throw new Error(`Shortlist not accepted:\n- ${problems.join('\n- ')}`);

  const names = new Map([...catalogue.benchmarks.map(b => [b.id, b.name] as const), ...catalogue.boards.map(b => [b.id, b.title] as const)]);
  const standing = (id: string, model: string) => {
    const x = measurement.get(id);
    // A measured result ranks among the user's results on the same metric, level and task.
    if (x) {
      const peers = results.filter(y => y.metric === x.metric && y.level === x.level && (y.task ?? '').toLowerCase() === (x.task ?? '').toLowerCase());
      return { score: x.value, rank: 1 + peers.filter(y => x.higherIsBetter ? y.value > x.value : y.value < x.value).length, of: peers.length };
    }
    const row = standings(catalogue, id).find(x => x.model.id === model);
    return { score: row?.score ?? null, rank: row?.rank ?? 0, of: row?.of ?? 0 };
  };
  const label = (id: string) => {
    const x = measurement.get(id);
    return x ? `Your eval: ${x.metric} (${x.level} level, ${x.samples} ${x.samples === 1 ? 'sample' : 'samples'}, ${x.source})` : names.get(id) ?? id;
  };
  const calls = context.task?.callsPerRun ?? 1;
  const { outputTokens } = s.workload;
  const assessed = qualifying.map((r, i): RecommendedModel => {
    const m = byId.get(r.modelId);
    if (!m) throw new Error('Unreachable: validated above.');
    // The route pricing the most of the kind's own quantities (images for an image model), then the most of the
    // workload, then the cheapest; earlier routes win ties. A route pricing only the prompt never beats one pricing the image.
    const own = (primary[m.kind ?? ''] ?? ['inputTokens', 'outputTokens']).filter(q => (s.workload[q] ?? 0) > 0);
    let best: { route: Endpoint; usd: number; used: Rate[]; unpriced: Quantity[]; covered: number } | null = null;
    for (const route of eligibleEndpoints(m, filters)) {
      const c = routeCost(route, m.kind, s.workload), covered = own.filter(q => !c.unpriced.includes(q)).length;
      if (!c.used.length) continue;
      if (!best || covered > best.covered || covered === best.covered && (c.unpriced.length < best.unpriced.length || c.unpriced.length === best.unpriced.length && c.usd < best.usd)) best = { route, covered, ...c };
    }
    // The user's measured cost on this task: per agent run at the agent level, per call at the task level.
    const spent = measuredOn(m, results).filter(x => x.kind === 'usd' && x.level !== 'environment' && sameTitle(x.task, context.task?.title))
      .sort((a, b) => (a.level === 'agent' ? 0 : 1) - (b.level === 'agent' ? 0 : 1))[0];
    const perRun = spent ? (spent.level === 'agent' ? spent.value : spent.value * calls) : null;
    const measuredCost = spent && perRun !== null ? { usdPer1kTasks: round(perRun / calls * 1000, 4), ...(calls > 1 ? { usdPer1kAgentRuns: round(perRun * 1000, 4) } : {}), result: `measured:${spent.id}` } : undefined;
    const tps = m.speed?.tokensPerSecond, ttft = m.speed?.timeToFirstToken;
    const released = m.releaseDate;
    return {
      rank: i + 1, id: m.id, name: m.name, provider: m.provider, rationale: r.rationale, watchOut: r.watchOut ?? null,
      quality: { score: r.quality, measured: r.evidence.some(id => measurement.get(id)?.kind === 'quality'), evidence: r.evidence.map(id => ({ benchmark: id, name: label(id), ...standing(id, m.id) })) },
      cost: best ? { usdPer1kTasks: round(best.usd * 1000, 4), ...(calls > 1 ? { usdPer1kAgentRuns: round(best.usd * 1000 * calls, 4) } : {}), route: best.route.provider, endpointId: best.route.id, providerModelId: best.route.modelId, inputPerMillion: best.route.inputPrice, outputPerMillion: best.route.outputPrice,
        rates: best.used.map(x => ({ unit: unitLabels[x.unit], kind: x.kind, amount: x.amount })), unpriced: best.unpriced, ...(measuredCost ? { measured: measuredCost } : {}) } : null,
      latency: tps && ttft != null && outputTokens ? { seconds: round(ttft + outputTokens / tps, 1), firstTokenSeconds: round(ttft, 1), tokensPerSecond: Math.round(tps), source: m.speed?.source ?? null } : null,
      recency: released ? { released, ageDays: Math.max(0, Math.floor((now - Date.parse(released)) / 86_400_000)) } : null,
      best: [],
    };
  });
  // Rank by the priority, lower first; unknown values go last, and ties keep the agent's order.
  // Only the top five are shown, so a costlier unmeasured model cannot displace a cheaper one that reaches the bar.
  // A cost that leaves part of the workload unpriced understates the bill, so it ranks as unknown.
  // The workload is Scout's guess, so the user's measured cost on this task calibrates every estimate in it:
  // the median ratio of measured to estimated cost among measured models scales all fully priced estimates alike,
  // which keeps their order and makes their size comparable with what the user pays.
  const calibrating = assessed.flatMap(m => m.cost?.measured && !m.cost.unpriced.length && m.cost.usdPer1kTasks > 0 ? [{ ratio: m.cost.measured.usdPer1kTasks / m.cost.usdPer1kTasks, result: m.cost.measured.result }] : []);
  const ratios = calibrating.map(x => x.ratio).sort((a, b) => a - b);
  if (ratios.length) {
    const factor = ratios.length % 2 ? ratios[(ratios.length - 1) / 2]! : (ratios[ratios.length / 2 - 1]! + ratios[ratios.length / 2]!) / 2;
    const from = calibrating.map(x => x.result);
    for (const m of assessed) if (m.cost && !m.cost.unpriced.length) {
      m.cost.usdPer1kTasks = round(m.cost.usdPer1kTasks * factor, 4);
      if (m.cost.usdPer1kAgentRuns !== undefined) m.cost.usdPer1kAgentRuns = round(m.cost.usdPer1kAgentRuns * factor, 4);
      m.cost.calibration = { factor: round(factor, 4), results: from };
    }
  }
  const priority = s.priority ?? 'cost';
  const keys: Record<Axis, (m: RecommendedModel) => number | null> = {
    quality: m => -m.quality.score, cost: m => m.cost && !m.cost.unpriced.length ? m.cost.usdPer1kTasks : null, recency: m => m.recency?.ageDays ?? null,
  };
  // Models the user measured come first: their own result on this work outranks a public benchmark,
  // so an unmeasured model cannot lead on a benchmark-based estimate. Within each group the priority ranks.
  // Measured cost replaces the estimate when every model in the group has one; estimates can be far off and must not be mixed with it.
  const allMeasuredCost = (measured: boolean) => assessed.filter(m => m.quality.measured === measured).every(m => m.cost?.measured);
  const useMeasured = { true: allMeasuredCost(true), false: allMeasuredCost(false) };
  const key = (m: RecommendedModel) => (priority === 'cost' && useMeasured[`${m.quality.measured}`] ? m.cost?.measured?.usdPer1kTasks : keys[priority](m)) ?? Infinity;
  // Models that tie on the priority, such as equal quality from the same measured results, rank by measured cost when both have one.
  const spent = (m: RecommendedModel) => m.cost?.measured?.usdPer1kTasks ?? Infinity;
  const diff = (x: number, y: number) => x === y ? 0 : x - y;
  const order = (a: RecommendedModel, b: RecommendedModel) => Number(b.quality.measured) - Number(a.quality.measured) || diff(key(a), key(b)) || diff(spent(a), spent(b));
  const models = assessed.sort(order).slice(0, 5);
  models.forEach((m, i) => { m.rank = i + 1; });
  leaders(models);
  // The model writes before sorting; its proposed winner can disagree with the final order.
  // Keep the explanation and caveat attached to the candidate that actually ranks first.
  const first = models[0];
  const summary = first
    ? `${first.name} ranks first in this shortlist. ${first.rationale}${first.watchOut ? ` ${first.watchOut}` : ''}`
    : s.summary;
  return { summary, workload: s.workload, priority, qualityBar: s.qualityBar, models, evaluation: s.evaluation };
}
