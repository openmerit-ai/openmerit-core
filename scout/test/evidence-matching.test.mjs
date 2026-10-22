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
import {createProductAnalytics} from '../product-analytics.mjs';

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
    if(url.endsWith('/responses')){
      const value=decomposition??{overflow:false,tasks:[{title:'Code task',layers,slots:[{...slot(conditions),unresolved}]}]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...value,tasks:value.tasks.map(t=>({sourceText:'Opaque task.',...t}))})}]}]});
    }
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
  for(const r of await transports(f,{prompt:'Opaque task.'})){
    assert.deepEqual(r.recommendations.map(m=>m.modelId),['lab/m0']);
    assert.equal(r.ranking.frontier.qualityGate.status,'unverified');assert.equal(r.ranking.frontier.qualityGate.qualifiedConfigurations,0);
    assert.ok(r.warnings.some(w=>w.includes('not a claim that the models meet your required quality')));
  }
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

test('product analytics counts one search per caller across multi-task, shared computation, cache hits and failures',async t=>{
 const sent=[],pending=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push(...JSON.parse(options.body).batch);return new Response(null,{status:200});});
 const env={POSTHOG_PROJECT_TOKEN:'phc_fixture',POSTHOG_HOST:'https://us.i.posthog.com',POSTHOG_ENVIRONMENT:'test'};
 const flush=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 for(const count of [1,2,3]){
  sent.length=0;
  const tasks=Array.from({length:count},(_,i)=>({title:`Task ${i}`,layers,slots:[slot(i===2?[{all:[{field:'creator',op:'eq',values:['Unknown lab']}]}]:[])]}));
  const f=await fixture([],[],{overflow:false,tasks});
  // Failure in the separate prompt archive must not suppress product events.
  const run=createRecommender({apiKey:'fixture',db:f.db,fetcher:f.fetcher,observe(){throw new Error('PRIVATE_ARCHIVE_FAILURE');}});
  async function call(mcp,user,prompt='PRIVATE_PROMPT_CANARY'){
   const args={prompt},request=new Request(`https://example.test/scout/${mcp?'mcp?agent=amp':'api/recommend'}`,{
    method:'POST',headers:{'content-type':'application/json','x-scout-client':mcp?'agent':'web',...(!mcp?{'x-scout-agent':user==='user_a'?'cursor':'codex'}:{})},
    body:JSON.stringify(mcp?{jsonrpc:'2.0',id:'PRIVATE_RPC_ID',method:'tools/call',params:{name:'scout_models',arguments:args}}:args),
   });
   const analytics=createProductAnalytics(request,env,{waitUntil:p=>pending.push(p)});analytics.identify(user);
   const response=await(mcp?handleMCP:handleAPI)(request,f.index,{},(...args)=>run(...args,mcp?'mcp':'api',analytics.observeSearch),analytics.observeMCP);
   analytics.complete(response);return response.json();
  }
  await Promise.all([call(false,'user_a'),call(false,'user_b')]);
  const calls=f.calls();await call(true,'user_a');assert.equal(f.calls(),calls);await flush();
  const searches=sent.filter(e=>e.event==='scout_search_completed');assert.equal(searches.length,3);
  assert.deepEqual(searches.map(e=>e.properties.cache).sort(),['hit','miss','shared']);
  assert.deepEqual(searches.map(e=>e.properties.agent).sort(),['amp','codex','cursor'],'cached/shared results cannot inherit another agent attribution');
  assert.equal(sent.find(e=>e.event==='scout_request_completed'&&e.properties.transport==='mcp').properties.mcp_method,'tools/call');
  assert.equal(sent.filter(e=>e.event==='scout_agent_connected').length,0,'searches are not MCP handshakes');
  assert.ok(searches.every(e=>e.properties.task_count===count&&e.properties.candidate_count===Math.min(count,2)&&e.properties.outcome==='ok'));
  assert.equal(new Set(searches.map(e=>e.properties.trace_id)).size,3,'shared computation must not share request traces');
  for(const search of searches){
   const events=sent.filter(e=>e.properties.trace_id===search.properties.trace_id);
   assert.ok(events.every(e=>e.properties.distinct_id===search.properties.distinct_id));
   assert.equal(events.filter(e=>e.event==='$ai_trace').length,1);
   const details=events.filter(e=>e.event==='scout_search_details');assert.equal(details.length,count);
   assert.deepEqual(details.map(e=>e.properties.task_index),Array.from({length:count},(_,i)=>i+1));
   assert.equal(details[0].properties.top5[0].model,'lab/m0');
   assert.equal(events.find(e=>e.event==='$ai_trace').properties.$ai_input_state,undefined);
   assert.ok(details.every(e=>e.properties.layers===undefined));
  }
  const ids=searches.map(e=>e.properties.distinct_id);assert.equal(new Set(ids).size,2);
  assert.equal(searches.find(e=>e.properties.transport==='mcp').properties.distinct_id,ids.find(id=>ids.filter(other=>id===other).length===2));
  assert.equal(sent.filter(e=>e.event==='scout_request_completed').length,3);
  f.index.snapshot.publication.id='missing';await call(true,'user_a','Another private prompt');await flush();
  assert.equal(sent.filter(e=>e.event==='scout_search_completed').at(-1).properties.outcome,'interpretation_error');
  const failed=sent.filter(e=>e.event==='scout_request_completed').at(-1);assert.equal(failed.properties.http_status,200);assert.equal(failed.properties.outcome,'error');
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_|user_a|user_b|Another private|Source files/);
 }
});

