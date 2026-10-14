import { interpretPrompt, capabilities } from './capabilities.mjs';

const family = name => name.toLowerCase().replace(/ · aa$/, '').replace(/^(aime|gpqa|mmlu|swe.bench|terminal.bench|ocrbench|mmmu|ifbench|tau|τ).*$/, '$1');
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
// Workers can freeze the clock during synchronous execution. Zero is not a timing measurement.
const elapsed = start => { const duration = performance.now() - start; return duration > 0 ? Math.max(.01, round(duration)) : null; };
export function createIndex(snapshot) {
  if (snapshot.version !== 1 || !snapshot.models?.length) throw new Error('Unsupported Scout index.');
  const benchmarks = new Map(snapshot.benchmarks.map(b => [b.id, b]));
  const distributions = new Map();
  for (const model of snapshot.models) for (const e of model.evidence) {
    const values = distributions.get(e.benchmark) ?? []; values.push(e.score); distributions.set(e.benchmark, values);
  }
  for (const values of distributions.values()) values.sort((a, b) => a - b);
  const models = snapshot.models.map(model => ({ ...model, evidence: model.evidence.map(e => {
    const values = distributions.get(e.benchmark);
    const below = values.filter(v => v < e.score).length, tied = values.filter(v => v === e.score).length;
    // Mid-rank percentile, shrunk toward neutral when the comparison set is small.
    const percentile = (below + tied / 2) / values.length;
    return { ...e, relativeQuality: .5 + (percentile - .5) * Math.min(1, values.length / 8), cohortSize: values.length };
  }) }));
  return { snapshot, benchmarks, models };
}

export function indexStatus(index, now = Date.now()) {
  const { snapshot, models } = index;
  return { checkedAt: snapshot.checkedAt, stale: snapshot.sources.some(s => !s.checkedAt || now - Date.parse(s.checkedAt) > 2 * 3600_000), degraded: snapshot.sources.some(s => s.status === 'failed'),
    benchmarks: snapshot.benchmarks.length, benchmarksWithResults: new Set(models.flatMap(m => m.evidence.map(e => e.benchmark))).size,
    models: models.length, availableModels: snapshot.availableModels, measurements: models.reduce((sum, m) => sum + m.evidence.length, 0),
    sources: snapshot.sources, wordCloud: Object.entries(capabilities).map(([id, c]) => ({ id, label: c.label, keywords: c.terms, benchmarks: snapshot.benchmarks.filter(b => b.tags.includes(id)).length, models: models.filter(m => m.evidence.some(e => index.benchmarks.get(e.benchmark)?.tags.includes(id))).length })), refreshIntervalSeconds: 3600 };
}

