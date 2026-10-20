import {interpretPrompt} from './interpreter.mjs';
import {prepareEligibility,eligibilityWarnings} from './eligibility.mjs';
import {fieldDefinitions,selectionResult,satisfies} from './constraints.mjs';
import {embed,retrieveEvidence,assessEvidence,evidenceDocuments} from './evidence-search.mjs';
import {queryProjection,loadProjectionModels} from './projection.mjs';
import {createIndex,recommend} from './rank.mjs';
import {matchSpecialists,relevantProfiles} from './specialists.mjs';
import {createTimings} from './timing.mjs';

export async function matchTask(index,prompt,modelIds,endpointIds,options={}) {
  const {timeoutMs=6000,fetcher=fetch}=options,controller=new AbortController(),trace=createTimings();let timer;
  const boundedFetch=(url,init)=>fetcher(url,{...init,signal:init?.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal});
  try{return await Promise.race([runMatch(index,prompt,modelIds,endpointIds,{...options,timeoutMs,fetcher:boundedFetch,trace}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>{const error=new DOMException('Matching deadline exceeded.','TimeoutError');controller.abort(error);reject(error);},timeoutMs);})]);}
  catch(error){error.diagnostics=trace.snapshot(error);throw error;}
  finally{clearTimeout(timer);controller.abort();}
}
async function runMatch(index,prompt,modelIds,endpointIds,{apiKey,fetcher,db,vectorize,now=Date.now,timeoutMs,trace}={}) {
  const started=performance.now(),deadline=started+timeoutMs,remaining=()=>Math.max(1,Math.floor(deadline-performance.now()));
  const manifest=index.snapshot,directory=manifest.metadataDefinitions?null:prepareEligibility(manifest),definitions=manifest.metadataDefinitions??fieldDefinitions(directory),vocabulary=manifest.selectionVocabulary??directory.vocabulary;
  // Exact metadata selection and embedding depend on extraction, not on the
  // independent Decisions task contract. Start them as soon as names resolve.
  const prepare=async metadata=>{
    const vectors=metadata.clarification?Promise.resolve({value:[]}):trace.measure('embedding',()=>embed([metadata.search||prompt],{apiKey,fetcher,timeoutMs:remaining()})).then(value=>({value}),error=>({error}));
    const selection=db?trace.measure('eligibility',()=>queryProjection(db,manifest.publication.id,metadata.alternatives,definitions,{modelIds,endpointIds,includeFacts:metadata.preferences.length>0})):Promise.resolve(selectionResult(directory,metadata.alternatives,metadata.preferences,{modelIds,endpointIds}));
    const [embedding,selectionValue]=await Promise.all([vectors,selection]);return {embedding,selection:selectionValue};
  };
  const interpreted=await trace.measure('interpretation',()=>interpretPrompt(prompt,{apiKey,fetcher,registry:manifest.registry,definitions,vocabulary,now:now(),timeoutMs:remaining(),trace,prepare}));
  const task=interpreted.task;task.servingEngine='evidence';
  // Selection restrictions must not bias methodology search. Embed the actual
  // downstream work while the independent exact eligibility query runs.
  let selected;
  if(db){
    selected=interpreted.prepared.selection;
    task.selection={version:'2',required:[...new Set(task.constraints.flatMap(g=>g.all.map(c=>c.field)))],preferred:task.preferences,conditions:task.constraints,status:task.constraints.length?'ok':'not-needed',allowedModelIds:[...new Set(selected.filter(p=>!p.repository).map(p=>p.modelId))],allowedEndpointIds:selected.map(p=>p.endpointId),allowedRepositories:selected.filter(p=>p.repository).map(p=>p.repository)};
  }else{
    task.selection=interpreted.prepared.selection;
    selected=directory.profiles.filter(p=>task.selection.allowedEndpointIds.includes(p.endpointId));
  }
  if(task.unresolved.length){task.selection.required.push('unresolved');task.selection.allowedModelIds=[];task.selection.allowedEndpointIds=[];task.selection.allowedRepositories=[];selected=[];}
  // Specialist metadata and compatibility are independent of benchmark retrieval
  // and model observations. Start their reads now rather than serializing them.
  const taskFit=['detect','segment'].includes(task.kind)&&!task.needsTools&&!task.needsMemory;
  const pendingSpecialists=(async()=>{
    // Unmeasured specialists cannot displace evaluated generative candidates.
    // Spatial pipelines still need their independent compatibility check.
    if(!taskFit)return {specialists:[],profiles:[],match:{status:'not-needed',matches:[],evaluatedProfiles:0}};
    const hub=index.loadSpecialists?await trace.measure('specialistRead',()=>index.loadSpecialists(task)):{specialists:manifest.specialists??[],profiles:manifest.specialistProfiles??[]};
    const profiles=relevantProfiles(hub.profiles,task).filter(p=>p.repositories.some(id=>task.selection.allowedRepositories.includes(id)));
    let match={status:'not-needed',matches:[],evaluatedProfiles:0};
    if(profiles.length){try{match=await trace.measure('specialistCheck',()=>matchSpecialists(prompt,task,profiles,{apiKey,fetcher,timeoutMs:remaining()}));}catch{match={status:'unavailable',matches:[],evaluatedProfiles:profiles.length};}}
    return {...hub,match};
  })().then(value=>({value}),error=>({error}));
  const evidenceIndex=manifest.evidenceIndex??{documents:evidenceDocuments(manifest)};
  const loadRows=benchmarkIds=>{
    if(task.unsupported||task.clarification||!selected.length||(!benchmarkIds.length&&!taskFit))return Promise.resolve([]);
    if(db)return trace.measure('modelRead',()=>loadProjectionModels(db,manifest.publication.id,task.selection.allowedModelIds,benchmarkIds));
    const ids=new Set(task.selection.allowedModelIds);return Promise.resolve((manifest.catalogue??manifest.models).filter(m=>ids.has(m.id)).map(m=>({...m,evidence:(manifest.models.find(x=>x.id===m.id)?.evidence??[]).filter(e=>benchmarkIds.includes(e.benchmark))})));
  };
  let rows;
  if(selected.length&&!task.unsupported&&!task.clarification&&!taskFit){
    const vectors=interpreted.prepared.embedding;if(vectors.error)throw vectors.error;
    const documents=await trace.measure('evidenceRetrieval',()=>retrieveEvidence(task,evidenceIndex,{vectorize,queryVector:vectors.value[0],modelIds:task.selection.allowedModelIds}));
    [task.evidenceMatch,rows]=await Promise.all([
      trace.measure('evidence',()=>assessEvidence(task,documents,{apiKey,fetcher,capabilityDefinitions:manifest.registry.capabilities,timeoutMs:Math.min(1800,remaining())})),
      loadRows(documents.map(d=>d.id)),
    ]);
    // Prefetching is independent of assessment. Only verified evidence may rank.
    const accepted=new Set(task.evidenceMatch.ids);rows=rows.map(m=>({...m,evidence:m.evidence.filter(e=>accepted.has(e.benchmark))}));
  }else {task.evidenceMatch={ids:[],assessments:[],coverage:'No benchmark quality comparison is used for this result.'};rows=await loadRows([]);}
  if(task.evidenceMatch.degraded&&!task.evidenceMatch.ids.length)throw Error('Task evidence applicability is unavailable.');
  // Endpoint restriction always applies, even with no free-text conditions.
  task.selection.enforce=true;
  const scoped=createIndex({...manifest,servingEngine:'evidence',publicStatus:manifest.publicStatus??index.cachedStatus,catalogue:rows,models:rows,specialists:manifest.specialists??[],specialistProfiles:manifest.specialistProfiles??[]});
  const hub=await pendingSpecialists;if(hub.error)throw hub.error;
  scoped.snapshot.specialists=hub.value.specialists;scoped.snapshot.specialistProfiles=hub.value.profiles;task.specialistMatch=hub.value.match;
  const profileByEndpoint=new Map((directory?.profiles??selected.filter(p=>p.facts)).map(p=>[p.endpointId,p]));
  task.preferenceScores=Object.fromEntries(selected.map(p=>[p.endpointId,task.preferences.reduce((n,c)=>n+(profileByEndpoint.has(p.endpointId)&&satisfies(profileByEndpoint.get(p.endpointId),c)?1:0),0)]));
  if(performance.now()>deadline)throw Error('Matching deadline exceeded.');
  const result={...await trace.measure('ranking',()=>recommend(scoped,prompt,now(),task,undefined,modelIds,endpointIds)),interpretationMs:interpreted.elapsedMs,snapshotVersion:manifest.publication?.id,retrieval:{catalogueModels:manifest.publicStatus?.models??manifest.catalogue.length,consideredModels:rows.length,exhaustive:true,evidenceExhaustive:false,evidenceBenchmarks:task.evidenceMatch.ids.length}};
  result.warnings.push(...eligibilityWarnings(task));
  if(task.evidenceMatch.degraded)result.warnings.push('Some task-specific evidence applicability checks were unavailable. Unverified evidence was withheld from ranking.');
  if(!selected.length&&task.selection.required.length)result.warnings.unshift('No verified model endpoint satisfies the requested restrictions in the available catalogue and selected inventory.');
  if(task.unresolved.length)result.warnings.unshift(`The following requirements could not be verified: ${task.unresolved.join('; ')}.`);
  result.evaluatedAt=new Date(now()).toISOString();result.elapsedMs=Math.round(performance.now()-started);result.runtime=trace.snapshot();return result;
}
