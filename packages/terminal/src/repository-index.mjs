import { opendir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, dirname, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseCode, parseConfig } from './repository-syntax.mjs';
import { endpointService } from './service-registry.mjs';

export const INDEX_LIMITS = Object.freeze({ files:400, entries:8000, bytes:4*1024*1024, fileBytes:128*1024, depth:8, declarations:2000, issues:100 });
const excluded = new Set(['node_modules','vendor','dist','build','out','coverage','target','venv','env','__pycache__','site-packages','logs','runs','results']);
const extensions = new Set(['.py','.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.yaml','.yml','.toml']);
const privateFile = /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|auth)(?:[._-]|$)|(?:^|\/)id_(?:rsa|ed25519)/i;
const digest = value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const safeName = value=>typeof value==='string' && value.length<=160 && !/[\x00-\x1f\x7f]/.test(value) && !/(?:sk[-_]|Bearer\s|(?:api[_-]?key|token|secret|password)\s*[:=])/i.test(value);
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
  const counts={};for(const issue of index?.issues??[])counts[issue.code]=(counts[issue.code]||0)+1;
  return {schemaVersion:1,scope:'repository-index',enabled:Boolean(index),summary:index?.summary??null,issueCounts:counts,limits:INDEX_LIMITS};
}
export async function indexRepository(root, limits=INDEX_LIMITS) {
  const canonical=await realpath(root), files=[], issues=[], parsed=[], references=[];
  const summary={filesRead:0,bytesRead:0,entriesVisited:0,filesByFormat:{},skipped:{policy:0,unsupported:0,symlink:0,oversized:0,unreadable:0},truncated:false,declarations:0,unresolved:0};
  const issueKeys=new Set();
  const issue=(code,file,line=1,field)=>{const key=JSON.stringify([code,file,line,field]);if(issueKeys.has(key))return;issueKeys.add(key);summary.unresolved++;if(issues.length<limits.issues)issues.push({code,...(file?{file}:{}),line,...(field&&safeName(field)?{field}: {})});};
  async function scan(dir,depth) {
    let directory;
    try {directory=await opendir(dir);for await(const entry of directory){
      if(++summary.entriesVisited>limits.entries){summary.truncated=true;break;}
      if(entry.isSymbolicLink()){summary.skipped.symlink++;continue;}
      const isEnv=/^\.env(?:\.[\w.-]+)?$/.test(entry.name);
      if(entry.name.startsWith('.')&&!isEnv||excluded.has(entry.name)||privateFile.test(entry.name)||/(?:package-lock|pnpm-lock|yarn\.lock|\.min\.|\.d\.ts$)/.test(entry.name)){summary.skipped.policy++;continue;}
      const path=join(dir,entry.name);
      if(entry.isDirectory()){
        if(depth>=limits.depth){summary.truncated=true;continue;}
        const st=await lstat(path);if(st.isSymbolicLink()||await realpath(path)!==path){summary.skipped.symlink++;continue;}
        await scan(path,depth+1);
      }else if(entry.isFile()){
        if(isEnv||extensions.has(extname(entry.name)))files.push(path);else summary.skipped.unsupported++;
      }
      if(summary.entriesVisited>=limits.entries){summary.truncated=true;break;}
    }}catch{summary.skipped.unreadable++;issue('unreadable-directory',relative(canonical,dir)||'.');}
  }
  await scan(canonical,0);
  // Deterministic selection prefers environment/configuration before source.
  files.sort((a,b)=>Number(!envFile(a))-Number(!envFile(b))||a.localeCompare(b));
  if(files.length>limits.files)summary.truncated=true;
  for(const path of files.slice(0,limits.files)) {
    const file=relative(canonical,path);let handle;
    try{
      if(await realpath(path)!==path || !path.startsWith(canonical+sep)){summary.skipped.symlink++;continue;}
      handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));const stat=await handle.stat();
      if(!stat.isFile()){summary.skipped.policy++;continue;}
      if(stat.size>limits.fileBytes){summary.skipped.oversized++;issue('oversized-file',file);continue;}
      if(summary.bytesRead+stat.size>limits.bytes){summary.truncated=true;continue;}
      const buffer=Buffer.alloc(Math.min(limits.fileBytes+1,stat.size+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead>limits.fileBytes){summary.skipped.oversized++;issue('oversized-file',file);continue;}
      summary.filesRead++;summary.bytesRead+=bytesRead;
      const body=buffer.subarray(0,bytesRead).toString('utf8');
      if(body.includes('\0')){issue('binary-file',file);continue;}
      const code=/\.(?:py|[cm]?js|jsx|tsx?)$/.test(file),format=envFile(file)?'dotenv':extname(file).slice(1);
      summary.filesByFormat[format]=(summary.filesByFormat[format]||0)+1;
      const result=code?parseCode(body,file):parseConfig(body,file);
      for(const i of result.issues)issue(i.code,file,i.line,i.field);
      // Parser input is released after each file; only narrow metadata survives.
      parsed.push({file,context:contextFor(file),entries:result.entries});
    }catch{summary.skipped.unreadable++;issue('unreadable-file',file);}
    finally{await handle?.close();}
  }
  const envValues=[];
  for(const item of parsed.filter(p=>envFile(p.file)&&p.context==='application'))for(const e of item.entries)if(e.environmentDeclaration&&e.value)envValues.push({...e,file:item.file});
  const resolveEnv=(entry,file)=>{
    if(entry.value!==undefined)return [entry];
    if(!entry.env)return [];
    let dir=dirname(file);
    for(;;){
      const matching=envValues.filter(e=>e.field===entry.env&&dirname(e.file)===dir);
      if(matching.length){
        const unique=[...new Set(matching.map(e=>e.value))];
        if(unique.length!==1){issue('ambiguous-environment',file,entry.line,entry.field);return [];}
        return [{...entry,value:unique[0],basis:'environment-reference',via:{file:matching[0].file,line:matching[0].line}}];
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
      endpoint=endpointIdentity(value);
      if(endpoint?.nonInference){issue('non-inference-endpoint',item.file,line,field);return null;}
      if(endpoint?.placeholder){issue('placeholder-endpoint',item.file,line,field);return null;}
      if(!endpoint){issue('unsupported-endpoint',item.file,line,field);return null;}
      value=endpoint.address;
    }else if(!(kind==='task' ? safeName(value) && value.trim() && !value.includes('://') : modelValue(value))){
      issue(value?.includes('*')?'model-pattern':'unsupported-value',item.file,line,field);return null;
    }
    if(context==='application'&&kind==='model'&&!extra.endpointIds?.length&&!entry.inferenceCall&&!entry.localLibrary)context='unlinked';
    const id=digest([kind,item.file,line,value,context].join('|'));
    const previous=unique.get(id);
    const result={id,kind,value,file:item.file,line,field,basis,context,...(entry.via?{via:entry.via}:{}),...(endpoint?{endpoint}:{}),...(entry.localLibrary?{localLibrary:true}:{}),...extra};
    if(previous){Object.assign(previous,extra);return previous;}
    if(unique.size>=limits.declarations){summary.truncated=true;return null;}
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
  if(summary.truncated)issue('scan-limit');
  const inventory=[],models=[], byService=new Map();
  for(const ref of references.filter(r=>r.kind==='endpoint'&&r.context==='application')) {
    const endpoint=ref.endpoint,name=endpoint.service;
    const item=byService.get(name)||{name,kind:['router','gateway','runtime'].includes(endpoint.serviceType)?endpoint.serviceType:endpoint.serviceType==='unknown'?'unknown':'provider',serviceType:endpoint.serviceType,location:endpoint.location,state:'declared',sourceId:'repository',evidence:[]};
    item.evidence.push({sourceId:'repository',field:ref.field,basis:'repository-declaration',file:ref.file,line:ref.line,referenceId:ref.id,endpointHost:endpoint.host});byService.set(name,item);
  }
  inventory.push(...byService.values());
  const byId=new Map(references.map(r=>[r.id,r]));
  for(const ref of references.filter(r=>r.kind==='model'&&r.context==='application')) {
    if (!ref.endpointIds?.length && references.some(other => other.kind==='model' && other.context==='application' && other.file===ref.file && other.value===ref.value && other.endpointIds?.length)) continue;
    const endpoints=(ref.endpointIds||[]).map(id=>byId.get(id)).filter(r=>r?.context==='application').map(r=>r.endpoint);
    // Multiple alternatives do not establish which service supplies this model.
    const services=[...new Set(endpoints.map(e=>e.service))];
    const provider=services.length===1?services[0]:'Unattributed';
    models.push({id:`declaration:${ref.id}`,name:ref.value,provider,location:'unknown',state:'declared',sourceId:'repository',declarationIds:[ref.id],memoryBytes:null});
  }
  return {references,issues,summary,inventory,models,checkedAt:new Date().toISOString()};
}
