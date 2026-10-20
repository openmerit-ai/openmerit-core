import {digest}from'./utils.mjs';

// Discovery is resumable and independent of task/protocol support. A listing
// establishes identity/provenance, not creator, quality or an executable route.
export const discoverySchema=`CREATE TABLE IF NOT EXISTS scout_discovery (id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,payload TEXT NOT NULL,last_seen TEXT NOT NULL,researched_at TEXT); CREATE INDEX IF NOT EXISTS scout_discovery_queue ON scout_discovery(researched_at,last_seen);`;
export async function archiveListings(db,rows,checkedAt) {
  await db.exec(discoverySchema);
  for(let i=0;i<rows.length;i+=100)await db.prepare("INSERT INTO scout_discovery(id,name,url,payload,last_seen) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.discovery.url'),value,? FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,payload=excluded.payload").bind(checkedAt,JSON.stringify(rows.slice(i,i+100))).run();
}
export async function discoveryBacklog(db,{limit=24,maxAgeHours=168,now=Date.now()}={}) {
  await db.exec(discoverySchema);
  const result=await db.prepare('SELECT id,name,url,payload FROM scout_discovery WHERE researched_at IS NULL OR researched_at<? ORDER BY researched_at IS NOT NULL,last_seen DESC,id LIMIT ?').bind(new Date(now-maxAgeHours*3600000).toISOString(),limit).all();
  return result.results.map(r=>({...r,payload:JSON.parse(r.payload)}));
}
export async function discoverInventory(snapshot,previous,{fetcher=fetch,pages=2,pageSize=100,archiveDb}={}) {
  const inventory=new Map(snapshot.catalogue.map(m=>[m.id,m]));
  for(const m of previous.catalogue??[])if(m.discovery&&!inventory.has(m.id))inventory.set(m.id,m);
  const state={...(previous.discoveryState??{})},queries=[],discovered=[];
  const base=new URL('https://huggingface.co/api/models');
  base.searchParams.set('sort','lastModified');base.searchParams.set('direction','-1');base.searchParams.set('limit',String(pageSize));
  for(const field of ['sha','pipeline_tag','lastModified','private','disabled'])base.searchParams.append('expand',field);
  const savedCursor=state.hubNext??base.href;let cursor=savedCursor;
  const savedURL=new URL(savedCursor);if(savedURL.origin!==base.origin||savedURL.pathname!==base.pathname)throw Error('Invalid public discovery cursor.');
  for(let i=0;i<pages;i++) {
    const url=new URL(i===0?base.href:cursor);
    if(url.origin!==base.origin||url.pathname!==base.pathname)throw Error('Invalid public discovery cursor.');
    const response=await fetcher(url.href,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`Model discovery returned HTTP ${response.status}.`);
    const rows=await response.json();if(!Array.isArray(rows)||rows.length>pageSize)throw Error('Invalid public model discovery.');
    for(const m of rows) {
      if(typeof m.id!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(m.id)||m.private||m.disabled||typeof m.sha!=='string'||!/^[a-f0-9]{40,64}$/.test(m.sha))continue;
      const id=`hub:${await digest([m.id,m.sha])}`;
      const record={id,name:m.id,provider:null,repository:m.id,revision:m.sha,facts:[],modalities:[],outputModalities:[],parameters:[],context:null,inputPrice:null,outputPrice:null,speed:null,evidence:[],endpoints:[],discovery:{source:'huggingface',url:`https://huggingface.co/${m.id}/blob/${m.sha}/README.md`,checkedAt:snapshot.checkedAt,pipeline:m.pipeline_tag??null}};
      discovered.push(record);if(!inventory.has(id))inventory.set(id,record);
    }
    const next=response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    queries.push(url.href);cursor=i===0&&pages>1&&savedCursor!==base.href?savedCursor:next??base.href;
    if(i>0&&!next)break;
  }
  state.hubNext=cursor;state.hubCheckedAt=snapshot.checkedAt;
  let indexedListings=inventory.size;if(archiveDb){await archiveListings(archiveDb,discovered,snapshot.checkedAt);indexedListings=(await archiveDb.prepare('SELECT count(*) AS count FROM scout_discovery').first()).count;}
  return {...snapshot,catalogue:archiveDb?snapshot.catalogue:[...inventory.values()],discoveryState:state,discoverySummary:{pages:queries.length,indexedListings,scope:'Public listings; discovery does not establish endpoint compatibility or benchmark quality.'}};
}
