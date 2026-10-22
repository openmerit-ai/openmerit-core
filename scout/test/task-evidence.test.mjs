import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredCandidates } from '../task-evidence.mjs';
import { orderCandidates, taskWeights, compareQuality } from '../comparison.mjs';
import { buildEvidence } from '../experiments/build-task-evidence.mjs';
const now=Date.parse('2026-10-14T20:00:00Z');
const task={kind:'extract',outputFormat:'json',weights:{structured:3},needsStructured:true,workload:{input:'short',output:'short',priority:'balanced'}};
function fixture() {
 const candidates=Array.from({length:6},(_,i)=>({model:{id:`provider/${i}`,inputPrice:9-i,outputPrice:9-i},evidence:[]}));
 const profile={id:'fixture',label:'Text extraction',split:'calibration',measuredAt:new Date(now-1000).toISOString(),casesPerModel:8,scope:{kind:'extract',vision:false,tools:false,structured:true,outputFormat:'json',input:'short',output:'short',capabilities:['structured']},models:candidates.map((c,i)=>({id:c.model.id,cases:8,quality:1-i*.1,meanCostUsd:1+i,medianSeconds:1+i}))};
 return {candidates,data:{version:1,profiles:[profile]}};
}
test('all five positions use measured task performance rather than model identity or advertised price',()=>{
 for (const prefix of ['provider/','renamed/']) {
  const {candidates,data}=fixture();for(const c of candidates)c.model.id=c.model.id.replace('provider/',prefix);for(const m of data.profiles[0].models)m.id=m.id.replace('provider/',prefix);
  const match=measuredCandidates(candidates.reverse(),task,now,data);orderCandidates(match.candidates,task);
  assert.deepEqual(match.candidates.slice(0,5).map(c=>c.model.id),[0,1,2,3,4].map(i=>prefix+i));
 }
});
test('small proxy leads cannot overwhelm a large price and latency premium',()=>{
 const e=score=>[{benchmark:'same',score,definition:{name:'same',tags:['structured']}}];
 const cheap={model:{id:'cheap',inputPrice:1,outputPrice:1,speed:{timeToFirstAnswer:1,tokensPerSecond:128}},evidence:e(.9)};
 const expensive={model:{id:'expensive',inputPrice:10,outputPrice:10,speed:{timeToFirstAnswer:10,tokensPerSecond:128}},evidence:e(.91)};
 assert.equal(compareQuality(cheap,expensive,task.weights).preference,.5);
 const list=[expensive,cheap];orderCandidates(list,task);assert.equal(list[0].model.id,'cheap');
 assert.deepEqual(taskWeights({...task,weights:{structured:3,reasoning:1}}),{structured:3,reasoning:1});
});
test('measured evidence cannot leak across modalities, workload, retention or substantive capabilities',()=>{
 for (const change of [{kind:'other'},{needsVision:true},{needsTools:true},{needsMemory:true},{requirements:{memory:'session'}},{weights:{structured:3,math:3}},{weights:{structured:3,agents:1}},{workload:{input:'long',output:'short'}},{needsStructured:false}]) {
  const {candidates,data}=fixture();assert.equal(measuredCandidates(candidates,{...task,...change},now,data),null);
 }
});
test('uncertain operation, output or format cannot inherit a narrow measured profile',()=>{
 for(const field of ['task_kind','result_type','json']) {
  const {candidates,data}=fixture();
  assert.equal(measuredCandidates(candidates,{...task,uncertainty:[field]},now,data),null);
 }
 const {candidates,data}=fixture();
 assert.ok(measuredCandidates(candidates,{...task,uncertainty:['priority']},now,data));
});
test('expired, future, held-out, undersampled and unavailable pools fall back without padding',()=>{
 for(const mutate of [p=>p.measuredAt=new Date(now-31*86400_000).toISOString(),p=>p.measuredAt=new Date(now+1).toISOString(),p=>p.split='holdout',p=>p.models=p.models.slice(0,4),p=>p.models.forEach(m=>m.cases=5)]) {
  const {candidates,data}=fixture();mutate(data.profiles[0]);assert.equal(measuredCandidates(candidates,task,now,data),null);
 }
 const {candidates,data}=fixture();assert.equal(measuredCandidates(candidates.slice(0,4),task,now,data),null);
});
test('unknown measured charges never become free calls',()=>{
 const {candidates,data}=fixture();data.profiles[0].models.forEach(m=>Object.assign(m,{quality:1,medianSeconds:1,meanCostUsd:1}));data.profiles[0].models[0].meanCostUsd=null;
 const result=measuredCandidates(candidates,task,now,data);orderCandidates(result.candidates,task);assert.equal(result.candidates.at(-1).model.id,'provider/0');assert.equal(result.candidates.at(-1).reference.cost,null);
});
test('evidence builder rejects held-out rows, duplicate observations and unplanned model IDs',()=>{
 const manifest={tasks:[{id:'t',models:['a'],cases:[{id:'train',split:'calibration'},{id:'test',split:'holdout'}]}]};
 for(const rows of [[{task:'t',caseId:'test',model:'a'}],[{task:'t',caseId:'train',model:'other'}],Array(2).fill({task:'t',caseId:'train',model:'a'})]) assert.throws(()=>buildEvidence(manifest,rows,'hash'),/calibration/);
});

