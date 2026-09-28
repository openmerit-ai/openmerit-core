// Harness-side calculation for this finite, prepared fixture suite. The real
// OpenMerit verifier checks the returned snapshot independently.
export function calculateComparison(profile, assessments, evidence, currentCandidateId, now = new Date().toISOString()) {
  const metric = (a, o) => a.metrics.find(m => m.metricId === o.metricId);
  const readiness = a => profile.objectives.filter(o => o.required).every(o => {
    const m = metric(a, o);
    return m?.state === 'measured' && Number.isFinite(m.value) && m.sampleCount >= o.minimumSamples && m.evidence.length;
  });
  // This demo reports observed point values, never confidence intervals.
  if (assessments.some(a => a.metrics.some(m => m.interval))) throw new Error('This fixture calculator only supports observed point values.');
  const unresolved = assessments.filter(a => !readiness(a));
  const ineligible = assessments.filter(a => readiness(a) && profile.objectives.some(o => {
    if (!o.constraint) return false;
    const value = metric(a, o)?.value;
    return o.constraint.operator === 'at_least' ? value < o.constraint.value : value > o.constraint.value;
  }));
  const eligible = assessments.filter(a => !unresolved.includes(a) && !ineligible.includes(a));
  const comparisons = eligible.flatMap(a => eligible.filter(b => b !== a).map(b => {
    let better = false, noWorse = true;
    for (const o of profile.objectives) {
      const x = metric(a, o), y = metric(b, o);
      if (!x || !y) throw new Error('Missing comparison objective.');
      if (x.direction !== y.direction || x.unit !== y.unit) throw new Error('Incompatible metrics.');
      const improvement = x.direction === 'maximize' ? x.value - y.value : y.value - x.value;
      noWorse &&= improvement >= -o.tolerance;
      better ||= improvement > o.tolerance;
    }
    const dominates = noWorse && better;
    return { candidateId: a.candidateId, otherCandidateId: b.candidateId,
      state: dominates ? 'dominates' : 'does_not_dominate',
      reasons: [dominates ? 'Observed results are no worse on every objective and better beyond tolerance on at least one.' : 'Observed results include a tradeoff or no material improvement.'] };
  }));
  const dominated = eligible.filter(a => comparisons.some(c => c.otherCandidateId === a.candidateId && c.state === 'dominates'));
  const frontier = eligible.filter(a => !dominated.includes(a));
  const frontierSnapshot = {
    id: 'demo-frontier', targetId: profile.applicationTarget.id, taskProfileId: profile.id,
    taskProfileRevision: profile.revision, productRevision: assessments[0].productRevision, createdAt: now,
    frontierCandidateIds: frontier.map(a => a.candidateId), dominatedCandidateIds: dominated.map(a => a.candidateId),
    ineligibleCandidateIds: ineligible.map(a => a.candidateId), unresolvedCandidateIds: unresolved.map(a => a.candidateId),
    comparisons, assessmentIds: assessments.map(a => a.id), calculationEvidence: [evidence],
  };
  const cost = a => a.metrics.find(m => m.metricId === 'total_task_cost').value;
  const current = assessments.find(a => a.candidateId === currentCandidateId);
  const best = [...frontier].sort((a, b) => cost(a) - cost(b) || a.candidateId.localeCompare(b.candidateId))[0];
  // Preserve the incumbent when no cheaper qualifying alternative was measured.
  const selected = best && current && best.candidateId !== currentCandidateId && cost(best) < cost(current) ? best : undefined;
  return { targetId: profile.applicationTarget.id, assessments, frontierSnapshot,
    ...(selected ? { recommendation: {
      targetId: profile.applicationTarget.id, frontierSnapshotId: frontierSnapshot.id,
      selectedCandidateId: selected.candidateId, currentCandidateId,
      reasons: ['Lowest observed cost on the verified eligible frontier, below the incumbent cost, under the confirmed fixture policy.'],
      preferenceEvidence: [evidence],
    } } : {}),
  };
}
