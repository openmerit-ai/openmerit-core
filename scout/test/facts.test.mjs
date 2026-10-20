import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileFacts} from '../facts.mjs';
const model={id:'model',name:'Model'};
const existing={field:'family',value:'line-subtype',url:'https://example.com/catalogue'};
const proposed={field:'family',value:'line',url:'https://example.com/original'};
const decide=(value,confidence=.99)=>async(_u,o)=>Response.json({answers:JSON.parse(o.body).questions.map(q=>({name:q.name,type:'choice',choice:value,confidence}))});
test('compatible parent and child claims retain a canonical value instead of becoming null',async()=>{
 const r=await reconcileFacts(model,[existing],[proposed],{apiKey:'fixture',fetcher:decide('existing')});
 assert.equal(r[0].value,'line-subtype');assert.equal(r[0].supportingClaims.length,2);
});
test('genuinely conflicting or uncertain claims remain unknown with both source claims',async()=>{
 for(const [choice,confidence]of [['unknown',.99],['proposed',.3]]) {
  const a={...existing,field:'releasedAt',value:'2026-09-01'},b={...proposed,field:'releasedAt',value:'2026-09-02'};
  const r=await reconcileFacts(model,[a],[b],{apiKey:'fixture',fetcher:decide(choice,confidence)});assert.equal(r[0].value,null);assert.equal(r[0].conflictingClaims.length,2);assert.equal(a.value,'2026-09-01');
 }
});
test('identical claims need no call and compatibility decisions reuse their source-keyed cache',async()=>{
 const same=await reconcileFacts(model,[existing],[{...existing}],{fetcher:()=>assert.fail('Identical values need no comparison')});assert.equal(same[0].value,existing.value);
 const data=new Map(),cache={get:async key=>data.get(key),put:async(key,value)=>data.set(key,value)};
 await reconcileFacts(model,[existing],[proposed],{apiKey:'fixture',cache,fetcher:decide('existing')});
 const r=await reconcileFacts(model,[existing],[proposed],{apiKey:'fixture',cache,fetcher:()=>assert.fail('Validated relationship must reuse its cache')});assert.equal(r[0].value,existing.value);
});
test('provider failures abort reconciliation rather than erase a previously verified value',async()=>{
 await assert.rejects(reconcileFacts(model,[existing],[proposed],{apiKey:'fixture',fetcher:async()=>new Response('{}',{status:401})}),/HTTP 401/);assert.equal(existing.value,'line-subtype');
});
