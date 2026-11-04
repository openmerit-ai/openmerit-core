import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { errorProperties, safeFrames, installationProperties, setupUUID } from '../src/telemetry.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url);
const clientEnvironment = {client_version:JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version,platform:process.platform,runtime_major:Number(process.versions.node.split('.')[0])};
test('diagnostics keep only application basenames and coordinates', () => {
  const app = new URL('../src/cli.mjs', import.meta.url).href;
  const error = new TypeError('PRIVATE text /home/user/secret');
  error.stack = `TypeError: PRIVATE\n    at secretFunction (${app}:12:3)\n    at privateFunction (file:///home/user/cli.mjs:22:4)\n    at PRIVATE (file:///home/user/task.js:4:8)`;
  assert.deepEqual(safeFrames(error), [{filename:'cli.mjs',lineno:12,colno:3}]);
  assert.deepEqual(errorProperties({get name(){throw Error('PRIVATE');}}), {error_type:'Error',frames:[]});
});

async function run(args, env = {}, mode = 'ok') {
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
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(deadline);
  const events = stderr.split('\n').filter(line => line.startsWith('TELEMETRY:')).map(line => JSON.parse(line.slice(10)));
  return { code, stdout, stderr: stderr.split('\n').filter(line => !line.startsWith('TELEMETRY:')).join('\n'), events };
}

test('CLI telemetry is default-off, exact opt-in only, and DO_NOT_TRACK overrides consent', async () => {
  for (const env of [{}, { OPENMERIT_TELEMETRY: '0' }, { OPENMERIT_TELEMETRY: 'true' }, { OPENMERIT_TELEMETRY: '1', DO_NOT_TRACK: '1' }]) {
    const result = await run(['--help'], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /openmerit scout/);
    assert.deepEqual(result.events, []);
    assert.equal(result.stderr, '');
  }
});

test('Scout setup CLI analytics defaults on without enabling evaluation analytics or bypassing opt-outs', async () => {
  for (const [args, env, enabled] of [
    [['install', '--help'], {}, true],
    [['install', '--help'], { OPENMERIT_TELEMETRY: '0' }, false],
    [['install', '--help'], { DO_NOT_TRACK: '1' }, false],
    [['eval', '--help'], {}, false],
  ]) {
    const result = await run(args, env);
    assert.equal(result.code, 0);
    assert.deepEqual(result.events.map(e => JSON.parse(e.body)).filter(e => e.event !== 'scout_installation_step').map(e => e.event),
      enabled ? ['cli_command_started', 'cli_command_completed'] : []);
    if (!enabled) assert.deepEqual(result.events, []);
  }
});

test('opted-in CLI sends only allowlisted payloads with ephemeral UUID identity', async () => {
  let previousId;
  for (const [args, command, outcome] of [
    [[], 'help', 'ok'], [['eval', '--help'], 'help', 'ok'],
    [['dash'], 'unknown', 'error'],
    [['private-prompt-model@example.org'], 'unknown', 'error'],
    ...['init', 'doctor', 'plan', 'run', 'watch', 'report'].map(action => [['eval', action, '--private-secret'], 'unknown', 'error']),
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

test('network errors and hung transport are silent, bounded, and preserve output and exit status', async () => {
  for (const mode of ['fail', 'hang', 'http-error']) {
    const started = performance.now();
    const result = await run(['--help'], { OPENMERIT_TELEMETRY: '1' }, mode);
    assert.ok(performance.now() - started < 3000);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /openmerit scout/);
    assert.equal(result.stderr, '');
    assert.equal(result.events.length, 2);
    const failure = await run(['unknown'], { OPENMERIT_TELEMETRY: '1' }, mode);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Unknown command/);
    assert.doesNotMatch(failure.stderr, /network failure/);
  }
});
