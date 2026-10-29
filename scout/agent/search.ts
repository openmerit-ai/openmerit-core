// Free-text retrieval over the published catalogue: one document per model,
// benchmark and leaderboard. The publisher indexes these documents in a D1 FTS5
// table and in Vectorize for each published version (publish.ts); the agent's
// search_catalogue tool merges the two ranked lists by reciprocal rank fusion.

export const documentTypes = ['model', 'benchmark', 'board'] as const;
export type DocumentType = typeof documentTypes[number];
export type SearchField = 'name' | 'aliases' | 'description' | 'meaning';
export interface CatalogueDocument { type: DocumentType; id: string; kind: string | null; name: string; aliases: string; description: string }
// One ranked hit. Scores are only comparable within the list that produced them.
export interface SearchHit { type: DocumentType; id: string; kind: string | null; score: number; fields: SearchField[] }
export interface SearchOptions { types?: readonly DocumentType[]; kind?: string; limit: number }

// Words a request uses for each kind of model, so "transcribe call audio" finds transcription models.
export const kindTerms: Record<string, string> = {
  chat: 'chat language model LLM text generation assistant reasoning',
  embedding: 'embedding embeddings vectors semantic search retrieval RAG similarity',
  rerank: 'rerank reranker reranking retrieval relevance search results',
  image: 'image generation text-to-image image editing pictures photos illustrations',
  video: 'video generation text-to-video image-to-video video editing clips',
  speech: 'speech synthesis text-to-speech TTS voice voices narration audio generation',
  transcription: 'transcription transcribe transcribing speech-to-text ASR speech recognition audio calls',
  decision: 'decision classification classify judge scoring evaluation labels',
  ocr: 'OCR optical character recognition scanned documents text extraction pages',
  moderation: 'moderation safety guardrail content filtering',
  '3d': '3D model generation meshes assets',
  music: 'music generation songs instrumental vocals audio',
};

// Publish-time text only: no prices, counts or ranks, so a document's content
// hash (and its embedding) changes only when its identity or description does.
export function embeddingText(d: CatalogueDocument): string {
  return `${d.type}${d.kind ? ` (${d.kind})` : ''}: ${d.name}\n${d.aliases}\n${d.description}`.slice(0, 2000);
}

const stopwords = new Set('a an and are as at be by for from i in is it its me my need of on or our so that the this to use want we with would model models'.split(' '));
export const terms = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !stopwords.has(w));

// An FTS5 query matching any of the request's words; each word is quoted so
// operators and punctuation in user text are never parsed as query syntax.
export function ftsQuery(text: string): string | null {
  const words = [...new Set(terms(text))].slice(0, 24);
  return words.length ? words.map(w => `"${w}"`).join(' OR ') : null;
}

