import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { browserCommand, openBrowser } from '../src/browser.mjs';
import { startTerminal } from '../src/server.mjs';

const url = 'http://127.0.0.1:4310';

test('browser launch uses platform defaults and never invokes a shell or opens remote URLs', async () => {
  assert.deepEqual(browserCommand('http://127.0.0.1:80', 'darwin', {}), ['open', ['http://127.0.0.1:80']]);
  assert.deepEqual(browserCommand(url, 'darwin', {}), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'win32', {}), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }), ['xdg-open', [url]]);
  for (const value of ['https://example.org', 'file:///etc/passwd', 'http://user:pass@127.0.0.1:4310', 'http://127.0.0.1:4310/?command=bad', 'http://127.0.0.1:4310/something']) assert.throws(() => browserCommand(value, 'darwin', {}));
  let launches = 0;
  assert.equal(await openBrowser(url, { platform: 'darwin', env: {}, spawnProcess: (command, args, options) => {
    launches++;
    assert.equal(command, 'open'); assert.deepEqual(args, [url]); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  } }), true);
  assert.equal(launches, 1);
});

test('headless sessions and opener failures preserve the manual URL path', async () => {
  const noSpawn = () => assert.fail('Headless sessions must not launch a browser');
  for (const [platform, env] of [['linux', {}], ['darwin', { SSH_CONNECTION: 'test' }], ['linux', { DISPLAY: ':0', SSH_TTY: '/dev/pts/0' }]]) {
    assert.equal(await openBrowser(url, { platform, env, spawnProcess: noSpawn }), false);
  }
  for (const failure of ['error', 'exit']) assert.equal(await openBrowser(url, { platform: 'darwin', env: {}, spawnProcess: () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit(failure, failure === 'exit' ? 1 : new Error('opener missing')));
    return child;
  } }), false);
});

test('busy default ports fall back to loopback and keep collection running; explicit ports fail', async t => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  let samples = 0;
  const collect = async () => ({ mode: 'live', records: [], sequence: ++samples });
  await assert.rejects(startTerminal({ port, collect }), { code: 'EADDRINUSE' });
  const terminal = await startTerminal({ port, collect, interval: 0.02, fallbackPort: true });
  t.after(() => terminal.close());
  assert.equal(terminal.server.address().address, '127.0.0.1');
  assert.notEqual(terminal.server.address().port, port);
  const first = await (await fetch(`${terminal.url}/api/snapshot`)).json();
  await delay(70);
  const next = await (await fetch(`${terminal.url}/api/snapshot`)).json();
  assert.ok(next.sequence > first.sequence);
});
