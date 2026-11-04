import { digest } from './utils.mjs';
import { validatePublication, toSnapshot } from './records.mjs';
import { createIndex, indexStatus } from './rank.mjs';
import {stageProjection,projectionRows} from './projection.mjs';
import {stageEvidence,verifyEvidenceReady,embed,recordLegacyEvidence,pruneEvidence} from './evidence-search.mjs';
import {stageAgentCatalogue} from './agent-projection.ts';

export const getJSON = async (bucket,key) => { const object=await bucket.get(key);return object?object.json():null; };
// Stored JSON escapes non-ASCII text; large containers are serialized piecewise.
const ascii = text => text.replace(/[\u0080-\uffff]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
function jsonPieces(value,depth,out) {
  if(depth>0&&value&&typeof value==='object'&&typeof value.toJSON!=='function') {
    if(Array.isArray(value)) {
      out.push('[');
      value.forEach((item,i)=>{if(i)out.push(',');const at=out.length;jsonPieces(item,depth-1,out);if(out.length===at)out.push('null');});
      out.push(']');return;
    }
    out.push('{');let first=true;
    for(const [key,item] of Object.entries(value)) {
      const mark=out.length;out.push(`${first?'':','}${ascii(JSON.stringify(key))}:`);
      const at=out.length;jsonPieces(item,depth-1,out);
      if(out.length===at){out.length=mark;continue;}
      first=false;
    }
    out.push('}');return;
  }
  const text=JSON.stringify(value);if(text!==undefined)out.push(ascii(text));
}
export function encodeJSON(data) {
  const pieces=[];jsonPieces(data,4,pieces);
  let size=0;for(const piece of pieces)size+=piece.length;
  const bytes=new Uint8Array(size),encoder=new TextEncoder();let at=0;
  for(const piece of pieces)at+=encoder.encodeInto(piece,bytes.subarray(at)).written;
  return bytes;
}
export const putJSON = (bucket,key,data) => bucket.put(key,encodeJSON(data),{httpMetadata:{contentType:'application/json'}});

// Earlier publications store research alongside records; preserve ledger migration.
export const researchKey = recordsKey => recordsKey.replace(/\.json$/,'.research.json');
export async function publishedRecordsKey(bucket) {
  const pointer=await getJSON(bucket,'active.json'),manifest=pointer?await getJSON(bucket,pointer.key):null;
  return manifest?.recordsKey??null;
}
export async function readPublished(bucket) {
  const key=await publishedRecordsKey(bucket);
  if(!key)return null;
  const records=await getJSON(bucket,key);delete records.research;
  return {records};
}

export async function stageCatalogue(bucket,records,previous,options={}) {
  const publication=await validatePublication(records,previous);
  // A new serving generation cannot reuse the retired recommendation manifest.
  publication.id=(await digest(['agent',11,publication.id])).slice(0,32);publication.servingVersion=11;
  const snapshot=toSnapshot({...records,publication}),status=indexStatus(createIndex(snapshot));
  const recordsKey=`catalogues/${publication.id}.json`,{research:archivedResearch,...archive}=records;
  if(archivedResearch?.length)await putJSON(bucket,researchKey(recordsKey),archivedResearch);
  await putJSON(bucket,recordsKey,{...archive,publication});
  const {models,catalogue,specialists,specialistProfiles,benchmarkMethodologies,benchmarkDescriptions,research,researchPending,researchState,searchIndex,...core}=snapshot;
  const manifest={...core,benchmarks:core.benchmarks.map(({research,methodologySelection,definition,...b})=>b),publicStatus:status,recordsKey,publication};
  if(options.db&&options.vectorize) {
    manifest.projection=await stageProjection(options.db,publication.id,snapshot);
    const evidenceKey=`serving-evidence/${publication.id}.json`;
    let evidenceIndex=await getJSON(bucket,evidenceKey);
    // Retain the one-time migration of old version-specific vectors for pruning.
    if(bucket.list)try{await recordLegacyEvidence(options.db,async function*(){let cursor;do{const page=await bucket.list({prefix:'serving-evidence/',cursor});
      for(const o of page.objects)yield {index:await getJSON(bucket,o.key),uploaded:new Date(o.uploaded).toISOString()};cursor=page.truncated?page.cursor:undefined;}while(cursor);});}
    catch(error){console.error('scout legacy evidence vectors not recorded',String(error?.message??error).slice(0,300));}
    if(!evidenceIndex){evidenceIndex=await stageEvidence(options.vectorize,snapshot,publication.id,{...options,cache:{get:key=>getJSON(bucket,key),put:(key,v)=>putJSON(bucket,key,v)}});await putJSON(bucket,evidenceKey,evidenceIndex);}
    await verifyEvidenceReady(options.vectorize,evidenceIndex);manifest.evidenceIndex=evidenceIndex;
    try{manifest.evidencePrune=await pruneEvidence(options.db,options.vectorize,[publication.id,...(previous?.publication?.id?[previous.publication.id]:[])]);}catch(error){manifest.evidencePrune={error:String(error?.message??error).slice(0,300)};}
    try{manifest.agentCatalogue=await stageAgentCatalogue(options.db,publication.id,manifest,projectionRows(snapshot).models,{vectorize:options.vectorize,cache:{get:key=>getJSON(bucket,key),put:(key,value)=>putJSON(bucket,key,value)},
      keep:previous?.publication?.id?[previous.publication.id]:[],...(options.apiKey?{embed:texts=>embed(texts,{apiKey:options.apiKey,fetcher:options.fetcher,timeoutMs:30000})}:{})});}
    catch(error){manifest.agentCatalogue={error:String(error?.message??error).slice(0,300)};console.error('scout agent catalogue not staged',manifest.agentCatalogue.error);}
  }
  const key=`manifests/${publication.id}.json`;await putJSON(bucket,key,manifest);
  return {key,publication,previousVersion:previous?.publication?.id??null};
}

export function createSnapshotReader(bucket,{now=Date.now,ttl=15_000}={}) {
  let active=null,expires=0,pending=null;
  async function manifest() {
    if(active&&now()<expires)return active;
    if(pending)return pending;
    pending=(async()=>{try{const pointer=await getJSON(bucket,'active.json');if(!pointer)throw new Error('Scout is preparing its first catalogue.');const next=active?.publication.id===pointer.publication?.id?active:await getJSON(bucket,pointer.key);if(!next?.publication)throw new Error('Published snapshot unavailable.');active=next;expires=now()+ttl;return next;}catch(error){if(active){expires=now()+2000;return {...active,servingFallback:true};}throw error;}finally{pending=null;}})();
    return pending;
  }
  async function view() {
    const snapshot=await manifest();return {snapshot,cachedStatus:snapshot.publicStatus};
  }
  return {manifest,view};
}
