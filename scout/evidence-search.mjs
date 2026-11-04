import {digest,chunks,concurrent,fetchJSON} from './utils.mjs';

export const embeddingModel='text-embedding-3-small',embeddingDimensions=256;
export async function embed(input,{apiKey,fetcher=fetch,timeoutMs=4000}={}) {
  const {response,body}=await fetchJSON(fetcher,'https://api.openai.com/v1/embeddings',{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:embeddingModel,dimensions:embeddingDimensions,input})},timeoutMs);
  if(!response.ok){const error=Error(`Evidence embeddings returned HTTP ${response.status}.`);error.providerStatus=response.status;error.code=body?.error?.code;throw error;}
  if(!Array.isArray(body.data)||body.data.length!==input.length)throw Error('Incomplete embeddings.');
  const rows=[...body.data].sort((a,b)=>a.index-b.index);
  if(rows.some((r,i)=>r.index!==i||r.embedding?.length!==embeddingDimensions||r.embedding.some(v=>!Number.isFinite(v))))throw Error('Invalid embeddings.');
  return rows.map(r=>r.embedding);
}
export function evidenceDocuments(snapshot) {
  const measured=Array.isArray(snapshot.models)?new Map():null;
  for(const model of snapshot.models??[])for(const e of model.evidence){const ids=measured.get(e.benchmark)??new Set();ids.add(model.id);measured.set(e.benchmark,ids);}
  return snapshot.benchmarks.filter(b=>!b.superseded&&b.interpretation?.status==='ready').map(b=>({id:b.id,family:b.family??b.id,tags:b.tags,
    modelIds:measured?[...(measured.get(b.id)??[])]:undefined,
    // Keep the verified enrichment and selected methodology used by hourly
    // interpretation. A generic feed label alone can discard the actual scope.
    text:JSON.stringify({name:b.name,research:b.research?{description:b.research.description,methodology:b.research.methodology,limitations:b.research.limitations}:null,methodology:b.methodologySelection?.sections??null,definition:b.definition??null,metric:b.metric??null,limitations:b.limitations??null}).slice(0,12000)}));
}
// Evidence vectors live in one shared namespace, addressed by benchmark and embedded
// text, so a publication upserts only the documents no earlier version indexed. Each
// version records the vectors it uses in D1; a vector goes once no retained version uses it.
export const evidenceNamespace='evidence';
const evidenceSchema=['CREATE TABLE IF NOT EXISTS scout_evidence_vectors (version TEXT NOT NULL, id TEXT NOT NULL, staged_at TEXT NOT NULL, PRIMARY KEY(version,id))','CREATE INDEX IF NOT EXISTS scout_evidence_vectors_id ON scout_evidence_vectors(id)'];
// Versions whose vectors survive besides those in `keep` (the staged and published ones).
const retainedEvidence=5;
const referenced=async(db,ids)=>{const out=new Set();for(const batch of chunks(ids,500))for(const r of (await db.prepare('SELECT DISTINCT id FROM scout_evidence_vectors WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(batch)).all()).results)out.add(r.id);return out;};
export async function stageEvidence(vectorize,snapshot,version,options) {
  // These descriptions and methodology selections were already verified during
  // hourly enrichment. Preserve them directly instead of summarizing them again.
  // Citation excerpts remain in the source records, outside semantic search text.
  const docs=evidenceDocuments(snapshot).filter(d=>!d.modelIds||d.modelIds.length),db=options.db;
  const hashes=await Promise.all(docs.map(d=>digest([embeddingModel,embeddingDimensions,d.text]))),ids=await Promise.all(docs.map((d,i)=>digest([evidenceNamespace,d.id,hashes[i]])));
  if(db)await db.batch(evidenceSchema.map(sql=>db.prepare(sql)));
  const present=db?await referenced(db,ids):new Set(),missing=docs.flatMap((_d,i)=>present.has(ids[i])?[]:[i]);
  const rows=await concurrent(missing,6,async i=>{
    const key=`semantic/embeddings/${hashes[i]}.json`;
    let values=await options.cache?.get(key);if(!values){[values]=await embed([docs[i].text],{...options,timeoutMs:30000});await options.cache?.put(key,values);}
    return {id:ids[i],namespace:evidenceNamespace,values,metadata:{benchmark:docs[i].id}};
  });
  let mutation;const submittedAt=new Date().toISOString();
  for(const batch of chunks(rows,500))mutation=(await vectorize.upsert(batch)).mutationId;
  if(db)await db.batch(chunks(ids,500).map(batch=>db.prepare('INSERT OR IGNORE INTO scout_evidence_vectors (version,id,staged_at) SELECT ?1,value,?2 FROM json_each(?3)').bind(version,options.now??submittedAt,JSON.stringify(batch))));
  return {version,namespace:evidenceNamespace,model:embeddingModel,dimensions:embeddingDimensions,documents:docs.map((d,i)=>({...d,vectorId:ids[i]})),mutationId:mutation,submittedAt,upserted:rows.length};
}
// Versions published before the shared namespace kept a full copy in a namespace named
// after the version. `indexes` yields their evidence indexes once, so pruning removes them too.
export async function recordLegacyEvidence(db,indexes) {
  await db.batch(evidenceSchema.map(sql=>db.prepare(sql)));
  if((await db.prepare('SELECT 1 FROM scout_evidence_vectors LIMIT 1').all()).results.length)return 0;
  // Every index is read before anything is written, so a failed read records nothing and the next publication starts over.
  const versions=[];
  for await(const {index,uploaded} of indexes())if(!index?.namespace&&typeof index?.version==='string'&&Array.isArray(index.documents))
    versions.push({version:index.version,uploaded,ids:index.documents.map(d=>d?.vectorId).filter(id=>typeof id==='string')});
  const writes=versions.flatMap(v=>chunks(v.ids,500).map(batch=>db.prepare('INSERT OR IGNORE INTO scout_evidence_vectors (version,id,staged_at) SELECT ?1,value,?2 FROM json_each(?3)').bind(v.version,v.uploaded,JSON.stringify(batch))));
  for(const batch of chunks(writes,50))await db.batch(batch);
  return versions.reduce((n,v)=>n+v.ids.length,0);
}
// At most this many vectors are deleted per publication; a capped or interrupted prune
// resumes on the next one. Vectorize takes at most 20 IDs per getByIds or deleteByIds call.
export const pruneBudget=2000;
// Deletes the vectors of versions older than the newest retained ones, oldest version first
// and one version at a time: a vector goes once no other listed version uses it, and the
// version's references go only after all its vectors are deleted, so a failure keeps the
// work done and the next publication resumes. The summary is recorded in the manifest.
export async function pruneEvidence(db,vectorize,keep,budget=pruneBudget) {
  const versions=(await db.prepare('SELECT version FROM scout_evidence_vectors GROUP BY version ORDER BY max(staged_at) DESC').all()).results.map(r=>r.version);
  const old=versions.filter(v=>!keep.includes(v)).slice(retainedEvidence).reverse(),summary={versions:0,deleted:0,remaining:old.length};
  for(const version of old){
    const ids=(await db.prepare('SELECT id FROM scout_evidence_vectors s WHERE version=?1 AND NOT EXISTS (SELECT 1 FROM scout_evidence_vectors o WHERE o.id=s.id AND o.version<>?1)').bind(version).all()).results.map(r=>r.id);
    if(summary.versions&&summary.deleted+ids.length>budget)break;
    try{for(const batch of chunks(ids,20)){await vectorize.deleteByIds(batch);summary.deleted+=batch.length;}}
    catch(error){summary.error=String(error?.message??error).slice(0,300);break;}
    await db.prepare('DELETE FROM scout_evidence_vectors WHERE version=?1').bind(version).run();summary.versions++;summary.remaining--;
  }
  return summary;
}
export async function verifyEvidenceReady(vectorize,index) {
  // Nothing new was upserted when every document was already indexed.
  if(index.mutationId){const info=await vectorize.describe();if(info.processedUpToMutation!==index.mutationId&&!(index.submittedAt&&Date.parse(info.processedUpToDatetime)>=Date.parse(index.submittedAt)))throw Error('Vector projection has not finished indexing.');}
  const namespace=index.namespace??index.version;
  await concurrent(chunks(index.documents,20),4,async batch=>{const rows=await vectorize.getByIds(batch.map(d=>d.vectorId));if(batch.some(d=>!rows.some(r=>r.id===d.vectorId&&r.namespace===namespace&&(!d.id||r.metadata?.benchmark===d.id))))throw Error('Vector generation is unavailable.');});
  return true;
}
