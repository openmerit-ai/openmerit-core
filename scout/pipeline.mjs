import seed from './snapshot.json' with { type: 'json' };
import { refreshSnapshot } from './sources.mjs';
import { refreshBenchmarks } from './benchmarks.mjs';
import { refreshSpecialists } from './specialists.mjs';
import { registry } from './registry.mjs';
import { toRecords, toSnapshot, publicationPredecessor } from './records.mjs';
import { getJSON, putJSON, stageCatalogue, readPublished, publishedRecordsKey, researchKey } from './store.mjs';
import { choice, decode } from './utils.mjs';
import { requestDecisions } from './decisions.mjs';
import { refreshModelMetadata } from './metadata.mjs';
import {structured} from './structured.mjs';
import {embed} from './evidence-search.mjs';
import {catalogueSources,importCatalogueSource,rebuildOfferings,rebuildModels} from './catalogue-db.ts';
import {refreshHubOrgs,crawlHubModels,refreshHubProviders} from './catalogue-hub.ts';
import {discoverMTEB,importMTEB} from './catalogue-mteb.ts';
import {boardSources,importBoards} from './catalogue-boards.ts';
import {loadCatalogue,catalogueRouteSource,decisionGateway} from './catalogue-routes.ts';
import admittedProviders from './catalogue-providers.json' with { type: 'json' };
import {evidenceLedger,migrateGeneration} from './evidence-db.ts';
import {productAnalyticsEnabled,sendProductBatch} from './product-analytics.mjs';

export function retainResearch(next,previous) {
  for(const b of previous.benchmarks.filter(b=>b.source.startsWith('research:')))if(!next.benchmarks.some(x=>x.id===b.id))next.benchmarks.push(b);
  const observed=new Map(previous.models.map(m=>[m.id,m.evidence]));
  for(const old of previous.catalogue??[]) {
    let model=next.catalogue.find(m=>m.id===old.id);
    if(!model&&old.research){model={...old,evidence:[]};next.catalogue.push(model);}
    if(!model)continue;
    if(old.research){model.research=old.research;model.facts=[...(model.facts??[]),...(old.facts??[]).filter(f=>f.runId&&!(model.facts??[]).some(x=>x.field===f.field))];}
    for(const route of old.endpoints??[])if(route.source?.startsWith('research:')&&!model.endpoints.some(e=>e.id===route.id))model.endpoints.push(route);
    const retained=(observed.get(old.id)??[]).filter(e=>e.provenance?.length&&e.raw);
    if(!retained.length)continue;
    let measured=next.models.find(m=>m.id===old.id);
    if(!measured){measured={...model,evidence:[]};next.models.push(measured);}
    for(const e of retained)if(!measured.evidence.some(x=>x.benchmark===e.benchmark))measured.evidence.push(e);
  }
  // Research is no longer collected; its descriptions are kept as retained records
  // that are not refreshed, so they never make the catalogue stale.
  next.sources.push(...previous.sources.filter(s=>s.id.startsWith('research:')&&!next.sources.some(x=>x.id===s.id)).map(({maxAgeHours:_age,...s})=>({...s,refreshPolicy:'retained'})));
  // Core capabilities and operating policy come from the released seed; discovered capabilities persist.
  const prior=previous.registry??registry,discovered=prior.capabilities.filter(c=>!c.core&&!registry.capabilities.some(x=>x.id===c.id));
  next.registry={...prior,capabilities:[...registry.capabilities,...discovered],policy:{...previous.registry?.policy,...registry.policy},questions:registry.questions,operations:registry.operations};next.research=previous.research??[];next.researchState=previous.researchState??{};next.researchPending=previous.researchPending??[];
  for(const b of next.benchmarks){const old=previous.benchmarks.find(x=>x.id===b.id);if(old?.research)b.research=old.research;}
  return next;
}

