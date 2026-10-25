import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {generateKeyPairSync,sign,createHmac,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';

// Node supplies only the platform base classes; exercise the actual Worker router.
const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='cloudflare:workers'
    ? {url:'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export class WorkflowEntrypoint {}',shortCircuit:true}
    : next(specifier,context);
}});
const {default:worker}=await import('../worker.mjs');
const {default:alpha,ScoutAccounts}=await import('../alpha-worker.mjs');
hook.deregister();
const env={ASSETS:{fetch:request=>{const path=new URL(request.url).pathname;return new Response(path==='/'?'Landing page':path==='/scout/'?'Scout':'Not found',{status:['/','/scout/'].includes(path)?200:404});}},get SCOUT_CATALOGUE(){assert.fail('Non-API routes must not read the catalogue');},get OPENAI_API_KEY(){assert.fail('Non-API routes must not invoke Decisions');}};

test('the landing page stays at root and Scout keeps its own canonical page',async()=>{
  for(const router of [worker,alpha]){
    const home=await router.fetch(new Request('https://example.test/?ref=home'),env,{});
    assert.equal(home.status,200);assert.equal(home.headers.get('location'),null);assert.equal(await home.text(),'Landing page');
    const response=await router.fetch(new Request('https://example.test/scout?q=birds'),env,{});
    assert.equal(response.status,308);assert.equal(response.headers.get('location'),'https://example.test/scout/?q=birds');
    assert.equal((await router.fetch(new Request('https://example.test/scout/'),env,{})).status,200);
  }
});
test('retired pages cannot fall through to old assets or the original website',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('Retired pages must not proxy to the old website'));
  const unavailable=new Proxy({},{get(){assert.fail('Retired pages must not read bindings or assets');}});
  for(const router of [worker,alpha])for(const path of ['/scouting','/scout-other','/connections','/index.html','/docs/','/docs/scout/','/docs/scout/source.md','/docs/manifest.json','/memo/','/engineering/','/demo/api/session'])for(const method of ['GET','HEAD','POST']){
    assert.equal((await router.fetch(new Request(`https://example.test${path}`,{method}),unavailable,{})).status,404,`${method} ${path}`);
  }
});
test('retired preview pages and API/MCP aliases do not redirect or execute matching',async()=>{
  for(const version of ['v1','v2'])for(const path of ['', '/', '/api/status','/api/recommend','/mcp'])for(const method of ['GET','POST']){
    const response=await worker.fetch(new Request(`https://example.test/scout/${version}${path}`,{method}),env,{});
    assert.equal(response.status,404,`${method} ${version}${path}`);assert.equal(response.headers.get('location'),null);
  }
});

test('retired agent and resource discovery routes are 404 before auth, analytics, alpha redirects or SPA fallback',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('Retired routes must not proxy or send analytics'));
  const retiredEnv=new Proxy({SCOUT_OAUTH_ENABLED:'true',SCOUT_OAUTH_CLIENT_IDS:'obsolete-client'},{get(){assert.fail('Retired routes must not read bindings or fetch assets');}});
  const ctx={waitUntil(){assert.fail('Retired routes must not schedule analytics');}};
  for(const router of [worker,alpha])for(const prefix of ['/scout','/scout/alpha','/scout/alpha/alpha','/scout/v1','/scout/v2','/scout/alpha/v1']){
    for(const suffix of ['/mcp','/mcp/','/mcp/tools','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/scout/mcp']){
      if(prefix==='/scout'&&suffix==='/mcp')continue; // Canonical MCP is served; see device-key tests.
      for(const method of ['GET','HEAD','POST','OPTIONS','DELETE']){
        const response=await router.fetch(new Request(`https://example.test${prefix}${suffix}?agent=claude-code`,{method,headers:{origin:'https://foreign.test',authorization:'Bearer obsolete'}}),retiredEnv,ctx);
        assert.equal(response.status,404,`${method} ${prefix}${suffix}`);
        assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('www-authenticate'),null);
        assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.deepEqual(await response.json(),{error:'Not found.'});
      }
    }
  }
  for(const router of [worker,alpha])for(const suffix of ['','/scout/mcp']){
    assert.equal((await router.fetch(new Request(`https://example.test/.well-known/oauth-protected-resource${suffix}`),retiredEnv,ctx)).status,404);
  }
});

