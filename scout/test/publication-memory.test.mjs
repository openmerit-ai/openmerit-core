import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationDigest,publicationPredecessor,validatePublication,toRecords} from '../records.mjs';
import snapshot from '../snapshot.json' with {type:'json'};
test('catalogue content addressing is canonical and covers every archived record',async()=>{
 const records={metadata:{b:2,a:1},models:[{id:'a',payload:{z:3,y:2}},{id:'b'}]};
 const hash=await publicationDigest(records);
 assert.equal(hash,await publicationDigest({models:[{payload:{y:2,z:3},id:'a'},{id:'b'}],metadata:{a:1,b:2}}));
 assert.notEqual(hash,await publicationDigest({...records,models:[...records.models,{id:'c'}]}));
 assert.notEqual(hash,await publicationDigest({...records,metadata:{a:1,b:3}}));
 assert.notEqual(hash,await publicationDigest({...records,models:[...records.models].reverse()}));
});
test('compact predecessors preserve publication retention checks without retaining the prior archive',async()=>{
 const records=toRecords(snapshot),prior={...records,research:[{text:'x'.repeat(100000)}],publication:{id:'old'}};
 const compact=publicationPredecessor(prior);assert.equal(compact.publication.id,'old');assert.ok(JSON.stringify(compact).length<100000);
 const current=await validatePublication(records,compact);assert.equal(current.models,records.models.length);
 const ready=records.benchmarks.find(b=>b.interpretation?.status==='ready');
 await assert.rejects(validatePublication({...records,benchmarks:records.benchmarks.filter(b=>b.id!==ready.id),observations:records.observations.filter(o=>o.benchmark!==ready.id)},compact),/discard previously validated/);
});
test('stored research keeps one copy of each record and cached inspections still re-integrate without provider calls',async()=>{
 const {toSnapshot}=await import('../records.mjs'),{integrateResearch}=await import('../enrich.mjs'),{digest}=await import('../utils.mjs');
 const record={id:'research:x',kind:'benchmark',name:'Fixture bench',url:'https://example.com/b',contentHash:'c1',subjectId:'none',subjectHash:'h',capabilities:[],citations:[{url:'https://example.com/b',excerpt:'x'.repeat(5000)}]};
 const inspectionHash=await digest(['22','c1','none',null]);
 const stored={...record,inspectionHash,verifiedAt:'2026-10-20T00:00:00Z',inspection:{record,identity:null,familyVerified:true,facts:[],observations:[],endpoints:[],verifiedAt:'2026-10-20T00:00:00Z',inspectionHash}};
 const records=toRecords({...snapshot,research:[stored]});
 assert.equal(records.research[0].inspection.record,undefined);
 assert.ok(JSON.stringify(records.research).length<JSON.stringify([stored]).length*.6);
 let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected provider call');};
 const next=await integrateResearch(toSnapshot(records),[{subjectId:'none',subjectHash:'h',records:[record]}],{fetcher,apiKey:'fixture'});
 assert.equal(calls,0);assert.equal(next.research.length,1);assert.equal(toRecords(next).research[0].inspection.record,undefined);
});
test('published research lives beside the records so collection never parses it, and older generations still load',async()=>{
 const {stageCatalogue,putJSON,readPublished,researchKey}=await import('../store.mjs');
 const bucket={data:new Map(),reads:[],async put(k,v){this.data.set(k,String(v));},async get(k){this.reads.push(k);const v=this.data.get(k);return v===undefined?null:{json:async()=>JSON.parse(v)};},async head(k){return this.data.has(k)?{}:null;}};
 const research=[{id:'research:x',kind:'benchmark',name:'Fixture',citations:[{url:'https://example.com',excerpts:['x'.repeat(5000)]}]}];
 const staged=await stageCatalogue(bucket,toRecords({...snapshot,research}));await putJSON(bucket,'active.json',staged);
 const manifest=JSON.parse(bucket.data.get(staged.key));
 assert.equal(JSON.parse(bucket.data.get(manifest.recordsKey)).research,undefined);
 assert.deepEqual(JSON.parse(bucket.data.get(researchKey(manifest.recordsKey))),toRecords({...snapshot,research}).research);
 const collected=await readPublished(bucket);assert.equal(collected.research,null);assert.equal(collected.records.research,undefined);assert.equal(collected.records.models.length,toRecords(snapshot).models.length);
 bucket.reads=[];const planned=await readPublished(bucket,{records:false,research:true});
 assert.deepEqual(planned.research.map(r=>r.id),['research:x']);assert.ok(!bucket.reads.includes(manifest.recordsKey),'research-only reads must not parse the records file');
 // A generation published before the split embeds research in the records file.
 bucket.data.delete(researchKey(manifest.recordsKey));bucket.data.set(manifest.recordsKey,JSON.stringify({...JSON.parse(bucket.data.get(manifest.recordsKey)),research}));
 const legacy=await readPublished(bucket,{research:true});assert.deepEqual(legacy.research.map(r=>r.id),['research:x']);assert.equal(legacy.records.research,undefined);
 assert.equal(await readPublished({get:async()=>null}),null);
});
