import test from 'node:test';
import assert from 'node:assert/strict';
import {d1} from './helpers-d1.ts';
import {stageProjection} from '../projection.mjs';

test('agent model publication preserves observations, endpoint timing and immutable generations across retries',async()=>{
  const db=d1(),snapshot={catalogue:[{id:'one',name:'First',endpoints:[{id:'direct'}],facts:[]}],models:[{id:'one',speed:{tokensPerSecond:7},evidence:[{benchmark:'b',score:.8,url:'https://example.com'}]}]};
  await stageProjection(db,'first',snapshot);await stageProjection(db,'first',snapshot);
  await stageProjection(db,'second',{catalogue:[{id:'two',name:'Second'}],models:[]});
  const first=JSON.parse(db.all('SELECT payload FROM scout_models WHERE version=? AND id=?','first','one')[0].payload);
  assert.equal(first.name,'First');assert.equal(first.speed.tokensPerSecond,7);assert.deepEqual(first.endpoints,[{id:'direct'}]);assert.deepEqual(first.evidence,snapshot.models[0].evidence);
  assert.equal(db.all('SELECT count(*) AS n FROM scout_models WHERE version=?','second')[0].n,1);
});
