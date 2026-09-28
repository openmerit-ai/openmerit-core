import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Playback, recordedView } from '../../site/demo/playback.mjs';
const recording = JSON.parse(await readFile(new URL('../../site/demo/recording.json',import.meta.url),'utf8'));

test('playback starts automatically, pauses exactly, resumes, and stops at the end',()=>{
  const player=new Playback(recording);
  assert.equal(player.playing,true);
  player.advance(5);assert.equal(player.elapsed,5);
  player.toggle();player.advance(90);assert.equal(player.elapsed,5);
  player.toggle();player.advance(2);assert.equal(player.elapsed,7);
  player.advance(100);assert.equal(player.elapsed,36);assert.equal(player.playing,false);
  player.toggle();assert.equal(player.elapsed,0);assert.equal(player.playing,true);
});

test('GPU placement replays its own recent-model route and rewinds to the Qwen baseline',async()=>{
  const data=JSON.parse(await readFile(new URL('../../site/demo/recording-placement.json',import.meta.url),'utf8'));
  const {tasks,qualifies,goalSummary}=await import('../../site/demo/tasks.mjs');
  const player=new Playback(data);player.seek(36);
  let view=recordedView(data,player.frameIndex);
  assert.equal(view.before.model,'qwen/qwen3.6-plus');assert.equal(view.after.model,'placement/recent-v1');
  assert.deepEqual(view.before.steps.map(s=>s.model),Array(3).fill('qwen/qwen3.6-plus'));
  assert.deepEqual(view.after.steps.map(s=>s.model),['google/gemma-4-26b-a4b-it','xiaomi/mimo-v2.5','deepseek/deepseek-v4.1-flash']);
  assert.ok(qualifies(view.after,tasks.placement));assert.equal(data.verification.matches,6);
  assert.deepEqual(view.output.afterTrace.map(s=>s.model),view.after.steps.map(s=>s.model));
  assert.match(goalSummary(tasks.placement,view.output.after),/placed|blocked/);
  assert.equal(data.modelReleases.length,4);
  for(const model of data.modelReleases) assert.ok(model.releasedAt>=data.releaseWindow.from && model.releasedAt<=data.releaseWindow.through);
  player.seek(20);view=recordedView(data,player.frameIndex);
  assert.equal(view.changed,false);assert.equal(view.after.model,'qwen/qwen3.6-plus');assert.equal(view.output,null);
  player.reset();view=recordedView(data,player.frameIndex);assert.equal(view.after,undefined);assert.equal(view.verified,false);
});
test('reset and backward seeking cannot retain future measurements or an approved swap',()=>{
  const player=new Playback(recording);player.advance(36);
  let view=recordedView(recording,player.frameIndex);assert.equal(view.verified,true);assert.ok(view.output);
  player.seek(20);view=recordedView(recording,player.frameIndex);
  assert.equal(view.phase,'proposal');assert.equal(view.changed,false);assert.equal(view.after.model,'openai/gpt-4.1-mini');assert.equal(view.output,null);
  player.reset();view=recordedView(recording,player.frameIndex);
  assert.equal(player.playing,false);assert.deepEqual(view.batches,{});assert.equal(view.before,undefined);assert.equal(view.changed,false);
  player.reset(true);assert.equal(player.playing,true);
});
test('field kit replays two six-model routes and rewinds every assignment together',async()=>{
  const data=JSON.parse(await readFile(new URL('../../site/demo/recording-fieldkit.json',import.meta.url),'utf8'));
  const {tasks,qualifies,goalSummary}=await import('../../site/demo/tasks.mjs');
  const {kitRoutes}=await import('../runtime/fieldkit-models.mjs');
  const player=new Playback(data);player.seek(36);
  let view=recordedView(data,player.frameIndex);
  for(const [side,route] of [['before',kitRoutes[0]],['after',kitRoutes[1]]]) {
    assert.equal(view[side].model,route.id);
    assert.deepEqual(view[side].steps.map(s=>s.model),route.steps.map(s=>s.model));
    assert.equal(new Set(view[side].steps.map(s=>s.model)).size,6);
    assert.deepEqual(view.output[`${side}Trace`].map(s=>s.model),route.steps.map(s=>s.model));
    assert.equal(view[side].samples,4);
  }
  assert.ok(qualifies(view.after,tasks.fieldkit));
  assert.ok(view.after.costPerInput<view.before.costPerInput);
  assert.equal(data.verification.matches,4);assert.equal(data.verification.samples,4);
  assert.equal(data.sourceEnvironment,'local');assert.equal(data.modelReleases.length,11);
  assert.match(data.sourceSha256,/^[a-f0-9]{64}$/);
  assert.match(goalSummary(tasks.fieldkit,view.output.after),/ready|blocked/);
  player.seek(20);view=recordedView(data,player.frameIndex);
  assert.equal(view.changed,false);assert.equal(view.output,null);
  assert.deepEqual(view.after.steps,view.before.steps);
  player.reset();view=recordedView(data,player.frameIndex);
  assert.equal(view.after,undefined);assert.equal(view.verified,false);
});
test('the recording preserves measured quality and excludes the rejected candidate',()=>{
  assert.equal(recording.frames[0].at,0);assert.equal(recording.frames.at(-1).at,recording.duration);
  assert.ok(recording.frames.every((f,i)=>i===0 || f.at>recording.frames[i-1].at));
  assert.equal(recording.measurements.baseline.matches,24);
  assert.equal(recording.measurements['trial-1'].matches,17);
  assert.equal(recording.measurements['trial-2'].matches,24);
  const final=recordedView(recording,recording.frames.length-1);
  assert.equal(final.after.model,'google/gemini-2.5-flash-lite');assert.equal(recording.verification.matches,6);
  assert.match(recording.sourceSha256,/^[a-f0-9]{64}$/);
});

