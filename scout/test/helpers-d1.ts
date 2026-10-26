import { DatabaseSync } from 'node:sqlite';
import type { Database, Statement } from '../catalogue-db.ts';

type Value = string | number | null;

// A D1-shaped wrapper over SQLite: prepare/bind/run/all/first and transactional batch.
export function d1(): Database & { all(sql: string, ...args: Value[]): Record<string, unknown>[] } {
  const db = new DatabaseSync(':memory:');
  // node:sqlite rejects D1's numbered ?N placeholders; expand them positionally.
  const positional = (sql: string, args: Value[]): [string, Value[]] => { const order: Value[] = []; return [sql.replace(/\?(\d+)/g, (_, n: string) => (order.push(args[Number(n) - 1] ?? null), '?')), order.length ? order : args]; };
  const statement = (sql: string, args: Value[] = []): Statement => { const [q, a] = positional(sql, args); return { bind: (...b: Value[]) => statement(sql, b), run: async () => ({ meta: { changes: Number(db.prepare(q).run(...a).changes) } }),
    all: async <Row>() => ({ results: db.prepare(q).all(...a) as Row[] }) }; };
  return { prepare: (sql: string) => statement(sql), all: (sql: string, ...a: Value[]) => db.prepare(sql).all(...a),
    batch: async (statements: Statement[]) => { db.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
