// Preserve the deployed Worker's configuration without adding retired fixtures
// to the separate, older local demo runtime.
import { getTask as localTask, limits, policy } from './config.mjs';
import { releaseRoutes, releaseModels, releaseSteps } from './release-models.ts';
export { harnessModel, limits } from './config.mjs';
const release = { id: 'release', name: 'Prepare a software release readiness handoff', targetId: 'release-agent-route', applicationId: 'demo-release-agent',
  models: releaseRoutes, inputNoun: 'goal', inputPlural: 'goals', sampleCount: 4, verificationCount: 4, maximumTries: 1, batchConcurrency: 1,
  minimumSuccess: 1, maximumLatency: 45000, maximumCostPerGoal: .006, maxOutputTokens: 2048, maxRequests: 144, workflow: true,
  structuredOutputs: true, reasoning: { enabled: false }, modelReleases: releaseModels,
  releaseWindow: { from: '2026-03-29', through: '2026-09-29' }, callSites: releaseSteps.map((_, i) => `release.mjs#stage-${i + 1}`) };
export function getTask(id = 'support') { return id === 'release' ? release : localTask(id); }
export function taskLimits(taskId = 'support') {
  const task = getTask(taskId);
  return { ...limits, maxRequests: task.maxRequests ?? limits.maxRequests, maxOutputTokens: task.maxOutputTokens ?? limits.maxOutputTokens };
}
export function taskPolicy(taskId = 'support') {
  const task = getTask(taskId);
  return { ...policy, evaluationBudget: { ...policy.evaluationBudget, maximumCandidateCount: task.models.length, maximumRunsPerCandidate: task.sampleCount ?? 24 },
    checkPolicy: { ...policy.checkPolicy, baselineAssessment: { afterCompletedTasks: task.sampleCount ?? 24 }, postSwapVerification: { afterCompletedTasks: task.verificationCount ?? 6 } } };
}
