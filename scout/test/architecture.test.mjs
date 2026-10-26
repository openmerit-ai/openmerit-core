import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with {type:'json'};
import {registry} from '../registry.mjs';
import {prepareBenchmarks,refreshBenchmarks} from '../benchmarks.mjs';
import {toRecords,toSnapshot,validateRecords,validatePublication} from '../records.mjs';
import {stageCatalogue,createSnapshotReader,putJSON} from '../store.mjs';
import {createIndex,recommend} from '../rank.mjs';
import {retrieve,narrowIndex,prepareSearch} from '../search-index.mjs';
import {publicURL} from '../utils.mjs';

const bench=(id,description='Visual test')=>({id,name:id,source:'fixture',tags:[],definition:{description,sourceURL:'https://example.com/method'}});
const mock=(capture=()=>{})=>async(_url,options)=>{const body=JSON.parse(options.body);capture(body);return Response.json({answers:body.questions.map(q=>({name:q.name,type:'choice',choice:q.name==='vision'?'supported':'absent',confidence:.99}))});};
const options=fetcher=>({apiKey:'fixture',fetcher});
class Bucket {
  data=new Map();reads=[];
  async put(key,data){this.data.set(key,typeof data==='string'?data:new TextDecoder().decode(data));}
  async get(key){this.reads.push(key);const value=this.data.get(key);return value===undefined?null:{json:async()=>JSON.parse(value)};}
  async head(key){return this.data.has(key)?{}:null;}
}

