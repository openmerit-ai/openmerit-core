import {chunks} from './utils.mjs';

// The agent reads complete model records from this versioned table. The retired
// recommendation route's routes, facts and readiness tables are no longer staged.
export const projectionSchema='CREATE TABLE IF NOT EXISTS scout_models (version TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(version,id));';
export function projectionRows(snapshot) {
  const measured=new Map(snapshot.models.map(m=>[m.id,m.evidence])),timing=new Map(snapshot.models.map(m=>[m.id,m.speed]));
  const models=(snapshot.catalogue??snapshot.models).map(m=>({id:m.id,name:m.name,provider:m.provider,endpoints:m.endpoints,facts:m.facts,modalities:m.modalities,parameters:m.parameters,speed:m.speed??timing.get(m.id)??null,evidence:(measured.get(m.id)??[]).map(({benchmark,score,metric,url,observedAt,configurations,raw,provenance})=>({benchmark,score,metric,url,observedAt,configurations,raw,provenance}))}));
  return {models};
}
export async function stageProjection(db,version,snapshot) {
  await db.prepare(projectionSchema).run();const {models}=projectionRows(snapshot);
  // Versions are content-addressed. Retrying cannot temporarily empty a version
  // that the agent is already serving.
  const writes=chunks(models,20).map(batch=>db.prepare("INSERT OR REPLACE INTO scout_models SELECT ?,json_extract(value,'$.id'),value FROM json_each(?)").bind(version,JSON.stringify(batch)));
  for(const batch of chunks(writes,20))await db.batch(batch);
  const {results:[count]}=await db.prepare('SELECT count(*) AS models FROM scout_models WHERE version=?').bind(version).all();
  if(count.models!==models.length)throw Error('Incomplete agent model projection.');
  return {version,models:count.models};
}
