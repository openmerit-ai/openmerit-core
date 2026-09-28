import { Playback, recordedView } from './playback.mjs?v=4';
import { tasks, unitCost, recordedStory, goalSummary } from './tasks.mjs?v=10';

const $ = id => document.getElementById(id);
const clock = seconds => `00:${String(Math.floor(seconds)).padStart(2,'0')}`;
const phases = { setup:'01 / Baseline', baseline:'01 / Baseline', trials:'02 / Compare', proposal:'03 / Approval', approved:'03 / Approval', applied:'04 / Verify', verified:'04 / Verify', complete:'Recording complete' };
let recording, player, pending = false, lastFrame = -1;
const requestedTask = new URL(location.href).searchParams.get('task');
let task = Object.hasOwn(tasks,requestedTask) ? tasks[requestedTask] : tasks.support;
const recordings = new Map();
let lastSingleTask=task.layer==='agent'?'support':task.id;
let lastAgentTask=task.layer==='agent'?task.id:'backfill';
let lastTick = performance.now();
document.addEventListener('visibilitychange',()=>{lastTick=performance.now();});

function text(id, value) { if ($(id).textContent !== value) $(id).textContent=value; }

function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function name(id) { return Object.values(recording?.measurements ?? {}).find(model => model.model === id)?.name ?? Object.values(recording?.measurements ?? {}).flatMap(m=>m.steps ?? []).find(s=>s.model===id)?.name ?? id; }
function stepName(id) { return Object.values(recording?.measurements ?? {}).flatMap(m=>m.steps ?? []).find(s=>s.model===id)?.name ?? name(id); }
function incumbentModel() { return recording?.measurements?.baseline?.model ?? task.incumbent ?? 'openai/gpt-4.1-mini'; }
function metrics(side, batch, model) {
  $(`${side}-model`).textContent = batch?.name ?? name(model ?? incumbentModel());
  const agent=task.layer==='agent',id=batch?.model ?? model ?? incumbentModel();
  $(`${side}-model`).hidden=agent;$(`${side}-route`).hidden=!agent;
  if(agent) {
    const steps=batch?.steps ?? Object.values(recording?.measurements ?? {}).find(m=>m.model===id)?.steps ?? [];
    $(`${side}-route`).replaceChildren(...steps.map((step,index)=>{
      const row=document.createElement('li'),label=document.createElement('span'),value=document.createElement('strong');
      label.textContent=`0${index+1} ${step.task}`;value.textContent=step.name ?? name(step.model);if(step.capability) value.title=step.capability;row.append(label,value);return row;
    }));
  }
  $(`${side}-quality`).textContent = batch ? `${batch.matches}/${batch.samples}` : '—';
  $(`${side}-cost`).textContent = Number.isFinite(unitCost(batch)) ? `$${(unitCost(batch)*1000).toFixed(3)}` : '—';
  $(`${side}-latency`).textContent = Number.isFinite(batch?.latencyMs) ? `${(batch.latencyMs/1000).toFixed(2)}s` : '—';
}
function latencyOutcome(before, after) {
  $('after-latency').classList.toggle('improved', Number.isFinite(before?.latencyMs) && Number.isFinite(after?.latencyMs) && after.latencyMs < before.latencyMs);
}
function ticket(value) { return value ? Object.entries(value).map(([key, val]) => `${key.padEnd(10)} ${Array.isArray(val)?JSON.stringify(val):val ?? 'null'}`).join('\n') : 'No sample output yet.'; }
function outputs(example) {
  const format = value => value && Object.hasOwn(value,'output') ? value.output ? ticket(value.output) : value.raw || 'No structured output returned.' : ticket(value);
  $('before-output').textContent = example ? format(example.before) : 'No sample output yet.';
  $('after-output').textContent = example ? format(example.after) : 'No sample output yet.';
}
function goalTrace(lines, trace) {
  if(task.layer!=='agent' || !trace) return lines;
  return [...lines,...trace.map(step=>({tone:step.ok?'good':'warn',message:`Sample agent · ${step.task} · ${stepName(step.model)}: ${step.summary ?? (step.request ? step.request.tool+'('+step.request.job_id+')' : goalSummary(task,step.output))}`}))];
}
function log(lines) {
  $('log').replaceChildren(...lines.map(line => {
    const li = document.createElement('li'); li.className = line.tone ?? ''; li.textContent = line.message; return li;
  }));
}
async function loadRecording(id) {
  if(!Object.hasOwn(tasks,id)) throw new Error('Unknown demo task.');
  if(recordings.has(id)) return recordings.get(id);
  const response=await fetch(tasks[id].recording);
  if(!response.ok) throw new Error('The recording could not load. Reload the page to retry.');
  const data=await response.json();recordings.set(id,data);return data;
}
function taskCopy() {
  text('task-command',task.command);
  text('task-description',task.description);
  $('demo-guide').href=`/docs/demo-${task.id}/`;
  text('sample-label',`Sample ${task.inputNoun}`);
  const agent=task.layer==='agent';
  const policy=task.policy ?? '24 test '+task.inputPlural+' · ≥90% exact matches · ≤10s mean latency · lowest eligible cost.';
  text('policy-copy',policy);
  $('workflow-context').hidden=!agent;
  text('workflow-title',`${task.label} workflow`);text('workflow-requirements',task.constraints ?? '');
  text('workflow-limits',agent?`Mean: ≤${task.maximumLatency/1000}s · ≤$${task.maximumCost} per goal · read-only tools`:'');
  for(const side of ['before','after']) {$(`${side}-model`).hidden=agent;$(`${side}-route`).hidden=!agent;}
  for(const label of document.querySelectorAll('.quality dt')) label.textContent=agent?'goals completed':'fixture matches';
  text('task-note',task.note+(recording?.sourceNotes?' '+recording.sourceNotes:''));$('jev-docs').hidden=task.id!=='spam';
  const releases=recording?.modelReleases ?? [];
  $('model-releases').hidden=!releases.length;
  $('model-releases').replaceChildren(...releases.map(model=>{
    const line=document.createElement('div'),link=document.createElement('a');
    link.href=model.url;link.textContent=model.name;
    line.append(link,` · ${model.capability?model.capability+' · ':''}released ${model.releasedAt} · OpenRouter`);return line;
  }));
  for(const id of ['before-unit','after-unit']) text(id,`per 1,000 ${task.inputPlural}`);
}
function applyTask(id,data) {
  task=tasks[id];if(task.layer==='agent') lastAgentTask=id;else lastSingleTask=id;recording=data;player=new Playback(recording);lastFrame=-1;
  $('seek').max=recording.duration;lastTick=performance.now();$('run-details').open=false;taskCopy();
  const url=new URL(location.href);url.searchParams.set('task',task.id);history.replaceState(null,'',url);
}
function controls() {
  const agent=task.layer==='agent';
  $('experience').setAttribute('aria-labelledby',agent?'level-agent':'level-single');
  $('demo').setAttribute('role','tabpanel');
  $('demo').setAttribute('aria-labelledby',`tab-${task.id}`);
  $('task-tabs').hidden=agent;$('agent-tabs').hidden=!agent;
  for(const tab of document.querySelectorAll('[data-level]')) {
    const selected=tab.dataset.level===(agent?'agent':'single');
    tab.setAttribute('aria-selected',selected);tab.tabIndex=selected?0:-1;tab.disabled=pending;
  }
  for(const tab of document.querySelectorAll('[data-task]')) {
    const selected=tab.dataset.task===task.id;
    tab.setAttribute('aria-selected',selected);tab.tabIndex=selected?0:-1;tab.disabled=pending;
  }
  for (const id of ['pause','replay','reset','seek','evidence']) $(id).disabled = pending || !player;
  if (player) {
    text('pause-label',player.playing ? 'Pause' : 'Play');
    $('pause').dataset.playing = player.playing;
    $('pause').setAttribute('aria-label',player.playing ? 'Pause recording' : player.complete ? 'Play recording again' : 'Play recording');
    text('status',player.complete ? 'Recording complete' : `${player.playing ? '' : 'Paused · '}${phases[recording.frames[player.frameIndex].phase]}`);
    $('seek').value = player.elapsed;
    $('seek').style.setProperty('--progress',`${100*player.elapsed/recording.duration}%`);
    $('seek').setAttribute('aria-valuetext',`${Math.floor(player.elapsed)} of ${recording.duration} seconds`);
    text('time',`${clock(player.elapsed)} / ${clock(recording.duration)}`);
    text('source-note',`Recorded ${new Date(recording.recordedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})} · ${recording.sourceEnvironment==='local'?'local run · ':''}timing compressed · no live calls`);
  }
}
function renderRecorded(force = false) {
  if (!player) return;
  const index = player.frameIndex;
  if (force || index !== lastFrame) {
    lastFrame = index;
    const view = recordedView(recording,index);
    $('comparison').hidden = false;
    $('demo').dataset.outcome = view.verified ? 'verified' : 'pending';
    metrics('before',view.before); metrics('after',view.after);
    latencyOutcome(view.before,view.after);
    $('sample-email').textContent = recording.example.input ?? recording.example.email;
    $('sample-expected').hidden = !view.output?.expected;
    text('sample-expected',view.output?.expected ? task.layer==='agent'?`Expected: ${goalSummary(task,view.output.expected)}`:`Expected: ${Object.values(view.output.expected).join(' · ')}` : '');
    outputs(view.output); log(goalTrace(view.lines,view.output?.afterTrace));
    $('managed-state').textContent = view.verified ? 'verified' : view.changed ? 'changed' : view.phase === 'proposal' ? 'approval needed' : 'evaluating';
    const story = recordedStory(recording,view,task);
    text('headline',story[0]); text('result',story[1]);
    $('before-output').setAttribute('aria-label',view.output ? `Recorded output for: ${recording.example.input ?? recording.example.email}` : 'Original application output');
    $('after-output').setAttribute('aria-label',view.output ? `Recorded output for: ${recording.example.input ?? recording.example.email}` : 'Managed application output');
  }
  controls();
}
async function action(operation) {
  if (pending) return;
  pending=true; error(); controls();
  try { await operation(); }
  catch(e) { error(e.message); }
  finally { pending=false; renderRecorded(true); }
}
function resetRecording(autoplay = false) {
  $('run-details').open=false; player.reset(autoplay); lastTick=performance.now(); renderRecorded(true);
}
$('pause').addEventListener('click',()=>{player.toggle();lastTick=performance.now();renderRecorded(true);});
$('seek').addEventListener('input',()=>{player.playing=false;player.seek($('seek').value);renderRecorded(true);});
$('replay').addEventListener('click',()=>resetRecording(true));
$('reset').addEventListener('click',()=>resetRecording());
$('evidence').addEventListener('click',()=>action(async()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(recording,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`openmerit-${task.id}-recorded-run.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}));
for(const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click',async()=>{
    const restoreFocus=document.activeElement===tab;
    await action(async()=>{
      const id=tab.dataset.task ?? (tab.dataset.level==='agent'?lastAgentTask:lastSingleTask);if(id===task.id && player) return;
      if(player) player.playing=false;
      const data=await loadRecording(id);applyTask(id,data);renderRecorded(true);
    });
    if(restoreFocus) (tab.dataset.level?$(task.layer==='agent'?'level-agent':'level-single'):$(`tab-${task.id}`)).focus({preventScroll:true});
  });
  tab.addEventListener('keydown',event=>{
    const tabs=[...tab.closest('[role=tablist]').querySelectorAll('[role=tab]')],index=tabs.indexOf(tab);
    const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
    if(next===null || pending) return;event.preventDefault();tabs[next].focus();tabs[next].click();
  });
}
try {
  taskCopy();text('headline',task.heading);text('result',task.intro);pending=true;controls();
  applyTask(task.id,await loadRecording(task.id));renderRecorded(true);
  setInterval(()=>{
    const now=performance.now(),elapsed=(now-lastTick)/1000;lastTick=now;
    if(!document.hidden) {player.advance(elapsed);renderRecorded();}
  },100);
} catch(e) {error(e.message);$('status').textContent='Recording unavailable';}
finally {pending=false;controls();}
