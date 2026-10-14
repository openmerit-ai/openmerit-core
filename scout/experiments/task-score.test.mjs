import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, failedScore } from './task-score.mjs';
const schema = {type:'object',properties:{answer:{type:'number'}},required:['answer'],additionalProperties:false};
const c = {kind:'json', schema, truth:{answer:3}};
const message = value => ({content:JSON.stringify(value)});
test('exact typed schema and per-task denominator are enforced', () => {
 assert.equal(grade(message({answer:3}),c).correct,1);
 for (const v of [{answer:'3'},{answer:3,extra:true},{},null,[]]) assert.equal(grade(message(v),c).correct,0);
 assert.equal(grade({content:'```json\n{"answer":3}\n```'},c).validJson,false);
 assert.equal(failedScore(c).total,1);
});
test('tool dispatch requires exact arguments and a missing-ID clarification', () => {
 const t={kind:'tools',expected:{name:'read',arguments:{id:'0003'}}};
 assert.equal(grade({tool_calls:[{function:{name:'read',arguments:'{"id":"0003"}'}}]},t).correct,1);
 assert.equal(grade({tool_calls:[{function:{name:'read',arguments:'{"id":3}'}}]},t).correct,0);
 assert.equal(grade({content:''},{kind:'tools',expected:null}).correct,0);
 assert.equal(grade({content:'Please provide your order ID.'},{kind:'tools',expected:null,clarification:true}).correct,1);
});
test('SQL is graded on executed rows; writes, attachments and file functions are rejected', () => {
 const t={kind:'sql',schema:{...schema,properties:{sql:{type:'string'}},required:['sql']},database:{tables:[{create:'CREATE TABLE a(n INTEGER)',insert:'INSERT INTO a VALUES(?)',rows:[[1],[2],[null]]}],expected:[[3]]}};
 assert.equal(grade(message({sql:'SELECT sum(n) FROM a'}),t).correct,1);
 assert.equal(grade(message({sql:'SELECT count(*) FROM a'}),t).correct,1);
 for(const sql of ['SELECT count(n) FROM a','DELETE FROM a RETURNING n','ATTACH DATABASE "/tmp/test.db" AS x',"SELECT load_extension('/tmp/a')",'DROP TABLE a']) assert.equal(grade(message({sql}),t).correct,0);
});