test('task restrictions stay independent through HTTP and MCP, including empty intersections',async()=>{
 const creator=name=>[{all:[{field:'creator',op:'eq',values:[name]}]}];
 const tasks=['Lab A','Lab B','Unknown lab'].map(name=>({title:`Task for ${name}`,layers,slots:[slot(creator(name))]}));
 const f=await fixture([],[],{overflow:false,tasks});
 for(const r of await transports(f,{prompt:'Three independent tasks with different provider restrictions.'})){
  assert.equal(r.ranking.mode,'multi-task');assert.deepEqual(r.recommendations,[]);
  assert.deepEqual(r.tasks.map(t=>t.slots.length),[1,1,1]);assert.deepEqual(r.tasks[0].layers,layers);
  assert.ok(Number.isFinite(Date.parse(r.evaluatedAt)));assert.ok(r.tasks.flatMap(t=>t.slots).every(s=>s.runtime.cache===r.runtime.cache));
  assert.deepEqual(r.tasks.flatMap(t=>t.slots.map(s=>s.recommendations.map(m=>m.modelId))),[['lab/m0'],['lab/m1'],[]]);
 }
 for(const r of await transports(f,{prompt:'Three independent tasks with different provider restrictions.',endpointIds:['route:1']}))assert.deepEqual(r.tasks.flatMap(t=>t.slots.map(s=>s.recommendations.map(m=>m.modelId))),[[],['lab/m1'],[]]);
});

test('task excerpts retain the original wording and prompt order without swapping their models',async()=>{
 const excerpts=['修复 café.ts — keep “α”\nand β.','Write tests for the CSV parser.'];
 const tasks=excerpts.map((sourceText,i)=>({title:`Rephrased task ${i}`,sourceText,layers,slots:[slot([{all:[{field:'creator',op:'eq',values:[i?'Lab B':'Lab A']}]}])]}));
 const f=await fixture([],[],{overflow:false,tasks:tasks.toReversed()});
 for(const result of await transports(f,{prompt:`First: ${excerpts[0]}\nSeparately: ${excerpts[1]}`})){
  assert.deepEqual(result.tasks.map(t=>t.sourceText),excerpts);
  assert.deepEqual(result.tasks.map(t=>t.title),['Rephrased task 0','Rephrased task 1']);
  assert.deepEqual(result.tasks.map(t=>t.slots[0].recommendations[0].modelId),['lab/m0','lab/m1']);
 }
 const repeated=await fixture([],[],{overflow:false,tasks:tasks.map((t,i)=>({...t,sourceText:i?'JSON':'preserving case'}))});
 for(const result of await transports(repeated,{prompt:'Parse JSON, preserving case. Separately, validate JSON.'})){
  assert.deepEqual(result.tasks.map(t=>t.sourceText),['preserving case','JSON']);
  assert.deepEqual(result.tasks.map(t=>t.title),['Rephrased task 0','Rephrased task 1']);
 }
 // A rewritten or whitespace-only excerpt is not presented as a user quote,
 // but display metadata alone must not suppress an otherwise valid shortlist.
 for(const sourceText of ['Fix the parser.', '   ']){
  const invalid=await fixture([],[],{overflow:false,tasks:[{title:'Parser task',sourceText,layers,slots:[slot()]}]});
  for(const result of await transports(invalid,{prompt:'Repair the parser.'})){
   assert.equal(result.tasks[0].sourceText,null);assert.ok(result.tasks[0].slots[0].recommendations.length);
  }
 }
});

