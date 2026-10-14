import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredCandidates } from '../task-evidence.mjs';
import { orderCandidates, taskWeights, compareQuality } from '../comparison.mjs';
import { buildEvidence } from '../experiments/build-task-evidence.mjs';
const now=Date.parse('2026-10-14T20:00:00Z');
const task={kind:'extract',weights:{structured:3},needsStructured:true,workload:{input:'short',output:'short',priority:'balanced'}};
function fixture() {
 const candidates=Array.from({length:6},(_,i)=>({model:{id:`provider/${i}`,inputPrice:9-i,outputPrice:9-i},evidence:[]}));
 const profile={id:'fixture',label:'Text extraction',split:'calibration',measuredAt:new Date(now-1000).toISOString(),casesPerModel:8,scope:{kind:'extract',vision:false,tools:false,structured:true,input:'short',output:'short',capabilities:['structured']},models:candidates.map((c,i)=>({id:c.model.id,cases:8,quality:1-i*.1,meanCostUsd:1+i,medianSeconds:1+i}))};
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
test('expired, future, held-out, undersampled and unavailable pools fall back without padding',()=>{
 for(const mutate of [p=>p.measuredAt=new Date(now-8*86400_000).toISOString(),p=>p.measuredAt=new Date(now+1).toISOString(),p=>p.split='holdout',p=>p.models=p.models.slice(0,4),p=>p.models.forEach(m=>m.cases=5)]) {
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
 const snapshot={version:1,checkedAt:new Date(now).toISOString(),sources:[],benchmarks:[],models:candidates.map(c=>({...c.model,name:c.model.id,provider:'provider',modalities:['text'],parameters:['response_format'],context:10000,evidence:[]}))};
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
