import { randomUUID } from 'node:crypto';

// Consent is independent of terminal discovery. Never persist an identity.
export function commandTelemetry(args) {
  if (process.env.OPENMERIT_TELEMETRY !== '1' || process.env.DO_NOT_TRACK === '1') return async () => {};
  const anonymousId = randomUUID();
  const started = performance.now();
  const actions = ['init', 'doctor', 'plan', 'run', 'watch', 'report'];
  const command = !args.length || args.includes('--help') || args.includes('-h') || args[0] === 'eval' && args.length === 1
    ? 'help' : args[0] === 'dash' ? 'dash' : args[0] === 'eval' && actions.includes(args[1]) ? `eval_${args[1]}` : 'unknown';
  async function send(event, properties) {
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => fetch('https://openmerit.ai/scout/api/analytics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, anonymousId, properties }),
          signal: controller.signal, redirect: 'error',
        })).then(response => response.body?.cancel()),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 750); }),
      ]);
    } catch { /* Analytics must never affect command behavior. */ }
    finally { clearTimeout(timer); }
  }
  const pending = send('cli_command_started', { command });
  return async outcome => {
    await Promise.all([pending, send('cli_command_completed', {
      command, outcome: outcome === 'ok' ? 'ok' : 'error',
      duration_ms: Math.min(86400000, Math.max(0, Math.round(performance.now() - started))),
    })]);
  };
}
