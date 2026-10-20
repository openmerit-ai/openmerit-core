import test from 'node:test';import assert from 'node:assert/strict';
import {LocalD1}from'./helpers-projection.mjs';
import {fieldDefinitions,selectProfiles,validateConstraints}from'../constraints.mjs';
import {stageProjection,queryProjection,selectionQuery,loadProjectionModels}from'../projection.mjs';
const profiles=[['one','A',500000,'2026-10-01'],['two','B',200000,'2026-09-01'],['three','A',100000,'2025-01-01'],['four',null,null,null]].map(([id,creator,contextTokens,releasedAt])=>({modelId:id,endpointId:`route:${id}`,source:'models',facts:{creator,contextTokens,releasedAt,parameters:id==='one'?['tools','json']:[],other:{inputPrice:1}}}));
const directory={profiles},snapshot={catalogue:profiles.map(p=>({id:p.modelId,name:p.modelId,endpoints:[],facts:[]})),models:[{id:'one',evidence:[{benchmark:'b',score:.8,metric:'accuracy',url:'https://example.com'}]}]};
const c=(field,op,...values)=>({field,op,values}),groups=(...all)=>[{all}];
test('SQL and local selection agree for alternatives, strict bounds, exclusions, arrays, dates and unknowns',async()=>{
 const db=new LocalD1();await stageProjection(db,'first',snapshot,directory);const defs=fieldDefinitions(directory);
 const cases=[[],groups(c('creator','eq','A')),groups(c('creator','ne','A')),groups(c('contextTokens','ne','500000')),groups(c('contextTokens','gt',200000)),groups(c('contextTokens','gte',200000)),groups(c('contextTokens','lt',500000)),groups(c('releasedAt','gt','2026-09-01')),groups(c('parameters','in','tools')),groups(c('parameters','not_in','tools')),groups(c('creator','in','A','B'),c('contextTokens','gte',500000)),[{all:[c('creator','eq','A'),c('contextTokens','gte',500000)]},{all:[c('creator','eq','B'),c('contextTokens','gte',200000)]}]];
 for(const g of cases){const actual=await queryProjection(db,'first',g,defs,{});assert.deepEqual(actual.map(p=>p.modelId).sort(),selectProfiles(directory,g).map(p=>p.modelId).sort(),JSON.stringify(g));}
});
test('inventories intersect before retrieval and empty inventories stay empty',async()=>{
 const db=new LocalD1();await stageProjection(db,'first',snapshot,directory);const defs=fieldDefinitions(directory),g=groups(c('creator','eq','A'));
 assert.equal((await queryProjection(db,'first',g,defs,{modelIds:['two']})).length,0);
 assert.equal((await queryProjection(db,'first',[],defs,{modelIds:[]})).length,0);
 assert.deepEqual((await queryProjection(db,'first',g,defs,{modelIds:['one','three'],endpointIds:['route:three']})).map(r=>r.modelId),['three']);
});
test('publication readiness, version isolation, retries and source evidence survive projection',async()=>{
 const db=new LocalD1();await stageProjection(db,'first',snapshot,directory);await stageProjection(db,'first',snapshot,directory);
 await stageProjection(db,'second',snapshot,{profiles:profiles.slice(0,1)});
 assert.equal((await queryProjection(db,'first',[],fieldDefinitions(directory),{})).length,4);
 assert.equal((await queryProjection(db,'second',[],fieldDefinitions(directory),{})).length,1);
 await assert.rejects(queryProjection(db,'absent',[],fieldDefinitions(directory),{}),/unavailable/);
 const rows=await loadProjectionModels(db,'first',['one'],['b']);assert.deepEqual(rows[0].evidence,snapshot.models[0].evidence);
 assert.deepEqual((await loadProjectionModels(db,'first',['one'],['other']))[0].evidence,[]);
});
test('unsupported expressions fail closed and literals remain bound parameters',()=>{
 const defs=fieldDefinitions(directory);assert.throws(()=>validateConstraints(groups(c('creator','execute','A')),defs));assert.throws(()=>validateConstraints(groups(c('missing','eq','A')),defs));assert.throws(()=>validateConstraints(groups(c('releasedAt','gt','last month')),defs));
 const q=selectionQuery('version',groups(c('creator','eq',"x'); DROP TABLE scout_models; --")),defs,{});assert.ok(!q.sql.includes('DROP TABLE'));assert.ok(q.bindings.includes("x'); DROP TABLE scout_models; --"));
});
