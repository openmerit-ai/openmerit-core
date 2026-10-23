import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const defaultURL = 'https://openmerit.ai/scout/mcp?agent=claude-code';
const policyPath = '.openmerit/scout.json';
const instructions = `# OpenMerit · Scout

Before introducing, recommending, replacing or configuring an application inference
model, use OpenMerit's scout_models MCP tool. Discover it through tool search if
needed. This applies when implementing features such as extraction, classification,
generation or agent workflows even if the user never mentions Scout. Do not run
model discovery for unrelated edits or each ordinary inference request. Preserve
the user's explicit model choice; assess it rather than silently replacing it.

Read .openmerit/scout.json in the current project before searching. If absent, ask
once to confirm existing-only or existing-first and the project's accessible
catalogue endpoint IDs, then save that choice with openmerit agent project.
Never infer endpoint access from a model name, SDK or environment-variable name.
Record only user-confirmed or verified endpoint IDs; never credentials, private
URLs, prompts or fixture contents. An empty inventory is not permission to search
all models. If no inventory is known, ask before unscoped discovery.

For either policy, first call scout_models with a non-confidential task description
and endpointIds set to the saved existing inventory, including [] when empty.
Existing-only must never broaden. For existing-first, if no existing candidate
meets the requirements, explain the gap and ask before a separate unscoped search.
Newly discovered endpoints are not authorized or authenticated connections.
Send only task requirements and catalogue IDs to Scout, never source files,
secrets, private endpoint addresses or actual customer records.

Compare the returned model AND endpoint, evidence, reference cost/time, unknowns
and warnings. For multiple tasks read tasks[].slots[0].recommendations, not the
empty top-level list. Prefer the lowest-cost usable option supported by the task's
quality evidence, but do not claim benchmarks establish application accuracy.
Explain why the selected route fits, whether access is verified and what remains
untested. Inspect the project's SDK/protocol and use the returned provider model
ID and deployment requirements; do not assume every model supports chat APIs.

Help configure the selected route within existing permissions. Ask separately
before new providers, credentials, paid evaluations, deployments or external
writes. Verify configuration and an authorized application check before claiming
success; recommendations, connectivity and task correctness are separate results.
Do not switch the model powering this coding agent or an approved production
model automatically. Unchanged approved application selections stay in place.

If Scout fails, disclose the failure and pause the model decision; do not silently
substitute a remembered recommendation. For authentication, use /mcp to authorize
the openmerit server through the browser. Claude Code owns OAuth storage and
renewal. Never copy browser session tokens, read browser credentials, or put tokens
in chat, source files or version control. Do not weaken permissions to reconnect.

Only Scout is installed. Hosted evidence/ranking updates arrive through the same
OpenMerit connection. Reconnect to refresh cached tool definitions when needed.
Update installed instructions with openmerit agent install after reviewing the
proposed change. New capabilities do not grant new permissions. These are default
instructions, not an enforcement hook or a guarantee of universal invocation.
`;

export const help = `OpenMerit · Scout in your coding agent (source preview)

  openmerit agent install claude-code --scope user|project [--yes]
                         [--client-id <public ID> --callback-port <port>]
  openmerit agent status claude-code --scope user|project [--check]
  openmerit agent remove claude-code --scope user|project [--yes]
  openmerit agent project --policy existing-only|existing-first
                         [--endpoint-id <catalogue ID> ...] [--yes]

Without --yes, install/remove/project print a plan and change nothing.
User scope persists across projects; project scope needs Claude's workspace trust.
Install preserves other servers/rules. Repeating it repairs missing owned files
or updates unchanged owned instructions; it never overwrites user modifications.
Then open Claude Code, use /mcp to authorize openmerit, and verify a Scout search.
Status --check asks Claude Code to check the connection; it does not run a search.
No tokens, provider keys, paid evaluations, hooks or background services are added.
Hosted OAuth must be enabled by the operator. Other clients remain manual setup.
`;

