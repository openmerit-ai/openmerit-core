import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { credentialsPath, readCredentials } from './scout-credentials.ts';
import { openBrowser } from './browser.mjs';
import { main as install } from './install.mjs';

const help = `OpenMerit · Langfuse connections (unreleased)

  openmerit connect langfuse                       Open the optional web UI
  openmerit connect langfuse --authorize [--no-open] [--json]
  openmerit connect langfuse --config mappings.json [--json]
  openmerit connect langfuse --stdin [--json]
  openmerit connect langfuse --status|--sync [--json]
  openmerit disconnect langfuse --yes [--json]
  openmerit disconnect langfuse --delete-all --yes [--json]

Authorize a separate connection-manager key once. First-time approval still
requires account sign-in; --no-open prints a link for approval on any device.
Rerun --authorize if pending (exit 10). This never replaces recommendation keys.
The management key is saved separately with owner-only file permissions.

--config reads non-secret region, from (YYYY-MM-DD), tagPrefix, mappings and models.
Supply LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY through a secret manager.
--stdin reads the full JSON settings including the Viewer key pair from a protected
pipe (maximum 18 KB), never echoes them, and does not save them locally.
Never put keys in arguments, chat, shell history or a tracked file. Use a separate
Viewer key, not tracing keys. OPENMERIT_CONNECTION_KEY can supply an already
approved management key to unattended jobs; otherwise the saved key is used.

Disconnect deletes the key pair and imports, not reported results or conversations.
--delete-all also removes reported results. Both require --yes for headless use.
Without --yes, disconnect opens the optional browser confirmation.
`;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
async function settings(file: string | undefined, stdin: boolean, root: string): Promise<Record<string, unknown>> {
  let text = '';
  if (stdin) {
    if (process.stdin.isTTY) throw new Error('--stdin requires a protected JSON pipe, not interactive key entry.');
    process.stdin.setEncoding('utf8');
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 18_000) throw new Error('Connection settings exceed 18 KB.');
      text += String(chunk);
    }
  } else {
    try { text = await readFile(resolve(root, file ?? ''), 'utf8'); }
    catch { throw new Error('Could not read connection settings.'); }
  }
  if (Buffer.byteLength(text) > 18_000) throw new Error('Connection settings exceed 18 KB.');
  let config: unknown;
  try { config = JSON.parse(text); } catch { throw new Error('Connection settings must be a JSON object.'); }
  const fields = ['region', 'from', 'tagPrefix', 'mappings', 'models', ...(stdin ? ['publicKey', 'secretKey'] : [])];
  if (!object(config) || Object.keys(config).some(key => !fields.includes(key))) throw new Error('Use non-secret settings in --config; credentials must come from a secret manager or --stdin.');
  if (!stdin) config = { ...config, publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY };
  if (!object(config) || typeof config.publicKey !== 'string' || typeof config.secretKey !== 'string' || !config.publicKey || !config.secretKey) throw new Error('Supply a separate Viewer key pair through a secret manager or --stdin.');
  return config;
}

export async function connection(args: string[], { root = process.cwd(), print = console.log, printError = console.error } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { print(help); return 0; }
  const [command, provider, ...flags] = args;
  if (!['connect', 'disconnect'].includes(command ?? '') || provider !== 'langfuse') throw new Error('Use openmerit connect langfuse --help.');
  let file: string | undefined;
  const options = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    if (options.has(flag)) throw new Error('Duplicate connection option.');
    options.add(flag);
    if (flag === '--config') {
      file = flags[++i];
      if (!file || file.startsWith('-')) throw new Error('--config needs a settings file.');
    } else if (!['--stdin', '--authorize', '--no-open', '--status', '--sync', '--yes', '--delete-all', '--json'].includes(flag)) throw new Error('Unknown connection option. Use --help; never pass keys as arguments.');
  }
  const operation = ['--config', '--stdin', '--authorize', '--status', '--sync'].filter(flag => options.has(flag));
  if (operation.length > 1 || command === 'disconnect' && operation.length || command === 'connect' && (options.has('--yes') || options.has('--delete-all'))
    || options.has('--no-open') && !options.has('--authorize')) throw new Error('Choose one connection action. Use --help.');
  if (options.has('--delete-all') && !options.has('--yes')) throw new Error('--delete-all requires --yes.');
  if (options.has('--authorize')) return install(['login', '--client', 'connector', '--scope', 'user', ...(options.has('--no-open') ? ['--no-open'] : []), ...(options.has('--json') ? ['--json'] : [])], { root, print, printError });
  if (!operation.length && !options.has('--yes')) {
    const url = 'https://openmerit.ai/connect/?integration=langfuse';
    print(`Manage Langfuse in your signed-in browser: ${url}`);
    await openBrowser(url, { allowed: (value: string) => value === url }).catch(() => false);
    return 0;
  }
  const server = (process.env.OPENMERIT_URL ?? 'https://openmerit.ai').replace(/\/+$/, '');
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS OpenMerit origin, or localhost for development.');
  const credentials = readCredentials(credentialsPath('connector', 'user', root));
  const key = process.env.OPENMERIT_CONNECTION_KEY ?? (credentials?.server === server ? credentials.key : undefined);
  if (!key || !/^om_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Authorize connection management first: openmerit connect langfuse --authorize --no-open');
  // Read secrets only after authorization. No credential values reach stdout,
  // local files, tool arguments, analytics or errors, even on malformed input.
  const config = file || options.has('--stdin') ? await settings(file, options.has('--stdin'), root) : undefined;
  const path = options.has('--delete-all') ? 'evaluations' : options.has('--sync') ? 'langfuse/sync' : 'langfuse';
  const method = command === 'disconnect' ? 'DELETE' : config || options.has('--sync') ? 'POST' : 'GET';
  let response: Response;
  try {
    response = await fetch(`${server}/connect/api/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, ...(config ? { 'Content-Type': 'application/json' } : {}), 'X-Scout-Analytics': 'off' },
      ...(config ? { body: JSON.stringify(config) } : {}),
    });
  } catch { throw new Error('Could not reach OpenMerit. Check connection status before retrying a change.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? 'Management key rejected. Run openmerit connect langfuse --authorize --no-open.'
      : `Connection request failed (HTTP ${response.status}). Check Viewer permissions, region and mappings; check status before retrying.`);
  }
  const value: unknown = await response.json();
  if (!object(value)) throw new Error('OpenMerit returned an invalid connection response.');
  const state = Object.fromEntries(Object.entries(value).filter(([name]) => ['connected', 'connectedAt', 'syncedAt', 'experiments', 'unmapped', 'results', 'busy', 'cached', 'deleted'].includes(name)));
  print(JSON.stringify(state, null, 2));
  return 0;
}
