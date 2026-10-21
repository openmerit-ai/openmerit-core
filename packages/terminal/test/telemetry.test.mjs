import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const cli = new URL('../src/cli.mjs', import.meta.url);
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
      assert.deepEqual(headers, { 'Content-Type': 'application/json' });
      return JSON.parse(body);
    });
    const id = bodies[0].anonymousId;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(id, previousId); previousId = id;
    assert.deepEqual(bodies[0], { event: 'cli_command_started', anonymousId: id, properties: { command } });
    const duration = bodies[1].properties.duration_ms;
    assert.ok(Number.isInteger(duration) && duration >= 0 && duration <= 86400000);
    assert.deepEqual(bodies[1], { event: 'cli_command_completed', anonymousId: id, properties: { command, outcome, duration_ms: duration } });
  }
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
