import contracts from './endpoint-contracts.json' with { type: 'json' };
import { referenceWork, workloadFor } from './comparison.mjs';
import { specialistMatch, relevantProfiles } from './specialists.mjs';
import { routerEndpoint, textOutputOnly } from './catalogue.mjs';
import { metadataAllows } from './eligibility.mjs';

// Legacy IDs continue to identify router routes. New protocols have distinct
// catalogue IDs so older agent clients cannot execute a different route silently.
export const recommendationID = model => model.endpoint?.source === 'models' ? model.id : `${model.id}:${model.endpoint.protocol}`;
export const specializedKinds = new Set(['classify', 'judge', 'detect', 'segment']);
// Reviewed contracts plus the decision routes each refresh reads from the catalogue (snapshot.contracts).
// Decision-leaderboard standing attaches by canonical ID; a reviewed contract's own ID
// ("typesafe/jev-1.14.0") falls back to the one canonical model whose ID ends in its model ID.
export function contractModels(snapshot = null) {
  const scores = snapshot?.decisionScores ?? {}, byTail = new Map();
  for (const id of Object.keys(scores)) { const tail = id.split('/').pop(); byTail.set(tail, byTail.has(tail) ? null : scores[id]); }
  return [...contracts.entries.map(e => ({ ...e, checkedAt: contracts.reviewedAt })), ...(snapshot?.contracts ?? [])].map(e => ({ id: e.model, name: e.name, provider: e.provider, modalities: e.modalities, parameters: e.parameters, context: e.context ?? null,
    inputPrice: e.inputPrice, outputPrice: e.outputPrice, evidence: [], speed: null, decisionScore: scores[e.model] ?? byTail.get(e.modelId) ?? null,
    endpoint: { ...e, deployment: 'hosted', configuration: 'fixed typed questions' } }));
}
export function expandEndpoints(models, checkedAt, scoped = false) {
  return models.flatMap(model => (model.endpoints?.length ? model.endpoints : [routerEndpoint(model, checkedAt)])
    // Existing modelIds inventories refer to the legacy router IDs. They must
    // never grant access to an unrelated provider credential implicitly.
    .filter(e => !scoped || e.source === 'models')
    .map(endpoint => ({ ...model, endpoint, inputPrice: endpoint.inputPrice, outputPrice: endpoint.outputPrice,
      modalities: endpoint.modalities, outputModalities: endpoint.outputModalities, parameters: endpoint.parameters,
      context: endpoint.context ?? null,
      // Endpoint-bound timing wins. Unbound model-level measurements apply to
      // every route as a labelled fallback; timing bound to another route never migrates.
      speed: model.speed?.endpointId === endpoint.id ? { ...model.speed, scope: 'endpoint' } : model.speed && !model.speed.endpointId ? { ...model.speed, scope: 'model' } : null })));
}
export function hubEndpointModels(snapshot, task, _prompt) {
  const relevant = new Set(relevantProfiles(snapshot.specialistProfiles ?? [], task).map(p => p.id));
  if (task.kind === 'classify' && task.labelSpace !== 'supplied') return [];
  const pipelines = task.kind === 'classify' && task.needsVision ? ['zero-shot-image-classification', 'image-classification'] : task.kind === 'detect' ? ['zero-shot-object-detection', 'object-detection'] : task.kind === 'segment' ? ['image-segmentation', 'mask-generation'] : [];
  return (snapshot.specialists ?? []).filter(m => pipelines.includes(m.pipeline) && relevant.has(m.semantic?.profileId) && specialistMatch(m, task)).map(m => {
    const zeroShot = m.pipeline.startsWith('zero-shot-');
    const fit = zeroShot ? 3 : 2;
    const id = `huggingface/${m.id}`;
    return { id, name: m.id.split('/')[1], provider: m.id.split('/')[0], repository: m.id, modalities: ['image'], parameters: [], context: null,
      inputPrice: null, outputPrice: null, evidence: [], speed: null, fit,
      endpoint: { id: `huggingface:local:${m.id}:${m.revision}`, provider: 'Self-hosted', modelId: m.id, protocol: m.pipeline, api: null,
        operations: [task.kind], deployment: 'self-hosted', configuration: m.revision, source: 'huggingface', checkedAt: m.checkedAt, url: m.url,
        status: m.gated ? 'gated' : 'weights available', license: m.license, licenseURL: m.licenseURL, library: m.library,
        labelMode: zeroShot ? 'supplied' : 'fixed-or-prompted', matchedLabels: [], cardURL: m.cardURL,
        semanticProfile: m.semantic, semanticMatch: specialistMatch(m, task),
        reportedEvaluations: m.evaluations, listedHosts: m.providers,
        limits: zeroShot ? 'Supply candidate labels; accuracy, hardware cost and latency need evaluation.' : 'Semantic metadata compatibility is not measured accuracy. Check required point/box prompts and evaluate the trained vocabulary.',
        pricingBasis: 'Self-hosted deployment: compute and operational costs unknown; not free inference.' } };
  });
}
// Shared hard requirements for benchmark, measured and task-fit candidates.
// Source normalization happens during refresh; matching only reads prepared facts.
export function endpointSupports(model, task) {
  const e = model.endpoint;
  if (!metadataAllows(task,e.id)) return false;
  if (e.operations ? !e.operations.includes(task.kind) : !textOutputOnly(model.outputModalities)) return false;
  if (task.kind === 'classify' && e.operations && task.labelSpace !== 'supplied' && e.labelMode !== 'open') return false;
  if (task.needsVision && !model.modalities?.includes('image')) return false;
  if (task.needsStructured && !model.parameters?.some(p => ['structured_outputs', 'response_format'].includes(p))) return false;
  if ((task.needsTools || task.needsMemory) && !model.parameters?.includes('tools')) return false;
  if (task.kind === 'detect' && e.detection === 'single-box' && task.outputCardinality !== 'single') return false;
  return true;
}
export function endpointFit(model, task) {
  const e = model.endpoint;
  if (!endpointSupports(model, task)) return 0;
  if (task.needsTools || task.needsMemory) return 0;
  if (e.operations) return model.fit ?? 3;
  // Ordinary generative APIs can return labels; they do not become object
  // detectors or segmentation engines just because they accept image input.
  return ['classify', 'judge'].includes(task.kind) ? 2 : 0;
}
// Decision-leaderboard standing only breaks ties at equal reference cost (decision rates
// cluster at a few prices); a model without results sorts after those with them.
function compareRoute(a, b, priority) {
  return (priority === 'latency' ? (a.reference.seconds ?? Infinity) - (b.reference.seconds ?? Infinity) : 0) ||
    (a.reference.cost ?? Infinity) - (b.reference.cost ?? Infinity) ||
    (b.model.decisionScore?.quality ?? -1) - (a.model.decisionScore?.quality ?? -1) ||
    (a.reference.seconds ?? Infinity) - (b.reference.seconds ?? Infinity) || a.model.endpoint.id.localeCompare(b.model.endpoint.id);
}
export function orderTaskEndpoints(models, task) {
  const workload = workloadFor(task);
  const candidates = models.map(model => ({ model, fit: endpointFit(model, task), reference: referenceWork(model, workload) })).filter(c => c.fit > 0);
  // This is a suitability shortlist, NOT a quality prediction. Compare known
  // cost/time only within the same contract-fit tier. Unknown never means zero.
  candidates.sort((a, b) => b.fit - a.fit || Number(b.model.endpoint.deployment === 'hosted') - Number(a.model.endpoint.deployment === 'hosted') || compareRoute(a, b, workload.priority));
  const chosen = [], seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.model.id)) continue;
    seen.add(c.model.id); chosen.push(c);
    if (chosen.length === 5) break;
  }
  return { candidates, selected: chosen, workload };
}

