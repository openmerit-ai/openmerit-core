export const benchmarkFamily = b => b.family ?? b.id ?? b.name;
const evaluationAliases = { hle: 'humanityslastexam', gpqadiamond: 'gpqa', tau2: 'tau2bench', t2bench: 'tau2bench', mmmuval: 'mmmu' };
// Versions and splits stay distinct; publisher aliases do not duplicate a family.
export function evaluationKey(name) {
  const key = String(name).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/τ/g, 'tau')
    .replace(/\s*·\s*(vendor-reported|aa|vals ai|seal|sierra|fireworks)$/, '').replace(/\s*\((artificial analysis[^)]*|vals ai run)\)$/, '').replace(/\s*—\s*(artificial analysis|vals ai) evaluation$/, '').replace(/-aa$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return evaluationAliases[key] ?? key;
}
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
