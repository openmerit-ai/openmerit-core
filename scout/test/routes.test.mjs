import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';

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
  assert.deepEqual(await response.json(),{publishableKey:authEnv.CLERK_PUBLISHABLE_KEY,frontendApi:'scout-auth.clerk.accounts.dev'});
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