test('promoted Scout serves the canonical page and redirects former alpha paths',async t=>{
  t.mock.method(globalThis,'fetch',()=>new Response('Original site'));
  const redirect=await alpha.fetch(new Request('https://example.test/scout?q=a%20b'),env,{});
  assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'https://example.test/scout/?q=a%20b');
  const page=await alpha.fetch(new Request('https://example.test/scout/'),env,{});
  assert.equal(await page.text(),'Scout');assert.equal(page.headers.get('x-robots-tag'),null);
  for(const suffix of ['', '/', '/scout.js', '/api/status', '/api/recommend'])for(const method of ['GET','HEAD','POST']){
    const response=await alpha.fetch(new Request(`https://example.test/scout/alpha${suffix}?q=a%20b`,{method}),env,{});
    assert.equal(response.status,308);assert.equal(response.headers.get('location'),`https://example.test/scout${suffix||'/'}?q=a%20b`);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),'');
  }
  const assets={ASSETS:{fetch:()=>Response.redirect('https://example.test/scout/?q=kept',308)}};
  const assetRedirect=await alpha.fetch(new Request('https://example.test/scout/index.html'),assets,{});
  assert.equal(assetRedirect.headers.get('location'),'https://example.test/scout/?q=kept');
  for(const path of ['/scout/alpha-other','/scout/alphabets','/scout/v1/','/scout/v2/'])assert.equal((await alpha.fetch(new Request(`https://example.test${path}`),env,{})).status,404);
});

