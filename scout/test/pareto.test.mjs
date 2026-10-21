import test from 'node:test';import assert from 'node:assert/strict';import{selectPareto,dominates}from'../pareto.mjs';
const task={weights:{coding:3},workload:{input:'short',output:'short',priority:'balanced'}};
const candidate=(id,q,c,t,benchmark='same')=>({model:{id,endpoint:{id:`route:${id}`},inputPrice:c,outputPrice:c,speed:t===null?null:{timeToFirstAnswer:t,tokensPerSecond:100}},evidence:[{benchmark,metric:'accuracy',score:q,definition:{id:benchmark,tags:['coding'],family:benchmark}}]});
test('a single supported dominator removes every dominated model instead of filling five',()=>{
 const rows=[candidate('best',.9,1,1),candidate('worse',.8,2,2),candidate('worst',.7,3,3)];const r=selectPareto(rows,task);assert.deepEqual(rows.map(x=>x.model.id),['best']);assert.equal(r.frontier.comparedConfigurations,3);assert.equal(r.frontier.scope,'comparable');
});
test('quality-qualified tradeoffs are cheapest first; at most five distinct models are selected',()=>{
 const rows=Array.from({length:8},(_,i)=>candidate(`m${i}`,1-i*.002,8-i,1+i));const r=selectPareto(rows,task);assert.equal(r.frontier.eligibleConfigurations,8);assert.deepEqual(rows.map(c=>c.model.id),['m7','m6','m5','m4','m3']);
});
test('cost and latency cannot buy a pass outside the inclusive quality band',()=>{
 for(const priority of ['balanced','cost','latency','quality']){
  const rows=[candidate('strongest',.9,10,1),candidate('boundary',.88,1,2),candidate('outside',.879999,.1,.1),candidate('weak',.3,0,0)];
  const r=selectPareto(rows,{...task,workload:{...task.workload,priority}});
  assert.deepEqual(rows.map(c=>c.model.id),['boundary','strongest']);assert.equal(r.frontier.qualityGate.excludedConfigurations,2);
 }
});
test('missing latency and incomparable benchmarks remain provisional, never zero',()=>{
 const different=candidate('different',.95,0,1,'other');
 const rows=[candidate('known',.9,2,1),candidate('unknown',.89,1,null),different];const r=selectPareto(rows,task);assert.equal(r.frontier.scope,'partial');assert.equal(rows[0].model.id,'unknown');assert.equal(rows[0].reference.seconds,null);assert.equal(different.quality,null);assert.equal(dominates(rows[0],different),false);assert.ok(!rows.includes(different));assert.equal(r.frontier.qualityGate.unverifiedConfigurations,1);
});
test('endpoint configurations are compared before model identities are collapsed',()=>{
 const rows=[candidate('same',.9,1,1),candidate('same',.9,2,2),candidate('other',.89,.1,2)];rows[1].model.endpoint.id='another-route';selectPareto(rows,task);assert.equal(rows[0].model.id,'other');assert.equal(rows.filter(c=>c.model.id==='same').length,1);assert.equal(rows.find(c=>c.model.id==='same').model.endpoint.id,'route:same');
});
test('price precedes latency, soft preferences and surplus quality; unknown prices are last',()=>{
 const rows=[candidate('preferred',.9,10,1),candidate('cheap-fast',.889,1,2),candidate('cheap-slow',.89,1,3),candidate('unknown-time',.895,1,null),candidate('unknown-price',.899,null,.1)];rows[0].preference=10;selectPareto(rows,task);
 assert.deepEqual(rows.map(c=>c.model.id),['cheap-fast','cheap-slow','unknown-time','preferred','unknown-price']);assert.equal(rows[2].reference.seconds,null);assert.equal(rows.at(-1).reference.cost,null);
});
test('scope-relative quality bands do not change with cohort size or compare unrelated scores',()=>{
 const rows=[candidate('a-best',.9,10,1),candidate('a-close',.88,1,2),candidate('a-weak',.87,.1,3),candidate('b-best',.6,20,1,'other'),candidate('b-close',.585,2,2,'other'),candidate('b-weak',.57,0,3,'other')];
 // Multiple routes for one model must not tighten the quality band.
 for(let i=0;i<7;i++){const c=candidate('a-best',.9,11+i,2);c.model.endpoint.id=`extra-${i}`;rows.push(c);}
 selectPareto(rows,task);assert.deepEqual(rows.map(c=>c.model.id),['a-close','b-close','a-best','b-best']);
});
test('matching direct observations use effective quality, not the relative rank display score',()=>{
 const rows=[candidate('best',.1,10,1),candidate('close',.99,1,2),candidate('unreliable',1,0,0)];
 rows.forEach((c,i)=>{c.taskObservation={quality:.95,effectiveQuality:[.95,.93,.4][i],profile:{id:'calibration'}};});
 selectPareto(rows,task);assert.deepEqual(rows.map(c=>c.model.id),['close','best']);
});
test('the fast skyline agrees with exhaustive dominance, including ties',()=>{
 for(let s=0;s<30;s++){
   const rows=Array.from({length:30},(_,i)=>candidate(`m${i}`,.98+((s*31+i*5)%17)/1000,(s*13+i*7)%11,(s*17+i*3)%13));
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
 assert.equal(result.frontier.qualityGate.status,'unverified');assert.equal(result.frontier.qualityGate.qualifiedConfigurations,0);
});
