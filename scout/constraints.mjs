// A bounded data contract, not a natural-language parser. Values and aliases
// come from the published catalogue; only ordinary typed comparisons live here.
import { factDefinitions, factKinds } from './selection.mjs';
export const operators = ['eq','ne','in','not_in','gt','gte','lt','lte'];
export const fields = {...factDefinitions,inputPrice:'Endpoint input price in USD per million tokens.',outputPrice:'Endpoint output price in USD per million tokens.',inputs:'Documented endpoint input modalities.',outputs:'Documented endpoint output modalities.',parameters:'Documented endpoint features.'};
export function profileValue(profile,field) {
  if(field==='identity')return Object.values(profile.facts.identity??{});
  if(Object.hasOwn(profile.facts,field))return profile.facts[field];
  if(Object.hasOwn(profile.facts.other??{},field))return profile.facts.other[field];
  return profile.facts.other?.attributes?.find(f=>f.field===field)?.value??null;
}
export function fieldDefinitions(directory) {
  const result={...fields};delete result.other;
  for(const p of directory.profiles)for(const f of p.facts.other?.attributes??[])if(f.field&&!Object.hasOwn(result,f.field))result[f.field]=f.description??f.basis??`Documented attribute: ${f.field}`;
  return result;
}
const comparable=(field,value)=>factKinds[field]==='date'?Date.parse(value):value;
export function validateConstraints(value,definitions=fields) {
  if(!Array.isArray(value)||value.length>16)throw Error('Invalid selection alternatives.');
  for(const group of value){
    if(!group||Object.keys(group).join()!=='all'||!Array.isArray(group.all)||!group.all.length||group.all.length>32)throw Error('Invalid selection group.');
    for(const c of group.all){
      if(!c||Object.keys(c).sort().join()!=='field,op,values'||!Object.hasOwn(definitions,c.field)||!operators.includes(c.op)||!Array.isArray(c.values)||!c.values.length||c.values.length>240)throw Error('Invalid selection condition.');
      if(!['in','not_in'].includes(c.op)&&c.values.length!==1)throw Error('Invalid comparison cardinality.');
      for(const v of c.values)if(!['string','number','boolean'].includes(typeof v)||typeof v!==typeof c.values[0]||typeof v==='number'&&!Number.isFinite(v)||factKinds[c.field]==='date'&&(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T[^\s]+Z)?$/.test(v)||!Number.isFinite(Date.parse(v))))throw Error('Invalid comparison value.');
      if(['gt','gte','lt','lte'].includes(c.op)&&factKinds[c.field]!=='date'&&typeof c.values[0]!=='number')throw Error('Range comparisons require numeric or date facts.');
    }
  }
  return value;
}
export function satisfies(profile,condition) {
  const original=profileValue(profile,condition.field);
  if(original===null||original===undefined)return false;
  const actual=(Array.isArray(original)?original:[original]).filter(v=>v!==null&&v!==undefined).map(v=>comparable(condition.field,v));
  const wanted=condition.values.map(v=>comparable(condition.field,v));
  if(!actual.length||actual.some(v=>typeof v!==typeof wanted[0]||typeof v==='number'&&!Number.isFinite(v)))return false;
  const overlap=actual.some(v=>wanted.some(w=>v===w));
  if(['eq','in'].includes(condition.op))return overlap;
  if(['ne','not_in'].includes(condition.op))return !overlap;
  return actual.some(v=>typeof v==='number'&&typeof wanted[0]==='number'&&({gt:v>wanted[0],gte:v>=wanted[0],lt:v<wanted[0],lte:v<=wanted[0]})[condition.op]);
}
export const matches=(profile,groups)=>!groups.length||groups.some(g=>g.all.every(c=>satisfies(profile,c)));
export function selectProfiles(directory,groups,{modelIds=null,endpointIds=null}={}) {
  validateConstraints(groups,fieldDefinitions(directory));
  return directory.profiles.filter(p=>(modelIds===null||p.source==='models'&&modelIds.includes(p.modelId))&&(endpointIds===null||endpointIds.includes(p.endpointId))&&matches(p,groups));
}
export function selectionResult(directory,groups,preferences,scope={}) {
  const allowed=selectProfiles(directory,groups,scope);
  return {version:'2',required:[...new Set(groups.flatMap(g=>g.all.map(c=>c.field)))],preferred:preferences,conditions:groups,status:groups.length?'ok':'not-needed',checkedEndpoints:directory.profiles.length,unknownEndpoints:directory.profiles.length-allowed.length,
    allowedModelIds:[...new Set(allowed.filter(p=>!p.repository).map(p=>p.modelId))],allowedEndpointIds:allowed.map(p=>p.endpointId),allowedRepositories:allowed.filter(p=>p.repository).map(p=>p.repository)};
}
