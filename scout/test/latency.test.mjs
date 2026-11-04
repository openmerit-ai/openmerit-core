import test from 'node:test';
import assert from 'node:assert/strict';
import {createResultCache} from '../result-cache.mjs';
import {stageSpecialistPacks,createSnapshotReader,putJSON,shardFor} from '../store.mjs';
import {compactVocabulary} from '../interpreter.mjs';
import {createTimings} from '../timing.mjs';
import {searchRecord} from '../analytics.mjs';

const result=()=>({task:{},recommendations:[{modelId:'fixture'}]});
test('identical concurrent searches share work without sharing mutable results',async()=>{
 let calls=0;const cached=createResultCache(),compute=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return result();};
 const [a,b]=await Promise.all([cached('exact',compute),cached('exact',compute)]);
 assert.equal(calls,1);assert.equal(a.status,'miss');assert.equal(b.status,'shared');a.value.recommendations.length=0;
 assert.equal(b.value.recommendations.length,1);assert.equal((await cached('exact',compute)).value.recommendations.length,1);
});
test('cache expires, evicts and never reuses failed or incomplete checks',async()=>{
 let time=0,calls=0;const cached=createResultCache({now:()=>time,ttlMs:10,maxEntries:1,maxBytes:1000});const compute=async()=>{calls++;return result();};
 await cached('a',compute);time=10;assert.equal((await cached('a',compute)).status,'miss');
 await cached('b',compute);assert.equal((await cached('a',compute)).status,'miss');
 await assert.rejects(cached('failure',async()=>{throw Error('failed');}));assert.equal((await cached('failure',compute)).status,'miss');
 for(const [i,task] of [{specialistMatch:{status:'unavailable'}},{evidenceMatch:{degraded:true}}].entries()){const key=`partial${i}`;await cached(key,async()=>({...result(),task}));assert.equal((await cached(key,compute)).status,'miss');}
 assert.ok(calls>=6);
});
test('oversized results do not evict a small reusable entry',async()=>{
 const cached=createResultCache({maxBytes:500});await cached('small',async()=>result());
 await cached('big',async()=>({...result(),padding:'x'.repeat(1000)}));assert.equal((await cached('small',async()=>assert.fail())).status,'hit');
});
test('hourly packs retain scoped specialist records with bounded reads and immutable cache reuse',async()=>{
 const objects=new Map(),reads=[];const bucket={head:async k=>objects.has(k),get:async k=>{reads.push(k);return objects.has(k)?{json:async()=>JSON.parse(objects.get(k))}:null;},put:async(k,v)=>objects.set(k,(typeof v==='string'?v:new TextDecoder().decode(v)))};
 const specialists=Array.from({length:80},(_,i)=>({id:`lab/model${i}`,revision:'same',metadata:{exact:i}}));
 const profiles=specialists.map((s,i)=>({id:`profile${i}`,operation:'image_labels',repositories:[s.id]}));
 const packs=await stageSpecialistPacks(bucket,{specialists,specialistProfiles:profiles});
 await putJSON(bucket,'profiles',profiles);await putJSON(bucket,'manifest',{publication:{id:'new'},servingEngine:'evidence',registry:{policy:{profileLimit:64}},profileKeys:{image_labels:'profiles'},specialistPacks:packs});await putJSON(bucket,'active.json',{key:'manifest',publication:{id:'new'}});
 const reader=createSnapshotReader(bucket),view=await reader.view();reads.length=0;
 const allowed=specialists.slice(60).map(s=>s.id),task={kind:'classify',labelSpace:'supplied',needsVision:true,weights:{vision:3},selection:{allowedRepositories:allowed}};
 const loaded=await view.loadSpecialists(task);assert.deepEqual(loaded.specialists,specialists.slice(60));assert.equal(loaded.profiles.length,20);assert.equal(reads.length,3);
 reads.length=0;assert.deepEqual(await view.loadSpecialists(task),loaded);assert.equal(reads.length,0);
 const manifest=JSON.parse(objects.get('manifest'));delete manifest.specialistPacks;manifest.shards=Object.fromEntries(specialists.map(s=>[`specialists/${shardFor(s.id)}`,'old-records']));await putJSON(bucket,'manifest',manifest);await putJSON(bucket,'old-records',specialists);
 const sidecar={publicationId:'new',profileKeys:manifest.profileKeys,packs};await putJSON(bucket,'serving-specialists/new.json',sidecar);
 assert.deepEqual(await (await createSnapshotReader(bucket).view()).loadSpecialists(task),loaded);
 await putJSON(bucket,'serving-specialists/new.json',{...sidecar,publicationId:'wrong',packs:Object.fromEntries(profiles.map(p=>[p.id,'poison']))});await putJSON(bucket,'poison',specialists.map(s=>({...s,metadata:{wrong:true}})));
 assert.deepEqual(await (await createSnapshotReader(bucket).view()).loadSpecialists(task),loaded);

});
test('compact metadata keeps complete canonical names and arbitrary future string fields',()=>{
 const names=['Exact model','Exact model v2'];const v=compactVocabulary({identity:names,family:['line','line-mini'],creator:['Lab'],contextTokens:[1,200000],releasedAt:['2026-10-01'],future:['value'],empty:[]});
 assert.deepEqual(v,{identity:names,family:['line','line-mini'],creator:['Lab'],future:['value']});
});
test('timing failures retain bounded stage, status and provider code without error text',async()=>{
 let time=0;const trace=createTimings(()=>time),error=Object.assign(Error('PRIVATE_SECRET'),{code:'credit_balance_exhausted',providerStatus:429});
 await assert.rejects(trace.measure('constraints',async()=>{time=12;throw error;}));
 const diagnostics=trace.snapshot(error),decoded=JSON.parse(JSON.stringify(searchRecord({diagnostics})));
 assert.deepEqual(decoded.context.runtime.failure,{stage:'constraints',type:'error',code:'credit_balance_exhausted',providerStatus:429});assert.equal(decoded.context.runtime.timings.constraints,12);assert.doesNotMatch(JSON.stringify(decoded),/PRIVATE_SECRET/);
});
