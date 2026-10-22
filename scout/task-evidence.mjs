import bundled from './task-evidence.json' with { type: 'json' };
import { workloadFor } from './comparison.mjs';

// Small, versioned aggregates from a separate calibration split. No prompt text,
// answer keys, provider preferences, or per-model coefficients enter the ranker.
export const calibrationMaxAgeMs = 7 * 86400_000;
export function measuredCandidates(candidates, task, now, data = bundled, {minimumModels=5,maxAgeMs=calibrationMaxAgeMs}={}) {
  if (data.version !== 1 || !task.kind || task.kind === 'other' || task.unsupported) return null;
  if (task.uncertainty?.some(id => ['task_kind', 'result_type', 'json'].includes(id))) return null;
  const workload = workloadFor(task);
  for (const profile of [...data.profiles].sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))) {
    const age = now - Date.parse(profile.measuredAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs || profile.split !== 'calibration') continue;
    const scope = profile.scope;
    // A measurement applies only to the serialization actually exercised by
    // its harness. Unknown/legacy formats cannot authorize measured accuracy.
    if (scope.structured && (!scope.outputFormat || scope.outputFormat !== task.outputFormat)) continue;
    // Fixed-choice calibration cannot establish open identification accuracy.
    if (task.kind === 'classify' && (!scope.labelSpace || scope.labelSpace !== task.labelSpace)) continue;
    // Retention and execution are part of the task contract, never interchangeable
    // with a long context window or one function dispatch. Legacy profiles have neither.
    const memory = task.needsMemory ? 'persistent' : task.requirements?.memory ?? 'none';
    if ((scope.memory ?? 'none') !== memory || (scope.agentic ?? false) !== !!task.weights.agents) continue;
    if (scope.kind !== task.kind || scope.vision !== !!task.needsVision || scope.tools !== !!task.needsTools || scope.structured !== !!task.needsStructured || scope.input !== workload.input || scope.output !== workload.output) continue;
    if (Object.entries(task.weights).some(([tag, weight]) => weight >= 3 && !scope.capabilities.includes(tag))) continue;
    const observations = new Map(profile.models.map(m => [m.id, m]));
    const selected = candidates.filter(c => {
      const m = observations.get(c.model.id);
      if (c.model.endpoint && c.model.endpoint.source !== 'models') return false;
      return m?.cases >= 6 && Number.isFinite(m.quality) && m.quality >= 0 && m.quality <= 1 && Number.isFinite(m.effectiveQuality ?? m.quality) && (m.effectiveQuality ?? m.quality) >= 0 && (m.effectiveQuality ?? m.quality) <= m.quality && Number.isFinite(m.medianSeconds) && m.medianSeconds >= 0 && (m.meanCostUsd === null || Number.isFinite(m.meanCostUsd) && m.meanCostUsd >= 0);
    });
    if (selected.length < minimumModels) continue;
    for (const c of selected) c.measured = observations.get(c.model.id);
    return { candidates: selected, profile: { id: profile.id, label: profile.label, measuredAt: profile.measuredAt, expiresAt: new Date(Date.parse(profile.measuredAt) + 7 * 86400_000).toISOString(), casesPerModel: profile.casesPerModel, testedModels: profile.models.length, eligibleTestedModels: selected.length, protocolSha256: profile.protocolSha256, qualityBasis: profile.qualityBasis ?? 'Mean task-check accuracy; required format failures score zero.', url: 'https://openmerit.ai/scout/task-evidence.json' } };
  }
  return null;
}

// Reuse direct observations without excluding every other eligible model.
export function attachTaskObservations(candidates,task,now,data=bundled) {
  const matched=measuredCandidates(candidates,task,now,data,{minimumModels:1});
  if(!matched){
    // An applicable profile past its expiry stays excluded, but not silently.
    const expired=measuredCandidates(candidates,task,now,data,{minimumModels:1,maxAgeMs:Infinity});
    if(expired)for(const c of expired.candidates)delete c.measured;
    return expired?{expired:expired.profile}:null;
  }
  const scope=data.profiles.find(p=>p.id===matched.profile.id).scope;
  for(const c of matched.candidates) {
    c.taskObservation={...c.measured,profile:matched.profile};delete c.measured;
    const id=`calibration:${matched.profile.id}`;
    c.evidence.push({benchmark:id,score:c.taskObservation.quality,metric:'task-check accuracy',url:matched.profile.url,observedAt:matched.profile.measuredAt,configurations:['Recorded calibration endpoint configuration'],definition:{id,name:matched.profile.label,source:'scout-calibration',tags:scope.capabilities,family:id}});
  }
  return matched.profile;
}
