import test from 'node:test';
import assert from 'node:assert/strict';
import { boardSources, importBoards, linkResults } from '../catalogue-boards.ts';
import { ensureCatalogueSchema } from '../catalogue-db.ts';
import { d1 } from './helpers-d1.ts';

// A page as Next.js serves it: flight data pushed as JSON strings, split across scripts.
const page = (rows: unknown[]) => {
  const line = `3e:${JSON.stringify([null, rows])}\n`, half = Math.floor(line.length / 2);
  return [line.slice(0, half), line.slice(half)].map(s => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`).join('');
};
const arena = (name: string, elo: number, creator = 'Lab') => ({ formatted: { rank: 1, elo: String(Math.round(elo)) }, values: { id: `id-${name}`, name, elo, appearances: 1000, creator: { name: creator }, releaseDate: '2026-09-01', note: 'long markdown' } });
const source = (id: string) => { const s = boardSources.find(x => x.id === id); if (!s) throw new Error(id); return s; };
const merged = (id: string, kind: string, name: string) => `INSERT INTO cat_model_merged (id,kind,name,sources,provenance) VALUES ('${id}','${kind}','${name}','[]','{}')`;

test('media board results are stored verbatim, linked only to one catalogue model of the board kind, and a collapsed board keeps its previous results', async () => {
  const db = d1();
  await importBoards(db, source('analysis-board:text-to-image'), { fetcher: async () => new Response('down', { status: 503 }), now: '2026-10-27T00:00:00Z' });
  for (const sql of [merged('lab/pic-1', 'image', 'Pic 1'), merged('lab/pic-2', 'image', 'Pic 2'), merged('other/pic-2', 'image', 'Pic-2'), merged('lab/chat-1', 'chat', 'Pic 3')]) await db.prepare(sql).run();
  const rows = [arena('Pic 1 (max)', 1210.5), arena('Pic 2', 1190), arena('Pic 3', 1150), arena('Unknown A', 1100), arena('Unknown B', 1090)];
  let html = page(rows);
  const fetcher = async () => new Response(html), now = '2026-10-28T00:00:00Z';
  assert.deepEqual(await importBoards(db, source('analysis-board:text-to-image'), { fetcher, now }), { status: 'ok', boards: 1, results: 5, linked: 1 });
  // "(max)" is a run setting; Pic 2 names two models; Pic 3 is a chat model, not an image model.
  assert.deepEqual(db.all("SELECT model,score,samples,model_id FROM cat_board_results ORDER BY score DESC").map(r => Object.values(r)),
    [['Pic 1 (max)', 1210.5, 1000, 'lab/pic-1'], ['Pic 2', 1190, 1000, null], ['Pic 3', 1150, 1000, null], ['Unknown A', 1100, 1000, null], ['Unknown B', 1090, 1000, null]]);
  assert.deepEqual({ ...db.all("SELECT kind,metric,direction,results,linked FROM cat_boards WHERE id='analysis:text-to-image'")[0] }, { kind: 'image', metric: 'Elo', direction: 'higher', results: 5, linked: 1 });
  assert.equal(String(db.all('SELECT payload FROM cat_board_results LIMIT 1')[0]?.payload).includes('long markdown'), false, 'notes are not stored');

  // A new version replaces the old rows in one step.
  html = page([...rows.slice(0, 4), arena('Unknown C', 1000)]);
  assert.equal((await importBoards(db, source('analysis-board:text-to-image'), { fetcher, now: '2026-10-29T00:00:00Z' })).status, 'ok');
  assert.deepEqual(db.all('SELECT model FROM cat_board_results ORDER BY model').map(r => r.model), ['Pic 1 (max)', 'Pic 2', 'Pic 3', 'Unknown A', 'Unknown C']);
  // A page whose rows vanished fails the run and leaves the stored board alone.
  html = '<html>redesigned</html>';
  assert.equal((await importBoards(db, source('analysis-board:text-to-image'), { fetcher, now: '2026-10-30T00:00:00Z' })).status, 'failed');
  assert.equal(db.all('SELECT count(*) n FROM cat_board_results')[0]?.n, 5);
  assert.deepEqual(db.all("SELECT status FROM cat_runs ORDER BY started_at").map(r => r.status), ['failed', 'ok', 'ok', 'failed']);
});

test('results link by reviewed alias, exact ID or repository, owner and exact name, never by substring, sibling or an ambiguous name', () => {
  const candidates = [
    { id: 'google/veo-3.0-generate-001', kind: 'video', names: ['Veo 3.0', 'veo-3.0-generate-001'] },
    { id: 'google/veo-3.1', kind: 'video', names: ['Veo 3.1', 'veo-3.1'] }, { id: 'google/veo-3.1-generate-preview', kind: 'video', names: ['Veo 3.1', 'veo-3.1-generate-preview'] },
    { id: 'kwaivgi/kling-v3.0-pro', kind: 'video', names: ['Kling: Video v3.0 Pro', 'kling-v3.0-pro'] },
    { id: 'nvidia/parakeet-tdt-0.6b-v3', kind: 'transcription', names: ['Parakeet TDT 0.6B v3'], repos: ['nvidia/parakeet-tdt-0.6b-v3'] },
    { id: 'openai/whisper-large-v3', kind: 'transcription', names: ['Whisper Large v3'], repos: ['openai/whisper-large-v3'] },
    { id: 'google/gemma-4-e4b-it', kind: 'chat', names: ['Gemma 4 E4B'] },
    { id: 'elevenlabs/eleven-multilingual-v2', kind: 'speech', names: ['Eleven Multilingual v2'] },
  ];
  const link = (kind: string, names: string[], board = '') => { const rows = names.map(model => ({ model })), links = linkResults(rows, kind, candidates, board); return rows.map(r => links.get(r) ?? null); };
  // "Veo 3" is Veo 3.0, never 3.1 or 3.1 Fast; "Veo 3.1" names two models; "kling-v3-pro" is Kling v3.0 Pro.
  assert.deepEqual(link('video', ['Veo 3', 'veo-3', 'Veo 3.1', 'Veo 3.1 Fast', 'Veo', 'kling-v3-pro', 'Kling 3 Pro Turbo']), ['google/veo-3.0-generate-001', 'google/veo-3.0-generate-001', null, null, null, 'kwaivgi/kling-v3.0-pro', null]);
  // A repository or ID links whatever its kind; a sibling version or another owner's fine-tune does not.
  assert.deepEqual(link('transcription', ['nvidia/parakeet-tdt-0.6b-v3', 'nvidia/parakeet-tdt-0.6b-v2', 'someone/whisper-large-v3', 'openai/whisper-large-v3-turbo', 'Google/Gemma-4-E4B-it', 'Whisper Large v3, OpenAI']),
    ['nvidia/parakeet-tdt-0.6b-v3', null, null, null, 'google/gemma-4-e4b-it', 'openai/whisper-large-v3']);
  // A reviewed alias applies only to its kind and boards.
  assert.deepEqual([link('speech', ['Multilingual v2'], 'analysis:tts-provider-voice'), link('speech', ['Multilingual v2'], 'tts-arena:v2'), link('image', ['Multilingual v2'], 'analysis:tts-provider-voice')], [['elevenlabs/eleven-multilingual-v2'], [null], [null]]);
});

test('speech-to-text rows are host endpoints ranked by error rate, lower is better', async () => {
  const db = d1(), row = (name: string, host: string, wer: number | null) => ({ id: `${name}-${host}`, name, hostApiId: `${host}/${name}`, aaWerIndex: wer, model: { id: name, name, shortName: name, releaseDate: '2026-10-01' }, host: { name: host, slug: host.toLowerCase() } });
  const html = page([row('Ear 1', 'Lab', .03), row('Ear 1', 'Host', .031), row('Ear 2', 'Lab', .05), row('Ear 3', 'Lab', .06), row('Ear 4', 'Lab', .07), row('Ear 5', 'Lab', .08), row('Ear 6', 'Lab', null)]);
  assert.equal((await importBoards(db, source('analysis-board:stt'), { fetcher: async () => new Response(html) })).status, 'ok');
  assert.deepEqual({ ...db.all("SELECT metric,direction,results FROM cat_boards")[0] }, { metric: 'Word error rate index', direction: 'lower', results: 6 });
  assert.deepEqual(db.all("SELECT variant,score FROM cat_board_results WHERE model='Ear 1' ORDER BY score").map(r => Object.values(r)), [['lab:Lab/Ear 1', .03], ['host:Host/Ear 1', .031]]);
});

test('Arena media boards read only current categories and reject a category with mixed dates', () => {
  const rows = (category: string, dates: string[]) => dates.map((d, i) => ({ model_name: `m${i}`, organization: 'lab', rating: 1300 - i, rating_lower: 1290 - i, rating_upper: 1310 - i, vote_count: 900n, category, leaderboard_publish_date: d }));
  const day = Array<string>(6).fill('2026-10-26');
  const boards = source('arena-board:text_to_image').parse(['overall', 'photorealistic', 'text_rendering', 'commercial_design', 'portraits', 'art', 'cartoon', '3d_modeling', 'chinese'].flatMap(c => rows(c, c === 'chinese' ? Array(6).fill('2025-01-24') : day)));
  assert.equal(boards.length, 8);
  assert.ok(boards.every(b => b.published_at === '2026-10-26' && b.kind === 'image' && !b.id.includes('chinese')));
  assert.deepEqual(boards[0]?.results[0] && [boards[0].id, boards[0].results[0].score, boards[0].results[0].samples], ['arena:text-to-image', 1300, 900]);
  assert.throws(() => source('arena-board:video_edit').parse(rows('overall', ['2026-08-27', ...day.slice(1)])), /mixed/);
});

test('decision boards keep JevBench capability for ranked systems only and link Decision Index rows only to decision models', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  for (const sql of [merged('lab/decide-1', 'decision', 'Decide 1'), merged('lab/chat-9', 'chat', 'Chat 9')]) await db.prepare(sql).run();
  const system = (key: string, name: string, capability: number, composite: number, listing = 'ranked', measured = '2026-10-20') =>
    ({ key, name, board: 'api', listing, capability: { score: capability }, composite_score: composite, axes: { cost: 10 }, draw: { measured_on: measured } });
  const systems = [system('decide-1', 'Decide 1 (Lab)', 81, 20, 'ranked', '2026-10-26'), system('decide-1-r2', 'Decide 1 (new weights)', 90, 90, 'unranked'),
    ...Array.from({ length: 49 }, (_, i) => system(`m${i}`, `Model ${i}`, 50, 50))];
  const json = JSON.stringify({ revision: 'v1.7.15', systems });
  assert.deepEqual(await importBoards(db, source('jevbench'), { fetcher: async () => new Response(json) }), { status: 'ok', boards: 1, results: 50, linked: 1 });
  // Capability, not the cost-weighted composite; the unranked re-run of the same name is not stored.
  assert.deepEqual(db.all("SELECT model,variant,score,model_id FROM cat_board_results WHERE model_id IS NOT NULL").map(r => Object.values(r)), [['Decide 1 (Lab)', 'decide-1', 81, 'lab/decide-1']]);
  assert.deepEqual({ ...db.all("SELECT kind,published_at,direction FROM cat_boards")[0] }, { kind: 'decision', published_at: '2026-10-26', direction: 'higher' });

  const row = (slug: string, name: string, kind: string, indexScore: number) => ({ slug, kind, name, hostName: 'Host', creatorName: 'Lab', indexScore, scores: { when2callAccuracy: .8 }, costPerTaskUsd: .001 });
  const html = page([row('lab_decide-1', 'Decide 1', 'decisionModel', 65.2), row('lab_chat-9', 'Chat 9', 'llm', 60), row('a', 'A', 'llm', 50), row('b', 'B', 'llm', 40), row('c', 'C', 'decisionModel', 30)]);
  assert.deepEqual(await importBoards(db, source('analysis-board:decision-index'), { fetcher: async () => new Response(html) }), { status: 'ok', boards: 1, results: 5, linked: 1 });
  assert.deepEqual(db.all("SELECT model,score,model_id FROM cat_board_results WHERE board='analysis:decision-index' AND model IN ('Decide 1','Chat 9') ORDER BY score DESC").map(r => Object.values(r)),
    [['Decide 1', 65.2, 'lab/decide-1'], ['Chat 9', 60, null]]);
});

test('parquet integers in a result row are stored as numbers', async () => {
  const db = d1(), row = (i: number) => ({ model: `m${i}`, variant: '', creator: null, score: 100 - i, ci_lower: null, ci_upper: null, samples: null, released: null, payload: { rank: BigInt(i + 1) } });
  const source = { id: 'test-board', name: 'Test', url: 'https://example.test/board.json', license: 'test', type: 'json' as const, maxBytes: 1000,
    parse: () => [{ id: 'test:board', title: 'Test', kind: 'image', metric: 'Elo', direction: 'higher' as const, url: 'https://example.test', published_at: null, results: [0, 1, 2, 3, 4].map(row) }] };
  assert.equal((await importBoards(db, source, { fetcher: async () => new Response('{}') })).status, 'ok');
  assert.equal(db.all("SELECT payload FROM cat_board_results WHERE model='m0'")[0]?.payload, '{"rank":1}');
});

// A Gradio /config as a Space serves it: components by id, with the layout tree referring to them.
const gradio = (tables: { tab: string; elem?: string; headers: string[]; rows: unknown[][] }[]) => {
  const components: unknown[] = [], children: unknown[] = [];
  tables.forEach((t, i) => {
    components.push({ id: i * 2 + 1, type: 'tabitem', props: { label: t.tab } }, { id: i * 2 + 2, type: 'dataframe', props: { elem_id: t.elem, value: { headers: t.headers, data: t.rows } } });
    children.push({ id: i * 2 + 1, children: [{ id: i * 2 + 2 }] });
  });
  return JSON.stringify({ components, layout: { id: 0, children } });
};
const link = (href: string, name: string) => `<a target="_blank" href="${href}" style="color: var(--link-text-color);">${name}</a>`;

test('Open ASR boards store average WER from each table with HTML stripped, lower is better, and fail when a score column goes missing', async () => {
  const db = d1();
  await ensureCatalogueSchema(db);
  await db.prepare(merged('lab/ear-v2', 'transcription', 'Lab: Ear v2')).run();
  const english = ['Rank', 'Rank Δ', 'model', 'Average WER ⬇️', 'RTFx ⬆️️', 'LS Clean'];
  const names = ['lab/ear_v2', 'b/two', 'c/three &amp; more', 'd/four', 'e/five'];
  const config = (avg = 'Average WER ⬇️') => gradio([
    { tab: '🏅 Leaderboard', elem: 'leaderboard-table', headers: english, rows: names.map((n, i) => [i + 1, '—', link(`https://x.test/${i}`, n), 4 + i, 900 - i * 100, 1.5]) },
    { tab: '🌍 Multilingual', elem: 'multilingual-table', headers: ['Rank', 'Model', avg, 'Coverage'], rows: [...names, 'f/partial'].map((n, i) => [i + 1, link('https://x.test', n), n === 'f/partial' ? null : 3 + i, n === 'f/partial' ? '1/7' : '7/7']) },
    { tab: '📝 Long-form', elem: 'longform-table', headers: ['Rank', 'Model', 'Average WER ⬇️', 'RTFx ⬆️️'], rows: names.map((n, i) => [i + 1, link('https://x.test', n), 8 + i, 100]) }]);
  assert.deepEqual(await importBoards(db, source('open-asr'), { fetcher: async () => new Response(config()) }), { status: 'ok', boards: 3, results: 15, linked: 3 });
  // The WER average, not the speed factor, and names without their link markup or entities.
  assert.deepEqual(db.all("SELECT model,creator,score,model_id FROM cat_board_results WHERE board='open-asr:english' ORDER BY score LIMIT 3").map(r => Object.values(r)),
    [['lab/ear_v2', 'lab', 4, 'lab/ear-v2'], ['b/two', 'b', 5, null], ['c/three & more', 'c', 6, null]]);
  assert.deepEqual(db.all("SELECT id,kind,metric,direction,results FROM cat_boards ORDER BY id").map(r => Object.values(r)), [
    ['open-asr:english', 'transcription', 'Average WER (%)', 'lower', 5], ['open-asr:long-form', 'transcription', 'Average WER (%)', 'lower', 5], ['open-asr:multilingual', 'transcription', 'Average WER (%)', 'lower', 5]]);
  assert.equal(JSON.parse(String(db.all("SELECT payload FROM cat_board_results WHERE board='open-asr:english' AND model='b/two'")[0]?.payload))['RTFx ⬆️️'], 800);
  // A renamed score column fails the whole source and keeps every stored board.
  const failed = await importBoards(db, source('open-asr'), { fetcher: async () => new Response(config('Mean WER')) });
  assert.equal(failed.status, 'failed');
  assert.match(failed.status === 'failed' ? failed.error : '', /no Average WER/);
  assert.equal(db.all('SELECT count(*) n FROM cat_board_results')[0]?.n, 15);
});

