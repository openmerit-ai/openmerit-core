import test from 'node:test';
import assert from 'node:assert/strict';
import {providerMetadata} from '../catalogue.mjs';
import {refreshModelMetadata} from '../metadata.mjs';
import {toRecords,toSnapshot} from '../records.mjs';
import seed from '../snapshot.json' with {type:'json'};

const model={id:'maker/checkpoint',name:'Checkpoint',facts:[{field:'creator',value:'Maker'}],endpoints:[{id:'route',provider:'Unreviewed Host',modelId:'maker/checkpoint',source:'models',context:128000}],evidence:[]};
const feed={unreviewed:{name:'Unreviewed Host',models:{one:{id:'maker/checkpoint',name:'Checkpoint',family:'line',release_date:'2026-09-20'}}}};
const snapshot={catalogue:[model],models:[],providerMetadata:providerMetadata(feed)};
const accept=async(_u,o)=>{const b=JSON.parse(o.body);return Response.json({answers:b.questions.map(q=>({name:q.name,type:'choice',choice:q.choices.find(c=>c.value!=='not_established').value,confidence:.99}))});};

test('all service feeds contribute metadata without inventing an endpoint or a creator',async()=>{
 assert.equal(snapshot.providerMetadata.length,1);
 const r=await refreshModelMetadata(snapshot,null,{apiKey:'fixture',fetcher:accept}),m=r.catalogue[0];
 assert.equal(m.facts.find(f=>f.field==='family').value,'line');assert.equal(m.facts.find(f=>f.field==='releasedAt').value,'2026-09-20');
 assert.equal(m.facts.find(f=>f.field==='creator').value,'Maker');assert.deepEqual(m.endpoints,model.endpoints);assert.ok(!('providerMetadata'in r));
});
test('only the same service and exact model API ID can propose a metadata transfer',async()=>{
 const r=await refreshModelMetadata({...snapshot,catalogue:[{...model,endpoints:[{...model.endpoints[0],provider:'Different Host'}]}]},null,{apiKey:'fixture',fetcher:()=>assert.fail('Unmatched service must not be interpreted')});
 assert.ok(!r.catalogue[0].facts.some(f=>f.field==='family'));
 const other=await refreshModelMetadata({...snapshot,catalogue:[{...model,endpoints:[{...model.endpoints[0],modelId:'maker/different-version'}]}]},null,{apiKey:'fixture',fetcher:()=>assert.fail('Different API ID must not be interpreted')});assert.ok(!other.catalogue[0].metadataInspection);
});
test('semantic exact-identity rejection never transfers source facts',async()=>{
 const r=await refreshModelMetadata(snapshot,null,{apiKey:'fixture',fetcher:async(u,o)=>{const b=await(await accept(u,o)).json();b.answers[0].choice='not_established';return Response.json(b);}});
 assert.ok(!r.catalogue[0].facts.some(f=>f.field==='family'||f.field==='releasedAt'));
});
test('unchanged source metadata reuses interpretation and changed version facts are rechecked',async()=>{
 const first=await refreshModelMetadata(snapshot,null,{apiKey:'fixture',fetcher:accept});
 const second=await refreshModelMetadata(snapshot,first,{apiKey:'fixture',fetcher:()=>assert.fail('Unchanged metadata must reuse the cache')});
 assert.deepEqual(second.catalogue[0].facts,first.catalogue[0].facts);
 let calls=0;await refreshModelMetadata({...snapshot,providerMetadata:snapshot.providerMetadata.map(r=>({...r,release_date:'2026-09-21'}))},first,{apiKey:'fixture',fetcher:(...args)=>{calls++;return accept(...args);}});assert.equal(calls,1);
});
test('transport failures do not masquerade as rejected or missing metadata',async()=>{
 await assert.rejects(refreshModelMetadata(snapshot,null,{apiKey:'fixture',fetcher:async()=>new Response('{}',{status:401})}),/HTTP 401/);
});
test('source-outage reuse requires unchanged endpoint identity as well as the model name',async()=>{
 const first=await refreshModelMetadata(snapshot,null,{apiKey:'fixture',fetcher:accept});
 const retained=await refreshModelMetadata({...snapshot,providerMetadata:[]},first,{apiKey:'fixture',fetcher:()=>assert.fail('Unchanged verified identity can be retained')});assert.ok(retained.catalogue[0].facts.some(f=>f.field==='family'));
 const changed=await refreshModelMetadata({...snapshot,providerMetadata:[],catalogue:[{...model,endpoints:[{...model.endpoints[0],modelId:'changed-version'}]}]},first,{apiKey:'fixture',fetcher:()=>assert.fail('There is no source evidence to interpret')});assert.ok(!changed.catalogue[0].facts.some(f=>f.field==='family'));
});
test('new metadata survives measured model copies and normalized publication round trips',async()=>{
 const base=structuredClone(seed),original=base.models[0];
 base.catalogue=base.models.map(m=>({...m,facts:[{field:'creator',value:m.provider}]}));
 const pick=base.catalogue[0],endpoint=pick.endpoints?.[0];assert.ok(endpoint);
 base.providerMetadata=[{service:endpoint.provider,modelId:endpoint.modelId,name:pick.name,family:'verified-line',release_date:'2026-09-20'}];
 const next=await refreshModelMetadata(base,null,{apiKey:'fixture',fetcher:accept}),roundtrip=toSnapshot(toRecords(next));
 const m=roundtrip.catalogue.find(m=>m.id===original.id);assert.equal(m.facts.find(f=>f.field==='family').value,'verified-line');assert.ok(m.metadataInspection.sourceHash);assert.equal(m.evidence.length,original.evidence.length);
});