test('one, two and three tasks return five distinct ranked models each through HTTP and MCP',async()=>{
 for(const count of [1,2,3]){
  const tasks=Array.from({length:count},(_,i)=>({title:`Task ${i+1}`,layers,slots:[slot()]})),f=await fixture([],[],{overflow:false,tasks});
  // Nine models meet the quality band; the cheapest is too weak. Labs alternate.
  f.index.snapshot.models.forEach((m,i)=>{m.evidence[0].score=i===0?.6:.9+i*.002;});
  f.index.snapshot.publication.id='tradeoffs';
  await stageProjection(f.db,'tradeoffs',f.index.snapshot,prepareEligibility(f.index.snapshot));
  for(const result of await transports(f,{prompt:`${count} independent tasks.`})){
   assert.equal(result.tasks.length,count);
   assert.equal(result.tasks.reduce((n,t)=>n+t.slots[0].recommendations.length,0),5*count);
   for(const task of result.tasks){
    assert.equal(task.slots.length,1);assert.equal(task.slots[0].task.clarification,null);
    // Strongest first; the cheapest-and-fastest qualifying model keeps a labelled place.
    assert.deepEqual(task.slots[0].recommendations.map(m=>m.modelId),['lab/m9','lab/m8','lab/m7','lab/m6','lab/m1']);
    assert.deepEqual(task.slots[0].recommendations.map(m=>m.pick??[]),[['quality'],[],[],[],['value','speed']]);
    assert.equal(task.slots[0].ranking.frontier.qualityGate.excludedConfigurations,1);
    assert.equal(task.slots[0].ranking.frontier.qualityGate.status,'proxy-qualified');
    assert.ok(task.slots[0].warnings.some(w=>w.includes('not proof of sufficient quality')));
   }
  }
 }
});

test('three independent shortlists share one request deadline instead of three serial budgets',async()=>{
 const tasks=Array.from({length:3},(_,i)=>({title:`Task ${i}`,layers,slots:[slot()]}));
 const f=await fixture([],[],{overflow:false,tasks});
 const fetcher=async(...args)=>{await new Promise(r=>setTimeout(r,25));return f.fetcher(...args);};
 const run=createRecommender({apiKey:'fixture',db:f.db,fetcher,timeoutMs:350});
 const result=await run(f.index,'Three independent tasks.');
 assert.equal(result.tasks.length,3);assert.ok(result.tasks.every(t=>t.slots.length===1&&t.slots[0].recommendations[0].modelId==='lab/m0'));
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

test('task overflow, extra model roles, follow-up questions and invalid layers cannot change the result contract',async()=>{
 for(const [decomposition,status] of [
  [{overflow:true,tasks:[{title:'Too many tasks',layers,slots:[slot()]}]},422],
  [{overflow:false,tasks:Array.from({length:4},()=>({title:'Task',layers,slots:[slot()]}))},503],
  [{overflow:false,tasks:[{title:'Extra roles',layers,slots:[slot(),slot()]}]},503],
  [{overflow:false,tasks:[{title:'Question',layers,slots:[{...slot(),clarification:{question:'Which format?',options:['JSON','CSV']}}]}]},503],
  [{overflow:false,tasks:[{title:'Task',layers:{...layers,criteria:{text:'Invented',origin:'missing'}},slots:[slot()]}]},503],
 ]){
  const f=await fixture([],[],decomposition);
  await assert.rejects(f.run(f.index,'A task request.'),e=>e.status===status);
 }
});