// Adds reviewed hosted routes from the D1 catalogue to Scout's models. Without
// the catalogue (supply is null), the previous generation's routes are kept, labelled.
export function addCatalogueRoutes(next,previous,supply,error=null) {
  for(const m of next.catalogue)m.endpoints=(m.endpoints??[]).filter(e=>e.source!==catalogueRouteSource);
  const source={id:catalogueRouteSource,name:'OpenMerit catalogue · hosted routes',url:'https://models.dev',publishedAt:null,
    attribution:"Hosted chat routes, token prices and model identities from reviewed inference hosts and model makers' APIs, merged from Models.dev, OpenRouter, Vercel AI Gateway, LiteLLM and genai-prices. Availability on your account is not checked."};
  const decisions={id:decisionGateway.source,name:'Vercel AI Gateway · decision routes',url:decisionGateway.url,publishedAt:null,refreshPolicy:'catalogue-refresh',
    attribution:'Decision models Vercel AI Gateway routes, with their input rates, from the OpenMerit catalogue. One documented typed-question contract covers them all; not a quality measurement.'};
  const others=next.sources.filter(s=>s.id!==catalogueRouteSource&&s.id!==decisions.id);
  if(supply) {
    const routes=supply.routes(next.catalogue,next.checkedAt);
    for(const m of next.catalogue)m.endpoints.push(...(routes.get(m.id)??[]));
    next.contracts=supply.decisionRoutes().map(c=>({...c,checkedAt:next.checkedAt}));
    next.decisionScores=supply.decisionScores();
    next.sources=[...others,{...source,status:'ok',checkedAt:next.checkedAt},{...decisions,status:'ok',checkedAt:next.checkedAt}];
  } else {
    const old=new Map((previous.catalogue??[]).map(m=>[m.id,(m.endpoints??[]).filter(e=>e.source===catalogueRouteSource)]));
    for(const m of next.catalogue)m.endpoints.push(...(old.get(m.id)??[]));
    next.contracts=previous.contracts??[];
    next.decisionScores=previous.decisionScores??{};
    const failed=s=>({status:'failed',checkedAt:previous.sources?.find(p=>p.id===s.id)?.checkedAt??null,attemptedAt:next.checkedAt,error:String(error?.message??error??'Catalogue unavailable.').slice(0,200)});
    next.sources=[...others,{...source,...failed(source)},{...decisions,...failed(decisions)}];
  }
  return next;
}

// Moves the published generation's embedded research and capability answers
// into the evidence ledger and rewrites its records without them, once.
export async function migratePublished(bucket,db) {
  const key=await publishedRecordsKey(bucket);
  return key?migrateGeneration(db,await evidenceLedger(db),key,{
    load:async()=>{const records=await getJSON(bucket,key);return {records,research:records.research??await getJSON(bucket,researchKey(key))??[]};},
    save:records=>putJSON(bucket,key,records)}):{skipped:true};
}

// One PostHog event per refresh run, so operators can alert on it: whether it published, and every public
// feed or catalogue import that failed. A failed feed never fails the run (the last good data is kept),
// so a run can publish while degraded. Errors are the sources' own short messages; no catalogue content.
/** @param {string} id @param {{status:'published'|'failed',version?:string|null,feeds?:Array<{id:string,status:string,error?:string,checkedAt?:string}>,imports?:Array<{source:string,status:string,error?:string|null}>,error?:string|null}} outcome @param {string} environment */
export async function refreshEvent(id,{status,version=null,feeds=[],imports=[],error=null},environment) {
  const short=value=>String(value??'').slice(0,200);
  const failed=[...feeds.filter(s=>s.status==='failed').map(s=>({id:s.id,kind:'feed',error:short(s.error),lastSuccessAt:s.checkedAt??null})),
    ...imports.map(r=>({id:r.source,kind:'catalogue',error:short(r.error??(r.status==='running'?'Import did not finish.':'')),lastSuccessAt:null}))]
    .sort((a,b)=>a.id.localeCompare(b.id));
  // Retried steps resend the same UUID, which PostHog deduplicates.
  const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`scout-refresh:${id}:${status}`)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {event:'scout_refresh_completed',distinct_id:'scout-publisher',uuid:`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`,timestamp:new Date().toISOString(),
    properties:{$process_person_profile:false,product:'scout',environment,run_id:id,status,version,...(error?{error:short(error)}:{}),
      failed_count:failed.length,failed_source_ids:failed.map(f=>f.id).join(','),failed_sources:failed}};
}
async function reportRun(env,step,id,outcome) {
  if(!productAnalyticsEnabled(env))return;
  // Reporting never changes the run's outcome.
  try{await step.do(`report-${outcome.status}`,{retries:{limit:2,delay:'10 seconds'},timeout:'2 minutes'},async()=>{
    const imports=env.SCOUT_INDEX?(await env.SCOUT_INDEX.prepare("SELECT source,status,error FROM cat_runs WHERE id LIKE ?1 AND status!='ok'").bind(`${id}-%`).all()).results:[];
    const feeds=(await getJSON(env.SCOUT_CATALOGUE,`runs/${id}/sources.json`))??[];
    await sendProductBatch(env,[await refreshEvent(id,{...outcome,feeds,imports},env.POSTHOG_ENVIRONMENT)]);
    return {reported:true};
  });}catch{}
}

