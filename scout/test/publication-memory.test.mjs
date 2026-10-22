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
