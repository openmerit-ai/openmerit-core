import { digest, concurrent, chunks } from './utils.mjs';
import { validatePublication, toSnapshot } from './records.mjs';
import { prepareSearch, retrieve, routeCandidates } from './search-index.mjs';
import { createIndex, indexStatus } from './rank.mjs';
import { relevantProfiles } from './specialists.mjs';
import { prepareEligibility } from './eligibility.mjs';
import {fieldDefinitions} from './constraints.mjs';
import {stageProjection} from './projection.mjs';
import {stageEvidence,verifyEvidenceReady} from './evidence-search.mjs';

export function shardFor(id) {
  let hash=2166136261;for(const c of id)hash=Math.imul(hash^c.charCodeAt(0),16777619);
  return (hash>>>0).toString(16).padStart(8,'0').slice(0,3);
}
export const getJSON = async (bucket,key) => { const object=await bucket.get(key);return object?object.json():null; };
export const putJSON = (bucket,key,data) => bucket.put(key,JSON.stringify(data),{httpMetadata:{contentType:'application/json'}});

// Research is stored beside the published records, so refresh steps that do
// not use it never parse it. Generations published before the split embed it.
export const researchKey = recordsKey => recordsKey.replace(/\.json$/,'.research.json');
export async function readPublished(bucket,{records:withRecords=true,research:withResearch=false}={}) {
  const pointer=await getJSON(bucket,'active.json'),manifest=pointer?await getJSON(bucket,pointer.key):null;
  if(!manifest)return null;
  let research=withResearch?await getJSON(bucket,researchKey(manifest.recordsKey)):null,records=null;
  if(withRecords||(withResearch&&!research)) {
    records=await getJSON(bucket,manifest.recordsKey);
    if(withResearch)research??=records.research??[];
    delete records.research;
  }
  return {records:withRecords?records:null,research};
}

// Refresh-time materialization replaces a wave of per-repository remote reads.
// Profiles remain the selection index; a pack does not limit eligible models.
export async function stageSpecialistPacks(bucket,snapshot) {
  const byId=new Map(snapshot.specialists.map(s=>[s.id,s])),keys={};
  for(const operation of new Set(snapshot.specialistProfiles.map(p=>p.operation)))for(const profiles of chunks(snapshot.specialistProfiles.filter(p=>p.operation===operation),32)) {
    const ids=new Set(profiles.flatMap(p=>p.repositories)),rows=[...ids].sort().flatMap(id=>byId.get(id)??[]),key=`chunks/${await digest(rows)}.json`;
    if(!await bucket.head(key))await putJSON(bucket,key,rows);
    for(const p of profiles)keys[p.id]=key;
  }
  return keys;
}

// Pools contain complete model records. Use a small covering set instead of
// downloading the same records once per capability.
function modelPoolKeys(manifest,task,candidates) {
  const remaining=new Set(candidates),pools=Object.keys(task.weights).map(cap=>{
    const b=manifest.searchIndex.byCapability[cap];
    return {key:manifest.poolKeys[`cap:${cap}`],ids:new Set(b?['quality','coverage','cost','latency'].flatMap(k=>b[k]??[]):[])};
  });
  pools.push({key:manifest.poolKeys.calibration,ids:new Set(manifest.searchIndex.calibrationModels)});
  if(task.selection?.required.length)for(const pool of manifest.eligibilityPools??[])pools.push({key:pool.key,ids:new Set(pool.ids)});
  const keys=[];
  while(remaining.size) {
    let best,covered=0;
    for(const pool of pools) {
      const count=pool.key?[...remaining].reduce((n,id)=>n+Number(pool.ids.has(id)),0):0;
      if(count>covered){best=pool;covered=count;}
    }
    if(!best)break;
    keys.push(best.key);for(const id of best.ids)remaining.delete(id);
  }
  for(const shard of new Set([...remaining].map(shardFor)))if(manifest.shards[`models/${shard}`])keys.push(manifest.shards[`models/${shard}`]);
  return keys;
}

