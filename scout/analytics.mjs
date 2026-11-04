import { capabilities } from './capabilities.mjs';
import {timingStages} from './timing.mjs';

const kinds = ['extract', 'classify', 'dispatch', 'code', 'act', 'remember', 'sql', 'calculate', 'retrieve', 'judge', 'detect', 'segment', 'visual_unspecified', 'other'];
const modes = ['measured', 'benchmarks', 'task-fit', 'clarification'];
const pick = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const version = value => typeof value === 'string' && /^\d{1,5}$/.test(value) ? value : null;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_./:+-]{1,300}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

// Evidence comes from the public catalogue/calibration result, never the request.
// Keep named fields rather than copying an endpoint or recommendation wholesale.
const fields = (value, keys) => value ? Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]])) : null;
const evidenceFor = (m, profile) => ({
  benchmarks: (m.evidence ?? []).map(e => ({ ...fields(e, ['benchmark', 'source', 'score', 'metric', 'url', 'observedAt', 'configurations', 'historical', 'urls', 'observedDates', 'cohortSize', 'capabilities', 'family']),
    ...('interpretation' in e ? { interpretation: fields(e.interpretation, ['version', 'sourceHash', 'preparedAt']) } : {}) })),
  calibration: m.measured ? {
    ...fields(m.measured, ['cases', 'quality', 'effectiveQuality', 'validSchema', 'validJson', 'meanCostUsd', 'costKnownCalls', 'medianSeconds', 'providers', 'profile', 'measuredAt', 'url']),
    availability: fields(m.measured.availability, ['successes', 'attempts', 'rate']),
    protocol: fields(profile, ['id', 'measuredAt', 'expiresAt', 'casesPerModel', 'testedModels', 'eligibleTestedModels', 'protocolSha256', 'qualityBasis', 'url']),
  } : null,
  endpoint: fields(m.endpoint, ['protocol', 'operations', 'deployment', 'configuration', 'source', 'checkedAt', 'url', 'status', 'license', 'licenseURL', 'library', 'labelMode', 'cardURL', 'limits', 'imageExperimental', 'semanticProfile', 'semanticMatch']),
  reportedEvaluations: (m.endpoint?.reportedEvaluations ?? []).map(e => fields(e, ['format', 'dataset', 'datasetName', 'task', 'metric', 'value', 'split', 'configuration', 'date', 'url', 'provenance', 'verificationProvided'])),
  taskFit: fields(m.taskFit, ['tier', 'operation', 'output', 'basis']),
  pricing: fields(m.pricing, ['inputPerMillion', 'outputPerMillion', 'currency', 'basis', 'url']),
  reference: fields(m.reference, ['inputTokens', 'outputTokens', 'costUsd', 'completionSeconds']),
  speed: m.speed ? { ...fields(m.speed, ['tokensPerSecond', 'timeToFirstToken', 'timeToFirstAnswer', 'source', 'url', 'configurations', 'observedAt', 'historical', 'endpointId']),
    measurements: (m.speed.measurements ?? []).map(e => fields(e, ['configuration', 'tokensPerSecond', 'timeToFirstAnswer'])) } : null,
  comparison: fields(m.comparison, ['comparedModels', 'capabilityCoverage']),
});

// The validated prompt is the only user-supplied text. Public source evidence is
// attached separately. Never serialize requests, errors, inventories or whole results.
export function searchRecord({ prompt, result, task = result?.task, scope = 'all', index, diagnostics, position } = {}) {
  const mode = pick(result?.ranking?.mode, modes);
  const safeTask = {
    kind: pick(task?.kind, kinds),
    capabilities: Object.keys(capabilities).filter(key => task?.capabilities?.some(c => c.id === key)),
    input: task ? task.needsVision === true ? 'image' : 'text' : 'unknown',
    output: pick(task?.outputContract, ['labels', 'decision', 'boxes', 'masks', 'text', 'unspecified']),
    tools: task?.needsTools === true, memory: task?.needsMemory === true, structured: task?.needsStructured === true,
    priority: pick(task?.workload?.priority, ['balanced', 'quality', 'cost', 'latency']),
    inputSize: pick(task?.workload?.input, ['short', 'medium', 'long']),
    outputSize: pick(task?.workload?.output, ['short', 'medium', 'long']),
  };
  const top5 = (result?.recommendations ?? []).slice(0, 5).map((m, i) => ({
    rank: i + 1, model: id(m.modelId), endpoint: id(m.endpoint?.id),
    quality: mode === 'task-fit' ? null : number(m.quality),
    qualityBasis: mode === 'measured' ? 'calibration' : mode === 'benchmarks' ? 'relative-benchmarks' : 'unmeasured',
    costUsd: number(m.reference?.costUsd), seconds: number(m.reference?.completionSeconds),
    costBasis: number(m.reference?.costUsd) === null ? 'unknown' : mode === 'measured' ? 'calibration' : 'reference',
    timeBasis: number(m.reference?.completionSeconds) === null ? 'unknown' : mode === 'measured' ? 'calibration' : 'reference',
    fitTier: number(m.taskFit?.tier), evidence: evidenceFor(m, result?.ranking?.profile),
  }));
  const context = {
    rankingVersion: version(result?.ranking?.version), interpreterVersion: version(task?.interpreterVersion),
    indexCheckedAt: date(result?.checkedAt ?? index?.snapshot?.checkedAt), indexVersion: number(index?.snapshot?.dataVersion),
    scope: pick(scope, ['all', 'models', 'endpoints', 'intersection']),
    eligibleModels: number(result?.eligibleModels),
    inputTokens: number(result?.ranking?.workload?.inputTokens), outputTokens: number(result?.ranking?.workload?.outputTokens),
    weights: result?.ranking?.weights ? Object.fromEntries(['quality', 'cost', 'latency'].map(k => [k, number(result.ranking.weights[k])])) : null,
    ...(position?{position:Object.fromEntries(['task','slot','tasks','slots'].map(k=>[k,number(position[k])]))}:{}),
  };
  if(diagnostics)context.runtime={
    timings:Object.fromEntries(timingStages.filter(k=>number(diagnostics.timings?.[k])!==null).map(k=>[k,diagnostics.timings[k]])),
    pendingStages:(diagnostics.pendingStages??[]).filter(k=>timingStages.includes(k)),
    cache:pick(diagnostics.cache,['miss','hit','shared']),ageMs:number(diagnostics.ageMs),
    ...(diagnostics.failure?{failure:{stage:pick(diagnostics.failure.stage,[...timingStages,'matching']),type:pick(diagnostics.failure.type,['error','timeout']),
      code:typeof diagnostics.failure.code==='string'&&/^[a-z0-9_]{1,64}$/.test(diagnostics.failure.code)?diagnostics.failure.code:null,
      providerStatus:Number.isInteger(diagnostics.failure.providerStatus)&&diagnostics.failure.providerStatus>=100&&diagnostics.failure.providerStatus<=599?diagnostics.failure.providerStatus:null}}:{}),
  };
  return { prompt: typeof prompt === 'string' && prompt.length <= 4000 ? prompt : '', task: safeTask, top5, context };
}
