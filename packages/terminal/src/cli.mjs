#!/usr/bin/env node
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { startTerminal } from './server.mjs';
import { createCollector, loadConfig } from './collect.mjs';
import { createAccess } from './access.mjs';
import { createInterface } from 'node:readline/promises';
import { sampleSnapshot } from './sample.mjs';

const help = `OpenMerit · Inference Terminal

  openmerit dash [path] [options]

  --port <number>      Local port (default: 4310)
  --interval <seconds> Collection interval, 10–30 (default: 15)
  --no-discovery       Skip project scan, extra runtime discovery, and Pi history
  --access             Review optional access for this project, then exit
  --revoke-access      Revoke Pi history access for this project
  --json               Print one snapshot for an agent, then exit
  --demo               Explore a clearly labeled fictional environment
  --help               Show this help

Reads project metadata and local runtime inventory. Makes no inference calls.
`;

async function reviewHistoryAccess(access) {
  const permission = await access.status();
  if (!['allowed', 'denied', 'needs_access'].includes(permission.state)) {
    console.log('  No readable Pi history directory was found for this project.');
    return;
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n  Pi history is available for this project at:\n  ${permission.path}\n  Session files contain messages. Only models, request counts, tokens, and estimated costs will be retained.\n  This choice is remembered for this project; revoke with openmerit dash --revoke-access.\n`);
    const answer = await input.question('  Allow Pi usage metadata? [y/N] ');
    await access.set(/^y(?:es)?$/i.test(answer.trim()));
    console.log('  Access choice saved. Running terminals apply it on their next poll.\n');
  } finally { input.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  if (args.shift() !== 'dash') throw new Error('Unknown command. Run openmerit --help.');
  let root = process.cwd(), port = 4310, interval = 15, demo = false, json = false, pathSeen = false, discovery = true, reviewAccess = false, revokeAccess = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '--interval') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Error(`${arg} requires an integer.`);
      if (arg === '--port') port = Number(value); else interval = Number(value);
    } else if (arg === '--no-discovery') discovery = false;
    else if (arg === '--access') reviewAccess = true;
    else if (arg === '--revoke-access') revokeAccess = true;
    else if (arg === '--demo') demo = true;
    else if (arg === '--json') json = true;
    else if (!arg.startsWith('-') && !pathSeen) { root = resolve(arg); pathSeen = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (interval < 10 || interval > 30) throw new Error('Collection interval must be between 10 and 30 seconds.');
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project directory.');
  const config = demo ? null : await loadConfig(root);
  if (config && !discovery) config.discovery = false;
  const access = createAccess(root);
  if (demo && (reviewAccess || revokeAccess)) throw new Error('Sample mode has no environment permissions.');
  if (reviewAccess && (!process.stdin.isTTY || json)) throw new Error('Run --access in an interactive terminal without --json.');
  if (reviewAccess && revokeAccess) throw new Error('Choose --access or --revoke-access.');
  if (revokeAccess && json) throw new Error('Run --revoke-access without --json.');
  if (reviewAccess && !config.discovery) throw new Error('Enable discovery before reviewing history access.');
  if (revokeAccess) { await access.set(false); console.log('Pi history access revoked for this project. Running terminals apply the change on their next poll.'); return; }
  if (reviewAccess) { await reviewHistoryAccess(access); return; }
  if (json) { console.log(JSON.stringify(demo ? sampleSnapshot() : await createCollector(root, config, interval, { access })(), null, 2)); return; }
  const terminal = await startTerminal({ root, port, interval, demo, config, access });
  console.log(`\n  OpenMerit · Inference Terminal\n\n  ${terminal.url}\n\n  ${demo ? 'Sample environment · fictional data' : 'Current project · passive collection'}\n  Updates every ${interval}s. Press Ctrl+C to close.\n`);
  const close = () => { void terminal.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  if (!demo && config.discovery) {
    console.log('  Automatic discovery: project declarations, local runtimes, and machine readings.');
    const permission = await access.status();
    if (process.stdin.isTTY && permission.state === 'needs_access') {
      try { await reviewHistoryAccess(access); }
      catch { console.error('  Access was not saved. Collection continues within its existing permissions.'); }
    } else if (permission.state === 'needs_access') console.log('  Pi history needs access. Run openmerit dash --access in an interactive terminal.');
  }
}
main().catch(error => { console.error(`\n  ${error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message}\n`); process.exitCode = 1; });
