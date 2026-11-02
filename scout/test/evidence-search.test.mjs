import test from'node:test';import assert from'node:assert/strict';import{evidenceDocuments,relevantEvidence,stageEvidence,verifyEvidenceReady,recordLegacyEvidence,pruneEvidence,retrieveEvidence}from'../evidence-search.mjs';import{d1}from'./helpers-d1.ts';
test('hourly retrieval documents retain verified research and selected methodology rather than generic feed labels',()=>{
 const [d]=evidenceDocuments({benchmarks:[{id:'b',name:'Opaque series',tags:['vision'],interpretation:{status:'ready'},definition:{description:'Receives images.'},research:{description:'Recognize instances in photographs.',methodology:'Copy the visible category.',limitations:'No location evaluation.'},methodologySelection:{sections:[{title:'Scope',text:'Single photograph inputs.'}]}}]});
 assert.match(d.text,/Recognize instances/);assert.match(d.text,/Copy the visible category/);assert.match(d.text,/Single photograph inputs/);assert.match(d.text,/No location evaluation/);
});
test('one batch assesses each exact methodology independently without domain wording vetoing component evidence',async()=>{
 const docs=[{id:'one',text:'Read photographs.',tags:['vision']},{id:'two',text:'Generate programs.',tags:['coding']}],requests=[];
 const result=await relevantEvidence('PRIVATE downstream domain.',{weights:{vision:3},kind:'classify'},{documents:docs},{apiKey:'fixture',vectorize:{query:async()=>({matches:docs.map(d=>({metadata:{benchmark:d.id}}))})},queryVector:[],fetcher:async(_url,o)=>{const q=JSON.parse(o.body);requests.push(q);return Response.json({answers:q.questions.map((q,i)=>({name:q.name,type:'choice',choice:i===0?'vision':'none',confidence:.95}))});}});
 assert.deepEqual(result.ids,['one']);assert.equal(requests.length,1);assert.equal(requests[0].questions.length,2);
 assert.ok(requests[0].questions[0].instructions.includes(docs[0].text));assert.ok(!requests[0].questions[0].instructions.includes(docs[1].text));assert.ok(requests[0].questions[1].instructions.includes(docs[1].text));assert.doesNotMatch(JSON.stringify(requests),/PRIVATE downstream domain/);
});
test('evidence vectors are upserted once per content and pruned only when no retained or published version uses them',async()=>{
 const snapshot=text=>({benchmarks:[{id:'b',name:'b',tags:['vision'],definition:{description:text},interpretation:{status:'ready'}}]});
 const cache=new Map(),db=d1();let embeddingCalls=0;const options=now=>({db,now,apiKey:'fixture',cache:{get:async k=>cache.get(k),put:async(k,v)=>cache.set(k,v)},fetcher:async(url,o)=>{assert.ok(url.endsWith('/embeddings'),'Hourly retrieval must not summarize verified methodology again');embeddingCalls++;const q=JSON.parse(o.body);return Response.json({data:q.input.map((_,index)=>({index,embedding:Array(256).fill(.01)}))});}});
 let vectors=[];const deleted=[];const service={upsert:async rows=>{vectors.push(...rows);return{mutationId:'new'};},describe:async()=>({processedUpToMutation:'old'}),getByIds:async ids=>vectors.filter(v=>ids.includes(v.id)),deleteByIds:async ids=>{deleted.push(...ids);}};
 // A version published before the shared namespace is recorded once, from its stored index.
 assert.equal(await recordLegacyEvidence(db,async function*(){yield {index:{version:'legacy',documents:[{vectorId:'L1'}]},uploaded:'2026-09-01T00:00:00Z'};}),1);
 const a=await stageEvidence(service,snapshot('Photo interpretation.'),'a',options('2026-10-01T00:00:00Z'));
 assert.match(a.documents[0].text,/Photo interpretation/);assert.equal(a.namespace,'evidence');
 await assert.rejects(verifyEvidenceReady(service,a),/finished indexing/);
 // The same text in the next version reuses the vector: no embedding, no upsert, nothing to wait for.
 const b=await stageEvidence(service,snapshot('Photo interpretation.'),'b',options('2026-10-02T00:00:00Z'));
 assert.deepEqual([embeddingCalls,vectors.length,b.upserted,b.mutationId,b.documents[0].vectorId],[1,1,0,undefined,a.documents[0].vectorId]);
 assert.equal(await verifyEvidenceReady(service,b),true);
 assert.equal(await recordLegacyEvidence(db,async function*(){throw Error('must not list again');}),0);
 for(const [i,v] of ['c','d','e','f','g','h'].entries())await stageEvidence(service,snapshot('Changed description.'),v,options(`2026-10-0${i+3}T00:00:00Z`));
 assert.deepEqual([embeddingCalls,vectors.length],[2,2]);
 // With h staged and a published, b and the legacy version fall out of the newest five. Only the
 // legacy vector goes: b's vector is a's, which is still published.
 assert.deepEqual(await pruneEvidence(db,service,['h','a']),{versions:2,deleted:1});assert.deepEqual(deleted,['L1']);
 assert.deepEqual(await pruneEvidence(db,service,['h']),{versions:1,deleted:1});assert.deepEqual(deleted,['L1',a.documents[0].vectorId]);
 // Retrieval counts only this version's vector of a benchmark, not an older copy in the shared namespace.
 const h={...await stageEvidence(service,snapshot('Changed description.'),'h',options('2026-10-08T00:00:00Z'))};
 const found=async id=>(await retrieveEvidence({weights:{}},h,{vectorize:{query:async(_v,o)=>{assert.equal(o.namespace,'evidence');return {matches:[{id,metadata:{benchmark:'b'}}]};}},queryVector:[]})).map(d=>d.id);
 assert.deepEqual([await found(a.documents[0].vectorId),await found(h.documents[0].vectorId)],[[],['b']]);
});
test('an unavailable applicability check withholds even prepared proxies and marks uncertainty',async()=>{
 const docs=[{id:'supported',text:'Known operation.',tags:['coding']},{id:'unverified',text:'Unrelated operation.',tags:['vision']}];
 const result=await relevantEvidence('Opaque task.',{weights:{coding:3},capabilities:[],kind:'code'},{documents:docs},{apiKey:'fixture',vectorize:{query:async()=>({matches:docs.map(d=>({metadata:{benchmark:d.id}}))})},queryVector:[],fetcher:async(_url,o)=>{const q=JSON.parse(o.body);throw Error('offline');}});
 assert.deepEqual(result.ids,[]);assert.equal(result.degraded,true);assert.equal(result.assessments.length,docs.length);assert.ok(result.assessments.every(a=>a.applicability==='unknown'));
});
test('broad memberships cannot override rejected, unknown, weak or malformed measured-ability answers',async()=>{
 const values=[['none',.99],['unknown',.99],['vision',.79],['vision',.8],['vision',.99]],docs=values.map((_,i)=>({id:String(i),text:'Prepared methodology.',tags:['vision']}));
 const fetcher=async(_url,o)=>{const q=JSON.parse(o.body);return Response.json({answers:q.questions.map((q,i)=>({name:q.name,type:'choice',choice:values[i][0],confidence:values[i][1]}))});};
 const result=await relevantEvidence('A visual workload.',{weights:{vision:3}},{documents:docs},{apiKey:'fixture',fetcher});assert.deepEqual(result.ids,['3','4']);assert.deepEqual(result.preparedProxyIds,[]);
 for(const answer of [{name:'method_0',type:'choice',choice:'invented',confidence:.99},{name:'method_0',type:'choice',choice:'vision',confidence:2}]){const r=await relevantEvidence('Task.',{weights:{vision:3}},{documents:docs.slice(0,1)},{apiKey:'fixture',fetcher:async()=>Response.json({answers:[answer]})});assert.deepEqual(r.ids,[]);assert.equal(r.degraded,true);}
});
test('the hourly availability map excludes methods without observations for eligible models and preserves vector order',async()=>{
 const docs=[{id:'unavailable',modelIds:['elsewhere'],tags:['coding'],text:'Other model.'},{id:'second',modelIds:['eligible'],tags:['coding'],text:'Second.'},{id:'first',modelIds:['eligible'],tags:['coding'],text:'First.'}],seen=[];
 const r=await relevantEvidence('A task.',{weights:{coding:3}},{documents:docs},{apiKey:'fixture',modelIds:['eligible'],queryVector:[],vectorize:{query:async()=>({matches:['unavailable','first','second'].map(benchmark=>({metadata:{benchmark}}))})},fetcher:async(_url,o)=>{const q=JSON.parse(o.body);seen.push(...q.questions.map(q=>q.instructions));return Response.json({answers:q.questions.map(q=>({name:q.name,type:'choice',choice:'coding',confidence:.95}))});}});
 assert.equal(seen.length,2);assert.ok(seen[0].endsWith('First.'));assert.ok(seen[1].endsWith('Second.'));assert.deepEqual(r.ids,['first','second']);
});
test('benchmark assessment uses evaluation definitions and withholds incidental operations',async()=>{
 const result=await relevantEvidence('Private domain-specific artifact.',{weights:{authoring:3},capabilities:[{id:'authoring'}]},{documents:[{id:'helper',tags:['authoring'],text:'Uses an artifact to measure another ability.'}]},{apiKey:'fixture',capabilityDefinitions:[{id:'authoring',task:'Task definition.',benchmark:'Scored authoring quality.'}],fetcher:async(_url,o)=>{const q=JSON.parse(o.body);assert.equal(q.questions[0].choices.find(c=>c.value==='authoring').description,'Scored authoring quality.');return Response.json({answers:[{name:q.questions[0].name,type:'choice',choice:'none',confidence:.95}]});}});
 assert.deepEqual(result.ids,[]);assert.equal(result.assessments[0].applicability,'irrelevant');
});
test('a primary scored target excludes supporting modalities and an unresolved target cannot widen evidence',async()=>{
 const task={weights:{vision:3,documents:6},evidenceCapabilities:['documents']},index={documents:[{id:'evaluation',tags:['vision','documents'],text:'A document test.'}]};
 const r=await relevantEvidence('Task.',task,index,{apiKey:'fixture',fetcher:async(_url,o)=>{const q=JSON.parse(o.body);assert.deepEqual(q.questions[0].choices.map(c=>c.value),['none','unknown','documents']);return Response.json({answers:[{name:'method_0',type:'choice',choice:'documents',confidence:.99}]});}});assert.deepEqual(r.ids,['evaluation']);
 const unknown=await relevantEvidence('Task.',{...task,evidenceCapabilities:[]},index,{fetcher:()=>assert.fail('Unresolved targets do not grant broader evidence')});assert.deepEqual(unknown.ids,[]);
});
test('required capability memberships backstop a vector result with only incidental abilities within one bounded batch',async()=>{
 const unrelated=Array.from({length:20},(_,i)=>({id:'incidental'+i,tags:['incidental'],text:'Another ability.'})),core={id:'core',tags:['required'],text:'Required operation.'};let size=0;
 const result=await relevantEvidence('Create an artifact.',{weights:{required:3,incidental:1}},{documents:[...unrelated,core]},{apiKey:'fixture',vectorize:{query:async()=>({matches:unrelated.map(d=>({metadata:{benchmark:d.id}}))})},queryVector:[],fetcher:async(_url,o)=>{const q=JSON.parse(o.body);size=q.questions.length;assert.ok(q.questions.slice(0,4).every((q,i)=>q.instructions.endsWith(unrelated[i].text)));return Response.json({answers:q.questions.map(q=>({name:q.name,type:'choice',choice:q.instructions.endsWith(core.text)?'required':'none',confidence:.95}))});}});
 assert.equal(size,16);assert.deepEqual(result.ids,['core']);
});
test('one retrieved primary method cannot suppress other prepared primary evidence for a scoped inventory',async()=>{
 const documents=[{id:'retrieved',tags:['writing'],modelIds:['allowed'],text:'Weakly related.'},{id:'missing',tags:['writing'],modelIds:['allowed'],text:'Actual writing evaluation.'},{id:'excluded',tags:['writing'],modelIds:['other'],text:'Other inventory.'}];
 const r=await relevantEvidence('Task.',{weights:{structured:3,writing:3},evidenceCapabilities:['writing']},{documents},{apiKey:'fixture',modelIds:['allowed'],queryVector:[],vectorize:{query:async()=>({matches:[{metadata:{benchmark:'retrieved'}}]})},fetcher:async(_url,o)=>{const q=JSON.parse(o.body);assert.equal(q.questions.length,2);return Response.json({answers:q.questions.map((q,i)=>({name:q.name,type:'choice',choice:i===1?'writing':'none',confidence:.99}))});}});
 assert.deepEqual(r.ids,['missing']);
});
test('a processed mutation cannot publish missing or cross-generation vectors',async()=>{
 const index={version:'next',mutationId:'submitted',submittedAt:'2026-10-16T00:00:00Z',documents:[{vectorId:'one'},{vectorId:'two'}]};
 const service={describe:async()=>({processedUpToMutation:'later',processedUpToDatetime:'2026-10-16T00:01:00Z'}),getByIds:async()=>[{id:'one',namespace:'next'}]};
 await assert.rejects(verifyEvidenceReady(service,index),/unavailable/);
 service.getByIds=async()=>[{id:'one',namespace:'next'},{id:'two',namespace:'previous'}];await assert.rejects(verifyEvidenceReady(service,index),/unavailable/);
 service.getByIds=async()=>[{id:'one',namespace:'next'},{id:'two',namespace:'next'}];assert.equal(await verifyEvidenceReady(service,index),true);
});
test('explicit terms retrieve a narrow evaluation missed by vectors without bypassing inventory or applicability',async()=>{
 const documents=[...Array.from({length:20},(_,i)=>({id:`general-${i}`,text:'General scientific reasoning.',tags:['reasoning'],modelIds:['allowed']})),
  {id:'target',text:'Isotope dating calculations.',tags:['reasoning'],modelIds:['allowed']},
  {id:'excluded',text:'Isotope isotope dating.',tags:['reasoning'],modelIds:['other']}];
 const task={search:'Isotope dating',weights:{reasoning:3}},options={apiKey:'fixture',modelIds:['allowed'],vectorize:{query:async()=>({matches:[{metadata:{benchmark:'general-0'}}]})},queryVector:[],
  fetcher:async(_url,o)=>Response.json({answers:JSON.parse(o.body).questions.map(q=>({name:q.name,type:'choice',choice:q.instructions.endsWith('Isotope dating calculations.')?'reasoning':'none',confidence:.99}))})};
 const r=await relevantEvidence('Task.',task,{documents},options);assert.deepEqual(r.ids,['target']);assert.ok(!r.assessments.some(a=>a.benchmark==='excluded'));
 const rejected=await relevantEvidence('Task.',task,{documents},{...options,fetcher:async(_url,o)=>Response.json({answers:JSON.parse(o.body).questions.map(q=>({name:q.name,type:'choice',choice:'none',confidence:.99}))})});assert.deepEqual(rejected.ids,[]);
});
test('image-reading tasks can accept document evidence even when another ability is the quality target',async()=>{
  const {assessEvidence}=await import('../evidence-search.mjs');
  const task={weights:{structured:3,documents:6,vision:3},needsVision:true,evidenceCapabilities:['structured']};
  const docs={id:'docs',text:'Document parsing benchmark.',tags:['documents']},format={id:'format',text:'Instruction following.',tags:['structured']};
  let offered;const fetcher=async(_url,options)=>{const {questions}=JSON.parse(options.body);offered=questions[0].choices.map(c=>c.value);
    return Response.json({answers:[{name:'method_0',type:'choice',choice:'documents',confidence:.95},{name:'method_1',type:'choice',choice:'structured',confidence:.95}]});};
  const result=await assessEvidence(task,[docs,format],{apiKey:'fixture',fetcher});
  assert.ok(offered.includes('documents'));assert.deepEqual(result.ids,['docs','format']);
});
test('task-domain evidence is accepted, confidently unrelated proxies are withheld and a missing domain answer stays a general proxy',async()=>{
 const docs=[{id:'coding-benchmark',tags:[],text:'Assign diagnosis codes to clinical notes.'},{id:'contest-maths',tags:['knowledge'],text:'Competition mathematics.'},{id:'science-qa',tags:['knowledge'],text:'Graduate science questions.'},{id:'billing-qa',tags:[],text:'Assign billing codes to invoices.'}];
 // billing-qa splits its task-specific vote between direct and domain; together they are confident.
 const method={'coding-benchmark':['unknown',.9],'contest-maths':['knowledge',.95],'science-qa':['knowledge',.95],'billing-qa':['none',.6]},domain={'coding-benchmark':['direct',.95],'contest-maths':['unrelated',.9],'billing-qa':['domain',.5,[{value:'direct',probability:.3},{value:'domain',probability:.5},{value:'generic',probability:.2}]]};
 const task={search:'Assign ICD-10 codes to discharge summaries.',weights:{knowledge:3},evidenceCapabilities:['knowledge']};
 const r=await relevantEvidence('Task.',task,{documents:docs},{apiKey:'fixture',fetcher:async(_url,o)=>{const q=JSON.parse(o.body);
  const answers=q.questions.flatMap(q=>{const kind=q.name.split('_')[0],doc=docs.find(d=>q.instructions.endsWith(d.text)),a=(kind==='method'?method:domain)[doc.id];if(kind==='domain')assert.ok(q.instructions.includes(task.search));return a?[{name:q.name,type:'choice',choice:a[0],confidence:a[1],...(a[2]?{probabilities:a[2]}:{})}]:[];});
  return Response.json({answers});}});
 assert.deepEqual([...r.ids].sort(),['billing-qa','coding-benchmark','science-qa']);
 assert.deepEqual(r.assessments.map(a=>[a.benchmark,a.capability,a.relevance]).sort(),[['billing-qa','knowledge','domain'],['coding-benchmark','knowledge','direct'],['contest-maths','knowledge','unrelated'],['science-qa','knowledge','generic']]);
});