test('new early-sorted records, changed sibling and reordered inputs do not invalidate unrelated caches',async()=>{
  const before=await prepareBenchmarks([bench('b'),bench('c')],[],options(mock()));const called=[];
  const next=await prepareBenchmarks([bench('c'),bench('a'),bench('b')],before,options(mock(b=>called.push(JSON.parse(b.input.split('\n').at(-1)).benchmark.id))));
  assert.deepEqual(called,['a']);assert.deepEqual(next[0].interpretation,before[1].interpretation);
  const called2=[];await prepareBenchmarks([bench('b','changed'),bench('c')],before,options(mock(b=>called2.push(JSON.parse(b.input.split('\n').at(-1)).benchmark.id))));assert.deepEqual(called2,['b']);
});
test('a new capability asks only the new question and leaves prior semantic answers intact',async()=>{
  const before=await prepareBenchmarks([bench('a')],[],options(mock()));const asked=[];
  const extended={...registry,capabilities:[...registry.capabilities,{id:'novel',label:'Novel',task:'New operation',benchmark:'New operation',parent:'vision'}]};
  await prepareBenchmarks([bench('a')],before,{...options(mock(b=>asked.push(...b.questions.map(q=>q.name)))),registry:extended});assert.deepEqual(asked,['novel']);
});
test('outage retains old definition and matching observations, not new scores under old semantics',async()=>{
  const before=await prepareBenchmarks([bench('a')],[],options(mock()));
  const previous={benchmarks:before,models:[{id:'m',evidence:[{benchmark:'a',score:.5}]}]};
  const next=await refreshBenchmarks({benchmarks:[bench('a','new meaning')],models:[{id:'m',evidence:[{benchmark:'a',score:.9}]}],sources:[{id:'fixture',status:'ok'}]},previous,options(async()=>{throw Error('offline');}));
  assert.equal(next.benchmarks[0].definition.description,'Visual test');assert.equal(next.models[0].evidence[0].score,.5);assert.equal(next.sources[0].status,'failed');
});
test('successful benchmark recovery clears retry state for new and cached interpretations',async()=>{
  const [ready]=await prepareBenchmarks([bench('a')],[],options(mock()));
  const pending={...ready,refreshPending:true,refreshError:'Previous attempt unavailable.'};
  const [cached]=await prepareBenchmarks([pending],[pending],options(mock(()=>assert.fail('Unchanged evidence should reuse its interpretation'))));
  const [updated]=await prepareBenchmarks([{...pending,definition:{...pending.definition,description:'Updated visual test'}}],[pending],options(mock()));
  for(const b of [cached,updated]){assert.equal(b.refreshPending,undefined);assert.equal(b.refreshError,undefined);assert.equal(b.interpretation.status,'ready');}
  assert.equal(updated.definition.description,'Updated visual test');
});
test('normalized catalogue preserves all existing observations, routes and null prices',()=>{
  const records=validateRecords(toRecords(snapshot)),restored=toSnapshot(records);
  assert.equal(restored.models.length,snapshot.models.length);assert.equal(records.observations.length,snapshot.models.reduce((n,m)=>n+m.evidence.length,0));
  assert.deepEqual(restored.models[0].evidence,snapshot.models[0].evidence);
  const bad=structuredClone(records);bad.observations[0].score=Infinity;assert.throws(()=>validateRecords(bad),/observation/);
});
test('publication refuses to lose previously validated evidence and leaves active version unchanged',async()=>{
  const records=toRecords(snapshot),bad=structuredClone(records);bad.benchmarks=bad.benchmarks.filter(b=>b.id!==records.benchmarks[0].id);bad.observations=bad.observations.filter(e=>e.benchmark!==records.benchmarks[0].id);
  await assert.rejects(validatePublication(bad,records),/discard/);
});
test('candidate retrieval remains bounded and explicit inventories never widen',()=>{
  const index=createIndex(snapshot),task={weights:{coding:3},workload:{priority:'balanced'}};
  assert.ok(retrieve(index,task).length<=registry.policy.candidateLimit+index.search.calibrationModels.length);
  assert.deepEqual(retrieve(index,task,[]),[]);assert.deepEqual(retrieve(index,task,['not-a-model']),['not-a-model']);
  assert.equal(narrowIndex(index,task,[],null).models.length,0);
});
test('snapshot reader fetches selected chunks, retains one version, and supports empty scoped results',async()=>{
  const bucket=new Bucket(),records=toRecords(snapshot),staged=await stageCatalogue(bucket,records);
  await putJSON(bucket,'active.json',staged);const reader=createSnapshotReader(bucket),view=await reader.view();
  const task={weights:{coding:3},needsVision:false,needsTools:false,needsStructured:false,kind:'code',workload:{priority:'balanced'},interpreter:'openai-decisions',requirements:{},uncertainty:[]};
  const index=await view.loadTask(task,[],null);assert.equal(index.models.length,0);assert.equal(recommend(index,'Write a function',Date.now(),task).recommendations.length,0);
  assert.equal(index.snapshot.publication.id,staged.publication.id);assert.equal(index.cachedStatus.models,snapshot.models.length);
  assert.ok(!bucket.reads.some(k=>k.startsWith('catalogues/')));
});
test('manifest polling reuses immutable data until the publication pointer changes',async()=>{
  const bucket=new Bucket();let time=0;
  for(const id of ['one','two'])await putJSON(bucket,`manifests/${id}`,{publication:{id}});
  await putJSON(bucket,'active.json',{key:'manifests/one',publication:{id:'one'}});
  const reader=createSnapshotReader(bucket,{now:()=>time,ttl:10});
  assert.equal((await reader.manifest()).publication.id,'one');
  time=11;assert.equal((await reader.manifest()).publication.id,'one');
  assert.equal(bucket.reads.filter(k=>k==='manifests/one').length,1);
  await putJSON(bucket,'active.json',{key:'manifests/two',publication:{id:'two'}});
  time=22;assert.equal((await reader.manifest()).publication.id,'two');
});

test('weak semantic answers get a bounded independent confirmation; disagreement remains uncertain',async()=>{
  const {resolveAmbiguous}=await import('../decisions.mjs');
  const {choice}=await import('../utils.mjs');
  const q=[choice('operation','Does the work require reading visible writing?',{required:'Reading is necessary.',absent:'Reading is not necessary.'})];
  const initial=[{name:'operation',type:'choice',choice:'required',confidence:.2}];let calls=0;
  const fetcher=async(_u,o)=>{calls++;const body=JSON.parse(o.body);return Response.json({answers:body.questions.map((q,i)=>({name:q.name,type:'choice',choice:i===0?'yes':'no',confidence:.99}))});};
  const result=await resolveAmbiguous('Read the visible label.',q,initial,{apiKey:'fixture',fetcher});
  assert.equal(calls,1);assert.equal(result[0].choice,'required');assert.equal(result[0].verified,true);
  const ambiguous=await resolveAmbiguous('Unclear.',q,initial,{apiKey:'fixture',fetcher:async(_u,o)=>Response.json({answers:JSON.parse(o.body).questions.map(q=>({name:q.name,type:'choice',choice:'no',confidence:.99}))})});
  assert.deepEqual(ambiguous,initial);
  const unavailable=await resolveAmbiguous('Unclear.',q,initial,{apiKey:'fixture',fetcher:async()=>{throw Error('offline');}});assert.deepEqual(unavailable,initial);
});

