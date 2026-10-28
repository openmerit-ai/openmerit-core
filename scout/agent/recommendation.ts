// The agent's two answers to a turn: clarifying questions about the task brief,
// or a shortlist. The model chooses and justifies; this module checks the choice
// against the catalogue and computes every number shown for cost, latency and
// recency, so a figure on screen always comes from source data.
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import { eligibleEndpoints, blendedPrice, standings, violation, type Catalogue, type Filters } from './catalogue.ts';

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

export const SubmissionSchema = Type.Object({
  brief: BriefSchema,
  filters: Type.Optional(FiltersSchema),
  workload: Type.Object({
    inputTokens: Type.Integer({ minimum: 1, description: 'Estimated input tokens per task, including prompts, documents and images.' }),
    outputTokens: Type.Integer({ minimum: 1, description: 'Estimated output tokens per task, including visible reasoning.' }),
  }),
  summary: Type.String({ description: 'Two or three sentences: the recommendation and the main trade-off.' }),
  assumptions: Type.Array(Type.String(), { description: 'Assumptions you made in place of missing information.' }),
  recommendations: Type.Array(Type.Object({
    modelId: Type.String({ description: 'Model ID from the catalogue tools.' }),
    role: Type.String({ description: 'Short label, such as "Best quality", "Best value", "Fastest", "Newest" or "Balanced".' }),
    quality: Type.Integer({ minimum: 0, maximum: 100, description: 'Your quality estimate for THIS task, from the cited benchmark standings.' }),
    evidence: Type.Array(Type.String(), { description: 'Benchmark IDs (from the tools) this model has results on that support the quality estimate.' }),
    rationale: Type.String({ description: 'One or two sentences on why this model fits the brief.' }),
    watchOut: Type.Optional(Type.String({ description: 'The main risk or limitation.' })),
  }), { minItems: 1, maxItems: 5 }),
});
export type Submission = Static<typeof SubmissionSchema>;

export type Axis = 'quality' | 'cost' | 'latency' | 'recency';
export interface RecommendedModel {
  rank: number; id: string; name: string; provider: string; role: string; rationale: string; watchOut: string | null;
  quality: { score: number; evidence: Array<{ benchmark: string; name: string; score: number; rank: number; of: number }> };
  cost: { usdPer1kTasks: number; inputPerMillion: number; outputPerMillion: number; route: string } | null;
  latency: { seconds: number; firstTokenSeconds: number; tokensPerSecond: number; source: string | null } | null;
  recency: { released: string; ageDays: number } | null;
  best: Axis[];
}
export interface Recommendation {
  kind: 'recommendation'; brief: Brief; summary: string; assumptions: string[]; catalogueVersion: string;
  workload: { inputTokens: number; outputTokens: number }; models: RecommendedModel[];
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
  lead('cost', m => m.cost?.usdPer1kTasks ?? null, false);
  lead('latency', m => m.latency?.seconds ?? null, false);
  lead('recency', m => m.recency ? -m.recency.ageDays : null, true);
}

// Validates a submitted shortlist. Errors are written for the agent, which can
// correct the submission and try again; nothing invalid reaches the user.
export function finalize(catalogue: Catalogue, s: Submission, now: number): Recommendation {
  const filters: Filters = s.filters ?? {}, byId = new Map(catalogue.models.map(m => [m.id, m]));
  const problems: string[] = [], seen = new Set<string>();
  for (const r of s.recommendations) {
    const m = byId.get(r.modelId);
    if (!m) { problems.push(`${r.modelId} is not in the catalogue; use an exact ID from search_models.`); continue; }
    if (seen.has(m.id)) problems.push(`${m.id} is listed twice.`);
    seen.add(m.id);
    const why = violation(m, filters);
    if (why) problems.push(`${m.id} breaks the hard constraints: ${why}.`);
    const measured = new Set(m.evidence.map(e => e.benchmark));
    const missing = r.evidence.filter(id => !measured.has(id));
    if (missing.length) problems.push(`${m.id} has no results on ${missing.join(', ')}; cite only benchmarks from its get_model_details results.`);
  }
  const eligible = catalogue.models.filter(m => violation(m, filters) === null).length;
  if (!problems.length && s.recommendations.length < Math.min(5, eligible)) problems.push(`Recommend five models: ${eligible} models meet the constraints. Cover the quality, cost, latency and recency trade-offs.`);
  if (problems.length) throw new Error(`Shortlist not accepted:\n- ${problems.join('\n- ')}`);

  const names = new Map(catalogue.benchmarks.map(b => [b.id, b.name]));
  const standing = (benchmark: string, id: string) => {
    const row = standings(catalogue, benchmark).find(x => x.model.id === id);
    return { score: row?.observation.score ?? 0, rank: row?.rank ?? 0, of: row?.of ?? 0 };
  };
  const { inputTokens, outputTokens } = s.workload;
  const models = s.recommendations.map((r, i): RecommendedModel => {
    const m = byId.get(r.modelId);
    if (!m) throw new Error('Unreachable: validated above.');
    const route = [...eligibleEndpoints(m, filters)].sort((a, b) => blendedPrice(a) - blendedPrice(b))[0];
    const tps = m.speed?.tokensPerSecond, ttft = m.speed?.timeToFirstToken;
    const released = m.releaseDate;
    return {
      rank: i + 1, id: m.id, name: m.name, provider: m.provider, role: r.role, rationale: r.rationale, watchOut: r.watchOut ?? null,
      quality: { score: r.quality, evidence: r.evidence.map(id => ({ benchmark: id, name: names.get(id) ?? id, ...standing(id, m.id) })) },
      cost: route ? { usdPer1kTasks: round((inputTokens * route.inputPrice + outputTokens * route.outputPrice) / 1000, 4), inputPerMillion: route.inputPrice, outputPerMillion: route.outputPrice, route: route.provider } : null,
      latency: tps && ttft != null ? { seconds: round(ttft + outputTokens / tps, 1), firstTokenSeconds: round(ttft, 1), tokensPerSecond: Math.round(tps), source: m.speed?.source ?? null } : null,
      recency: released ? { released, ageDays: Math.max(0, Math.floor((now - Date.parse(released)) / 86_400_000)) } : null,
      best: [],
    };
  });
  leaders(models);
  return { kind: 'recommendation', brief: s.brief, summary: s.summary, assumptions: s.assumptions, catalogueVersion: catalogue.version, workload: s.workload, models };
}
