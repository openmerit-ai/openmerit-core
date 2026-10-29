// Final per-model results from media and decision-model leaderboards (image, editing,
// video, speech, transcription, music, decisions), kept verbatim with provenance. Like
// MTEB, these stay out of chat evidence; decision boards only break equal-cost ties in
// task-fit shortlists (catalogue-routes.ts decisionScores). A result
// links to a canonical model only when its name matches exactly one catalogue
// model of the board's kind.
import { parquetReadObjects } from 'hyparquet';
import { type Database, type Bucket, chunked, digest, ensureCatalogueSchema, isObject, obj, readSource, text, date } from './catalogue-db.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface Options { fetcher?: Fetcher; bucket?: Bucket; now?: string; run?: string }

const schema = [
  'CREATE TABLE IF NOT EXISTS cat_boards (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, metric TEXT NOT NULL, direction TEXT NOT NULL, url TEXT NOT NULL, license TEXT NOT NULL, published_at TEXT, version TEXT NOT NULL, artifact TEXT NOT NULL, results INTEGER NOT NULL, linked INTEGER NOT NULL, checked_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cat_board_results (board TEXT NOT NULL, version TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, creator TEXT, score REAL NOT NULL, ci_lower REAL, ci_upper REAL, samples INTEGER, released TEXT, model_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(board,version,model,variant))',
  'CREATE INDEX IF NOT EXISTS cat_board_results_model ON cat_board_results(model_id)',
];

export interface BoardResult { model: string; variant: string; creator: string | null; score: number; ci_lower: number | null; ci_upper: number | null; samples: number | null; released: string | null; payload: Record<string, unknown> }
export interface Board { id: string; title: string; kind: string; metric: string; direction: 'higher' | 'lower'; url: string; published_at: string | null; results: BoardResult[] }
interface BoardSource { id: string; name: string; url: string; license: string; type: 'html' | 'parquet' | 'json'; maxBytes: number; role?: string; parse(data: unknown): Board[] }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown) => finite(v) && v >= 0 ? Math.round(v) : null;

