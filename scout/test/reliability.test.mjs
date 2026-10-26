import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with {type:'json'};
import {registry} from '../registry.mjs';
import {createIndex,indexStatus,recommend} from '../rank.mjs';
import {requestDecisions,classifyPrompt,questionsFor} from '../decisions.mjs';
import {choice} from '../utils.mjs';
const q=[choice('ok','Fixture',{yes:'Yes',no:'No'})],body={answers:[{name:'ok',type:'choice',choice:'yes',confidence:.9}]};
const settings={apiKey:'fixture',timeoutMs:200,retryBaseMs:0};
const stall=signal=>new Promise((_resolve,reject)=>{
  const guard=setTimeout(()=>reject(Error('Abort deadline did not fire')),1000);
  signal.addEventListener('abort',()=>{clearTimeout(guard);reject(signal.reason);},{once:true});
});

test('transient HTTP and network failures recover within one bounded retry',async()=>{
  for(const fail of [()=>Response.json({error:{code:'server_error'}},{status:503}),()=>Response.json({error:{code:'rate_limit_exceeded'}},{status:429}),()=>{throw new TypeError('Connection reset');}]){
    let calls=0;const result=await requestDecisions('Fixture',q,{...settings,fetcher:async()=>++calls===1?fail():Response.json(body)});
    assert.deepEqual(result,body);assert.equal(calls,2);
  }
});
test('permanent errors, exhausted credit and Retry-After beyond the deadline are never retried early',async()=>{
  for(const [status,code,headers]of [[401,'invalid_api_key',{}],[429,'credit_balance_exhausted',{}],[429,'insufficient_quota',{}],[429,'rate_limit_exceeded',{'retry-after':'10'}],[503,'server_error',{'x-should-retry':'false'}]]){
    let calls=0;await assert.rejects(requestDecisions('Fixture',q,{...settings,fetcher:async()=>{calls++;return Response.json({error:{code}},{status,headers});}}),new RegExp(`HTTP ${status}`));assert.equal(calls,1);
  }
});
test('Retry-After is honored and an attempt timeout leaves room for recovery',async()=>{
  let calls=0,first=0;
  await requestDecisions('Fixture',q,{...settings,fetcher:async()=>{calls++;if(calls===1){first=performance.now();return Response.json({}, {status:429,headers:{'retry-after':'0.02'}});}assert.ok(performance.now()-first>=19);return Response.json(body);}});
  calls=0;
  const result=await requestDecisions('Fixture',q,{...settings,attemptTimeoutMs:15,fetcher:async(_u,{signal})=>{
    if(++calls>1)return Response.json(body);
    return stall(signal);
  }});
  assert.deepEqual(result,body);assert.equal(calls,2);
});
test('repeated failures stop after two attempts and malformed success stays invalid',async()=>{
  let calls=0;await assert.rejects(requestDecisions('Fixture',q,{...settings,fetcher:async()=>{calls++;return Response.json({}, {status:503});}}),/HTTP 503/);assert.equal(calls,2);
  await assert.rejects(classifyPrompt('Fixture',{...settings,fetcher:async()=>Response.json({answers:[]})}),/Incomplete/);
});
test('slow optional verification returns conservative answers before its own deadline',async()=>{
  const questions=questionsFor(),answers=questions.map(q=>({name:q.name,type:'choice',choice:q.choices[0].value,confidence:.99}));
  answers.find(a=>a.name==='json').confidence=.1;
  let calls=0;const start=performance.now();
  const result=await classifyPrompt('Fixture',{...settings,verificationTimeoutMs:20,fetcher:async(_u,{signal,body})=>{
    const qs=JSON.parse(body).questions;calls++;
    if(!qs[0].name.startsWith('verify_'))return Response.json({answers:answers.filter(a=>qs.some(q=>q.name===a.name))});
    return stall(signal);
  }});
  assert.equal(calls,2);assert.equal(result.task.needsStructured,false);assert.ok(result.task.uncertainty.includes('json'));assert.ok(performance.now()-start<500);
});
test('freshness follows source policy, including unknown dates and genuine feed failures',()=>{
  const now=Date.now(),hours=ago=>new Date(now-ago*3600_000).toISOString();
  const sources=[{id:'feed',status:'ok',checkedAt:hours(.5)},{id:'arbitrary-research-publisher',status:'ok',checkedAt:hours(24),maxAgeHours:168},{id:'contract',status:'ok',checkedAt:null,refreshPolicy:'manual-contract-review'},{id:'research:retained',status:'ok',checkedAt:hours(24*30),refreshPolicy:'retained'}];
  const current=()=>createIndex({...snapshot,registry,sources});
  assert.equal(indexStatus(current(),now).stale,false);
  sources[1].checkedAt=hours(169);assert.equal(indexStatus(current(),now).stale,true);
  sources[1].checkedAt=hours(24);sources[0].checkedAt=hours(14);sources[0].status='failed';
  assert.equal(indexStatus(current(),now).stale,true);assert.equal(indexStatus(current(),now).degraded,true);
  sources[0].checkedAt='invalid';assert.equal(indexStatus(current(),now).stale,true);
});
