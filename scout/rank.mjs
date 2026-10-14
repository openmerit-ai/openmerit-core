import { interpretPrompt, capabilities } from './capabilities.mjs';
import { orderCandidates, benchmarkFamily } from './comparison.mjs';
import { measuredCandidates } from './task-evidence.mjs';
import { providerURL } from './provider-links.mjs';

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
// Workers can freeze the clock during synchronous execution. Zero is not a timing measurement.
const elapsed = start => { const duration = performance.now() - start; return duration > 0 ? Math.max(.01, round(duration)) : null; };
export function selectSnapshot(seed, saved) {
  return (seed.dataVersion ?? 1) > (saved.dataVersion ?? 1) || Date.parse(seed.checkedAt) > Date.parse(saved.checkedAt) || seed.sources.some(source => !saved.sources.some(s => s.id === source.id)) ? seed : saved;
}
export function createIndex(snapshot) {
  if (snapshot.version !== 1 || !snapshot.models?.length) throw new Error('Unsupported Scout index.');
  const benchmarks = new Map(snapshot.benchmarks.map(b => [b.id, b]));
  const counts = new Map();
  for (const model of snapshot.models) for (const e of model.evidence) counts.set(e.benchmark, (counts.get(e.benchmark) ?? 0) + 1);
  const models = snapshot.models.map(model => ({ ...model, evidence: model.evidence.map(e => ({ ...e, cohortSize: counts.get(e.benchmark) })) }));
  return { snapshot, benchmarks, models };
}

export function indexStatus(index, now = Date.now()) {
  const { snapshot, models } = index;
  const providers = new Set(models.map(model => {
    const namespace = model.id.split('/')[0];
    return namespace === 'meta-llama' ? 'meta' : namespace;
  })).size;
  return { checkedAt: snapshot.checkedAt, stale: snapshot.sources.some(s => !s.checkedAt || now - Date.parse(s.checkedAt) > 2 * 3600_000), degraded: snapshot.sources.some(s => s.status === 'failed'),
    benchmarks: snapshot.benchmarks.length, benchmarksWithResults: new Set(models.flatMap(m => m.evidence.map(e => e.benchmark))).size,
    models: models.length, providers, availableModels: snapshot.availableModels, measurements: models.reduce((sum, m) => sum + m.evidence.length, 0),
    sources: snapshot.sources, wordCloud: Object.entries(capabilities).map(([id, c]) => ({ id, label: c.label, keywords: c.terms, benchmarks: snapshot.benchmarks.filter(b => b.tags.includes(id)).length, models: models.filter(m => m.evidence.some(e => index.benchmarks.get(e.benchmark)?.tags.includes(id))).length })), refreshIntervalSeconds: 3600 };
}

