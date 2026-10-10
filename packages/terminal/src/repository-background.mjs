import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { emptyIndexSummary } from './repository-policy.mjs';

// The HTTP server never parses project code. A failed worker leaves the last
// usable index visible, explicitly marked incomplete, and retries next cycle.
export function createBackgroundIndex(root,{intervalMs=60_000,limits}={}) {
  let worker=null,timer=null,closed=false,started=false,revision=0;
  const session=randomUUID(),nextRevision=()=>`${session}:${++revision}`;
  let current={references:[],issues:[],models:[],inventory:[],summary:emptyIndexSummary(),checkedAt:null,revision:`${session}:0`,progress:{phase:'queued',processed:0,total:null,discovered:0,parsed:0,reused:0,elapsedMs:0}};
  const schedule=()=>{if(!closed){clearTimeout(timer);timer=setTimeout(run,intervalMs);timer.unref();}};
  const failed=()=>{if(closed)return;current={...current,revision:nextRevision(),progress:{...current.progress,phase:'failed'}};schedule();};
  function run() {
    if(closed)return;
    if(!worker) {
      worker=new Worker(new URL('./repository-worker.mjs',import.meta.url),{workerData:{root,limits},resourceLimits:{maxOldGenerationSizeMb:256},execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))});
      worker.on('message',message=>{
        if(closed)return;
        if(message.type==='failed'){failed();return;}
        if(message.type==='complete') {
          current={...message.index,revision:nextRevision()};schedule();
        }else {
          current=message.index?{...message.index,revision:nextRevision()}:{...current,progress:message.progress};
        }
      });
      worker.on('error',()=>{ /* Exit handles termination and the retry. */ });
      worker.on('exit',()=>{worker=null;failed();});
      worker.unref();
    }
    worker.postMessage('scan');
  }
  return {
    start(){if(!started&&!closed){started=true;run();}},
    get(){return current;},
    async close(){closed=true;clearTimeout(timer);const active=worker;worker=null;if(active)await active.terminate();},
  };
}
