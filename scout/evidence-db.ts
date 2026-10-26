// Evidence ledger in D1: the refresh's research inspections and per-capability
// benchmark interpretations. These are caches keyed by content hashes that only
// the refresh reads, so they live in rows looked up per subject instead of in
// the published catalogue that every refresh step would otherwise parse.
import type { Database, Statement } from './catalogue-db.ts';

type Value = string | number | null;
type Json = Record<string, unknown>;

// One statement per entry: D1 exec splits on newlines, so schema goes through batch.
export const evidenceSchema = [
  'CREATE TABLE IF NOT EXISTS ev_research (id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, subject_hash TEXT, content_hash TEXT, name TEXT, url TEXT, inspection_hash TEXT, verified_at TEXT, record TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS ev_research_kind ON ev_research(kind)',
  'CREATE TABLE IF NOT EXISTS ev_capabilities (benchmark_id TEXT NOT NULL, capability_id TEXT NOT NULL, source_hash TEXT NOT NULL, definition_hash TEXT NOT NULL, choice TEXT NOT NULL, confidence REAL NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(benchmark_id,capability_id))',
  'CREATE TABLE IF NOT EXISTS ev_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

export interface ResearchEntry extends Json { id: string }
export interface Answer { choice: string; confidence: number; definitionHash: string }
export interface Interpretation { benchmark: string; sourceHash: string; answers: Record<string, Answer> }
export interface ResearchLedger {
  get(ids: readonly string[]): Promise<Map<string, ResearchEntry>>;
  save(entries: readonly ResearchEntry[]): Promise<void>;
  providers(): Promise<ResearchEntry[]>;
}
export interface InterpretationLedger {
  get(benchmark: string, sourceHash: string): Promise<Record<string, Answer>>;
  save(rows: readonly Interpretation[]): Promise<void>;
}

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
// D1 limits a row to 2 MB; a larger cache entry is skipped and inspected again.
const maxRowBytes = 1_800_000, maxStatementBytes = 900_000;

// Rows go to D1 as JSON arrays expanded by json_each, bounded by bytes per
// statement because research records vary from a few KB to tens of KB. Rows are
// serialized lazily, so at most one batch of statements is held at a time.
async function insert(db: Database, sql: string, rows: Iterable<string>, bindings: Value[]): Promise<void> {
  let statements: Statement[] = [], part: string[] = [], size = 0;
  const flush = () => { if (part.length) statements.push(db.prepare(sql).bind(...bindings, `[${part.join(',')}]`)); part = []; size = 0; };
  for (const row of rows) {
    if (size + row.length > maxStatementBytes) flush();
    if (statements.length === 4) { await db.batch(statements); statements = []; }
    part.push(row); size += row.length + 1;
  }
  flush();
  if (statements.length) await db.batch(statements);
}

// A stored inspection's record is the enclosing research entry itself; keep one copy.
const compact = (entry: ResearchEntry): ResearchEntry => {
  if (!isObject(entry.inspection) || !('record' in entry.inspection)) return entry;
  const { record: _record, ...inspection } = entry.inspection;
  return { ...entry, inspection };
};

export async function evidenceLedger(db: Database, now: () => string = () => new Date().toISOString()): Promise<{ research: ResearchLedger; interpretations: InterpretationLedger }> {
  await db.batch(evidenceSchema.map(s => db.prepare(s)));
  const research: ResearchLedger = {
    async get(ids) {
      const out = new Map<string, ResearchEntry>();
      if (!ids.length) return out;
      const { results } = await db.prepare('SELECT record FROM ev_research WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...new Set(ids)])).all<{ record: string }>();
      for (const { record } of results) { const entry: unknown = JSON.parse(record); if (isObject(entry) && typeof entry.id === 'string') out.set(entry.id, { ...entry, id: entry.id }); }
      return out;
    },
    async save(entries) {
      const rows = function* () {
        for (const raw of entries) {
          const entry = compact(raw), record = JSON.stringify(entry);
          if (record.length > maxRowBytes) continue;
          yield JSON.stringify({ id: entry.id, kind: str(entry.kind), subject_id: str(entry.subjectId), subject_hash: str(entry.subjectHash), content_hash: str(entry.contentHash),
            name: str(entry.name), url: str(entry.url), inspection_hash: str(entry.inspectionHash), verified_at: str(entry.verifiedAt), record });
        }
      };
      const columns = ['id', 'kind', 'subject_id', 'subject_hash', 'content_hash', 'name', 'url', 'inspection_hash', 'verified_at', 'record'];
      await insert(db, `INSERT INTO ev_research (${columns.join(',')},updated_at) SELECT ${columns.map(c => `json_extract(value,'$.${c}')`).join(',')},?1 FROM json_each(?2) WHERE true
        ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c => `${c}=excluded.${c}`).join(',')},updated_at=excluded.updated_at`, rows(), [now()]);
    },
    // Research planning needs only each provider's identity and content hash.
    async providers() {
      const { results } = await db.prepare("SELECT id,name,url,content_hash FROM ev_research WHERE kind='provider' ORDER BY id").all<{ id: string; name: string | null; url: string | null; content_hash: string | null }>();
      return results.map(r => ({ id: r.id, kind: 'provider', name: r.name, url: r.url, contentHash: r.content_hash }));
    },
  };
  const interpretations: InterpretationLedger = {
    async get(benchmark, sourceHash) {
      const { results } = await db.prepare('SELECT capability_id,choice,confidence,definition_hash FROM ev_capabilities WHERE benchmark_id=?1 AND source_hash=?2').bind(benchmark, sourceHash)
        .all<{ capability_id: string; choice: string; confidence: number; definition_hash: string }>();
      return Object.fromEntries(results.map(r => [r.capability_id, { choice: r.choice, confidence: r.confidence, definitionHash: r.definition_hash }]));
    },
    // Each benchmark's answers replace its previous source's answers.
    async save(rows) {
      const flat = function* () { for (const r of rows) for (const [capability, a] of Object.entries(r.answers)) yield JSON.stringify([r.benchmark, capability, r.sourceHash, a.definitionHash, a.choice, a.confidence]); };
      await insert(db, `INSERT INTO ev_capabilities (benchmark_id,capability_id,source_hash,definition_hash,choice,confidence,updated_at)
        SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),?1 FROM json_each(?2) WHERE true
        ON CONFLICT(benchmark_id,capability_id) DO UPDATE SET source_hash=excluded.source_hash,definition_hash=excluded.definition_hash,choice=excluded.choice,confidence=excluded.confidence,updated_at=excluded.updated_at`, flat(), [now()]);
      // Capabilities missing from a newer interpretation are not answers for its source.
      const sources = rows.map(r => [r.benchmark, r.sourceHash]);
      if (sources.length) await db.prepare("DELETE FROM ev_capabilities WHERE EXISTS (SELECT 1 FROM json_each(?1) k WHERE json_extract(k.value,'$[0]')=benchmark_id AND json_extract(k.value,'$[1]')<>source_hash)").bind(JSON.stringify(sources)).run();
    },
  };
  return { research, interpretations };
}

const answer = (v: unknown): v is Answer => isObject(v) && typeof v.choice === 'string' && typeof v.confidence === 'number' && typeof v.definitionHash === 'string';

// Generations published before the ledger embed research and per-capability
// answers. Once per generation, move both into the ledger and store the
// records without them, so no later step parses them again.
export async function migrateGeneration(db: Database, ledgers: { research: ResearchLedger; interpretations: InterpretationLedger }, key: string,
  io: { load(): Promise<{ records: Json; research: readonly ResearchEntry[] }>; save(records: Json): Promise<unknown> }): Promise<{ research: number; interpretations: number } | { skipped: true }> {
  const marker = `migrated:${key}`;
  if ((await db.prepare('SELECT value FROM ev_meta WHERE key=?1').bind(marker).all()).results.length) return { skipped: true };
  // Drop each part once it is in the ledger, so the rewrite holds only what remains.
  const loaded = await io.load(), { records } = loaded, research = loaded.research.length, rows: Interpretation[] = [];
  await ledgers.research.save(loaded.research);
  loaded.research = []; delete records.research;
  for (const b of Array.isArray(records.benchmarks) ? records.benchmarks : []) {
    if (!isObject(b) || typeof b.id !== 'string' || !isObject(b.interpretation)) continue;
    const { capabilities, ...interpretation } = b.interpretation;
    if (isObject(capabilities) && interpretation.status === 'ready' && typeof interpretation.sourceHash === 'string')
      rows.push({ benchmark: b.id, sourceHash: interpretation.sourceHash, answers: Object.fromEntries(Object.entries(capabilities).filter((e): e is [string, Answer] => answer(e[1]))) });
    b.interpretation = interpretation;
  }
  await ledgers.interpretations.save(rows);
  const moved = { research, interpretations: rows.length };
  rows.length = 0;
  await io.save(records);
  await db.prepare('INSERT OR REPLACE INTO ev_meta (key,value) VALUES (?1,?2)').bind(marker, JSON.stringify(moved)).run();
  return moved;
}
