import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCandidates} from '../comparison.mjs';
import {orderCandidates as referenceOrder} from './fixtures/ranked-pairs-reference.mjs';
import {decisionQuestions,interpretDecisions,questionsFor} from '../decisions.mjs';
import {registry} from '../registry.mjs';
import {measuredCandidates} from '../task-evidence.mjs';
import {indexStatus} from '../rank.mjs';
const answers=(choices={},confidence={})=>decisionQuestions.map(q=>({name:q.name,type:'choice',choice:choices[q.name]??({task_kind:'other',output_format:'none',output_specificity:'established',json:'no',tools:'no',memory:'none',output:'supported',input_length:'short',output_length:'short',priority:'balanced'}[q.name]??q.choices[0].value),confidence:confidence[q.name]??.95}));

test('cached catalogue status cannot retain an old calibration contract or expiry',()=>{
 const index={snapshot:{sources:[]},cachedStatus:{models:321,calibration:{profiles:[]}}};
 const current=indexStatus(index),late=indexStatus(index,Date.now()+8*86400_000);
 assert.equal(current.models,321);assert.ok(current.calibration.profiles.length);
 assert.ok(current.calibration.profiles.filter(p=>p.scope.structured).every(p=>p.scope.outputFormat==='json'));
 assert.ok(late.calibration.profiles.every(p=>!p.active));
});

test('format evidence applies only to the tested serialization, including future formats',()=>{
 const now=Date.now(),candidates=Array.from({length:5},(_,i)=>({model:{id:String(i)},evidence:[]}));
 const task={kind:'extract',needsStructured:true,outputFormat:'json',weights:{structured:3},workload:{input:'short',output:'short'}};
 const profile={split:'calibration',measuredAt:new Date(now).toISOString(),scope:{kind:'extract',vision:false,tools:false,structured:true,outputFormat:'json',input:'short',output:'short',capabilities:['structured']},models:candidates.map(c=>({id:c.model.id,cases:6,quality:.8,meanCostUsd:null,medianSeconds:1}))};
 const data={version:1,profiles:[profile]};assert.ok(measuredCandidates(candidates,task,now,data));
 for(const outputFormat of ['other','none','unspecified',undefined,'new-serialization'])assert.equal(measuredCandidates(candidates,{...task,outputFormat},now,data),null);
 delete profile.scope.outputFormat;assert.equal(measuredCandidates(candidates,task,now,data),null);
 profile.scope.outputFormat='new-serialization';assert.ok(measuredCandidates(candidates,{...task,outputFormat:'new-serialization'},now,data));
});
test('independent field-record evidence grounds extraction; weak guesses cannot add a narrow operation',()=>{
 assert.equal(interpretDecisions(answers({result_type:'fields',task_kind:'other'})).kind,'extract');
 const weak=interpretDecisions(answers({result_type:'absent',task_kind:'extract',writing:'required'},{task_kind:.2}));
 assert.equal(weak.kind,'other');assert.equal(weak.weights.structured,undefined);
 const format=interpretDecisions(answers({json:'yes',output_format:'json'},{output_format:.2}));assert.equal(format.outputFormat,'unspecified');
 const fields=interpretDecisions(answers({result_type:'fields',task_kind:'extract',writing:'required'},{writing:.2}));
 assert.equal(fields.kind,'extract');assert.equal(fields.weights.structured,3);assert.equal(fields.weights.writing,undefined);
});
test('visual uncertainty cannot become a mask contract or erase an established label contract',()=>{
 assert.equal(interpretDecisions(answers({vision:'required',result_type:'masks',task_kind:'segment',output_specificity:'ambiguous'})).kind,'visual_unspecified');
 const labels=interpretDecisions(answers({vision:'required',result_type:'labels',task_kind:'classify',label_space:'open',output_specificity:'ambiguous'}));assert.equal(labels.kind,'classify');assert.equal(labels.labelSpace,'open');
});
test('published capabilities stay dynamic while application contract questions upgrade independently',()=>{
 const previous={...registry,questions:[],capabilities:[...registry.capabilities,{id:'future',label:'Future',task:'A new task operation',benchmark:'A new benchmark scope'}]};
 const questions=questionsFor(previous);assert.ok(questions.some(q=>q.name==='future'));assert.ok(questions.some(q=>q.name==='output_format'));
});
test('incremental graph closure preserves ranked-pairs order across bitset boundaries and cycles',()=>{
 let state=41;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
 for(const n of[2,31,32,33,65,129]){
  const candidates=Array.from({length:n},(_,i)=>({model:{id:`anonymous/${i}`,inputPrice:random()*8,outputPrice:random()*20,speed:{timeToFirstAnswer:random()*2,tokensPerSecond:random()*100+1}},evidence:Array.from({length:4},(_,j)=>({benchmark:`b${j}`,score:random(),definition:{tags:[j%2?'coding':'reasoning'],family:`family${j}`}}))}));
  for(const priority of ['balanced','quality','cost','latency']){
   const task={weights:{coding:3,reasoning:1},workload:{priority,input:'short',output:'short'}},a=structuredClone(candidates),b=structuredClone(candidates);
   referenceOrder(a,task);orderCandidates(b,task);assert.deepEqual(b.map(c=>[c.model.id,c.score,c.quality]),a.map(c=>[c.model.id,c.score,c.quality]));
  }
 }
});
