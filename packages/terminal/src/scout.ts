// `openmerit scout`: a conversation with Scout, the agent behind openmerit.ai/scout,
// for coding agents without the MCP server and for people at a terminal. It calls
// the same scout_models MCP tool with this device's key, so every client gets the
// same clarifying questions and per-task shortlists.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialsPath, readCredentials, type DeviceCredentials } from './scout-credentials.ts';

const policyFile = '.openmerit/scout.json';
export const components = ['input', 'work', 'output', 'criteria', 'constraints'] as const;

const help = `OpenMerit · Scout

  openmerit scout "<the work models need to do>" [--all-endpoints] [--json]
  openmerit scout --conversation <id> [--brief <component>=<text> ...] [--skip] ["<follow-up>"] [--json]

Asks Scout, the agent behind openmerit.ai/scout. Scout may first return a task
brief with clarifying questions: answer them with --brief (components: input,
work, output, criteria, constraints) in the same conversation, or --skip to let
Scout assume. It then splits the work into tasks and recommends up to five
models for each. A turn usually takes one to three minutes.

A new conversation is limited to the endpoint IDs in ${policyFile}
(set with openmerit project). --all-endpoints searches the whole catalogue and is
refused under the existing-only policy. Uses the device key that
"openmerit install" saved for Claude Code or Pi, this project's first. Never include secrets, source files or customer records.
`;

type Json = Record<string, unknown>;
interface ScoutRequest { prompt?: string; conversationId?: string; brief?: Partial<Record<typeof components[number], string>>; skip?: boolean; endpointIds?: string[] }
export interface ScoutModel {
  rank: number; id: string; name: string; provider: string; rationale: string; watchOut: string | null;
  quality: { score: number; evidence: Array<{ name: string; rank: number; of: number }> };
  cost: { usdPer1kTasks: number; inputPerMillion: number; outputPerMillion: number; route: string; endpointId: string; providerModelId: string } | null;
  latency?: { seconds: number } | null; recency?: { released: string } | null;
}
// How a task's models are ordered. Cost (cheapest first among models that reach the quality bar) is the default.
type Priority = 'cost' | 'quality' | 'latency' | 'recency';
interface ScoutResult {
  conversationId: string; status: 'needs_answers' | 'recommended' | 'working' | 'message' | 'error'; next?: string;
  brief?: Record<string, { text: string; source: string }>; questions?: Array<{ component: string; question: string }>;
  assumptions?: string[]; tasks?: Array<{ title: string; work: string; summary: string; priority?: Priority; models: ScoutModel[] }>;
  text?: string; error?: string;
}

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
async function readJSON(path: string): Promise<Json | null> {
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8')); return isObject(value) ? value : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(`Could not read ${path}.`); }
}

// The device key an installation saved: this project's installation first, then the user's.
function deviceKey(root: string): DeviceCredentials | null {
  for (const scope of ['project', 'user'] as const) for (const client of ['claude-code', 'pi'] as const) {
    const credentials = readCredentials(credentialsPath(client, scope, root));
    if (credentials) return credentials;
  }
  return null;
}

