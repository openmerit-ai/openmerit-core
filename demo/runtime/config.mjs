import {kitRoutes,originalKitModels,specialistKitModels,kitRequirements} from './fieldkit-models.mjs';
export const models = [
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', role: 'Incumbent' },
  { id: 'openai/gpt-4.1-nano', name: 'GPT-4.1 nano', role: 'Challenger' },
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', role: 'Challenger' },
];
export const harnessModel = 'openai/gpt-4.1-mini';
export const agentSteps = ['Inspect incident','Read checkpoint','Plan recovery'];
const route = ids => ids.map((id,index)=>({task:agentSteps[index],model:id,name:models.find(m=>m.id===id).name}));
export const agentRoutes = [
  {...models[0],name:'Fixed model',steps:route([models[0].id,models[0].id,models[0].id])},
  {id:'backfill/mixed-v1',name:'Mixed model route',role:'Challenger',steps:route([models[1].id,models[0].id,models[2].id])},
];
export const placementModels = [
  {id:'google/gemma-4-26b-a4b-it',name:'Gemma 4 26B A4B',releasedAt:'2026-04-03'},
  {id:'xiaomi/mimo-v2.5',name:'MiMo-V2.5',releasedAt:'2026-04-22'},
  {id:'deepseek/deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',releasedAt:'2026-09-10'},
];
export const placementBaseline={id:'qwen/qwen3.6-plus',name:'Qwen3.6 Plus',releasedAt:'2026-04-02'};
const placementSteps=['Read requirements','Inspect capacity','Choose pool'];
export const placementRoutes = [
  {...placementBaseline,name:'Fixed model',role:'Incumbent',steps:placementSteps.map(task=>({task,model:placementBaseline.id,name:placementBaseline.name}))},
  {id:'placement/recent-v1',name:'Mixed model route',role:'Challenger',steps:placementModels.map((m,i)=>({task:placementSteps[i],model:m.id,name:m.name}))},
];
export const targetId = 'support-ticket-route';
export const tasks = {
  fieldkit: {id:'fieldkit',name:'Prepare an offline field-recording kit',targetId:'fieldkit-agent-route',applicationId:'demo-fieldkit-agent',
    models:kitRoutes,inputNoun:'goal',inputPlural:'goals',sampleCount:4,verificationCount:4,maximumTries:1,batchConcurrency:1,
    minimumSuccess:1,maximumLatency:45000,maximumCostPerGoal:.006,maxOutputTokens:2048,workflow:true,
    modelRequirements:kitRequirements,modelReleases:[...new Map([...originalKitModels,...specialistKitModels].map(m=>[m.id,m])).values()],
    releaseWindow:{from:'2026-03-28',through:'2026-09-28'},callSites:['fieldkit.mjs#translate','fieldkit.mjs#vision','fieldkit.mjs#extract','fieldkit.mjs#code','fieldkit.mjs#reason','fieldkit.mjs#handoff']},
  support: { id:'support', name:'Support email to ticket', targetId, applicationId:'demo-ticket-app', models, inputNoun:'email', inputPlural:'emails' },
  spam: { id:'spam', name:'Community comment spam filter', targetId:'comment-spam-route', applicationId:'demo-comment-app',
    models:[models[0],{id:'typesafe/jev-1.13',name:'Jev 1.13',role:'Challenger',api:'decisions'}], inputNoun:'comment', inputPlural:'comments' },
  backfill: { id:'backfill', name:'Recover an interrupted data backfill', targetId:'backfill-agent-route', applicationId:'demo-backfill-agent',
    models:agentRoutes, inputNoun:'goal', inputPlural:'goals', sampleCount:8, verificationCount:6,
    minimumSuccess:1, maximumLatency:8000, maximumCostPerGoal:.003, maxOutputTokens:2048, workflow:true },
  placement: {id:'placement',name:'Place a GPU job within its constraints',targetId:'gpu-placement-route',applicationId:'demo-placement-agent',
    models:placementRoutes,inputNoun:'goal',inputPlural:'goals',sampleCount:8,verificationCount:6,
    minimumSuccess:1,maximumLatency:12000,maximumCostPerGoal:.003,maxOutputTokens:2048,workflow:true,
    structuredOutputs:true,reasoning:{enabled:false},modelReleases:[placementBaseline,...placementModels].map(m=>({...m,url:`https://openrouter.ai/${m.id}`})),
    releaseWindow:{from:'2026-03-28',through:'2026-09-28'},callSites:['placement.mjs#read_job','placement.mjs#list_pools','placement.mjs#placement_plan']},
};
export function getTask(id = 'support') {
  if (!Object.hasOwn(tasks,id)) throw new Error('Unknown demo task.');
  return tasks[id];
}
// Route IDs are application configurations, never provider model IDs.
export function providerModels(task) {
  return [...new Set(task.models.flatMap(m=>m.steps?.map(s=>s.model) ?? [m.id]))];
}
export function applicationConfig(task, id) {
  const selected=task.models.find(m=>m.id===id);
  if(!selected) throw new Error('Unknown application route.');
  return {model:id,...(selected.steps?{steps:selected.steps}:{})};
}
export const limits = { lifetimeSeconds: 600, maxRequests: 120, maxInputBytes: 180000, maxOutputTokens: 8192, dailySessions: 10, concurrentSessions: 2 };
export function confirmedProfile(confirmedAt, sampleCount, taskId = 'support') {
  const task = getTask(taskId);
  return {
    id: taskId === 'support' ? 'support-ticket-demo' : taskId === 'spam' ? 'comment-spam-demo' : `${taskId}-agent-demo`, revision: 1, name: task.name,
    goal: 'Choose the lowest observed cost on the eligible frontier of this fixed synthetic fixture suite.',
    applicationTarget: { id: task.targetId, kind: 'application_llm_call', name: task.name,
      applicationId: task.applicationId, callSites: task.callSites ?? (task.workflow ? ['backfill.mjs#inspect_job','backfill.mjs#read_checkpoint','backfill.mjs#recovery_manifest'] : ['application.mjs#classify']), routeKey: 'model', confirmedAt },
    createdAt: confirmedAt, confirmedAt,
    objectives: [
      { metricId: 'task_success', required: true, minimumSamples: sampleCount, tolerance: 0, constraint: { operator: 'at_least', value: task.minimumSuccess ?? 0.9 } },
      { metricId: 'total_task_cost', required: true, minimumSamples: sampleCount, tolerance: 0, ...(task.workflow?{constraint:{operator:'at_most',value:task.maximumCostPerGoal*sampleCount}}:{}) },
      { metricId: 'end_to_end_task_latency', required: true, minimumSamples: sampleCount, tolerance: 0, constraint: { operator: 'at_most', value: task.maximumLatency ?? 10000 } },
      ...(task.workflow?['tool_use_performance','structured_output_reliability','instruction_following','retrieval_use_quality'].map(metricId=>({metricId,required:true,minimumSamples:sampleCount,tolerance:0,constraint:{operator:'at_least',value:1}})):[]),
    ].map(objective => ({ ...objective, samplingPlan: {
      strategy: 'representative_task_set', representativeCaseCount: sampleCount, repetitionsPerCase: 1,
      aggregation: ['total_task_cost','end_to_end_task_latency'].includes(objective.metricId) ? 'mean' : 'rate',
      rationale: objective.metricId === 'total_task_cost'
        ? 'Present mean cost per goal from the fixed suite; report summed metric windows for evaluation-budget accounting.'
        : 'Measure this objective once per fixed synthetic case; report an observed suite aggregate, not production reliability.',
    } })),
  };
}
export const policy = {
  mode: 'supervised_graduation',
  evaluationBudget: { currency: 'USD', maximumSpend: 0.25, maximumCandidateCount: 3, maximumRunsPerCandidate: 24 },
  automaticSwapsEnabled: false, confirmationRequiredUntilVerifiedSwaps: 1,
  requirePostSwapVerification: true, rollbackOnRegression: true,
  checkPolicy: {
    baselineAssessment: { afterCompletedTasks: 24 },
    frontierReassessment: { afterCompletedTasks: 1000, onModelCatalogChange: false },
    regressionCheck: { afterCompletedTasks: 1000, thresholds: [] },
    postSwapVerification: { afterCompletedTasks: 6 }, cooldownSeconds: 0,
    execution: { mode: 'active_session_only', infrastructureChangesAllowed: false },
  },
};
export function taskPolicy(taskId='support') {
  const task=getTask(taskId);
  return {...policy,evaluationBudget:{...policy.evaluationBudget,maximumCandidateCount:task.models.length,maximumRunsPerCandidate:task.sampleCount ?? 24},
    checkPolicy:{...policy.checkPolicy,baselineAssessment:{afterCompletedTasks:task.sampleCount ?? 24},postSwapVerification:{afterCompletedTasks:task.verificationCount ?? 6}}};
}
