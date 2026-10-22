import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:http';

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

// Real SDK signature verification with disposable keys, not a mocked identity.
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const authEnv={
  CLERK_PUBLISHABLE_KEY:`pk_test_${Buffer.from('scout-auth.clerk.accounts.dev$').toString('base64')}`,
  CLERK_SECRET_KEY:'sk_test_local_fixture_not_a_credential',
  CLERK_JWT_KEY:keys.publicKey.export({type:'spki',format:'pem'}),
};
function sessionToken(changes={},key=keys.privateKey){
  const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload={iss:'https://scout-auth.clerk.accounts.dev',azp:'https://example.test',sub:'user_alice',sid:'sess_alice',iat:now,nbf:now-1,exp:now+60,v:2,sts:'active',...changes};
  const input=`${encode({alg:'RS256',typ:'JWT',kid:'local-fixture'})}.${encode(payload)}`;
  return `${input}.${sign('RSA-SHA256',Buffer.from(input),key).toString('base64url')}`;
}
const authenticatedRequest=(path,token,headers={})=>new Request(`https://example.test/scout/${path}`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:JSON.stringify(path==='mcp'?{jsonrpc:'2.0',id:7,method:'ping'}:{invalid:'body preserved'})});

test('public auth configuration exposes only the publishable key and fails closed when incomplete',async()=>{
  const response=await alpha.fetch(new Request('https://example.test/scout/api/auth'),authEnv,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{publishableKey:authEnv.CLERK_PUBLISHABLE_KEY,frontendApi:'scout-auth.clerk.accounts.dev',analytics:{enabled:false}});
  for(const config of [{},{CLERK_PUBLISHABLE_KEY:authEnv.CLERK_PUBLISHABLE_KEY},{...authEnv,CLERK_PUBLISHABLE_KEY:'invalid'}]){
    for(const path of ['api/auth','api/recommend','mcp']){
      const result=await alpha.fetch(new Request(`https://example.test/scout/${path}`),config,{});
      assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/sk_test|BEGIN PUBLIC KEY|invalid/);
    }
  }
});

test('HTTP and MCP reject missing, forged, expired, foreign and pending sessions before catalogue access',async()=>{
  const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  const invalid=[null,'malformed',sessionToken({},otherKey),sessionToken({exp:Math.floor(Date.now()/1000)-60}),sessionToken({nbf:Math.floor(Date.now()/1000)+120}),sessionToken({iss:'https://other.clerk.accounts.dev'}),sessionToken({azp:'https://untrusted.example'}),sessionToken({sts:'pending'}),sessionToken({sid:''}),sessionToken({sub:''})];
  const blockedEnv=Object.assign(Object.create(env),authEnv);
  for(const path of ['api/recommend','mcp']){
    for(const token of invalid){
      const response=await alpha.fetch(authenticatedRequest(path,token),blockedEnv,{});
      assert.equal(response.status,401,`${path}: ${token?.slice(0,20)??'anonymous'}`);
      assert.equal(response.headers.get('www-authenticate'),'Bearer realm="Scout"');
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal((await response.json()).code,'sign_in_required');
    }
    const cookieOnly=await alpha.fetch(authenticatedRequest(path,null,{cookie:`__session=${sessionToken()}`}),blockedEnv,{});
    assert.equal(cookieOnly.status,401);
    assert.equal((await alpha.fetch(authenticatedRequest(path,sessionToken(),{origin:'https://untrusted.example'}),blockedEnv,{})).status,403);
  }
});

