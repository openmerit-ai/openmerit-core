import taskEvidence from './task-evidence.json' with { type: 'json' };
const descriptions = {
  models: { role: 'Availability & advertised pricing', measures: 'Catalogue inputs, context, API features and token rates.', limits: 'Router availability is not task quality. Advertised support is not measured schema or tool reliability. Rates are route quotes, not direct-provider quotes.' },
  epoch: { role: 'Benchmark aggregation', measures: 'Published reasoning, coding, knowledge and multimodal evaluations.', limits: 'Model versions and evaluation setups differ. Aggregated results can overlap other feeds; shared benchmark families are grouped in ranking.' },
  analysis: { role: 'Benchmark & endpoint measurements', measures: 'Capability tests, output throughput and time to first answer.', limits: 'Timing belongs to the tested endpoint and configuration. Reference task time is estimated; it is not a live speed test.' },
  openvlm: { role: 'Visual understanding evaluations', measures: 'Visual question answering, OCR and multimodal reasoning.', limits: 'Historical snapshot. Visual QA and OCR scores do not directly measure exact field extraction or JSON validity.' },
  omnidoc: { role: 'Document parsing evaluations', measures: 'End-to-end parsing of text, tables, formulas and document layout.', limits: 'Parsing quality is not exact business-field extraction. Only the explicit v1.6_full general-VLM table is imported.' },
  bfcl: { role: 'Tool & external-memory evaluations', measures: 'Function selection, arguments, dependent calls and retrieval with named external memory backends.', limits: 'Harness, schema and memory backend matter. This does not establish built-in memory or reliability in your tool loop.' },
  huggingface: { role: 'Specialist discovery & reported evaluations', measures: 'Task tags, pinned model cards, declared licenses, deployment metadata and published evaluation records.', limits: 'Bounded discovery sample, not the whole Hub. Reported results retain their dataset and metric; Scout has not verified them or mixed them into the ranked five.' },
};
export function describeSources(index) {
  return index.snapshot.sources.map(source => {
    const benchmarks = index.snapshot.benchmarks.filter(b => b.source === source.id), ids = new Set(benchmarks.map(b => b.id));
    const models = index.models.filter(m => m.evidence.some(e => ids.has(e.benchmark)));
    const observations = models.flatMap(m => m.evidence.filter(e => ids.has(e.benchmark)));
    const dates = observations.map(e => e.observedAt).filter(Boolean).sort();
    return { ...source, ...descriptions[source.id], coverage: { benchmarkSeries: benchmarks.length, matchedModels: models.length, measurements: observations.length,
      datedResults: dates.length, earliestSourceDate: dates[0] ?? null, latestSourceDate: dates.at(-1) ?? null, historicalResults: observations.filter(e => e.historical).length,
      ...(source.id === 'models' ? { cataloguedModels: index.snapshot.availableModels } : {}),
      ...(source.id === 'huggingface' ? { repositories: index.snapshot.specialists?.length ?? 0, repositoriesWithReportedResults: (index.snapshot.specialists ?? []).filter(m => m.evaluations.length).length } : {}) } };
  });
}
export function calibrationStatus(now = Date.now()) {
  return { name: 'Scout task measurements', url: 'https://openmerit.ai/scout/task-evidence.json', role: 'Direct task calibration',
    profiles: taskEvidence.profiles.map(p => ({ id: p.id, label: p.label, casesPerModel: p.casesPerModel, testedModels: p.models.length, measuredAt: p.measuredAt,
      expiresAt: new Date(Date.parse(p.measuredAt) + 7 * 86400_000).toISOString(), active: now >= Date.parse(p.measuredAt) && now - Date.parse(p.measuredAt) <= 7 * 86400_000, scope: p.scope })),
    limits: 'Separate small calibration sets, not executions of your prompt. Profile scope and tested pool constrain applicability. Independent holdout outcomes are excluded from runtime evidence.' };
}
