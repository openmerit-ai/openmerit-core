import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixtures,verification,smoke,runWorkflow,grade} from '../runtime/fieldkit.mjs';
import {kitRoutes} from '../runtime/fieldkit-models.mjs';
import {getTask,providerModels,taskPolicy} from '../runtime/config.mjs';
import {classify} from '../runtime/application.mjs';
import {inferenceRequest} from '../security.mjs';
import {makeRecording} from '../recording.mjs';

const responses=f=>['Recording lasts four hours, starts at 10:00, must finish by 16:00. Uploading is forbidden.',f.label,f.manual,f.code,f.decision,f.expected];
test('field-kit fixtures cover all six constraints and keep verification disjoint',async()=>{
  assert.equal(fixtures.length,4);assert.equal(verification.length,4);
  assert.deepEqual(fixtures.map(f=>f.expected.blockers),[[],['battery','storage'],['network','sample_rate'],['deadline','connector']]);
  assert.deepEqual(verification.map(f=>f.expected.blockers),[[],['battery'],['network','sample_rate'],['deadline','connector']]);
  assert.equal(new Set([...fixtures,...verification].map(f=>f.kitId)).size,8);
  for(const f of [smoke,...fixtures,...verification]) {
    const png=await readFile(new URL(`../runtime/fieldkit-labels/${f.kitId}.png`,import.meta.url));
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.ok(grade(f.expected,f.expected));
    assert.equal(grade({...f.expected,evidence:['invented']},f.expected),false);
  }
});

test('field-kit provider requests use six distinct actual models and modality-specific adapters',async t=>{
  const f=fixtures[0],seen=[],outputs=responses(f),route=kitRoutes[1];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body);const output=outputs[seen.length-1];
    return Response.json({model:body.model,choices:[{message:{content:typeof output==='string'?output:JSON.stringify(output)},finish_reason:'stop'}],usage:{cost:.0001,prompt_tokens:10,completion_tokens:20}});
  });
  const result=await classify(f.input,route.id,{task:'fieldkit',key:'test-only'});
  assert.deepEqual(seen.map(b=>b.model),route.steps.map(s=>s.model));
  assert.deepEqual(seen.map(b=>b.max_tokens),[180,180,180,180,2048,350]);
  assert.equal(seen[0].response_format,undefined);assert.equal(seen[0].reasoning,undefined);
  assert.ok(seen[1].messages[1].content.some(c=>c.type==='image_url' && c.image_url.url.startsWith('data:image/png;base64,')));
  assert.equal(seen[2].messages[0].content,f.manualHtml);assert.equal(seen[2].reasoning,undefined);
  assert.equal(seen[2].response_format.json_schema.name,'active_manual_profile');
  assert.equal(seen[3].response_format,undefined);assert.match(seen[3].messages[1].content,/UPLOAD_ENABLED = not LOCAL_ONLY/);
  assert.match(seen[4].messages[1].content,/translated_brief/);assert.match(seen[4].messages[1].content,/capture_script/);
  assert.deepEqual(JSON.parse(seen[5].messages[1].content).decision,f.decision);
  assert.ok(grade(result.output,f.expected));assert.ok(Object.values(result.checks).every(v=>v===1));
  assert.equal(result.calls.length,6);assert.equal(result.trace.length,6);assert.ok(Math.abs(result.cost-.0006)<1e-12);
  assert.equal(result.inputTokens,60);assert.equal(result.outputTokens,120);
});

test('intermediate failures cannot be hidden by a correct final answer or silently repaired',async()=>{
  const f=fixtures[0];
  for(const index of [1,2,3,4]) {
    const outputs=responses(f);outputs[index]=index===3?{...f.code,upload_enabled:true}:null;
    let called=0;const seen=[];
    const result=await runWorkflow(f.input,kitRoutes[1],async(messages)=>{
      seen.push(messages);return {output:outputs[called++],cost:.0001};
    });
    assert.equal(called,6);assert.equal(result.trace[index].ok,false);assert.equal(result.checks.instruction_following,0);
    assert.equal(grade(result.output,f.expected),true); // batch success still requires every stage check.
    if(index===3) assert.equal(JSON.parse(seen[4][1].content).capture_script.upload_enabled,true);
  }
});

test('unknown kits stop before inference and both routes remain heterogeneous and bounded',async()=>{
  await assert.rejects(runWorkflow('KIT-9999',kitRoutes[1],()=>{throw new Error('Must not call inference');}),/prepared kit/);
  const task=getTask('fieldkit');
  for(const route of task.models) assert.equal(new Set(route.steps.map(s=>s.model)).size,6);
  assert.equal(task.models[0].steps.filter((s,i)=>s.model!==task.models[1].steps[i].model).length,5);
  assert.equal(task.models[0].steps[4].model,task.models[1].steps[4].model);
  assert.equal(task.modelReleases.length,11);
  assert.equal(taskPolicy('fieldkit').checkPolicy.postSwapVerification.afterCompletedTasks,4);
  assert.equal(taskPolicy('placement').checkPolicy.postSwapVerification.afterCompletedTasks,6);
  for(const model of providerModels(task)) {
    assert.equal(inferenceRequest({model,messages:[{role:'user',content:'synthetic'}],max_tokens:4000},100,'fieldkit').body.max_tokens,2048);
    assert.throws(()=>inferenceRequest({model,messages:[{role:'user',content:'synthetic'}]},100,'support'),/not allowed/);
  }
  assert.throws(()=>inferenceRequest({model:kitRoutes[0].id,messages:[]},100,'fieldkit'),/not allowed/);
  for(const m of task.modelReleases) assert.ok(m.releasedAt>=task.releaseWindow.from && m.releasedAt<=task.releaseWindow.through);
});

test('six-task curation requires all six provider assignments and four fresh complete goals',()=>{
  const batch=(route,n)=>({assessment:{modelId:route.id,completedAt:'2026-09-28T00:00:00Z'},runs:Array.from({length:n},(_,i)=>({fixtureId:`fixture-${i}`,input:'synthetic unit test',expected:fixtures[0].expected,output:fixtures[0].expected,passed:true,cost:route===kitRoutes[0]?.003:.001,latencyMs:12000,
    checks:{tool_use_performance:1,structured_output_reliability:1,instruction_following:1,retrieval_use_quality:1},calls:route.steps.map(s=>({model:s.model})),trace:route.steps.map(s=>({task:s.task,model:s.model}))}))});
  const source=()=>({task:'fieldkit',build:'unit-test-only',files:{'openmerit-state.json':{cycle:{stage:'swap_verified'}},'configuration-diff.json':{before:{model:kitRoutes[0].id},after:{model:kitRoutes[1].id},approvedAt:'2026-09-28T00:00:00Z'},'baseline.json':batch(kitRoutes[0],4),'trial-1.json':batch(kitRoutes[1],4),'verification.json':batch(kitRoutes[1],4)}});
  const result=makeRecording(JSON.stringify(source()));assert.equal(result.verification.samples,4);assert.equal(result.measurements.baseline.steps.length,6);
  for(const mutation of [x=>x.files['verification.json'].runs.pop(),x=>x.files['trial-1.json'].runs[0].calls.pop(),x=>x.files['verification.json'].runs[0].trace[5].model='invented',x=>x.files['trial-1.json'].runs[0].checks.instruction_following=0]) {
    const bad=source();mutation(bad);assert.throws(()=>makeRecording(JSON.stringify(bad)));
  }
});