test('verified sessions reach HTTP/MCP handlers, while account and IP limits remain independent',async()=>{
  const manifest={publication:{id:'auth-fixture'},sources:[],publicStatus:{models:0},servingEngine:'evidence'};
  const bucket={async get(key){const data=key==='active.json'?{key:'manifest.json',publication:manifest.publication}:key==='manifest.json'?manifest:null;return data?{json:async()=>data}:null;}};
  const configured={...authEnv,SCOUT_CATALOGUE:bucket};
  const token=sessionToken();
  const api=await alpha.fetch(authenticatedRequest('api/recommend',token),configured,{});
  assert.equal(api.status,400,await api.clone().text());assert.equal((await api.json()).error,'Provide prompt and optionally modelIds or endpointIds.');
  const ping=await alpha.fetch(authenticatedRequest('mcp',token),configured,{});
  assert.equal(ping.status,200);assert.deepEqual(await ping.json(),{jsonrpc:'2.0',id:7,result:{}});
  const status=await alpha.fetch(new Request('https://example.test/scout/api/status'),configured,{});
  assert.equal(status.status,200);assert.equal((await status.json()).snapshotVersion,'auth-fixture');

  const counts=new Map();configured.SCOUT_RATE={async limit({key}){const count=(counts.get(key)??0)+1;counts.set(key,count);return {success:count<=2};}};
  const call=(sub,ip)=>alpha.fetch(authenticatedRequest('mcp',sessionToken({sub}),{'cf-connecting-ip':ip}),configured,{});
  assert.equal((await call('user_alice','192.0.2.1')).status,200);
  assert.equal((await call('user_alice','192.0.2.2')).status,200);
  const accountLimit=await call('user_alice','192.0.2.3');assert.equal(accountLimit.status,429);assert.equal(accountLimit.headers.get('retry-after'),'60');
  assert.equal((await call('user_bob','192.0.2.3')).status,200);
  assert.equal((await call('user_charlie','192.0.2.3')).status,429);
});

const productEnv={POSTHOG_PROJECT_TOKEN:'phc_disposable_fixture',POSTHOG_HOST:'https://eu.i.posthog.com',POSTHOG_ENVIRONMENT:'test'};
const anon='de31df69-f037-422a-909c-7a56cb2a2048';
const eventRequest=(event,properties={},token,headers={})=>new Request('https://example.test/scout/api/analytics?private=URL_CANARY',{
  method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},
  body:JSON.stringify({event,anonymousId:anon,properties}),
});
function pendingContext(){
  const pending=[];
  return {waitUntil:p=>pending.push(p),async flush(){while(pending.length)await Promise.all(pending.splice(0));}};
}

test('product events are allowlisted, identity comes from verified sessions, and prompt archives stay separate',async t=>{
  const sent=[],ctx=pendingContext(),config={...authEnv,...productEnv,SCOUT_ANALYTICS:{writeDataPoint(){assert.fail('Product events must not enter prompt archives');}}};
  t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push({url,headers:options.headers,...JSON.parse(options.body)});return new Response(null,{status:200});});
  const secret='PRIVATE_CANARY_person@example.invalid';
  const visit=await alpha.fetch(eventRequest('scout_visited',{prompt:secret,$set:{email:secret},distinct_id:secret},undefined,{'user-agent':secret,cookie:secret,'cf-connecting-ip':'192.0.2.55'}),config,ctx);
  assert.equal(visit.status,204);
  const responses=await Promise.all(['alice','bob'].map(name=>alpha.fetch(eventRequest('scout_signed_in',{userId:secret},sessionToken({sub:`user_${name}`})),config,ctx)));
  assert.deepEqual(responses.map(r=>r.status),[204,204]);
  assert.equal((await alpha.fetch(eventRequest('scout_model_id_copied',{rank:2,task_index:3,modelId:secret}),config,ctx)).status,204);
  await ctx.flush();
  const events=sent.flatMap(p=>p.batch),identities=events.filter(e=>e.event==='$identify');
  assert.equal(events.length,6);assert.equal(identities.length,2);
  assert.equal(events[0].properties.distinct_id,`anonymous:${anon}`);
  assert.notEqual(identities[0].properties.distinct_id,identities[1].properties.distinct_id);
  assert.ok(identities.every(e=>/^account:[a-f0-9]{64}$/.test(e.properties.distinct_id)&&e.properties.$anon_distinct_id===`anonymous:${anon}`));
  const copy=events.find(e=>e.event==='scout_model_id_copied');assert.equal(copy.properties.rank,2);assert.equal(copy.properties.task_index,3);
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_CANARY|URL_CANARY|192\.0\.2|user_alice|user_bob|sess_alice|authorization|cookie|\$set/);
  assert.ok(sent.every(p=>p.url==='https://eu.i.posthog.com/batch/'&&Object.keys(p.headers).join()==='Content-Type'));
  assert.ok(events.every(e=>e.properties.$geoip_disable===true&&e.properties.$ip===null&&e.properties.environment==='test'));
  for(const event of ['scout_search_completed','$identify','constructor',{toString:false}])assert.equal((await alpha.fetch(eventRequest(event),config,ctx)).status,400);
  assert.equal((await alpha.fetch(eventRequest('scout_signed_in'),config,ctx)).status,401);
  assert.equal((await alpha.fetch(eventRequest('scout_signed_in',{},'forged'),config,ctx)).status,401);
  assert.equal((await alpha.fetch(eventRequest('scout_visited',{},undefined,{origin:'https://foreign.test'}),config,ctx)).status,403);
  await ctx.flush();assert.equal(sent.flatMap(p=>p.batch).length,6);
});