async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function object(path) {
  const text = await optional(path);
  if (text === null) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${path}; nothing was overwritten.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object in ${path}.`);
  return value;
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function locations(root, scope) {
  const config = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const base = scope === 'user' ? config : join(root, '.claude');
  return {
    rule: join(base, 'rules/openmerit.md'), record: join(base, 'openmerit-install.json'),
    mcp: scope === 'user' ? process.env.CLAUDE_CONFIG_DIR ? join(config, '.claude.json') : join(homedir(), '.claude.json') : join(root, '.mcp.json'),
  };
}
async function claude(args, root) {
  try { return await exec('claude', args, { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  catch (error) {
    // Native output can include unrelated configuration or credentials. Never echo it.
    throw new Error(error.code === 'ENOENT' ? 'Install Claude Code first, then retry.' : 'Claude Code could not complete this operation. Check /mcp; no connection success is claimed.');
  }
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/scout/mcp' || [...url.searchParams.keys()].some(k => !['agent', 'analytics'].includes(k))) throw new Error('Use an HTTPS /scout/mcp endpoint with only public agent/analytics query parameters.');
  return url.href;
}

export async function main(args, { root = process.cwd(), print = console.log } = {}) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { print(help); return; }
  const [action, ...rest] = args;
  if (!['install', 'status', 'remove', 'project'].includes(action)) throw new Error('Unknown agent action. Run openmerit agent --help.');
  let scope, yes = false, check = false, url, policy, clientId, callbackPort;
  const ids = [];
  if (action !== 'project' && rest.shift() !== 'claude-code') throw new Error('Only claude-code has an installer in this preview.');
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (option === '--scope' && action !== 'project') scope = rest[++i];
    else if (option === '--yes' && action !== 'status') yes = true;
    else if (option === '--check' && action === 'status') check = true;
    else if (option === '--url' && action === 'install') url = endpoint(rest[++i]);
    else if (option === '--client-id' && action === 'install') {
      clientId = rest[++i];
      if (!clientId || !/^[a-zA-Z0-9._:-]{1,200}$/.test(clientId)) throw new Error('Use the operator-provided public OAuth client ID, never a client secret.');
    }
    else if (option === '--callback-port' && action === 'install') {
      callbackPort = Number(rest[++i]);
      if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) throw new Error('Use the registered OAuth callback port between 1 and 65535.');
    }
    else if (option === '--policy' && action === 'project') policy = rest[++i];
    else if (option === '--endpoint-id' && action === 'project') ids.push(rest[++i]);
    else throw new Error(`Unknown or misplaced option: ${option}`);
  }
  if ((clientId !== undefined) !== (callbackPort !== undefined)) throw new Error('Provide both --client-id and --callback-port for a pre-registered public OAuth client.');
  root = resolve(root);
  if (action === 'project') {
    if (!['existing-only', 'existing-first'].includes(policy)) throw new Error('Choose --policy existing-only or existing-first explicitly.');
    if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || id.includes('://') || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,159}$/.test(id))) throw new Error('Use up to 100 unique public catalogue endpoint IDs, never credentials or URLs.');
    const value = { version: 1, policy, endpointIds: ids };
    const file = join(root, policyPath), existing = await object(file);
    if (Object.keys(existing).some(key => !['version', 'policy', 'endpointIds'].includes(key))) throw new Error('Existing Scout policy has unrecognized fields; edit it explicitly instead of overwriting it.');
    if (yes) await save(file, value);
    print(JSON.stringify({ action, saved: yes, path: policyPath, policy: value, permissions: 'Discovery only; endpoint IDs do not prove access or authorize spending.' }, null, 2));
    return;
  }
  if (!['user', 'project'].includes(scope)) throw new Error('Choose --scope user or --scope project explicitly.');
  const paths = locations(root, scope);
  const record = await object(paths.record), config = await object(paths.mcp), rule = await optional(paths.rule);
  const server = config.mcpServers?.openmerit;
  const userConfig = scope === 'user' ? config : await object(locations(root, 'user').mcp);
  const otherConfig = scope === 'project' ? userConfig : await object(locations(root, 'project').mcp);
  const shadowed = !!(otherConfig.mcpServers?.openmerit || userConfig.projects?.[root]?.mcpServers?.openmerit);
  const owned = record.version === 1 && record.scope === scope;
  const ruleMatches = rule === null || owned && [record.ruleHash, record.pendingRuleHash].includes(hash(rule));
  const serverMatches = !server || owned && isDeepStrictEqual(server, record.server);
  if (action === 'status') {
    let connection = 'not_checked';
    if (check && server && serverMatches && !shadowed) {
      const { stdout } = await claude(['mcp', 'get', 'openmerit'], root);
      connection = /Needs authentication/i.test(stdout) ? 'needs_authentication' : /(?:✔|✓) Connected/.test(stdout) ? 'connected' : 'not_connected';
    }
    print(JSON.stringify({ installed: owned && record.phase === 'ready' && !!server && serverMatches && rule !== null && ruleMatches && !shadowed, scope, scopeConflict: shadowed,
      configuration: server ? serverMatches ? 'matches' : 'modified_or_unowned' : 'missing',
      instructions: rule === null ? 'missing' : ruleMatches ? 'matches' : 'modified_or_unowned', connection,
      search: 'not_checked', next: 'In Claude Code, use /mcp to authorize openmerit, discover scout_models and run a non-confidential first task. A connection check is not a successful search.' }, null, 2));
    return;
  }
  if (!ruleMatches || !serverMatches || !owned && (rule !== null || server)) throw new Error('Existing openmerit configuration or instructions are not unchanged installer-owned files. Resolve the conflict manually; nothing was overwritten.');
  if (action === 'remove') {
    if (!owned) { print('No installer-owned OpenMerit connection in this scope.'); return; }
    print(JSON.stringify({ action, scope, applied: yes, keeps: [policyPath, 'other servers and rules'], note: 'Removal is not account-wide OAuth revocation; revoke the grant at the provider when needed.' }, null, 2));
    if (!yes) return;
    if (server) await claude(['mcp', 'remove', '--scope', scope, 'openmerit'], root);
    if (rule !== null) await rm(paths.rule);
    await rm(paths.record);
    return;
  }
  if (shadowed) throw new Error('An openmerit server exists in another Claude Code scope. Resolve that conflict before installing; nothing was overwritten.');
  url ??= owned ? record.server?.url ?? defaultURL : defaultURL;
  const oauth = { scopes: 'scout:recommend' };
  clientId ??= owned ? record.server?.oauth?.clientId : undefined;
  callbackPort ??= owned ? record.server?.oauth?.callbackPort : undefined;
  if (clientId) Object.assign(oauth, { clientId, callbackPort });
  const nextServer = { type: 'http', url, headers: { 'X-Scout-Analytics-Content': 'off' }, oauth };
  if (server && !isDeepStrictEqual(server, nextServer)) throw new Error('Changing an installed endpoint or OAuth configuration requires removing that connection first; this may require reauthorization.');
  print(JSON.stringify({ action, scope, applied: false, endpoint: url, instructions: paths.rule,
    oauth, proposedInstructions: instructions,
    note: yes ? 'Installing configuration only; authentication and search still need verification.' : 'Review this plan, then rerun with --yes to approve these local changes.' }, null, 2));
  if (!yes) return;
  await claude(['--version'], root);
  // Record intent first so a partial install can be safely repaired by rerunning.
  const nextRecord = { version: 1, scope, phase: 'installing', server: nextServer, ruleHash: record.ruleHash, pendingRuleHash: hash(instructions) };
  await save(paths.record, nextRecord);
  if (!server) await claude(['mcp', 'add-json', '--scope', scope, 'openmerit', JSON.stringify(nextServer)], root);
  await save(paths.rule, instructions);
  await save(paths.record, { ...nextRecord, phase: 'ready', ruleHash: hash(instructions), pendingRuleHash: undefined });
  print('OpenMerit configuration installed. Restart Claude Code; approve project trust if needed. Use /mcp → openmerit → Authenticate. Then verify scout_models discovery and a first search. OAuth availability depends on the hosted operator configuration. No authentication or search success is claimed.');
}
