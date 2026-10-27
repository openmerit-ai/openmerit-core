// Repeatable searches. A completed search records each provider answer it
// received; an identical later request replays that answer instead of asking
// again. The interpretation, evidence assessment and ranking then repeat
// exactly. Entries are keyed by a hash of the provider request and encrypted
// with a key derived from that request, so a stored answer can only be read
// with the exact request text. Entries expire after answerTtlMs.
import type { Database } from './catalogue-db.ts';

export const answerTtlMs = 7 * 86_400_000;
// Marks a replayed answer, which is not a provider call in search diagnostics.
export const replayHeader = 'x-scout-answer-replay';
export interface AnswerRow { id: string; value: string; at: number }
export interface AnswerStore {
  get(id: string, since: number): Promise<string | null>;
  put(rows: readonly AnswerRow[], before: number): Promise<void>;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const cacheable = /^https:\/\/api\.openai\.com\/v1\/(responses|decisions|embeddings)$/;
const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => crypto.subtle.digest('SHA-256', encode(text));

async function keysFor(url: string, body: string) {
  const [id, secret] = await Promise.all([sha256(`scout-answer-id\n${url}\n${body}`), sha256(`scout-answer-key\n${url}\n${body}`)]);
  return { id: [...new Uint8Array(id)].map(b => b.toString(16).padStart(2, '0')).join(''), key: await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)), sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encode(text)));
  const all = new Uint8Array(iv.length + sealed.length);all.set(iv);all.set(sealed, iv.length);
  let binary = '';for (let i = 0; i < all.length; i += 0x8000) binary += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function open(key: CryptoKey, value: string): Promise<string> {
  const all = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12)));
}

// Wraps one search's provider transport. Answers are written only by commit(),
// which the caller runs after the search completed, so a failed or degraded
// search never pins its answers. A store failure falls back to the provider.
export function answerTransport(store: AnswerStore | undefined, fetcher: Fetcher, now: () => number = Date.now) {
  const recorded: Promise<AnswerRow>[] = [];
  const fetch: Fetcher = async (url, init) => {
    const body = init?.body;
    if (!store || !cacheable.test(url) || typeof body !== 'string') return fetcher(url, init);
    const { id, key } = await keysFor(url, body);
    try {
      const stored = await store.get(id, now() - answerTtlMs);
      if (stored) { const text = await open(key, stored);return new Response(text, { status: 200, headers: { 'content-type': 'application/json', [replayHeader]: '1' } }); }
    } catch { /* An unreadable entry is a miss. */ }
    const response = await fetcher(url, init);
    if (!response.ok) return response;
    // Read the body here rather than through clone(): a clone of an aborted
    // response can stay pending forever, which would hold commit() open.
    const text = await response.text();
    recorded.push(seal(key, text).then(value => ({ id, value, at: now() })));
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch,
    async commit(): Promise<void> {
      if (!store || !recorded.length) return;
      try { await store.put(await Promise.all(recorded.splice(0)), now() - answerTtlMs); } catch { /* Best effort: the next identical search asks again. */ }
    },
  };
}

export function d1Answers(db: Database): AnswerStore {
  let ready: Promise<unknown> | undefined;
  const schema = () => ready ??= db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS scout_answers (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS scout_answers_created ON scout_answers(created_at)'),
  ]).catch(error => { ready = undefined;throw error; });
  return {
    async get(id, since) {
      await schema();
      const { results } = await db.prepare('SELECT value FROM scout_answers WHERE id = ? AND created_at >= ?').bind(id, since).all<{ value: string }>();
      return results[0]?.value ?? null;
    },
    async put(rows, before) {
      await schema();
      await db.batch([db.prepare('DELETE FROM scout_answers WHERE created_at < ?').bind(before),
        ...rows.map(r => db.prepare('INSERT OR REPLACE INTO scout_answers (id, value, created_at) VALUES (?, ?, ?)').bind(r.id, r.value, r.at))]);
    },
  };
}
