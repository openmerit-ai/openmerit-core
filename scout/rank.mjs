import { labels, registry as defaultRegistry } from './registry.mjs';
import { attachSearch } from './search-index.mjs';
import { orderCandidates, benchmarkFamily } from './comparison.mjs';
import { measuredCandidates,attachTaskObservations } from './task-evidence.mjs';
import { providerURL } from './provider-links.mjs';
import { describeSources, calibrationStatus } from './source-details.mjs';
import { recommendationID, contractModels, expandEndpoints, endpointSupports, bestEndpointPerModel, specializedKinds, taskEndpointResult } from './endpoints.mjs';
import { discoverSpecialists } from './huggingface.mjs';
import { selectPareto } from './pareto.mjs';

const round = (value, places = 2) => Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null;
// Workers can freeze the clock during synchronous execution. Zero is not a timing measurement.
const elapsed = start => { const duration = performance.now() - start; return duration > 0 ? Math.max(.01, round(duration)) : null; };
const staleSources = (snapshot, now) => snapshot.sources.some(s => {
  if (s.refreshPolicy === 'manual-contract-review') return false;
  const hours = s.maxAgeHours ?? snapshot.registry?.policy.maxSourceAgeHours ?? defaultRegistry.policy.maxSourceAgeHours;
  return !Number.isFinite(Date.parse(s.checkedAt)) || now - Date.parse(s.checkedAt) > hours * 3600_000;
});
export function selectSnapshot(seed, saved) {
  return (seed.dataVersion ?? 1) > (saved.dataVersion ?? 1) || Date.parse(seed.checkedAt) > Date.parse(saved.checkedAt) || seed.sources.some(source => !saved.sources.some(s => s.id === source.id)) ? seed : saved;
}
export function createIndex(snapshot) {
  if (snapshot.version !== 1 || (!snapshot.models?.length && !snapshot.publicStatus)) throw new Error('Unsupported Scout index.');
  const benchmarks = new Map(snapshot.benchmarks.map(b => [b.id, b]));
  const counts = new Map();
  for (const model of snapshot.models) for (const e of model.evidence) counts.set(e.benchmark, (counts.get(e.benchmark) ?? 0) + 1);
  const models = snapshot.models.map(model => ({ ...model, evidence: model.evidence.map(e => ({ ...e, cohortSize: counts.get(e.benchmark) })) }));
  const interpreted = snapshot.benchmarks.filter(b => b.interpretation);
  const benchmarkInterpretation = { version: interpreted[0]?.interpretation.version ?? null, prepared: interpreted.filter(b => b.interpretation.status === 'ready').length,
    classified: interpreted.filter(b => b.interpretation.status === 'ready' && b.tags.length).length, unclassified: interpreted.filter(b => b.interpretation.status === 'ready' && !b.tags.length).length,
    unavailable: interpreted.filter(b => b.interpretation.status === 'unavailable').length };
  const index = { snapshot, benchmarks, models, benchmarkInterpretation };
  index.cachedStatus = snapshot.publicStatus ?? computeIndexStatus(index);
  return snapshot.servingEngine==='evidence'?index:attachSearch(index);
}

function computeIndexStatus(index, now = Date.now()) {
  const capabilities = labels(index.snapshot.registry ?? defaultRegistry);
  const { snapshot, models } = index;
  const providers = new Set(models.map(model => {
    const namespace = model.id.split('/')[0];
    return namespace === 'meta-llama' ? 'meta' : namespace;
  })).size;
  return { checkedAt: snapshot.checkedAt, stale: staleSources(snapshot, now), degraded: snapshot.sources.some(s => s.status === 'failed'),
    benchmarks: snapshot.benchmarks.length, benchmarksWithResults: new Set(models.flatMap(m => m.evidence.map(e => e.benchmark))).size, benchmarkInterpretation: index.benchmarkInterpretation,
    models: models.length, providers, endpoints: (snapshot.catalogue ?? models).reduce((n, m) => n + (m.endpoints?.length ?? 1), 0) + contractModels().length, independentModels: (snapshot.catalogue ?? []).filter(m => m.endpoints?.some(e => e.source !== 'models')).length, availableModels: snapshot.availableModels, measurements: models.reduce((sum, m) => sum + m.evidence.length, 0),
    sources: describeSources(index), calibration: calibrationStatus(now), specialistRepositories: snapshot.specialists?.length ?? 0, wordCloud: Object.entries(capabilities).map(([id, c]) => ({ id, label: c.label, keywords: c.terms, benchmarks: snapshot.benchmarks.filter(b => b.tags.includes(id)).length, models: models.filter(m => m.evidence.some(e => index.benchmarks.get(e.benchmark)?.tags.includes(id))).length })), refreshIntervalSeconds: 3600 };
}

