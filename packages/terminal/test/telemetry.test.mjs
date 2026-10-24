import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { startTerminal } from '../src/server.mjs';
import { commandTelemetry, errorProperties, safeFrames, terminalProperties, installationProperties, setupUUID } from '../src/telemetry.mjs';
import { createAnalytics, browserErrorProperties } from '../client/analytics.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url);
const clientEnvironment = {client_version:JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version,platform:process.platform,runtime_major:Number(process.versions.node.split('.')[0])};
test('diagnostics keep only application basenames and coordinates, including Scout response traces', async () => {
  const app = new URL('../src/cli.mjs', import.meta.url).href;
  const error = new TypeError('PRIVATE text /home/user/secret');
  error.stack = `TypeError: PRIVATE\n    at secretFunction (${app}:12:3)\n    at privateFunction (file:///home/user/cli.mjs:22:4)\n    at PRIVATE (file:///home/user/task.js:4:8)`;
  assert.deepEqual(safeFrames(error), [{filename:'cli.mjs',lineno:12,colno:3}]);
  assert.deepEqual(terminalProperties('terminal_error', {code:'render_error',error_type:'TypeError',frames:[{filename:'app.js',lineno:5,colno:9,function:'PRIVATE',message:'PRIVATE'}, {filename:'/home/user/cli.mjs',lineno:3,colno:2}]}), {code:'render_error',error_type:'TypeError',frames:[{filename:'app.js',lineno:5,colno:9}]});
  assert.deepEqual(errorProperties({get name(){throw Error('PRIVATE');}}), {error_type:'Error',frames:[]});
  const location = globalThis.location;
  try {
    globalThis.location = { href: 'http://localhost:4310/' };
    const browserError = { name:'TypeError', stack:'TypeError: PRIVATE\n    at PRIVATE (http://localhost:4310/app.js:17:2)\n    at PRIVATE (https://private.example/app.js:22:5)' };
    assert.deepEqual(browserErrorProperties(browserError), {error_type:'TypeError',frames:[{filename:'app.js',lineno:17,colno:2}]});
    assert.deepEqual(browserErrorProperties({get stack(){throw Error('PRIVATE');}}), {error_type:'Error',frames:[]});
  } finally { if (location === undefined) delete globalThis.location; else globalThis.location = location; }
  const { makePlan } = await import('../../eval/src/scout.mjs');
  const config = {scope:'all',connections:[],tasks:[{id:'PRIVATE',description:'PRIVATE'}]};
  const trace = 'b8d2d9fa-6d37-4d50-a90b-d83ea69b22bf';
  for (const [response, code] of [[new Response('PRIVATE',{status:503,headers:{'X-Scout-Trace-Id':trace}}),'scout_http_error'], [Response.json({PRIVATE:true},{headers:{'X-Scout-Trace-Id':trace}}),'scout_response_error']]) {
    await assert.rejects(makePlan(config, async()=>response), error => {
      const diagnostic = errorProperties(error);
      assert.equal(diagnostic.code,code);
      assert.equal(diagnostic.operation,'scout_recommend');
      assert.equal(diagnostic.trace_id,trace);
      assert.ok(diagnostic.frames.some(f=>f.filename==='scout.mjs'));
      assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|file:|\/home\//);
      return true;
    });
  }
  for (const [error, code] of [[new Error('PRIVATE'),'scout_network_error'],[new DOMException('PRIVATE','TimeoutError'),'scout_timeout']]) {
    await assert.rejects(makePlan(config,async()=>{throw error;}), caught => errorProperties(caught).code===code);
  }
  await assert.rejects(makePlan(config,async()=>new Response(null,{status:503,headers:{'X-Scout-Trace-Id':'PRIVATE'}})), error => !('trace_id' in errorProperties(error)));
});