test('analytics never forwards its credentials or event body to a redirect destination',async t=>{
  const received=[],ctx=pendingContext(),nativeFetch=globalThis.fetch;
  const server=createServer((request,response)=>{
    received.push(request.url);
    request.resume();
    response.writeHead(request.url==='/batch/'?307:200,{Location:'/redirected',Connection:'close'});
    response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  // Exercise real HTTP redirect handling; only replace the upstream address.
  t.mock.method(globalThis,'fetch',(url,options)=>nativeFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,options));
  const response=await alpha.fetch(eventRequest('scout_visited'),{...authEnv,...productEnv},ctx);
  assert.equal(response.status,204);
  await ctx.flush();
  assert.deepEqual(received,['/batch/']);
});

test('product opt-out and missing configuration suppress all transmissions; rejected searches remain unchanged',async t=>{
  const sent=[],ctx=pendingContext();
  t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push(JSON.parse(options.body));return new Response(null,{status:200});});
  for(const headers of [{dnt:'1'},{'sec-gpc':'1'},{'x-scout-analytics':'off'}]){
    const config={...authEnv,...productEnv};
    assert.equal((await alpha.fetch(eventRequest('scout_visited',{},undefined,headers),config,ctx)).status,204);
    assert.equal((await alpha.fetch(authenticatedRequest('api/recommend',null,headers),config,ctx)).status,401);
  }
  for(const config of [{...authEnv},{...authEnv,...productEnv,POSTHOG_PROJECT_TOKEN:''},{...authEnv,...productEnv,POSTHOG_HOST:'https://unexpected.test'},{...authEnv,...productEnv,POSTHOG_ENVIRONMENT:''}]){
    assert.equal((await alpha.fetch(eventRequest('scout_visited'),config,ctx)).status,204);
    assert.equal((await alpha.fetch(authenticatedRequest('mcp'),config,ctx)).status,401);
  }
  await ctx.flush();assert.equal(sent.length,0);
  assert.equal((await alpha.fetch(authenticatedRequest('api/recommend',null,{'x-scout-client':'cli'}),{...authEnv,...productEnv},ctx)).status,401);
  await ctx.flush();const event=sent[0].batch[0];assert.equal(event.event,'scout_request_completed');
  assert.equal(event.properties.http_status,401);assert.equal(event.properties.outcome,'error');assert.equal(event.properties.client,'cli');assert.equal(event.properties.transport,'http');
});

test('analytics has a separate IP quota and unavailable delivery cannot fail or block requests',async t=>{
  const keys=[],ctx=pendingContext();let release;
  const config={...authEnv,...productEnv,SCOUT_RATE:{async limit({key}){keys.push(key);return {success:true};}}};
  t.mock.method(globalThis,'fetch',()=>new Promise((_,reject)=>{release=()=>reject(new Error('PRIVATE_CANARY'));}));
  const response=await alpha.fetch(eventRequest('scout_signed_in',{},sessionToken()),config,ctx);
  assert.equal(response.status,204);assert.deepEqual(keys,['analytics:ip:unknown']);
  // The response arrived while PostHog is still unresolved. Drain its failed
  // background work afterwards without any failure leaking into the response.
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));release();await ctx.flush();
  assert.equal(await response.text(),'');
  config.SCOUT_RATE.limit=async()=>({success:false});
  assert.equal((await alpha.fetch(eventRequest('scout_visited'),config,ctx)).status,429);
});