test('VBench reads Total Score from each tab, keeps rows from every evaluator as variants and drops unscored rows', () => {
  const headers = (model: string) => [model, 'Certification', 'Sampled by', 'Evaluated by', 'Accessibility', 'Date', 'Total Score', 'Quality Score'];
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [`[Gen ${i}](https://x.test/${i})`, '', 'VBench Team', ' VBench Team', null, '2026-01-01', `${80 - i}.50%`, '99.00%']);
  const boards = source('vbench').parse(JSON.parse(gradio([
    { tab: '📊 VBench 1.0', elem: 'vbench-tab-table', headers: headers('Model Name (clickable)'), rows: rows(5) },
    { tab: '⭐ VBench 2.0', elem: 'vbench-tab-table', headers: headers('Model (alphabetical order)'), rows: [...rows(5), ['[Gen 0](https://x.test/0)', '', 'Gen Team', 'Gen Team', null, '2026-01-01', '82.00%', '99.00%']] },
    { tab: 'VBench-I2V', elem: 'vbench-tab-table', headers: headers('Model Name (clickable)'), rows: [...rows(5), ['Gen X', '', 'X', 'X', null, '', 'nan', 'nan']] }])));
  assert.deepEqual(boards.map(b => [b.id, b.kind, b.direction, b.results.length]), [['vbench:t2v', 'video', 'higher', 5], ['vbench:v2', 'video', 'higher', 6], ['vbench:i2v', 'video', 'higher', 5]]);
  assert.deepEqual(boards[1]?.results.filter(r => r.model === 'Gen 0').map(r => [r.variant, r.score]), [['VBench Team', 80.5], ['Gen Team', 82]]);
  assert.equal(boards[0]?.results[0]?.payload['Quality Score'], '99.00%');
});

