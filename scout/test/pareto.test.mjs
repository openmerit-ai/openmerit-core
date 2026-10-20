import test from 'node:test';import assert from 'node:assert/strict';import{selectPareto,dominates}from'../pareto.mjs';
const task={weights:{coding:3},workload:{input:'short',output:'short',priority:'balanced'}};
const candidate=(id,q,c,t,benchmark='same')=>({model:{id,endpoint:{id:`route:${id}`},inputPrice:c,outputPrice:c,speed:t===null?null:{timeToFirstAnswer:t,tokensPerSecond:100}},evidence:[{benchmark,metric:'accuracy',score:q,definition:{id:benchmark,tags:['coding'],family:benchmark}}]});
test('a single supported dominator removes every dominated model instead of filling five',()=>{
 const rows=[candidate('best',.9,1,1),candidate('worse',.8,2,2),candidate('worst',.7,3,3)];const r=selectPareto(rows,task);assert.deepEqual(rows.map(x=>x.model.id),['best']);assert.equal(r.frontier.comparedConfigurations,3);assert.equal(r.frontier.scope,'comparable');
});
test('quality, cost and time tradeoffs survive; at most five distinct models are selected',()=>{
 const rows=Array.from({length:8},(_,i)=>candidate(`m${i}`,1-i*.05,8-i,1+i));const r=selectPareto(rows,task);assert.equal(rows.length,5);assert.equal(r.frontier.eligibleConfigurations,8);assert.ok(rows.some(c=>c.model.id==='m0'));assert.ok(!rows.some(c=>c.model.id==='m7'));
});
test('a weak cheapest point has no reserved slot; an explicit cost priority can still select it',()=>{
 const make=()=>Array.from({length:8},(_,i)=>candidate(`m${i}`,1-i*.1,8-i,1+i));
 const best=make();selectPareto(best,task);assert.deepEqual(best.map(c=>c.model.id),['m0','m1','m2','m3','m4']);
 const cheap=make();selectPareto(cheap,{...task,workload:{...task.workload,priority:'cost'}});assert.equal(cheap[0].model.id,'m7');
});
test('missing latency and incomparable benchmarks remain provisional, never zero',()=>{
 const rows=[candidate('known',.9,2,1),candidate('unknown',.8,1,null),candidate('different',.95,1,1,'other')];const r=selectPareto(rows,task);assert.equal(r.frontier.scope,'partial');assert.equal(rows.find(c=>c.model.id==='unknown').reference.seconds,null);assert.equal(rows.find(c=>c.model.id==='different').quality,null);assert.equal(dominates(rows[0],rows.find(c=>c.model.id==='different')),false);
});
test('endpoint configurations are compared before model identities are collapsed',()=>{
 const rows=[candidate('same',.9,1,1),candidate('same',.9,2,2),candidate('other',.8,.1,2)];rows[1].model.endpoint.id='another-route';selectPareto(rows,task);assert.equal(rows.filter(c=>c.model.id==='same').length,1);assert.equal(rows.find(c=>c.model.id==='same').model.endpoint.id,'route:same');
});
test('explicit priorities and soft preferences order frontier points without changing membership',()=>{
 const rows=[candidate('quality',.9,10,1),candidate('cheap',.8,1,2)];rows[1].preference=1;selectPareto(rows,task);assert.equal(rows[0].model.id,'cheap');assert.equal(rows.length,2);
});
test('the fast skyline agrees with exhaustive dominance, including ties',()=>{
 for(let s=0;s<30;s++){
   const rows=Array.from({length:30},(_,i)=>candidate(`m${i}`,((s*31+i*5)%17)/17,(s*13+i*7)%11,(s*17+i*3)%13));
   const all=rows.slice();selectPareto(rows,task,{limit:100});
   const oracle=all.filter(b=>!all.some(a=>a!==b&&dominates(a,b)));
   assert.deepEqual(rows.map(x=>x.model.id).sort(),oracle.map(x=>x.model.id).sort());
 }
});
test('ten thousand comparable models are all considered before selecting the frontier',()=>{
 const rows=Array.from({length:10000},(_,i)=>candidate(`m${i}`,1-i/10000,1+i/1000,1+i/1000));
 const result=selectPareto(rows,task);assert.equal(result.frontier.comparedConfigurations,10000);assert.deepEqual(rows.map(c=>c.model.id),['m0']);
});
test('disconnected evidence does not create quadratic comparisons or fabricated quality',()=>{
 const rows=Array.from({length:10000},(_,i)=>candidate(`m${i}`,.9,1+i,1,`separate-${i}`));const result=selectPareto(rows,task);
 assert.equal(result.frontier.comparedConfigurations,10000);assert.equal(result.frontier.scope,'partial');assert.ok(rows.every(c=>c.quality===null&&c.comparedModels===0));
});
