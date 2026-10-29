// Model-agnostic comparison. No model names, prompt examples, or answer keys.
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const benchmarkFamily = b => b.family ?? b.id ?? b.name;
// The name of the evaluation a record reports, without its publisher's label,
// so third-party and vendor-reported copies of one benchmark compare equal.
// Versions and splits stay in the key; only spellings of one name are aliased.
const evaluationAliases = { hle: 'humanityslastexam', gpqadiamond: 'gpqa', tau2: 'tau2bench', t2bench: 'tau2bench', mmmuval: 'mmmu' };
export function evaluationKey(name) {
  const key = String(name).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/τ/g, 'tau')
    .replace(/\s*·\s*(vendor-reported|aa|vals ai|seal)$/, '').replace(/\s*\((artificial analysis[^)]*|vals ai run)\)$/, '').replace(/\s*—\s*(artificial analysis|vals ai) evaluation$/, '').replace(/-aa$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return evaluationAliases[key] ?? key;
}
// Copies of one evaluation from several publishers are one family, so they share
// one evaluation's weight in the quality estimate instead of each counting fully.
// Their scores remain separate series; vendors and third parties use different harnesses.
export function linkFamilies(benchmarks) {
  const parent = new Map(), root = f => { while (parent.get(f) !== f) f = parent.get(f); return f; };
  const join = (a, b) => { const [x, y] = [root(a), root(b)].sort(); parent.set(y, x); };
  const byKey = new Map();
  for (const b of benchmarks) {
    const family = benchmarkFamily(b), key = evaluationKey(b.name ?? b.id);
    if (!parent.has(family)) parent.set(family, family);
    if (byKey.has(key)) join(byKey.get(key), family); else byKey.set(key, family);
  }
  return benchmarks.map(b => { const family = root(benchmarkFamily(b)); return family === benchmarkFamily(b) ? b : { ...b, family }; });
}
export const qualityIndifference = .02;
// Hard evidence the ranker requires before a candidate is admitted. Evidence
// retrieval and applicability must be able to supply these, not only the quality target.
// Newly released models often lack document results. General image evidence can
// admit them for document work, but the gap is labelled rather than hidden.
export const evidenceFallbacks = { documents: 'vision' };
export const acceptableEvidenceTags = task => [...new Set(requiredEvidenceTags(task).flatMap(tag => [tag, evidenceFallbacks[tag]].filter(Boolean)))];
export const requiredEvidenceTags = task => [task.needsMemory && 'memory', task.needsTools && 'tools', task.needsVision && (task.weights.documents ? 'documents' : 'vision')].filter(Boolean);

export function workloadFor(task) {
  const input = task.workload?.input ?? (task.weights.context ? 'long' : task.needsVision ? 'medium' : 'short');
  const output = task.workload?.output ?? (task.needsStructured || task.needsTools ? 'short' : 'medium');
  return { input, output, inputTokens: { short: 1024, medium: 4096, long: 32768 }[input],
    outputTokens: task.kind === 'judge' || (task.kind === 'classify' && task.labelSpace === 'supplied') ? 16 : { short: 128, medium: 512, long: 2048 }[output], priority: task.workload?.priority ?? 'balanced' };
}

export function taskWeights(task) {
  const weights = { ...task.weights };
  // Format compliance is supporting evidence when the task has a substantive
  // capability. Instruction following is not a measurement of extraction accuracy.
  if (weights.structured && Object.entries(weights).some(([tag, weight]) => !['structured', 'vision'].includes(tag) && weight >= 3)) weights.structured *= .25;
  return weights;
}

export function referenceWork(model, workload) {
  const cost = Number.isFinite(model.inputPrice) && model.inputPrice >= 0 && Number.isFinite(model.outputPrice) && model.outputPrice >= 0 ? (model.inputPrice * workload.inputTokens + model.outputPrice * workload.outputTokens) / 1e6 : null;
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
  const margin = Math.sign(difference) * clamp((Math.abs(difference) - qualityIndifference) / .2, 0, 1);
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
  // Incremental transitive closure preserves the exact ranked-pairs policy.
  // Bitsets replace repeated recursive walks through the growing DAG.
  const positions = new Map(candidates.map((c, i) => [c, i]));
  const words = Math.ceil(candidates.length / 32);
  const reachable = candidates.map(() => new Uint32Array(words));
  const reaches = (a, b) => (reachable[a][b >>> 5] & (1 << (b & 31))) !== 0;
  edges.sort((a, b) => b.strength - a.strength || a.winner.model.id.localeCompare(b.winner.model.id) || a.loser.model.id.localeCompare(b.loser.model.id));
  for (const { winner, loser } of edges) {
    const a = positions.get(winner), b = positions.get(loser);
    if (reaches(b, a)) continue;
    next.get(winner).add(loser); incoming.set(loser, incoming.get(loser) + 1);
    if (reaches(a, b)) continue;
    const descendants = reachable[b].slice(); descendants[b >>> 5] |= 1 << (b & 31);
    for (let i = 0; i < candidates.length; i++) if (i === a || reaches(i, a)) {
      for (let w = 0; w < words; w++) reachable[i][w] |= descendants[w];
    }
  }
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