// HTTP/MCP provide the same server-interpreted task. Client-supplied task objects
// are never accepted. The keyword path remains available for offline comparison.
export function recommend(index, prompt, now = Date.now(), interpretedTask = null, taskEvidence = undefined) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Describe a task in 1–4,000 characters.');
  const start = performance.now(), task = interpretedTask ?? interpretPrompt(prompt.trim()), status = indexStatus(index, now);
  const warnings = [];
  if (status.stale) warnings.push('Some source data has not refreshed successfully for more than two hours.');
  if (status.degraded) warnings.push(`Source refresh incomplete: ${status.sources.filter(s => s.status === 'failed').map(s => s.name).join(', ')}. Last available evidence is retained with its original timestamps.`);
  if (task.fallback) warnings.push('No specific capability matched. These are general-purpose candidates.');
  if (task.unsupported) return { prompt: prompt.trim(), task, ...status, recommendations: [], warnings: ['Scout covers text responses and visual understanding. It does not rank image, video, audio generation, or transcription models.'], elapsedMs: elapsed(start) };
  const totalWeight = Object.values(task.weights).reduce((a, b) => a + b, 0);
  let candidates = [];
  for (const model of index.models) {
    if (task.needsVision && !model.modalities.includes('image')) continue;
    if (task.needsStructured && !model.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))) continue;
    if ((task.needsTools || task.needsMemory) && !model.parameters.includes('tools')) continue;
    const evidence = model.evidence.map(e => ({ ...e, definition: index.benchmarks.get(e.benchmark) })).filter(e => e.definition && !e.definition.superseded && e.definition.tags.some(t => task.weights[t]));
    const coverage = Object.entries(task.weights).reduce((sum, [tag, weight]) => sum + (evidence.some(e => e.definition.tags.includes(tag)) ? weight : 0), 0) / totalWeight;
    const blendedPrice = (model.inputPrice * 3 + model.outputPrice) / 4; // Compatibility field, no longer scored.
    evidence.sort((a, b) => {
      const weight = e => e.definition.tags.reduce((sum, t) => sum + (task.weights[t] ?? 0), 0);
      return weight(b) - weight(a) || b.cohortSize - a.cohortSize || a.benchmark.localeCompare(b.benchmark);
    });
    // Compact responses must show why each hard evidence requirement was satisfied.
    const requiredTags = [task.needsMemory && 'memory', task.needsTools && 'tools', task.needsVision && task.weights.documents && 'documents'].filter(Boolean);
    const requiredEvidence = [...new Set(requiredTags.map(tag => evidence.find(e => e.definition.tags.includes(tag))).filter(Boolean))];
    evidence.splice(0, evidence.length, ...requiredEvidence, ...evidence.filter(e => !requiredEvidence.includes(e)));
    candidates.push({ model, coverage, blendedPrice, evidence });
  }
  // Direct task observations can establish a capability absent from public feeds.
  // The benchmark fallback still requires explicit document/tool/memory evidence.
  const benchmarkCandidates = candidates.filter(c => c.evidence.length &&
    (!(task.needsVision && task.weights.documents) || c.evidence.some(e => e.definition.tags.includes('documents'))) &&
    (!task.needsTools || c.evidence.some(e => e.definition.tags.includes('tools'))) &&
    (!task.needsMemory || c.evidence.some(e => e.definition.tags.includes('memory'))));
  const benchmarkEligible = benchmarkCandidates.length;
  const measured = measuredCandidates(candidates, task, now, taskEvidence);
  candidates = measured ? measured.candidates : benchmarkCandidates;
  const comparison = orderCandidates(candidates, task);
  const selected = candidates.slice(0, 5);
  if (selected.length < 5) warnings.push(`Only ${selected.length} eligible models have relevant evidence. Scout does not fill gaps with unsupported picks.`);
  if (selected.some(c => c.reference.cost === null)) warnings.push('Measured cost is unavailable for some candidates; unknown charges earn no cost advantage.');
  if (selected.some(c => c.reference.seconds === null)) warnings.push('Reference latency is unavailable for some models; missing measurements earn no speed advantage.');
  if (selected.some(c => c.comparisonCoverage < .8)) warnings.push('Some candidates lack shared benchmarks for all task capabilities. Pairwise comparisons use only overlapping evidence; inspect comparison coverage.');
  if (measured) warnings.push(`Ranked among ${candidates.length} eligible models tested on ${measured.profile.label}, using a separate calibration set. These are representative tasks, not your prompt or a search of every available model. Cost and speed reflect the tested OpenRouter routes and may change.`);
  else warnings.push('Cost and completion time use a disclosed reference workload, not a measured execution of your prompt. Image processing, hidden reasoning, caching and endpoint differences can change actual charges and latency.');
  if (selected.some(c => c.evidence.some(e => e.definition.source === 'openvlm'))) warnings.push(`Some visual evidence comes from OpenVLM’s ${index.snapshot.sources.find(s => s.id === 'openvlm')?.publishedAt ?? 'undated'} snapshot. Newer models may lack comparable document results.`);
  if (task.needsStructured && !measured) warnings.push('JSON support is checked against the model catalogue. Instruction-following benchmarks are a proxy, not a test of your exact schema.');
  if (task.weights.tools) warnings.push('Tool-calling support and relevant evaluations are checked. Reliability still depends on your function definitions, arguments and execution loop.');
  if (task.weights.memory) warnings.push('Memory evidence is BFCL v4 with external key-value, vector and summarization stores. It is not built-in memory or a test of your storage system; newer models without comparable results are excluded when persistent memory is required.');
  if (task.requirements?.memory === 'session') warnings.push('The prompt requires conversation state within a session. This is distinct from persistent-memory benchmarks.');
  if (task.uncertainty?.length) warnings.push(`Some task requirements are uncertain: ${task.uncertainty.join(', ')}. Inspect the interpretation and evaluate the shortlist on your examples.`);
  const recommendations = selected.map((c, i) => {
    const { model } = c;
    const tags = [...new Set(c.evidence.flatMap(e => e.definition.tags).filter(t => task.weights[t]))];
    const families = new Set(c.evidence.map(e => benchmarkFamily(e.definition)));
    const confidence = c.measured ? 'small calibration sample' : c.coverage >= .8 && families.size >= 4 ? 'broader evidence' : 'limited evidence';
    return { rank: i + 1, id: model.id, name: model.name, provider: model.provider, score: round(c.score * 100), quality: round(c.quality * 100),
      evidenceCoverage: round(c.coverage * 100), confidence, reason: c.measured ? `${c.measured.cases} calibration cases: ${round(c.measured.quality * 100)}% mean field accuracy, ${c.measured.validSchema}/${c.measured.cases} valid outputs. ${c.measured.availability ? `Request success across calibration tasks: ${c.measured.availability.successes}/${c.measured.availability.attempts}; repeated failures cap the quality signal. ` : ''}Compared with ${c.comparedModels} tested models. Independent test results are not used in this ranking.` : `${tags.map(t => capabilities[t].label.toLowerCase()).join(', ')}: ${c.evidence.length} results across ${families.size} benchmark families. Compared on shared benchmarks with ${c.comparedModels} eligible models. ${c.reference.seconds !== null ? 'Reference first-answer delay and generation time included.' : 'Reference latency unavailable.'}`,
      pricing: { inputPerMillion: round(model.inputPrice, 4), outputPerMillion: round(model.outputPrice, 4), blendedPerMillion: round(c.blendedPrice, 4), currency: 'USD', basis: '3 input tokens : 1 output token; advertised OpenRouter rates, excluding caching, reasoning and modality-specific charges.', url: providerURL(model.id) },
      measured: c.measured ? { ...c.measured, profile: measured.profile.id, measuredAt: measured.profile.measuredAt, url: measured.profile.url } : null,
      comparison: { comparedModels: c.comparedModels, capabilityCoverage: round(c.comparisonCoverage * 100) },
      reference: { inputTokens: measured ? null : comparison.workload.inputTokens, outputTokens: measured ? null : comparison.workload.outputTokens, costUsd: c.reference.cost === null ? null : round(c.reference.cost, 6), completionSeconds: c.reference.seconds === null ? null : round(c.reference.seconds),
        basis: measured ? 'Mean reported charge and median full request time on the calibration cases, including errors. Unknown charges are excluded from the cost mean and disclosed by costKnownCalls. Not a quote for your prompt.' : 'Illustrative workload; advertised token rates and published first-answer delay + output tokens / throughput. Not an exact task quote or measured endpoint latency.' },
      speed: model.speed, context: model.context, modalities: model.modalities, parameters: model.parameters,
      evidence: c.evidence.map(e => ({ benchmark: e.definition.name, source: e.definition.source, score: round(e.score * 100), metric: e.metric, url: e.url, observedAt: e.observedAt,
        configurations: e.configurations, historical: !!e.historical, urls: e.urls, observedDates: e.observedDates, cohortSize: e.cohortSize })),
    };
  });
  return { prompt: prompt.trim(), task, ...status, eligibleModels: candidates.length, recommendations, warnings,
    ranking: { version: '3', mode: measured ? 'measured' : 'benchmarks', profile: measured?.profile ?? null, benchmarkEligibleModels: benchmarkEligible, workload: comparison.workload, weights: comparison.weights, eligibleModels: candidates.length },
    methodology: measured ? `Typed task match → calibration-only field accuracy, reported cost and full request time → strongest pairwise preferences without cycles → ordered top five among tested eligible models. Weights: ${comparison.weights.quality * 100}% quality, ${comparison.weights.cost * 100}% cost, ${comparison.weights.latency * 100}% latency. Small-sample evidence, not predicted accuracy on your task.` : `${task.interpreter === 'openai-decisions' ? 'OpenAI Decisions task interpretation' : 'Capability vocabulary'} → compare candidates on the same benchmarks, grouped by family → task-shaped reference cost and completion time → strongest pairwise preferences without cycles → ordered top five. Weights: ${Math.round(comparison.weights.quality * 100)}% quality, ${Math.round(comparison.weights.cost * 100)}% cost, ${Math.round(comparison.weights.latency * 100)}% latency. Scores are ranking signals, not predicted accuracy.`, elapsedMs: elapsed(start) };
}
