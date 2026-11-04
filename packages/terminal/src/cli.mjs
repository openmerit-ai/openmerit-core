#!/usr/bin/env node
import { commandTelemetry } from './telemetry.mjs';

const help = `OpenMerit

  openmerit scout --help             Ask Scout which models fit your tasks
  openmerit install --help           Connect OpenMerit to your coding agent
  openmerit update --help            Update installed Scout instructions
  openmerit --help                   Show this help
`;

async function main() {
  const args = process.argv.slice(2);
  if (['install', 'status', 'remove', 'login', 'logout', 'project', 'doctor', 'update'].includes(args[0])) { const { main } = await import('./install.mjs'); process.exitCode = await main(args); return; }
  if (args[0] === 'scout') { const { main } = await import('./scout.ts'); process.exitCode = await main(args.slice(1)); return; }
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  throw new Error('Unknown command. Run openmerit --help.');
}
const completeTelemetry = commandTelemetry(process.argv.slice(2));
const setupCodes = { 10: 'approval_pending', 11: 'access_denied', 20: 'install_conflict', 30: 'openmerit_unreachable' };
main().then(() => completeTelemetry(process.exitCode ? 'error' : 'ok', undefined, setupCodes[process.exitCode]), async error => {
  console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
  await completeTelemetry('error', error);
});
