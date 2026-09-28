import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRecording } from '../recording.mjs';
import {agentRoutes} from '../runtime/config.mjs';
function source() {
  const batch=(model,n)=>({assessment:{modelId:model,completedAt:'2026-09-28T00:00:00.000Z'},runs:Array.from({length:n},(_,i)=>({fixtureId:`test-${i}`,input:`synthetic test ${i}`,expected:{decision:'publish'},output:{decision:'publish'},passed:true,cost:model.includes('jev')?.00001:.0001,latencyMs:500}))});
  return {task:'spam',build:'unit-test-only',files:{'openmerit-state.json':{cycle:{stage:'swap_verified'}},'configuration-diff.json':{before:{model:'openai/gpt-4.1-mini'},after:{model:'typesafe/jev-1.13'},approvedAt:'2026-09-28T00:00:00.000Z'},'baseline.json':batch('openai/gpt-4.1-mini',24),'trial-1.json':batch('typesafe/jev-1.13',24),'verification.json':batch('typesafe/jev-1.13',6)}};
}
test('recording curation refuses partial, unapproved, regressed, or unmeasured runs',()=>{
  const data=source();const result=makeRecording(JSON.stringify(data));assert.equal(result.selectedMeasurement,'trial-1');
  for(const mutate of [
    x=>x.files['openmerit-state.json'].cycle.stage='frontier_ready',
    x=>delete x.files['configuration-diff.json'].approvedAt,
    x=>x.files['baseline.json'].runs.pop(),
    x=>delete x.files['trial-1.json'].runs[0].cost,
    x=>x.files['verification.json'].runs[0].passed=false,
    x=>x.files['rollback.json']={restored:true},
    x=>x.files['trial-1.json'].runs.forEach(r=>r.cost=.001),
  ]) {const bad=source();mutate(bad);assert.throws(()=>makeRecording(JSON.stringify(bad)));}
});

test('agent recordings derive assignments from matching provider calls, including verification',()=>{
  const batch=(route,n)=>({assessment:{modelId:route.id,completedAt:'2026-09-28T00:00:00.000Z'},runs:Array.from({length:n},(_,i)=>({
    fixtureId:`test-${i}`,input:`synthetic goal ${i}`,expected:{status:'resume'},output:{status:'resume'},passed:true,
    cost:route===agentRoutes[0] ? .001 : .0005,latencyMs:3000,
    checks:{tool_use_performance:1,structured_output_reliability:1,instruction_following:1,retrieval_use_quality:1},
    calls:route.steps.map(s=>({model:s.model})),trace:route.steps.map(s=>({task:s.task,model:s.model,ok:true})),
  }))});
  const source=()=>({task:'backfill',build:'unit-test-only',files:{
    'openmerit-state.json':{cycle:{stage:'swap_verified'}},
    'configuration-diff.json':{before:{model:agentRoutes[0].id},after:{model:agentRoutes[1].id},approvedAt:'2026-09-28T00:00:00Z'},
    'baseline.json':batch(agentRoutes[0],8),'trial-1.json':batch(agentRoutes[1],8),'verification.json':batch(agentRoutes[1],6),
  }});
  const recording=makeRecording(JSON.stringify(source()));
  assert.deepEqual(recording.measurements['trial-1'].steps,agentRoutes[1].steps);
  for(const [file,field] of [['trial-1.json','calls'],['trial-1.json','trace'],['verification.json','calls']]) {
    const bad=source();bad.files[file].runs[0][field][0].model='openai/gpt-4.1-mini';
    assert.throws(()=>makeRecording(JSON.stringify(bad)),/models/);
  }
});