test('direct task evidence can establish an otherwise unmeasured capability while catalogue requirements still apply',async()=>{
 const {recommend,createIndex}=await import('../rank.mjs');
 const {candidates,data}=fixture();
 const snapshot={version:1,checkedAt:new Date(now).toISOString(),sources:[],benchmarks:[],models:candidates.map(c=>({...c.model,name:c.model.id,provider:'provider',modalities:['text'],outputModalities:['text'],parameters:['response_format'],context:10000,evidence:[]}))};
 const t={...task,capabilities:[{id:'structured',label:'Structured output'}]};
 const result=recommend(createIndex(snapshot),'Extract fields as JSON',now,t,data);
 assert.equal(result.ranking.mode,'measured');assert.equal(result.recommendations.length,5);assert.equal(result.ranking.benchmarkEligibleModels,0);
 snapshot.models[0].parameters=[];snapshot.models[1].parameters=[];
 const sparse=recommend(createIndex(snapshot),'Extract fields as JSON',now,t,data);assert.equal(sparse.ranking.mode,'benchmarks');assert.equal(sparse.recommendations.length,0);
});

test('repeated route failures cap other task scores; one isolated failure does not',()=>{
 const ids=['a','b','c','d','e'],cases=Array.from({length:6},(_,i)=>({id:String(i),split:'calibration'}));
 const manifest={tasks:[{id:'quality',models:ids,cases,task},{id:'health',models:ids,cases:cases.slice(0,4),healthOnly:true}]};
 const rows=manifest.tasks.flatMap(t=>t.models.flatMap(model=>t.cases.map(c=>({task:t.id,caseId:c.id,model,startedAt:new Date(now).toISOString(),latencyMs:1000,httpStatus:t.id==='health'&&((model==='a'&&Number(c.id)<2)||(model==='b'&&c.id==='0'))?429:200,usage:{cost:.001},score:{correct:1,total:1,validJson:true,schemaValid:true}}))));
 const evidence=buildEvidence(manifest,rows,'hash'),[a,b]=evidence.profiles[0].models;
 assert.equal(a.quality,1);assert.equal(a.effectiveQuality,.8);assert.equal(a.availability.attempts,10);
 assert.equal(b.quality,1);assert.equal(b.effectiveQuality,1);assert.equal(b.availability.rate,.9);
 const candidates=evidence.profiles[0].models.map(m=>({model:{id:m.id},evidence:[],measured:m}));orderCandidates(candidates,task);assert.equal(candidates.at(-1).model.id,'a');
});

test('execution profiles match contracts, including retention and loops, without model or prompt rules',()=>{
 for(const [kind,changes] of Object.entries({code:{weights:{coding:3}},act:{weights:{agents:3,tools:3},needsTools:true},remember:{weights:{memory:3,tools:3},needsTools:true,needsMemory:true,requirements:{memory:'persistent'}}})){
  const {candidates,data}=fixture();const t={...task,kind,needsStructured:false,...changes};
  Object.assign(data.profiles[0].scope,{kind,structured:false,tools:!!t.needsTools,memory:t.needsMemory?'persistent':'none',agentic:!!t.weights.agents,capabilities:Object.keys(t.weights)});
  assert.equal(measuredCandidates(candidates,t,now,data).candidates.length,6);
  if(kind==='remember')assert.equal(measuredCandidates(candidates,{...t,needsMemory:false,requirements:{memory:'session'}},now,data),null);
  if(kind==='act')assert.equal(measuredCandidates(candidates,{...t,weights:{tools:3}},now,data),null);
  assert.equal(measuredCandidates(candidates,{...t,needsStructured:true},now,data),null);
  assert.equal(measuredCandidates(candidates,{...t,weights:{...t.weights,knowledge:3}},now,data),null);
 }
});

test('new execution evidence is built through the same calibration-only path',()=>{
 for(const kind of ['code','act','remember']){
  const t={...task,kind,needsStructured:false,needsTools:kind!=='code',needsMemory:kind==='remember',weights:{[kind==='code'?'coding':kind==='act'?'agents':'memory']:3}};
  const models=['a','b','c','d','e'],cases=Array.from({length:6},(_,i)=>({id:String(i),split:'calibration'}));
  const manifest={tasks:[{id:'new-operation',models,cases,task:t}]};
  const rows=models.flatMap(model=>cases.map(c=>({task:'new-operation',caseId:c.id,model,startedAt:new Date(now).toISOString(),latencyMs:2000,httpStatus:200,usage:{cost:.002},score:{correct:1,total:1,schemaValid:true}})));
  const data=buildEvidence(manifest,rows,'protocol');
  assert.equal(data.profiles.length,1);assert.equal(data.profiles[0].scope.memory,kind==='remember'?'persistent':'none');
  assert.ok(measuredCandidates(models.map(id=>({model:{id}})),t,now,data));
 }
});

test('matching evidence is selected by measurement recency rather than file order',()=>{
 const {candidates,data}=fixture();const newer=structuredClone(data.profiles[0]);newer.id='newer';newer.measuredAt=new Date(now-500).toISOString();data.profiles.push(newer);
 assert.equal(measuredCandidates(candidates,task,now,data).profile.id,'newer');
 newer.split='holdout';assert.equal(measuredCandidates(candidates,task,now,data).profile.id,'fixture');
});
test('an applicable calibration profile past its expiry is excluded with a visible warning',async()=>{
 const {attachTaskObservations}=await import('../task-evidence.mjs');
 const {candidates,data}=fixture(),late=now+31*86400_000;
 assert.equal(attachTaskObservations(candidates,task,late,data).expired.id,'fixture');
 assert.ok(candidates.every(c=>!c.measured&&!c.taskObservation&&!c.evidence.length));
 assert.equal(attachTaskObservations(fixture().candidates,task,now,data).id,'fixture');
 // A non-matching task gets neither observations nor an expiry warning.
 assert.equal(attachTaskObservations(fixture().candidates,{...task,kind:'classify'},late,data),null);
});
