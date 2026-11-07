// Opt-in paid ranking baseline: replays the Sahra Health playground's brief through the
// real Scout agent and scores its shortlists against what the playground measured.
// The ScoutAgent Durable Object, Pi harness, tools and shortlist validation run in
// workerd. The catalogue bindings read production read-only: R2 through
// `wrangler r2 object get`, D1 (SELECT only) and Vectorize (query only) through the
// Cloudflare API. The first active.json read pins the catalogue version for the run.
// Web search is off. Conversations live only in this process's Miniflare storage.
//
// Usage: RUNS=3 node scout/experiments/playground-ranking.ts /path/report.json
// Needs OPENAI_API_KEY, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { TaskRecommendation } from '../agent/recommendation.ts';
import type { AgentState } from '../agent/turn.ts';

const report = process.argv[2], runs = Number(process.env.RUNS ?? 3);
const { OPENAI_API_KEY: openai, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!report || process.argv.length !== 3 || !openai || !token || !account || !(runs >= 1)) throw new Error('Supply a report path, OPENAI_API_KEY, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
const root = new URL('../../', import.meta.url);
const message = await readFile(new URL('playground/scout-tasks/agent-models-0.3.1.txt', root), 'utf8');
type Result = { task: string; model: string; kind?: string; metric: string; value: number; level: string };
const results = JSON.parse(await readFile(new URL('playground/scout-results/2026-11-05-0.3.4-reported-agent-level.json', root), 'utf8')) as Result[];
const config = await readFile(new URL('wrangler.scout-alpha.jsonc', root), 'utf8');
const database = /"database_id":\s*"([^"]+)"/.exec(config)?.[1], index = /"index_name":\s*"([^"]+)"/.exec(config)?.[1], bucket = /"bucket_name":\s*"([^"]+)"/.exec(config)?.[1];
if (!database || !index || !bucket) throw new Error('Could not read the Scout bindings from wrangler.scout-alpha.jsonc.');

// What the playground measured, per task: models that passed every agent check, models that failed one, and USD per agent run.
const truth = new Map<string, { pass: Set<string>; fail: Set<string>; usd: Map<string, number> }>();
for (const r of results) {
  const t = truth.get(r.task) ?? { pass: new Set(), fail: new Set(), usd: new Map() }, model = r.model.replace(/^openrouter:chat:/, '');
  truth.set(r.task, t);
  if ((r.kind ?? 'quality') === 'usd') t.usd.set(model, r.value);
  else if ((r.kind ?? 'quality') === 'quality') (r.value >= 1 ? t.pass : t.fail).add(model);
}
for (const t of truth.values()) for (const m of t.fail) t.pass.delete(m);