export function taskEndpointResult(index, prompt, task, modelIds, status, endpointIds = null) {
  const scoped = modelIds !== null;
  const inventory = (index.snapshot.catalogue ?? index.models).filter(m => !scoped || modelIds.includes(m.id));
  const models = expandEndpoints(inventory, index.snapshot.checkedAt, scoped);
  if (!scoped) models.push(...contractModels(index.snapshot), ...hubEndpointModels(index.snapshot, task, prompt));
  const { candidates, selected, workload } = orderTaskEndpoints(models.filter(m => endpointIds === null || endpointIds.includes(m.endpoint.id)), task);
  const recommendations = selected.map(({ model: m, fit, reference }, i) => ({
    rank: i + 1, id: recommendationID(m), modelId: m.id, name: m.name, provider: m.provider, endpoint: m.endpoint,
    score: null, quality: null, measured: null, confidence: 'task fit; quality unmeasured', evidenceCoverage: 0,
    reason: `${fit === 3 ? 'Native task contract' : fit === 2 ? 'Compatible output with adaptation' : 'Pipeline match; input requirements need verification'}. ${m.endpoint.limits ?? 'Generative output requires validation against your allowed labels.'}${m.decisionScore ? ` Decision leaderboards: ${m.decisionScore.results.map(r => `${r.title} ${Math.round(r.score * 10) / 10} (ahead of ${Math.round(r.percentile * 100)}%)`).join('; ')}.` : ''}`,
    taskFit: { tier: fit, operation: task.kind, output: task.outputContract, basis: 'Documented endpoint contract or pinned pipeline metadata, not measured quality.' },
    pricing: { inputPerMillion: m.inputPrice ?? null, outputPerMillion: m.outputPrice ?? null, currency: 'USD', basis: m.endpoint.pricingBasis, url: m.endpoint.url },
    reference: { inputTokens: workload.inputTokens, outputTokens: m.endpoint.protocol === 'decisions' ? 0 : workload.outputTokens, costUsd: reference.cost, completionSeconds: reference.seconds,
      basis: 'Illustrative token workload only. No measured quality or endpoint latency; image encoding and self-hosted hardware costs can differ.' },
    decisionBenchmarks: m.decisionScore?.results ?? [],
    speed: null, context: m.context, metadata:{facts:m.facts??[]},modalities: m.modalities, parameters: m.parameters, evidence: [], comparison: { comparedModels: 0, capabilityCoverage: 0 },
  }));
  return { prompt: prompt.trim(), task, ...status, selection: { modelIds, endpointIds }, eligibleModels: candidates.length, recommendations,
    specialists: { candidates: [], reason: 'Compatible specialist deployment options are considered in this task shortlist.' },
    warnings: [
      ...(task.specialistMatch?.status === 'unavailable' ? ['Specialist compatibility could not be checked. Hugging Face candidates are omitted for this search.'] : []),
      'Ordered by documented task/output fit, deployment readiness, then known reference cost and speed within a fit tier. Comparable task-quality measurements are not available for these endpoints; this is a shortlist to evaluate, not a proven performance ranking.',
      'Unknown prices and latency remain unknown. Model-card results and general reasoning benchmarks do not establish accuracy on this task.',
      ...(selected.some(c => c.model.decisionScore) ? ['Between options with the same reference cost, decision-model leaderboard standing (JevBench capability, Artificial Analysis Decision Index) breaks the tie. Those boards measure general typed decisions, not accuracy on this task; options without results come after.'] : []),
      ...(selected.length < 5 ? [`Only ${selected.length} compatible options were found; Scout does not fill the list with unsupported endpoints.`] : []),
      ...(task.needsVision ? ['Image tokenization differs across providers. Reference costs are not per-image quotes. Check fixed label sets and required prompts before deployment.'] : []),
      ...(selected.some(c => c.model.endpoint.imageExperimental && task.needsVision) ? ['Some image endpoints are experimental; their status and required headers are shown in endpoint details.'] : []),
      ...(selected.some(c => c.model.endpoint.deployment === 'self-hosted') ? ['Self-hosted weights require compatible hardware and a serving runtime. Their inference cost is not zero.'] : []),
      ...(status.degraded ? ['A source refresh failed; previous metadata is retained with original timestamps.'] : []),
    ],
    ranking: { version: '6', mode: 'task-fit', profile: null, eligibleModels: candidates.length, workload, weights: null },
    methodology: 'Task operation and output contract → eligible hosted endpoints and specialist deployments → contract fit and deployment readiness → known cost, with decision-leaderboard standing breaking equal-cost ties → speed. Task quality remains unknown until comparable task evaluations exist.', elapsedMs: null };
}

export function bestEndpointPerModel(candidates, task) {
  const groups = new Map(), workload = workloadFor(task);
  for (const c of candidates) {
    const group = groups.get(c.model.id) ?? [];
    group.push({ candidate: c, model: c.model, reference: referenceWork(c.model, workload) }); groups.set(c.model.id, group);
  }
  return [...groups.values()].map(group => group.sort((a, b) => compareRoute(a, b, workload.priority))[0].candidate);
}
