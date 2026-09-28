export const tasks = {
  fieldkit: {id:'fieldkit',layer:'agent',incumbent:'fieldkit/original-v2',label:'Field kit',command:'field brief → recording handoff',inputNoun:'request',inputPlural:'goals',
    description:'Check whether an offline field-recording kit is ready to use. Six model tasks work through a Spanish brief, equipment label, manual, and capture script to identify blockers and write a handoff.',
    recording:'/demo/recording-fieldkit.json?v=1',heading:'One handoff. Six different strengths.',
    intro:'Translate a brief, read a label, extract limits, inspect code, check feasibility, and write the handoff.',
    sampleCount:4,verificationCount:4,maximumTries:1,minimumSuccess:1,maximumLatency:45000,maximumCost:.006,
    policy:'4 complete goals · every source, intermediate result, and final handoff checked · mean ≤45s and ≤$0.006 per goal. 4 separate goals verify a change.',
    constraints:'Required: 4/4 goals · offline, sample rate, battery, storage, deadline & connector',
    knownJobs:'Prepared kits: KIT-8101–KIT-8104. Request one kit’s handoff; the brief, label image, manual, and script are fixed.',
    note:'Both routes already use six different models. The original mix is compared with a prepared mix of translation, visual perception, HTML extraction, coding, reasoning, and instruction models. Each route has six distinct models; five assignments change while the feasibility model is retained. Each model does one task; its actual result feeds the next dependent task. Vision receives a real synthetic label image, the extractor receives HTML, and the coder reads Python without executing it. The workflow dispatches read-only source adapters. Both routes get the same inputs, stage formats, token budgets, and graders. Every intermediate structured result must match, as well as the final handoff. The two route configurations and integrations are supplied in advance; this is not an unrestricted model search. All application models were released within March 28–September 28, 2026. No kit is dispatched, recording uploaded, or script executed.'},
  support: { id:'support', label:'Support tickets', command:'support email → ticket', inputNoun:'email', inputPlural:'emails',
    description:'Turn a customer email into a ticket with a category, urgency, and order ID. The same emails test whether a cheaper model can produce the required result.',
    recording:'/demo/recording.json?v=3', heading:'One task. Three models.',
    intro:'Turn support emails into tickets. Find a cheaper model that passes the checks.',
    note:'Prepared prompt, exact-match grader, and model shortlist. Both paths use the same ticket schema.' },
  spam: { id:'spam', label:'Spam filter · Jev', command:'community comment → publish / hold', inputNoun:'comment', inputPlural:'comments',
    description:'Decide whether a community comment should be published or held as promotional spam. Compare a general chat model with Jev, a specialist for this kind of decision.',
    recording:'/demo/recording-spam.json?v=1', heading:'A small decision. A better fit.',
    intro:'Filter promotional spam. Compare a chat model with Jev, a specialist for typed decisions.',
    note:'Jev 1.13 is a TypeSafe decision model. Its API adapter and publish/hold question are prepared in advance. OpenMerit evaluates the application route and changes its model configuration after approval; it does not generate this integration.' },
  backfill: {id:'backfill',layer:'agent',label:'Backfill recovery',command:'failed backfill → recovery manifest',inputNoun:'request',inputPlural:'goals',
    description:'Plan a safe restart for an interrupted data backfill. Three model steps inspect the incident and saved checkpoint, then identify what to replay or quarantine without repeating committed data.',
    recording:'/demo/recording-backfill.json?v=2',heading:'One goal. A model for each task.',
    intro:'Recover an interrupted backfill without replaying committed data. Inspect the incident, read the checkpoint, and plan the recovery.',
    sampleCount:8,minimumSuccess:1,maximumLatency:8000,maximumCost:.003,
    policy:'8 complete goals · 100% exact manifest, tool, schema, checkpoint-safety, and evidence checks · mean ≤8s and ≤$0.003 per goal.',
    constraints:'Required: 8/8 goals · no committed data replayed · all evidence cited',
    knownJobs:"Prepared jobs: BF-4101–BF-4108. Ask for one job's recovery manifest; its incident and ledger are fixed.",
    note:'A prepared agent uses three sequential model turns and two read-only tools over synthetic incident and checkpoint records. OpenMerit compares the fixed model with a prepared mixed-model route, evaluates the whole goal, and applies the route after approval. Each task uses the model shown above and receives the preceding context. The route shortlist is supplied in advance; this does not demonstrate an unrestricted search over model combinations. Recovery manifests are never executed.'},
  placement: {id:'placement',layer:'agent',incumbent:'qwen/qwen3.6-plus',label:'GPU placement',command:'GPU job → eligible pool',inputNoun:'request',inputPlural:'goals',
    description:'Find the cheapest GPU pool that meets a job’s region, memory, capacity, deadline, budget, and preemption rules. Three model steps read the requirements, inspect capacity, and produce a placement plan.',
    recording:'/demo/recording-placement.json?v=1',heading:'One job. Six hard constraints.',
    intro:'Place a GPU job without breaking its region, memory, capacity, deadline, budget, or preemption rules.',
    sampleCount:8,minimumSuccess:1,maximumLatency:12000,maximumCost:.003,
    policy:'8 complete goals · 100% exact placement, tool, schema, constraint, and evidence checks · mean ≤12s and ≤$0.003 per goal.',
    constraints:'Required: 8/8 goals · region, VRAM, capacity, deadline, budget & preemption',
    knownJobs:"Prepared jobs: GPU-6101–GPU-6108. Ask for one job's placement plan; its requirements and capacity are fixed.",
    note:'Three sequential model turns read a synthetic job, inspect its pool inventory, and prepare a placement plan. Choose the cheapest eligible pool, then earliest finish, then alphabetical pool ID; block the job if none qualify. OpenMerit compares a fixed model with a prepared Gemma 4 / MiMo-V2.5 / DeepSeek V4.1 Flash route and applies the complete route after approval. Each step receives the trusted results it needs; raw queue notes are not forwarded to later tasks. All four application models, including the Qwen3.6 Plus baseline, were released within March 28–September 28, 2026. No capacity is reserved and no GPU job is launched. The shortlist is supplied in advance, not an unrestricted search over model combinations. GPU quotes in sample outputs are synthetic; comparison costs are actual model-call costs.'},
};
export function goalSummary(task,output) {
  if(!output) return 'No valid plan.';
  if(task.id==='fieldkit') return `${output.status} · ${output.blockers?.length?output.blockers.join(', '):'all constraints met'}`;
  return task.id==='placement'?`${output.status} · ${output.pool_id ?? 'no eligible pool'}`:`${output.status} · replay [${output.replay ?? ''}] · quarantine [${output.quarantine ?? ''}]`;
}
export function qualifies(batch,task) {
  return !!batch && batch.matches/batch.samples>=(task.minimumSuccess ?? .9) && batch.latencyMs<=(task.maximumLatency ?? 10000)
    && (task.layer!=='agent' || unitCost(batch)<=task.maximumCost && Object.values(batch.checks ?? {}).length===4 && Object.values(batch.checks).every(v=>v===1));
}
export const unitCost = batch => batch?.costPerInput ?? batch?.costPerEmail;
export function savings(before,after) {
  const a=unitCost(before),b=unitCost(after);
  const changes=[];
  if(Number.isFinite(a) && Number.isFinite(b) && a>0 && b>=0 && b<a) changes.push(`${Math.round((1-b/a)*100)}% lower cost.`);
  if(Number.isFinite(before?.latencyMs) && Number.isFinite(after?.latencyMs) && before.latencyMs>0 && after.latencyMs>=0) {
    const reduction=(1-after.latencyMs/before.latencyMs)*100;
    const percent=Math.round(Math.abs(reduction));
    changes.push(percent ? `${percent}% ${reduction>0?'lower':'higher'} latency.` : reduction===0 ? 'Same latency.' : 'Similar latency.');
  }
  return changes.join(' ') || 'Comparison complete.';
}
export function recordedStory(recording,view,task) {
  const chosen=recording.measurements[recording.selectedMeasurement ?? 'trial-2'];
  const lastTrial=Object.entries(view.batches).filter(([key])=>key!=='baseline').at(-1)?.[1];
  if(view.verified) {
    const equal=view.before.matches/view.before.samples===view.after.matches/view.after.samples;
    return [savings(view.before,view.after),`${equal?'Same ':''}${view.after.matches}/${view.after.samples} ${task.layer==='agent'?'goals completed':'fixture matches'}. ${recording.verification.matches}/${recording.verification.samples} fresh checks passed.`];
  }
  if(view.phase==='applied') return ['Change made. Now verify.',`${recording.verification.samples} fresh ${task.inputPlural} check the new ${task.layer==='agent'?'model route':'application model'}.`];
  if(view.phase==='approved') return ['Approval received.','The operator approved this change in the recorded run.'];
  if(view.phase==='proposal') return ['You approve the change.',task.layer==='agent'?'OpenMerit proposes the measured route. The original route stays unchanged.':`OpenMerit proposes ${chosen.name}. The original model stays put.`];
  if(lastTrial) {
    const passes=qualifies(lastTrial,task);
    const cheaper=unitCost(lastTrial)<unitCost(view.before);
    return passes ? [task.id==='spam'?'A specialist qualifies.':task.layer==='agent'?'A mixed-model route passes.':cheaper?'A cheaper model passes.':'A model meets the requirements.',`${lastTrial.name} matches ${lastTrial.matches}/${lastTrial.samples} test ${task.inputPlural}${cheaper?' at a lower measured cost':''}.`]
      : ['Cheaper doesn’t always qualify.',`${lastTrial.name} matches ${lastTrial.matches}/${lastTrial.samples}. It fails the prepared requirements.`];
  }
  if(view.before) return ['Start with a measured baseline.',`${view.before.name} matches ${view.before.matches}/${view.before.samples} test ${task.inputPlural}.`];
  return [task.heading,task.intro];
}
