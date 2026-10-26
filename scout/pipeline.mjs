import seed from './snapshot.json' with { type: 'json' };
import { refreshSnapshot } from './sources.mjs';
import { refreshBenchmarks } from './benchmarks.mjs';
import { refreshSpecialists } from './specialists.mjs';
import { registry } from './registry.mjs';
import { ParallelResearch, planResearch } from './research.mjs';
import { integrateResearch } from './enrich.mjs';
import { toRecords, toSnapshot, publicationPredecessor } from './records.mjs';
import { getJSON, putJSON, stageCatalogue, readPublished, publishedRecordsKey, researchKey } from './store.mjs';
import { digest, concurrent, choice, decode } from './utils.mjs';
import { requestDecisions } from './decisions.mjs';
import { refreshModelMetadata } from './metadata.mjs';
import {structured} from './structured.mjs';
import {embed} from './evidence-search.mjs';
import {discoverInventory,archiveListings,discoveryBacklog} from './discovery.mjs';
import {catalogueInventory} from './catalogue.mjs';
import {catalogueSources,importCatalogueSource,rebuildOfferings} from './catalogue-db.ts';
import {refreshHubOrgs,crawlHubModels} from './catalogue-hub.ts';
import {catalogueRoutes,catalogueRouteSource} from './catalogue-routes.ts';
import admittedProviders from './catalogue-providers.json' with { type: 'json' };
import {evidenceLedger,migrateGeneration} from './evidence-db.ts';

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
  next.sources.push(...previous.sources.filter(s=>s.id.startsWith('research:')&&!next.sources.some(x=>x.id===s.id)).map(s=>({...s,maxAgeHours:(previous.registry??registry).policy.maxResearchAgeHours})));
  // Core capabilities and operating policy come from the released seed; discovered capabilities persist.
  const prior=previous.registry??registry,discovered=prior.capabilities.filter(c=>!c.core&&!registry.capabilities.some(x=>x.id===c.id));
  next.registry={...prior,capabilities:[...registry.capabilities,...discovered],policy:{...previous.registry?.policy,...registry.policy},questions:registry.questions,operations:registry.operations};next.research=previous.research??[];next.researchState=previous.researchState??{};next.researchPending=previous.researchPending??[];
  for(const b of next.benchmarks){const old=previous.benchmarks.find(x=>x.id===b.id);if(old?.research)b.research=old.research;}
  return next;
}

