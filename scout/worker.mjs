import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { json, isRetiredAgentPath } from './http.mjs';
import { handleMCP } from './mcp.mjs';
import { handleConnect } from './connect.mjs';
import { createSnapshotReader, getJSON, putJSON } from './store.mjs';
import { runRefresh } from './pipeline.mjs';
import { indexStatus } from './rank.mjs';
import { scoutAccess, sessionUser } from './auth.mjs';
import { createProductAnalytics } from './product-analytics.mjs';
import { handleClerkWebhook } from './account-analytics.mjs';
import { publicSiteResponse } from './public-site.mjs';
import { agentPath, handleAgent } from './agent/routes.ts';

// Publication coordination only. User searches do not pass through this object.
export class ScoutPublication extends DurableObject {
  async begin(id) {
    return this.ctx.blockConcurrencyWhile(async()=>{
    const active=await this.ctx.storage.get('run');
    if(active&&active.id!==id&&Date.now()-active.startedAt<55*60_000)return {acquired:false};
    if(active?.id!==id)await this.ctx.storage.put('run',{id,startedAt:Date.now()});
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'running',scheduler:'cloudflare-twice-daily',lastAttemptAt:new Date().toISOString()});return {acquired:true};
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
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'idle',scheduler:'cloudflare-twice-daily',lastAttemptAt:new Date().toISOString(),snapshotVersion:staged.publication.id});
    await putJSON(this.env.SCOUT_CATALOGUE,receiptKey,{runId:id,publicationId:staged.publication.id});
    await this.ctx.storage.delete('run');return {published:staged.publication.id};
    });
  }
  async fail(id,message) {
    return this.ctx.blockConcurrencyWhile(async()=>{
    const run=await this.ctx.storage.get('run');if(run?.id!==id)return;
    await putJSON(this.env.SCOUT_CATALOGUE,'health.json',{refreshStatus:'failed',scheduler:'cloudflare-twice-daily',lastAttemptAt:new Date().toISOString(),refreshError:message});
    await this.ctx.storage.delete('run');
    });
  }
}
export class ScoutRefresh extends WorkflowEntrypoint {
  async run(event,step) {
    return runRefresh(this.env,step,event.instanceId);
  }
}

let reader;
function services(env) {
  reader??=createSnapshotReader(env.SCOUT_CATALOGUE);
  return reader;
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
    // Open pages compare this with the version they loaded under, so a deploy can ask them to refresh.
    if(path==='/scout/api/version')return request.method==='GET'?json({version:env.CF_VERSION_METADATA?.id??null}):json({error:'Use GET.'},405);
    if(!path.startsWith('/scout/api/')&&path!=='/scout/mcp') {
      return ['GET','HEAD'].includes(request.method)?env.ASSETS.fetch(request):json({error:'Not found.'},404);
    }
    const analytics=createProductAnalytics(request,env,ctx);
    let userId,permissions;
    const access=await scoutAccess(request,env,(id,grants)=>{userId=id;permissions=grants;analytics.identify(id);});
    if(access){await analytics.complete(access);return analytics.response(access);}
    if(path==='/scout/api/analytics')return analytics.handleEvent();
    if(agentPath.test(path)){const response=await handleAgent(request,env.SCOUT_AGENT,userId,env.SCOUT_EVALUATIONS);await analytics.complete(response);return analytics.response(response);}
    // Coding agents talk to the same Scout agent as the page, through MCP.
    if(path==='/scout/mcp'){const response=await handleMCP(request,env.SCOUT_AGENT,userId,analytics.observeMCP,env.SCOUT_EVALUATIONS,permissions);await analytics.complete(response);return analytics.response(response);}
    if(path==='/scout/api/analytics/preference')return analytics.handlePreference();
    let response;
    try {
      const index=await services(env).view();
      if(path==='/scout/api/status') {
        if(request.method!=='GET')return json({error:'Use GET.'},405);
        const status=indexStatus(index);
        const health=await getJSON(env.SCOUT_CATALOGUE,'health.json').catch(()=>null);
        return json({...status,scheduler:'cloudflare-twice-daily',refreshStatus:status.degraded?'degraded':'idle',...health,snapshotVersion:index.snapshot.publication.id,refreshSummary:index.snapshot.refreshSummary});
      }
      response=json({error:'Not found.'},404);
    } catch (error) {analytics.exception(error);response=json({error:'Scout could not load its prepared catalogue. Please try again shortly.'},503);}
    await analytics.complete(response);return analytics.response(response);
  },
  async scheduled(event,env,ctx) {
    const id=`hour-${Math.floor(event.scheduledTime/3600_000)}`;
    ctx.waitUntil(env.SCOUT_REFRESH.create({id,params:{}}));
  },
};