export async function runRefresh(env,step,id) {
  const bucket=env.SCOUT_CATALOGUE,coordinator=env.SCOUT_CONTROL.getByName('publication');
  const lock=await step.do('claim-refresh',()=>coordinator.begin(id));
  if(!lock.acquired)return {status:'already-running'};
  const options={apiKey:env.OPENAI_API_KEY,cache:{get:key=>getJSON(bucket,key),put:(key,value)=>putJSON(bucket,key,value)}};
  try {
    // The D1 model catalogue is independent of the serving snapshot. Each source
    // records its own run; a failure there never blocks the rest of the refresh.
    if(env.SCOUT_INDEX){
      const hubOptions={token:env.HF_TOKEN,run:`${id}-huggingface`},steps={
        ...Object.fromEntries(Object.keys(catalogueSources).map(source=>[source,()=>importCatalogueSource(env.SCOUT_INDEX,source,{bucket,run:`${id}-${source}`})])),
        // The Hub crawl needs HF_TOKEN; it covers part of the organisations per run.
        ...(env.HF_TOKEN?{'hub-orgs':()=>refreshHubOrgs(env.SCOUT_INDEX,hubOptions),'hub-models':()=>crawlHubModels(env.SCOUT_INDEX,hubOptions)}:{})};
      for(const [name,run] of Object.entries(steps))
        try{await step.do(`catalogue-${name}`,{retries:{limit:1,delay:'30 seconds'},timeout:'10 minutes'},run);}catch{}
      // Separate bounded steps release each page/batch before the next. Durable
      // cursors also resume across refreshes when this workflow's budget ends.
      if(env.HF_TOKEN)for(let chunk=0;chunk<128;chunk++){
        try{
          const progress=await step.do(`catalogue-hub-providers-${chunk}`,{retries:{limit:1,delay:'30 seconds'},timeout:'10 minutes'},
            ()=>refreshHubProviders(env.SCOUT_INDEX,{token:env.HF_TOKEN,run:`${id}-huggingface-providers`,applyBatches:20}));
          if(progress.complete||progress.error||progress.rateLimited)break;
        }catch{break;}
      }
      // A timed-out step keeps running beside its retry; the long timeout keeps a slow D1 from starting one.
      for(const [name,rebuild] of [['offerings',rebuildOfferings],['models',rebuildModels]])
        try{await step.do(`catalogue-${name}`,{retries:{limit:1,delay:'30 seconds'},timeout:'30 minutes'},()=>rebuild(env.SCOUT_INDEX));}catch{}
      // One compact final-results response per step; never hold every MTEB
      // leaderboard in memory or download its benchmark datasets/results dump.
      let mteb=[];
      try{mteb=await step.do('catalogue-mteb-directory',{retries:{limit:1,delay:'30 seconds'},timeout:'2 minutes'},()=>discoverMTEB());}catch{}
      for(const benchmark of mteb)
        try{await step.do(`catalogue-mteb-${benchmark.name}`,{retries:{limit:1,delay:'30 seconds'},timeout:'2 minutes'},()=>importMTEB(env.SCOUT_INDEX,benchmark,{bucket,run:`${id}-mteb-${benchmark.name}`}));}catch{}
      // Media leaderboards, one page or parquet per step, after models are rebuilt so links use this run's catalogue.
      for(const source of boardSources)
        try{await step.do(`catalogue-${source.id.replace(':','-')}`,{retries:{limit:1,delay:'30 seconds'},timeout:'2 minutes'},()=>importBoards(env.SCOUT_INDEX,source,{bucket,run:`${id}-${source.id}`}));}catch{}
    }
    await step.do('check-semantic-service',{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},async()=>{
      const questions=[choice('ready','Is this an availability check?',{yes:'Availability check.',no:'Another request.'})];
      decode(questions,(await requestDecisions('Scout hourly semantic-service availability check.',questions,options)).answers);
      if(env.SCOUT_INDEX&&env.SCOUT_EVIDENCE)await Promise.all([
        structured('Availability check.',{type:'object',properties:{available:{type:'boolean'}},required:['available'],additionalProperties:false},{...options,name:'scout_availability',instructions:'Return available=true.',timeoutMs:10000,maxOutputTokens:30}),
        embed(['Availability check.'],{...options,timeoutMs:10000}),
      ]);
      return {available:true};
    });
    // Research inspections and capability interpretations live in the D1
    // evidence ledger. Generations published before it embed both; move them once.
    if(!env.SCOUT_INDEX)throw new Error('The evidence ledger needs the SCOUT_INDEX D1 binding.');
    const ledger=()=>evidenceLedger(env.SCOUT_INDEX);
    await step.do('migrate-evidence-ledger',{retries:{limit:2,delay:'10 seconds'},timeout:'10 minutes'},()=>migratePublished(bucket,env.SCOUT_INDEX));
    const baseKey=await step.do('collect-public-feeds',{retries:{limit:2,delay:'10 seconds'},timeout:'5 minutes'},async()=>{
      // Collection never reads research; the steps that do load it themselves.
      const published=await readPublished(bucket),previous=published?toSnapshot(published.records):seed;
      // One read of the D1 catalogue supplies both catalogue models and hosted routes.
      let supply=null,supplyError=null;
      if(env.SCOUT_INDEX)try{supply=await loadCatalogue(env.SCOUT_INDEX,admittedProviders.providers);}catch(error){supplyError=error;}
      let next=await refreshSnapshot(fetch,previous,{collectOnly:true,catalogueSupply:supply});
      // Preserve research-owned records while independently refreshing known feeds.
      next=retainResearch(next,previous);
      if(env.SCOUT_INDEX)next=addCatalogueRoutes(next,previous,supply,supplyError);
      // Later steps re-read the unchanged published generation instead of a copy here.
      const key=`runs/${id}/collected.json`;await putJSON(bucket,key,{next});
      // Written at collection, so the run report lists failed feeds even if a later step fails.
      await putJSON(bucket,`runs/${id}/sources.json`,next.sources.map(({id,status,error,checkedAt})=>({id,status,error,checkedAt})));return key;
    });
    const candidateKey=await step.do('interpret-evidence',{retries:{limit:1,delay:'15 seconds'},timeout:'15 minutes'},async()=>{
      // The refresh lock keeps the published generation unchanged until this run publishes.
      // Parse it first, before this run's snapshot. Research and capability
      // answers are read from the ledger per subject, never as a whole.
      const published=await readPublished(bucket),previous=published?toSnapshot(published.records):seed,{interpretations}=await ledger();
      let {next}=await getJSON(bucket,baseKey);
      let candidate=await refreshModelMetadata(next,previous,options);next=null;
      candidate.availableModels=candidate.catalogue.length;candidate.researchPending=[];
      candidate=await refreshBenchmarks(candidate,previous,{...options,registry:candidate.registry,interpretations});
      candidate=await refreshSpecialists(candidate,previous,options);
      const {research:_ledgered,...records}=toRecords(candidate),key=`runs/${id}/candidate.json`;
      await putJSON(bucket,key,{records,previous:publicationPredecessor(previous)});return key;
    });
    const staged=await step.do('validate-and-stage',{retries:{limit:12,delay:'10 seconds',backoff:'constant'},timeout:'10 minutes'},async()=>{
      const {records,previous}=await getJSON(bucket,candidateKey);return stageCatalogue(bucket,records,previous,{...options,db:env.SCOUT_INDEX,vectorize:env.SCOUT_EVIDENCE});
    });
    await step.do('publish',()=>coordinator.publish(id,staged));
    await reportRun(env,step,id,{status:'published',version:staged.publication.id});
    return {status:'published',version:staged.publication.id};
  } catch(error) {
    await step.do('record-failure',()=>coordinator.fail(id,'Refresh did not finish; serving the last committed catalogue.'));
    await reportRun(env,step,id,{status:'failed',error:error?.message});
    throw error;
  }
}
