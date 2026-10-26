// Opt-in paid check of task evidence selection and ranking against evidence-cases.json.
// Replays one published records file locally: embeds its evidence documents,
// stands in for Vectorize with exact cosine search, and runs the recommender.
// Each case lists name patterns that accepted evidence should include and
// patterns it must not include. Optional checks:
//   leaders: a benchmark-name pattern. Its ten highest-scoring models, read from
//     the records file rather than from Scout, must include one of the top five.
//   filter: restrictions the prompt states (provider pattern, minimum context,
//     maximum input price per million tokens) that every recommendation must meet.
// RUNS=n repeats every case and reports how much the top five agree across runs.
// No recommended model is executed.
// Usage: [RUNS=3] node scout/experiments/audit-evidence.ts records.json report.json [case-id ...]
import { readFile, writeFile } from 'node:fs/promises';

interface Filter { provider?: string; minContext?: number; maxInputPrice?: number }
interface Case { id: string; prompt: string; expect: string[]; avoid: string[]; leaders?: string; filter?: Filter }
interface Document { id: string; text: string; modelIds?: string[] }
interface Assessment { benchmark: string; applicability: string; capability?: string | null; relevance?: string }
interface Task { evidenceMatch?: { ids: string[]; assessments: Assessment[] } }
interface Recommendation { id: string; name: string; provider?: string; context?: number | null; endpoint?: { provider?: string; context?: number | null; inputPrice?: number | null }; evidence?: { benchmark: string }[] }
interface Result { error?: string; task?: Task; tasks?: { task?: Task }[]; recommendations?: Recommendation[] }
interface Index { benchmarks: Map<string, { name: string }> }
interface Snapshot { models: { id: string; evidence: { benchmark: string; score: number }[] }[]; registry?: unknown }
type Recommender = (index: Index, prompt: string) => Promise<Result>;
interface Modules {
  records: { toSnapshot: (records: unknown) => Snapshot };
  rank: { createIndex: (snapshot: unknown) => Index };
  recommend: { createRecommender: (options: { apiKey: string; vectorize: unknown }) => Recommender };
  registry: { registry: unknown };
  search: { evidenceDocuments: (snapshot: unknown) => Document[]; embed: (texts: string[], options: { apiKey: string; timeoutMs: number }) => Promise<number[][]> };
}

const [recordsPath, report, ...only] = process.argv.slice(2), apiKey = process.env.OPENAI_API_KEY, runs = Math.max(1, Number(process.env.RUNS ?? 1));
if (!recordsPath || !report || !apiKey) throw new Error('Usage: [RUNS=n] audit-evidence.ts records.json report.json [case-id ...] with OPENAI_API_KEY set.');
const load = (name: string) => import(new URL(`../${name}.mjs`, import.meta.url).href);
const m: Modules = { records: await load('records'), rank: await load('rank'), recommend: await load('recommend'), registry: await load('registry'), search: await load('evidence-search') };
const cases = (JSON.parse(await readFile(new URL('./evidence-cases.json', import.meta.url), 'utf8')) as Case[]).filter(c => !only.length || only.includes(c.id));
const snapshot = m.records.toSnapshot(JSON.parse(await readFile(recordsPath, 'utf8')));

const documents = m.search.evidenceDocuments(snapshot).filter(d => !d.modelIds || d.modelIds.length), vectors: number[][] = [];
for (let i = 0; i < documents.length; i += 64) vectors.push(...await m.search.embed(documents.slice(i, i + 64).map(d => d.text), { apiKey, timeoutMs: 60000 }));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const vectorize = { query: async (q: number[], { topK }: { topK: number }) => ({ matches: documents.map((d, i) => ({ score: dot(q, vectors[i] ?? []), metadata: { benchmark: d.id } })).sort((a, b) => b.score - a.score).slice(0, topK) }) };
const index = m.rank.createIndex({ ...snapshot, registry: snapshot.registry ?? m.registry.registry, servingEngine: 'evidence', publication: { id: `audit-${Date.now()}` } });

const name = (id: string) => index.benchmarks.get(id)?.name ?? id;
// The ten models with the best result on any benchmark matching the pattern.
const leadersOf = (pattern: string) => {
  const best = new Map<string, number>();
  for (const model of snapshot.models) for (const e of model.evidence) if (new RegExp(pattern).test(name(e.benchmark))) best.set(model.id, Math.max(best.get(model.id) ?? -Infinity, e.score));
  return new Set([...best].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id));
};
const meets = (r: Recommendation, f: Filter) => (!f.provider || new RegExp(f.provider).test(`${r.provider ?? ''} ${r.endpoint?.provider ?? ''}`))
  && (f.minContext === undefined || (r.endpoint?.context ?? r.context ?? 0) >= f.minContext)
  && (f.maxInputPrice === undefined || (r.endpoint?.inputPrice ?? Infinity) <= f.maxInputPrice);

