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
test('retained research keeps one copy of each record',async()=>{
 const {digest}=await import('../utils.mjs');
 const record={id:'research:x',kind:'benchmark',name:'Fixture bench',url:'https://example.com/b',contentHash:'c1',subjectId:'none',subjectHash:'h',capabilities:[],citations:[{url:'https://example.com/b',excerpt:'x'.repeat(5000)}]};
 const inspectionHash=await digest(['22','c1','none',null]);
 const stored={...record,inspectionHash,verifiedAt:'2026-10-20T00:00:00Z',inspection:{record,identity:null,familyVerified:true,facts:[],observations:[],endpoints:[],verifiedAt:'2026-10-20T00:00:00Z',inspectionHash}};
 const records=toRecords({...snapshot,research:[stored]});
 assert.equal(records.research[0].inspection.record,undefined);
 assert.ok(JSON.stringify(records.research).length<JSON.stringify([stored]).length*.6);
});
test('a published generation moves research and capability answers into the D1 ledger once, then loads without them',async()=>{
 const {stageCatalogue,putJSON,readPublished}=await import('../store.mjs'),{migratePublished}=await import('../pipeline.mjs');
 const {evidenceLedger}=await import('../evidence-db.ts'),{LocalD1}=await import('./helpers-projection.mjs');
 const bucket={data:new Map(),async put(k,v){this.data.set(k,(typeof v==='string'?v:new TextDecoder().decode(v)));},async get(k){const v=this.data.get(k);return v===undefined?null:{json:async()=>JSON.parse(v)};},async head(k){return this.data.has(k)?{}:null;}};
 const research=[{id:'research:x',kind:'provider',name:'Fixture',url:'https://example.com',contentHash:'p',citations:[{url:'https://example.com',excerpts:['x'.repeat(5000)]}]}];
 const staged=await stageCatalogue(bucket,toRecords({...snapshot,research}));await putJSON(bucket,'active.json',staged);
 const recordsKey=JSON.parse(bucket.data.get(staged.key)).recordsKey;
 // Generations from before the ledger embed research and capability answers in the records file.
 const legacy=JSON.parse(bucket.data.get(recordsKey)),embedded=legacy.benchmarks.filter(b=>b.interpretation?.status==='ready'&&b.interpretation.capabilities);
 const answers={coding:{choice:'supported',confidence:.9,definitionHash:'d1'},vision:{choice:'absent',confidence:.8,definitionHash:'d2'}};
 embedded[0].interpretation.capabilities={...answers,stale:{choice:'absent',confidence:1}};
 bucket.data.set(recordsKey,JSON.stringify({...legacy,research}));
 const db=new LocalD1();
 assert.deepEqual(await migratePublished(bucket,db),{research:1,interpretations:embedded.length});
 const records=JSON.parse(bucket.data.get(recordsKey));
 assert.equal(records.research,undefined);assert.ok(records.benchmarks.every(b=>!b.interpretation?.capabilities));
 assert.equal(records.benchmarks.filter(b=>b.interpretation?.status==='ready').length,snapshot.benchmarks.filter(b=>b.interpretation?.status==='ready').length);
 const {research:ledger,interpretations}=await evidenceLedger(db),[b]=embedded;
 assert.deepEqual((await ledger.providers()).map(r=>r.id),['research:x']);
 // Answers without a definition hash could never be reused, so they are not kept.
 assert.deepEqual(await interpretations.get(b.id,b.interpretation.sourceHash),answers);
 assert.deepEqual(await migratePublished(bucket,db),{skipped:true});
 assert.equal((await readPublished(bucket)).records.models.length,toRecords(snapshot).models.length);
 assert.equal(await readPublished({get:async()=>null}),null);
});
test('stored JSON is pure ASCII and parses to exactly what JSON.stringify would store',async()=>{
 const {encodeJSON}=await import('../store.mjs');
 const tricky={skipped:undefined,'clé ✓':['é','😀',' ','\ud800',undefined,()=>1,NaN,{a:undefined,b:[[[[undefined,'ü']]]]}],at:new Date(0),empty:{},none:[],nested:{x:{y:{z:{w:{v:'深い',u:undefined}}}}},fn:()=>1,n:-0.5,t:true,nil:null};
 for(const value of [tricky,[undefined,tricky],snapshot,'naïve',7,null]) {
  const bytes=encodeJSON(value);
  assert.ok(bytes.every(b=>b<0x80),'stored JSON must be ASCII');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)),JSON.parse(JSON.stringify(value)));
 }
});
