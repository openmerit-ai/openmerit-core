#!/usr/bin/env node
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { startTerminal } from './server.mjs';
import { createCollector, loadConfig } from './collect.mjs';
import { sampleSnapshot } from './sample.mjs';
import { openBrowser } from './browser.mjs';
import { commandTelemetry } from './telemetry.mjs';

const help = `OpenMerit · Inference Terminal

  openmerit dash [path] [options]
  openmerit scout --help             Ask Scout which models fit your tasks
  openmerit install --help           Connect OpenMerit to your coding agent
  openmerit update --help            Update installed Scout instructions
  openmerit eval --help              Evaluate CLI changes across coding agents

  --port <number>      Require a specific local port (default: 4310 or a free port)
  --interval <seconds> Collection interval, 10–30 (default: 15)
  --no-discovery       Skip project/log discovery and extra runtime discovery
  --no-open            Print the URL without opening a browser
  --json               Print one snapshot for an agent, then exit
  --diagnostics        Print shareable index coverage counts, then exit
  --demo               Explore a clearly labeled fictional environment
  --help               Show this help

Opens your default browser after the local terminal is ready.
Reads application metadata and local runtime inventory. Makes no inference calls.
Coding-harness usage is outside this terminal's scope.
`;

async function main() {
  const args = process.argv.slice(2);
  if (['install', 'status', 'remove', 'login', 'logout', 'project', 'doctor', 'update'].includes(args[0])) { const { main } = await import('./install.mjs'); process.exitCode = await main(args); return; }
  if (args[0] === 'scout') { const { main } = await import('./scout.ts'); process.exitCode = await main(args.slice(1)); return; }
  if (args[0] === 'eval') { const { main } = await import('../../eval/src/cli.mjs'); await main(args.slice(1)); return; }
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  if (args.shift() !== 'dash') throw new Error('Unknown command. Run openmerit --help.');
  let root = process.cwd(), port = 4310, interval = 15, demo = false, json = false, pathSeen = false, discovery = true, noOpen = false, explicitPort = false, diagnostics = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '--interval') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Error(`${arg} requires an integer.`);
      if (arg === '--port') { port = Number(value); explicitPort = true; } else interval = Number(value);
    } else if (arg === '--no-open') noOpen = true;
    else if (arg === '--no-discovery') discovery = false;
    else if (arg === '--demo') demo = true;
    else if (arg === '--json') json = true;
    else if (arg === '--diagnostics') diagnostics = true;
    else if (!arg.startsWith('-') && !pathSeen) { root = resolve(arg); pathSeen = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (interval < 10 || interval > 30) throw new Error('Collection interval must be between 10 and 30 seconds.');
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project directory.');
  const config = demo ? null : await loadConfig(root);
  if (config && !discovery) config.discovery = false;
  if (diagnostics) { const {indexRepository,indexDiagnostics}=await import('./repository-index.mjs'); const index = !demo && config.discovery ? await indexRepository(root) : null; console.log(JSON.stringify(indexDiagnostics(index), null, 2)); return; }
  if (json) { console.log(JSON.stringify(demo ? sampleSnapshot() : await createCollector(root, config, interval)(), null, 2)); return; }
  const terminal = await startTerminal({ root, port, interval, demo, config, fallbackPort: !explicitPort });
  console.log(`\n  OpenMerit · Inference Terminal\n\n  ${terminal.url}\n\n  ${demo ? 'Sample environment · fictional data' : 'Current project · passive collection'}\n  Updates every ${interval}s. Press Ctrl+C to close.\n`);
  const close = () => { void terminal.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  if (!demo && config.discovery) {
    console.log('  Automatic discovery: repository code/configuration, saved request logs, and project-linked runtimes.');
  }
  if (!noOpen && !await openBrowser(terminal.url)) console.log('  Open the local URL above in your browser.');
}
const completeTelemetry = commandTelemetry(process.argv.slice(2));
const setupCodes = { 10: 'approval_pending', 11: 'access_denied', 20: 'install_conflict', 30: 'openmerit_unreachable' };
main().then(() => completeTelemetry(process.exitCode ? 'error' : 'ok', undefined, setupCodes[process.exitCode]), async error => {
  console.error(`\n  ${error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message}\n`);
  process.exitCode = 1;
  await completeTelemetry('error', error);
});