test('promoted Scout preserves canonical API bodies',async t=>{
  t.mock.method(worker,'fetch',async request=>Response.json({path:new URL(request.url).pathname,query:new URL(request.url).search,method:request.method,origin:request.headers.get('origin'),body:await request.json()}));
  for(const path of ['api/recommend']){
    const response=await alpha.fetch(new Request(`https://example.test/scout/${path}?test=1`,{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'{"prompt":"Keep my task"}'}),{},{});
    assert.deepEqual(await response.json(),{path:`/scout/${path}`,query:'?test=1',method:'POST',origin:'https://example.test',body:{prompt:'Keep my task'}});
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
const authenticatedRequest=(path,token,headers={})=>new Request(`https://example.test/scout/${path}`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:JSON.stringify({invalid:'body preserved'})});

test('public auth configuration exposes only the publishable key and fails closed when incomplete',async()=>{
  const response=await alpha.fetch(new Request('https://example.test/scout/api/auth'),authEnv,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{publishableKey:authEnv.CLERK_PUBLISHABLE_KEY,frontendApi:'scout-auth.clerk.accounts.dev',analytics:{enabled:false,accountSync:false,content:false,contentDefault:false}});
  for(const config of [{},{CLERK_PUBLISHABLE_KEY:authEnv.CLERK_PUBLISHABLE_KEY},{...authEnv,CLERK_PUBLISHABLE_KEY:'invalid'}]){
    for(const path of ['api/auth','api/recommend']){
      const result=await alpha.fetch(new Request(`https://example.test/scout/${path}`),config,{});
      assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/sk_test|BEGIN PUBLIC KEY|invalid/);
    }
  }
});

test('HTTP rejects missing, forged, expired, foreign and pending sessions before catalogue access',async()=>{
  const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  const invalid=[null,'malformed',sessionToken({},otherKey),sessionToken({exp:Math.floor(Date.now()/1000)-60}),sessionToken({nbf:Math.floor(Date.now()/1000)+120}),sessionToken({iss:'https://other.clerk.accounts.dev'}),sessionToken({azp:'https://untrusted.example'}),sessionToken({sts:'pending'}),sessionToken({sid:''}),sessionToken({sub:''})];
  const blockedEnv=Object.assign(Object.create(env),authEnv);
  for(const path of ['api/recommend']){
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

test('verified sessions reach HTTP handlers, while account and IP limits remain independent',async()=>{
  const manifest={publication:{id:'auth-fixture'},sources:[],publicStatus:{models:0},servingEngine:'evidence'};
  const bucket={async get(key){const data=key==='active.json'?{key:'manifest.json',publication:manifest.publication}:key==='manifest.json'?manifest:null;return data?{json:async()=>data}:null;}};
  const configured={...authEnv,SCOUT_CATALOGUE:bucket};
  const token=sessionToken();
  const api=await alpha.fetch(authenticatedRequest('api/recommend',token),configured,{});
  assert.equal(api.status,400,await api.clone().text());assert.equal((await api.json()).error,'Provide prompt and optionally modelIds or endpointIds.');
  const status=await alpha.fetch(new Request('https://example.test/scout/api/status'),configured,{});
  assert.equal(status.status,200);assert.equal((await status.json()).snapshotVersion,'auth-fixture');

  const counts=new Map();configured.SCOUT_RATE={async limit({key}){const count=(counts.get(key)??0)+1;counts.set(key,count);return {success:count<=2};}};
  const call=(sub,ip)=>alpha.fetch(authenticatedRequest('api/recommend',sessionToken({sub}),{'cf-connecting-ip':ip}),configured,{});
  assert.equal((await call('user_alice','192.0.2.1')).status,400);
  assert.equal((await call('user_alice','192.0.2.2')).status,400);
  const accountLimit=await call('user_alice','192.0.2.3');assert.equal(accountLimit.status,429);assert.equal(accountLimit.headers.get('retry-after'),'60');
  assert.equal((await call('user_bob','192.0.2.3')).status,400);
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
  const responses=await Promise.all(['alice','bob'].map(name=>alpha.fetch(eventRequest('scout_session_observed',{userId:secret},sessionToken({sub:`user_${name}`})),config,ctx)));
  assert.deepEqual(responses.map(r=>r.status),[204,204]);
  assert.equal((await alpha.fetch(eventRequest('scout_model_id_copied',{rank:2,task_index:3,modelId:secret}),config,ctx)).status,204);
  for(const example of ['invoice-extraction','support-workflow','feedback-workflow',secret])assert.equal((await alpha.fetch(eventRequest('scout_example_selected',{example,prompt:secret}),config,ctx)).status,204);
  await ctx.flush();
  const events=sent.flatMap(p=>p.batch),identities=events.filter(e=>e.event==='$identify');
  assert.equal(events.length,10);assert.equal(identities.length,2);
  assert.deepEqual(events.filter(e=>e.event==='scout_example_selected').map(e=>e.properties.example),['invoice-extraction','support-workflow','feedback-workflow',undefined]);
  assert.equal(events[0].properties.distinct_id,`anonymous:${anon}`);
  assert.notEqual(identities[0].properties.distinct_id,identities[1].properties.distinct_id);
  assert.ok(identities.every(e=>/^account:[a-f0-9]{64}$/.test(e.properties.distinct_id)&&e.properties.$anon_distinct_id===`anonymous:${anon}`));
  const copy=events.find(e=>e.event==='scout_model_id_copied');assert.equal(copy.properties.rank,2);assert.equal(copy.properties.task_index,3);
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_CANARY|URL_CANARY|192\.0\.2|user_alice|user_bob|sess_alice|authorization|cookie|\$set/);
  assert.ok(sent.every(p=>p.url==='https://eu.i.posthog.com/batch/'&&Object.keys(p.headers).join()==='Content-Type'));
  assert.ok(events.every(e=>e.properties.$geoip_disable===true&&e.properties.$ip===null&&e.properties.environment==='test'));
  for(const event of ['scout_search_completed','scout_signed_in','scout_signed_up','scout_signed_out','$identify','constructor',{toString:false}])assert.equal((await alpha.fetch(eventRequest(event),config,ctx)).status,400);
  for(const event of ['scout_agent_setup_opened','scout_agent_selected','scout_agent_docs_opened','scout_agent_connected'])assert.equal((await alpha.fetch(eventRequest(event),config,ctx)).status,400);
  assert.equal((await alpha.fetch(eventRequest('scout_session_observed'),config,ctx)).status,401);
  assert.equal((await alpha.fetch(eventRequest('scout_session_observed',{},'forged'),config,ctx)).status,401);
  assert.equal((await alpha.fetch(eventRequest('scout_visited',{},undefined,{origin:'https://foreign.test'}),config,ctx)).status,403);
  await ctx.flush();assert.equal(sent.flatMap(p=>p.batch).length,10);
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
    assert.equal((await alpha.fetch(authenticatedRequest('api/recommend'),config,ctx)).status,401);
  }
  await ctx.flush();assert.equal(sent.length,0);
  assert.equal((await alpha.fetch(authenticatedRequest('api/recommend',null,{'x-scout-client':'cli'}),{...authEnv,...productEnv},ctx)).status,401);
  await ctx.flush();const event=sent[0].batch[0];assert.equal(event.event,'scout_request_completed');
  assert.equal(event.properties.http_status,401);assert.equal(event.properties.outcome,'error');assert.equal(event.properties.client,'cli');assert.equal(event.properties.transport,'http');
});

test('analytics has a separate IP quota and unavailable delivery cannot fail or block requests',async t=>{
  const keys=[],ctx=pendingContext();let release;
  const config={...authEnv,...productEnv,SCOUT_RATE:{async limit({key}){keys.push(key);return {success:true};}}};
  let unavailable=false;
  t.mock.method(globalThis,'fetch',()=>unavailable?Promise.reject(new Error('PRIVATE_CANARY')):new Promise((_,reject)=>{release=()=>{unavailable=true;reject(new Error('PRIVATE_CANARY'));};}));
  const response=await alpha.fetch(eventRequest('scout_session_observed',{},sessionToken()),config,ctx);
  assert.equal(response.status,204);assert.deepEqual(keys,['analytics:ip:unknown']);
  // The response arrived while PostHog is still unresolved. Drain its failed
  // background work afterwards without any failure leaking into the response.
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));release();await ctx.flush();
  assert.equal(await response.text(),'');
  config.SCOUT_RATE.limit=async()=>({success:false});
  assert.equal((await alpha.fetch(eventRequest('scout_visited'),config,ctx)).status,429);
});

