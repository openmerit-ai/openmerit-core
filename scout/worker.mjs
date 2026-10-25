import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { handleAPI, json, isRetiredAgentPath } from './http.mjs';
import { handleMCP } from './mcp.mjs';
import { handleConnect } from './connect.mjs';
import { createRecommender } from './recommend.mjs';
import { createSnapshotReader, getJSON, putJSON } from './store.mjs';
import { runRefresh } from './pipeline.mjs';
import { ParallelResearch } from './research.mjs';
import { indexStatus } from './rank.mjs';
import { scoutAccess, sessionUser } from './auth.mjs';
import { createProductAnalytics } from './product-analytics.mjs';
import { handleClerkWebhook } from './account-analytics.mjs';
import { publicSiteResponse } from './public-site.mjs';

// Publication coordination only. User searches do not pass through this object.
export class ScoutPublication extends DurableObject {
  async begin(id) {
    return this.ctx.blockConcurrencyWhile(async()=>{
    const active=await this.ctx.storage.get('run');
    if(active&&active.id!==id&&Date.now()-active.startedAt<55*60_000)return {acquired:false};
    if(active?.id!==id)await this.ctx.storage.put('run',{id,startedAt:Date.now()});
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'running',scheduler:'cloudflare-hourly',lastAttemptAt:new Date().toISOString()});return {acquired:true};
    });
  }
  async publish(id,staged) {
    return this.ctx.blockConcurrencyWhile(async()=>{
    // The receipt is written after every side effect, before releasing the lease.
    // A lost reply can be acknowledged even after a later refresh has started.
    const receiptKey=`publications/${staged.publication.id}.json`;
    const receipt=await getJSON(this.env.SCOUT_CATALOGUE,receiptKey);
    if(receipt?.runId===id) {
      if((await this.ctx.storage.get('run'))?.id===id)await this.ctx.storage.delete('run');
      return {published:receipt.publicationId};
    }
    const run=await this.ctx.storage.get('run');if(run?.id!==id)throw new Error('Refresh lease expired.');
    const current=await getJSON(this.env.SCOUT_CATALOGUE,'active.json');
    if((current?.publication.id??null)!==staged.previousVersion&&current?.publication.id!==staged.publication.id)throw new Error('Newer catalogue already published.');
    if(current&&current.publication.id!==staged.publication.id)await putJSON(this.env.SCOUT_CATALOGUE,'previous.json',current);
    if(current?.publication.id!==staged.publication.id)await putJSON(this.env.SCOUT_CATALOGUE,'active.json',{...staged,runId:id,publishedAt:new Date().toISOString()});
    const completed=new Set(staged.completedResearchKeys??[]),backlog=await getJSON(this.env.SCOUT_CATALOGUE,'research-backlog.json')??[];
    await putJSON(this.env.SCOUT_CATALOGUE,'research-backlog.json',backlog.filter(p=>!completed.has(p.key)));
    if(this.env.SCOUT_INDEX&&staged.completedResearchSubjects?.length)await this.env.SCOUT_INDEX.prepare('UPDATE scout_discovery SET researched_at=? WHERE id IN (SELECT value FROM json_each(?))').bind(new Date().toISOString(),JSON.stringify(staged.completedResearchSubjects)).run();
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'idle',scheduler:'cloudflare-hourly',lastAttemptAt:new Date().toISOString(),snapshotVersion:staged.publication.id});
    await putJSON(this.env.SCOUT_CATALOGUE,receiptKey,{runId:id,publicationId:staged.publication.id});
    await this.ctx.storage.delete('run');return {published:staged.publication.id};
    });
  }
  async fail(id,message) {
    return this.ctx.blockConcurrencyWhile(async()=>{
    const run=await this.ctx.storage.get('run');if(run?.id!==id)return;
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'failed',scheduler:'cloudflare-hourly',lastAttemptAt:new Date().toISOString(),refreshError:message});
    await this.ctx.storage.delete('run');
    });
  }
}
export class ScoutRefresh extends WorkflowEntrypoint {
  async run(event,step) {
    // Administrative, read-only credential check through Cloudflare's workflow
    // control plane. This is never exposed as a public HTTP route.
    if(event.payload?.probeRunId)return step.do('check-research-access',async()=>{
      try{return {status:(await new ParallelResearch({apiKey:this.env.PARALLEL_API_KEY}).poll(event.payload.probeRunId)).status};}
      catch(error){return {status:'unavailable',error:error.message,configured:!!this.env.PARALLEL_API_KEY};}
    });
    return runRefresh(this.env,step,event.instanceId);
  }
}

let reader,recommend;
function services(env) {
  if(!reader){reader=createSnapshotReader(env.SCOUT_CATALOGUE);recommend=createRecommender({apiKey:env.OPENAI_API_KEY,db:env.SCOUT_INDEX,vectorize:env.SCOUT_EVIDENCE});}
  return {reader,recommend};
}
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname;
    if(isRetiredAgentPath(path))return json({error:'Not found.'},404);
    const unavailable=publicSiteResponse(request);
    if(unavailable)return unavailable;
    if(path==='/scout')return Response.redirect(`${url.origin}/scout/${url.search}`,308);
    if(path==='/connect')return Response.redirect(`${url.origin}/connect/${url.search}`,308);
    // Product-level device sign-in for coding agents. The page is a static asset.
    if(path.startsWith('/connect/api/')) {
      const analytics=createProductAnalytics(request,env,ctx);
      const response=await handleConnect(request,env,{session:request=>sessionUser(request,env),analytics});
      return analytics.response(response);
    }
    // This endpoint authenticates Clerk's signature, never a browser session.
    if(path==='/scout/api/webhooks/clerk')return handleClerkWebhook(request,env);
    if(!path.startsWith('/scout/api/')&&path!=='/scout/mcp') {
      return ['GET','HEAD'].includes(request.method)?env.ASSETS.fetch(request):json({error:'Not found.'},404);
    }
    const analytics=createProductAnalytics(request,env,ctx);
    const access=await scoutAccess(request,env,analytics.identify);
    if(access){await analytics.complete(access);return analytics.response(access);}
    if(path==='/scout/api/analytics')return analytics.handleEvent();
    if(path==='/scout/api/analytics/preference')return analytics.handlePreference();
    let response;
    try {
      const {reader,recommend}=services(env),index=await reader.view();
      if(path==='/scout/api/status') {
        if(request.method!=='GET')return json({error:'Use GET.'},405);
        const status=indexStatus(index);
        const health=await getJSON(env.SCOUT_CATALOGUE,'health.json').catch(()=>null);
        return json({...status,scheduler:'cloudflare-hourly',refreshStatus:status.degraded?'degraded':'idle',...health,snapshotVersion:index.snapshot.publication.id,refreshSummary:index.snapshot.refreshSummary});
      }
      const mcp=path==='/scout/mcp';
      response=await (mcp?handleMCP:handleAPI)(request,index,{},(...args)=>recommend(...args,mcp?'mcp':'api',analytics.observeSearch),analytics.observeMCP);
    } catch (error) {analytics.exception(error);response=json({error:'Scout could not load its prepared catalogue. Please try again shortly.'},503);}
    await analytics.complete(response);return analytics.response(response);
  },
  async scheduled(event,env,ctx) {
    const id=`hour-${Math.floor(event.scheduledTime/3600_000)}`;
    ctx.waitUntil(env.SCOUT_REFRESH.create({id,params:{}}));
  },
};
