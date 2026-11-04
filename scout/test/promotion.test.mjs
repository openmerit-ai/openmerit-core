import test from 'node:test';
import assert from 'node:assert/strict';
import {indexStatus} from '../rank.mjs';

test('cached catalogue status omits retired calibration without losing coverage',()=>{
  const index={snapshot:{sources:[]},cachedStatus:{models:321,calibration:{profiles:[{id:'old'}]}}};
  assert.deepEqual(indexStatus(index),{models:321,stale:false,degraded:false});
});
