import {profileValue,fieldDefinitions,validateConstraints} from './constraints.mjs';
import {factKinds} from './selection.mjs';
import {chunks} from './utils.mjs';

export const projectionSchema=`
CREATE TABLE IF NOT EXISTS scout_versions (id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, profiles INTEGER NOT NULL, models INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scout_routes (version TEXT NOT NULL, endpoint_id TEXT NOT NULL, model_id TEXT NOT NULL, source TEXT NOT NULL, repository TEXT, facts TEXT NOT NULL, PRIMARY KEY(version,endpoint_id));
CREATE TABLE IF NOT EXISTS scout_facts (version TEXT NOT NULL, endpoint_id TEXT NOT NULL, field TEXT NOT NULL, kind TEXT NOT NULL, text_value TEXT, number_value REAL);
CREATE INDEX IF NOT EXISTS scout_fact_text ON scout_facts(version,field,text_value,endpoint_id);
CREATE INDEX IF NOT EXISTS scout_fact_number ON scout_facts(version,field,number_value,endpoint_id);
CREATE INDEX IF NOT EXISTS scout_fact_route ON scout_facts(version,endpoint_id,field);
CREATE TABLE IF NOT EXISTS scout_models (version TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(version,id));
`;
const sqlOperators={eq:'=',ne:'=',in:'=',not_in:'=',gt:'>',gte:'>=',lt:'<',lte:'<='};
function predicate(c,bindings) {
  const date=factKinds[c.field]==='date',number=date||typeof c.values[0]==='number',column=number?'number_value':'text_value';
  const values=c.values.map(v=>date?Date.parse(v):typeof v==='boolean'?String(v):v);
  bindings.push(c.field,date?'date':typeof c.values[0]);
  const match=['in','not_in'].includes(c.op)?`${column} IN (SELECT value FROM json_each(?))`:`${column} ${sqlOperators[c.op]} ?`;
  bindings.push(['in','not_in'].includes(c.op)?JSON.stringify(values):values[0]);
  const exists=`EXISTS (SELECT 1 FROM scout_facts f WHERE f.version=r.version AND f.endpoint_id=r.endpoint_id AND f.field=? AND f.kind=? AND ${match})`;
  if(!['ne','not_in'].includes(c.op))return exists;
  // Unknown fields cannot satisfy exclusions. A known array must have no match.
  bindings.push(c.field,date?'date':typeof c.values[0]);
  return `(NOT ${exists} AND EXISTS (SELECT 1 FROM scout_facts f WHERE f.version=r.version AND f.endpoint_id=r.endpoint_id AND f.field=? AND f.kind=?))`;
}
export function selectionQuery(version,groups,definitions,{modelIds=null,endpointIds=null,includeFacts=false}={}) {
  validateConstraints(groups,definitions);const bindings=[version],where=['r.version=?'];
  if(groups.length)where.push(`(${groups.map(g=>`(${g.all.map(c=>predicate(c,bindings)).join(' AND ')})`).join(' OR ')})`);
  if(modelIds!==null){where.push("r.source='models' AND r.model_id IN (SELECT value FROM json_each(?))");bindings.push(JSON.stringify(modelIds));}
  if(endpointIds!==null){where.push('r.endpoint_id IN (SELECT value FROM json_each(?))');bindings.push(JSON.stringify(endpointIds));}
  if(bindings.length>100)throw Error('Selection exceeds the database parameter budget.');
  return {sql:`SELECT r.endpoint_id AS endpointId,r.model_id AS modelId,r.repository${includeFacts?',r.facts':''} FROM scout_routes r WHERE ${where.join(' AND ')} ORDER BY r.endpoint_id`,bindings};
}
export function projectionRows(snapshot,directory) {
  const definitions=fieldDefinitions(directory),routes=[...new Map(directory.profiles.map(p=>[p.endpointId,p])).values()],facts=[];
  for(const p of routes)for(const field of Object.keys(definitions)) {
    const v=profileValue(p,field);for(const x of (Array.isArray(v)?v:[v]))if(x!==null&&x!==undefined&&['string','number','boolean'].includes(typeof x)) {
      const numeric=factKinds[field]==='date'?Date.parse(x):typeof x==='number'?x:null;
      if(numeric!==null&&!Number.isFinite(numeric))throw Error('Invalid projection fact.');
      facts.push([p.endpointId,field,factKinds[field]??typeof x,numeric===null?String(x):null,numeric]);
    }
  }
  const measured=new Map(snapshot.models.map(m=>[m.id,m.evidence])),timing=new Map(snapshot.models.map(m=>[m.id,m.speed]));
  // Catalogue identities omit measurements; timing lives on the measured record.
  const models=(snapshot.catalogue??snapshot.models).map(m=>({id:m.id,name:m.name,provider:m.provider,endpoints:m.endpoints,facts:m.facts,modalities:m.modalities,parameters:m.parameters,speed:m.speed??timing.get(m.id)??null,evidence:(measured.get(m.id)??[]).map(({benchmark,score,metric,url,observedAt,configurations,raw,provenance})=>({benchmark,score,metric,url,observedAt,configurations,raw,provenance}))}));
  return {definitions,routes,facts,models};
}
export async function stageProjection(db,version,snapshot,directory) {
  await db.exec(projectionSchema);const rows=projectionRows(snapshot,directory);
  const old=await db.prepare('SELECT ready,profiles,models FROM scout_versions WHERE id=?').bind(version).first();
  if(old?.ready&&old.profiles===rows.routes.length&&old.models===rows.models.length)return {version,profiles:old.profiles,models:old.models};
  await db.batch(['scout_routes','scout_facts','scout_models'].map(t=>db.prepare(`DELETE FROM ${t} WHERE version=?`).bind(version)));
  await db.prepare('INSERT OR REPLACE INTO scout_versions(id,ready,profiles,models) VALUES (?,0,?,?)').bind(version,rows.routes.length,rows.models.length).run();
  const writes=[];
  for(const batch of chunks(rows.routes,100))writes.push(db.prepare("INSERT INTO scout_routes SELECT ?,json_extract(value,'$.endpointId'),json_extract(value,'$.modelId'),json_extract(value,'$.source'),json_extract(value,'$.repository'),json_extract(value,'$.facts') FROM json_each(?)").bind(version,JSON.stringify(batch.map(({endpointId,modelId,source,repository,facts})=>({endpointId,modelId,source,repository,facts})))));
  for(const batch of chunks(rows.facts,500))writes.push(db.prepare("INSERT INTO scout_facts SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?)").bind(version,JSON.stringify(batch)));
  for(const batch of chunks(rows.models,20))writes.push(db.prepare("INSERT INTO scout_models SELECT ?,json_extract(value,'$.id'),value FROM json_each(?)").bind(version,JSON.stringify(batch)));
  for(const batch of chunks(writes,20))await db.batch(batch);
  const count=await db.prepare('SELECT (SELECT count(*) FROM scout_routes WHERE version=?) AS profiles,(SELECT count(*) FROM scout_models WHERE version=?) AS models,(SELECT count(*) FROM scout_facts WHERE version=?) AS facts').bind(version,version,version).first();
  if(count.profiles!==rows.routes.length||count.models!==rows.models.length||count.facts!==rows.facts.length)throw Error('Incomplete serving projection.');
  await db.prepare('UPDATE scout_versions SET ready=1 WHERE id=?').bind(version).run();return {version,profiles:count.profiles,models:count.models};
}
export async function queryProjection(db,version,groups,definitions,scope) {
  const query=selectionQuery(version,groups,definitions,scope);
  // Both reads refer to the same immutable generation. Eligibility is never
  // returned before readiness is confirmed, but the reads need not serialize.
  const [ready,result]=await Promise.all([db.prepare('SELECT ready FROM scout_versions WHERE id=?').bind(version).first(),db.prepare(query.sql).bind(...query.bindings).all()]);
  if(!ready?.ready)throw Error('Serving projection unavailable.');
  return result.results.map(r=>r.facts?{...r,facts:JSON.parse(r.facts)}:r);
}
export async function loadProjectionModels(db,version,modelIds,benchmarkIds) {
  if(!modelIds.length)return [];
  // Filter observations in SQL before transferring records to the Worker. No
  // top-K model cap is applied before the numerical frontier is calculated.
  const evidence=benchmarkIds.length?"COALESCE((SELECT json_group_array(json(e.value)) FROM json_each(scout_models.payload,'$.evidence') e WHERE json_extract(e.value,'$.benchmark') IN (SELECT value FROM json_each(?))),'[]')":"'[]'";
  const bindings=benchmarkIds.length?[JSON.stringify(benchmarkIds),version,JSON.stringify(modelIds)]:[version,JSON.stringify(modelIds)];
  const result=await db.prepare(`SELECT json_set(payload,'$.evidence',json(${evidence})) AS payload FROM scout_models WHERE version=? AND id IN (SELECT value FROM json_each(?))`).bind(...bindings).all();
  return result.results.map(r=>JSON.parse(r.payload));
}
