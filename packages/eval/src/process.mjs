import { spawn } from 'node:child_process';

// No shell interpolation. Bound both time and output, and stop descendants too.
export function execute(command, args, { cwd, env = process.env, input = '', timeoutMs = 180_000, signal } = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    let stdout = '', stderr = '', bytes = 0, reason = null, escalation;
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = sig => {
      try {
        if (process.platform === 'win32') { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); killer.on('error', () => child.kill(sig)); }
        else process.kill(-child.pid, sig);
      } catch {}
    };
    const stop = why => { if (reason) return; reason = why; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 500); };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (chunk, which) => {
      bytes += chunk.length;
      if (bytes > 4_000_000) return stop('output_limit');
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => collect(chunk, 'out'));
    child.stderr.on('data', chunk => collect(chunk, 'err'));
    child.on('error', () => { reason = 'spawn_failed'; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      resolve({ code, reason, stdout, stderr, seconds: (performance.now() - start) / 1000 });
    });
  });
}

export function agentEnvironment(names = []) {
  const result = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM', ...names]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  result.OPENMERIT_EVAL = '1';
  return result;
}
