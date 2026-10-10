import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBackgroundIndex} from '../src/repository-background.mjs';
import {createCollector,loadConfig} from '../src/collect.mjs';
import {startTerminal} from '../src/server.mjs';
async function until(read,predicate){for(let i=0;i<300;i++){const result=await read();if(predicate(result))return result;await delay(10);}assert.fail('Timed out waiting for background index');}

test('worker results and deletions update snapshots independently of the collection interval',async t=>{
  const root=await mkdtemp(join(tmpdir(),'terminal-background-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await Promise.all(Array.from({length:120},(_,i)=>writeFile(join(root,`app-${i}.json`),JSON.stringify({base_url:'https://api.openai.com/v1',model:`model-${i}`}))));
  const collect=createCollector(root,await loadConfig(root),15,{backgroundIndex:true,indexOptions:{intervalMs:200,limits:{publishMs:0,batchFiles:8}}});
  const terminal=await startTerminal({root,port:0,collect,interval:15});t.after(()=>terminal.close());
  const read=async()=> (await fetch(`${terminal.url}/api/snapshot`)).json();
  let seenPartial=false;
  const complete=await until(async()=>{const s=await read();if(s.repository?.references.length&&s.repository.progress.phase!=='complete')seenPartial=true;return s;},s=>s.repository?.progress.phase==='complete');
  assert.equal(complete.models.length,120);assert.equal(complete.records.length,0);
  const revision=complete.repository.revision;
  const compact=await (await fetch(`${terminal.url}/api/snapshot?repositoryRevision=${revision}`)).json();
  if(compact.repository.revision===revision)assert.equal(compact.repository.references,undefined);
  assert.ok((await read()).repository.references.length,'plain API remains self-contained');
  await rm(join(root,'app-119.json'));
  const changed=await until(read,s=>s.repository?.progress.phase==='complete'&&s.repository.progress.scan>=2&&s.models.length===119);
  assert.equal(changed.observedAt,complete.observedAt,'repository updates do not rerun activity collection');
  assert.equal(changed.repository.progress.parsed,0);assert.equal(changed.repository.progress.reused,119);
});

test('worker failures are explicit, recover on a later scan, and can be closed twice',async t=>{
  const root=await mkdtemp(join(tmpdir(),'terminal-worker-'));await rm(root,{recursive:true});
  const index=createBackgroundIndex(root,{intervalMs:50});t.after(()=>index.close());
  index.start();const failed=await until(()=>index.get(),r=>r.progress.phase==='failed');assert.equal(failed.checkedAt,null);assert.equal(failed.references.length,0);
  const {mkdir}=await import('node:fs/promises');await mkdir(root);t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'config.json'),'{"base_url":"https://api.openai.com/v1","model":"gpt-5"}');
  const recovered=await until(()=>index.get(),r=>r.progress.phase==='complete');assert.equal(recovered.models.length,1);
  await index.close();await index.close();
});

test('a failed first collection is disclosed without exposing the error and is retried',async t=>{
  let calls=0;
  const terminal=await startTerminal({port:0,interval:0.05,collect:async()=>{if(++calls===1)throw new Error('PRIVATE_PATH');return {mode:'live',records:[],sequence:calls};}});
  t.after(()=>terminal.close());
  const initial=await (await fetch(`${terminal.url}/api/snapshot`)).json();assert.equal(initial.loadError,true);assert.doesNotMatch(JSON.stringify(initial),/PRIVATE_PATH/);
  const recovered=await until(async()=> (await fetch(`${terminal.url}/api/snapshot`)).json(),s=>s.sequence>=2);assert.equal(recovered.loading,undefined);
});
