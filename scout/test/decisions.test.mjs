import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with {type:'json'};
import {decisionQuestions,interpretDecisions,classifyPrompt} from '../decisions.mjs';
import {createIndex,recommend} from '../rank.mjs';
const answers=(choices={})=>decisionQuestions.map(q=>({type:'choice',name:q.name,choice:choices[q.name]??({tools:'no',memory:'none',json:'no',task_kind:'other',output:'supported',output_format:'none',output_specificity:'established'}[q.name]??q.choices[0].value),confidence:.95}));
test('incomplete, refused, duplicate, or invalid decisions cannot silently become a ranking',()=>{
 assert.throws(()=>interpretDecisions([]),/Incomplete/);
 for(const replacement of [{name:'documents',type:'refusal'},{name:'documents',type:'choice',choice:'invented',confidence:1},{name:'vision',type:'choice',choice:'required',confidence:1}]){const rows=answers();rows[0]=replacement;assert.throws(()=>interpretDecisions(rows),/Invalid/);}
});
test('ranking requires a typed task and selects evidence from that task',()=>{
 const index=createIndex(snapshot);assert.throws(()=>recommend(index,'Invoice JSON code'),/semantic task/);
 const task=interpretDecisions(answers({documents:'required',vision:'required',task_kind:'extract'}));
 const result=recommend(index,'Uninterpreted words do not control ranking',Date.parse(snapshot.checkedAt),task);
 assert.ok(result.recommendations.length);assert.ok(result.recommendations.every(m=>m.evidence.some(e=>e.capabilities.includes('documents'))||m.missingEvidence?.includes('documents')&&m.evidence.some(e=>e.capabilities.includes('vision'))));
});
test('interpretation bounds requests, reports failures without credentials, and preserves unknown memory',async()=>{
 await assert.rejects(classifyPrompt('Example'),/configured/);
 await assert.rejects(classifyPrompt('Example',{apiKey:'private',fetcher:async()=>new Response('private',{status:429})}),{message:'Decisions returned HTTP 429.'});
 const result=await classifyPrompt('Example',{apiKey:'private',fetcher:async(_u,o)=>{assert.ok(o.signal);const qs=JSON.parse(o.body).questions;return Response.json({answers:answers({memory:'unspecified'}).filter(a=>qs.some(q=>q.name===a.name))});}});
 assert.equal(result.task.requirements.memory,'unspecified');assert.equal(result.task.weights.memory,undefined);
});
