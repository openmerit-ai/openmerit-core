import { labels, registry as defaultRegistry } from './registry.mjs';
import { linkFamilies } from './comparison.mjs';
import { describeSources } from './source-details.mjs';
import { contractModels } from './endpoints.mjs';

const staleSources = (snapshot, now) => snapshot.sources.some(s => {
  if (s.refreshPolicy === 'manual-contract-review' || s.refreshPolicy === 'retained') return false;
  const hours = s.maxAgeHours ?? snapshot.registry?.policy.maxSourceAgeHours ?? defaultRegistry.policy.maxSourceAgeHours;
  return !Number.isFinite(Date.parse(s.checkedAt)) || now - Date.parse(s.checkedAt) > hours * 3600_000;
});

export function createIndex(snapshot) {
  if (snapshot.version !== 1 || (!snapshot.models?.length && !snapshot.publicStatus)) throw new Error('Unsupported Scout index.');
  const benchmarks = new Map(linkFamilies(snapshot.benchmarks).map(b => [b.id, b]));
  const counts = new Map();
  for (const model of snapshot.models) for (const e of model.evidence) counts.set(e.benchmark, (counts.get(e.benchmark) ?? 0) + 1);
  const models = snapshot.models.map(model => ({ ...model, evidence: model.evidence.map(e => ({ ...e, cohortSize: counts.get(e.benchmark) })) }));
  const interpreted = snapshot.benchmarks.filter(b => b.interpretation);
  const benchmarkInterpretation = { version: interpreted[0]?.interpretation.version ?? null, prepared: interpreted.filter(b => b.interpretation.status === 'ready').length,
    classified: interpreted.filter(b => b.interpretation.status === 'ready' && b.tags.length).length, unclassified: interpreted.filter(b => b.interpretation.status === 'ready' && !b.tags.length).length,
    unavailable: interpreted.filter(b => b.interpretation.status === 'unavailable').length };
  const index = { snapshot, benchmarks, models, benchmarkInterpretation };
  index.cachedStatus = snapshot.publicStatus ?? computeIndexStatus(index);
  return index;
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
    models: models.length, providers, endpoints: (snapshot.catalogue ?? models).reduce((n, m) => n + (m.endpoints?.length ?? 1), 0) + contractModels(snapshot).length, independentModels: (snapshot.catalogue ?? []).filter(m => m.endpoints?.some(e => e.source !== 'models')).length, availableModels: snapshot.availableModels, measurements: models.reduce((sum, m) => sum + m.evidence.length, 0),
    sources: describeSources(index), specialistRepositories: snapshot.specialists?.length ?? 0, wordCloud: Object.entries(capabilities).map(([id, c]) => ({ id, label: c.label, keywords: c.terms, benchmarks: snapshot.benchmarks.filter(b => b.tags.includes(id)).length, models: models.filter(m => m.evidence.some(e => index.benchmarks.get(e.benchmark)?.tags.includes(id))).length })), refreshIntervalSeconds: 3600 };
}

export function indexStatus(index, now = Date.now()) {
  const status = index.cachedStatus ?? computeIndexStatus(index, now);
  // Old published manifests can still contain the retired calibration field.
  const { calibration, ...current } = status;
  return { ...current, stale: staleSources(index.snapshot, now), degraded: index.snapshot.sources.some(s => s.status === 'failed') };
}
