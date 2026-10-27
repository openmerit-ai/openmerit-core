import { classifyPrompt, validatePrompt } from './decisions.mjs';
import { recommend } from './rank.mjs';
import { validateSelection } from './selection.mjs';
import { matchSpecialists, specialistVersion, relevantProfiles } from './specialists.mjs';
import { narrowIndex } from './search-index.mjs';
import { registry as seed } from './registry.mjs';
import { prepareEligibility, matchEligibility, eligibilityWarnings } from './eligibility.mjs';
import { matchTask } from './matching.mjs';
import {createResultCache} from './result-cache.mjs';
import {interpreterVersion} from './interpreter.mjs';
import {matchingTimeoutMs,createTimings} from './timing.mjs';
import {diagnosticTransport} from './utils.mjs';
import {d1Answers} from './answer-cache.ts';

// HTTP search computation; bounded admission without visitor accounts or queues.
export function createRecommender({ apiKey, fetcher = fetch, now = Date.now, timeoutMs = matchingTimeoutMs, db, vectorize, observe = () => {},cacheOptions,answers = db ? d1Answers(db) : undefined } = {}) {
  let inFlight = 0, windowStart = now(), requests = 0;
  const cached=createResultCache({now,...cacheOptions});
  return async (index, prompt, selection, endpoints, channel = 'api', observeRequest = () => {}) => {
    const submittedPrompt = prompt;
    prompt = validatePrompt(prompt);
    const modelIds = validateSelection(selection), endpointIds = validateSelection(endpoints, 'endpointIds');
    const started = now();
    const deadline = performance.now() + timeoutMs;
    const scope = modelIds !== null && endpointIds !== null ? 'intersection' : modelIds !== null ? 'models' : endpointIds !== null ? 'endpoints' : 'all';
    let admitted = false, task, result, diagnostics, failure, legacyTrace, legacyCause, outcome = 'internal_error';
    const generations=[];
    try {
      if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
      if (inFlight >= 32 || requests >= 600) {
        outcome = 'rate_limited';
        const error = new Error('Scout is busy. Please try again shortly.'); error.status = 429; throw error;
      }
      requests++; inFlight++; admitted = true;
      if(index.snapshot.servingEngine==='evidence') {
        let ownsComputation=false;
        try {
          const key=JSON.stringify([index.snapshot.publication.id,interpreterVersion,prompt,modelIds,endpointIds,new Date(started).toISOString().slice(0,10)]);
          const entry=await cached(key,()=>{ownsComputation=true;return matchTask(index,prompt,modelIds,endpointIds,{apiKey,fetcher,now,timeoutMs,db,vectorize,answers});});
          result=entry.value;result.runtime={...(entry.status==='miss'?result.runtime:{}),cache:entry.status,ageMs:entry.ageMs};
          result.elapsedMs=Math.max(0,now()-started);if(entry.status!=='miss')result.interpretationMs=0;
          task=result.task;const slots=result.tasks.flatMap(t=>t.slots);
          for(const slot of slots){
            slot.runtime={...(entry.status==='miss'?slot.runtime:{}),cache:entry.status,ageMs:entry.ageMs};
            if(entry.status!=='miss')slot.interpretationMs=0;
          }
          outcome=task.unsupported?'unsupported':slots.some(s=>s.task.clarification)?'clarification':slots.some(s=>s.recommendations.length)?'ok':'empty';return result;
        }
        catch(cause){diagnostics=cause.diagnostics?structuredClone({...cause.diagnostics,generations:ownsComputation?cause.diagnostics.generations:[],spans:ownsComputation?cause.diagnostics.spans:[]}):undefined;outcome='interpretation_error';if(cause.status===422)throw cause;const error=new Error('Scout could not establish this recommendation right now. Please try again.');error.status=503;error.cause=cause;throw error;}
      }
      legacyTrace=createTimings();
      const legacyFetcher=diagnosticTransport(fetcher,generations);
      let interpreted;
      try { interpreted = await legacyTrace.measure('interpretation',()=>classifyPrompt(prompt, { apiKey, fetcher:legacyFetcher, timeoutMs, registry: index.snapshot.registry ?? seed, interpretSelection:!!index.snapshot.eligibilityKey||index.snapshot.selectionMetadataVersion==='1',selectionVocabulary:index.snapshot.selectionVocabulary??{} })); }
      catch (cause) { legacyCause=cause;outcome = 'interpretation_error'; const error = new Error('Scout could not interpret this task right now. Please try again.'); error.status = 503;error.cause=cause; throw error; }
      task = interpreted.task;
      if(task.selection.required.length&&!task.unsupported&&!task.clarification) {
        try {
          const directory=index.loadEligibility?await index.loadEligibility():prepareEligibility(index.snapshot);
          const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw new Error('Selection deadline exceeded.');
          task.selection=await legacyTrace.measure('eligibility',()=>matchEligibility(prompt,task.selection,directory,{apiKey,fetcher:legacyFetcher,timeoutMs:remaining,modelIds,endpointIds,now:now()}));
        }catch (cause) {legacyCause=cause;outcome='selection_error';const error=new Error('Scout could not verify the model-selection restrictions right now. Please try again.');error.status=503;error.cause=cause;throw error;}
      }
      index = index.loadTask ? await index.loadTask(task, modelIds, endpointIds) : narrowIndex(index, task, modelIds, endpointIds);
      // Explicit legacy model inventories cannot grant access to a Hub route.
      const profiles = modelIds !== null ? [] : relevantProfiles(index.snapshot.specialistProfiles ?? [], task).filter(p=>!task.selection.required.length||p.repositories.some(id=>task.selection.allowedRepositories.includes(id))).slice(0,(index.snapshot.registry ?? seed).policy.profileLimit).filter(p => endpointIds === null || p.repositories.some(id => {
        const m = index.snapshot.specialists.find(m => m.id === id);
        return endpointIds.includes(`huggingface:local:${id}:${m.revision}`);
      }));
      try {
        const remaining = Math.floor(deadline-performance.now());
        if(profiles.length && remaining<=0)throw new Error('Specialist comparison deadline exceeded.');
        task.specialistMatch = await legacyTrace.measure('specialistCheck',()=>matchSpecialists(prompt, task, profiles, { apiKey, fetcher:legacyFetcher, timeoutMs: Math.max(1,remaining) }));
      }
      catch { task.specialistMatch = { version: specialistVersion, status: 'unavailable', matches: [] }; }
      result = { ...recommend(index, prompt, now(), task, undefined, modelIds, endpointIds), interpretationMs: interpreted.elapsedMs, retrieval: index.retrieval, snapshotVersion: index.snapshot.publication?.id };
      result.warnings.push(...eligibilityWarnings(task));
      outcome = task.unsupported ? 'unsupported' : task.clarification ? 'clarification' : result.recommendations.length ? 'ok' : 'empty';
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (admitted) inFlight--;
      if(legacyTrace){diagnostics={...legacyTrace.snapshot(legacyCause??failure),generations:structuredClone(generations)};if(result)result.runtime=diagnostics;}
      for (const observer of [observe, observeRequest]) {
        try { observer({ prompt: submittedPrompt, index, result, task, outcome, channel, scope, durationMs: now() - started,diagnostics:diagnostics??result?.runtime,error:failure }); }
        catch { /* Independent best-effort observers cannot change task results. */ }
      }
    }
  };
}