const webhookKey = randomBytes(32);
function webhookRequest(type, data, { id = crypto.randomUUID(), timestamp = Date.now(), signedAt = Math.floor(Date.now()/1000), tamper = false } = {}) {
  const body = JSON.stringify({ object: 'event', type, timestamp, instance_id: 'ins_fixture', data, event_attributes: { http_request: { client_ip: '192.0.2.199', user_agent: 'PRIVATE_CANARY' } } });
  const signature = createHmac('sha256', webhookKey).update(`${id}.${signedAt}.${body}`).digest('base64');
  return new Request('https://example.test/scout/api/webhooks/clerk', { method: 'POST', headers: {
    'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(signedAt), 'svix-signature': `v1,${signature}`,
  }, body: tamper ? body.replace(type, 'user.deleted') : body });
}
function accountEnvironment() {
  const config = { ...authEnv, ...productEnv, CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${webhookKey.toString('base64')}`, POSTHOG_PERSONAL_API_KEY: 'disposable-person-key', POSTHOG_PROJECT_ID: '123' };
  const objects = new Map(), stored = new Map();
  config.SCOUT_ACCOUNTS = { idFromName: id => id, get(id) {
    if (!objects.has(id)) {
      const data = new Map(); stored.set(id, data); let pending = Promise.resolve();
      const ctx = {
        storage: { get: async key => structuredClone(data.get(key)), put: async (key, value) => data.set(key, structuredClone(value)), setAlarm: async () => {} },
        blockConcurrencyWhile(fn) { const next = pending.then(fn); pending = next.catch(() => {}); return next; },
      };
      objects.set(id, new ScoutAccounts(ctx, config));
    }
    return objects.get(id);
  } };
  return { config, stored, alarm: async () => { for (const object of objects.values()) await object.alarm(); } };
}
const preferenceRequest = (enabled, headers = {}, token = sessionToken()) => new Request('https://example.test/scout/api/analytics/preference', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ enabled }),
});
const profileFixture = () => ({ object: 'user', id: 'user_alice', first_name: 'Ada', last_name: 'Lovelace', created_at: 1700000000000,
  primary_email_address_id: 'id_primary', email_addresses: [
    { id: 'id_secondary', email_address: 'PRIVATE_CANARY@example.invalid', verification: { status: 'verified' } },
    { id: 'id_primary', email_address: 'ada@example.invalid', verification: { status: 'verified' } },
  ], external_accounts: [{ provider: 'oauth_google' }, { provider: 'github' }], private_metadata: { secret: 'PRIVATE_CANARY' }, image_url: 'PRIVATE_CANARY', phone_numbers: ['PRIVATE_CANARY'],
});

test('signed Clerk deliveries sync canonical profiles, buffer OAuth signup and deduplicate lifecycle events', async t => {
  const { config, stored } = accountEnvironment(), sent = [], ctx = pendingContext(); let profile = profileFixture();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.clerk.com/v1/users/')) return Response.json(profile);
    assert.equal(url, 'https://eu.i.posthog.com/batch/'); sent.push(...JSON.parse(options.body).batch); return Response.json({ status: 1 });
  });
  const signup = webhookRequest('user.created', { id: 'user_alice', first_name: 'PRIVATE_CANARY' });
  const signin = webhookRequest('session.created', { user_id: 'user_alice', id: 'sess_private', user: profile });
  for (const request of [signup.clone(), signin.clone(), signup.clone()]) assert.equal((await alpha.fetch(request, config, ctx)).status, 200);
  assert.equal(sent.length, 0, 'no webhook exports before the browser preference is known');
  assert.equal((await alpha.fetch(preferenceRequest(true), config, ctx)).status, 204);
  assert.deepEqual(sent.map(e => e.event), ['$set', 'scout_signed_up', 'scout_signed_in']);
  assert.deepEqual(sent[0].properties.$set, { name: 'Ada Lovelace', email: 'ada@example.invalid', signup_at: '2023-11-14T22:13:20.000Z', connected_providers: ['github', 'google'] });
  assert.equal(sent[2].properties.auth_provider, 'unknown', 'two linked providers do not establish the login provider');
  for (const request of [signup.clone(), signin.clone()]) assert.equal((await alpha.fetch(request, config, ctx)).status, 200);
  assert.equal(sent.length, 3);
  profile = { ...profile, first_name: '', last_name: '', email_addresses: profile.email_addresses.map(e => ({ ...e, verification: { status: 'unverified' } })), external_accounts: [{ provider: 'google' }] };
  assert.equal((await alpha.fetch(webhookRequest('user.updated', profileFixture(), { timestamp: Date.now() - 10000 }), config, ctx)).status, 200);
  assert.deepEqual(sent.at(-1).properties.$unset, ['name', 'email']);
  assert.deepEqual(sent.at(-1).properties.$set.connected_providers, ['google']);
  assert.equal(sent.at(-1).properties.$set.email, undefined, 'stale webhook data cannot restore the previous email');
  for (const [type, event] of [['session.ended', 'scout_signed_out'], ['session.revoked', 'scout_session_revoked'], ['session.removed', 'scout_session_removed']]) {
    const request = webhookRequest(type, { user_id: 'user_alice' });
    assert.equal((await alpha.fetch(request.clone(), config, ctx)).status, 200);
    assert.equal((await alpha.fetch(request, config, ctx)).status, 200);
    assert.equal(sent.filter(e => e.event === event).length, 1);
  }
  assert.ok(sent.every(e => e.properties.distinct_id === sent[0].properties.distinct_id && e.properties.$geoip_disable && e.properties.$ip === null));
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_CANARY|user_alice|sess_private|192\.0\.2/);
  assert.doesNotMatch(JSON.stringify([...stored].map(([id, data]) => [id, [...data]])), /Lovelace|ada@|user_alice|sess_private|PRIVATE_CANARY/);
});

test('webhook signatures and preference authentication fail closed, and opt-outs suppress later server deliveries', async t => {
  const { config } = accountEnvironment(), sent = [], ctx = pendingContext();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.clerk.com/')) return Response.json(profileFixture());
    sent.push(...JSON.parse(options.body).batch); return Response.json({ status: 1 });
  });
  for (const request of [webhookRequest('user.updated', { id: 'user_alice' }, { tamper: true }), webhookRequest('user.updated', { id: 'user_alice' }, { signedAt: 1 }), authenticatedRequest('api/webhooks/clerk', sessionToken())]) {
    assert.equal((await alpha.fetch(request, config, ctx)).status, 400);
  }
  assert.equal((await alpha.fetch(webhookRequest('user.updated', { id: 'user_alice' }), { ...config, CLERK_WEBHOOK_SIGNING_SECRET: '' }, ctx)).status, 503);
  assert.equal((await alpha.fetch(new Request('https://example.test/scout/api/webhooks/clerk', { method: 'POST', body: 'x'.repeat(262145) }), config, ctx)).status, 413);
  assert.equal((await alpha.fetch(preferenceRequest(true, {}, null), config, ctx)).status, 401);
  assert.equal((await alpha.fetch(preferenceRequest(true, { origin: 'https://foreign.test' }), config, ctx)).status, 403);
  assert.equal((await alpha.fetch(preferenceRequest(true, {}, 'forged'), config, ctx)).status, 401);
  assert.equal(sent.length, 0);
  for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }, { 'x-scout-analytics': 'off' }]) {
    // Account-wide changes require the explicit preference route. A disabled
    // request alone must not silently opt every other client out.
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await alpha.fetch(preferenceRequest(true), config, ctx)).status, 204);
    assert.equal((await alpha.fetch(eventRequest('scout_visited', {}, sessionToken(), headers), config, ctx)).status, 204);
    assert.equal((await alpha.fetch(preferenceRequest(false, headers), config, ctx)).status, 204);
    await ctx.flush(); const before = sent.length;
    assert.equal((await alpha.fetch(webhookRequest('session.created', { user_id: 'user_alice' }), config, ctx)).status, 200);
    assert.equal((await alpha.fetch(webhookRequest('user.updated', { id: 'user_alice' }), config, ctx)).status, 200);
    assert.equal((await alpha.fetch(preferenceRequest(true, headers), config, ctx)).status, 204);
    assert.equal((await alpha.fetch(eventRequest('scout_session_observed', {}, sessionToken()), config, ctx)).status, 204);
    await ctx.flush(); assert.equal(sent.length, before, 'webhooks and account events obey the stored opt-out');
  }
});

test('unlinked requests ignore known identities and traces without bypassing account opt-outs or deletion', async t => {
  const { config } = accountEnvironment(), sent = [], ctx = pendingContext();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.clerk.com/')) return Response.json(profileFixture());
    if (url.includes('/persons/bulk_delete/')) return Response.json({ persons_found: 0, deletion_errors: [] });
    sent.push(...JSON.parse(options.body).batch); return Response.json({ status: 1 });
  });
  config.POSTHOG_CAPTURE_CONTENT = 'true'; config.SCOUT_BETA_EVALUATION_LOGGING = 'true';
  const auth = await (await alpha.fetch(new Request('https://example.test/scout/api/auth'), config, ctx)).json();
  assert.equal(auth.analytics.contentDefault, true);
  const unavailable = await (await alpha.fetch(new Request('https://example.test/scout/api/auth'), { ...config, POSTHOG_PERSONAL_API_KEY: '' }, ctx)).json();
  assert.equal(unavailable.analytics.contentDefault, false);
  await alpha.fetch(preferenceRequest(true), config, ctx);
  await alpha.fetch(eventRequest('scout_session_observed', {}, sessionToken()), config, ctx); await ctx.flush();
  const linked = sent.find(e => e.event === '$identify').properties;
  const headers = { 'x-scout-analytics-account': 'off', 'x-scout-anonymous-id': linked.$session_id };
  const before = sent.length;
  for (let i = 0; i < 2; i++) {
    const response = await alpha.fetch(eventRequest('scout_model_id_copied', { rank: 2, task_index: 1, trace_id: linked.trace_id }, sessionToken(), headers), config, ctx);
    assert.equal(response.headers.get('X-Scout-Trace-Id'), null, 'a later linked click must not recover this unlinked trace');
  }
  await alpha.fetch(eventRequest('scout_session_observed', {}, sessionToken(), headers), config, ctx);
  await ctx.flush();
  const unlinked = sent.slice(before);
  assert.equal(unlinked.length, 3, 'no identify or profile accompanies an unlinked request');
  assert.equal(new Set(unlinked.map(e => e.properties.distinct_id)).size, 3);
  for (const { event, properties: p } of unlinked) {
    assert.notEqual(event, '$identify'); assert.equal(p.account_linked, false); assert.equal(p.$process_person_profile, false);
    assert.notEqual(p.distinct_id, linked.distinct_id); assert.notEqual(p.$session_id, linked.$session_id);
    assert.notEqual(p.trace_id, linked.trace_id); assert.equal(p.$anon_distinct_id, undefined);
  }
  await alpha.fetch(preferenceRequest(false), config, ctx);
  const count = sent.length;
  await alpha.fetch(eventRequest('scout_visited', {}, sessionToken(), headers), config, ctx); await ctx.flush();
  assert.equal(sent.length, count);
  await alpha.fetch(webhookRequest('user.deleted', { id: 'user_alice' }), config, ctx);
  await alpha.fetch(eventRequest('scout_visited', {}, sessionToken(), headers), config, ctx); await ctx.flush();
  assert.equal(sent.length, count);
});

test('delivery retries preserve IDs and deletion tombstones block late updates and still-valid sessions', async t => {
  const { config, alarm } = accountEnvironment(), attempts = [], erased = [], ctx = pendingContext(); let failCapture = false, failDelete = true, persons = 1;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.clerk.com/')) return Response.json(profileFixture());
    if (url === 'https://eu.posthog.com/api/projects/123/persons/bulk_delete/') {
      erased.push(JSON.parse(options.body));
      return failDelete ? new Response('PRIVATE_CANARY', { status: 503 }) : Response.json({ persons_found: persons, events_queued_for_deletion: persons > 0, deletion_errors: [] }, { status: 202 });
    }
    assert.equal(url, 'https://eu.i.posthog.com/batch/');
    attempts.push(...JSON.parse(options.body).batch);
    return new Response(null, { status: failCapture ? 503 : 200 });
  });
  assert.equal((await alpha.fetch(preferenceRequest(true), config, ctx)).status, 204);
  const event = webhookRequest('session.created', { user_id: 'user_alice' });
  failCapture = true;
  assert.equal((await alpha.fetch(event.clone(), config, ctx)).status, 503);
  failCapture = false;
  assert.equal((await alpha.fetch(event.clone(), config, ctx)).status, 200);
  assert.equal((await alpha.fetch(event, config, ctx)).status, 200);
  const retries = attempts.filter(e => e.event === 'scout_signed_in');
  assert.equal(retries.length, 4); assert.equal(new Set(retries.map(e => e.uuid)).size, 1);
  const deleted = webhookRequest('user.deleted', { id: 'user_alice', deleted: true });
  const failed = await alpha.fetch(deleted.clone(), config, ctx);
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /PRIVATE_CANARY/);
  const before = attempts.length;
  assert.equal((await alpha.fetch(webhookRequest('user.updated', { id: 'user_alice' }), config, ctx)).status, 503, 'a late update retries erasure, not profile creation');
  assert.equal((await alpha.fetch(eventRequest('scout_session_observed', {}, sessionToken()), config, ctx)).status, 204);
  await ctx.flush(); assert.equal(attempts.length, before);
  failDelete = false;
  assert.equal((await alpha.fetch(deleted.clone(), config, ctx)).status, 200);
  assert.equal((await alpha.fetch(deleted, config, ctx)).status, 200);
  assert.equal((await alpha.fetch(webhookRequest('user.created', { id: 'user_alice' }), config, ctx)).status, 200);
  assert.equal((await alpha.fetch(preferenceRequest(true), config, ctx)).status, 204);
  assert.equal(attempts.length, before);
  assert.equal(erased.length, 3);
  assert.deepEqual(erased[2], { distinct_ids: [attempts[0].properties.distinct_id], delete_events: true, delete_recordings: true });
  assert.doesNotMatch(JSON.stringify(erased), /user_alice|Lovelace|ada@/);
  assert.equal((await alpha.fetch(eventRequest('scout_visited', {}, sessionToken({ sub: 'user_bob' })), config, ctx)).status, 204);
  await ctx.flush(); assert.equal(attempts.length, before + 1, 'deleting Alice must not suppress Bob');
  persons = 0; config.POSTHOG_PROJECT_TOKEN = '';
  assert.equal((await alpha.fetch(webhookRequest('user.deleted', { id: 'user_bob' }), config, ctx)).status, 200, 'zero matching persons is accepted even with capture disabled');
  const prior = erased.length;
  await alarm(); assert.equal(erased.length, prior + 2, 'both tombstones reconcile after a no-op or accepted deletion');
  persons = 1; // Accepted-but-delayed capture finally creates the person upstream.
  await alarm(); assert.equal(erased.length, prior + 4);
  assert.deepEqual(erased.at(-1), erased[prior - 1], 'late ingestion is erased by the same pseudonym');
});