const cf = async (path: string, body: unknown) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json() as { success: boolean; result: unknown; errors?: unknown };
  if (!json.success) throw new Error(`${path}: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.result;
};
const r2 = new Map<string, string | null>();
const bindings = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url), body = await request.json() as Record<string, unknown>;
  if (pathname === '/r2') {
    const key = String(body.key);
    if (!r2.has(key)) {
      try { r2.set(key, execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe', '-c', 'wrangler.scout-alpha.jsonc'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })); }
      catch { r2.set(key, null); }
    }
    const value = r2.get(key);
    return value == null ? new Response(null, { status: 404 }) : new Response(value);
  }
  if (pathname === '/d1') {
    const sql = String(body.sql);
    if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql) || /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|vacuum)\b/i.test(sql.replace(/'[^']*'/g, ''))) throw new Error(`Refused non-SELECT statement: ${sql.slice(0, 80)}`);
    const [first] = await cf(`d1/database/${database}/query`, { sql, params: body.params }) as Array<{ results: unknown[] }>;
    return Response.json({ results: first?.results ?? [] });
  }
  if (pathname === '/vectorize') return Response.json(await cf(`vectorize/v2/indexes/${index}/query`, body));
  return new Response('unknown binding', { status: 404 });
};

const bundle = await build({ stdin: { contents: `
  import { ScoutAgent } from './scout/agent/agent.ts';
  import { loadCatalogue } from './scout/agent/catalogue.ts';
  import { embed } from './scout/evidence-search.mjs';
  import { parseTurn } from './scout/agent/routes.ts';
  const call = async (path, body) => { const r = await fetch('https://bindings.invalid' + path, { method: 'POST', body: JSON.stringify(body) }); if (r.status === 404) return null; if (!r.ok) throw new Error(await r.text()); return r; };
  const statement = (sql, params = []) => ({ bind: (...values) => statement(sql, values), all: async () => (await call('/d1', { sql, params })).json() });
  let catalogue;
  export class ReplayAgent extends ScoutAgent {
    constructor(ctx, env) {
      super(ctx, env);
      const proxied = { OPENAI_API_KEY: env.OPENAI_API_KEY,
        SCOUT_CATALOGUE: { get: async key => { const r = await call('/r2', { key }); return r && { json: () => r.json() }; } },
        SCOUT_INDEX: { prepare: sql => statement(sql) },
        SCOUT_EVIDENCE: { query: async (vector, options) => (await call('/vectorize', { vector, ...options })).json() } };
      this.host.catalogue = () => catalogue ??= loadCatalogue(proxied, (texts, apiKey) => embed(texts, { apiKey, timeoutMs: 8000 }));
    }
  }
  export default { async fetch(request, env) {
    const parsed = parseTurn(await request.json());
    if (typeof parsed === 'string') return new Response(parsed, { status: 400 });
    return Response.json(await env.AGENTS.getByName(new URL(request.url).pathname).turn(parsed.turn, 'agent'));
  }};`, resolveDir: root.pathname }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'] });

const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-09-28', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { AGENTS: { className: 'ReplayAgent', useSQLite: true } },
  bindings: { AI: {}, OPENAI_API_KEY: openai, SCOUT_AGENT_MODEL: /"SCOUT_AGENT_MODEL":\s*"([^"]+)"/.exec(config)?.[1] ?? 'openai/gpt-6-sol', SCOUT_AGENT_WEB_SEARCH: 'off' },
  outboundService: async request => {
    if (new URL(request.url).hostname === 'bindings.invalid') return bindings(request as unknown as Request);
    // Node's fetch sets Host and Content-Length itself and refuses requests that carry them.
    const headers = new Headers([...request.headers as unknown as Iterable<[string, string]>]); for (const h of ['host', 'content-length', 'cf-worker']) headers.delete(h);
    const response = await fetch(request.url, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer()) });
    if (!response.ok) console.warn(`${request.method} ${new URL(request.url).host}${new URL(request.url).pathname} returned ${response.status}: ${(await response.clone().text()).slice(0, 300)}`);
    return response as never;
  } }));

// Scenario "fresh" is a new conversation before any results; "measured" is a new conversation that also reports the playground's agent-level results.
type Score = { scenario: string; run: number; task: string; top: string[]; bestValueListed: boolean | null; failingInTopTwo: boolean; regretUsdPerRun: number | null };
const scores: Score[] = [], shortlists: Array<{ scenario: string; run: number; answer: AgentState['answer'] }> = [];
try {
  const jobs = Array.from({ length: runs }, (_, i) => i + 1).flatMap(run => (['fresh', 'measured'] as const).map(async scenario => {
    // A turn takes at most 50 results; seconds are left out because Scout does not rank on latency (49 remain).
    const body = { message, skip: true, ...(scenario === 'measured' ? { results: results.filter(r => r.kind !== 'seconds') } : {}) };
    const response = await mf.dispatchFetch(`http://local/${scenario}-${run}`, { method: 'POST', body: JSON.stringify(body) });
    const state = await response.json() as AgentState;
    shortlists.push({ scenario, run, answer: state.answer });
    if (state.answer?.kind !== 'recommendation') { console.warn(`${scenario} run ${run}: no recommendation (${state.answer?.kind})`); return; }
    for (const task of state.answer.tasks as TaskRecommendation[]) {
      // Scout names the tasks itself; match them to the playground's agents by their distinctive word.
      const words: Record<string, RegExp> = { Enrollment: /enrol/, 'Claims intake': /intake|extract/, 'Coding review': /cod/, 'Coverage adjudication': /adjudicat|coverage/, 'Fraud review': /fraud|fwa/ };
      const name = [...truth.keys()].find(k => (words[k] ?? new RegExp(k.toLowerCase())).test(task.title.toLowerCase()));
      const t = name ? truth.get(name) : undefined, ids = task.models.map(m => m.id);
      if (!t) { console.warn(`${scenario} run ${run}: unknown task "${task.title}"`); continue; }
      const cheapest = [...t.pass].filter(m => t.usd.has(m)).sort((a, b) => t.usd.get(a)! - t.usd.get(b)!)[0];
      const first = ids[0], firstUsd = first ? t.usd.get(first) : undefined;
      scores.push({ scenario, run, task: name!, top: ids,
        bestValueListed: cheapest ? ids.includes(cheapest) : null,
        failingInTopTwo: ids.slice(0, 2).some(id => t.fail.has(id)),
        regretUsdPerRun: cheapest && firstUsd !== undefined && t.pass.has(first!) ? firstUsd - t.usd.get(cheapest)! : null });
    }
  }));
  await Promise.all(jobs);
} finally { await mf.dispose(); }

const version = r2.get('active.json') ? (JSON.parse(r2.get('active.json')!) as { publication?: { id?: string } }).publication?.id : null;
const summary = (['fresh', 'measured'] as const).map(scenario => {
  const s = scores.filter(x => x.scenario === scenario), known = s.filter(x => x.bestValueListed !== null), regret = s.filter(x => x.regretUsdPerRun !== null);
  const claims = s.filter(x => x.task !== 'Enrollment');
  return { scenario, shortlists: s.length,
    bestValueListed: `${known.filter(x => x.bestValueListed).length}/${known.length}`,
    failingInTopTwo: `${s.filter(x => x.failingInTopTwo).length}/${s.length}`,
    firstIsMeasuredPass: `${regret.length}/${claims.length}`,
    meanRegretUsdPerDay: regret.length ? +(300 * regret.reduce((a, x) => a + x.regretUsdPerRun!, 0) / runs).toFixed(2) : null,
    topOneAgreement: [...new Set(s.map(x => x.task))].map(task => { const firsts = s.filter(x => x.task === task).map(x => x.top[0]); return `${task}: ${new Set(firsts).size} distinct #1 in ${firsts.length}`; }) };
});
await writeFile(report, JSON.stringify({ catalogue: version, runs, summary, scores, shortlists }, null, 2));
console.log(JSON.stringify({ catalogue: version, runs, summary }, null, 2));
for (const s of scores.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.task.localeCompare(b.task) || a.run - b.run))
  console.log(`${s.scenario.padEnd(8)} ${s.task.padEnd(22)} run ${s.run}: ${s.top.join(', ')}`);
