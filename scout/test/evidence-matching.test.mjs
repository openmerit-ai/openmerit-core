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

async function fixture(conditions=[],unresolved=[]) {
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
    if(url.endsWith('/responses'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(request.text.format.name==='scout_evidence'?{indices:[0]}:{search:'Write source code.',alternatives:conditions,preferences:[],unresolved,clarification:null})}]}]});
    if(url.endsWith('/embeddings')){assert.deepEqual(request.input,['Write source code.']);return Response.json({data:[{index:0,embedding:Array(256).fill(.01)}]});}
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
 await f.run(f.index,args.prompt,[]);assert.ok(f.calls()>count);const afterScope=f.calls();
 await f.run(f.index,'Different task.');assert.ok(f.calls()>afterScope);
 // A new publication never reuses a result from its predecessor.
 f.index.snapshot.publication.id='missing-generation';await assert.rejects(f.run(f.index,args.prompt),/could not establish/);
});
