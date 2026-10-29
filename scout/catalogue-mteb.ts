// Only MTEB's published final leaderboard summaries, never task corpora,
// embeddings, predictions or the expanded per-example results export.
// These stay outside chat evidence: a retrieval score is not chat quality.
import { type Database, type Bucket, type Row, chunked, digest, ensureCatalogueSchema, isObject, obj, readSource } from './catalogue-db.ts';

export const mtebAPI = 'https://mteb-leaderboard-backend.hf.space/v1';
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface Options { fetcher?: Fetcher; bucket?: Bucket; now?: string; run?: string }
export interface MTEBBenchmark extends Record<string, unknown> { name: string }

// Readers join results to the benchmark's active version. A partial write is
// invisible until the last transaction, and historical responses remain in R2.
const schema = [
  'CREATE TABLE IF NOT EXISTS cat_mteb_benchmarks (name TEXT PRIMARY KEY, metadata TEXT NOT NULL, summary TEXT NOT NULL, version TEXT NOT NULL, artifact TEXT NOT NULL, checked_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cat_mteb_results (benchmark TEXT NOT NULL, version TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(benchmark,version,model,variant))',
  'CREATE INDEX IF NOT EXISTS cat_mteb_results_model ON cat_mteb_results(model)',
];

export async function discoverMTEB({ fetcher = fetch }: Options = {}): Promise<MTEBBenchmark[]> {
  const data: unknown = JSON.parse(new TextDecoder().decode(await readSource(fetcher, `${mtebAPI}/benchmarks?include_hidden=true`, 2_000_000)));
  if (!Array.isArray(data) || !data.length || data.length > 500) throw new Error('MTEB benchmark directory format changed.');
  const names = new Set<string>();
  return data.map((value: unknown) => {
    const b = obj(value);
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200 || names.has(b.name) || !Array.isArray(b.tasks) || !Array.isArray(b.modalities)) throw new Error('Invalid MTEB benchmark metadata.');
    names.add(b.name);
    return { ...b, name: b.name };
  });
}

// Keep the publisher's numbers verbatim. Correlation metrics can be negative;
// null aggregates denote incomplete coverage, not zero. Do not recompute means
// or collapse experiment variants, task versions, languages or model names.
export function parseMTEB(data: unknown, name: string): { summary: Record<string, unknown>; rows: Record<string, unknown>[] } {
  const b = obj(data);
  if (b.benchmarkName !== name || !Array.isArray(b.tasks) || !Array.isArray(b.tasksMeta) || !Array.isArray(b.rows)) throw new Error('MTEB final-results format changed.');
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  const scores = (value: unknown) => isObject(value) && Object.values(value).every(numeric);
  const rows = b.rows.map((value: unknown) => {
    const r = obj(value), model = obj(r.model);
    if (typeof model.name !== 'string' || !model.name.trim() || !numeric(r.rank) ||
      ![r.meanTask, r.meanTaskType].every(v => v === null || numeric(v)) ||
      !scores(r.scoresByTask) || !scores(r.scoresByTaskType) ||
      !(r.experiments == null || isObject(r.experiments))) throw new Error('Invalid MTEB final-result row.');
    return r;
  });
  const { rows: _rows, ...summary } = b;
  return { summary, rows };
}

export type MTEBImport = { status: 'ok'; rows: number; models: number } | { status: 'failed'; error: string };
export async function importMTEB(db: Database, benchmark: MTEBBenchmark, options: Options = {}): Promise<MTEBImport> {
  const { fetcher = fetch, bucket, now = new Date().toISOString() } = options;
  const name = benchmark.name, source = `mteb:${name}`, run = options.run ?? `${source}-${now}`, url = `${mtebAPI}/benchmarks/${encodeURIComponent(name)}/scores`;
  await ensureCatalogueSchema(db);
  await db.batch(schema.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare('INSERT INTO cat_sources (id,name,url,license,role) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,license=excluded.license,role=excluded.role')
      .bind(source, `MTEB · ${name}`, url, 'CC0-1.0 (MTEB results); task dataset licences are separate', 'Published embedding/retrieval leaderboard results; not chat quality or independent verification'),
    db.prepare("INSERT OR REPLACE INTO cat_runs (id,source,started_at,status) VALUES (?1,?2,?3,'running')").bind(run, source, now),
  ]);
  try {
    const bytes = await readSource(fetcher, url, 8_000_000), parsed = parseMTEB(JSON.parse(new TextDecoder().decode(bytes)), name);
    const previous = (await db.prepare('SELECT count(*) n FROM cat_mteb_results r JOIN cat_mteb_benchmarks b ON b.name=r.benchmark AND b.version=r.version WHERE b.name=?1').bind(name).all<{ n: number }>()).results[0]?.n ?? 0;
    if (previous > 10 && parsed.rows.length < previous * .5) throw new Error(`MTEB results dropped from ${previous} to ${parsed.rows.length}; previous results retained.`);
    if (!parsed.rows.length && benchmark.numModels !== 0) throw new Error('MTEB returned no final results.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const artifact = `catalogue-raw/mteb/${hash}.json`, version = await digest([benchmark, parsed.summary, parsed.rows]);
    const rows: Row[] = [], identities = new Set<string>(), models = new Set<string>();
    for (const r of parsed.rows) {
      const model = String(obj(r.model).name), variant = await digest(r.experiments ?? null), key = JSON.stringify([model, variant]);
      if (identities.has(key)) throw new Error('Duplicate MTEB model/experiment identity; previous results retained.');
      identities.add(key); models.add(model);
      rows.push({ model, variant, payload: JSON.stringify(r) });
    }
    if (bucket && !await bucket.head(artifact)) await bucket.put(artifact, bytes, { httpMetadata: { contentType: 'application/json' } });
    await chunked(db, `INSERT OR REPLACE INTO cat_mteb_results (benchmark,version,model,variant,payload)
      SELECT ?1,?2,json_extract(value,'$.model'),json_extract(value,'$.variant'),json_extract(value,'$.payload') FROM json_each(?3)`, rows, [name, version], 20);
    await db.batch([
      db.prepare('INSERT INTO cat_mteb_benchmarks (name,metadata,summary,version,artifact,checked_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(name) DO UPDATE SET metadata=excluded.metadata,summary=excluded.summary,version=excluded.version,artifact=excluded.artifact,checked_at=excluded.checked_at')
        .bind(name, JSON.stringify(benchmark), JSON.stringify(parsed.summary), version, artifact, now),
      db.prepare('DELETE FROM cat_mteb_results WHERE benchmark=?1 AND version<>?2').bind(name, version),
      db.prepare("UPDATE cat_runs SET finished_at=?2,status='ok',artifact=?3,artifact_bytes=?4,listings=?5 WHERE id=?1").bind(run, new Date().toISOString(), hash, bytes.length, rows.length),
      db.prepare('UPDATE cat_sources SET last_success_at=?2,last_run=?3 WHERE id=?1').bind(source, now, run),
    ]);
    return { status: 'ok', rows: rows.length, models: models.size };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    await db.prepare("UPDATE cat_runs SET finished_at=?2,status='failed',error=?3 WHERE id=?1").bind(run, new Date().toISOString(), message).run();
    return { status: 'failed', error: message };
  }
}
