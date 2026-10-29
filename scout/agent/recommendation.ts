// The agent's two answers to a turn: clarifying questions about the task brief,
// or a shortlist. The model chooses and justifies; this module checks the choice
// against the catalogue and computes every number shown for cost, latency and
// recency, so a figure on screen always comes from source data.
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import { eligibleEndpoints, kinds, standings, unitLabels, violation, type Catalogue, type Endpoint, type Filters, type Rate } from './catalogue.ts';

export const components = ['input', 'work', 'output', 'criteria', 'constraints'] as const;
export type Component = typeof components[number];

const Part = (description: string) => Type.Object({
  text: Type.String({ description: `${description} Empty when unknown.` }),
  source: StringEnum(['stated', 'assumed', 'missing'], { description: 'stated: the user said it; assumed: your inference, to confirm; missing: unknown.' }),
});
export const BriefSchema = Type.Object({
  input: Part('What the model receives: data type, modality, size and format.'),
  work: Part('The steps or tasks the model performs, in order.'),
  output: Part('What the model must produce: format, schema, length, modality.'),
  criteria: Part('How success is judged: quality bar, evaluations, metrics, and which of quality, cost, latency and recency matter most.'),
  constraints: Part('Guardrails and hard limits: budget, latency ceilings, hosting, providers, data residency, open weights, licensing, safety.'),
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

export const SubmissionSchema = Type.Object({
  brief: BriefSchema,
  filters: Type.Optional(FiltersSchema),
  workload: WorkloadSchema,
  summary: Type.String({ description: 'Two or three sentences: the recommendation and the main trade-off.' }),
  assumptions: Type.Array(Type.String(), { description: 'Assumptions you made in place of missing information.' }),
  recommendations: Type.Array(Type.Object({
    modelId: Type.String({ description: 'Model ID from the catalogue tools.' }),
    role: Type.String({ description: 'Short label, such as "Best quality", "Best value", "Fastest", "Newest" or "Balanced".' }),
    quality: Type.Integer({ minimum: 0, maximum: 100, description: 'Your quality estimate for THIS task, from the cited benchmark standings.' }),
    evidence: Type.Array(Type.String(), { description: 'Benchmark or leaderboard IDs from this model\'s get_model_details results that support the quality estimate.' }),
    rationale: Type.String({ description: 'One or two sentences on why this model fits the brief.' }),
    watchOut: Type.Optional(Type.String({ description: 'The main risk or limitation.' })),
  }), { minItems: 1, maxItems: 5 }),
});
export type Submission = Static<typeof SubmissionSchema>;

export type Axis = 'quality' | 'cost' | 'latency' | 'recency';
export interface RecommendedModel {
  rank: number; id: string; name: string; provider: string; role: string; rationale: string; watchOut: string | null;
  quality: { score: number; evidence: Array<{ benchmark: string; name: string; score: number | null; rank: number; of: number }> };
  // Cost of 1,000 tasks on the eligible route that prices the most workload quantities, then the cheapest.
  // Token prices are kept for the shortlist table; rates lists every price used; unpriced lists quantities the route does not bill.
  cost: { usdPer1kTasks: number; route: string; inputPerMillion: number | null; outputPerMillion: number | null; rates: Array<{ unit: string; kind: string; amount: number }>; unpriced: Quantity[] } | null;
  latency: { seconds: number; firstTokenSeconds: number; tokensPerSecond: number; source: string | null } | null;
  recency: { released: string; ageDays: number } | null;
  best: Axis[];
}
export interface Recommendation {
  kind: 'recommendation'; brief: Brief; summary: string; assumptions: string[]; catalogueVersion: string;
  workload: Workload; models: RecommendedModel[];
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
  // Only a cost covering the whole workload can lead.
  lead('cost', m => m.cost && !m.cost.unpriced.length ? m.cost.usdPer1kTasks : null, false);
  lead('latency', m => m.latency?.seconds ?? null, false);
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

// Validates a submitted shortlist. Errors are written for the agent, which can
// correct the submission and try again; nothing invalid reaches the user.
export function finalize(catalogue: Catalogue, s: Submission, now: number): Recommendation {
  const filters: Filters = s.filters ?? {}, byId = new Map(catalogue.models.map(m => [m.id, m]));
  const problems: string[] = [], seen = new Set<string>();
  if (!quantities.some(q => (s.workload[q] ?? 0) > 0)) problems.push('The workload is empty: estimate at least one per-task quantity, such as inputTokens and outputTokens, images or audioSeconds.');
  for (const r of s.recommendations) {
    const m = byId.get(r.modelId);
    if (!m) { problems.push(`${r.modelId} is not in the catalogue; use an exact ID from search_models or search_catalogue.`); continue; }
    if (seen.has(m.id)) problems.push(`${m.id} is listed twice.`);
    seen.add(m.id);
    const why = violation(m, filters);
    if (why) problems.push(`${m.id} breaks the hard constraints: ${why}.`);
    // A citation must be this model's own benchmark or leaderboard result.
    const measured = new Set([...m.evidence.map(e => e.benchmark), ...m.boards.map(b => b.board)]);
    const missing = r.evidence.filter(id => !measured.has(id));
    if (missing.length) problems.push(`${m.id} has no results on ${missing.join(', ')}; cite only benchmark or leaderboard IDs from its get_model_details results.`);
  }
  const eligible = catalogue.models.filter(m => violation(m, filters) === null).length;
  if (!problems.length && s.recommendations.length < Math.min(5, eligible)) problems.push(`Recommend five models: ${eligible} models meet the constraints${filters.kind ? '' : ' (set filters.kind when the task needs one kind of model)'}. Cover the quality, cost, latency and recency trade-offs.`);
  if (problems.length) throw new Error(`Shortlist not accepted:\n- ${problems.join('\n- ')}`);

  const names = new Map([...catalogue.benchmarks.map(b => [b.id, b.name] as const), ...catalogue.boards.map(b => [b.id, b.title] as const)]);
  const standing = (id: string, model: string) => {
    const row = standings(catalogue, id).find(x => x.model.id === model);
    return { score: row?.score ?? null, rank: row?.rank ?? 0, of: row?.of ?? 0 };
  };
  const { outputTokens } = s.workload;
  const models = s.recommendations.map((r, i): RecommendedModel => {
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
    const tps = m.speed?.tokensPerSecond, ttft = m.speed?.timeToFirstToken;
    const released = m.releaseDate;
    return {
      rank: i + 1, id: m.id, name: m.name, provider: m.provider, role: r.role, rationale: r.rationale, watchOut: r.watchOut ?? null,
      quality: { score: r.quality, evidence: r.evidence.map(id => ({ benchmark: id, name: names.get(id) ?? id, ...standing(id, m.id) })) },
      cost: best ? { usdPer1kTasks: round(best.usd * 1000, 4), route: best.route.provider, inputPerMillion: best.route.inputPrice, outputPerMillion: best.route.outputPrice,
        rates: best.used.map(x => ({ unit: unitLabels[x.unit], kind: x.kind, amount: x.amount })), unpriced: best.unpriced } : null,
      latency: tps && ttft != null && outputTokens ? { seconds: round(ttft + outputTokens / tps, 1), firstTokenSeconds: round(ttft, 1), tokensPerSecond: Math.round(tps), source: m.speed?.source ?? null } : null,
      recency: released ? { released, ageDays: Math.max(0, Math.floor((now - Date.parse(released)) / 86_400_000)) } : null,
      best: [],
    };
  });
  leaders(models);
  return { kind: 'recommendation', brief: s.brief, summary: s.summary, assumptions: s.assumptions, catalogueVersion: catalogue.version, workload: s.workload, models };
}
