const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const completeMean = values => values.every(v => v !== null) ? mean(values) : null;
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.task, row.connection, row.variant].join('/');
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  return [...groups].map(([key, runs]) => ({
    key, task: runs[0].task, connection: runs[0].connection, variant: runs[0].variant, runs: runs.length,
    quality: completeMean(runs.map(r => r.quality)), failures: runs.filter(r => r.status !== 'ok' && r.quality !== null).length,
    blockedAttempts: runs.filter(r => r.failureReason).length, scoredRuns: runs.filter(r => r.quality !== null).length,
    failedTaskChecks: runs.filter(r => r.status === 'ok' && r.quality === 0).length,
    qualityRange: runs.every(r => r.quality !== null) ? [Math.min(...runs.map(r => r.quality)), Math.max(...runs.map(r => r.quality))] : null,
    inputTokens: completeMean(runs.map(r => r.usage?.input ?? null)), outputTokens: completeMean(runs.map(r => r.usage?.output ?? null)),
    reportedCostUsd: runs.some(r => r.costUsd !== null) ? runs.filter(r => r.costUsd !== null).reduce((s, r) => s + r.costUsd, 0) : null, unknownCosts: runs.filter(r => r.costUsd === null).length,
    partialReportedCostUsd: runs.reduce((s, r) => s + (r.partialCostUsd ?? 0), 0),
    meanCostUsd: completeMean(runs.map(r => r.costUsd)), medianSeconds: median(runs.map(r => r.seconds)),
  }));
}
export function isVolatile(rows) {
  const spread = values => {
    if (values.length < 3 || values.some(v => v === null)) return false;
    const avg = mean(values);
    return avg > 0 && Math.sqrt(mean(values.map(v => (v - avg) ** 2))) / avg > .25;
  };
  for (const group of summarize(rows)) {
    const runs = rows.filter(r => `${r.task}/${r.connection}/${r.variant}` === group.key);
    if (group.qualityRange && group.qualityRange[1] - group.qualityRange[0] > .05 || runs.some(r => r.status !== 'ok') || spread(runs.map(r => r.seconds)) || spread(runs.map(r => r.costUsd)) || spread(runs.map(r => r.usage?.input ?? null))) return true;
  }
  return false;
}
export function compareReports(current, previous) {
  if (!previous || previous.compatibility !== current.compatibility || previous.planHash !== current.planHash || previous.status !== 'complete' || current.status !== 'complete') return null;
  return current.summary.map(now => {
    const before = previous.summary.find(row => row.key === now.key);
    if (!before) return null;
    const delta = key => now[key] === null || before[key] === null ? null : now[key] - before[key];
    return { key: now.key, previousRuns: before.runs, runs: now.runs, qualityDelta: delta('quality'), inputTokensDelta: delta('inputTokens'), outputTokensDelta: delta('outputTokens'), meanCostUsdDelta: delta('meanCostUsd'), medianSecondsDelta: delta('medianSeconds') };
  }).filter(Boolean);
}
const fmt = (v, digits = 2) => v === null || v === undefined ? '?' : v.toFixed(digits);
export function formatReport(report) {
  const lines = [`OpenMerit eval · ${report.status} · ${report.revision.slice(0, 12)}`, '', 'Task / connection / variant | scored / attempts | blocked | quality | input / output tokens | estimated $/run | seconds (median)'];
  for (const row of report.summary) {
    lines.push(`${row.key} | ${row.scoredRuns ?? row.runs} / ${row.runs} | ${row.blockedAttempts ?? 0} | ${row.quality === null ? '?' : fmt(row.quality * 100, 1) + '%'} | ${fmt(row.inputTokens, 0)} / ${fmt(row.outputTokens, 0)} | ${fmt(row.meanCostUsd, 5)} | ${fmt(row.medianSeconds)}`);
    if (row.partialReportedCostUsd > 0) lines.push(`  Partial cost estimate: $${fmt(row.partialReportedCostUsd, 5)}; full attempt cost unknown.`);
  }
  if (report.comparison) {
    lines.push('', 'Change from the previous compatible revision (negative tokens/cost/time is lower):');
    for (const row of report.comparison) lines.push(`${row.key}: quality ${fmt(row.qualityDelta === null ? null : row.qualityDelta * 100, 1)} pp; tokens ${fmt(row.inputTokensDelta, 0)} / ${fmt(row.outputTokensDelta, 0)}; $ ${fmt(row.meanCostUsdDelta, 5)}; seconds ${fmt(row.medianSecondsDelta)}`);
  } else lines.push('', 'No complete, compatible previous revision for comparison.');
  lines.push('', '3–10 repetitions measure variability, not statistical certainty. ? means unavailable.', 'Costs are agent-reported estimates, not reconciled bills. Compare agents as different harnesses.');
  if (report.budgetLimitUsd !== undefined) lines.push(report.budgetLimitUsd === 'unlimited' ? 'Budget: no fixed cap. Task/repetition limits and timeouts still apply; watched changes can incur further charges until stopped.' : `Budget: $${fmt(report.budgetLimitUsd)} cumulative across reruns.`);
  lines.push(`Reserved allowance used: $${fmt(report.budgetUsedUsd, 5)} (not billed spend). Blocked attempts are unscored.`);
  if (report.reason) lines.push(`Stopped: ${report.reason}`);
  return lines.join('\n');
}