test('arena-style JSON boards: TTS Arena drops suspended entries, 3D Arena is its own kind, MMEB ranks by Overall', () => {
  const tts = (name: string, elo: number, suspended = false) => ({ rank: suspended ? 0 : 1, name, elo, uncertainty: 20, winRate: 55, totalVotes: 700, preliminary: false, active: true, suspended });
  const [speech] = source('tts-arena').parse({ rows: [tts('Voice A', 1600), tts('Voice B', 1550), tts('Voice C', 1500), tts('Voice D', 1450), tts('Voice E', 1400), tts('Gamed', 1700, true)] });
  assert.deepEqual([speech?.kind, speech?.metric, speech?.direction, speech?.results.map(r => r.model), speech?.results[0]?.samples], ['speech', 'Elo', 'higher', ['Voice A', 'Voice B', 'Voice C', 'Voice D', 'Voice E'], 700]);
  const [render] = source('3d-arena:render').parse(['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ name, rank: String(i + 1), score: 1400 - i, votes: 300, open_source: true })));
  assert.deepEqual([render?.id, render?.kind, render?.results[4]?.score], ['3d-arena:render', '3d', 1396]);
  assert.throws(() => source('3d-arena:topology').parse([{ name: 'A', score: 1 }]), /format changed/);
  const head = ['Rank', 'Models', 'Size(B)', 'Date', 'Overall', 'Overall-V3🆕'];
  const mmeb = source('mmeb').parse(JSON.parse(gradio([
    { tab: '📊 MMEB (V3)', elem: 'tab-overall', headers: head, rows: [0, 1, 2, 3, 4].map(i => ['🏆', `<a href="https://x.test">Emb-${i}</a>`, 'unknown', '26-01-01', 60 - i, 40 + i]) },
    { tab: '📊 MMEB (V2)', elem: 'tab-overall-v2', headers: ['Rank', 'Models', 'Overall-V2'], rows: [0, 1, 2, 3, 4].map(i => [i, `Emb-${i}`, 80 - i]) }])));
  assert.deepEqual(mmeb.map(b => [b.id, b.kind, b.results[0]?.model, b.results[0]?.score]), [['mmeb:v3', 'embedding', 'Emb-0', 60], ['mmeb:v2', 'embedding', 'Emb-0', 80]]);
});
