// Public facts are prepared hourly. Decisions compares them with the complete
// prompt; there is no prompt parser, provider-name list or filter expression.
import { requestDecisions } from './decisions.mjs';
import { choice, decode, chunks, stable } from './utils.mjs';
import { contractModels } from './endpoints.mjs';

import { eligibilityVersion, factDefinitions, factLabels, factKinds } from './selection.mjs';
export { eligibilityVersion, factDefinitions } from './selection.mjs';

const value=(row,field)=>row?.facts?.find(f=>f.field===field)?.value??null;
const metadataValue=(profile,field)=>field==='other'?profile.facts:profile.facts[field]??null;
const metadataLabel=field=>field==='other'?'documented model and endpoint metadata':factLabels[field];

// Posting lists are materialized during refresh. A semantic decision selects
// existing fact entries; request code only joins their endpoint memberships.
function prepareFacets(profiles) {
  return Object.fromEntries(Object.keys(factDefinitions).map(field=>{
    const values=new Map();
    profiles.forEach((profile,i)=>{
      const fact=metadataValue(profile,field);if(fact===null)return;
      const key=stable(fact),entry=values.get(key)??{profile:i,members:[]};
      entry.members.push(i);values.set(key,entry);
    });
    return [field,[...values.values()]];
  }));
}
export function modelFacts(model,endpoint) {
  return {creator:value(model,'creator'),host:endpoint.provider??null,family:value(model,'family'),identity:{name:model.name,id:model.id,endpointModelId:endpoint.modelId},
    contextTokens:endpoint.context??null,releasedAt:value(model,'releasedAt'),listedAt:value(model,'listedAt'),deployment:endpoint.deployment??null,
    other:{inputPrice:endpoint.inputPrice??null,outputPrice:endpoint.outputPrice??null,priceUnit:'USD per million tokens',pricingBasis:endpoint.pricingBasis??null,inputs:endpoint.modalities??[],outputs:endpoint.outputModalities??[],parameters:endpoint.parameters??[],attributes:[...(model.facts??[]),...(endpoint.facts??[])].filter(f=>!Object.hasOwn(factDefinitions,f.field))}};
}

export function prepareEligibility(snapshot) {
  const profiles=[];
  for(const model of snapshot.catalogue??snapshot.models)for(const endpoint of model.endpoints??[])
    profiles.push({modelId:model.id,endpointId:endpoint.id,source:endpoint.source,facts:modelFacts(model,endpoint)});
  const byId=new Map((snapshot.catalogue??snapshot.models).map(m=>[m.id,m]));
  for(const model of contractModels(snapshot))profiles.push({modelId:model.id,endpointId:model.endpoint.id,source:model.endpoint.source,facts:{...modelFacts({...model,facts:byId.get(model.id)?.facts},model.endpoint),creator:model.provider}});
  for(const model of snapshot.specialists??[])profiles.push({modelId:`huggingface/${model.id}`,repository:model.id,endpointId:`huggingface:local:${model.id}:${model.revision}`,source:'huggingface',
    facts:{creator:value(model,'creator'),host:'Self-hosted',family:value(model,'family'),identity:{id:model.id,name:model.id},contextTokens:value(model,'contextTokens'),releasedAt:value(model,'releasedAt'),listedAt:null,deployment:'self-hosted',other:{pipeline:model.pipeline,repositoryPublisher:model.id.split('/')[0],updatedAt:model.updatedAt,attributes:model.facts??[]}}});
  const vocabulary=Object.fromEntries(Object.keys(factDefinitions).map(field=>[field,[...new Set(profiles.flatMap(p=>Array.isArray(p.facts[field])?p.facts[field]:[p.facts[field]]).filter(v=>v!==null&&typeof v!=='object'))].sort((a,b)=>String(a).localeCompare(String(b)))]));
  vocabulary.identity=[...new Set(profiles.flatMap(p=>Object.values(p.facts.identity??{})).filter(v=>typeof v==='string'))].sort();
  return {version:eligibilityVersion,preparedAt:snapshot.checkedAt,profiles,vocabulary,facets:prepareFacets(profiles)};
}

function decodePredicates(questions,answers) {
  if(!Array.isArray(answers)||answers.length!==questions.length)throw new Error('Incomplete metadata response.');
  return questions.map(q=>{
    const matches=answers.filter(a=>a.name===q.name),a=matches[0];
    if(matches.length===1&&a.type==='refusal')return {...a,probability:null};
    if(matches.length!==1||a.type!=='predicate'||!Number.isFinite(a.probability)||a.probability<0||a.probability>1)throw new Error('Invalid metadata response.');
    return a;
  });
}