export async function stageCatalogue(bucket,records,previous,options={}) {
  const evidenceEngine=!!(options.db&&options.vectorize);
  const publication=await validatePublication(records,previous);
  if(evidenceEngine){publication.id=(await digest(['evidence',10,publication.id])).slice(0,32);publication.servingVersion=10;}
  const snapshot=toSnapshot({...records,publication});
  if(evidenceEngine)snapshot.servingEngine='evidence';else snapshot.searchIndex=prepareSearch(snapshot);
  const status=indexStatus(createIndex(snapshot)), groups=new Map();
  for(const [kind,rows] of evidenceEngine?[['specialists',snapshot.specialists]]:[['models',snapshot.catalogue],['specialists',snapshot.specialists]])for(const row of rows) {
    const key=`${kind}/${shardFor(row.id)}`, group=groups.get(key)??[];group.push(row);groups.set(key,group);
  }
  if(!evidenceEngine)for(const e of records.endpoints){const key=`endpoints/${shardFor(e.id)}`,group=groups.get(key)??[];group.push({id:e.id,modelId:e.canonicalModelId});groups.set(key,group);}
  const shards={};
  await concurrent([...groups],12,async([name,rows])=>{
    const sorted=rows.sort((a,b)=>a.id.localeCompare(b.id)),hash=await digest(sorted),key=`chunks/${hash}.json`;
    // Content addresses let unchanged chunks survive every new publication.
    if(!await bucket.head(key))await putJSON(bucket,key,sorted);
    shards[name]=key;
  });
  const recordsKey=`catalogues/${publication.id}.json`,{research:archivedResearch,...archive}=records;
  await putJSON(bucket,researchKey(recordsKey),archivedResearch??[]);
  await putJSON(bucket,recordsKey,{...archive,publication});
  if(options.db&&options.vectorize) {
    const directory=prepareEligibility(snapshot),projection=await stageProjection(options.db,publication.id,snapshot,directory);
    const evidenceKey=`serving-evidence/${publication.id}.json`;
    let evidenceIndex=await getJSON(bucket,evidenceKey);
    if(!evidenceIndex){evidenceIndex=await stageEvidence(options.vectorize,snapshot,publication.id,{...options,cache:{get:key=>getJSON(bucket,key),put:(key,v)=>putJSON(bucket,key,v)}});await putJSON(bucket,evidenceKey,evidenceIndex);}
    await verifyEvidenceReady(options.vectorize,evidenceIndex);
    const profileKeys={};for(const operation of new Set(snapshot.specialistProfiles.map(p=>p.operation))) {
      const rows=snapshot.specialistProfiles.filter(p=>p.operation===operation),key=`chunks/${await digest(rows)}.json`;if(!await bucket.head(key))await putJSON(bucket,key,rows);profileKeys[operation]=key;
    }
    const specialistPacks=await stageSpecialistPacks(bucket,snapshot);
    const {models,catalogue,specialists,benchmarkMethodologies,benchmarkDescriptions,research,researchPending,researchState,searchIndex,...core}=snapshot;
    const manifest={...core,servingEngine:'evidence',projection,metadataDefinitions:fieldDefinitions(directory),selectionVocabulary:directory.vocabulary,evidenceIndex,specialistProfiles:undefined,benchmarks:core.benchmarks.map(({research,methodologySelection,definition,...b})=>b),publicStatus:status,shards,profileKeys,specialistPacks,recordsKey,publication};
    const key=`manifests/${publication.id}.json`;await putJSON(bucket,key,manifest);return {key,publication,previousVersion:previous?.publication?.id??null};
  }
  // Request-sized materialized pools avoid hundreds of remote point reads.
  // Their cardinality is bounded by retrieval policy, not catalogue size.
  const byId=new Map(snapshot.catalogue.map(m=>[m.id,m])),poolKeys={};
  const pools=[['calibration',snapshot.searchIndex.calibrationModels.flatMap(id=>byId.get(id)??[])]];
  for(const [cap,b] of Object.entries(snapshot.searchIndex.byCapability))pools.push([`cap:${cap}`,[...new Set(['quality','coverage','cost','latency'].flatMap(k=>b[k]))].flatMap(id=>byId.get(id)??[])]);
  for(const [kind,ids] of Object.entries(snapshot.searchIndex.routePools))pools.push([`route:${kind}`,ids.flatMap(id=>byId.get(id)??[]).map(m=>({...m,evidence:[]}))]);
  const hub=new Map(snapshot.specialists.map(m=>[m.id,m]));
  for(const operation of Object.keys(snapshot.searchIndex.byOperation)) {
    const ids=new Set(snapshot.specialistProfiles.filter(p=>p.operation===operation).slice(0,snapshot.registry.policy.profileLimit).flatMap(p=>p.repositories));
    pools.push([`hub:${operation}`,[...ids].flatMap(id=>hub.get(id)??[])]);
  }
  await concurrent(pools,8,async([name,rows])=>{const key=`chunks/${await digest(rows)}.json`;if(!await bucket.head(key))await putJSON(bucket,key,rows);poolKeys[name]=key;});
  const directory=prepareEligibility(snapshot),eligibilityPools=[];
  const facets=new Map();
  for(const entry of Object.values(directory.facets).flat()) {
    const ids=[...new Set(entry.members.map(i=>directory.profiles[i].modelId).filter(id=>byId.has(id)))].sort();
    if(ids.length>1&&ids.length<=snapshot.searchIndex.limit)facets.set(JSON.stringify(ids),new Set(ids));
  }
  await concurrent([...facets.values()],8,async ids=>{const rows=[...ids].sort().flatMap(id=>byId.get(id)??[]),key=`chunks/${await digest(rows)}.json`;if(!await bucket.head(key))await putJSON(bucket,key,rows);eligibilityPools.push({key,ids:[...ids]});});
  const eligibilityKey=`chunks/${await digest(directory)}.json`;if(!await bucket.head(eligibilityKey))await putJSON(bucket,eligibilityKey,directory);
  const {models,catalogue,specialists,benchmarkMethodologies,benchmarkDescriptions,research,researchPending,researchState,...core}=snapshot;
  const profiles={};
  for(const p of snapshot.specialistProfiles) {const list=profiles[p.operation]??[];list.push(p);profiles[p.operation]=list;}
  const profileKeys={};
  for(const [operation,rows] of Object.entries(profiles)) {
    const key=`chunks/${await digest(rows)}.json`;if(!await bucket.head(key))await putJSON(bucket,key,rows);profileKeys[operation]=key;
  }
  const manifest={...core,selectionMetadataVersion:'1',selectionVocabulary:directory.vocabulary,specialistProfiles:undefined,benchmarks:core.benchmarks.map(({research,methodologySelection,...b})=>b),publicStatus:status,shards,profileKeys,poolKeys,eligibilityKey,eligibilityPools,recordsKey,publication};
  const key=`manifests/${publication.id}.json`;await putJSON(bucket,key,manifest);
  return {key,publication,previousVersion:previous?.publication?.id??null};
}

