import test from'node:test';import assert from'node:assert/strict';import{discoverInventory}from'../discovery.mjs';
import{catalogueInventory,providerMetadata}from'../catalogue.mjs';
import{archiveListings,discoveryBacklog}from'../discovery.mjs';import{LocalD1}from'./helpers-projection.mjs';
test('public discovery preserves exact revisions and resumes without inventing routes, creators or evaluations',async()=>{
 const one={id:'new-org/new-task-model',sha:'a'.repeat(40),pipeline_tag:'previously-unseen-operation'},two={id:'other-org/new-version',sha:'b'.repeat(40)};const snapshot={catalogue:[],checkedAt:'2026-10-16T00:00:00Z'};let calls=0;
 const first=await discoverInventory(snapshot,{}, {fetcher:async()=>{calls++;return Response.json([one],{headers:{link:'<https://huggingface.co/api/models?cursor=second>; rel="next"'}});},pages:1});
 assert.equal(calls,1);assert.match(first.discoveryState.hubNext,/cursor=second/);assert.equal(first.catalogue[0].provider,null);assert.deepEqual(first.catalogue[0].endpoints,[]);assert.deepEqual(first.catalogue[0].evidence,[]);
 const seen=[];const next=await discoverInventory(snapshot,first,{pages:2,fetcher:async url=>{seen.push(url);return Response.json([seen.length===1?one:two]);}});assert.equal(next.catalogue.length,2);assert.match(seen[1],/cursor=second/);
});
test('the durable discovery archive grows independently of the serving snapshot and research advances after publication',async()=>{
 const db=new LocalD1(),snapshot={catalogue:[],checkedAt:'2026-10-16T00:00:00Z'};
 const next=await discoverInventory(snapshot,{}, {archiveDb:db,pages:1,fetcher:async()=>Response.json([{id:'new/model',sha:'a'.repeat(40)}])});assert.equal(next.catalogue.length,0);assert.equal(next.discoverySummary.indexedListings,1);
 const [job]=await discoveryBacklog(db);assert.equal(job.name,'new/model');await archiveListings(db,[job.payload],snapshot.checkedAt);assert.equal((await discoveryBacklog(db)).length,1);
 await db.prepare('UPDATE scout_discovery SET researched_at=? WHERE id=?').bind(new Date().toISOString(),job.id).run();assert.equal((await discoveryBacklog(db)).length,0);
});
test('provider listings are indexed independently of native adapters without assuming the host is the creator',async()=>{
 const reported=providerMetadata({newservice:{name:'Unreviewed hosting service',models:{arbitrary:{id:'new-model',name:'New model',family:'new-line',release_date:'2026-10-01'}}}});
 const rows=await catalogueInventory(reported,[],'2026-10-16');assert.equal(rows.length,1);assert.equal(rows[0].provider,null);assert.deepEqual(rows[0].endpoints,[]);assert.deepEqual(rows[0].facts,[]);assert.equal(rows[0].catalogueSource.service,'Unreviewed hosting service');
});
test('discovery refuses untrusted cursor hosts and private/unpinned records',async()=>{
 const snapshot={catalogue:[],checkedAt:'2026-10-16T00:00:00Z'};
 const next=await discoverInventory(snapshot,{}, {pages:1,fetcher:async()=>Response.json([{id:'a/private',sha:'a'.repeat(40),private:true},{id:'a/moving'}])});assert.equal(next.catalogue.length,0);
 await assert.rejects(discoverInventory(snapshot,{discoveryState:{hubNext:'http://127.0.0.1/private'}},{pages:2,fetcher:async()=>Response.json([])}),/cursor/);
});
