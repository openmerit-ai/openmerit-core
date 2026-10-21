// Isolate-local, exact-key reuse only. Bounded bytes, entries and lifetime; no
// semantic similarity may merge different filters, negations or inventories.
export function createResultCache({now=Date.now,ttlMs=30_000,maxEntries=32,maxBytes=4*1024*1024}={}) {
  const values=new Map(),pending=new Map();let bytes=0;
  const remove=key=>{const old=values.get(key);if(old)bytes-=old.bytes;values.delete(key);};
  return async(key,compute)=>{
    for(const [k,v] of values)if(v.expires<=now())remove(k);
    const hit=values.get(key);
    if(hit){values.delete(key);values.set(key,hit);return {value:JSON.parse(hit.text),status:'hit',ageMs:now()-hit.created};}
    const shared=pending.get(key);
    if(shared)return {value:structuredClone(await shared),status:'shared',ageMs:0};
    const job=Promise.resolve().then(compute);pending.set(key,job);
    try {
      const value=await job;
      // An omitted compatibility check is not a complete result to reuse.
      const results=value.tasks?value.tasks.flatMap(t=>t.slots):[value];
      if(results.every(r=>r.task?.specialistMatch?.status!=='unavailable'&&!r.task?.evidenceMatch?.degraded)) {
        const text=JSON.stringify(value),size=text.length*2;
        if(maxEntries>0&&size<=maxBytes){while(values.size>=maxEntries||bytes+size>maxBytes)remove(values.keys().next().value);
          const created=now();values.set(key,{text,bytes:size,created,expires:created+ttlMs});bytes+=size;}
      }
      return {value,status:'miss',ageMs:0};
    }finally{pending.delete(key);}
  };
}