// Reciprocal rank fusion: each list contributes 1 / (k + rank). Raw scores are
// never mixed, because BM25 and cosine similarity are on unrelated scales.
export function reciprocalRankFusion(lists: ReadonlyArray<readonly SearchHit[]>, k = 60): SearchHit[] {
  const fused = new Map<string, { hit: SearchHit; score: number; best: number; fields: Set<SearchField> }>();
  for (const list of lists) list.forEach((hit, i) => {
    const key = `${hit.type}\u0000${hit.id}`, entry = fused.get(key) ?? { hit, score: 0, best: Infinity, fields: new Set<SearchField>() };
    entry.score += 1 / (k + i + 1); entry.best = Math.min(entry.best, i);
    for (const f of hit.fields) entry.fields.add(f);
    fused.set(key, entry);
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || a.best - b.best || a.hit.id.localeCompare(b.hit.id))
    .map(e => ({ ...e.hit, score: e.score, fields: [...e.fields] }));
}

// In-memory BM25 over the same documents, for catalogue versions published
// before the FTS index existed and for local snapshots. Same column weights as
// the D1 query; tokens are compared without stemming.
const weights = { name: 8, aliases: 4, description: 1 } as const;
export function memorySearch(documents: readonly CatalogueDocument[]): (query: string, options: SearchOptions) => SearchHit[] {
  const columns = Object.keys(weights) as Array<keyof typeof weights>;
  const docs = documents.map(d => ({ d, tokens: Object.fromEntries(columns.map(c => [c, terms(d[c])])) as Record<keyof typeof weights, string[]> }));
  const avg = Object.fromEntries(columns.map(c => [c, docs.reduce((n, x) => n + x.tokens[c].length, 0) / Math.max(1, docs.length)])) as Record<keyof typeof weights, number>;
  const frequency = new Map<string, number>();
  for (const x of docs) for (const t of new Set(columns.flatMap(c => x.tokens[c]))) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  return (query, { types, kind, limit }) => {
    const q = [...new Set(terms(query))];
    return docs.filter(x => (!types?.length || types.includes(x.d.type)) && (!kind || x.d.kind === kind)).flatMap(x => {
      let score = 0; const fields: SearchField[] = [];
      for (const c of columns) {
        const tokens = x.tokens[c];
        for (const t of q) {
          const tf = tokens.filter(w => w === t).length; if (!tf) continue;
          const idf = Math.log(1 + (docs.length - (frequency.get(t) ?? 0) + 0.5) / ((frequency.get(t) ?? 0) + 0.5));
          score += weights[c] * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * tokens.length / Math.max(1, avg[c])));
          if (!fields.includes(c)) fields.push(c);
        }
      }
      return score > 0 ? [{ type: x.d.type, id: x.d.id, kind: x.d.kind, score, fields }] : [];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  };
}

// The published FTS5 index: one table for all versions, filtered to one version.
// bm25() weights follow the column order (version, type, id, kind, name, aliases, description).
export const searchTable = 'scout_agent_search';
export const searchSchema = `CREATE VIRTUAL TABLE IF NOT EXISTS ${searchTable} USING fts5(version UNINDEXED, type UNINDEXED, id UNINDEXED, kind UNINDEXED, name, aliases, description, tokenize='porter unicode61 remove_diacritics 2')`;
interface Statement { bind(...values: unknown[]): Statement; all<T>(): Promise<{ results: T[] }> }
export async function ftsSearch(db: { prepare(sql: string): Statement }, version: string, query: string, { types, kind, limit }: SearchOptions): Promise<SearchHit[]> {
  const match = ftsQuery(query); if (!match) return [];
  const where = [`${searchTable} MATCH ?1`, 'version = ?2'], bindings: unknown[] = [match, version];
  if (types?.length) { bindings.push(JSON.stringify(types)); where.push(`type IN (SELECT value FROM json_each(?${bindings.length}))`); }
  if (kind) { bindings.push(kind); where.push(`kind = ?${bindings.length}`); }
  bindings.push(limit);
  // Highlight markers show which columns matched; char(1) never occurs in catalogue text.
  const rows = (await db.prepare(`SELECT type, id, kind, bm25(${searchTable}, 0, 0, 0, 0, ${weights.name}, ${weights.aliases}, ${weights.description}) AS score,
    instr(highlight(${searchTable}, 4, char(1), ''), char(1)) > 0 AS in_name, instr(highlight(${searchTable}, 5, char(1), ''), char(1)) > 0 AS in_aliases,
    instr(highlight(${searchTable}, 6, char(1), ''), char(1)) > 0 AS in_description
    FROM ${searchTable} WHERE ${where.join(' AND ')} ORDER BY score LIMIT ?${bindings.length}`).bind(...bindings)
    .all<{ type: DocumentType; id: string; kind: string | null; score: number; in_name: number; in_aliases: number; in_description: number }>()).results;
  // FTS5 bm25() is lower-is-better; flip it so every list is higher-is-better.
  return rows.map(r => ({ type: r.type, id: r.id, kind: r.kind, score: -r.score,
    fields: (['name', 'aliases', 'description'] as const).filter(f => r[`in_${f}`]) }));
}
