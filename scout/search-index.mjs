import calibration from './task-evidence.json' with { type: 'json' };
import { registry as seed } from './registry.mjs';

// Hourly materialization: request work reads bounded lists, not every model pair.
export function prepareSearch(snapshot) {
  const registry=snapshot.registry??seed, limit=registry.policy.candidateLimit;
  const benchmarks=new Map(snapshot.benchmarks.map(b=>[b.id,b])), byCapability={}, byOperation={};
  const entries=snapshot.models.map(m=>{
    const groups=new Map();
    for(const e of m.evidence) {
      const b=benchmarks.get(e.benchmark);if(!b||b.superseded)continue;
      for(const tag of b.tags){const g=groups.get(tag)??new Map();const f=g.get(b.family??b.id)??[];f.push(e.score);g.set(b.family??b.id,f);groups.set(tag,g);}
    }
    return {id:m.id,price:Number.isFinite(m.inputPrice)&&Number.isFinite(m.outputPrice)?m.inputPrice*3+m.outputPrice:Infinity,
      speed:m.speed?.tokensPerSecond??0,groups};
  });
  for(const c of registry.capabilities) {
    const rows=entries.filter(m=>m.groups.has(c.id)).map(m=>{const groups=[...m.groups.get(c.id).values()];return {...m,coverage:groups.length,quality:groups.reduce((n,g)=>n+g.reduce((a,b)=>a+b,0)/g.length,0)/groups.length};});
    const sorted=compare=>[...rows].sort((a,b)=>compare(a,b)||a.id.localeCompare(b.id)).map(m=>m.id);
    const complete={quality:sorted((a,b)=>b.quality-a.quality||b.coverage-a.coverage),coverage:sorted((a,b)=>b.coverage-a.coverage||b.quality-a.quality),cost:sorted((a,b)=>a.price-b.price||b.coverage-a.coverage),latency:sorted((a,b)=>b.speed-a.speed||b.coverage-a.coverage)};
    byCapability[c.id]={count:rows.length,...Object.fromEntries(Object.entries(complete).map(([k,ids])=>[k,ids.slice(0,limit)])),complete};
  }
  for(const profile of snapshot.specialistProfiles??[]) { const rows=byOperation[profile.operation]??[];rows.push(profile.id);byOperation[profile.operation]=rows; }
  const priceOrder=[...(snapshot.catalogue??snapshot.models)].sort((a,b)=>{
    const cost=m=>m.endpoints?.reduce((n,e)=>Number.isFinite(e.inputPrice)&&Number.isFinite(e.outputPrice)?Math.min(n,e.inputPrice*3+e.outputPrice):n,Infinity)??Infinity;
    return cost(a)-cost(b)||a.id.localeCompare(b.id);
  });
  const routePools={},routeInventory={};
  for(const m of priceOrder) for(const e of m.endpoints??[]) {
    const keys=['all',...(e.modalities??[]),...(e.parameters??[])];
    for(const key of keys){const all=routeInventory[key]??[];if(!all.includes(m.id))all.push(m.id);routeInventory[key]=all;routePools[key]=all.slice(0,limit);}
  }
  return {version:2,limit,byCapability,byOperation,routePools,routeInventory,calibrationModels:[...new Set(calibration.profiles.flatMap(p=>p.models.map(m=>m.id)))],modelCount:snapshot.models.length};
}

export function attachSearch(index) {
  const search=index.snapshot.searchIndex??prepareSearch(index.snapshot);
  return {...index,search,modelById:new Map(index.models.map(m=>[m.id,m])),catalogueById:new Map((index.snapshot.catalogue??index.models).map(m=>[m.id,m])),endpointModel:new Map((index.snapshot.catalogue??index.models).flatMap(m=>(m.endpoints??[]).map(e=>[e.id,m.id])))};
}

export function retrieve(index,task,modelIds=null,endpointIds=null) {
  const allowed=task.selection?.required.length?new Set(task.selection.allowedModelIds??[]):null;
  // Explicit inventory is filtered first and never widened by the index.
  if(modelIds!==null||endpointIds!==null) {
    const selected=modelIds!==null?modelIds:endpointIds.map(id=>index.endpointModel.get(id)).filter(Boolean);
    return [...new Set(selected)].filter(id=>(!allowed||allowed.has(id))&&(endpointIds===null||endpointIds.some(e=>index.endpointModel.get(e)===id)));
  }
  const points=new Map(), preference=task.workload?.priority??'balanced', add=(id,n)=>points.set(id,(points.get(id)??0)+n);
  for(const [cap,weight] of Object.entries(task.weights)) {
    const bucket=index.search.byCapability[cap];if(!bucket)continue;
    for(const key of ['quality','coverage','cost','latency']) (allowed?(bucket.complete?.[key]??bucket[key]??[]).filter(id=>allowed.has(id)).slice(0,index.search.limit):bucket[key]??[]).forEach((id,i)=>add(id,weight*(key===preference?2:1)/(i+8)));
  }
  let ids=[...points].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,index.search.limit).map(x=>x[0]);
  // Calibration has its own exact scope check later; preserve the tested pool.
  ids=[...new Set([...ids,...index.search.calibrationModels.filter(id=>!allowed||allowed.has(id))])];
  if(!ids.length)ids=routeCandidates(index.search,task,['all']);
  return ids;
}

export function routeCandidates(search,task,keys) {
  const allowed=task.selection?.required.length?new Set(task.selection.allowedModelIds??[]):null;
  return [...new Set(keys.flatMap(key=>allowed?(search.routeInventory?.[key]??search.routePools[key]??[]).filter(id=>allowed.has(id)).slice(0,search.limit):search.routePools[key]??[]))];
}

export function narrowIndex(index,task,modelIds,endpointIds) {
  const ids=retrieve(index,task,modelIds,endpointIds), inventory=new Set(ids);
  if(modelIds===null&&endpointIds===null)for(const id of routeCandidates(index.search,task,['all',...(task.needsVision?['image']:[]),...(task.needsTools?['tools']:[]),...(task.needsStructured?['structured_outputs']:[])]))inventory.add(id);
  return {...index,models:ids.flatMap(id=>index.modelById.get(id)??[]),snapshot:{...index.snapshot,catalogue:[...inventory].flatMap(id=>index.catalogueById.get(id)??[])},retrieval:{catalogueModels:index.search.modelCount,consideredModels:ids.length,limit:index.search.limit,exhaustive:ids.length>=index.search.modelCount}};
}