export function recommend(index, prompt, now = Date.now()) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Describe a task in 1–4,000 characters.');
  const start = performance.now(), task = interpretPrompt(prompt.trim()), status = indexStatus(index, now);
  const warnings = [];
  if (status.stale) warnings.push('Some source data has not refreshed successfully for more than two hours.');
  if (status.degraded) warnings.push(`Source refresh incomplete: ${status.sources.filter(s => s.status === 'failed').map(s => s.name).join(', ')}. Last available evidence is retained with its original timestamps.`);
  if (task.fallback) warnings.push('No specific capability matched. These are general-purpose candidates.');
  if (task.unsupported) return { prompt: prompt.trim(), task, ...status, recommendations: [], warnings: ['Scout covers text responses and visual understanding. It does not rank image, video, audio generation, or transcription models.'], elapsedMs: elapsed(start) };
  const totalWeight = Object.values(task.weights).reduce((a, b) => a + b, 0);
  const candidates = [];
  for (const model of index.models) {
    if (task.needsVision && !model.modalities.includes('image')) continue;
    if (task.needsStructured && !model.parameters.some(p => ['structured_outputs', 'response_format'].includes(p))) continue;
    const evidence = model.evidence.map(e => ({ ...e, definition: index.benchmarks.get(e.benchmark) })).filter(e => e.definition && !e.definition.superseded && e.definition.tags.some(t => task.weights[t]));
    if (!evidence.length) continue;
    // A general vision score cannot stand in for actually reading documents.
    if (task.needsVision && task.weights.documents && !evidence.some(e => e.definition.tags.includes('documents'))) continue;
    let quality = 0, coverage = 0;
    for (const [tag, weight] of Object.entries(task.weights)) {
      const matches = evidence.filter(e => e.definition.tags.includes(tag));
      // Missing capability evidence is conservative, never an invented benchmark result.
      if (!matches.length) { quality += .25 * weight; continue; }
      // Correlated versions of one benchmark cannot overwhelm independent evidence.
      const families = new Map();
      for (const e of matches) {
        const key = family(e.definition.name), group = families.get(key) ?? [];
        group.push(e.relativeQuality); families.set(key, group);
      }
      const mean = [...families.values()].reduce((sum, group) => sum + group.reduce((a, b) => a + b, 0) / group.length, 0) / families.size;
      // A single result is useful but insufficient for a strong quality claim.
      const score = .5 + (mean - .5) * families.size / (families.size + 2);
      quality += score * weight; coverage += weight;
    }
    quality /= totalWeight; coverage /= totalWeight;
    const blendedPrice = (model.inputPrice * 3 + model.outputPrice) / 4;
    const economy = 1 / (1 + Math.log1p(blendedPrice));
    const speed = model.speed ? Math.min(1, Math.log1p(model.speed.tokensPerSecond) / Math.log(301)) : 0;
    // Evidence leads. Price and measured reference speed break close quality tradeoffs.
    const score = quality * .8 + economy * .13 + speed * .07;
    evidence.sort((a, b) => {
      const weight = e => e.definition.tags.reduce((sum, t) => sum + (task.weights[t] ?? 0), 0);
      return weight(b) - weight(a) || b.cohortSize - a.cohortSize || a.benchmark.localeCompare(b.benchmark);
    });
    candidates.push({ model, quality, coverage, blendedPrice, score, evidence });
  }
  candidates.sort((a, b) => b.score - a.score || a.blendedPrice - b.blendedPrice || a.model.id.localeCompare(b.model.id));
  const selected = candidates.slice(0, 5);
  if (selected.length < 5) warnings.push(`Only ${selected.length} eligible models have relevant evidence. Scout does not fill gaps with unsupported picks.`);
  if (selected.some(c => !c.model.speed)) warnings.push('Reference speed is unavailable for some models; no speed was estimated.');
  if (selected.some(c => c.evidence.some(e => e.definition.source === 'openvlm'))) warnings.push(`Some visual evidence comes from OpenVLM’s ${index.snapshot.sources.find(s => s.id === 'openvlm')?.publishedAt ?? 'undated'} snapshot. Newer models may lack comparable document results.`);
  if (task.needsStructured) warnings.push('JSON support is checked against the model catalogue. Instruction-following benchmarks are a proxy, not a test of your exact schema.');
  const recommendations = selected.map((c, i) => {
    const { model } = c;
    const tags = [...new Set(c.evidence.flatMap(e => e.definition.tags).filter(t => task.weights[t]))];
    const families = new Set(c.evidence.map(e => family(e.definition.name)));
    const confidence = c.coverage >= .8 && families.size >= 4 ? 'broader evidence' : 'limited evidence';
    return { rank: i + 1, id: model.id, name: model.name, provider: model.provider, score: round(c.score * 100), quality: round(c.quality * 100),
      evidenceCoverage: round(c.coverage * 100), confidence, reason: `${tags.map(t => capabilities[t].label.toLowerCase()).join(', ')}: ${c.evidence.length} results across ${families.size} benchmark families. ${model.speed ? 'Measured reference throughput included.' : 'Reference throughput unavailable.'}`,
      pricing: { inputPerMillion: round(model.inputPrice, 4), outputPerMillion: round(model.outputPrice, 4), blendedPerMillion: round(c.blendedPrice, 4), currency: 'USD', basis: '3 input tokens : 1 output token; advertised OpenRouter rates, excluding caching, reasoning and modality-specific charges.', url: `https://openrouter.ai/${model.id}` },
      speed: model.speed, context: model.context, modalities: model.modalities, parameters: model.parameters,
      evidence: c.evidence.map(e => ({ benchmark: e.definition.name, source: e.definition.source, score: round(e.score * 100), metric: e.metric, url: e.url, observedAt: e.observedAt,
        configurations: e.configurations, historical: !!e.historical, urls: e.urls, observedDates: e.observedDates, cohortSize: e.cohortSize })),
    };
  });
  return { prompt: prompt.trim(), task, ...status, eligibleModels: candidates.length, recommendations, warnings,
    methodology: 'Capability vocabulary → benchmark percentiles grouped by family and adjusted for evidence coverage → 80% task quality, 13% price, 7% reference generation speed. Scores are ranking signals, not predicted accuracy. Published evaluation configurations can differ from API defaults.', elapsedMs: elapsed(start) };
}
