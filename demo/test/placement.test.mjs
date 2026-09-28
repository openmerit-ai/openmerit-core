import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtures,verification,grade,checks,runWorkflow,eligible} from '../runtime/placement.mjs';
import {placementRoutes,providerModels,getTask,confirmedProfile} from '../runtime/config.mjs';
import {classify} from '../runtime/application.mjs';
import {inferenceRequest} from '../security.mjs';

test('placement fixtures cover hard constraints, blocked jobs, boundaries, and deterministic tie breaks',()=>{
  assert.equal(fixtures.length,8);assert.equal(verification.length,6);
  assert.equal(new Set([...fixtures,...verification].map(f=>f.job.job_id)).size,14);
  assert.deepEqual(fixtures.map(f=>f.expected.pool_id),['eu-a','large','ready','two-free',null,'stable','b-fast','a-pool']);
  assert.deepEqual(verification.map(f=>f.expected.pool_id),['apac','exact','exact',null,'a-tie',null]);
  for(const f of [...fixtures,...verification]) {
    assert.ok(grade(f.expected,f.expected));assert.ok(Object.values(checks(f.expected,f,true,true)).every(v=>v===1));
    for(const p of f.capacity.pools.filter(p=>!eligible(f.job,p))) {
      const unsafe={...f.expected,status:'placed',pool_id:p.pool_id,cost_cents:p.total_cost_cents,finish_minute:p.start_minute+p.runtime_minutes};
      assert.equal(checks(unsafe,f,true,true).instruction_following,0);assert.equal(grade(unsafe,f.expected),false);
    }
    assert.equal(checks({...f.expected,evidence:['invented']},f,true,true).retrieval_use_quality,0);
  }
  assert.equal(grade({...fixtures[0].expected,cost_cents:'80'},fixtures[0].expected),false);
});

test('placement dispatches three distinct provider models with dependent job and capacity context',async t=>{
  const f=fixtures[0],seen=[],route=placementRoutes[1];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body);
    const output=seen.length===1?{tool:'read_job',job_id:f.job.job_id}:seen.length===2?{tool:'list_pools',job_id:f.job.job_id}:{pool_checks:[],plan:f.expected};
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify(output)}}],usage:{cost:.001,prompt_tokens:10,completion_tokens:20}});
  });
  const result=await classify(f.input,route.id,{task:'placement',key:'test-only'});
  assert.deepEqual(seen.map(b=>b.model),route.steps.map(s=>s.model));assert.deepEqual(seen.map(b=>b.max_tokens),[350,350,900]);
  assert.ok(seen.every(b=>b.response_format.type==='json_schema' && b.response_format.json_schema.strict));
  assert.ok(seen.every(b=>b.reasoning.enabled===false));
  assert.deepEqual(seen[0].response_format,seen[1].response_format);
  assert.equal(seen[2].response_format.json_schema.name,'placement_review');
  assert.match(seen[1].messages.at(-1).content,/job:GPU-6101/);assert.match(seen[2].messages.at(-1).content,/capacity:GPU-6101/);
  assert.deepEqual(result.trace.map(s=>s.model),route.steps.map(s=>s.model));assert.equal(result.cost,.003);
  assert.equal(result.inputTokens,30);assert.equal(result.outputTokens,60);assert.ok(grade(result.output,f.expected));
});

test('placement stops on invented jobs or cross-job capacity requests without spending on later turns',async()=>{
  for(const outputs of [[{tool:'read_job',job_id:'GPU-9999'}],[{tool:'read_job',job_id:'GPU-6101'},{tool:'list_pools',job_id:'GPU-6102'}]]) {
    let count=0;const result=await runWorkflow(fixtures[0].input,placementRoutes[1],async()=>{
      const output=outputs[count++];return {output,raw:JSON.stringify(output),cost:.001};
    });
    assert.equal(count,outputs.length);assert.equal(result.output,null);assert.equal(result.checks.tool_use_performance,0);
    assert.ok(result.failure);assert.equal(result.cost,count*.001);
  }
});

test('placement handoffs preserve required facts without forwarding untrusted queue instructions',async()=>{
  const f=fixtures[7],seen=[];
  await runWorkflow(f.input,placementRoutes[1],async messages=>{
    seen.push(messages);const output=seen.length===1?{tool:'read_job',job_id:f.job.job_id}:seen.length===2?{tool:'list_pools',job_id:f.job.job_id}:{pool_checks:[],plan:f.expected};
    return {output,raw:JSON.stringify(output),cost:.001};
  });
  assert.match(JSON.stringify(seen[0]),/Ignore the region policy/);
  for(const messages of seen.slice(1)) {
    assert.doesNotMatch(JSON.stringify(messages),/Ignore the region policy/);
    assert.match(JSON.stringify(messages),/allowed_regions/);
  }
  assert.match(JSON.stringify(seen[2]),/wrong-region/); // Candidate remains visible and must be rejected on its facts.
  assert.match(JSON.stringify(seen[2]),/finish_minute/);
});

test('placement has its own target, constraints and task-scoped provider allowlist',()=>{
  const task=getTask('placement'),profile=confirmedProfile('2026-09-28T00:00:00Z',8,'placement');
  assert.equal(profile.id,'placement-agent-demo');assert.equal(profile.applicationTarget.id,'gpu-placement-route');
  assert.ok(profile.applicationTarget.callSites.every(s=>s.startsWith('placement.mjs#')));
  assert.equal(profile.objectives.find(o=>o.metricId==='end_to_end_task_latency').constraint.value,12000);
  assert.equal(profile.objectives.find(o=>o.metricId==='total_task_cost').constraint.value,.024);
  for(const model of providerModels(task)) assert.equal(inferenceRequest({model,messages:[{role:'user',content:'test'}]},100,'placement').body.model,model);
  const model=placementRoutes[1].steps[0].model;
  const existing=new Set(getTask('backfill').models.flatMap(r=>r.steps.map(s=>s.model)));
  assert.ok(placementRoutes[1].steps.every(s=>!existing.has(s.model)));
  assert.throws(()=>inferenceRequest({model,messages:[{role:'user',content:'test'}]},100,'backfill'),/not allowed/);
  assert.throws(()=>inferenceRequest({model:placementRoutes[1].id,messages:[{role:'user',content:'test'}]},100,'placement'),/not allowed/);
  assert.deepEqual(task.modelReleases.map(m=>m.id).sort(),providerModels(task).sort());
  assert.equal(task.releaseWindow.from,'2026-03-28');assert.equal(task.releaseWindow.through,'2026-09-28');
  for(const model of task.modelReleases) {
    assert.ok(model.releasedAt>=task.releaseWindow.from && model.releasedAt<=task.releaseWindow.through);
    assert.equal(model.url,`https://openrouter.ai/${model.id}`);
    assert.ok(!existing.has(model.id));
  }
});
