// Model-agnostic comparison. No model names, prompt examples, or answer keys.
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const benchmarkFamily = b => b.family ?? b.name.toLowerCase().replace(/ · aa$/, '')
  .replace(/^(aime|gpqa|mmlu|swe.bench|terminal.bench|ocrbench|mmmu|ifbench|tau|τ).*$/, '$1');

export function workloadFor(task) {
  const input = task.workload?.input ?? (task.weights.context ? 'long' : task.needsVision ? 'medium' : 'short');
  const output = task.workload?.output ?? (task.needsStructured || task.needsTools ? 'short' : 'medium');
  return { input, output, inputTokens: { short: 1024, medium: 4096, long: 32768 }[input],
    outputTokens: { short: 128, medium: 512, long: 2048 }[output], priority: task.workload?.priority ?? 'balanced' };
}

export function taskWeights(task) {
  const weights = { ...task.weights };
  // Format compliance is supporting evidence when the task has a substantive
  // capability. Instruction following is not a measurement of extraction accuracy.
  if (weights.structured && Object.entries(weights).some(([tag, weight]) => !['structured', 'vision'].includes(tag) && weight >= 3)) weights.structured *= .25;
  return weights;
}

export function referenceWork(model, workload) {
  const cost = (model.inputPrice * workload.inputTokens + model.outputPrice * workload.outputTokens) / 1e6;
  const measurements = model.speed?.measurements ?? [{ timeToFirstAnswer: model.speed?.timeToFirstAnswer, tokensPerSecond: model.speed?.tokensPerSecond }];
  const times = measurements.filter(m => Number.isFinite(m.timeToFirstAnswer) && m.timeToFirstAnswer >= 0 && Number.isFinite(m.tokensPerSecond) && m.tokensPerSecond > 0)
    .map(m => m.timeToFirstAnswer + workload.outputTokens / m.tokensPerSecond);
  const seconds = times.length ? median(times) : null;
  return { cost, seconds };
}

// Compare only the SAME benchmark on both models. A percentile from a weak
// cohort cannot be compared with a percentile from a different, stronger cohort.
export function compareQuality(a, b, weights) {
  const byID = new Map(b.evidence.map(e => [e.benchmark, e]));
  let delta = 0, comparedWeight = 0;
  const tags = [];
  for (const [tag, weight] of Object.entries(weights)) {
    const families = new Map();
    for (const e of a.evidence) {
      const other = byID.get(e.benchmark);
      if (!other || !e.definition.tags.includes(tag)) continue;
      const key = benchmarkFamily(e.definition), group = families.get(key) ?? [];
      group.push(e.score - other.score); families.set(key, group);
    }
    if (!families.size) continue;
    delta += mean([...families.values()].map(mean)) * weight;
    comparedWeight += weight; tags.push(tag);
  }
  if (!comparedWeight) return null;
  // A small proxy-score difference is insufficient evidence to buy a large
  // price/latency premium. Two points are an explicit indifference band, not a
  // statistical confidence interval. A further 20-point gap gives full preference.
  const difference = delta / comparedWeight;
  const margin = Math.sign(difference) * clamp((Math.abs(difference) - .02) / .2, 0, 1);
  return { preference: .5 + margin / 2, difference, tags, comparedWeight };
}