test('each task replays its own approved model without leaking the other task’s output',async()=>{
  const {tasks,recordedStory,unitCost}=await import('../../site/demo/tasks.mjs');
  const spam=JSON.parse(await readFile(new URL('../../site/demo/recording-spam.json',import.meta.url),'utf8'));
  const backfill=JSON.parse(await readFile(new URL('../../site/demo/recording-backfill.json',import.meta.url),'utf8'));
  for(const [id,data,winner] of [['support',recording,'google/gemini-2.5-flash-lite'],['spam',spam,'typesafe/jev-1.13'],['backfill',backfill,'backfill/mixed-v1']]) {
    const player=new Playback(data);player.seek(36);
    let view=recordedView(data,player.frameIndex);
    assert.equal(view.before.model,'openai/gpt-4.1-mini');assert.equal(view.after.model,winner);
    assert.ok(unitCost(view.after)<unitCost(view.before));assert.equal(view.verified,true);
    assert.equal(view.output,data.example);
    const story=recordedStory(data,view,tasks[id]).join(' ');
    if(id==='spam') {assert.equal(view.before.matches,22);assert.equal(view.after.matches,24);assert.doesNotMatch(story,/Same/);}
    player.seek(20);view=recordedView(data,player.frameIndex);
    assert.equal(view.changed,false);assert.equal(view.after.model,'openai/gpt-4.1-mini');assert.equal(view.output,null);
    assert.match(recordedStory(data,view,tasks[id])[1],id==='spam'?/Jev/:id==='backfill'?/measured route/:/Gemini/);
    player.reset(true);view=recordedView(data,player.frameIndex);
    assert.equal(view.after,undefined);assert.equal(view.verified,false);assert.equal(view.output,null);
    assert.deepEqual(recordedStory(data,view,tasks[id]),[tasks[id].heading,tasks[id].intro]);
  }
  assert.deepEqual(spam.example.expected,{decision:'publish'});
  assert.deepEqual(spam.example.before,{decision:'hold'});assert.deepEqual(spam.example.after,{decision:'publish'});
  assert.match(spam.sourceSha256,/^[a-f0-9]{64}$/);
  assert.equal(backfill.sourceEnvironment,'local');assert.equal(backfill.example.afterTrace.length,3);
  assert.equal(backfill.measurements.baseline.samples,8);assert.deepEqual(backfill.example.before.replay,[2,3,4]);assert.deepEqual(backfill.example.after.replay,[3,4]);
  assert.deepEqual(backfill.measurements.baseline.steps.map(s=>s.model),Array(3).fill('openai/gpt-4.1-mini'));
  assert.deepEqual(backfill.measurements['trial-1'].steps.map(s=>s.model),['openai/gpt-4.1-nano','openai/gpt-4.1-mini','google/gemini-2.5-flash-lite']);
  assert.deepEqual(backfill.example.afterTrace.map(s=>s.model),backfill.measurements['trial-1'].steps.map(s=>s.model));
});
