import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretPrompt} from '../interpreter.mjs';
import {registry} from '../registry.mjs';
import {matchTask} from '../matching.mjs';

function transport(format,alternatives=[]) {
  return async(url,options)=>{
    const request=JSON.parse(options.body);
    if(url.endsWith('/responses'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({alternatives,preferences:[],unresolved:[],search:'Write source code.',clarification:null})}]}]});
    assert.ok(request.questions.some(q=>q.name==='json'));assert.ok(request.questions.some(q=>q.name==='output_format'));assert.ok(request.questions.some(q=>q.name==='vision'));
    const values={tools:'no',memory:'none',output:'supported',result_type:'absent',label_space:'absent',detection_scope:'absent',input_length:'short',output_length:'short',priority:'balanced',task_kind:'code',output_specificity:'established',catalogue_scope:'restricted',quality_target:'coding'};
    return Response.json({answers:request.questions.map(q=>({name:q.name,type:'choice',choice:q.name==='json'?(['json','other'].includes(format)?'yes':'no'):q.name==='output_format'?format:values[q.name]??(q.name==='coding'?'required':'absent'),confidence:.99}))});
  };
}
test('the hybrid reuses the complete Decisions task and serialization contract',async()=>{
  for(const [format,required] of [['none',false],['json',true],['other',true],['unspecified',false]]){
    const {task}=await interpretPrompt('Opaque task data.',{apiKey:'fixture',registry,fetcher:transport(format)});
    assert.equal(task.needsStructured,required);assert.equal(task.outputFormat,format);assert.equal(task.weights.coding,3);
    if(format==='unspecified')assert.ok(task.uncertainty.includes('output_format'));
  }
});
test('semantic output ambiguity uses the existing clarification response without discarding provider restrictions',async()=>{
 const alternatives=[{all:[{field:'creator',op:'eq',values:['Lab']}]}],base=transport('none',alternatives);
 const clarification={question:'Which output representation do you need?',options:['Source for a renderer.','Rendered media.']};
 const fetcher=async(url,options)=>{const r=await base(url,options);if(!url.endsWith('/responses'))return r;const body=await r.json();const content=body.output[0].content[0];content.text=JSON.stringify({...JSON.parse(content.text),clarification});return Response.json(body);};
 const {task}=await interpretPrompt('An ambiguous output request.',{apiKey:'fixture',fetcher});
 assert.deepEqual(task.clarification,clarification);assert.deepEqual(task.constraints,alternatives);assert.equal(task.unsupported,false);
});
test('request-time task questions remain bounded as the hourly capability directory grows',async()=>{
 const expanded={...registry,capabilities:[...registry.capabilities,...Array.from({length:500},(_,i)=>({id:`fine_${i}`,label:'Narrow scope',task:'A particular domain.',benchmark:'Its evaluation.',parent:'coding',core:false}))]};
 const base=transport('none');let count=0;
 const fetcher=async(url,options)=>{const q=JSON.parse(options.body);if(url.endsWith('/decisions')){count+=q.questions.length;assert.ok(!q.questions.some(q=>q.name.startsWith('fine_')));}return base(url,options);};
 const {task}=await interpretPrompt('Write source code.',{apiKey:'fixture',fetcher,registry:expanded});assert.equal(task.weights.coding,3);assert.ok(count<100);
});
test('malformed model-generated constraints fail closed before selecting any endpoint',async()=>{
  await assert.rejects(interpretPrompt('Opaque task data.',{apiKey:'fixture',registry,fetcher:transport('none',[{all:[]}])}),/structured interpretation|selection group/i);
});
test('matching bounds a transport that never resolves and aborts pending provider work',async()=>{
  let signal;await assert.rejects(matchTask({snapshot:{registry,metadataDefinitions:{creator:'Creator'},selectionVocabulary:{}}},'Opaque task.',null,null,{db:{},apiKey:'fixture',timeoutMs:25,fetcher:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}}),/deadline|timed out/i);assert.equal(signal.aborted,true);
});
test('metadata restrictions remain exact while Decisions sees only extracted downstream work',async()=>{
  const alternatives=[{all:[{field:'creator',op:'eq',values:['Lab']}]}],inner=transport('none',alternatives);let responses=0,decisionsStarted=false;
  const fetcher=async(url,options)=>{if(url.endsWith('/responses')){responses++;assert.equal(decisionsStarted,false);}else {decisionsStarted=true;const input=JSON.parse(options.body).input;assert.deepEqual(JSON.parse(input.slice(input.indexOf('\n')+1)),{task:'Write source code.'});}return inner(url,options);};
  const {task}=await interpretPrompt('Opaque task data.',{apiKey:'fixture',registry,fetcher});assert.equal(responses,1);assert.deepEqual(task.constraints,alternatives);assert.equal(task.weights.coding,3);
});