export function indexStatus(index, now = Date.now()) {
  const status = index.cachedStatus ?? computeIndexStatus(index, now);
  return { ...status, calibration: calibrationStatus(now), stale: staleSources(index.snapshot, now), degraded: index.snapshot.sources.some(s=>s.status==='failed') };
}

// HTTP/MCP provide the same server-interpreted task. Client-supplied task objects
// are never accepted. Every search uses the same semantic task contract.
export function recommend(index, prompt, now = Date.now(), interpretedTask = null, taskEvidence = undefined, modelIds = null, endpointIds = null) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Describe a task in 1–4,000 characters.');
  if (!interpretedTask) throw new Error('Scout requires semantic task interpretation.');
  const capabilities = labels(index.snapshot.registry ?? defaultRegistry);
  const start = performance.now(), task = interpretedTask, status = indexStatus(index, now);
  const warnings = [];
  if (status.stale) warnings.push('Some source data is overdue for its refresh policy.');
  if (status.degraded) warnings.push(`Source refresh incomplete: ${status.sources.filter(s => s.status === 'failed').map(s => s.name).join(', ')}. Last available evidence is retained with its original timestamps.`);
  if (task.fallback) warnings.push('No specific capability matched. These are general-purpose candidates.');
  if (task.specialistMatch?.status === 'unavailable') warnings.push('Specialist compatibility could not be checked. Hugging Face candidates are omitted for this search.');
  if (task.unsupported) return { prompt: prompt.trim(), task, ...status, selection: { modelIds, endpointIds }, recommendations: [], warnings: ['Scout covers text responses and visual understanding. It does not rank image, video, audio generation, or transcription models.'], elapsedMs: elapsed(start) };
  if (task.clarification) return { prompt: prompt.trim(), task, ...status, selection: { modelIds, endpointIds }, recommendations: [], specialists: { candidates: [] }, warnings: [task.clarification.question], ranking: { version: '6', mode: 'clarification', profile: null }, elapsedMs: elapsed(start) };
  // Open or uncertain identification needs name-generating endpoints and relevant
  // evidence, not the automatic task-fit advantage given to fixed-choice APIs.
  const openIdentification = task.kind === 'classify' && task.labelSpace !== 'supplied';
  const typedTask = specializedKinds.has(task.kind) && !openIdentification && !task.needsTools && !task.needsMemory;
  if (typedTask && (task.servingEngine !== 'evidence' || ['detect','segment'].includes(task.kind))) return taskEndpointResult(index, prompt, task, modelIds, status, endpointIds);
  if (openIdentification) warnings.push('No supplied answer-label set was established. Ranked generative endpoints using relevant public evidence; fixed-choice APIs and label-dependent classifiers are excluded. These benchmarks do not establish accuracy on the specific identities in your task.');
  const totalWeight = Object.values(task.weights).reduce((a, b) => a + b, 0);
  let candidates = [];
  for (const model of expandEndpoints(index.models, index.snapshot.checkedAt, modelIds !== null)) {
    if (endpointIds !== null && !endpointIds.includes(model.endpoint.id)) continue;
    if (modelIds !== null && !modelIds.includes(model.id)) continue;
    if (!endpointSupports(model, task)) continue;
    const evidence = model.evidence.map(e => ({ ...e, definition: index.benchmarks.get(e.benchmark) })).filter(e => e.definition && !e.definition.superseded && (task.evidenceMatch?task.evidenceMatch.ids.includes(e.benchmark):e.definition.tags.some(t => task.weights[t])));
    const coverage = Object.entries(task.weights).reduce((sum, [tag, weight]) => sum + (evidence.some(e => e.definition.tags.includes(tag)) ? weight : 0), 0) / totalWeight;
    const blendedPrice = Number.isFinite(model.inputPrice) && Number.isFinite(model.outputPrice) ? (model.inputPrice * 3 + model.outputPrice) / 4 : null; // Compatibility field, no longer scored.
    evidence.sort((a, b) => {
      if(task.evidenceMatch){const assessment=id=>task.evidenceMatch.assessments.find(e=>e.benchmark===id)?.applicability;const direct=id=>assessment(id)==='direct'?2:assessment(id)==='proxy'?1:0;const delta=direct(b.benchmark)-direct(a.benchmark);if(delta)return delta;}
      const weight = e => e.definition.tags.reduce((sum, t) => sum + (task.weights[t] ?? 0), 0);
      return weight(b) - weight(a) || b.cohortSize - a.cohortSize || a.benchmark.localeCompare(b.benchmark);
    });
    // Compact responses must show why each hard evidence requirement was satisfied.
    const requiredTags = [task.needsMemory && 'memory', task.needsTools && 'tools', task.needsVision && (task.weights.documents ? 'documents' : 'vision')].filter(Boolean);
    const requiredEvidence = [...new Set(requiredTags.map(tag => evidence.find(e => e.definition.tags.includes(tag))).filter(Boolean))];
    evidence.splice(0, evidence.length, ...requiredEvidence, ...evidence.filter(e => !requiredEvidence.includes(e)));
    candidates.push({ model, coverage, blendedPrice, evidence,preference:task.preferenceScores?.[model.endpoint.id]??0 });
  }
  // Direct task observations can establish a capability absent from public feeds.
  // The benchmark fallback still requires explicit document/tool/memory evidence.
  if(task.servingEngine==='evidence')attachTaskObservations(candidates,task,now,taskEvidence);
  const benchmarkCandidates = candidates.filter(c => c.evidence.length &&
    (!task.needsVision || c.evidence.some(e => e.definition.tags.includes(task.weights.documents ? 'documents' : 'vision'))) &&
    (!task.needsTools || c.evidence.some(e => e.definition.tags.includes('tools'))) &&
    (!task.needsMemory || c.evidence.some(e => e.definition.tags.includes('memory'))));
  const benchmarkEligible = task.servingEngine==='evidence'?new Set(benchmarkCandidates.map(c=>c.model.id)).size:benchmarkCandidates.length;
  const measured = task.servingEngine==='evidence'?null:measuredCandidates(candidates, task, now, taskEvidence);
  candidates = measured ? measured.candidates : task.servingEngine==='evidence'?benchmarkCandidates:bestEndpointPerModel(benchmarkCandidates, task);
  // Contract compatibility cannot outrank measured evidence merely because an
  // endpoint has a native label/decision API. Preserve an explicitly unmeasured
  // shortlist only when no comparable benchmark candidates can be established.
  if (!candidates.length && typedTask) return taskEndpointResult(index, prompt, task, modelIds, status, endpointIds);
  const eligibleModels=new Set(candidates.map(c=>c.model.id)).size;
  const comparison = task.servingEngine==='evidence'?selectPareto(candidates,task):orderCandidates(candidates, task);
  if(comparison.frontier)warnings.push(comparison.frontier.qualityGate.status==='proxy-qualified'
    ? 'Lowest estimated cost first within two proxy-score points of the strongest model in each comparable evaluation scope. This is a relative evidence policy, not proof of sufficient quality or a requested accuracy target on your task.'
    : 'No comparable quality cohort can qualify these candidates. This is an unverified discovery shortlist ordered by known estimated cost, not a claim that the models meet your required quality.');
  if(comparison.frontier?.scope==='partial')warnings.push('The frontier is provisional: some configurations have missing objectives or incomparable evaluation coverage. No global three-objective frontier is established.');
  const selected = [], selectedIDs = new Set();
  for (const c of candidates) { if (selectedIDs.has(c.model.id)) continue; selectedIDs.add(c.model.id); selected.push(c); if (selected.length === 5) break; }
  if (selected.length < 5) warnings.push(comparison.frontier?`${selected.length} distinct models remain after eligibility and supported frontier selection. Scout does not fill gaps with dominated or unsupported picks.`:`Only ${selected.length} eligible models have relevant evidence. Scout does not fill gaps with unsupported picks.`);
  if (selected.some(c => c.reference.cost === null)) warnings.push('Measured cost is unavailable for some candidates; unknown charges earn no cost advantage.');
  if (selected.some(c => c.reference.seconds === null)) warnings.push('Reference latency is unavailable for some models; missing measurements earn no speed advantage.');
  if (selected.some(c => c.comparisonCoverage < .8)) warnings.push('Some candidates lack shared benchmarks for all task capabilities. Pairwise comparisons use only overlapping evidence; inspect comparison coverage.');
  if (measured) warnings.push(`Ranked among ${candidates.length} eligible models tested on ${measured.profile.label}, using a separate calibration set. These are representative tasks, not your prompt or a search of every available model. ${measured.profile.qualityBasis} Cost and speed reflect the tested OpenRouter routes and may change.`);
  else warnings.push('Cost and completion time use a disclosed reference workload, not a measured execution of your prompt. Image processing, hidden reasoning, caching and endpoint differences can change actual charges and latency.');
  if (selected.some(c => c.evidence.some(e => e.definition.source === 'openvlm'))) warnings.push(`Some visual evidence comes from OpenVLM’s ${index.snapshot.sources.find(s => s.id === 'openvlm')?.publishedAt ?? 'undated'} snapshot. Newer models may lack comparable document results.`);
  if (task.needsStructured && !measured) warnings.push('JSON support is checked against the model catalogue. Instruction-following benchmarks are a proxy, not a test of your exact schema.');
  if (task.weights.tools) warnings.push('Tool-calling support and relevant evaluations are checked. Reliability still depends on your function definitions, arguments and execution loop.');
  if (task.weights.memory && !measured) warnings.push('Memory evidence is BFCL v4 with external key-value, vector and summarization stores. It is not built-in memory or a test of your storage system; newer models without comparable results are excluded when persistent memory is required.');
  if (task.requirements?.memory === 'session') warnings.push('The prompt requires conversation state within a session. This is distinct from persistent-memory benchmarks.');
  if (task.uncertainty?.length) warnings.push(`Some task requirements are uncertain: ${task.uncertainty.join(', ')}. Inspect the interpretation and evaluate the shortlist on your examples.`);
  const recommendations = selected.map((c, i) => {
    const { model } = c;
    const tags = [...new Set(c.evidence.flatMap(e => e.definition.tags).filter(t => task.weights[t]))];
    const families = new Set(c.evidence.map(e => benchmarkFamily(e.definition)));
    const confidence = c.measured ? 'small calibration sample' : c.coverage >= .8 && families.size >= 4 ? 'broader evidence' : 'limited evidence';
    return { rank: i + 1, id: recommendationID(model), modelId: model.id, name: model.name, provider: model.provider, endpoint: model.endpoint, score: round(c.score * 100), quality: c.quality===null?null:round(c.quality * 100),
      evidenceCoverage: round(c.coverage * 100), confidence, reason: c.measured ? `${c.measured.cases} calibration cases: ${round(c.measured.quality * 100)}% mean task-check accuracy, ${c.measured.validSchema}/${c.measured.cases} usable outputs. ${c.measured.availability ? `Request success across calibration tasks: ${c.measured.availability.successes}/${c.measured.availability.attempts}; repeated failures cap the quality signal. ` : ''}Compared with ${c.comparedModels} tested models. Independent test results are not used in this ranking.` : `${tags.map(t => (capabilities[t]?.label ?? t).toLowerCase()).join(', ')}: ${c.evidence.length} results across ${families.size} benchmark families. Compared on shared benchmarks with ${c.comparedModels} eligible models. ${c.reference.seconds !== null ? 'Reference first-answer delay and generation time included.' : 'Reference latency unavailable.'}`,
      pricing: { inputPerMillion: round(model.inputPrice, 4), outputPerMillion: round(model.outputPrice, 4), blendedPerMillion: round(c.blendedPrice, 4), currency: 'USD', basis: model.endpoint?.pricingBasis ?? 'Advertised token rates; excludes caching, reasoning and modality-specific charges.', url: model.endpoint?.url ?? providerURL(model.id) },
      measured: c.measured ? { ...c.measured, profile: measured.profile.id, measuredAt: measured.profile.measuredAt, url: measured.profile.url } : null,
      comparison: { comparedModels: c.comparedModels, capabilityCoverage: round(c.comparisonCoverage * 100) },
      reference: { inputTokens: measured ? null : comparison.workload.inputTokens, outputTokens: measured ? null : comparison.workload.outputTokens, costUsd: c.reference.cost === null ? null : round(c.reference.cost, 6), completionSeconds: c.reference.seconds === null ? null : round(c.reference.seconds),
        basis: measured ? 'Mean reported charge and median full task time on the calibration cases, including errors. Unknown charges are excluded from the cost mean and disclosed by costKnownCalls. Not a quote for your prompt.' : 'Illustrative workload; advertised token rates and published first-answer delay + output tokens / throughput. Not an exact task quote or measured endpoint latency.' },
      speed: model.speed, context: model.context, metadata: {facts:model.facts??[]},modalities: model.modalities, parameters: model.parameters,
      evidence: c.evidence.map(e => ({ benchmark: e.definition.name, source: e.definition.source, score: round(e.score * 100), metric: e.metric, url: e.url, observedAt: e.observedAt,
        capabilities: e.definition.tags, family: benchmarkFamily(e.definition), interpretation: e.definition.interpretation ? { version: e.definition.interpretation.version, preparedAt: e.definition.interpretation.preparedAt } : null,
        configurations: e.configurations, historical: !!e.historical, urls: e.urls, observedDates: e.observedDates, cohortSize: e.cohortSize })),
    };
  });
  return { prompt: prompt.trim(), task, ...status, selection: { modelIds, endpointIds }, eligibleModels, recommendations, specialists: modelIds === null && endpointIds === null ? discoverSpecialists(index.snapshot, task, prompt, selected) : { candidates: [], reason: 'Specialist discovery is outside the selected endpoint inventory.' }, warnings,
    ranking: { version: comparison.frontier?'9':'6', mode: measured ? 'measured' : 'benchmarks', profile: measured?.profile ?? null, benchmarkEligibleModels: benchmarkEligible, workload: comparison.workload, weights: comparison.weights, eligibleModels,...(comparison.frontier?{frontier:comparison.frontier}:{}) },
    methodology: comparison.frontier?'Structured task interpretation → exact documented restrictions → semantic evidence retrieval and applicability → two-point quality band within common evaluation scopes → supported Pareto selection → lowest known reference cost first, latency on price ties. Missing objectives and incomparable scopes remain provisional. Up to five distinct models; no verified task-accuracy threshold.':measured ? `Typed task match → calibration-only task-check accuracy, reported cost and full request time → strongest pairwise preferences without cycles → ordered top five among tested eligible models. Weights: ${comparison.weights.quality * 100}% quality, ${comparison.weights.cost * 100}% cost, ${comparison.weights.latency * 100}% latency. Small-sample evidence, not predicted accuracy on your task.` : `${task.interpreter === 'openai-decisions' ? 'OpenAI Decisions task interpretation' : 'Capability vocabulary'} → compare candidates on the same benchmarks, grouped by family → task-shaped reference cost and completion time → strongest pairwise preferences without cycles → ordered top five. Weights: ${Math.round(comparison.weights.quality * 100)}% quality, ${Math.round(comparison.weights.cost * 100)}% cost, ${Math.round(comparison.weights.latency * 100)}% latency. Scores are ranking signals, not predicted accuracy.`, elapsedMs: elapsed(start) };
}