test('research observations and routes survive an independent known-feed refresh',async()=>{
  const {retainResearch}=await import('../pipeline.mjs');
  const route={id:'research-route',source:'research:example.com'};
  const observation={benchmark:'b',score:.6,provenance:[{url:'https://example.com'}],raw:{value:60}};
  const research={description:'Collected methodology description.'};
  const previous={benchmarks:[{id:'b',source:'research:example.com'},{id:'feed-b',source:'epoch',research}],models:[{id:'m',evidence:[observation]}],catalogue:[{id:'m',endpoints:[route]}],sources:[{id:'research:example.com',status:'ok',checkedAt:'2026-01-01T00:00:00Z',maxAgeHours:168}],registry:{...registry,policy:{...registry.policy,maxSourceAgeHours:registry.policy.maxSourceAgeHours+100,retiredSetting:1}}};
  const next={benchmarks:[{id:'feed-b',source:'epoch'}],models:[],catalogue:[{id:'m',endpoints:[]}],sources:[]};retainResearch(next,previous);
  assert.deepEqual(next.models[0].evidence,[observation]);assert.deepEqual(next.catalogue[0].endpoints,[route]);
  // Research is no longer collected: its descriptions stay and its sources are never due.
  assert.deepEqual(next.benchmarks.find(b=>b.id==='feed-b').research,research);
  assert.equal(next.sources[0].refreshPolicy,'retained');
  assert.equal(createIndex({...snapshot,registry,sources:next.sources}).cachedStatus.stale,false);
  // A released policy change reaches the next publication instead of being masked by the previous one.
  assert.equal(next.registry.policy.maxSourceAgeHours,registry.policy.maxSourceAgeHours);assert.equal(next.registry.policy.retiredSetting,1);
});

test('published-reader candidate pool equals local retrieval and is independent of route inventory',async()=>{
  const bucket=new Bucket(),records=toRecords({...snapshot,registry}),staged=await stageCatalogue(bucket,records);await putJSON(bucket,'active.json',staged);
  const task={weights:{reasoning:3,knowledge:1},needsVision:false,kind:'other',workload:{priority:'balanced'}};
  const lazy=await(await createSnapshotReader(bucket).view()).loadTask(task,null,null),local=narrowIndex(createIndex({...snapshot,registry}),task,null,null);
  assert.deepEqual(lazy.models.map(m=>m.id).sort(),local.models.map(m=>m.id).sort());
  assert.ok(lazy.models.length<=registry.policy.candidateLimit+lazy.search.calibrationModels.length);
});

test('cold search reads a bounded number of prepared pools instead of model point reads',async()=>{
 const bucket=new Bucket(),staged=await stageCatalogue(bucket,toRecords({...snapshot,registry}));await putJSON(bucket,'active.json',staged);bucket.reads=[];
 const task={weights:{vision:3,knowledge:1},needsVision:true,kind:'classify',labelSpace:'open',workload:{priority:'balanced'}};
 await(await createSnapshotReader(bucket).view()).loadTask(task,null,null);
 assert.ok(bucket.reads.length<=9,`Remote reads: ${bucket.reads.length}`);
});

