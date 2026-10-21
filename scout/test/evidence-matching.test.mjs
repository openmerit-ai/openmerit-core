import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from './helpers-projection.mjs';
import {prepareEligibility} from '../eligibility.mjs';
import {fieldDefinitions} from '../constraints.mjs';
import {stageProjection} from '../projection.mjs';
import {createIndex} from '../rank.mjs';
import {createRecommender} from '../recommend.mjs';
import {handleAPI} from '../http.mjs';
import {handleMCP} from '../mcp.mjs';
import {registry} from '../registry.mjs';

const layers={input:{text:'Source files',origin:'explicit'},work:{text:'Review code',origin:'inferred'},output:{text:'Corrected code',origin:'explicit'},criteria:{text:null,origin:'missing'},constraints:{text:null,origin:'missing'}};
const slot=(alternatives=[])=>({label:'Code',search:'Write source code.',alternatives,preferences:[],unresolved:[],clarification:null});
async function fixture(conditions=[],unresolved=[],decomposition) {
  const checkedAt=new Date().toISOString(),benchmark={id:'fixture',name:'Fixture',source:'fixture',family:'fixture',tags:['coding'],interpretation:{status:'ready'},definition:{description:'Source-code checks.'}};
  const models=Array.from({length:10},(_,i)=>({id:`lab/m${i}`,name:`Model ${i}`,provider:i%2?'Lab B':'Lab A',facts:[{field:'creator',value:i%2?'Lab B':'Lab A'},{field:'family',value:'line'},{field:'releasedAt',value:'2026-10-01'}],
    modalities:['text'],outputModalities:['text'],parameters:[],speed:{endpointId:`route:${i}`,timeToFirstAnswer:1+i,tokensPerSecond:100},
    endpoints:[{id:`route:${i}`,modelId:`m${i}`,provider:'Host',source:'models',protocol:'chat-completions',deployment:'hosted',context:i===0?500000:64000,modalities:['text'],outputModalities:['text'],parameters:[],inputPrice:1+i,outputPrice:1+i}],
    evidence:[{benchmark:'fixture',score:1-i/20,metric:'accuracy',url:'https://example.com/evaluation'}]}));
  const snapshot={version:1,checkedAt,registry,sources:[],benchmarks:[benchmark],catalogue:models,models,availableModels:models.length,publication:{id:'fixture'},servingEngine:'evidence',specialistProfiles:[],specialists:[],evidenceIndex:{version:'fixture',documents:[{id:'fixture',text:'Source-code checks.',tags:['coding']}]}};
  const directory=prepareEligibility(snapshot);snapshot.metadataDefinitions=fieldDefinitions(directory);snapshot.selectionVocabulary=directory.vocabulary;
  const db=new LocalD1();await stageProjection(db,'fixture',snapshot,directory);
  let calls=0;const fetcher=async(url,options)=>{calls++;
    const request=JSON.parse(options.body);
    if(url.endsWith('/responses'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(decomposition??{overflow:false,tasks:[{title:'Code task',layers,slots:[{...slot(conditions),unresolved}]}]})}]}]});
    if(url.endsWith('/embeddings'))return Response.json({data:request.input.map((_,index)=>({index,embedding:Array(256).fill(.01)}))});
    const choices={tools:'no',memory:'none',json:'no',output:'supported',result_type:'absent',label_space:'absent',detection_scope:'absent',input_length:'short',output_length:'short',priority:'balanced',task_kind:'code',output_format:'none',output_specificity:'established',catalogue_scope:'restricted',coding:'required',quality_target:'coding'};
    return Response.json({answers:request.questions.map(q=>q.type==='predicate'?{name:q.name,type:'predicate',probability:.99}:{name:q.name,type:'choice',choice:(q.name.startsWith('method_')?'coding':choices[q.name]??'absent'),confidence:.99})});
  };
  return {db,fetcher,calls:()=>calls,index:createIndex(snapshot),run:createRecommender({apiKey:'fixture',db,vectorize:{query:async()=>({matches:[{metadata:{benchmark:'fixture'}}]})},fetcher})};
}
async function transports(f,args) {
  const post=(path,body)=>new Request(`https://example.test/scout/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const http=await handleAPI(post('api/recommend',args),f.index,{},f.run);assert.equal(http.status,200);
  const rpc=await(await handleMCP(post('mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'scout_models',arguments:args}}),f.index,{},f.run)).json();assert.equal(rpc.result.isError,false);
  return [await http.json(),rpc.result.structuredContent];
}
test('the evidence engine enforces SQL filters and inventory intersections through HTTP and MCP',async()=>{
  const f=await fixture([{all:[{field:'creator',op:'eq',values:['Lab A']},{field:'contextTokens',op:'gte',values:[200000]}]}]);
  for(const r of await transports(f,{prompt:'Opaque task.'}))assert.deepEqual(r.recommendations.map(m=>m.modelId),['lab/m0']);
  for(const scope of [{modelIds:['lab/m1']},{endpointIds:['route:1']},{modelIds:[]}])for(const r of await transports(f,{prompt:'Opaque task.',...scope}))assert.deepEqual(r.recommendations,[]);
});
test('all eligible models enter Pareto comparison before the API selects distinct tradeoffs',async()=>{
  const f=await fixture();for(const r of await transports(f,{prompt:'Opaque task.'})){
    assert.equal(r.ranking.frontier.comparedConfigurations,10);assert.equal(r.ranking.frontier.scope,'comparable');assert.deepEqual(r.recommendations.map(m=>m.modelId),['lab/m0']);
    assert.equal(r.retrieval.consideredModels,10);assert.equal(r.eligibleModels,10);assert.equal(r.ranking.eligibleModels,10);assert.ok(!r.warnings.some(w=>w.includes('Only 1 eligible')));assert.ok(r.recommendations[0].reference.completionSeconds>0);
  }
});
test('an unexpressible mandatory restriction cannot silently widen the catalogue',async()=>{
  const f=await fixture([],['A required undocumented property.']);for(const r of await transports(f,{prompt:'Opaque task.'})){assert.deepEqual(r.recommendations,[]);assert.ok(r.warnings.some(w=>w.includes('could not be verified')));}
});

test('model prefetch overlaps assessment but rejected observations never enter ranking',async()=>{
 const f=await fixture(),snapshot=f.index.snapshot;snapshot.publication.id='overlap';
 snapshot.benchmarks.push({...snapshot.benchmarks[0],id:'rejected',family:'rejected',name:'Unrelated evaluation'});
 for(const m of snapshot.models)m.evidence.push({...m.evidence[0],benchmark:'rejected',score:1});
 snapshot.evidenceIndex.documents.push({id:'rejected',tags:['coding'],text:'Incidental target.'});
 await stageProjection(f.db,'overlap',snapshot,prepareEligibility(snapshot));
 let started;const reading=new Promise(r=>{started=r;}),prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const q=prepare(sql);if(sql.startsWith('SELECT json_set(payload')){const all=q.all.bind(q);q.all=async()=>{started();return all();};}return q;};
 const fetcher=async(url,o)=>{const q=JSON.parse(o.body);if(!q.questions?.[0].name.startsWith('method_'))return f.fetcher(url,o);
  await reading;return Response.json({answers:q.questions.map(q=>({name:q.name,type:'choice',choice:q.instructions.endsWith('Incidental target.')?'none':'coding',confidence:.99}))});};
 const run=createRecommender({apiKey:'fixture',db:f.db,fetcher,timeoutMs:500,vectorize:{query:async()=>({matches:['fixture','rejected'].map(benchmark=>({metadata:{benchmark}}))})}});
 const r=await run(f.index,'Opaque task.');assert.ok(r.recommendations.length);assert.deepEqual(r.task.evidenceMatch.ids,['fixture']);assert.ok(r.recommendations.every(m=>m.evidence.every(e=>e.benchmark==='Fixture')));
});

test('exact result reuse respects inventories, prompt identity and catalogue publication',async()=>{
 const f=await fixture(),args={prompt:'Opaque task.'};const first=await f.run(f.index,args.prompt),count=f.calls();assert.equal(first.runtime.cache,'miss');
 first.recommendations.length=0;const second=await f.run(f.index,args.prompt);assert.equal(second.runtime.cache,'hit');assert.ok(second.recommendations.length);assert.equal(f.calls(),count);
 assert.equal(second.evaluatedAt,first.evaluatedAt);assert.equal(second.tasks[0].slots[0].evaluatedAt,first.tasks[0].slots[0].evaluatedAt);
 assert.equal(second.tasks[0].slots[0].runtime.cache,'hit');assert.equal(second.tasks[0].slots[0].interpretationMs,0);assert.equal(second.tasks[0].slots[0].runtime.timings,undefined);
 await f.run(f.index,args.prompt,[]);assert.ok(f.calls()>count);const afterScope=f.calls();
 await f.run(f.index,'Different task.');assert.ok(f.calls()>afterScope);
 // A new publication never reuses a result from its predecessor.
 f.index.snapshot.publication.id='missing-generation';await assert.rejects(f.run(f.index,args.prompt),/could not establish/);
});

test('task and role restrictions stay independent through HTTP and MCP, including empty intersections',async()=>{
 const creator=name=>[{all:[{field:'creator',op:'eq',values:[name]}]}];
 const tasks=[{title:'Two roles',layers,slots:[slot(creator('Lab A')),slot(creator('Lab B'))]},{title:'Another task',layers,slots:[slot(creator('Unknown lab'))]}];
 const f=await fixture([],[],{overflow:false,tasks});
 for(const r of await transports(f,{prompt:'Two separate tasks with different model roles.'})){
  assert.equal(r.ranking.mode,'multi-task');assert.deepEqual(r.recommendations,[]);
  assert.deepEqual(r.tasks.map(t=>t.slots.length),[2,1]);assert.deepEqual(r.tasks[0].layers,layers);
  assert.ok(Number.isFinite(Date.parse(r.evaluatedAt)));assert.ok(r.tasks.flatMap(t=>t.slots).every(s=>s.runtime.cache===r.runtime.cache));
  assert.deepEqual(r.tasks.flatMap(t=>t.slots.map(s=>s.recommendations.map(m=>m.modelId))),[['lab/m0'],['lab/m1'],[]]);
 }
 for(const r of await transports(f,{prompt:'Two separate tasks with different model roles.',endpointIds:['route:1']}))assert.deepEqual(r.tasks.flatMap(t=>t.slots.map(s=>s.recommendations.map(m=>m.modelId))),[[],['lab/m1'],[]]);
});

test('nine independent shortlists share one request deadline instead of nine serial budgets',async()=>{
 const tasks=Array.from({length:3},(_,i)=>({title:`Task ${i}`,layers,slots:Array.from({length:3},()=>slot())}));
 const f=await fixture([],[],{overflow:false,tasks});
 const fetcher=async(...args)=>{await new Promise(r=>setTimeout(r,25));return f.fetcher(...args);};
 const run=createRecommender({apiKey:'fixture',db:f.db,fetcher,timeoutMs:350});
 const result=await run(f.index,'Three independent tasks with three roles each.');
 assert.equal(result.tasks.length,3);assert.ok(result.tasks.every(t=>t.slots.length===3&&t.slots.every(s=>s.recommendations[0].modelId==='lab/m0')));
 const limited=createRecommender({apiKey:'fixture',db:f.db,fetcher,timeoutMs:30});
 await assert.rejects(limited(f.index,'Three tasks.'),e=>e.status===503);
});

test('HTTP and MCP accept valid searches beyond the speed target but still bound stalled providers',async t=>{
 const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
 for(const channel of ['http','mcp'])for(const stalled of [false,true]){
  let begin;const started=new Promise(resolve=>{begin=resolve;});
  const fetcher=async(url,options)=>{
   if(url.endsWith('/responses')){begin();await new Promise(resolve=>{if(!stalled)setTimeout(resolve,6000);});}
   return f.fetcher(url,options);
  };
  const run=createRecommender({apiKey:'fixture',db:f.db,fetcher}),args={prompt:'A task with a slow provider.'};
  const body=channel==='http'?args:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'scout_models',arguments:args}};
  const request=new Request(`https://example.test/scout/${channel==='http'?'api/recommend':'mcp'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const pending=(channel==='http'?handleAPI:handleMCP)(request,f.index,{},run);
  await started;t.mock.timers.tick(stalled?30000:6000);
  const response=await pending,data=await response.json();
  if(channel==='http')assert.equal(response.status,stalled?503:200);
  else assert.equal(data.result.isError,stalled);
  if(!stalled)assert.deepEqual((channel==='http'?data:data.result.structuredContent).recommendations.map(m=>m.modelId),['lab/m0']);
 }
});

test('task overflow is explicit and a malformed fourth task or missing-layer claim fails closed',async()=>{
 for(const [decomposition,status] of [
  [{overflow:true,tasks:[{title:'Too many tasks',layers,slots:[slot()]}]},422],
  [{overflow:false,tasks:Array.from({length:4},()=>({title:'Task',layers,slots:[slot()]}))},503],
  [{overflow:false,tasks:[{title:'Task',layers:{...layers,criteria:{text:'Invented',origin:'missing'}},slots:[slot()]}]},503],
 ]){
  const f=await fixture([],[],decomposition);
  await assert.rejects(f.run(f.index,'A task request.'),e=>e.status===status);
 }
});
