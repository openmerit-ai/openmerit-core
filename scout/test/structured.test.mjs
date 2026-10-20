import test from'node:test';import assert from'node:assert/strict';import{structured}from'../structured.mjs';
const schema={type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false};
const options=output=>({apiKey:'fixture',fetcher:async()=>Response.json({status:'completed',output:output.map(text=>({type:'message',content:[{type:'output_text',text}]}))})});
test('additional prose output cannot replace a complete schema object',async()=>{assert.deepEqual((await structured('input',schema,options(['Examining the input.','{"value":4}']))).value,{value:4});});
test('conflicting, truncated, refused and unavailable interpretations fail closed',async()=>{
 await assert.rejects(structured('input',schema,options(['{"value":4}','{"value":5}'])),/conflicting/);
 await assert.rejects(structured('input',schema,options(['{"value":'])),/Invalid/);
 await assert.rejects(structured('input',schema,options(['{"value":"wrong type"}'])),/Invalid/);
 await assert.rejects(structured('input',schema,{apiKey:'fixture',fetcher:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]})}),/refused/);
 await assert.rejects(structured('input',schema,{apiKey:'fixture',fetcher:async()=>Response.json({error:{}},{status:429})}),/429/);
});