// Adds reviewed hosted routes from the D1 catalogue to Scout's models. If the
// catalogue cannot be read, the previous generation's routes are kept, labelled.
export async function addCatalogueRoutes(next,previous,db,admitted=admittedProviders.providers) {
  for(const m of next.catalogue)m.endpoints=(m.endpoints??[]).filter(e=>e.source!==catalogueRouteSource);
  const source={id:catalogueRouteSource,name:'OpenMerit catalogue · hosted routes',url:'https://models.dev',publishedAt:null,
    attribution:"Hosted chat routes and token prices from reviewed inference hosts and model makers' APIs, merged from Models.dev, LiteLLM, OpenRouter, Vercel AI Gateway and genai-prices. Availability on your account is not checked."};
  try {
    const routes=await catalogueRoutes(db,next.catalogue,admitted,next.checkedAt);
    for(const m of next.catalogue)m.endpoints.push(...(routes.get(m.id)??[]));
    next.sources=[...next.sources.filter(s=>s.id!==catalogueRouteSource),{...source,status:'ok',checkedAt:next.checkedAt}];
  } catch(error) {
    const old=new Map((previous.catalogue??[]).map(m=>[m.id,(m.endpoints??[]).filter(e=>e.source===catalogueRouteSource)]));
    for(const m of next.catalogue)m.endpoints.push(...(old.get(m.id)??[]));
    const prior=previous.sources?.find(s=>s.id===catalogueRouteSource);
    next.sources=[...next.sources.filter(s=>s.id!==catalogueRouteSource),{...source,status:'failed',checkedAt:prior?.checkedAt??null,attemptedAt:next.checkedAt,error:String(error?.message??error).slice(0,200)}];
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
        ...(env.HF_TOKEN?{'hub-orgs':()=>refreshHubOrgs(env.SCOUT_INDEX,hubOptions),'hub-models':()=>crawlHubModels(env.SCOUT_INDEX,hubOptions)}:{}),
        offerings:()=>rebuildOfferings(env.SCOUT_INDEX)};
      for(const [name,run] of Object.entries(steps))
        try{await step.do(`catalogue-${name}`,{retries:{limit:1,delay:'30 seconds'},timeout:'10 minutes'},run);}catch{}
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
      let next=await refreshSnapshot(fetch,previous,{collectOnly:true});
      // Preserve research-owned records while independently refreshing known feeds.
      next=retainResearch(next,previous);
      if(env.SCOUT_INDEX&&env.SCOUT_EVIDENCE){
        // The collection step already captured reported metadata independently
        // of protocol adapters. Preserve listings without inventing endpoints.
        const extra=await catalogueInventory(next.providerMetadata??[],next.catalogue,next.checkedAt);
        await archiveListings(env.SCOUT_INDEX,extra,next.checkedAt);
        next=await discoverInventory(next,previous,{archiveDb:env.SCOUT_INDEX,pages:next.registry.policy.discoveryPagesPerHour??2});
      }
      if(env.SCOUT_INDEX)next=await addCatalogueRoutes(next,previous,env.SCOUT_INDEX);
      // Later steps re-read the unchanged published generation instead of a copy here.
      const key=`runs/${id}/collected.json`;await putJSON(bucket,key,{next});return key;
    });
    const jobs=await step.do('plan-research',async()=>{
      const {next}=await getJSON(bucket,baseKey);
      const backlog=await getJSON(bucket,'research-backlog.json')??[];
      next.researchPending=[...new Map([...(next.researchPending??[]),...backlog].map(p=>[p.job.id,p])).values()];
      const prior=Object.entries(next.researchState).map(([subjectId,v])=>({subjectId,...v}));
      const limit=Number(env.RESEARCH_PER_HOUR??next.registry.policy.researchPerHour);
      const discoveryCandidates=env.SCOUT_INDEX?await discoveryBacklog(env.SCOUT_INDEX,{limit,maxAgeHours:next.registry.policy.maxResearchAgeHours}):[];
      return planResearch(next,prior,{limit,maxAgeHours:next.registry.policy.maxResearchAgeHours,discoveryCandidates,providers:await (await ledger()).research.providers()});
    });
    await step.do('persist-research-plan',async()=>{
      const prior=await getJSON(bucket,'research-backlog.json')??[];
      const planned=await Promise.all(jobs.map(async job=>({job,key:`research-jobs/${await digest([job.id,job.subjectHash,job.epoch])}.json`})));
      await putJSON(bucket,'research-backlog.json',[...new Map([...prior,...planned].map(p=>[p.key,p])).values()]);
    });
    const client=new ParallelResearch({apiKey:env.PARALLEL_API_KEY,processor:registry.policy.researchProcessor});
    const results=await concurrent(jobs,registry.policy.refreshConcurrency,async(job,j)=>{
      const jobKey=`research-jobs/${await digest([job.id,job.subjectHash,job.epoch])}.json`;
      const run=await step.do(`research-start-${j}`,{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},async()=>{
        const prior=await getJSON(bucket,jobKey);if(prior)return prior;
        await putJSON(bucket,jobKey,{status:'uncertain',subjectId:job.id,subjectHash:job.subjectHash,startedAt:new Date().toISOString()});
        try{const runId=await client.start(job);const receipt={status:'pending',runId,subjectId:job.id,subjectHash:job.subjectHash};await putJSON(bucket,jobKey,receipt);return receipt;}
        catch(error){const receipt={status:'unavailable',subjectId:job.id,error:error.message};await putJSON(bucket,jobKey,receipt);return receipt;}
      });
      if(!run.runId)return {subjectId:job.id,status:run.status};
      if(run.status==='completed')return {key:jobKey,status:'completed',subjectId:job.id};
      for(let poll=0;poll<20;poll++) {
        const status=await step.do(`research-poll-${j}-${poll}`,{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
          try{const result=await client.poll(run.runId);if(result.status==='completed'){await putJSON(bucket,jobKey,{...result,subjectId:job.id,subjectHash:job.subjectHash,checkedAt:new Date().toISOString()});return 'completed';}return 'pending';}catch(error){await putJSON(bucket,`runs/${id}/research-error-${j}.json`,{error:error.message});return 'unavailable';}
        });
        if(status==='completed')return {key:jobKey,status,subjectId:job.id};
        if(status==='unavailable')return {key:jobKey,status,subjectId:job.id};
        await step.sleep(`research-wait-${j}-${poll}`,'20 seconds');
      }
      return {key:jobKey,status:'pending',subjectId:job.id};
    });
    const candidateKey=await step.do('interpret-evidence',{retries:{limit:1,delay:'15 seconds'},timeout:'15 minutes'},async()=>{
      // The refresh lock keeps the published generation unchanged until this run publishes.
      // Parse it first, before this run's snapshot. Research and capability
      // answers are read from the ledger per subject, never as a whole.
      const published=await readPublished(bucket),previous=published?toSnapshot(published.records):seed,{research,interpretations}=await ledger();
      let {next}=await getJSON(bucket,baseKey);
      const batches=await Promise.all(results.filter(r=>r.status==='completed').map(r=>getJSON(bucket,r.key)));
      let candidate=await integrateResearch(await refreshModelMetadata(next,previous,options),batches,{...options,research});next=null;
      candidate.researchPending=(await Promise.all(results.filter(r=>r.key&&r.status!=='completed').map(async r=>{
        const receipt=await getJSON(bucket,r.key);return receipt?.runId?{job:jobs.find(j=>j.id===r.subjectId),key:r.key}:null;
      }))).filter(Boolean);
      for(const batch of batches)candidate.researchState[batch.subjectId]={subjectHash:batch.subjectHash,checkedAt:batch.checkedAt,status:'completed'};
      candidate=await refreshBenchmarks(candidate,previous,{...options,registry:candidate.registry,interpretations});
      candidate=await refreshSpecialists(candidate,previous,options);
      candidate.sources.push({id:'parallel',name:'Parallel research',url:'https://parallel.ai',status:results.some(r=>r.status!=='completed')?'failed':'ok',checkedAt:new Date().toISOString(),publishedAt:null,attribution:'Hourly incremental public-source research. Original publishers retain attribution. Pending jobs do not overwrite validated records.'});
      candidate.refreshSummary={jobs:results.length,completed:results.filter(r=>r.status==='completed').length,pending:results.filter(r=>r.status!=='completed').length};
      const {research:_ledgered,...records}=toRecords(candidate),key=`runs/${id}/candidate.json`;
      await putJSON(bucket,key,{records,previous:publicationPredecessor(previous)});return key;
    });
    const staged=await step.do('validate-and-stage',{retries:{limit:12,delay:'10 seconds',backoff:'constant'},timeout:'10 minutes'},async()=>{
      const {records,previous}=await getJSON(bucket,candidateKey);return {...await stageCatalogue(bucket,records,previous,{...options,db:env.SCOUT_INDEX,vectorize:env.SCOUT_EVIDENCE}),completedResearchSubjects:results.filter(r=>r.status==='completed').map(r=>r.subjectId),completedResearchKeys:results.filter(r=>r.status==='completed').map(r=>r.key)};
    });
    await step.do('publish',()=>coordinator.publish(id,staged));
    return {status:'published',version:staged.publication.id,research:results.map(r=>({subject:r.subjectId,status:r.status}))};
  } catch(error) {await step.do('record-failure',()=>coordinator.fail(id,'Refresh did not finish; serving the last committed catalogue.'));throw error;}
}
