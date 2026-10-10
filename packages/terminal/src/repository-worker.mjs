import { parentPort, workerData } from 'node:worker_threads';
import { createRepositoryScanner } from './repository-index.mjs';
const scan=createRepositoryScanner(workerData.root,workerData.limits);
let busy=false;
parentPort.on('message',async message=>{
  if(message!=='scan'||busy)return;
  busy=true;
  try {
    const index=await scan({onProgress:update=>parentPort.postMessage({type:'progress',...update})});
    parentPort.postMessage({type:'complete',index});
  }catch {
    // Do not send exception messages: filesystem errors can contain paths.
    parentPort.postMessage({type:'failed'});
  }finally {busy=false;}
});
