// Fixed diagnostic fields only: no request text, error messages or credentials.
export const timingStages=['interpretation','decisions','consistency','constraints','canonicalNames','embedding','eligibility','specialistRead','specialistCheck','evidenceRetrieval','evidence','modelRead','ranking'];
export function createTimings(clock=()=>performance.now()) {
  const timings={},pending=new Map();
  return {
    async measure(stage,run) {
      const start=clock();pending.set(stage,start);
      try{return await run();}
      catch(error){if(!error.stage)error.stage=stage;throw error;}
      finally{timings[stage]=Math.round(clock()-start);pending.delete(stage);}
    },
    snapshot(error) {
      const result={timings:{...timings},pendingStages:[...pending.keys()]};
      if(error)result.failure={stage:timingStages.includes(error.stage)?error.stage:'matching',type:['AbortError','TimeoutError'].includes(error.name)?'timeout':'error',
        ...(Number.isInteger(error.providerStatus)?{providerStatus:error.providerStatus}:{}),
        ...(typeof error.code==='string'&&/^[a-z0-9_]{1,64}$/.test(error.code)?{code:error.code}:{})};
      return result;
    },
  };
}
