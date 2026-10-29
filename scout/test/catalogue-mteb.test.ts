import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMTEB, importMTEB, mtebAPI } from '../catalogue-mteb.ts';
import { type Bucket, type Database } from '../catalogue-db.ts';
import { d1 } from './helpers-d1.ts';

const board = (name = 'MTEB(eng, v2)') => ({ name, tasks: ['Retrieval.v2', 'STS'], modalities: ['text'], numModels: 2, displayOnLeaderboard: false });
const row = (name: string, experiments: Record<string, unknown> | null = null) => ({
  rank: 1, model: { name, modelType: 'dense', embeddingDim: 1024, releaseDate: '2026-02-01' },
  meanTask: null, meanTaskType: .37, scoresByTask: { 'Retrieval.v2': .82, STS: -.08 }, scoresByTaskType: { Retrieval: .82, STS: -.08 },
  zeroShotPct: 50, trainedOnTasks: ['Retrieval.v2'], experiments,
});
const summary = (rows: unknown[] = [row('Lab/Model'), row('Lab/Model', { vector_type: 'binary' })], name = board().name) => ({
  benchmarkName: name, tasks: ['Retrieval.v2', 'STS'], tasksMeta: [{ name: 'Retrieval.v2', mainScore: 'ndcg_at_10' }, { name: 'STS', mainScore: 'cosine_spearman' }], rows,
});
const active = (db: ReturnType<typeof d1>) => db.all('SELECT r.benchmark,r.model,r.payload FROM cat_mteb_results r JOIN cat_mteb_benchmarks b ON b.name=r.benchmark AND b.version=r.version ORDER BY r.benchmark,r.model,r.variant');

test('MTEB imports only final summaries and preserves suite versions, variants, negative scores, missing means and training disclosures', async () => {
  const db = d1(), raw = new Map<string, Uint8Array>(), seen: string[] = [];
  const bucket: Bucket = { head: async k => raw.has(k), put: async (k, v) => raw.set(k, v) };
  const suites = [board(), board('MTEB(eng, v1)')];
  const fetcher = async (url: string) => {
    seen.push(url);
    if (url === `${mtebAPI}/benchmarks?include_hidden=true`) return Response.json(suites);
    const b = suites.find(b => url === `${mtebAPI}/benchmarks/${encodeURIComponent(b.name)}/scores`);
    assert.ok(b, 'no task datasets, weights or results export may be fetched');
    return Response.json(summary(undefined, b.name));
  };
  const discovered = await discoverMTEB({ fetcher });
  assert.deepEqual(discovered, suites, 'off-menu historical suites are retained');
  for (const b of discovered) assert.deepEqual(await importMTEB(db, b, { fetcher, bucket, now: '2026-10-28T00:00:00Z' }), { status: 'ok', rows: 2, models: 1 });
  assert.equal(active(db).length, 4, 'versions and experiment configurations are not averaged together');
  assert.deepEqual(active(db).filter(r => r.benchmark === board().name).map(r => JSON.parse(String(r.payload))).sort((a, b) => Number(!!a.experiments) - Number(!!b.experiments)), summary().rows);
  assert.equal(raw.size, 2); assert.equal(seen.length, 3);
  const before = active(db);
  await importMTEB(db, board(), { fetcher, bucket, now: '2026-10-28T12:00:00Z' });
  assert.deepEqual(active(db), before, 'reimport is idempotent'); assert.equal(raw.size, 2);
});

test('MTEB outages, malformed rows and collapsing feeds retain the previous complete board and its timestamp', async () => {
  const db = d1(), rows = Array.from({ length: 12 }, (_, i) => row(`Lab/Model-${i}`));
  const fetched = (data: unknown) => async () => Response.json(data);
  await importMTEB(db, board(), { fetcher: fetched(summary(rows)), now: '2026-10-28T00:00:00Z', run: 'first' });
  const before = active(db), metadata = db.all('SELECT * FROM cat_mteb_benchmarks');
  for (const [i, fetcher] of [
    fetched(summary(rows.slice(0, 2))), fetched(summary([...rows.slice(0, 10), row('Lab/Duplicate'), row('Lab/Duplicate')])),
    fetched(summary([{ ...row('Lab/Bad'), scoresByTask: { STS: '0.9' } }])),
    fetched(summary(rows, 'wrong board')), async () => new Response('rate limited', { status: 429 }),
  ].entries()) {
    assert.equal((await importMTEB(db, board(), { fetcher, now: '2026-10-29T00:00:00Z', run: `failure-${i}` })).status, 'failed');
    assert.deepEqual(active(db), before); assert.deepEqual(db.all('SELECT * FROM cat_mteb_benchmarks'), metadata);
  }
  assert.equal(db.all("SELECT count(*) n FROM cat_runs WHERE status='failed'")[0]?.n, 5);
  assert.equal(db.all('SELECT last_run FROM cat_sources')[0]?.last_run, 'first');
  // A valid replacement removes rows that really left, rather than retaining every past model forever.
  assert.equal((await importMTEB(db, board(), { fetcher: fetched(summary(rows.slice(0, 7))), run: 'later' })).status, 'ok');
  assert.equal(active(db).length, 7); assert.equal(db.all('SELECT count(*) n FROM cat_mteb_results')[0]?.n, 7);
});

test('MTEB partial database writes are invisible and a retry publishes one complete result version', async () => {
  const db = d1();
  await importMTEB(db, board(), { fetcher: async () => Response.json(summary()), run: 'old' });
  const before = active(db);
  const failed: Database = { ...db, batch: async statements => {
    if (statements.length === 4) throw new Error('publication interrupted');
    return db.batch(statements);
  } };
  const next = summary(Array.from({ length: 25 }, (_, i) => row(`Lab/New-${i}`)));
  assert.equal((await importMTEB(failed, board(), { fetcher: async () => Response.json(next), run: 'next' })).status, 'failed');
  assert.deepEqual(active(db), before);
  assert.deepEqual(await importMTEB(db, board(), { fetcher: async () => Response.json(next), run: 'next' }), { status: 'ok', rows: 25, models: 25 });
  assert.equal(active(db).length, 25); assert.equal(db.all('SELECT count(*) n FROM cat_mteb_results')[0]?.n, 25);
});
