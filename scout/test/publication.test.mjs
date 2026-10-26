import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='cloudflare:workers'?{url:'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkflowEntrypoint {}',shortCircuit:true}:next(specifier,context);
}});
const {ScoutPublication}=await import('../worker.mjs');hook.deregister();

async function fixture() {
  const objects=new Map(),storage=new Map();let fault,queue=Promise.resolve();
  const write=async(key,value,fn)=>{
    const fail=fault?.key===key?fault:null;
    if(fail){fault=null;if(!fail.after)throw Error('Injected storage interruption');}
    fn();if(fail)throw Error('Injected lost acknowledgement');
  };
  const bucket={get:async key=>objects.has(key)?{json:async()=>JSON.parse(objects.get(key))}:null,
    put:async(key,value)=>write(key,value,()=>objects.set(key,typeof value==='string'?value:new TextDecoder().decode(value)))};
  const ctx={storage:{get:async key=>storage.get(key),put:async(key,value)=>storage.set(key,value),
    delete:async key=>write('lease',null,()=>storage.delete(key))},
    blockConcurrencyWhile:fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;}};
  const coordinator=()=>new ScoutPublication(ctx,{SCOUT_CATALOGUE:bucket});
  const get=key=>JSON.parse(objects.get(key));
  objects.set('active.json',JSON.stringify({key:'manifests/old.json',publication:{id:'old'}}));
  objects.set('previous.json',JSON.stringify({publication:{id:'older'}}));
  await coordinator().begin('run');
  const staged={key:'manifests/new.json',previousVersion:'old',publication:{id:'new'}};
  return {coordinator,storage,objects,get,staged,interrupt:(key,after)=>{fault={key,after};}};
}

for(const key of ['previous.json','active.json','health.json','publications/new.json','lease'])for(const after of [false,true]) {
  test(`publication resumes after interruption ${after?'after':'before'} ${key}`,async()=>{
    const f=await fixture();f.interrupt(key,after);
    await assert.rejects(f.coordinator().publish('run',f.staged),/Injected/);
    assert.deepEqual(await f.coordinator().publish('run',f.staged),{published:'new'});
    assert.equal(f.get('active.json').publication.id,'new');
    assert.equal(f.get('previous.json').publication.id,'old');
    assert.equal(f.get('health.json').snapshotVersion,'new');
    assert.equal(f.get('health.json').refreshStatus,'idle');
    assert.equal(f.get('publications/new.json').runId,'run');
    assert.equal(f.storage.has('run'),false);
  });
}
test('lost publication reply is acknowledged without changing a later refresh or its catalogue',async()=>{
  const f=await fixture();await f.coordinator().publish('run',f.staged);
  await f.coordinator().begin('next');
  const running=new Map(f.objects);
  assert.deepEqual(await f.coordinator().publish('run',f.staged),{published:'new'});
  assert.deepEqual(f.objects,running);assert.equal(f.storage.get('run').id,'next');
  await f.coordinator().publish('next',{...f.staged,previousVersion:'new',publication:{id:'newer'}});
  const completed=new Map(f.objects);
  assert.deepEqual(await f.coordinator().publish('run',f.staged),{published:'new'});
  assert.deepEqual(f.objects,completed);assert.equal(f.get('active.json').publication.id,'newer');
});
test('obsolete or unowned publication cannot overwrite a newer active catalogue',async()=>{
  const f=await fixture();const before=new Map(f.objects);
  await assert.rejects(f.coordinator().publish('wrong',f.staged),/lease/);
  await assert.rejects(f.coordinator().publish('run',{...f.staged,previousVersion:'unknown'}),/Newer/);
  assert.deepEqual(f.objects,before);
});
test('concurrent refresh claims serialize and replay preserves the original lease start',async()=>{
  const f=await fixture(),time=f.storage.get('run').startedAt;
  const claims=await Promise.all([f.coordinator().begin('run'),f.coordinator().begin('other')]);
  assert.deepEqual(claims,[{acquired:true},{acquired:false}]);
  assert.equal(f.storage.get('run').startedAt,time);
});