export function createSnapshotReader(bucket,{now=Date.now,ttl=15_000,maxCachedChunks=192}={}) {
  let active=null,expires=0,pending=null;const cache=new Map();
  async function chunk(key) {
    if(!key)return [];
    if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
    const promise=getJSON(bucket,key).then(v=>{if(!v)throw new Error('Snapshot chunk unavailable.');return v;}).catch(e=>{cache.delete(key);throw e;});cache.set(key,promise);
    while(cache.size>maxCachedChunks)cache.delete(cache.keys().next().value);
    return promise;
  }
  async function manifest() {
    if(active&&now()<expires)return active;
    if(pending)return pending;
    pending=(async()=>{try{const pointer=await getJSON(bucket,'active.json');if(!pointer)throw new Error('Scout is preparing its first catalogue.');const next=active?.publication.id===pointer.publication?.id?active:await getJSON(bucket,pointer.key);if(!next?.publication)throw new Error('Published snapshot unavailable.');active=next;expires=now()+ttl;return next;}catch(error){if(active){expires=now()+2000;return {...active,servingFallback:true};}throw error;}finally{pending=null;}})();
    return pending;
  }
  async function view() {
    const m=await manifest();
    if(m.servingEngine==='evidence')return {snapshot:m,cachedStatus:m.publicStatus,loadSpecialists:async task=>{
      const operations=Object.keys(m.profileKeys).filter(operation=>relevantProfiles([{id:operation,operation}],task).length);
      const [groups,backfill]=await Promise.all([Promise.all(operations.map(o=>chunk(m.profileKeys[o]))),m.specialistPacks?null:chunk(`serving-specialists/${m.publication.id}.json`).catch(()=>null)]);
      const profiles=groups.flat().filter(p=>p.repositories.some(id=>task.selection.allowedRepositories.includes(id))).slice(0,m.registry.policy.profileLimit);
      const repos=new Set(profiles.flatMap(p=>p.repositories).filter(id=>task.selection.allowedRepositories.includes(id)));
      const packIndex=m.specialistPacks??(backfill?.publicationId===m.publication.id&&JSON.stringify(backfill.profileKeys)===JSON.stringify(m.profileKeys)?backfill.packs:null);
      const packed=profiles.flatMap(p=>packIndex?.[p.id]??[]);
      const keys=packed.length===profiles.length?[...new Set(packed)]:[...new Set([...repos].map(shardFor))].map(s=>m.shards[`specialists/${s}`]);
      const specialists=[...new Map((await concurrent(keys,6,key=>chunk(key))).flat().filter(s=>repos.has(s.id)).map(s=>[s.id,s])).values()];return {profiles,specialists};
    }};
    return {snapshot:m,cachedStatus:m.publicStatus,loadEligibility:()=>chunk(m.eligibilityKey),loadTask:async(task,modelIds,endpointIds)=>{
      const started=performance.now();
      // Scoped endpoints are mapped by a small, independently sharded directory.
      let scoped=modelIds;
      if(endpointIds!==null){const dirs=(await Promise.all([...new Set(endpointIds.map(shardFor))].map(s=>chunk(m.shards[`endpoints/${s}`])))).flat();const mapped=endpointIds.map(id=>dirs.find(e=>e.id===id)?.modelId).filter(Boolean);scoped=modelIds===null?mapped:modelIds.filter(id=>mapped.includes(id));}
      const allowed=task.selection?.required.length?new Set(task.selection.allowedModelIds??[]):null;
      const candidates=scoped!==null?scoped.filter(id=>!allowed||allowed.has(id)):retrieve({search:m.searchIndex},task);
      let ids=candidates;
      const routeKinds=['all',...(task.needsVision?['image']:[]),...(task.needsTools?['tools']:[]),...(task.needsStructured?['structured_outputs']:[])];
      if(scoped===null)ids=[...new Set([...ids,...routeCandidates(m.searchIndex,task,routeKinds)])];
      const keys=scoped===null&&m.poolKeys
        ? allowed?modelPoolKeys(m,task,ids):[...modelPoolKeys(m,task,candidates),...routeKinds.map(kind=>m.poolKeys[`route:${kind}`])]
        : [...new Set(ids.map(shardFor))].map(s=>m.shards[`models/${s}`]);
      const operations=Object.keys(m.profileKeys).filter(operation=>relevantProfiles([{id:operation,operation}],task).length);
      // These pools are independent: a cold request needs one read phase.
      const [modelGroups,profileGroups,hubGroups]=await Promise.all([
        concurrent([...new Set(keys.filter(Boolean))],6,key=>chunk(key)),
        Promise.all(operations.map(o=>chunk(m.profileKeys[o]))),
        m.poolKeys&&!allowed?concurrent(operations.map(o=>m.poolKeys[`hub:${o}`]),6,key=>chunk(key)):null,
      ]);
      const fetched=modelGroups.flat();
      // Rich measured records win over route-only copies of the same model.
      const unique=new Map();for(const row of fetched)if(!unique.has(row.id)||(row.evidence?.length??0)>(unique.get(row.id).evidence?.length??0))unique.set(row.id,row);
      const rows=[...unique.values()];
      const set=new Set(ids),catalogue=rows.filter(x=>set.has(x.id));
      const profiles=profileGroups.flat().filter(p=>!allowed||p.repositories.some(id=>task.selection.allowedRepositories.includes(id))).slice(0,m.registry.policy.profileLimit);
      const repos=new Set(profiles.flatMap(p=>p.repositories).filter(id=>!allowed||task.selection.allowedRepositories.includes(id)));
      const hubKeys=[...new Set([...repos].map(shardFor))].map(s=>m.shards[`specialists/${s}`]);
      const specialists=[...new Map((hubGroups??await concurrent(hubKeys,6,key=>chunk(key))).flat().filter(x=>repos.has(x.id)).map(x=>[x.id,x])).values()];
      const candidateSet=new Set(candidates);
      const index=createIndex({...m,catalogue,models:catalogue.filter(x=>candidateSet.has(x.id)&&x.evidence.length),specialists,specialistProfiles:profiles});
      index.retrieval={catalogueModels:m.publicStatus.models,consideredModels:index.models.length,limit:m.searchIndex.limit,exhaustive:index.models.length>=m.publicStatus.models,elapsedMs:Math.round(performance.now()-started)};
      return index;
    }};
  }
  return {manifest,view};
}