// Serialized Next.js flight data; scripts on the page are never evaluated.
export function flightRecords(html: string, match: (row: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  let flight = '', found: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1] ?? '""') as string;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length > found.length && value.every(r => isObject(r) && match(r))) found = value as Record<string, unknown>[];
    for (const child of Object.values(value)) if (typeof child === 'object') walk(child);
  };
  for (const line of flight.split('\n')) { const m = line.match(/^[\da-f]+:(\[.*|\{.*)$/); if (m?.[1]) { try { walk(JSON.parse(m[1])); } catch { /* not a data line */ } } }
  return found;
}

// Artificial Analysis arenas: Elo from blind pairwise votes. Confidence intervals are
// published only on some boards; their absence is not zero uncertainty.
function analysisArena(html: string, board: Omit<Board, 'results' | 'published_at' | 'metric' | 'direction'>): Board {
  const rows = flightRecords(html, r => isObject(r.values) && typeof obj(r.values).name === 'string' && finite(obj(r.values).elo));
  if (rows.length < 5) throw new Error(`${board.title}: format changed.`);
  const results = rows.map(r => {
    const v = obj(r.values), { formatted: _f, ...payload } = r;
    return { model: String(v.name), variant: text(v.id) ?? '', creator: text(obj(v.creator).name), score: Number(v.elo), ci_lower: finite(v.ciLower) ? v.ciLower : null, ci_upper: finite(v.ciUpper) ? v.ciUpper : null,
      samples: count(v.appearances), released: date(v.releaseDate), payload: { ...payload, values: { ...v, note: undefined } } };
  });
  return { ...board, metric: 'Elo', direction: 'higher', published_at: null, results };
}
// Speech-to-text rows are endpoints (model on a host); the host is the variant.
function analysisSTT(html: string, board: Omit<Board, 'results' | 'published_at' | 'metric' | 'direction'>, field: string): Board {
  const rows = flightRecords(html, r => typeof r.hostApiId === 'string' && isObject(r.model) && isObject(r.host));
  const results = rows.filter(r => finite(r[field])).map(r => {
    const model = obj(r.model), host = obj(r.host), { performanceOverTime: _p, ...payload } = r;
    return { model: text(model.shortName) ?? String(model.name ?? r.name), variant: `${text(host.slug) ?? ''}:${String(r.hostApiId)}`, creator: text(host.name), score: Number(r[field]),
      ci_lower: null, ci_upper: null, samples: null, released: date(model.releaseDate), payload };
  });
  if (results.length < 5) throw new Error(`${board.title}: format changed.`);
  return { ...board, metric: 'Word error rate index', direction: 'lower', published_at: null, results };
}

// LMArena publishes Bradley-Terry ratings per category, each with its own date.
// Ratings are stored as published; intervals wider than 60 points stay, flagged by ci.
function arenaBoards(rows: Record<string, unknown>[], prefix: string, kind: string, page: string, categories: ReadonlyArray<readonly [string, string]>): Board[] {
  if (rows.length < 5) throw new Error(`Arena ${prefix} format changed.`);
  return categories.map(([category, title]) => {
    const list = rows.filter(r => r.category === category && typeof r.model_name === 'string' && finite(r.rating));
    const dates = new Set(list.map(r => r.leaderboard_publish_date));
    if (list.length < 5 || dates.size !== 1) throw new Error(`Arena ${prefix} ${category} is missing or mixed.`);
    return { id: `arena:${prefix}${category === 'overall' ? '' : `:${category}`}`, title, kind, metric: 'Arena rating', direction: 'higher' as const, url: page, published_at: date([...dates][0]),
      results: list.map(r => ({ model: String(r.model_name), variant: '', creator: text(r.organization), score: Number(r.rating), ci_lower: finite(r.rating_lower) ? r.rating_lower : null,
        ci_upper: finite(r.rating_upper) ? r.rating_upper : null, samples: count(typeof r.vote_count === 'bigint' ? Number(r.vote_count) : r.vote_count), released: null, payload: { ...r, vote_count: count(Number(r.vote_count)) } })) };
  });
}

// Artificial Analysis Decision Index: decision models and LLMs on one 0–100 index. The LLM
// rows stay in the board; they link only if a decision-kind model has the same name.
function analysisDecisions(html: string): Board {
  const rows = flightRecords(html, r => typeof r.slug === 'string' && typeof r.kind === 'string' && typeof r.name === 'string' && 'indexScore' in r);
  const results = rows.filter(r => finite(r.indexScore)).map(r => ({ model: String(r.name), variant: String(r.slug), creator: text(r.creatorName), score: Number(r.indexScore),
    ci_lower: null, ci_upper: null, samples: null, released: null, payload: r }));
  if (results.length < 5) throw new Error('Artificial Analysis Decision Index: format changed.');
  const url = `${AA}/evaluations/artificial-analysis-decision-index`;
  return { id: 'analysis:decision-index', title: 'Artificial Analysis · Decision Index', kind: 'decision', metric: 'Decision Index', direction: 'higher', url, published_at: null, results };
}
// JevBench capability: the mean of its intelligence and calibration axes (0–100), which
// leaves out the speed and cost axes. Only rows JevBench itself ranks are kept; listed,
// wrapper, preliminary and re-measure-pending rows have no official standing.
function jevBench(data: unknown): Board {
  const root = obj(data), systems = Array.isArray(root.systems) ? root.systems.filter(isObject) : [];
  const ranked = systems.filter(s => s.listing === 'ranked' && typeof s.name === 'string' && typeof s.key === 'string' && finite(obj(s.capability).score));
  if (ranked.length < 50 || typeof root.revision !== 'string') throw new Error('JevBench: format changed.');
  const measured = ranked.map(s => date(obj(s.draw).measured_on)).filter((d): d is string => !!d).sort();
  return { id: 'jevbench:capability', title: `JevBench capability (${root.revision})`, kind: 'decision', metric: 'Capability (intelligence and calibration)', direction: 'higher', url: 'https://benchmarkheaven.com/jev-models',
    published_at: measured.at(-1) ?? null, results: ranked.map(s => ({ model: String(s.name), variant: String(s.key), creator: null, score: Number(obj(s.capability).score),
      ci_lower: null, ci_upper: null, samples: null, released: null, payload: { ...s, revision: root.revision } })) };
}

const decisionRole = 'Final decision-model leaderboard results; break equal-cost ties in task-fit shortlists';
const AA = 'https://artificialanalysis.ai', aaLicense = 'Artificial Analysis public leaderboard pages; final results only, attributed', arenaLicense = 'CC BY 4.0';
const arenaData = (board: string) => `https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/${board}/latest-00000-of-00001.parquet`;
const aa = (path: string, id: string, title: string, kind: string, stt?: string): BoardSource => ({ id: `analysis-board:${id}`, name: `Artificial Analysis · ${title}`, url: `${AA}${path}`, license: aaLicense, type: 'html', maxBytes: 8_000_000,
  parse: data => [stt ? analysisSTT(String(data), { id: `analysis:${id}`, title: `Artificial Analysis · ${title}`, kind, url: `${AA}${path}` }, stt) : analysisArena(String(data), { id: `analysis:${id}`, title: `Artificial Analysis · ${title}`, kind, url: `${AA}${path}` })] });
const arena = (board: string, prefix: string, kind: string, page: string, categories: ReadonlyArray<readonly [string, string]>): BoardSource => ({ id: `arena-board:${board}`, name: `Arena · ${board}`, url: arenaData(board), license: arenaLicense, type: 'parquet', maxBytes: 2_000_000,
  parse: data => arenaBoards(data as Record<string, unknown>[], prefix, kind, page, categories) });

// Categories with stale dates (Arena's 2025 language splits) or a handful of models are not read.
export const boardSources: BoardSource[] = [
  aa('/image/leaderboard/text-to-image', 'text-to-image', 'Text to image', 'image'),
  aa('/image/leaderboard/editing', 'image-editing', 'Image editing', 'image'),
  aa('/video/leaderboard/text-to-video', 'text-to-video', 'Text to video', 'video'),
  aa('/video/leaderboard/image-to-video', 'image-to-video', 'Image to video', 'video'),
  aa('/video/leaderboard/video-editing', 'video-editing', 'Video editing', 'video'),
  aa('/text-to-speech/leaderboard/provider-voice', 'tts-provider-voice', 'Text to speech (provider voices)', 'speech'),
  aa('/text-to-speech/leaderboard/controlled-voice', 'tts-controlled-voice', 'Text to speech (controlled voice)', 'speech'),
  aa('/music/leaderboard/instrumental', 'music-instrumental', 'Music (instrumental)', 'music'),
  aa('/music/leaderboard/vocals', 'music-vocals', 'Music (vocals)', 'music'),
  aa('/speech-to-text/non-streaming', 'stt', 'Speech to text', 'transcription', 'aaWerIndex'),
  aa('/speech-to-text/streaming', 'stt-streaming', 'Speech to text (streaming)', 'transcription', 'aaWerStreamingIndex'),
  arena('text_to_image', 'text-to-image', 'image', 'https://arena.ai/leaderboard/text-to-image', [['overall', 'Arena · Text to image'], ['photorealistic', 'Arena · Text to image: photorealistic'],
    ['text_rendering', 'Arena · Text to image: text rendering'], ['commercial_design', 'Arena · Text to image: commercial design'], ['portraits', 'Arena · Text to image: portraits'], ['art', 'Arena · Text to image: art'],
    ['cartoon', 'Arena · Text to image: cartoon'], ['3d_modeling', 'Arena · Text to image: 3D modelling']]),
  arena('image_edit', 'image-edit', 'image', 'https://arena.ai/leaderboard/image-edit', [['overall', 'Arena · Image editing'], ['multi_image_edit', 'Arena · Multi-image editing']]),
  arena('text_to_video', 'text-to-video', 'video', 'https://arena.ai/leaderboard/text-to-video', [['overall', 'Arena · Text to video']]),
  arena('image_to_video', 'image-to-video', 'video', 'https://arena.ai/leaderboard/image-to-video', [['overall', 'Arena · Image to video']]),
  arena('video_edit', 'video-edit', 'video', 'https://arena.ai/leaderboard/video-edit', [['overall', 'Arena · Video editing']]),
  { id: 'analysis-board:decision-index', name: 'Artificial Analysis · Decision Index', url: `${AA}/evaluations/artificial-analysis-decision-index`, license: aaLicense, type: 'html', maxBytes: 8_000_000, role: decisionRole, parse: data => [analysisDecisions(String(data))] },
  { id: 'jevbench', name: 'JevBench (Benchmark Heaven)', url: 'https://benchmarkheaven.com/api/jevbench/latest', license: 'No licence stated; final results only, attributed', type: 'json', maxBytes: 4_000_000, role: decisionRole, parse: data => [jevBench(data)] },
];

// Exact names only: lower-case alphanumerics, without a trailing run setting such as "(max)".
export const boardName = (v: string) => v.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
export function linkResults(results: readonly BoardResult[], kind: string, candidates: ReadonlyArray<{ id: string; kind: string | null; names: readonly string[] }>): Map<BoardResult, string> {
  const byName = new Map<string, Set<string>>();
  for (const c of candidates) if (c.kind === kind) for (const n of c.names) { const k = boardName(n); if (k.length >= 3) byName.set(k, (byName.get(k) ?? new Set()).add(c.id)); }
  const out = new Map<BoardResult, string>();
  for (const r of results) { const hits = byName.get(boardName(r.model)); if (hits?.size === 1) out.set(r, [...hits][0] ?? ''); }
  return out;
}

export type BoardImport = { status: 'ok'; boards: number; results: number; linked: number } | { status: 'failed'; error: string };
// One source per call. Every board it yields is validated before any is written, and
// each board's new version becomes visible in the final batch.
export async function importBoards(db: Database, source: BoardSource, options: Options = {}): Promise<BoardImport> {
  const { fetcher = fetch, bucket, now = new Date().toISOString() } = options, run = options.run ?? `${source.id}-${now}`;
  await ensureCatalogueSchema(db);
  await db.batch(schema.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare('INSERT INTO cat_sources (id,name,url,license,role) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,license=excluded.license,role=excluded.role')
      .bind(source.id, source.name, source.url, source.license, source.role ?? 'Final leaderboard results; not yet used in ranking'),
    db.prepare("INSERT OR REPLACE INTO cat_runs (id,source,started_at,status) VALUES (?1,?2,?3,'running')").bind(run, source.id, now),
  ]);
  try {
    const bytes = await readSource(fetcher, source.url, source.maxBytes);
    const data: unknown = source.type === 'parquet' ? await parquetReadObjects({ file: bytes.buffer }) : source.type === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : new TextDecoder().decode(bytes);
    const boards = source.parse(data);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const artifact = `catalogue-raw/boards/${hash}.${source.type}`;
    const candidates = (await db.prepare(`SELECT g.id,g.kind,json_group_array(n.name) names FROM cat_model_merged g JOIN (SELECT id,name FROM cat_model_merged WHERE name IS NOT NULL
      UNION SELECT id,substr(id,instr(id,'/')+1) FROM cat_model_merged UNION SELECT model_id,name FROM cat_offerings WHERE model_id IS NOT NULL AND name IS NOT NULL) n ON n.id=g.id GROUP BY g.id`)
      .all<{ id: string; kind: string | null; names: string }>()).results.map(c => ({ id: c.id, kind: c.kind, names: JSON.parse(c.names) as string[] }));
    const prepared = [];
    for (const board of boards) {
      const previous = (await db.prepare('SELECT results FROM cat_boards WHERE id=?1').bind(board.id).all<{ results: number }>()).results[0]?.results ?? 0;
      if (previous > 10 && board.results.length < previous * .5) throw new Error(`${board.id} dropped from ${previous} to ${board.results.length} results; previous results retained.`);
      const keys = new Set<string>();
      for (const r of board.results) { const k = JSON.stringify([r.model, r.variant]); if (keys.has(k)) throw new Error(`${board.id}: duplicate result for ${r.model}.`); keys.add(k); }
      const links = linkResults(board.results, board.kind, candidates), version = await digest([board.id, board.published_at, board.results.map(r => [r.model, r.variant, r.score, r.ci_lower, r.ci_upper, r.samples])]);
      prepared.push({ board, version, links, rows: board.results.map(r => ({ ...r, model_id: links.get(r) ?? null, payload: JSON.stringify(r.payload, (_k, v: unknown) => typeof v === 'bigint' ? Number(v) : v) })) });
    }
    if (bucket && !await bucket.head(artifact)) await bucket.put(artifact, bytes, { httpMetadata: { contentType: { parquet: 'application/vnd.apache.parquet', json: 'application/json', html: 'text/html' }[source.type] } });
    for (const p of prepared) await chunked(db, `INSERT OR REPLACE INTO cat_board_results (board,version,model,variant,creator,score,ci_lower,ci_upper,samples,released,model_id,payload)
      SELECT ?1,?2,${['model', 'variant', 'creator', 'score', 'ci_lower', 'ci_upper', 'samples', 'released', 'model_id', 'payload'].map(c => `json_extract(value,'$.${c}')`).join(',')} FROM json_each(?3)`, p.rows, [p.board.id, p.version], 50);
    await db.batch([
      ...prepared.flatMap(p => [
        db.prepare(`INSERT INTO cat_boards (id,source,title,kind,metric,direction,url,license,published_at,version,artifact,results,linked,checked_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
          ON CONFLICT(id) DO UPDATE SET source=excluded.source,title=excluded.title,kind=excluded.kind,metric=excluded.metric,direction=excluded.direction,url=excluded.url,license=excluded.license,
          published_at=excluded.published_at,version=excluded.version,artifact=excluded.artifact,results=excluded.results,linked=excluded.linked,checked_at=excluded.checked_at`)
          .bind(p.board.id, source.id, p.board.title, p.board.kind, p.board.metric, p.board.direction, p.board.url, source.license, p.board.published_at, p.version, artifact, p.rows.length, p.links.size, now),
        db.prepare('DELETE FROM cat_board_results WHERE board=?1 AND version<>?2').bind(p.board.id, p.version)]),
      db.prepare("UPDATE cat_runs SET finished_at=?2,status='ok',artifact=?3,artifact_bytes=?4,listings=?5 WHERE id=?1").bind(run, new Date().toISOString(), hash, bytes.length, prepared.reduce((n, p) => n + p.rows.length, 0)),
      db.prepare('UPDATE cat_sources SET last_success_at=?2,last_run=?3 WHERE id=?1').bind(source.id, now, run),
    ]);
    return { status: 'ok', boards: prepared.length, results: prepared.reduce((n, p) => n + p.rows.length, 0), linked: prepared.reduce((n, p) => n + p.links.size, 0) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    await db.prepare("UPDATE cat_runs SET finished_at=?2,status='failed',error=?3 WHERE id=?1").bind(run, new Date().toISOString(), message).run();
    return { status: 'failed', error: message };
  }
}
