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