// One turn through the scout_models MCP tool. Errors are written for the person or agent running it.
async function askScout(root: string, request: ScoutRequest, signal?: AbortSignal): Promise<ScoutResult> {
  const credentials = deviceKey(root);
  if (!credentials) throw new Error('This device is not signed in to OpenMerit. Run: npx -y openmerit@latest install');
  const server = credentials.server;
  let response: Response;
  try {
    response = await fetch(`${server}/scout/mcp`, {
      method: 'POST', redirect: 'error',
      // A turn can take minutes; Scout keeps working if the connection drops.
      signal: AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]),
      headers: { ...credentials.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.key}`, 'X-Scout-Client': 'cli' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scout_models', arguments: request } }),
    });
  } catch (error) {
    const id = request.conversationId;
    throw new Error((error as Error).name === 'TimeoutError' && id ? `Scout is still working. Read the outcome with: openmerit scout --conversation ${id}` : `Could not reach ${server}. Check your connection and retry.`);
  }
  if (response.status === 401) throw new Error('The device key was rejected. Run: npx -y openmerit@latest login, then install again.');
  const body: unknown = await response.json().catch(() => null);
  const result = isObject(body) && isObject(body.result) ? body.result : null;
  if (!result) throw new Error(`Scout returned HTTP ${response.status}${isObject(body) && isObject(body.error) ? `: ${String(body.error.message)}` : ''}.`);
  const text = Array.isArray(result.content) && isObject(result.content[0]) ? String(result.content[0].text) : '';
  if (result.isError && !isObject(result.structuredContent)) throw new Error(text || 'Scout could not finish this turn.');
  return result.structuredContent as unknown as ScoutResult;
}

// A turn under the project's access policy. A new conversation is limited to the saved
// inventory; the whole catalogue needs an explicit choice the policy permits.
export async function scoutTurn(root: string, request: Omit<ScoutRequest, 'endpointIds'> & { allEndpoints?: boolean }, signal?: AbortSignal): Promise<ScoutResult> {
  const { allEndpoints, ...turn } = request;
  if (turn.conversationId) {
    if (allEndpoints) throw new Error('--all-endpoints applies when a conversation starts. Start a new conversation instead.');
    return askScout(root, turn, signal);
  }
  const policy = await readJSON(join(root, policyFile));
  if (!policy) {
    if (!allEndpoints) throw new Error(`${policyFile} is missing. Ask which endpoints this project can use and save them with "npx -y openmerit@latest project --policy existing-only|existing-first --endpoint-id <id> ...", or pass --all-endpoints to search the whole catalogue.`);
    return askScout(root, turn, signal);
  }
  const ids = Array.isArray(policy.endpointIds) && policy.endpointIds.every(id => typeof id === 'string') ? policy.endpointIds as string[] : null;
  if (!ids || !['existing-only', 'existing-first'].includes(String(policy.policy))) throw new Error(`${policyFile} is not a valid Scout policy. Save it again with "openmerit project".`);
  if (allEndpoints && policy.policy === 'existing-only') throw new Error('This project uses the existing-only policy, so Scout cannot search the whole catalogue.');
  return askScout(root, allEndpoints ? turn : { ...turn, endpointIds: ids }, signal);
}

const money = (usd: number) => `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
const rankings: Record<Exclude<Priority, 'cost'>, string> = { quality: 'Highest quality estimate first.', latency: 'Fastest first.', recency: 'Newest first.' };
export function renderScout(result: ScoutResult): string {
  const lines: string[] = [];
  if (result.status === 'needs_answers') {
    lines.push('Scout needs more detail. Its task brief:', '');
    for (const c of components) { const part = result.brief?.[c]; lines.push(`  ${c.padEnd(12)}${part?.text || '(missing)'}${part ? `  [${part.source}]` : ''}`); }
    lines.push('', 'Questions:', ...(result.questions ?? []).map(q => `  ${q.component}: ${q.question}`), '',
      `Answer: openmerit scout --conversation ${result.conversationId} --brief <component>="<answer>" ...`,
      `Or skip: openmerit scout --conversation ${result.conversationId} --skip`);
  } else if (result.status === 'recommended') {
    const tasks = result.tasks ?? [];
    tasks.forEach((task, i) => {
      if (tasks.length > 1) lines.push(`${i + 1}. ${task.title}`, `   ${task.work}`);
      // As on the page, the default cheapest-first order is unlabelled; another priority is named with the value it sorts by.
      const priority = task.priority ?? 'cost';
      if (priority !== 'cost') lines.push(`   ${rankings[priority]}`);
      for (const m of task.models) {
        const price = m.cost ? `${money(m.cost.inputPerMillion)} in / ${money(m.cost.outputPerMillion)} out per 1M via ${m.cost.route} (${m.cost.endpointId})` : 'no priced route';
        const metric = priority === 'latency' ? ` · ${m.latency ? `${m.latency.seconds.toFixed(1)}s per task` : 'time unknown'}`
          : priority === 'recency' ? ` · ${m.recency ? `released ${m.recency.released}` : 'release date unknown'}` : '';
        lines.push(`   ${m.rank}. ${m.name}${metric} · quality ${m.quality.score}/100 · ${price}`, `      ${m.rationale}`);
      }
      lines.push(`   ${task.summary}`, '');
    });
    if (result.assumptions?.length) lines.push('Assumptions:', ...result.assumptions.map(a => `  - ${a}`), '');
    lines.push(`Refine: openmerit scout --conversation ${result.conversationId} "<follow-up>"`);
    lines.push('Quality is Scout\'s estimate from public benchmarks, not measured accuracy for your application.');
  } else if (result.status === 'working') lines.push(`Scout is still working. Read the outcome with: openmerit scout --conversation ${result.conversationId}`);
  else lines.push(result.text ?? result.error ?? 'Scout replied without an answer.');
  return lines.join('\n');
}

export async function main(args: string[], { root = process.cwd(), print = console.log } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { print(help); return 0; }
  const request: Parameters<typeof scoutTurn>[1] = {};
  const words: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const value = () => { const v = args[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value.`); return v; };
    if (arg === '--conversation') request.conversationId = value();
    else if (arg === '--brief') {
      const [component, ...text] = value().split('=');
      if (!(components as readonly string[]).includes(component ?? '') || !text.length) throw new Error(`--brief takes <component>=<text>; components: ${components.join(', ')}.`);
      request.brief = { ...request.brief, [component as typeof components[number]]: text.join('=') };
    } else if (arg === '--skip') request.skip = true;
    else if (arg === '--all-endpoints') request.allEndpoints = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option for scout: ${arg}`);
    else words.push(arg);
  }
  if (words.length) request.prompt = words.join(' ');
  if (!request.prompt && !request.conversationId) { print(help); return 1; }
  const result = await scoutTurn(root, request);
  print(json ? JSON.stringify(result, null, 2) : renderScout(result));
  return result.status === 'error' ? 1 : 0;
}
