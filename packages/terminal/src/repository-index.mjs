import { opendir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, dirname, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseCode, parseConfig } from './repository-syntax.mjs';
import { endpointService } from './service-registry.mjs';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { INDEX_LIMITS, emptyIndexSummary } from './repository-policy.mjs';
export { INDEX_LIMITS } from './repository-policy.mjs';

const excluded = new Set(['node_modules','vendor','dist','build','out','coverage','target','venv','env','__pycache__','site-packages','logs','runs','results']);
const extensions = new Set(['.py','.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.yaml','.yml','.toml']);
const privateFile = /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|auth)(?:[._-]|$)|(?:^|\/)id_(?:rsa|ed25519)/i;
const digest = value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const safeName = value=>typeof value==='string' && value.length<=160 && !/[\x00-\x1f\x7f]/.test(value) && !/(?:\bsk[-_]|Bearer\s|(?:api[_-]?key|token|secret|password)\s*[:=])/i.test(value);
const modelValue = value=>safeName(value) && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(value) && !value.includes('://');
const contextFor = file=> /(?:^|\/)(?:benchmarks?|evals?|backtests?)(?:\/|[._-])|(?:benchmark|backtest)/i.test(file)?'benchmark':/(?:^|\/)(?:tests?|fixtures?)(?:\/|[._-])|[._](?:test|spec)\./i.test(file)?'test':/(?:^|\/)(?:examples?|samples?)(?:\/|[._-])|(?:^|\/)\.env\.(?:example|sample|template)/i.test(file)?'example':'application';
const envFile = file=>/(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(file);

// Display identity only. No result from this module is used as a network target.
export function endpointIdentity(value) {
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\$`]/.test(value))return null;
  try {
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    const known=endpointService(value), host=url.hostname;
    if(['huggingface.co','www.huggingface.co','hf.co'].includes(host))return {nonInference:true};
    if(/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/.test(host)||['url.here','your-endpoint','your-host'].includes(host))return {placeholder:true};
    if(/(?:sk-|token|secret|password)/i.test(host))return null;
    const displayHost=known?.endpointHost??host.split('.').map(label=>label.length>30?'…':label).join('.');
    // Account/project/model identifiers can be embedded in paths. Keep only
    // structural API paths; custom resource suffixes are deliberately omitted.
    const path=/^\/(?:v\d+(?:beta\d*)?|api(?:\/v\d+)?|api\/alpha\/decisions|v1\/systemone|dsr1\/v1)\/?$/.test(url.pathname)?url.pathname.replace(/\/$/,''):'';
    const address=displayHost+(url.port?':'+url.port:'')+path;
    const local=['localhost','127.0.0.1','[::1]'].includes(host);
    const privateHost=local||host.endsWith('.local')||host.endsWith('.internal')||/^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^\[(?:fc|fd|fe80)/i.test(host);
    return {address,host:displayHost+(url.port?':'+url.port:''),service:known?.service.name??address,serviceType:known?.service.type??'unknown',location:privateHost?'private':known?'cloud':'unknown',loopback:local,ip:Boolean(isIP(host.replace(/^\[|\]$/g,''))),pathRedacted:url.pathname!=='/'&&!path};
  }catch{return null;}
}
export function indexDiagnostics(index) {
  // Sharing is opt-in by copying this output. Deliberately exclude paths,
  // names, URLs, values, environment variables and source contents.
  const counts=index?.summary?.issueCounts??{};
  return {schemaVersion:1,scope:'repository-index',enabled:Boolean(index),summary:index?.summary??null,issueCounts:counts,limits:INDEX_LIMITS};
}
// Cache only parser metadata, never source text, and never write into the project.
// Endpoint values are sanitized before entering this process-local cache.
function cacheEntry(entry) {
  const result={...entry};
  if (entry.endpoints) result.endpoints=entry.endpoints.map(cacheEntry);
  if (typeof entry.value==='string' && (entry.kind==='endpoint' || /^https?:\/\//i.test(entry.value))) {
    result.endpointValue=endpointIdentity(entry.value) || {invalid:true};
    result.value=result.endpointValue.address || '';
  }
  return result;
}
function reporter(summary, issues, limit) {
  const seen=new Set();
  return (code,file,line=1,field)=>{
    const key=JSON.stringify([code,file,line,field]);if(seen.has(key))return;seen.add(key);
    summary.unresolved++;summary.issueCounts[code]=(summary.issueCounts[code]||0)+1;
    if(issues.length<limit)issues.push({code,...(file?{file}:{}),line,...(field&&safeName(field)?{field}:{})});
  };
}
export function createRepositoryScanner(root, options={}) {
  const limits={...INDEX_LIMITS,...options};
  const cache=new Map();let running=false,scanId=0;
  return async function scanRepository({onProgress=()=>{},signal}={}) {
    if(running)throw new Error('Repository scan already running');
    running=true;
    const started=performance.now(),summary=emptyIndexSummary(),scanIssues=[],parsed=[],files=[],seen=new Set();
    const issue=reporter(summary,scanIssues,limits.issues);
    const progress={phase:'discovering',scan:++scanId,discovered:0,processed:0,parsed:0,reused:0,batches:0,total:null,elapsedMs:0};
    let environmentFiles=Infinity;
    let lastPublished=0,batchFiles=0,batchBytes=0,batchStart=performance.now();
    const check=()=>signal?.throwIfAborted();
    const status=()=>({...progress,elapsedMs:Math.round(performance.now()-started)});
    const publish=async (force=false,results=false)=>{
      check();
      if(!force&&performance.now()-lastPublished<limits.publishMs)return;
      lastPublished=performance.now();
      // On a first scan, usable declarations arrive in batches. Later scans
      // retain the last complete index until replacement, avoiding flicker.
      const index=results?projectIndex(parsed,summary,scanIssues,limits):null;
      await onProgress({progress:status(),summary:{...summary},...(index?{index:{...index,progress:status()}}:{})});
    };
    const batch=async()=>{
      if(batchFiles<limits.batchFiles&&batchBytes<limits.batchBytes&&performance.now()-batchStart<limits.batchMs)return;
      progress.batches++;await publish(false,progress.phase==='indexing'&&progress.processed>=environmentFiles&&scanId===1);
      await yieldThread();check();batchFiles=0;batchBytes=0;batchStart=performance.now();
    };
    try {
      const canonical=await realpath(root),directories=[canonical];
      await publish(true);
      // Iterative traversal has no depth/entry ceiling and does not consume
      // the JS call stack. Symlinks and excluded directories remain excluded.
      while(directories.length) {
        check();const dir=directories.pop();
        try {
          if(await realpath(dir)!==dir){summary.skipped.symlink++;continue;}
          const directory=await opendir(dir);
          for await(const entry of directory) {
            check();summary.entriesVisited++;
            const isEnv=/^\.env(?:\.[\w.-]+)?$/.test(entry.name);
            if(entry.isSymbolicLink())summary.skipped.symlink++;
            else if(entry.name.startsWith('.')&&!isEnv||excluded.has(entry.name)||privateFile.test(entry.name)||/(?:package-lock|pnpm-lock|yarn\.lock|\.min\.|\.d\.ts$)/.test(entry.name))summary.skipped.policy++;
            else {
              const path=join(dir,entry.name);
              if(entry.isDirectory())directories.push(path);
              else if(entry.isFile()) {
                if(isEnv||extensions.has(extname(entry.name))){files.push(path);progress.discovered++;}
                else summary.skipped.unsupported++;
              }
            }
            // Walking a tree full of unsupported files is still cooperative.
            batchFiles++;await batch();
          }
        }catch(error){check();summary.skipped.unreadable++;issue('unreadable-directory',relative(canonical,dir)||'.');}
      }
      const priority=path=>envFile(path)?0:/\.(?:json|ya?ml|toml)$/.test(path)?1:/(?:inference|llm|model|provider|client|agent|router)/i.test(path)?2:3;
      files.sort((a,b)=>priority(a)-priority(b)||a.localeCompare(b));
      environmentFiles=files.filter(envFile).length;
      progress.phase='indexing';progress.total=files.length;await publish(true);
      for(const path of files) {
        check();const file=relative(canonical,path);let handle;
        try {
          if(await realpath(path)!==path||!path.startsWith(canonical+sep)){summary.skipped.symlink++;continue;}
          handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
          const stat=await handle.stat({bigint:true});
          if(!stat.isFile()){summary.skipped.policy++;continue;}
          if(stat.size>BigInt(limits.fileBytes)){summary.skipped.oversized++;issue('oversized-file',file);continue;}
          const fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
          seen.add(file);
          const cached=cache.get(file);
          let item;
          if(cached?.fingerprint===fingerprint){item=cached;progress.reused++;}
          else {
            const buffer=Buffer.alloc(Math.min(limits.fileBytes+1,Number(stat.size)+1));
            const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
            summary.filesRead++;summary.bytesRead+=bytesRead;batchBytes+=bytesRead;
            if(bytesRead>limits.fileBytes){summary.skipped.oversized++;issue('oversized-file',file);seen.delete(file);continue;}
            const after=await handle.stat({bigint:true});
            if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(':')!==fingerprint){issue('changed-during-read',file);seen.delete(file);continue;}
            const body=buffer.subarray(0,bytesRead).toString('utf8');
            const hash=digest(body);
            if(cached?.hash===hash){item={...cached,fingerprint};progress.reused++;}
            else {
              const code=/\.(?:py|[cm]?js|jsx|tsx?)$/.test(file);
              const result=body.includes('\0')?{entries:[],issues:[{code:'binary-file'}]}:code?parseCode(body,file):parseConfig(body,file);
              // Dotenv bindings are read each scan and discarded after projection;
              // arbitrary unrelated setting values never enter the cache.
              item={file,context:contextFor(file),fingerprint,hash,bytes:bytesRead,entries:result.entries.map(cacheEntry),issues:result.issues};
              progress.parsed++;
            }
            if(!envFile(file))cache.set(file,item);
          }
          parsed.push(item);summary.filesIndexed++;summary.bytesIndexed+=item.bytes;
          const format=envFile(file)?'dotenv':extname(file).slice(1);
          summary.filesByFormat[format]=(summary.filesByFormat[format]||0)+1;
          for(const note of item.issues)issue(note.code,file,note.line,note.field);
        }catch(error){check();seen.delete(file);summary.skipped.unreadable++;issue('unreadable-file',file);}
        finally {await handle?.close();progress.processed++;batchFiles++;await batch();}
      }
      for(const file of cache.keys())if(!seen.has(file))cache.delete(file);
      progress.phase='resolving';await publish(true);
      const index=projectIndex(parsed,summary,scanIssues,limits);
      progress.phase='complete';progress.batches++;
      return {...index,progress:status()};
    }finally {running=false;}
  };
}
export async function indexRepository(root,limits=INDEX_LIMITS) {
  return createRepositoryScanner(root,limits)();
}
function projectIndex(parsed,scanSummary,scanIssues,limits) {
  const summary={...scanSummary,unresolved:0,issueCounts:{}},issues=[],references=[];
  const issue=reporter(summary,issues,limits.issues);
  // Preserve total issue counts even when the detailed list is bounded.
  for(const note of scanIssues)issue(note.code,note.file,note.line,note.field);
  summary.unresolved=scanSummary.unresolved;summary.issueCounts={...scanSummary.issueCounts};
  const envValues=[];
  for(const item of parsed.filter(p=>envFile(p.file)&&p.context==='application'))for(const e of item.entries)if(e.environmentDeclaration&&(e.value||e.endpointValue))envValues.push({...e,file:item.file});
  const environment=new Map();
  for(const e of envValues){const key=JSON.stringify([dirname(e.file),e.field]);if(!environment.has(key))environment.set(key,[]);environment.get(key).push(e);}
  const resolveEnv=(entry,file)=>{
    if(entry.value!==undefined)return [entry];
    if(!entry.env)return [];
    let dir=dirname(file);
    for(;;){
      const matching=environment.get(JSON.stringify([dir,entry.env]))||[];
      if(matching.length){
        const unique=[...new Set(matching.map(e=>JSON.stringify([e.value,e.endpointValue])))];
        if(unique.length!==1){issue('ambiguous-environment',file,entry.line,entry.field);return [];}
        return [{...entry,value:matching[0].value,...(matching[0].endpointValue?{endpointValue:matching[0].endpointValue}:{}),basis:'environment-reference',via:{file:matching[0].file,line:matching[0].line}}];
      }
      if(dir==='.')break;dir=dirname(dir);
    }
    issue('unresolved-environment',file,entry.line,entry.field);return [];
  };
  const unique=new Map();
  function add(entry,item,extra={}) {
    const {kind,field,line,basis}=entry;
    let context=item.context;
    if(context==='application'&&entry.alias)context='alias';
    if(context==='application'&&(entry.candidate||basis==='branch'))context='candidate';
    if(context==='application'&&basis==='fallback')context='fallback';
    let value=entry.value,endpoint;
    if(kind==='binding')return null;
    if(kind==='endpoint') {
      endpoint=entry.endpointValue??endpointIdentity(value);
      if(endpoint?.nonInference){issue('non-inference-endpoint',item.file,line,field);return null;}
      if(endpoint?.placeholder){issue('placeholder-endpoint',item.file,line,field);return null;}
      if(!endpoint||endpoint.invalid){issue('unsupported-endpoint',item.file,line,field);return null;}
      value=endpoint.address;
    }else if(!(kind==='task' ? safeName(value) && value.trim() && !value.includes('://') : modelValue(value))){
      issue(value?.includes('*')?'model-pattern':'unsupported-value',item.file,line,field);return null;
    }
    if(context==='application'&&kind==='model'&&!extra.endpointIds?.length&&!entry.inferenceCall&&!entry.localLibrary)context='unlinked';
    const id=digest([kind,item.file,line,value,context].join('|'));
    const previous=unique.get(id);
    const result={id,kind,value,file:item.file,line,field,basis,context,...(entry.via?{via:entry.via}:{}),...(endpoint?{endpoint}:{}),...(entry.localLibrary?{localLibrary:true}:{}),...extra};
    if(previous){Object.assign(previous,extra);return previous;}
    unique.set(id,result);return result;
  }
  for(const item of parsed){
    const groups=new Map();
    for(const e of item.entries){const group=groups.get(e.group)||[];group.push(e);groups.set(e.group,group);}
    for(const entries of groups.values()) {
      const endpoints=entries.filter(e=>e.kind==='endpoint').flatMap(e=>resolveEnv(e,item.file));
      for(const entry of entries.filter(e=>e.kind!=='binding'))for(const e of resolveEnv(entry,item.file)) {
        let endpointIds=[];
        if(e.kind==='model'||e.kind==='task'){
          const linked=(e.endpoints?.length?e.endpoints:endpoints).flatMap(v=>resolveEnv({...v,field:v.field||'base_url',kind:'endpoint',line:v.line||e.line},item.file));
          endpointIds=[...new Set(linked.map(v=>add(v,item)).filter(Boolean).map(r=>r.id))];
        }
        const ref=add(e,item,endpointIds.length?{endpointIds}:{});
        if(ref&&e.kind==='model'&&e.task&&safeName(e.task))ref.task=e.task;
      }
    }
  }
  const resolvedSites=new Set([...unique.values()].filter(r=>r.context==='application').map(r=>[r.kind,r.file,r.line,r.value].join('|')));
  references.push(...[...unique.values()].filter(r=>r.context!=='unlinked'||!resolvedSites.has([r.kind,r.file,r.line,r.value].join('|'))));
  summary.declarations=references.length;
  const inventory=[],models=[], byService=new Map();
  for(const ref of references.filter(r=>r.kind==='endpoint'&&r.context==='application')) {
    const endpoint=ref.endpoint,name=endpoint.service;
    const item=byService.get(name)||{name,kind:['router','gateway','runtime'].includes(endpoint.serviceType)?endpoint.serviceType:endpoint.serviceType==='unknown'?'unknown':'provider',serviceType:endpoint.serviceType,location:endpoint.location,state:'declared',sourceId:'repository',evidence:[]};
    item.evidence.push({sourceId:'repository',field:ref.field,basis:'repository-declaration',file:ref.file,line:ref.line,referenceId:ref.id,endpointHost:endpoint.host});byService.set(name,item);
  }
  inventory.push(...byService.values());
  const byId=new Map(references.map(r=>[r.id,r]));
  const linkedModels=new Set(references.filter(r=>r.kind==='model'&&r.context==='application'&&r.endpointIds?.length).map(r=>`${r.file}:${r.value}`));
  const byModel=new Map();
  for(const ref of references.filter(r=>r.kind==='model'&&r.context==='application')) {
    if(!ref.endpointIds?.length&&linkedModels.has(`${ref.file}:${ref.value}`))continue;
    const endpoints=(ref.endpointIds||[]).map(id=>byId.get(id)).filter(r=>r?.context==='application').map(r=>r.endpoint);
    // Multiple alternatives do not establish which service supplies this model.
    const services=[...new Set(endpoints.map(e=>e.service))];
    const provider=services.length===1?services[0]:'Unattributed';
    const key=JSON.stringify([provider,ref.value]);
    if(byModel.has(key))byModel.get(key).declarationIds.push(ref.id);
    else byModel.set(key,{id:`declaration:${ref.id}`,name:ref.value,provider,location:'unknown',state:'declared',sourceId:'repository',declarationIds:[ref.id],memoryBytes:null});
  }
  models.push(...byModel.values());
  return {references,issues,summary,inventory,models,checkedAt:new Date().toISOString()};
}