test('large vocabularies resolve only extracted names and cannot drop other restrictions',async()=>{
 const vocabulary={identity:['Canonical Model',...Array.from({length:500},(_,i)=>`Catalogue model ${i}`)],creator:['Lab']};
 const conditions=[{all:[{field:'identity',op:'eq',values:['my alias']},{field:'creator',op:'eq',values:['Lab']}]}],base=transport('none',conditions);let resolutions=0;
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);if(body.text?.format?.name==='scout_names'){resolutions++;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({resolutions:[{field:'identity',requested:'my alias',values:['Canonical Model']}]})}]}]});}return base(url,options);};
 const {task}=await interpretPrompt('Opaque task.',{apiKey:'fixture',vocabulary,fetcher});assert.equal(resolutions,1);assert.deepEqual(task.constraints,[{all:[{field:'identity',op:'eq',values:['Canonical Model']},{field:'creator',op:'eq',values:['Lab']}]}]);
 const noNames=await interpretPrompt('Opaque task.',{apiKey:'fixture',vocabulary,fetcher:transport('none')});assert.deepEqual(noNames.task.constraints,[]);assert.equal(resolutions,1);
});

test('metadata preparation overlaps task decisions and primary evidence does not remove endpoint requirements',async()=>{
 const inner=transport('none');let prepared=false;
 const fetcher=async(url,o)=>{const response=await inner(url,o);if(!url.endsWith('/decisions'))return response;const body=await response.json();
  for(const a of body.answers){if(a.name==='quality_target')a.choice='documents';if(['documents','vision'].includes(a.name))a.choice='required';}
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(prepared,true);return Response.json(body);};
 const r=await interpretPrompt('Opaque task.',{apiKey:'fixture',fetcher,prepare:async metadata=>{assert.equal(metadata.search,'Write source code.');prepared=true;return 'ready';}});
 assert.equal(r.prepared,'ready');assert.deepEqual(r.task.evidenceCapabilities,['documents']);assert.equal(r.task.needsVision,true);assert.ok(r.task.weights.vision);
});
test('contradictory semantic fields receive one bounded reconciliation instead of a false empty result',async()=>{
 for(const recovered of [true,false]){
  let calls=0;const inner=transport('none'),fetcher=async(url,o)=>{const response=await inner(url,o);if(!url.endsWith('/decisions'))return response;calls++;const body=await response.json();if(calls===1||!recovered){for(const a of body.answers){if(a.name==='task_kind')a.choice='other';if(a.name==='coding')a.choice='absent';if(a.name==='reasoning')a.choice='useful';}}return Response.json(body);};
  if(recovered){const r=await interpretPrompt('Opaque task.',{apiKey:'fixture',fetcher});assert.deepEqual(r.task.evidenceCapabilities,['coding']);assert.equal(r.task.weights.coding,3);}else await assert.rejects(interpretPrompt('Opaque task.',{apiKey:'fixture',fetcher}),/could not be established/);
  assert.equal(calls,2);
 }
});
test('unknown deferred identities fail closed and invented canonical names are rejected',async()=>{
 for(const values of [[],['Invented model']]){
  const vocabulary={identity:['Verified Model',...Array.from({length:500},(_,i)=>`Catalogue model ${i}`)]},base=transport('none',[{all:[{field:'identity',op:'eq',values:['alias']}]}]);
  const fetcher=async(url,options)=>JSON.parse(options.body).text?.format?.name==='scout_names'?Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({resolutions:[{field:'identity',requested:'alias',values}]})}]}]}):base(url,options);
  if(values.length)await assert.rejects(interpretPrompt('Opaque task.',{apiKey:'fixture',vocabulary,fetcher}),/canonical/);
  else assert.ok((await interpretPrompt('Opaque task.',{apiKey:'fixture',vocabulary,fetcher})).task.unresolved.length);
 }
});