const audit = async (c: Case) => {
  let result: Result;
  // A new recommender per run: one would answer repeats from its result cache.
  try { result = await m.recommend.createRecommender({ apiKey, vectorize })(index, c.prompt); } catch (error) { result = { error: error instanceof Error && error.cause ? String(error.cause) : String(error) }; }
  const matches = [result.task, ...(result.tasks ?? []).map(t => t.task)].flatMap(t => t?.evidenceMatch ? [t.evidenceMatch] : []);
  const accepted = [...new Set(matches.flatMap(e => e.ids))], assessments = matches.flatMap(e => e.assessments).filter(a => accepted.includes(a.benchmark));
  const recommendations = result.recommendations ?? [], names = accepted.map(name), top = recommendations[0]?.evidence?.map(e => e.benchmark) ?? [];
  const hit = (pattern: string, list: string[]) => list.some(n => new RegExp(pattern).test(n));
  const missing = c.expect.filter(p => !hit(p, names)), violations = names.filter(n => c.avoid.some(p => new RegExp(p).test(n)));
  // Expected evidence that retrieval found but assessment withheld.
  const withheld = matches.flatMap(e => e.assessments).filter(a => !accepted.includes(a.benchmark) && c.expect.some(p => new RegExp(p).test(name(a.benchmark)))).map(a => name(a.benchmark));
  const shortlist = recommendations.slice(0, 5), leaders = c.leaders ? leadersOf(c.leaders) : null;
  // A recommendation ID is its model ID, plus ":<protocol>" for one endpoint of it.
  const leaderFound = leaders ? shortlist.some(r => [...leaders].some(id => r.id === id || r.id.startsWith(`${id}:`))) : null;
  const filterBroken = c.filter ? recommendations.filter(r => !meets(r, c.filter as Filter)).map(r => r.name) : [];
  return { id: c.id, prompt: c.prompt, pass: !result.error && !missing.length && !violations.length && leaderFound !== false && !filterBroken.length && (!c.filter || recommendations.length > 0),
    error: result.error, missing, violations, withheld, leaderFound, filterBroken, shortlist: shortlist.map(r => r.id),
    topEvidenceExpected: c.expect.some(p => hit(p, top)), accepted: assessments.map(a => ({ name: name(a.benchmark), capability: a.capability ?? null, relevance: a.relevance ?? null })), topEvidence: top };
};
type Run = Awaited<ReturnType<typeof audit>>;
const results: { id: string; runs: Run[]; stability: number | null }[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map(async c => {
  const all = await Promise.all(Array.from({ length: runs }, () => audit(c)));
  // Mean share of the top five two runs have in common.
  const pairs = all.flatMap((a, x) => all.slice(x + 1).map(b => b.shortlist.filter(id => a.shortlist.includes(id)).length / Math.max(1, a.shortlist.length, b.shortlist.length)));
  return { id: c.id, runs: all, stability: pairs.length ? pairs.reduce((s, v) => s + v, 0) / pairs.length : null };
})));
await writeFile(report, JSON.stringify(results, null, 2));
for (const { id, runs: all, stability } of results) for (const r of all) console.log(JSON.stringify({ id, pass: r.pass, top: r.topEvidenceExpected, leader: r.leaderFound, filterBroken: r.filterBroken.length ? r.filterBroken : undefined, missing: r.missing, withheld: r.withheld, violations: r.violations, error: r.error, stability }));
const flat = results.flatMap(r => r.runs), count = (f: (r: Run) => boolean) => flat.filter(f).length, stable = results.flatMap(r => r.stability === null ? [] : [r.stability]);
console.log(JSON.stringify({ cases: results.length, runs, pass: count(r => r.pass), passEveryRun: results.filter(r => r.runs.every(x => x.pass)).length, expectedFound: count(r => !r.missing.length), clean: count(r => !r.violations.length),
  leadersFound: `${count(r => r.leaderFound === true)}/${count(r => r.leaderFound !== null)}`, filtersMet: `${count(r => r.filterBroken.length === 0 && r.shortlist.length > 0 && cases.some(c => c.id === r.id && c.filter))}/${count(r => cases.some(c => c.id === r.id && c.filter))}`,
  topEvidenceExpected: count(r => r.topEvidenceExpected), errors: count(r => Boolean(r.error)), meanTop5Overlap: stable.length ? Math.round(100 * stable.reduce((s, v) => s + v, 0) / stable.length) / 100 : null }));
