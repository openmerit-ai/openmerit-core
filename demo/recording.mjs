// Curate a verified evidence export into an honest, compressed replay.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getTask } from './runtime/config.mjs';

export function makeRecording(raw) {
  const evidence=JSON.parse(raw),task=getTask(evidence.task);
  const files=evidence.files,cycle=files['openmerit-state.json']?.cycle;
  const diff=files['configuration-diff.json'];
  if(cycle?.stage!=='swap_verified' || !diff?.approvedAt || diff.before.model!==task.models[0].id || files['rollback.json']) throw new Error('A verified, approved change is required.');
  const measurements={};
  let selectedMeasurement;
  for(const key of ['baseline',...task.models.slice(1).map((_,i)=>`trial-${i+1}`)]) {
    const batch=files[`${key}.json`];
    if(!batch || batch.runs.length!==(task.sampleCount ?? 24) || batch.runs.some(r=>!Number.isFinite(r.cost) || r.cost<0 || !Number.isFinite(r.latencyMs))) throw new Error('Complete measured batches with provider cost are required.');
    const model=task.models.find(m=>m.id===batch.assessment.modelId);
    if(!model) throw new Error('Unrecognized measured model.');
    measurements[key]={model:model.id,name:model.name,matches:batch.runs.filter(r=>r.passed).length,samples:batch.runs.length,
      costPerInput:batch.runs.reduce((n,r)=>n+r.cost,0)/batch.runs.length,latencyMs:batch.runs.reduce((n,r)=>n+r.latencyMs,0)/batch.runs.length,
      ...(task.workflow?{steps:model.steps,checks:Object.fromEntries(['tool_use_performance','structured_output_reliability','instruction_following','retrieval_use_quality'].map(id=>[id,batch.runs.reduce((n,r)=>n+(r.checks?.[id] ?? 0),0)/batch.runs.length]))}:{})};
    if(task.workflow && batch.runs.some(r=>r.calls?.length!==model.steps.length || r.trace?.length!==model.steps.length || r.calls.some((c,i)=>c.model!==model.steps[i].model) || r.trace.some((s,i)=>s.model!==model.steps[i].model))) throw new Error('Recorded step models must match the actual provider calls and tool trace.');
    if(model.id===diff.after.model && key!=='baseline') selectedMeasurement=key;
  }
  const selected=measurements[selectedMeasurement],baseline=measurements.baseline;
  if(!selected || selected.matches/selected.samples<(task.minimumSuccess ?? .9) || selected.latencyMs>(task.maximumLatency ?? 10000) || selected.costPerInput>=baseline.costPerInput || (task.workflow && (selected.costPerInput>task.maximumCostPerGoal || Object.values(selected.checks).some(v=>v!==1)))) throw new Error('The selected model must actually qualify and cost less.');
  const verificationBatch=files['verification.json'];
  const verificationCount=task.verificationCount ?? 6;
  if(verificationBatch?.assessment.modelId!==selected.model || verificationBatch.runs.length!==verificationCount || verificationBatch.runs.some(r=>!r.passed || !Number.isFinite(r.cost) || r.cost<0 || !Number.isFinite(r.latencyMs) || (task.workflow && ['tool_use_performance','structured_output_reliability','instruction_following','retrieval_use_quality'].some(id=>r.checks?.[id]!==1)))) throw new Error(`${verificationCount} passing post-swap checks are required for this golden recording.`);
  if(verificationBatch.runs.reduce((n,r)=>n+r.latencyMs,0)/verificationCount>(task.maximumLatency ?? 10000) || task.workflow && verificationBatch.runs.reduce((n,r)=>n+r.cost,0)/verificationCount>task.maximumCostPerGoal) throw new Error('Post-swap measurements must still meet the confirmed constraints.');
  if(task.workflow && verificationBatch.runs.some(r=>r.calls?.length!==selected.steps.length || r.trace?.length!==selected.steps.length || r.calls.some((c,i)=>c.model!==selected.steps[i].model) || r.trace.some((s,i)=>s.model!==selected.steps[i].model))) throw new Error('Verification must use the approved step models.');
  // Prefer an informative error in the fixed path, without excluding any
  // fixture from the aggregate measurements or changing its expected answer.
  const beforeRuns=files['baseline.json'].runs,afterRuns=files[`${selectedMeasurement}.json`].runs;
  const sample=beforeRuns.find(r=>!r.passed && afterRuns.some(a=>a.fixtureId===r.fixtureId && a.passed)) ?? beforeRuns[0];
  const after=afterRuns.find(r=>r.fixtureId===sample.fixtureId);
  if(!after || (sample.input ?? sample.email)!==(after.input ?? after.email)) throw new Error('Sample inputs must match.');
  const all=Object.keys(measurements);
  const frame=(at,phase,message,measured,tone='neutral')=>({at,phase,message,measured,tone});
  return {schemaVersion:1,task:task.id,recordedAt:verificationBatch.assessment.completedAt,sourceBuild:evidence.build,sourceEnvironment:evidence.environment ?? 'cloudflare',
    sourceSha256:createHash('sha256').update(raw).digest('hex'),duration:36,selectedMeasurement,measurements,
    ...(task.modelReleases?{modelReleases:task.modelReleases,releaseWindow:task.releaseWindow}:{}),
    verification:{matches:verificationCount,samples:verificationCount},
    example:{input:sample.input ?? sample.email,fixtureId:sample.fixtureId,expected:sample.expected,before:sample.output,after:after.output,
      ...(after.decision?{nativeDecision:after.decision}:{}),...(task.workflow?{beforeTrace:sample.trace,afterTrace:after.trace}:{})},
    frames:[
      frame(0,'setup','Check the prepared rubric, application adapters, and measurement collectors.',[]),
      frame(4,'baseline',`${baseline.name}: ${baseline.matches}/${baseline.samples} fixture matches.`,['baseline']),
      frame(11,'trials',`${selected.name}: ${selected.matches}/${selected.samples} fixture matches at lower measured cost.`,all,'good'),
      frame(18,'proposal',task.workflow?`OpenMerit proposes ${selected.name}. The original route stays unchanged.`:`OpenMerit proposes ${selected.name}. The original application remains on ${baseline.name}.`,all),
      frame(23,'approved','The operator approved this change in the recorded run.',all),
      frame(27,'applied',`Pi changes the managed application configuration to ${selected.name}.`,all,'good'),
      frame(31,'verified',`The changed application passes ${verificationCount}/${verificationCount} separate verification fixtures.`,all,'good'),
      frame(36,'complete',`${baseline.name} stays fixed; the managed application now uses ${selected.name}.`,all,'good'),
    ]};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [source,destination]=process.argv.slice(2);
  if(!source || !destination) throw new Error('Usage: node demo/recording.mjs evidence.json recording.json');
  const recording=makeRecording(await readFile(source,'utf8'));
  await writeFile(destination,JSON.stringify(recording,null,2)+'\n');
  console.log(`Recorded ${recording.task}: ${recording.measurements[recording.selectedMeasurement].name}; source SHA-256 ${recording.sourceSha256}`);
}
