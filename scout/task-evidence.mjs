import bundled from './task-evidence.json' with { type: 'json' };
import { workloadFor } from './comparison.mjs';

// Small, versioned aggregates from a separate calibration split. No prompt text,
// answer keys, provider preferences, or per-model coefficients enter the ranker.
export function measuredCandidates(candidates, task, now, data = bundled) {
  if (data.version !== 1 || !task.kind || task.kind === 'other' || task.unsupported || task.needsMemory || task.weights.agents || !['none', undefined].includes(task.requirements?.memory)) return null;
  const workload = workloadFor(task);
  for (const profile of data.profiles) {
    const age = now - Date.parse(profile.measuredAt);
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400_000 || profile.split !== 'calibration') continue;
    const scope = profile.scope;
    if (scope.kind !== task.kind || scope.vision !== !!task.needsVision || scope.tools !== !!task.needsTools || scope.structured !== !!task.needsStructured || scope.input !== workload.input || scope.output !== workload.output) continue;
    if (Object.entries(task.weights).some(([tag, weight]) => weight >= 3 && !scope.capabilities.includes(tag))) continue;
    const observations = new Map(profile.models.map(m => [m.id, m]));
    const selected = candidates.filter(c => {
      const m = observations.get(c.model.id);
      return m?.cases >= 6 && Number.isFinite(m.quality) && m.quality >= 0 && m.quality <= 1 && Number.isFinite(m.effectiveQuality ?? m.quality) && (m.effectiveQuality ?? m.quality) >= 0 && (m.effectiveQuality ?? m.quality) <= m.quality && Number.isFinite(m.medianSeconds) && m.medianSeconds >= 0 && (m.meanCostUsd === null || Number.isFinite(m.meanCostUsd) && m.meanCostUsd >= 0);
    });
    if (selected.length < 5) continue;
    for (const c of selected) c.measured = observations.get(c.model.id);
    return { candidates: selected, profile: { id: profile.id, label: profile.label, measuredAt: profile.measuredAt, expiresAt: new Date(Date.parse(profile.measuredAt) + 7 * 86400_000).toISOString(), casesPerModel: profile.casesPerModel, testedModels: profile.models.length, eligibleTestedModels: selected.length, protocolSha256: profile.protocolSha256, url: 'https://openmerit.ai/scout/task-evidence.json' } };
  }
  return null;
}