const cheaper = (a, b) => a + b === 0 ? .5 : b / (a + b);
export function orderCandidates(candidates, task) {
  const workload = workloadFor(task), weights = taskWeights(task);
  const policy = { balanced: [.6, .2, .2], quality: [.9, .05, .05], cost: [.6, .35, .05], latency: [.6, .05, .35] }[workload.priority];
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const edges = [];
  for (const candidate of candidates) Object.assign(candidate, { reference: candidate.measured ? { cost: candidate.measured.meanCostUsd, seconds: candidate.measured.medianSeconds } : referenceWork(candidate.model, workload), quality: 0, economy: 0, speedSignal: 0, comparedModels: 0, comparisonCoverage: 0 });
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i], b = candidates[j], comparison = a.measured && b.measured ? { preference: .5 + clamp(((a.measured.effectiveQuality ?? a.measured.quality) - (b.measured.effectiveQuality ?? b.measured.quality)) / .2, -.5, .5), comparedWeight: totalWeight } : compareQuality(a, b, weights);
    a.quality += comparison?.preference ?? .5; b.quality += comparison ? 1 - comparison.preference : .5;
    if (comparison) {
      a.comparedModels++; b.comparedModels++;
      a.comparisonCoverage += comparison.comparedWeight / totalWeight;
      b.comparisonCoverage += comparison.comparedWeight / totalWeight;
    }
    let costA = a.reference.cost !== null ? .5 : 0, costB = b.reference.cost !== null ? .5 : 0;
    if (a.reference.cost !== null && b.reference.cost !== null) { costA = cheaper(a.reference.cost, b.reference.cost); costB = 1 - costA; }
    a.economy += costA; b.economy += costB;
    let speedA = a.reference.seconds !== null ? .5 : 0, speedB = b.reference.seconds !== null ? .5 : 0;
    if (a.reference.seconds !== null && b.reference.seconds !== null) {
      speedA = cheaper(a.reference.seconds, b.reference.seconds); speedB = 1 - speedA;
    }
    // Unknown latency earns no speed advantage, including over another unknown.
    a.speedSignal += speedA; b.speedSignal += speedB;
    if (comparison) {
      const margin = (2 * comparison.preference - 1) * policy[0] + (costA - costB) * policy[1] + (speedA - speedB) * policy[2];
      if (Math.abs(margin) > 1e-12) edges.push({ winner: margin > 0 ? a : b, loser: margin > 0 ? b : a,
        strength: Math.abs(margin) * comparison.comparedWeight / totalWeight });
    }
  }
  for (const c of candidates) {
    const denominator = Math.max(1, candidates.length - 1);
    c.quality = candidates.length === 1 ? .5 : c.quality / denominator;
    c.economy /= denominator; c.speedSignal /= denominator; c.comparisonCoverage /= denominator;
    // Sparse/disconnected evidence cannot win simply by being cheap and unknown.
    c.score = c.quality * policy[0] + c.economy * policy[1] + c.speedSignal * policy[2] - .1 * (1 - c.comparedModels / denominator);
  }
  // Ranked pairs: honor the strongest supported comparisons without introducing
  // cycles. A candidate's easy wins over weak models cannot override its direct
  // loss to another finalist. Stable IDs are used only for exact ties.
  const next = new Map(candidates.map(c => [c, new Set()])), incoming = new Map(candidates.map(c => [c, 0]));
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from); return [...next.get(from)].some(c => reaches(c, target, seen));
  };
  edges.sort((a, b) => b.strength - a.strength || a.winner.model.id.localeCompare(b.winner.model.id) || a.loser.model.id.localeCompare(b.loser.model.id));
  for (const { winner, loser } of edges) if (!reaches(loser, winner)) { next.get(winner).add(loser); incoming.set(loser, incoming.get(loser) + 1); }
  const tieBreak = (a, b) => b.score - a.score || b.quality - a.quality || (a.reference.cost ?? Infinity) - (b.reference.cost ?? Infinity) || a.model.id.localeCompare(b.model.id);
  const ordered = [], remaining = new Set(candidates);
  while (remaining.size) {
    const chosen = [...remaining].filter(c => incoming.get(c) === 0).sort(tieBreak)[0];
    remaining.delete(chosen); ordered.push(chosen);
    for (const c of next.get(chosen)) incoming.set(c, incoming.get(c) - 1);
  }
  candidates.splice(0, candidates.length, ...ordered);
  return { workload, weights: { quality: policy[0], cost: policy[1], latency: policy[2] } };
}