function describeFact(field,value,now,timeView='absolute_date') {
  if(factKinds[field]==='date'&&typeof value==='string'&&Number.isFinite(Date.parse(value))) {
    const released=new Date(value),reference=new Date(now);
    const months=(reference.getUTCFullYear()-released.getUTCFullYear())*12+reference.getUTCMonth()-released.getUTCMonth();
    const age=(now-released.getTime())/86400000,days=Math.floor(age),hours=(age-days)*24;
    return value+(['elapsed_age','multiple'].includes(timeView)?`; elapsed age: ${days} complete days plus ${hours.toFixed(2)} hours`:'')+(['calendar_period','multiple'].includes(timeView)?`; calendar month: ${new Intl.RelativeTimeFormat('en',{numeric:'auto'}).format(-months,'month')}`:'');
  }
  return typeof value==='string'?value:stable(value);
}

export async function matchEligibility(prompt,intent,directory,{modelIds=null,endpointIds=null,now=Date.now(),...options}={}) {
  if(!intent?.required.length)return {...intent,status:'not-needed'};
  if(directory?.version!==eligibilityVersion)throw new Error('Selection metadata is not prepared.');
  const deadline=performance.now()+(options.timeoutMs??4000);
  const ask=questions=>{
    const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw new Error('Metadata verification deadline exceeded.');
    return requestDecisions(input,questions,{...options,timeoutMs:remaining,maxRetries:0});
  };
  const fields=intent.required;
  const selected=new Set(directory.profiles.flatMap((p,i)=>(modelIds===null||modelIds.includes(p.modelId)&&p.source==='models')&&(endpointIds===null||endpointIds.includes(p.endpointId))?[i]:[]));
  const facets=directory.facets??prepareFacets(directory.profiles);
  const entries=fields.flatMap(field=>facets[field].filter(e=>e.members.some(i=>selected.has(i))).map(e=>({field,value:metadataValue(directory.profiles[e.profile],field),members:e.members})));
  const input=prompt+'\nReference time: '+new Date(now).toISOString()+' (UTC).';
  const permitted=new Map(fields.map(field=>[field,new Set()]));
  let checkedFacts=0;
  async function evaluate(batch) {
    checkedFacts+=batch.length;
    const pairs=batch.flatMap((e,i)=>{
      const description=describeFact(e.field,e.value,now,intent.timeView),label=metadataLabel(e.field);
      const conventions='';
      e.option=typeof e.value==='string'&&e.value!=='not_a_match'?e.value:stable(e.value);
      return [{name:`eligible_${i}`,type:'predicate',instructions:`Considering only the requested restrictions on ${label}, this ${label} value is permitted: ${description}. Ignore the task the model performs.${conventions}`},
        choice(`confirm_${i}`,`Is this ${label} value allowed by the request's restriction? Ignore the task the model performs.${conventions}`,{[e.option]:`Allowed model ${label}: ${description}`,not_a_match:`This ${label} value does not satisfy the request.`})];
    });
    const availability=fields.flatMap(field=>chunks(entries.filter(e=>e.field===field&&typeof e.value!=='object'),240).map((values,i)=>({field,question:choice(`available_${field}_${i}`,`Choose one supplied ${metadataLabel(field)} value that satisfies the model-selection restriction in the request. Choose no_documented_match if none satisfies it. Ignore what work the model will do.`,{no_documented_match:'No supplied value satisfies the restriction.',...Object.fromEntries(values.map(e=>[String(e.value),`Documented model ${metadataLabel(field)}: ${describeFact(field,e.value,now,intent.timeView)}`]))})})));
    const questions=[...pairs,...availability.map(a=>a.question)];
    const answers=(await Promise.all(chunks(questions,100).map(async qs=>{
      const body=await ask(qs);
      if(!Array.isArray(body.answers)||body.answers.length!==qs.length)throw new Error('Incomplete metadata response.');
      return qs.map(q=>{
        const matches=body.answers.filter(a=>a.name===q.name);if(matches.length!==1)throw new Error('Invalid metadata response.');
        if(matches[0].type==='refusal')return {name:q.name,type:'refusal',probability:null};
        return q.type==='predicate'?decodePredicates([q],matches)[0]:decode([q],matches)[0];
      });
    }))).flat();
    batch.forEach((e,i)=>{if((answers[2*i].probability>=.85||answers[2*i].probability>=.7&&answers[2*i+1].confidence>=.4)&&answers[2*i+1].choice===e.option)for(const member of e.members)permitted.get(e.field).add(member);});
    for(const field of fields) {
      const verdicts=availability.flatMap((a,i)=>a.field===field?[answers[pairs.length+i]]:[]);
      if(verdicts.length&&verdicts.every(a=>a.choice==='no_documented_match'&&a.confidence>=.7))permitted.get(field).clear();
    }
  }
  const initial=entries.filter(e=>!intent.hints?.[e.field]||String(e.value)===intent.hints[e.field]);
  await evaluate(initial);
  const retryFields=fields.filter(field=>intent.hints?.[field]&&!permitted.get(field).size);
  if(retryFields.length)await evaluate(entries.filter(e=>retryFields.includes(e.field)&&!initial.includes(e)));
  const profiles=[...selected].map(i=>directory.profiles[i]);
  const grouped=new Map();
  for(const i of selected)if(fields.every(f=>permitted.get(f).has(i))) {
    const profile=directory.profiles[i],facts=Object.fromEntries(fields.map(f=>[f,metadataValue(profile,f)])),key=stable(facts),group=grouped.get(key)??{facts,members:[]};
    group.members.push(profile);grouped.set(key,group);
  }
  const proposed=[...grouped.values()],allowed=[],unknown=[];
  let verified=proposed;
  if(intent.coupled&&fields.length>1&&proposed.length) {
    const confirmations=(await Promise.all(chunks(proposed,50).map(async batch=>{
      const qs=batch.flatMap((g,i)=>[
        {name:`verify_${i}`,type:'predicate',instructions:`This candidate's metadata establishes every explicit restriction on WHICH models can be recommended: ${JSON.stringify(g.facts)}. Ignore the task to perform, soft preferences and incidental names. A missing required fact cannot establish a match. Respect exclusions, complete alternatives and strict boundaries.`},
        choice(`verify_choice_${i}`,'Does this combination of metadata satisfy one COMPLETE acceptable set of model-selection conditions? Ignore task quality. Mixing conditions from different alternatives is not sufficient.',{[stable(g.facts)]:JSON.stringify(g.facts),excluded:'The metadata does not establish a complete matching combination.'}),
      ]);
      const body=await ask(qs);
      return batch.map((_g,i)=>({predicate:decodePredicates([qs[2*i]],body.answers.filter(a=>a.name===qs[2*i].name))[0],choice:body.answers.find(a=>a.name===qs[2*i+1].name)?.type==='refusal'?{type:'refusal'}:decode([qs[2*i+1]],body.answers.filter(a=>a.name===qs[2*i+1].name))[0]}));
    }))).flat();
    verified=proposed.filter((g,i)=>confirmations[i].predicate.probability>=.25&&confirmations[i].choice.choice===stable(g.facts)&&confirmations[i].choice.confidence>=.25);
  }
  const admitted=new Set(verified);
  for(const g of proposed)if(admitted.has(g))allowed.push(...g.members);
  const admittedEndpoints=new Set(allowed.map(p=>p.endpointId));unknown.push(...profiles.filter(p=>!admittedEndpoints.has(p.endpointId)));
  return {...intent,status:'ok',groups:proposed.length,checkedFacts,checkedEndpoints:profiles.length,unknownEndpoints:unknown.length,
    allowedModelIds:[...new Set(allowed.filter(p=>!p.repository).map(p=>p.modelId))],allowedEndpointIds:allowed.map(p=>p.endpointId),allowedRepositories:allowed.filter(p=>p.repository).map(p=>p.repository)};
}

export const metadataAllows=(task,endpointId)=>!task.selection?.enforce&&!task.selection?.required.length||['ok','not-needed'].includes(task.selection.status)&&task.selection.allowedEndpointIds.includes(endpointId);
export function eligibilityWarnings(task) {
  if(!task.selection?.required.length)return [];
  return [...(!task.selection.allowedEndpointIds?.length?['No verified matching model was found in the available catalogue and selected inventory. This does not establish that no matching model exists.']:[]),
    'Explicit model-selection restrictions were checked against hourly-prepared metadata before candidate retrieval. Unknown facts do not satisfy hard restrictions.',
    ...(task.selection.unknownEndpoints?[`${task.selection.unknownEndpoints} endpoint options were omitted because their metadata could not establish the requested restrictions.`]:[])];
}
