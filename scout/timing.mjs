// Five seconds is the performance target, not a reason to discard valid work.
// Bound the whole search, including decomposition and every model role.
import {failureCode} from './utils.mjs';
export const matchingTimeoutMs=30_000;

// Fixed diagnostic fields only: no request text, error messages or credentials.
export const timingStages=['decomposition','interpretation','decisions','consistency','constraints','canonicalNames','embedding','eligibility','specialistRead','specialistCheck','evidenceRetrieval','evidence','modelRead','ranking'];
export function createTimings(clock=()=>performance.now(),children=[],shared={count:0}) {
  const timings={},pending=new Map(),spans=[];
  return {
    child(){const child=createTimings(clock,[],shared);children.push(child);return child;},
    async measure(stage,run) {
      const start=clock(),id=crypto.randomUUID();pending.set(id,stage);
      const span=timingStages.includes(stage)&&shared.count<80?{id,stage,startedAt:new Date().toISOString(),durationMs:0,failed:false}:null;
      if(span){shared.count++;spans.push({span,start,pending:true});}
      try{return await run();}
      catch(error){if(span)span.failed=true;if(!error.stage)error.stage=stage;throw error;}
      finally{timings[stage]=Math.round(clock()-start);pending.delete(id);if(span){span.durationMs=timings[stage];spans.find(s=>s.span===span).pending=false;}}
    },
    snapshot(error) {
      const snapshots=children.map(c=>c.snapshot());
      const result={timings:{...Object.assign({},...snapshots.map(c=>c.timings)),...timings},pendingStages:[...new Set([...pending.values(),...snapshots.flatMap(c=>c.pendingStages)])],
        spans:[...spans.map(s=>({...s.span,pending:s.pending,durationMs:s.pending?Math.max(0,Math.round(clock()-s.start)):s.span.durationMs})),...snapshots.flatMap(c=>c.spans)]};
      if(error)result.failure={stage:timingStages.includes(error.stage)?error.stage:'matching',type:['AbortError','TimeoutError'].includes(error.name)?'timeout':'error',
        ...(Number.isInteger(error.providerStatus)?{providerStatus:error.providerStatus}:{}),
        code:failureCode(error)};
      return result;
    },
  };
}
