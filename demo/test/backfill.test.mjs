import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtures,verification,grade,checks,runWorkflow} from '../runtime/backfill.mjs';
import {confirmedProfile,taskPolicy,agentRoutes,applicationConfig,getTask} from '../runtime/config.mjs';
import {calculateComparison} from '../runtime/comparison.mjs';
import {inferenceRequest} from '../security.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('recovery fixtures cover duplicate prevention, non-contiguous checkpoints, quarantine and unknown failures',()=>{
  assert.equal(fixtures.length,8);assert.equal(verification.length,6);
  assert.equal(new Set([...fixtures,...verification].map(f=>f.job.job_id)).size,14);
  for(const f of [...fixtures,...verification]) {
    assert.ok(grade(f.expected,f.expected));
    assert.ok(Object.values(checks(f.expected,f,true,true)).every(v=>v===1));
    const unsafe={...f.expected,replay:[...f.ledger.committed,999]};
    assert.equal(checks(unsafe,f,true,true).instruction_following,0);
    assert.equal(grade(unsafe,f.expected),false);
    assert.equal(checks({...f.expected,evidence:['invented']},f,true,true).retrieval_use_quality,0);
  }
  assert.deepEqual(fixtures[4].expected.replay,[1,3]);
  assert.deepEqual(fixtures[5].expected.quarantine,[0]);
  assert.equal(fixtures[3].expected.status,'complete');
  assert.equal(fixtures[7].expected.status,'investigate');
});

test('agent executes dependent tool requests and accounts for every model call',async()=>{
  const f=fixtures[0],seen=[];
  const outputs=[{tool:'inspect_job',job_id:f.job.job_id},{tool:'read_checkpoint',job_id:f.job.job_id},f.expected];
  const result=await runWorkflow(f.input,'test-model',async messages=>{
    seen.push(structuredClone(messages));const output=outputs[seen.length-1];
    return {output,raw:JSON.stringify(output),cost:.001,inputTokens:10,outputTokens:5};
  });
  assert.equal(seen.length,3);assert.match(seen[1].at(-1).content,/incident:BF-4101/);assert.match(seen[2].at(-1).content,/"committed":\[0,1,2\]/);
  assert.equal(result.cost,.003);assert.equal(result.inputTokens,30);assert.equal(result.outputTokens,15);
  assert.equal(result.trace.length,3);assert.equal(result.calls.length,3);
  assert.ok(grade(result.output,f.expected));assert.ok(Object.values(result.checks).every(v=>v===1));
});

test('wrong or fabricated tool calls stop the agent and cannot become a successful cheap run',async()=>{
  const f=fixtures[0];let calls=0;
  const result=await runWorkflow(f.input,'test-model',async()=>{
    calls++;const output={tool:'delete_partitions',job_id:f.job.job_id};return {output,raw:JSON.stringify(output),cost:.00001};
  });
  assert.equal(calls,1);assert.equal(result.output,null);assert.equal(result.checks.tool_use_performance,0);assert.equal(result.checks.instruction_following,0);
  assert.equal(grade(result.output,f.expected),false);
});

test('whole-goal constraints exclude cheap unsafe or ungrounded agents',()=>{
  const profile=confirmedProfile('2026-09-28T00:00:00Z',8,'backfill');
  assert.equal(taskPolicy('backfill').checkPolicy.baselineAssessment.afterCompletedTasks,8);
  assert.equal(inferenceRequest({model:'openai/gpt-4.1-mini',max_tokens:8192,messages:[{role:'user',content:'test'}]},100,'backfill').body.max_tokens,2048);
  assert.equal(profile.applicationTarget.callSites.length,3);
  const make=(id,cost,overrides={})=>({id,candidateId:id,productRevision:'test',metrics:profile.objectives.map(o=>({metricId:o.metricId,state:'measured',sampleCount:8,evidence:[{id:'test'}],unit:o.metricId==='total_task_cost'?'usd':o.metricId==='end_to_end_task_latency'?'milliseconds':'ratio',direction:['total_task_cost','end_to_end_task_latency'].includes(o.metricId)?'minimize':'maximize',value:overrides[o.metricId] ?? (o.metricId==='total_task_cost'?cost:o.metricId==='end_to_end_task_latency'?4000:1)}))});
  const result=calculateComparison(profile,[make('incumbent',.002),make('unsafe',.0001,{instruction_following:.875}),make('ungrounded',.0002,{retrieval_use_quality:.875}),make('over-budget',.03),make('candidate-1',.0005)],{id:'evidence'},'incumbent');
  assert.deepEqual(result.frontierSnapshot.ineligibleCandidateIds,['unsafe','ungrounded','over-budget']);
  assert.equal(result.recommendation.selectedCandidateId,'candidate-1');
});

