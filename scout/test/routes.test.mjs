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
const {default:alpha}=await import('../alpha-worker.mjs');
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

test('promoted Scout serves the canonical page and redirects former alpha paths',async t=>{
  t.mock.method(globalThis,'fetch',()=>new Response('Original site'));
  const redirect=await alpha.fetch(new Request('https://example.test/scout?q=a%20b'),env,{});
  assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'https://example.test/scout/?q=a%20b');
  const page=await alpha.fetch(new Request('https://example.test/scout/'),env,{});
  assert.equal(await page.text(),'Scout');assert.equal(page.headers.get('x-robots-tag'),null);
  for(const suffix of ['', '/', '/scout.js', '/api/status', '/api/recommend', '/mcp'])for(const method of ['GET','HEAD','POST']){
    const response=await alpha.fetch(new Request(`https://example.test/scout/alpha${suffix}?q=a%20b`,{method}),env,{});
    assert.equal(response.status,308);assert.equal(response.headers.get('location'),`https://example.test/scout${suffix||'/'}?q=a%20b`);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),'');
  }
  const assets={ASSETS:{fetch:()=>Response.redirect('https://example.test/scout/?q=kept',308)}};
  const assetRedirect=await alpha.fetch(new Request('https://example.test/scout/index.html'),assets,{});
  assert.equal(assetRedirect.headers.get('location'),'https://example.test/scout/?q=kept');
  for(const path of ['/scout/alpha-other','/scout/alphabets','/scout/v1/','/scout/v2/'])assert.equal((await alpha.fetch(new Request(`https://example.test${path}`),env,{})).status,404);
});

test('promoted Scout preserves canonical API and MCP bodies and leaves non-Scout routes untouched',async t=>{
  t.mock.method(globalThis,'fetch',request=>new Response(`Original route: ${new URL(request.url).pathname}`));
  t.mock.method(worker,'fetch',async request=>Response.json({path:new URL(request.url).pathname,query:new URL(request.url).search,method:request.method,origin:request.headers.get('origin'),body:await request.json()}));
  for(const path of ['api/recommend','mcp']){
    const response=await alpha.fetch(new Request(`https://example.test/scout/${path}?test=1`,{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'{"prompt":"Keep my task"}'}),{},{});
    assert.deepEqual(await response.json(),{path:`/scout/${path}`,query:'?test=1',method:'POST',origin:'https://example.test',body:{prompt:'Keep my task'}});
  }
  for(const path of ['/scouting','/scout-other','/docs/scout/','/memo/','/']){
    const response=await alpha.fetch(new Request(`https://example.test${path}`),{},{});
    assert.equal(await response.text(),`Original route: ${path}`);assert.equal(response.headers.get('x-robots-tag'),null);
  }
});