test('browser consent controls prevent even local submission; enabled browser uses only relay', async () => {
  const calls = [];
  for (const control of [{enabled:false}, {navigator:{doNotTrack:'1'}}, {navigator:{globalPrivacyControl:true}}, {optOut:'1'}, {blocked:true}, {}]) {
    const send = createAnalytics({enabled:()=>control.enabled!==false,mode:()=> 'live',navigator:control.navigator??{},storage:{getItem:()=>{if(control.blocked)throw new Error('blocked');return control.optOut;}},fetcher:async (...args)=>{calls.push(args);}});
    send('terminal_visited');
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/api/analytics');
  assert.deepEqual(JSON.parse(calls[0][1].body),{event:'terminal_visited',properties:{mode:'live'}});
});

test('local relay projects allowlists, shares CLI identity, enforces guards and bounds on hung transport', async () => {
  const originalFetch = globalThis.fetch, saved = process.env.OPENMERIT_TELEMETRY, dnt = process.env.DO_NOT_TRACK;
  const calls=[];
  globalThis.fetch=async (url,options)=>{calls.push({url,...options});return new Response(null);};
  process.env.OPENMERIT_TELEMETRY=''; process.env.DO_NOT_TRACK='';
  const terminal=await startTerminal({port:0,demo:true});
  const post=(body,headers={})=>originalFetch(`${terminal.url}/api/analytics`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  try {
    const event={event:'terminal_interaction',anonymousId:'CANARY',properties:{mode:'live',action:'inspect',kind:'model',key:'CANARY',prompt:'CANARY',error:'CANARY'}};
    assert.equal((await originalFetch(`${terminal.url}/api/info`).then(r=>r.json())).telemetry,false);
    assert.equal((await post(event)).status,204); assert.equal(calls.length,0);
    process.env.OPENMERIT_TELEMETRY='1';
    assert.equal((await originalFetch(`${terminal.url}/api/info`).then(r=>r.json())).telemetry,true);
    await commandTelemetry(['dash'])('ok');
    assert.equal((await post(event)).status,204);
    await new Promise(resolve=>setImmediate(resolve));
    const body=JSON.parse(calls.at(-1).body);
    assert.equal(body.anonymousId,JSON.parse(calls[0].body).anonymousId);
    assert.deepEqual(body.properties,{mode:'live',action:'inspect',kind:'model',...clientEnvironment});
    assert.doesNotMatch(JSON.stringify(body),/CANARY/);
    const consented = calls.length;
    for (const privacy of [{ DNT: '1' }, { 'Sec-GPC': '1' }, { 'X-Scout-Analytics': 'off' }]) {
      assert.equal((await post(event, privacy)).status, 204);
      assert.equal(calls.length, consented, 'request privacy overrides process opt-in');
    }
    assert.equal((await post(event,{Origin:'https://evil.example'})).status,403);
    assert.equal((await post(event,{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await post('x'.repeat(2049))).status,413);
    for(const value of [{...event,event:'private_event'},{...event,properties:{mode:'CANARY',action:'inspect',kind:'model'}},{event:'terminal_snapshot',properties:{mode:'live',model_count:Infinity}},{event:'terminal_error',properties:{code:'collection_error',error_type:'CANARY'}}]) assert.equal((await post(value)).status,400);
    globalThis.fetch=async (url,options)=>{calls.push({url,...options});return new Promise(()=>{});};
    const before=calls.length, started=performance.now();
    await Promise.all(Array.from({length:12},()=>post(event)));
    assert.ok(calls.length-before<=4);
    assert.ok(performance.now()-started<700);
    assert.equal((await originalFetch(`${terminal.url}/api/snapshot`)).status,200);
    await new Promise(resolve=>setTimeout(resolve,800));
    await post(event); assert.ok(calls.length>before);
  } finally {
    await terminal.close();globalThis.fetch=originalFetch;
    if(saved===undefined)delete process.env.OPENMERIT_TELEMETRY;else process.env.OPENMERIT_TELEMETRY=saved;
    if(dnt===undefined)delete process.env.DO_NOT_TRACK;else process.env.DO_NOT_TRACK=dnt;
  }
});
async function run(args, env = {}, mode = 'ok', stopAfterStartup = false) {
  // Installed before the CLI loads: no test can contact the analytics service.
  const preload = `globalThis.fetch = async (url, options) => {
    process.stderr.write('TELEMETRY:' + JSON.stringify({url, ...options, signal: undefined}) + '\\n');
    if (${JSON.stringify(mode)} === 'fail') throw new Error('private network failure');
    if (${JSON.stringify(mode)} === 'hang') return new Promise(() => {});
    return new Response(null, {status: ${mode === 'http-error' ? 503 : 200}});
  };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli.pathname, ...args], {
    env: { ...process.env, OPENMERIT_TELEMETRY: '', DO_NOT_TRACK: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => {
    stderr += data;
    if (stopAfterStartup && stderr.includes('cli_command_completed')) child.kill('SIGTERM');
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(deadline);
  const events = stderr.split('\n').filter(line => line.startsWith('TELEMETRY:')).map(line => JSON.parse(line.slice(10)));
  return { code, stdout, stderr: stderr.split('\n').filter(line => !line.startsWith('TELEMETRY:')).join('\n'), events };
}

test('CLI telemetry is default-off, exact opt-in only, and DO_NOT_TRACK overrides consent', async () => {
  for (const env of [{}, { OPENMERIT_TELEMETRY: '0' }, { OPENMERIT_TELEMETRY: 'true' }, { OPENMERIT_TELEMETRY: '1', DO_NOT_TRACK: '1' }]) {
    const result = await run(['dash', '--demo', '--json'], env);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).mode, 'sample');
    assert.deepEqual(result.events, []);
    assert.equal(result.stderr, '');
  }
});

test('opted-in CLI sends only allowlisted payloads with ephemeral UUID identity', async () => {
  let previousId;
  for (const [args, command, outcome] of [
    [[], 'help', 'ok'], [['eval', '--help'], 'help', 'ok'],
    [['dash', '--demo', '--json'], 'dash', 'ok'],
    [['dash', '--demo', '--diagnostics'], 'dash', 'ok'],
    [['private-prompt-model@example.org'], 'unknown', 'error'],
    ...['init', 'doctor', 'plan', 'run', 'watch', 'report'].map(action => [['eval', action, '--private-secret'], `eval_${action}`, 'error']),
  ]) {
    const result = await run(args, { OPENMERIT_TELEMETRY: '1', PRIVATE_SECRET: 'never-send' });
    assert.equal(result.code, outcome === 'ok' ? 0 : 1);
    assert.equal(result.events.length, 2);
    const bodies = result.events.map(({url, method, headers, body, redirect}) => {
      assert.equal(url, 'https://openmerit.ai/scout/api/analytics');
      assert.equal(method, 'POST');
      assert.equal(redirect, 'error');
      assert.deepEqual(headers, { 'Content-Type': 'application/json', 'X-Scout-Client': 'cli', 'X-Scout-Analytics': 'on' });
      return JSON.parse(body);
    });
    const id = bodies[0].anonymousId;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(id, previousId); previousId = id;
    const common = { ...clientEnvironment, command_id: bodies[0].properties.command_id };
    assert.match(common.command_id, /^[0-9a-f-]{36}$/);
    assert.ok(bodies.every(body => setupUUID(body.event_id)));
    assert.notEqual(bodies[0].event_id, bodies[1].event_id);
    assert.deepEqual(bodies[0], { event: 'cli_command_started', event_id: bodies[0].event_id, anonymousId: id, properties: { command, ...common } });
    const duration = bodies[1].properties.duration_ms;
    assert.ok(Number.isInteger(duration) && duration >= 0 && duration <= 86400000);
    const diagnostic = outcome === 'ok' ? {} : { code: 'command_error', error_type: 'Error', frames: bodies[1].properties.frames };
    if (outcome === 'error') assert.ok(diagnostic.frames.some(f => f.filename === 'cli.mjs'));
    assert.deepEqual(bodies[1], { event: 'cli_command_completed', event_id: bodies[1].event_id, anonymousId: id, properties: { command, outcome, ...diagnostic, duration_ms: duration, ...common } });
    assert.doesNotMatch(JSON.stringify(bodies), /private-|secret|@example|\/Users\/|file:\/\//);
  }
});

test('installation telemetry projects only exact lifecycle enums, UUID v4 identities and booleans', () => {
  const id = '359afdd2-0e4e-4f5b-9a91-2213814b1234';
  const allowed = { stage: 'status', outcome: 'conflict', agent: 'claude-code', scope: 'project', setup_id: id, installation_id: id,
    applied: false, installed: false, rule_status: 'matches', skill_status: 'missing', server_status: 'modified_or_unowned', connection: 'not_checked', code: 'install_conflict' };
  assert.deepEqual(installationProperties({ ...allowed, root: 'PRIVATE', message: 'PRIVATE', key: 'PRIVATE', prompt: 'PRIVATE' }), allowed);
  assert.deepEqual(installationProperties({ stage: 'started', outcome: 'started', setup_id: 'PRIVATE', installation_id: id.replace('-4f5b-', '-1f5b-'), installed: 'true' }), { stage: 'started', outcome: 'started' });
  for (const invalid of [null, [], {}, { ...allowed, stage: 'PRIVATE' }, { ...allowed, outcome: 'success' }, { ...allowed, scope: 'PRIVATE' }, { ...allowed, connection: 'PRIVATE' }, { ...allowed, rule_status: 'PRIVATE' }, { ...allowed, code: 'PRIVATE' }]) assert.equal(installationProperties(invalid), null);
});

test('network errors and hung transport are silent, bounded, and preserve JSON and exit status', async () => {
  for (const mode of ['fail', 'hang', 'http-error']) {
    const started = performance.now();
    const result = await run(['dash', '--demo', '--diagnostics'], { OPENMERIT_TELEMETRY: '1' }, mode);
    assert.ok(performance.now() - started < 3000);
    assert.equal(result.code, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.equal(result.stderr, '');
    assert.equal(result.events.length, 2);
    const failure = await run(['unknown'], { OPENMERIT_TELEMETRY: '1' }, mode);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Unknown command/);
    assert.doesNotMatch(failure.stderr, /network failure/);
  }
});

test('long-running dash completes telemetry at startup, before the server stops', async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const result = await run(['dash', '--demo', '--no-open', '--port', String(port)], { OPENMERIT_TELEMETRY: '1' }, 'ok', true);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Press Ctrl\+C to close/);
  assert.equal(result.stderr, '');
  assert.equal(result.events.length, 2);
  assert.equal(JSON.parse(result.events[1].body).properties.outcome, 'ok');
});

test('Scout requests identify the CLI and propagate explicit analytics consent', async () => {
  const { makePlan } = await import('../../eval/src/scout.mjs');
  const saved = { telemetry: process.env.OPENMERIT_TELEMETRY, dnt: process.env.DO_NOT_TRACK };
  try {
    for (const [telemetry, dnt, expected] of [['', '', 'off'], ['true', '', 'off'], ['1', '', 'on'], ['1', '1', 'off']]) {
      process.env.OPENMERIT_TELEMETRY = telemetry; process.env.DO_NOT_TRACK = dnt;
      await makePlan({ scope: 'all', connections: [], tasks: [{ id: 'task', description: 'private task' }] }, async (url, options) => {
        assert.equal(options.headers['X-Scout-Client'], 'cli');
        assert.equal(options.headers['X-Scout-Analytics-Content'], 'off');
        assert.equal(options.headers['X-Scout-Analytics'], expected);
        return { ok: true, json: async () => ({ recommendations: [] }) };
      });
    }
  } finally {
    for (const [key, value] of [['OPENMERIT_TELEMETRY', saved.telemetry], ['DO_NOT_TRACK', saved.dnt]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
