#!/usr/bin/env node
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { startTerminal } from './server.mjs';
import { createCollector, loadConfig } from './collect.mjs';
import { sampleSnapshot } from './sample.mjs';

const help = `OpenMerit · Inference Terminal

  openmerit dash [path] [options]

  --port <number>      Local port (default: 4310)
  --interval <seconds> Collection interval, 10–30 (default: 15)
  --json               Print one snapshot for an agent, then exit
  --demo               Explore a clearly labeled fictional environment
  --help               Show this help

Reads project metadata and local runtime inventory. Makes no inference calls.
`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  if (args.shift() !== 'dash') throw new Error('Unknown command. Run openmerit --help.');
  let root = process.cwd(), port = 4310, interval = 15, demo = false, json = false, pathSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '--interval') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Error(`${arg} requires an integer.`);
      if (arg === '--port') port = Number(value); else interval = Number(value);
    } else if (arg === '--demo') demo = true;
    else if (arg === '--json') json = true;
    else if (!arg.startsWith('-') && !pathSeen) { root = resolve(arg); pathSeen = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (interval < 10 || interval > 30) throw new Error('Collection interval must be between 10 and 30 seconds.');
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project directory.');
  if (json) { console.log(JSON.stringify(demo ? sampleSnapshot() : await createCollector(root, await loadConfig(root), interval)(), null, 2)); return; }
  const terminal = await startTerminal({ root, port, interval, demo });
  console.log(`\n  OpenMerit · Inference Terminal\n\n  ${terminal.url}\n\n  ${demo ? 'Sample environment · fictional data' : 'Current project · passive collection'}\n  Updates every ${interval}s. Press Ctrl+C to close.\n`);
  const close = () => { void terminal.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
main().catch(error => { console.error(`\n  ${error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message}\n`); process.exitCode = 1; });
