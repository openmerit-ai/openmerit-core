import test from 'node:test';import assert from 'node:assert/strict';import{selectPareto,dominates,estimateQuality}from'../pareto.mjs';
const task={weights:{coding:3},workload:{input:'short',output:'short',priority:'balanced'}};
const candidate=(id,q,c,t,benchmark='same',provider)=>({model:{id,provider,endpoint:{id:`route:${id}`},inputPrice:c,outputPrice:c,speed:t===null?null:{timeToFirstAnswer:t,tokensPerSecond:100}},evidence:[{benchmark,metric:'accuracy',score:q,definition:{id:benchmark,tags:['coding'],family:benchmark}}]});
test('a single supported dominator removes every dominated model instead of filling five',()=>{
 const rows=[candidate('best',.9,1,1),candidate('worse',.8,2,2),candidate('worst',.7,3,3)];const r=selectPareto(rows,task);assert.deepEqual(rows.map(x=>x.model.id),['best']);assert.equal(r.frontier.comparedConfigurations,3);assert.equal(r.frontier.scope,'comparable');
});
// Two linked benchmarks with different scales: [score on 'wide', score on 'narrow'].
const linked=(id,q,c,t,provider)=>{const x=candidate(id,q,c,t,'wide',provider);x.evidence.push({benchmark:'narrow',metric:'accuracy',score:q/10,definition:{id:'narrow',tags:['coding'],family:'narrow'}});return x;};
test('topping a tiny evidence scope does not pass against stronger linked models',()=>{
 // The cheap pair share only one benchmark. Per-scope screening let the
 // better of them pass as "best in its scope"; a common estimate does not.
 const rows=[linked('s1',.9,10,2),linked('s2',.89,8,3),linked('s3',.6,1,1),candidate('cheap',.62,.1,.1,'wide'),candidate('cheaper',.58,.05,.1,'wide')];
 const all=rows.slice();selectPareto(rows,task);
 assert.deepEqual(rows.map(c=>c.model.id).sort(),['s1','s2']);
 const q=id=>all.find(c=>c.model.id===id).scopeQuality;assert.ok(q('cheap')<q('s2')-.1&&q('cheap')>q('s3'));
});
test('balanced searches label strongest, best-value and fastest; priorities change the order',()=>{
 const build=()=>[linked('a',.9,10,5),linked('b',.895,1,8),linked('c',.893,5,1),linked('d',.8,4,4),linked('weak',.5,.1,.1)];
 const order=priority=>{const rows=build();selectPareto(rows,{...task,workload:{...task.workload,priority}});return rows;};
 const balanced=order('balanced');
 assert.deepEqual(balanced.map(c=>c.model.id),['a','b','c']);
 assert.deepEqual(balanced.map(c=>c.pick),[['quality'],['value'],['speed']]);
 assert.deepEqual(order('quality').map(c=>c.model.id),['a','b','c']);
 assert.deepEqual(order('cost').map(c=>c.model.id),['b','c','a']);
 assert.deepEqual(order('latency').map(c=>c.model.id),['c','a','b']);
});
test('cost and latency cannot buy a pass outside the quality band for any priority',()=>{
 for(const priority of ['balanced','cost','latency','quality']){
  const rows=[linked('strongest',.9,10,1),linked('close',.895,9,2),linked('peer',.7,5,5),linked('outside',.75,.01,.01)];
  const r=selectPareto(rows,{...task,workload:{...task.workload,priority}});
  assert.ok(!rows.some(c=>['outside','peer'].includes(c.model.id)),priority);assert.equal(r.frontier.qualityGate.excludedConfigurations,2);
 }
});
test('at most two models per provider unless supported places would stay empty',()=>{
 const quality={...task,workload:{...task.workload,priority:'quality'}};
 const mixed=[...['a','b','c','d'].map((x,i)=>linked(`p1-${x}`,.9-i*.001,10-i,1,'P1')),linked('p2',.896,5,1,'P2'),linked('p3',.895,4,1,'P3')];
 selectPareto(mixed,quality);assert.deepEqual(mixed.map(c=>c.model.id),['p1-a','p1-b','p1-c','p2','p3']);
 const single=['a','b','c','d','e','f'].map((x,i)=>linked(`p1-${x}`,.9-i*.001,10-i,1,'P1'));
 selectPareto(single,quality);assert.equal(single.length,5);
});
test('missing latency stays unknown and cannot dominate',()=>{
 const rows=[linked('known',.9,2,1),linked('unknown',.899,1,null)];const r=selectPareto(rows,task);
 assert.equal(r.frontier.scope,'partial');assert.deepEqual(rows.map(c=>c.model.id),['known','unknown']);assert.equal(rows[1].reference.seconds,null);assert.equal(dominates(rows[0],rows[1]),false);
});
test('endpoint configurations are compared before model identities are collapsed',()=>{
 const rows=[linked('same',.9,1,1),linked('same',.9,2,2),linked('other',.899,.1,2)];rows[1].model.endpoint.id='another-route';selectPareto(rows,task);
 assert.equal(rows.filter(c=>c.model.id==='same').length,1);assert.equal(rows.find(c=>c.model.id==='same').model.endpoint.id,'route:same');assert.ok(rows.some(c=>c.model.id==='other'));
});
test('extra routes for one model do not add quality votes or tighten the band',()=>{
 const base=()=>[linked('a',.9,10,1),linked('b',.885,1,2),linked('c',.6,.1,.1)];
 const plain=base();const estimates=plain.slice();selectPareto(plain,task);
 const many=base();for(let i=0;i<7;i++){const c=linked('a',.9,11+i,2);c.model.endpoint.id=`extra-${i}`;many.push(c);}
 const all=many.slice();selectPareto(many,task);
 assert.deepEqual(many.map(c=>c.model.id),plain.map(c=>c.model.id));
 assert.equal(all.find(c=>c.model.id==='b').scopeQuality,estimates.find(c=>c.model.id==='b').scopeQuality);
});
test('calibration observations join the estimate using effective quality',()=>{
 const rows=[linked('best',.9,10,1),linked('close',.9,1,2),linked('unreliable',.9,0,0)];
 rows.forEach((c,i)=>{c.taskObservation={quality:.95,effectiveQuality:[.95,.93,.4][i],profile:{id:'calibration'}};});
 const all=rows.slice();selectPareto(rows,task);
 assert.ok(!rows.some(c=>c.model.id==='unreliable'));assert.deepEqual(rows.map(c=>c.model.id).sort(),['best','close']);
 assert.ok(all.find(c=>c.model.id==='unreliable').scopeQuality<all.find(c=>c.model.id==='close').scopeQuality);
});
test('disconnected evidence groups are never compared numerically',()=>{
 const rows=[candidate('a1',.9,3,1,'x'),candidate('a2',.88,2,2,'x'),candidate('a3',.5,1,3,'x'),candidate('b1',.99,.1,.1,'y'),candidate('b2',.2,.1,.1,'y')];
 const all=rows.slice();selectPareto(rows,task);
 assert.ok(rows.every(c=>c.model.id.startsWith('a')));assert.ok(all.filter(c=>c.model.id.startsWith('b')).every(c=>c.quality===null&&c.scopeQuality===null));
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
test('an evaluation that disagrees with the others cannot define common quality through a narrow score range',async()=>{
 const{estimateQuality}=await import('../pareto.mjs');
 const row=(id,scores)=>({model:{id,endpoint:{id:`route:${id}`}},evidence:Object.entries(scores).map(([benchmark,score])=>({benchmark,score,definition:{id:benchmark,tags:['coding'],family:benchmark}}))});
 // Three agreeing evaluations rank m7 strongest; a near-constant faithfulness
 // score falls slightly as they rise, and two models report only that score.
 const rows=Array.from({length:8},(_,i)=>row(`m${i}`,{a:.3+.08*i+(i%2)*.01,b:.25+.07*i,c:.35+.06*i-(i%3)*.01,faith:.95-.004*i}));
 rows.push(row('f1',{faith:.97}),row('f2',{faith:.965}));
 const{estimates}=estimateQuality(rows,{coding:3});
 assert.ok(!estimates.has('f1')&&!estimates.has('f2'));
 assert.equal([...estimates].sort((x,y)=>y[1].value-x[1].value)[0][0],'m7');
});
test('a model whose evaluations disagree about it carries a wider standard error',async()=>{
 const{estimateQuality}=await import('../pareto.mjs');
 const row=(id,scores)=>({model:{id,endpoint:{id:`route:${id}`}},evidence:Object.entries(scores).map(([benchmark,score])=>({benchmark,score,definition:{id:benchmark,tags:['coding'],family:benchmark}}))});
 const rows=Array.from({length:8},(_,i)=>row(`m${i}`,{a:.3+.08*i,b:.25+.07*i,c:.35+.06*i}));
 // Same average standing as m4, but the evaluations disagree sharply about it.
 rows.push(row('split',{a:.3+.08*4+.2,b:.25+.07*4-.2,c:.35+.06*4}));
 const{estimates}=estimateQuality(rows,{coding:3});
 assert.ok(estimates.get('split').se>3*estimates.get('m4').se);
});
test('task-domain evidence outweighs a majority of general proxies that disagree with it',()=>{
 const row=(id,domain,general,relevance)=>({model:{id},evidence:[{benchmark:'clinical',score:domain,definition:{id:'clinical',tags:['knowledge'],family:'clinical',relevance}},...[1,2,3,4].map(i=>({benchmark:`general${i}`,score:general+i/100,definition:{id:`general${i}`,tags:['knowledge'],family:`general${i}`,relevance:'generic'}}))]});
 const leader=relevance=>{const r=estimateQuality([row('domain-leader',.8,.5,relevance),row('general-leader',.6,.7,relevance),row('middle',.7,.6,relevance)],{knowledge:3}).estimates;return [...r].sort((a,b)=>b[1].value-a[1].value)[0][0];};
 assert.equal(leader('domain'),'domain-leader');
 assert.equal(leader('generic'),'general-leader');
});
