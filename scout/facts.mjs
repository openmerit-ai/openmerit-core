import {requestDecisions} from './decisions.mjs';
import {choice,decode,digest,stable} from './utils.mjs';

const claim=f=>Object.fromEntries(['field','value','unit','url','basis','description','runId'].filter(k=>f[k]!==undefined).map(k=>[k,f[k]]));
// Reconcile source claims during refresh, never by guessing from unequal strings.
// Parent/child family labels and equivalent reporting can both be valid.
export async function reconcileFacts(model,existing,incoming,options={}) {
  const facts=structuredClone(existing??[]);
  for(const candidate of incoming) {
    const i=facts.findIndex(f=>f.field===candidate.field),prior=facts[i];
    if(!prior){facts.push(candidate);continue;}
    if(stable(prior.value)===stable(candidate.value))continue;
    const input={model:{id:model.id,name:model.name},existing:claim(prior),proposed:claim(candidate)};
    const cacheKey=`semantic/fact-compatibility/${await digest(['1',input])}.json`;
    let answer=await options.cache?.get(cacheKey);
    if(!answer) {
      const qs=[choice('canonical','Both claims have been independently checked against their sources. Are they compatible for this exact model and attribute? Choose the more specific supported value ONLY when both claims can coexist. Equivalent names or a documented parent/sub-family may be compatible. Different exact dates, versions, units or quantities are not equivalent merely because they are close. Contradictory or unresolved claims remain unknown.',{existing:'The claims are compatible; retain the existing value.',proposed:'The claims are compatible; the proposed value is more specific.',unknown:'The claims conflict or compatibility cannot be established.'})];
      const body=await requestDecisions(JSON.stringify(input),qs,{...options,timeoutMs:30_000});
      answer=body.answers?.length===1&&body.answers[0].name==='canonical'&&body.answers[0].type==='refusal'?{choice:'unknown',confidence:0}:decode(qs,body.answers)[0];
      await options.cache?.put(cacheKey,answer);
    }
    const supportingClaims=[...new Map([...(prior.supportingClaims??[]),claim(prior),claim(candidate)].map(f=>[stable(f),f])).values()];
    if(answer.confidence<.7||answer.choice==='unknown')facts[i]={...prior,value:null,conflictingClaims:supportingClaims,supportingClaims};
    else facts[i]={...(answer.choice==='proposed'?candidate:prior),supportingClaims};
  }
  return facts;
}