test('overlapping capability pools preserve candidates and full evidence with fewer cold reads',async()=>{
 const bucket=new Bucket(),staged=await stageCatalogue(bucket,toRecords({...snapshot,registry}));await putJSON(bucket,'active.json',staged);
 const manifest=JSON.parse(bucket.data.get(staged.key));
 const members=Object.values(manifest.searchIndex.byCapability).filter(b=>b.quality.length).sort((a,b)=>b.quality.length-a.quality.length)[0];
 const ids=[...new Set(['quality','coverage','cost','latency'].flatMap(k=>members[k]))],rows=toSnapshot(toRecords(snapshot)).catalogue.filter(m=>ids.includes(m.id));
 for(let i=0;i<6;i++){
   const cap=`overlap_${i}`,key=`pool-${i}`;manifest.searchIndex.byCapability[cap]={...members,quality:[...members.quality].reverse()};
   manifest.poolKeys[`cap:${cap}`]=key;await putJSON(bucket,key,i%2?[...rows].reverse():rows);
 }
 await putJSON(bucket,staged.key,manifest);bucket.reads=[];
 const task={weights:Object.fromEntries(Array.from({length:6},(_,i)=>[`overlap_${i}`,3])),needsVision:false,kind:'other',workload:{priority:'balanced'}};
 const index=await(await createSnapshotReader(bucket).view()).loadTask(task,null,null);
 assert.equal(bucket.reads.filter(k=>k.startsWith('pool-')).length,1);
 const expected=new Set(retrieve({search:manifest.searchIndex},task));
 assert.deepEqual(index.models.map(m=>m.id).sort(),snapshot.models.filter(m=>expected.has(m.id)).map(m=>m.id).sort());
 const raw=rows=>rows.map(({cohortSize,...e})=>e);
 for(const m of index.models)assert.deepEqual(raw(m.evidence),raw(snapshot.models.find(x=>x.id===m.id).evidence));
});

test('catalogue routes are replaced each collection and, if D1 fails, the previous routes stay with a failed source',async()=>{
 const {addCatalogueRoutes}=await import('../pipeline.mjs'),{loadCatalogue}=await import('../catalogue-routes.ts');
 const route={id:'catalogue:host:chat-completions:m',provider:'Host',modelId:'m',source:'catalogue'};
 const previous={catalogue:[{id:'a',endpoints:[{id:'or',source:'models'},route]}],sources:[{id:'catalogue',status:'ok',checkedAt:'2026-10-25T12:00:00Z'}]};
 const next=()=>({checkedAt:'2026-10-26T00:00:00Z',sources:[],catalogue:[{id:'a',endpoints:[{id:'or',source:'models'},route]}]});
 const broken={prepare:()=>{throw new Error('D1 unavailable');}};
 const kept=addCatalogueRoutes(next(),previous,null,await loadCatalogue(broken,{}).catch(e=>e));
 assert.deepEqual(kept.catalogue[0].endpoints.map(e=>e.id),['or',route.id],'carried-over routes are not duplicated');
 assert.deepEqual([kept.sources[0].status,kept.sources[0].checkedAt],['failed','2026-10-25T12:00:00Z']);
 const empty={prepare:()=>({bind(){return this;},all:async()=>({results:[]})})};
 const fresh=addCatalogueRoutes(next(),previous,await loadCatalogue(empty,{}));
 assert.deepEqual(fresh.catalogue[0].endpoints.map(e=>e.id),['or'],'a route the catalogue no longer lists is dropped');assert.equal(fresh.sources[0].status,'ok');
});

test('semantic-service admission failure stops the refresh before any paid work',async()=>{
 const {runRefresh}=await import('../pipeline.mjs');let failure=null;const calls=[];
 const coordinator={begin:async()=>({acquired:true}),fail:async(_id,message)=>{failure=message;}};
 const env={SCOUT_CATALOGUE:new Bucket(),SCOUT_CONTROL:{getByName:()=>coordinator},OPENAI_API_KEY:'fixture'};
 const step={do:async(name,...args)=>{calls.push(name);if(name==='check-semantic-service')throw Error('Credits unavailable');return args.at(-1)();}};
 await assert.rejects(runRefresh(env,step,'fixture'),/Credits unavailable/);
 assert.deepEqual(calls,['claim-refresh','check-semantic-service','record-failure']);assert.match(failure,/serving the last committed catalogue/);assert.equal(env.SCOUT_CATALOGUE.data.size,0);
});