test('measured agent batches attach actual tool traces with the evidence type required by Pi',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'openmerit-agent-test-'));
  const oldTask=process.env.DEMO_TASK,oldRoot=process.env.DEMO_WORKSPACE,oldKey=process.env.DEMO_PROXY_TOKEN;
  process.env.DEMO_TASK='backfill';process.env.DEMO_WORKSPACE=dir;process.env.DEMO_PROXY_TOKEN='test-only';
  t.after(async()=>{for(const [key,value] of [['DEMO_TASK',oldTask],['DEMO_WORKSPACE',oldRoot],['DEMO_PROXY_TOKEN',oldKey]]) value===undefined?delete process.env[key]:process.env[key]=value;await rm(dir,{recursive:true,force:true});});
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body),f=fixtures.find(f=>body.messages[1].content===f.input),last=body.messages.at(-1).content;
    const output=last.startsWith('Task 1')?{tool:'inspect_job',job_id:f.job.job_id}:last.includes('Task 2')?{tool:'read_checkpoint',job_id:f.job.job_id}:f.expected;
    return Response.json({choices:[{message:{content:JSON.stringify(output)}}],usage:{cost:.001,prompt_tokens:20,completion_tokens:10}});
  });
  const {runBatch}=await import('../runtime/work.mjs');
  const batch=await runBatch('openai/gpt-4.1-mini',fixtures.slice(0,2),'regression',confirmedProfile('2026-09-28T00:00:00Z',2,'backfill'));
  assert.ok(batch.runs.every(r=>r.passed));
  assert.equal(batch.assessment.metrics.find(m=>m.metricId==='total_task_cost').value,.006);
  const ref=batch.assessment.metrics.find(m=>m.metricId==='tool_use_performance').evidence[0];
  assert.equal(ref.source,'harness_trace');
  const trace=JSON.parse(await readFile(new URL(ref.uri),'utf8'));
  assert.equal(trace.runs.length,2);assert.equal(trace.runs[0].calls.length,3);assert.equal(trace.runs[0].trace[1].request.tool,'read_checkpoint');
});

test('mixed route sends each dependent turn to its configured provider model',async t=>{
  const {classify}=await import('../runtime/application.mjs');
  const selected=agentRoutes[1],f=fixtures[0],seen=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body);
    const output=seen.length===1?{tool:'inspect_job',job_id:f.job.job_id}:seen.length===2?{tool:'read_checkpoint',job_id:f.job.job_id}:f.expected;
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify(output)}}],usage:{cost:.001}});
  });
  const result=await classify(f.input,selected.id,{task:'backfill',key:'test-only'});
  assert.deepEqual(seen.map(b=>b.model),selected.steps.map(s=>s.model));
  assert.equal(new Set(seen.map(b=>b.model)).size,3);
  assert.match(seen[2].messages.at(-1).content,/ledger:BF-4101/);
  assert.deepEqual(result.trace.map(s=>s.model),selected.steps.map(s=>s.model));
  assert.deepEqual(result.calls.map(c=>c.model),selected.steps.map(s=>s.model));
  assert.equal(result.cost,.003);assert.ok(grade(result.output,f.expected));
  for(const step of selected.steps) assert.equal(inferenceRequest({model:step.model,messages:[{role:'user',content:'test'}]},100,'backfill').body.model,step.model);
  assert.throws(()=>inferenceRequest({model:selected.id,messages:[{role:'user',content:'test'}]},100,'backfill'),/not allowed/);
  assert.deepEqual(applicationConfig(getTask('backfill'),selected.id).steps,selected.steps);
  assert.deepEqual(applicationConfig(getTask('backfill'),agentRoutes[0].id).steps.map(s=>s.model),Array(3).fill(agentRoutes[0].id));
});
