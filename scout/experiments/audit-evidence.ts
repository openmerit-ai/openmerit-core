// Opt-in paid check of task evidence selection against evidence-cases.json.
// Replays one published records file locally: embeds its evidence documents,
// stands in for Vectorize with exact cosine search, and runs the recommender.
// Each case lists name patterns that accepted evidence should include and
// patterns it must not include. No recommended model is executed.
// Usage: node scout/experiments/audit-evidence.ts records.json report.json [case-id ...]
import { readFile, writeFile } from 'node:fs/promises';

interface Case { id: string; prompt: string; expect: string[]; avoid: string[] }
interface Document { id: string; text: string; modelIds?: string[] }
interface Assessment { benchmark: string; applicability: string; capability?: string | null; relevance?: string }
interface Task { evidenceMatch?: { ids: string[]; assessments: Assessment[] } }
interface Result { error?: string; task?: Task; tasks?: { task?: Task }[]; recommendations?: { evidence?: { benchmark: string }[] }[] }
interface Index { benchmarks: Map<string, { name: string }> }
type Recommender = (index: Index, prompt: string) => Promise<Result>;
interface Modules {
  records: { toSnapshot: (records: unknown) => unknown };
  rank: { createIndex: (snapshot: unknown) => Index };
  recommend: { createRecommender: (options: { apiKey: string; vectorize: unknown }) => Recommender };
  registry: { registry: unknown };
  search: { evidenceDocuments: (snapshot: unknown) => Document[]; embed: (texts: string[], options: { apiKey: string; timeoutMs: number }) => Promise<number[][]> };
}

const [recordsPath, report, ...only] = process.argv.slice(2), apiKey = process.env.OPENAI_API_KEY;
if (!recordsPath || !report || !apiKey) throw new Error('Usage: audit-evidence.ts records.json report.json [case-id ...] with OPENAI_API_KEY set.');
const load = (name: string) => import(new URL(`../${name}.mjs`, import.meta.url).href);
const m: Modules = { records: await load('records'), rank: await load('rank'), recommend: await load('recommend'), registry: await load('registry'), search: await load('evidence-search') };
const cases = (JSON.parse(await readFile(new URL('./evidence-cases.json', import.meta.url), 'utf8')) as Case[]).filter(c => !only.length || only.includes(c.id));
const snapshot = m.records.toSnapshot(JSON.parse(await readFile(recordsPath, 'utf8'))) as Record<string, unknown>;

const documents = m.search.evidenceDocuments(snapshot).filter(d => !d.modelIds || d.modelIds.length), vectors: number[][] = [];
for (let i = 0; i < documents.length; i += 64) vectors.push(...await m.search.embed(documents.slice(i, i + 64).map(d => d.text), { apiKey, timeoutMs: 60000 }));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const vectorize = { query: async (q: number[], { topK }: { topK: number }) => ({ matches: documents.map((d, i) => ({ score: dot(q, vectors[i] ?? []), metadata: { benchmark: d.id } })).sort((a, b) => b.score - a.score).slice(0, topK) }) };
const index = m.rank.createIndex({ ...snapshot, registry: snapshot.registry ?? m.registry.registry, servingEngine: 'evidence', publication: { id: `audit-${Date.now()}` } });
const run = m.recommend.createRecommender({ apiKey, vectorize });

const name = (id: string) => index.benchmarks.get(id)?.name ?? id;
const audit = async (c: Case) => {
  let result: Result;
  try { result = await run(index, c.prompt); } catch (error) { result = { error: error instanceof Error && error.cause ? String(error.cause) : String(error) }; }
  const matches = [result.task, ...(result.tasks ?? []).map(t => t.task)].flatMap(t => t?.evidenceMatch ? [t.evidenceMatch] : []);
  const accepted = [...new Set(matches.flatMap(e => e.ids))], assessments = matches.flatMap(e => e.assessments).filter(a => accepted.includes(a.benchmark));
  const names = accepted.map(name), top = result.recommendations?.[0]?.evidence?.map(e => e.benchmark) ?? [];
  const hit = (pattern: string, list: string[]) => list.some(n => new RegExp(pattern).test(n));
  const missing = c.expect.filter(p => !hit(p, names)), violations = names.filter(n => c.avoid.some(p => new RegExp(p).test(n)));
  // Expected evidence that retrieval found but assessment withheld.
  const withheld = matches.flatMap(e => e.assessments).filter(a => !accepted.includes(a.benchmark) && c.expect.some(p => new RegExp(p).test(name(a.benchmark)))).map(a => name(a.benchmark));
  return { id: c.id, prompt: c.prompt, pass: !result.error && !missing.length && !violations.length, error: result.error, missing, violations, withheld,
    topEvidenceExpected: c.expect.some(p => hit(p, top)), accepted: assessments.map(a => ({ name: name(a.benchmark), capability: a.capability ?? null, relevance: a.relevance ?? null })), topEvidence: top };
};
const results: Awaited<ReturnType<typeof audit>>[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map(audit)));
await writeFile(report, JSON.stringify(results, null, 2));
for (const r of results) console.log(JSON.stringify({ id: r.id, pass: r.pass, top: r.topEvidenceExpected, missing: r.missing, withheld: r.withheld, violations: r.violations, error: r.error }));
const count = (f: (r: typeof results[number]) => boolean) => results.filter(f).length;
console.log(JSON.stringify({ cases: results.length, pass: count(r => r.pass), expectedFound: count(r => !r.missing.length), clean: count(r => !r.violations.length), topEvidenceExpected: count(r => r.topEvidenceExpected), errors: count(r => Boolean(r.error)) }));
