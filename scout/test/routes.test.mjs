import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Node supplies only the platform base classes; exercise the actual Worker router.
const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='cloudflare:workers'
    ? {url:'data:text/javascript,export class DurableObject {} export class WorkflowEntrypoint {}',shortCircuit:true}
    : next(specifier,context);
}});
const {default:worker}=await import('../worker.mjs');
hook.deregister();
const env={ASSETS:{fetch:request=>new Response(new URL(request.url).pathname==='/scout/'?'Scout':'Not found',{status:new URL(request.url).pathname==='/scout/'?200:404})},get SCOUT_CATALOGUE(){assert.fail('Non-API routes must not read the catalogue');},get OPENAI_API_KEY(){assert.fail('Non-API routes must not invoke Decisions');}};

test('Scout has one canonical page and preserves query parameters on slash redirects',async()=>{
  const response=await worker.fetch(new Request('https://example.test/scout?q=birds'),env,{});
  assert.equal(response.status,308);assert.equal(response.headers.get('location'),'https://example.test/scout/?q=birds');
  assert.equal((await worker.fetch(new Request('https://example.test/scout/'),env,{})).status,200);
});
test('retired preview pages and API/MCP aliases do not redirect or execute matching',async()=>{
  for(const version of ['v1','v2'])for(const path of ['', '/', '/api/status','/api/recommend','/mcp'])for(const method of ['GET','POST']){
    const response=await worker.fetch(new Request(`https://example.test/scout/${version}${path}`,{method}),env,{});
    assert.equal(response.status,404,`${method} ${version}${path}`);assert.equal(response.headers.get('location'),null);
  }
});
