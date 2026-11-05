// `openmerit scout`: a conversation with Scout, the agent behind openmerit.ai/scout,
// for coding agents without the MCP server and for people at a terminal. It calls
// the same scout_models MCP tool with this device's key, so every client gets the
// same clarifying questions and per-task shortlists.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { credentialsPath, readCredentials, type DeviceCredentials } from './scout-credentials.ts';
import { openBrowser } from './browser.mjs';

const policyFile = '.openmerit/scout.json';
export const components = ['input', 'work', 'output', 'criteria', 'constraints'] as const;

const help = `OpenMerit · Scout

  openmerit scout "<the work models need to do>" [--all-endpoints] [--json]
  openmerit scout --conversation <id> [--brief <component>=<text> ...] [--skip] ["<follow-up>"] [--json]
  openmerit scout --conversation <id> --results <file.json> [--json]
  openmerit scout --conversation <id> --sync langfuse [--json]
  openmerit connect langfuse
  openmerit disconnect langfuse

Asks Scout, the agent behind openmerit.ai/scout. Scout may first return a task
brief with clarifying questions: answer them with --brief (components: input,
work, output, criteria, constraints) in the same conversation, or --skip to let
Scout assume. It then splits the work into tasks and recommends up to five
models for each, with an evaluation: how to measure the candidates with your
own evals. Report what you measured with --results: a JSON list of aggregate
results ({level, kind?, task?, scope, model, metric, value, higherIsBetter,
samples, source}), never inputs or outputs. kind is quality (the default), usd
or seconds; measured usd replaces Scout's cost estimate. Scout ranks them above
public benchmarks, for your recommendations only. A turn usually takes one to three minutes.

Connect a separate Langfuse Viewer key in the signed-in browser, then --sync
langfuse refreshes mapped, tagged experiment aggregates before recommending.
Results are stored per user across conversations for 90 days. Disconnect deletes
the key and imports; use Delete all evaluation data to remove reported results too.
Past conversations remain. Never put record IDs or emails in source or scope.

A new conversation is limited to the endpoint IDs in ${policyFile}
(set with openmerit project). --all-endpoints searches the whole catalogue and is
refused under the existing-only policy. Uses the device key that
"openmerit install" saved for Claude Code or Pi, this project's first. Never include secrets, source files or customer records.
`;

