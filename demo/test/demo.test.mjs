import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, verification, smoke, grade } from '../runtime/fixtures.mjs';
import { confirmedProfile, targetId } from '../runtime/config.mjs';
import { calculateComparison } from '../runtime/comparison.mjs';
import { verifyFrontierSnapshot } from '../../dist/core/src/index.js';
import { classify } from '../runtime/application.mjs';
import { inferenceRequest, limitedText, readSessionCookie } from '../security.mjs';

const date = '2026-09-28T00:00:00.000Z';
const profile = confirmedProfile(date, fixtures.length);
const evidence = { id:'test-evidence', source:'evaluation_artifact', uri:'file:///test/observations.json' };
function assessment(id, success, cost, latency, sampleCount=24) {
  return { id:`assessment-${id}`, candidateId:id, modelId:id, targetId, taskProfileId:profile.id, taskProfileRevision:1,
    productRevision:'test', harnessId:'pi', startedAt:date, completedAt:date,
    metrics:[['task_success',success,'maximize','ratio'],['total_task_cost',cost,'minimize','usd'],['end_to_end_task_latency',latency,'minimize','milliseconds']].map(([metricId,value,direction,unit])=>({ targetId, metricId, value, direction, unit, sampleCount, state:'measured', scope:'sample_window', method:'derived', aggregation:metricId==='total_task_cost'?'sum':metricId==='task_success'?'rate':'mean', evidence:[evidence] })) };
}
test('fixture partitions are disjoint and grading rejects missing, wrong, and extra fields',()=>{
  assert.equal(fixtures.length,24); assert.equal(verification.length,6);
  const all=[smoke,...fixtures,...verification];
  assert.equal(new Set(all.map(f=>f.id)).size,all.length);
  assert.equal(new Set(all.map(f=>f.email)).size,all.length);
  assert.equal(grade({...fixtures[0].expected},fixtures[0].expected),true);
  assert.equal(grade({...fixtures[0].expected,urgency:'high'},fixtures[0].expected),false);
  assert.equal(grade({...fixtures[0].expected,explanation:'extra'},fixtures[0].expected),false);
  assert.equal(grade(null,fixtures[0].expected),false);
});
test('independent OpenMerit verifier accepts cheaper qualified candidate and excludes quality failure',()=>{
  const assessments=[assessment('incumbent',1,.04,1200),assessment('cheap-failing',.7,.008,400),assessment('qualified',1,.01,600)];
  const result=calculateComparison(profile,assessments,evidence,'incumbent',date);
  assert.deepEqual(verifyFrontierSnapshot(profile,assessments,result.frontierSnapshot),{valid:true,errors:[]});
  assert.deepEqual(result.frontierSnapshot.ineligibleCandidateIds,['cheap-failing']);
  assert.equal(result.recommendation.selectedCandidateId,'qualified');
  const forged={...result.frontierSnapshot,frontierCandidateIds:['cheap-failing']};
  assert.equal(verifyFrontierSnapshot(profile,assessments,forged).valid,false);
});
test('keeping the incumbent is valid; immature samples stay unresolved',()=>{
  const assessments=[assessment('incumbent',1,.01,1200),assessment('expensive',1,.04,700),assessment('immature',1,.001,400,1)];
  const result=calculateComparison(profile,assessments,evidence,'incumbent',date);
  assert.equal(result.recommendation,undefined);
  assert.deepEqual(result.frontierSnapshot.unresolvedCandidateIds,['immature']);
  assert.equal(verifyFrontierSnapshot(profile,assessments,result.frontierSnapshot).valid,true);
});
test('proxy pins models and pricing, caps output, and strips routing overrides',()=>{
  assert.throws(()=>inferenceRequest({model:'unapproved',messages:[{role:'user',content:'x'}]},100),/not allowed/);
  const {body,reservation}=inferenceRequest({model:'openai/gpt-4.1-mini',messages:[{role:'user',content:'test'}],max_tokens:100000,stream:true,provider:{max_price:{completion:999}},plugins:[{id:'web'}]},300);
  assert.equal(body.max_tokens,8192); assert.equal(body.plugins,undefined);
  assert.equal(body.provider.max_price.completion,3); assert.ok(reservation>0);
  assert.throws(()=>inferenceRequest({...body},180001),/oversized/);
});
test('streamed bodies cannot bypass the input limit and session cookies require a full random ID',async()=>{
  await assert.rejects(limitedText(new Request('https://example.test',{method:'POST',body:'abcdef'}),5),/too large/);
  const id='a'.repeat(64);
  assert.equal(readSessionCookie(new Request('https://x',{headers:{Cookie:`x=1; openmerit_demo=${id}; y=2`}})),id);
  assert.equal(readSessionCookie(new Request('https://x',{headers:{Cookie:'openmerit_demo=../../other'}})),null);
});
test('application counts invalid JSON as a failure but never invents missing provider cost',async t=>{
  let data={id:'generation-test',choices:[{message:{content:'invalid JSON'}}],usage:{cost:0.002,prompt_tokens:20,completion_tokens:10}};
  t.mock.method(globalThis,'fetch',async()=>Response.json(data));
  const result=await classify('test email','openai/gpt-4.1-mini',{key:'test-key'});
  assert.equal(result.output,null); assert.equal(result.cost,.002);
  data={...data,usage:{prompt_tokens:20,completion_tokens:10}};
  await assert.rejects(classify('test email','openai/gpt-4.1-mini',{key:'test-key'}),/cost was missing/);
});