type Json = Record<string, unknown>;
interface ScoutRequest { prompt?: string; conversationId?: string; brief?: Partial<Record<typeof components[number], string>>; skip?: boolean; endpointIds?: string[]; results?: unknown[]; sync?: 'langfuse' }
export interface ScoutModel {
  rank: number; id: string; name: string; provider: string; rationale: string; watchOut: string | null;
  quality: { score: number; measured?: boolean; evidence: Array<{ name: string; rank: number; of: number }> };
  cost: { usdPer1kTasks: number; usdPer1kAgentRuns?: number; measured?: { usdPer1kTasks: number; usdPer1kAgentRuns?: number }; inputPerMillion: number; outputPerMillion: number; route: string; endpointId: string; providerModelId: string } | null;
  latency?: { seconds: number } | null; recency?: { released: string } | null;
}
interface Evaluation { checks: Array<{ level: string; metric: string; how: string }>; samples: number; stopEarly: string }
// How a task's models are ordered. Cost (cheapest first among models that reach the quality bar) is the default.
type Priority = 'cost' | 'quality' | 'latency' | 'recency';
interface ScoutResult {
  conversationId: string; status: 'needs_answers' | 'recommended' | 'working' | 'message' | 'error'; next?: string;
  brief?: Record<string, { text: string; source: string }>; questions?: Array<{ component: string; question: string }>;
  assumptions?: string[]; tasks?: Array<{ title: string; work: string; summary: string; priority?: Priority; agent?: string; callsPerRun?: number; models: ScoutModel[]; evaluation?: Evaluation }>;
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
      if (tasks.length > 1) lines.push(`${i + 1}. ${task.title}${task.agent ? ` (${task.agent}${task.callsPerRun && task.callsPerRun > 1 ? `, ${task.callsPerRun} calls per run` : ''})` : ''}`, `   ${task.work}`);
      // As on the page, the default cheapest-first order is unlabelled; another priority is named with the value it sorts by.
      const priority = task.priority ?? 'cost';
      if (priority !== 'cost') lines.push(`   ${rankings[priority]}`);
      for (const m of task.models) {
        const measuredCost = m.cost?.measured ? `measured ${money(m.cost.measured.usdPer1kAgentRuns ?? m.cost.measured.usdPer1kTasks)} per 1k ${m.cost.measured.usdPer1kAgentRuns === undefined ? 'tasks' : 'agent runs'}, ` : '';
        const price = m.cost ? `${measuredCost}${money(m.cost.inputPerMillion)} in / ${money(m.cost.outputPerMillion)} out per 1M via ${m.cost.route} (${m.cost.endpointId})` : 'no priced route';
        const metric = priority === 'latency' ? ` · ${m.latency ? `${m.latency.seconds.toFixed(1)}s per task` : 'time unknown'}`
          : priority === 'recency' ? ` · ${m.recency ? `released ${m.recency.released}` : 'release date unknown'}` : '';
        lines.push(`   ${m.rank}. ${m.name}${metric} · quality ${m.quality.score}/100${m.quality.measured ? ' (measured)' : ''} · ${price}`, `      ${m.rationale}`);
      }
      lines.push(`   ${task.summary}`);
      if (task.evaluation) lines.push(`   Measure with your evals (${task.evaluation.samples} labelled examples per candidate; ${task.evaluation.stopEarly}):`,
        ...task.evaluation.checks.map(c => `     - ${c.level}: ${c.metric}. ${c.how}`));
      lines.push('');
    });
    if (result.assumptions?.length) lines.push('Assumptions:', ...result.assumptions.map(a => `  - ${a}`), '');
    lines.push(`Refine: openmerit scout --conversation ${result.conversationId} "<follow-up>"`);
    lines.push(`Report measured results: openmerit scout --conversation ${result.conversationId} --results <file.json>`);
    lines.push(tasks.some(t => t.models.some(m => m.quality.measured))
      ? 'Quality marked (measured) rests on the results you reported; the rest is Scout\'s estimate from public benchmarks.'
      : 'Quality is Scout\'s estimate from public benchmarks, not measured accuracy for your application.');
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
    else if (arg === '--sync') {
      if (value() !== 'langfuse') throw new Error('--sync supports langfuse.');
      request.sync = 'langfuse';
    }
    else if (arg === '--results') {
      const file = value();
      let results: unknown;
      try { results = JSON.parse(await readFile(resolve(root, file), 'utf8')); } catch { throw new Error(`Could not read results from ${file}: it must be a JSON list.`); }
      if (!Array.isArray(results)) throw new Error(`${file} must hold a JSON list of results.`);
      // Scout accepts at most 50 per turn; each call is a turn that recommends again, so splitting is the caller's choice.
      if (results.length > 50) throw new Error(`${file} holds ${results.length} results; Scout accepts at most 50 per call. Split them into files of up to 50 and report each with --results in turn; Scout recommends again after each.`);
      if (results.some(r => isObject(r) && [r.source, r.scope].some(v => typeof v === 'string' && /(?:\b(?:claim|patient|member|FICT|CLM)[-_ ]?\d|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|[^\s@]+@[^\s@]+\.[^\s@]+)/i.test(v)))) print('Warning: source or scope looks like a record ID or email. Send aggregate labels only; remove identifiers before sharing.');
      request.results = results;
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option for scout: ${arg}`);
    else words.push(arg);
  }
  if (words.length) request.prompt = words.join(' ');
  if (!request.prompt && !request.conversationId) { print(help); return 1; }
  if (request.results && !request.conversationId) throw new Error('--results continues a conversation: pass --conversation <id> from the recommendation you measured.');
  const result = await scoutTurn(root, request);
  print(json ? JSON.stringify(result, null, 2) : renderScout(result));
  return result.status === 'error' ? 1 : 0;
}

export async function connection(args: string[], print = console.log): Promise<number> {
  if (!['connect', 'disconnect'].includes(args[0] ?? '') || args[1] !== 'langfuse' || args.length !== 2) throw new Error('Use openmerit connect langfuse or openmerit disconnect langfuse.');
  const url = 'https://openmerit.ai/connect/?integration=langfuse';
  print(args[0] === 'connect' ? `Add a separate Langfuse Viewer key in your signed-in browser: ${url}` : `Confirm “Disconnect & delete imports” in your signed-in browser: ${url}`);
  await openBrowser(url, { allowed: (value: string) => value === url }).catch(() => false);
  return 0;
}
