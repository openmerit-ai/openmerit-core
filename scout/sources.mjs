import { unzipSync, strFromU8 } from 'fflate';
import { parquetReadObjects } from 'hyparquet';
import { refreshBenchmarks } from './benchmarks.mjs';
import { readEpochDefinitions, analysisDescriptions, benchmarkIdentity, methodologySections } from './benchmark-metadata.mjs';
import { catalogueURL, parseProviderCatalogue, mergeCatalogues, routerEndpoint, textOutputOnly, reportedFact, providerMetadata } from './catalogue.mjs';
import contracts from './endpoint-contracts.json' with { type: 'json' };
import { hubQueries, parseHubModels, hubID } from './huggingface.mjs';
import { refreshSpecialists } from './specialists.mjs';
import { refreshModelMetadata } from './metadata.mjs';
import { catalogueRouteSource } from './catalogue-routes.ts';

export const sourceURLs = {
  modelsdev: catalogueURL,
  epoch: 'https://epoch.ai/data/benchmark_data.zip',
  analysis: 'https://artificialanalysis.ai/leaderboards/models',
  analysisMethodology: 'https://artificialanalysis.ai/methodology/intelligence-benchmarking',
  // This is the publisher's data URL, as linked by its Hugging Face leaderboard.
  openvlm: 'http://opencompass.openxlab.space/assets/OpenVLM.json',
  models: 'https://openrouter.ai/api/v1/models',
  omnidoc: 'https://raw.githubusercontent.com/opendatalab/OmniDocBench/main/README.md',
  bfcl: 'https://gorilla.cs.berkeley.edu/data_overall.csv',
  idp: 'https://www.idp-leaderboard.org/',
  vectara: 'https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md',
  arena: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text_style_control/latest-00000-of-00001.parquet',
  arenaDocument: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/document_style_control/latest-00000-of-00001.parquet',
  arenaVision: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/vision_style_control/latest-00000-of-00001.parquet',
  arenaWebdev: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/webdev/latest-00000-of-00001.parquet',
  arenaFactuality: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text_factuality/latest-00000-of-00001.parquet',
  // LLM Stats' public API: its 100 most-reported benchmarks with every model's score.
  vendor: 'https://api.llm-stats.com/leaderboard/benchmarks/matrix?top_n=100',
  bfclMethodology: 'https://gorilla.cs.berkeley.edu/leaderboard',
  bfclMemory: 'https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html',
};
// "+" is part of a model name (Command A+ is not Command A), so it survives as "plus".
const norm = value => String(value).toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
const number = value => value === '' || value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const median = values => { const a = [...values].sort((a, b) => a - b); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null; };
const safeURL = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('Unterminated CSV field.');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((h, i) => [h.replace(/^\uFEFF/, ''), r[i] ?? ''])));
}

export function parseAnalysis(html) {
  // Read serialized public data, never evaluate scripts from a source page.
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
  let found = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    // Locate the record shape, independently of framework/component prop names.
    if (Array.isArray(value) && value.length > found.length && value.every(m => m && typeof m === 'object' && typeof m.name === 'string' && typeof m.slug === 'string') && value.some(m => 'medianOutputTokensPerSecond' in m)) found = value;
    for (const child of Object.values(value)) if (typeof child === 'object') walk(child);
  }
  for (const line of flight.split('\n')) { const match = line.match(/^[\da-f]+:(\[.*|\{.*)$/); if (match) { try { walk(JSON.parse(match[1])); } catch {} } }
  if (found.length < 10) throw new Error('Artificial Analysis public data format changed.');
  return found;
}

// Read only the explicitly labelled leaderboard, never the older tables below it.
export function parseOmniDoc(markdown) {
  const table = [...markdown.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)].find(m => /<caption>[^<]*OmniDocBench \(v1\.6_full\)/.test(m[1]));
  if (!table || !/Overall&#x2191;/.test(table[1])) throw new Error('OmniDocBench leaderboard format changed.');
  const rows = [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]*>/g, '').trim()))
    .filter(c => c.length === 9 && c[1] === 'General VLMs').map(c => ({ name: c[0], score: number(c[3]) }));
  if (rows.length < 3 || rows.some(r => r.score === null || r.score < 0 || r.score > 100)) throw new Error('Invalid OmniDocBench results.');
  return rows;
}

// The overall column averages the three component series, so it is not stored.
export const idpSeries = [
  ['olmocr', 'OlmOCR', 'IDP Leaderboard · OlmOCR Bench', 'OCR fidelity on about 7,000 document pages, including math equations, tables, headers/footers and reading order.'],
  ['omnidoc', 'OmniDoc', 'IDP Leaderboard · OmniDocBench v1.5', 'Document parsing: text extraction, formula recognition, table structure (TEDS) and reading order on document images.'],
  ['core', 'IDP', 'IDP Leaderboard · IDP Core', 'Real-world document processing on document images: key information extraction (fields such as those on invoices and receipts), handwriting OCR, table understanding and visual question answering.'],
];
// Read only the server-rendered leaderboard table, never page scripts.
export function parseIDP(html) {
  const table = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(m => m[0]).find(t => {
    const head = (t.match(/<thead[\s\S]*?<\/thead>/)?.[0] ?? '').replace(/<[^>]*>/g, '|');
    return ['Model', 'Overall', ...idpSeries.map(s => s[1])].every(h => head.includes(`|${h}|`));
  });
  if (!table) throw new Error('IDP Leaderboard format changed.');
  const header = [...table.match(/<thead[\s\S]*?<\/thead>/)[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(c => c[1].replace(/<[^>]*>/g, '').trim());
  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(m => [...m[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1])).filter(c => c.length === header.length).map(cells => {
    const name = cells[header.indexOf('Model')].match(/<a\b[^>]*>([^<]+)<\/a>/)?.[1].trim();
    const scores = Object.fromEntries(idpSeries.map(([id, column]) => [id, number(cells[header.indexOf(column)].replace(/<[^>]*>/g, '').trim())]));
    return { name, scores };
  });
  if (rows.length < 5 || rows.some(r => !r.name || Object.values(r.scores).some(v => v === null || v < 0 || v > 100))) throw new Error('Invalid IDP Leaderboard results.');
  return rows;
}

// Summaries of supplied documents scored by HHEM. A model that declines many
// documents is scored only on the rest, so low answer rates are excluded.
// Vals AI benchmarks read for vertical and task coverage: healthcare, legal, finance,
// public benefits, education, multilingual math, science, code migration and security.
// Left out: composite indexes, archived versions, small beta boards, speech, and
// evaluations other feeds already supply (GPQA, MMLU-Pro, MMMU, LiveCodeBench, SWE-bench,
// Terminal-Bench, AIME, MATH 500, ProofBench).
export const valsSlugs = ['medqa', 'medcode', 'medscribe', 'legal_bench', 'legal_research', 'hlab', 'corp_fin_v2', 'tax_eval_v2', 'mortgage_tax', 'fabv2', 'fabv2-1', 'emb', 'emb-v1-1', 'claimbench',
  'public-benefits-bench', 'sage', 'mgsm', 'biomysterybench', 'mysterymechanism', 'code-migration', 'code-migration-v1-1', 'vibe-code', 'programbench', 'ioi', 'swebench-multimodal', 'cyber', 'srebench'];
const decodeEntities = value => value.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, v => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' })[v]);
// Each benchmark page links its data file under a content hash; only overall accuracy is kept.
export function parseVals(slug, data, summary = '') {
  const md = data?.metadata, overall = data?.tasks?.overall;
  if (typeof md?.benchmark !== 'string' || !overall || typeof overall !== 'object') throw new Error('Vals AI format changed.');
  const rows = Object.entries(overall).flatMap(([id, r]) => Number.isFinite(r?.accuracy) && r.accuracy >= 0 && r.accuracy <= 100 ? [{ id, score: r.accuracy / 100 }] : []);
  if (rows.length < 5) throw new Error(`Too few Vals AI results for ${slug}.`);
  return { slug, name: md.benchmark, family: typeof md.family === 'string' ? md.family : slug, industry: typeof md.industry === 'string' ? md.industry : null,
    description: [summary, typeof md.description === 'string' ? md.description : ''].filter(Boolean).join(' '), updated: /^\d{4}-\d{2}-\d{2}$/.test(md.updated) ? md.updated : null, publicData: md.dataset_type === 'public', rows };
}
// Four at a time, reduced to scores as each arrives, so collection holds one small table per benchmark.
export async function readVals(read) {
  const found = [], missing = [];
  for (let i = 0; i < valsSlugs.length; i += 4) {
    const batch = valsSlugs.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(async slug => {
      const page = await read(`https://www.vals.ai/benchmarks/${slug}`, 'text', 3_000_000), path = page.match(/\/_astro\/benchmark_view_[\w.-]+?\.json/)?.[0];
      if (!path) throw new Error('Vals AI data link missing.');
      // The page summary says what the benchmark tests, for example the code sets or tasks it covers.
      const summary = decodeEntities(page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
      return parseVals(slug, await read(`https://www.vals.ai${path}`, 'json', 8_000_000), summary);
    }));
    results.forEach((r, j) => r.status === 'fulfilled' ? found.push(r.value) : missing.push(batch[j]));
  }
  if (found.length < valsSlugs.length / 2) throw new Error('Most Vals AI benchmarks were unavailable.');
  return { benchmarks: found, missing };
}
// Developer-reported scores compiled by LLM Stats. Only scores it marks self-reported
// are kept, on 0–1 or 0–100 scales; Elo-style and unbounded scales are not comparable.
export function parseVendorScores(data) {
  if (!Array.isArray(data?.benchmarks) || !Array.isArray(data?.models)) throw new Error('LLM Stats format changed.');
  const benchmarks = data.benchmarks.filter(b => typeof b?.benchmark_id === 'string' && typeof b.name === 'string' && (b.max_score === 1 || b.max_score === 100))
    .map(b => ({ id: b.benchmark_id, name: b.name, description: typeof b.description === 'string' ? b.description : '', scale: b.max_score, modality: b.modality ?? null, rows: [] }));
  const byId = new Map(benchmarks.map(b => [b.id, b]));
  for (const m of data.models) {
    if (typeof m?.model_id !== 'string') continue;
    for (const [id, r] of Object.entries(m.benchmark_scores ?? {})) {
      const b = byId.get(id), score = Number.isFinite(r?.score) ? r.score / (b?.scale ?? 1) : null;
      if (b && r.self_reported === true && score !== null && score >= 0 && score <= 1) b.rows.push({ id: m.model_id, name: typeof m.name === 'string' ? m.name : m.model_id, organization: m.organization ?? null, score });
    }
  }
  const kept = benchmarks.filter(b => b.rows.length >= 5);
  if (kept.length < 20) throw new Error('Too few LLM Stats benchmarks.');
  return kept;
}
export function parseVectara(markdown) {
  const lines = markdown.split('\n'), start = lines.findIndex(l => /^\|\s*Model\s*\|\s*Hallucination Rate\s*\|\s*Factual Consistency Rate\s*\|\s*Answer Rate\s*\|/.test(l));
  if (start < 0) throw new Error('Vectara leaderboard format changed.');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const [name, , consistency, answer] = line.split('|').slice(1, -1).map(c => c.trim());
    rows.push({ name, consistency: number(consistency.replace(/\s*%$/, '')), answerRate: number(answer.replace(/\s*%$/, '')) });
  }
  if (rows.length < 20 || rows.some(r => !r.name || r.consistency === null || r.answerRate === null || r.consistency < 0 || r.consistency > 100)) throw new Error('Invalid Vectara leaderboard results.');
  const updated = markdown.match(/Last updated on ([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
  return { rows: rows.filter(r => r.answerRate >= 90), publishedAt: updated && Number.isFinite(Date.parse(`${updated} UTC`)) ? new Date(`${updated} UTC`).toISOString().slice(0, 10) : null };
}
// Arena text categories that describe a kind of request. Language, coding and
// math categories are omitted; other sources measure those directly.
export const arenaCategories = [
  ['creative_writing', 'Arena · Creative writing', 'Human preference on prompts asking for creative writing such as stories, poems and other original prose.'],
  ['industry_writing_and_literature_and_language', 'Arena · Writing, literature & language', 'Human preference on prompts from writing, editing, literature and language work, such as drafting, rewriting and copy editing.'],
  ['industry_business_and_management_and_financial_operations', 'Arena · Business, management & finance', 'Human preference on prompts from business, management and financial operations work, such as analyses, plans, prioritization, recommendations and business documents.'],
  ['instruction_following', 'Arena · Instruction following', 'Human preference on prompts with explicit instructions or constraints on the response.'],
  ['hard_prompts', 'Arena · Hard prompts', 'Human preference on prompts classified as complex, specific and requiring problem solving.'],
  ['multi_turn', 'Arena · Multi-turn', 'Human preference on conversations with more than one user turn.'],
  ['longer_query', 'Arena · Longer queries', 'Human preference on prompts of 500 or more tokens, often with supplied material to work from.'],
  ['expert', 'Arena · Expert prompts', 'Human preference on prompts judged to need expert domain knowledge.'],
  // Industry categories no other source measures (software and mathematics are measured directly elsewhere).
  ['industry_medicine_and_healthcare', 'Arena · Medicine & healthcare', 'Human preference on prompts Arena classifies as medicine and healthcare work.'],
  ['industry_legal_and_government', 'Arena · Legal & government', 'Human preference on prompts Arena classifies as legal and government work.'],
  ['industry_life_and_physical_and_social_science', 'Arena · Life, physical & social sciences', 'Human preference on prompts Arena classifies as life, physical and social science work.'],
  ['industry_entertainment_and_sports_and_media', 'Arena · Entertainment, sports & media', 'Human preference on prompts Arena classifies as entertainment, sports and media work.'],
];
// Vision arena categories (image input, text output) that describe a kind of request.
// Captioning and entity recognition are omitted: few of their ratings are narrow enough to compare.
export const arenaVisionCategories = [
  ['overall', 'Arena · Vision', 'Human preference on prompts that include one or more images, across all vision categories.'],
  ['ocr', 'Arena · Vision OCR', 'Human preference on image prompts that require reading text in the image, such as screenshots, receipts, forms and signs.'],
  ['diagram', 'Arena · Vision diagrams', 'Human preference on image prompts about charts, diagrams, plots and other structured figures.'],
  ['homework', 'Arena · Vision homework', 'Human preference on image prompts with homework or exam problems, such as photographed math, science or language exercises.'],
  ['creative_writing_vision', 'Arena · Vision creative writing', 'Human preference on prompts asking for creative writing about or inspired by supplied images.'],
];
// Code Arena (WebDev) categories: models build working web applications from a prompt.
export const arenaWebdevCategories = [
  ['overall', 'Arena · WebDev', 'Human preference between two web applications that models built and ran from the same prompt, judged by using the result.'],
  ['webdev-html', 'Arena · WebDev HTML', 'Human preference between two single-page HTML, CSS and JavaScript applications built from the same prompt.'],
  ['webdev-react', 'Arena · WebDev React', 'Human preference between two React applications built from the same prompt.'],
  ['image_to_webdev', 'Arena · Image to WebDev', 'Human preference between two web applications built from the same prompt that includes an image, such as a screenshot or mockup to reproduce.'],
];
// Text factuality blends human preference with automated web checks of each verifiable claim
// (Arena's composite Bradley-Terry model, factuality weight 25%). It repeats every text category; only the overall board and the verticals
// where a false claim costs most are read, since the rest duplicate the text categories.
export const arenaFactualityCategories = [
  ['overall', 'Arena · Factuality', 'Text answers ranked by human preference blended with web-verified correctness of their factual claims.'],
  ['industry_medicine_and_healthcare', 'Arena · Factuality: medicine & healthcare', 'Medicine and healthcare prompts, ranked by human preference blended with web-verified correctness of factual claims.'],
  ['industry_legal_and_government', 'Arena · Factuality: legal & government', 'Legal and government prompts, ranked by human preference blended with web-verified correctness of factual claims.'],
  ['industry_business_and_management_and_financial_operations', 'Arena · Factuality: business & finance', 'Business, management and financial operations prompts, ranked by human preference blended with web-verified correctness of factual claims.'],
];
// Bradley-Terry ratings become the expected win rate against the median-rated
// model of the same leaderboard category, which keeps scores on a 0-1 scale.
// Categories of one leaderboard can be published on different dates; each keeps its own.
export function parseArena(rows, categories) {
  if (!Array.isArray(rows) || rows.length < 20) throw new Error('Invalid Arena leaderboard dataset.');
  const result = {}, dates = {};
  for (const category of categories) {
    const list = rows.filter(r => r.category === category && typeof r.model_name === 'string' && Number.isFinite(r.rating) && Number.isFinite(r.rating_lower) && Number.isFinite(r.rating_upper));
    if (list.length < 10) throw new Error(`Arena category ${category} is missing.`);
    const published = new Set(list.map(r => r.leaderboard_publish_date));
    if (published.size !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test([...published][0])) throw new Error('Arena leaderboard format changed.');
    dates[category] = [...published][0];
    const sorted = list.map(r => r.rating).sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    // Wide intervals mean few votes; those ratings are not stable enough to compare.
    result[category] = list.filter(r => r.rating_upper - r.rating_lower <= 60).map(r => ({ name: r.model_name, score: 1 / (1 + 10 ** ((median - r.rating) / 400)) }));
  }
  return { categories: result, dates, publishedAt: Object.values(dates).sort().at(-1) };
}

// Artificial Analysis publishes each model's scores under `scores`, keyed by
// evaluation slug. Benchmark IDs keep their original field names, so existing
// series and their prepared interpretations carry over. GDPval-AA's value is now
// an Elo-style rating, outside the 0–1 range, so its original series takes no new rows.
const aaBenchmarks = {
  gpqa: ['gpqa-diamond', 'GPQA Diamond · AA'], hle: ['humanitys-last-exam', 'Humanity’s Last Exam · AA'],
  scicode: ['scicode', 'SciCode · AA'], ifbench: ['ifbench', 'IFBench · AA'], lcr: ['artificial-analysis-long-context-reasoning', 'AA Long Context Reasoning'],
  terminalbenchHard: ['terminalbench-hard', 'Terminal-Bench Hard · AA'], terminalBench21: ['terminalbench-2-1', 'Terminal-Bench 2.1 · AA'],
  terminalBench40: ['terminalbench-4-0', 'Terminal-Bench 4.0 · AA'], tau2: ['tau2-bench', 'τ²-Bench · AA'], tauBanking: ['tau3-banking', 'τ-Bench Banking · AA'],
  critpt: ['critpt', 'CritPt · AA'], apexAgents: ['apex-agents-aa', 'APEX-Agents · AA'], itbenchSre: ['itbench-aa', 'ITBench SRE · AA'],
  mmmuPro: ['mmmu-pro', 'MMMU Pro · AA'], omniscienceAccuracy: ['omniscience-accuracy', 'AA Omniscience accuracy'],
  analystAgent: ['aa-analyst-agent', 'Analyst Agent · AA'], gdpvalNormalized: ['gdpval-aa-normalized', 'GDPval · AA'],
  omniscienceNonHallucination: ['omniscience-non-hallucination', 'AA Omniscience non-hallucination rate'], livecodebench: ['livecodebench', 'LiveCodeBench · AA'],
  aime2025: ['aime-2025', 'AIME 2025 · AA'], automationbench: ['automationbench-aa', 'AutomationBench · AA'], gdpPdf: ['gdp-pdf', 'GDP.pdf · AA'],
  terminalBenchScience: ['terminal-bench-science', 'Terminal-Bench-Science · AA'], frontiercode: ['frontiercode', 'FrontierCode · AA'],
  mlcr: ['mlcr-aa', 'MLCR-AA Medical Long Context Reasoning'], harveyLab: ['harvey-lab-aa', 'Harvey LAB-AA'], enterpriseOpsGym: ['enterprise-ops-gym-aa', 'EnterpriseOps-Gym · AA'],
  // Newer versions are separate series; the refresh links each to its earlier version's family.
  hleDiamond: ['hle-diamond', 'Humanity’s Last Exam Diamond · AA'], critptV2Hard: ['critpt-v2-hard', 'CritPt v2 Hard · AA'], frontiercode20: ['frontiercode-2-0', 'FrontierCode 2.0 · AA'],
  healthbench: ['healthbench', 'HealthBench · AA'], healthbenchProfessional: ['healthbench-professional', 'HealthBench Professional · AA'],
};
// Elo-style AA ratings become the expected win rate against the median-rated
// model, as for Arena. AA-Briefcase is not read: dozens of exact zeros look like
// placeholders rather than ratings.
const aaRatings = { gdpvalRating: ['gdpval-aa-normalized', 'GDPval-AA · win rate vs median model'], aa3d: ['aa-3d', 'AA-3D · win rate vs median model'], code2video: ['code2video-aa', 'Code2Video-AA · win rate vs median model'] };

export const bfclMetrics = [
  ['nonLive', 'Non-Live AST Acc', 'BFCL v4 single-turn'],
  ['live', 'Live Acc', 'BFCL v4 live function calling'],
  ['multiTurn', 'Multi Turn Acc', 'BFCL v4 multi-turn'],
  ['memoryKV', 'Memory KV', 'BFCL v4 memory · key-value store'],
  ['memoryVector', 'Memory Vector', 'BFCL v4 memory · vector store'],
  ['memorySummary', 'Memory Recursive Summarization', 'BFCL v4 memory · recursive summarization'],
];

export function parseBFCL(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 3 || !rows[0].Model || bfclMetrics.some(([, field]) => !(field in rows[0]))) throw new Error('BFCL v4 leaderboard format changed.');
  return rows.filter(r => /\(FC(?:\s[^)]*)?\)$/.test(r.Model)).map(r => {
    const scores = {};
    for (const [id, field] of bfclMetrics) {
      if (!r[field] || /^(N\/A|—|-)$/i.test(r[field])) continue;
      if (!/^\d+(?:\.\d+)?%$/.test(r[field])) throw new Error('Invalid BFCL percentage.');
      const value = Number(r[field].slice(0, -1)) / 100;
      if (value < 0 || value > 1) throw new Error('Invalid BFCL score.');
      scores[id] = value;
    }
    return { name: r.Model, scores };
  });
}

export function compileSnapshot({ epochZip, analysisHTML, openvlm, router, omnidocHTML, idpHTML, vectaraMarkdown, arenaRows, arenaDocumentRows, arenaVisionRows, arenaWebdevRows, arenaFactualityRows, vals, vendorScores, bfclCSV, hubRows, modelsDev, benchmarkDescriptions, benchmarkMethodologies, catalogueSupply, previous, failures = {}, checkedAt = new Date().toISOString() }) {
  const sources = [], benchmarks = [], observations = new Map();
  const descriptions = benchmarkDescriptions ?? previous?.benchmarkDescriptions ?? {};
  const priorSources = new Map(previous?.sources.map(s => [s.id, s]) ?? []);
  const failed = (id, error) => ({ ...priorSources.get(id), id, status: 'failed', checkedAt: priorSources.get(id)?.checkedAt ?? null, attemptedAt: checkedAt, error: String(error).slice(0, 200) });
  let independent = [];
  if (modelsDev !== undefined || previous?.sources.some(s => s.id === 'modelsdev')) {
    try { independent = parseProviderCatalogue(modelsDev, checkedAt); const oldCount = (previous?.catalogue ?? []).filter(m => m.endpoints?.some(e => e.source === 'modelsdev')).length; if (oldCount > 10 && independent.length < oldCount * .3) throw new Error('Independent catalogue coverage dropped unexpectedly.'); sources.push({ id: 'modelsdev', name: 'Models.dev · direct providers', url: catalogueURL, status: 'ok', checkedAt, attribution: 'Independent community catalogue of provider-native model IDs, capabilities and advertised prices. Direct-provider adapters only; not benchmark evidence.' }); }
    catch { independent = (previous?.catalogue ?? []).flatMap(m => (m.endpoints ?? []).filter(e => e.source === 'modelsdev' && textOutputOnly(e.outputModalities)).map(e => ({ ...m, endpoints: [e], evidence: [], speed: null }))); sources.push({ name: 'Models.dev · direct providers', url: catalogueURL, ...failed('modelsdev', 'Independent provider feed unavailable; previous records retained.') }); }
  }
  if (!Array.isArray(router?.data) || router.data.length < 10) {
    if (!previous && !independent.length) throw new Error('Invalid model catalogue; no previous index.');
    router = null; sources.push(failed('models', failures.models ?? 'Model catalogue unavailable.'));
  } else sources.push({ id: 'models', name: 'OpenRouter', url: sourceURLs.models, status: 'ok', checkedAt, publishedAt: null, attribution: 'Available models, advertised token prices and supported inputs from OpenRouter.' });
  const routerModels = router ? router.data.filter(m => !m.id.includes(':') && !m.id.startsWith('~') && !m.id.startsWith('openrouter/') && textOutputOnly(m.architecture?.output_modalities) &&
    !/\b(router|auto|embed)\b/.test(m.id) && (!m.expiration_date || Date.parse(m.expiration_date) > Date.parse(checkedAt))).map(m => ({
    id: m.id, name: m.name.replace(/^[^:]+:\s*/, ''), provider: m.name.includes(':') ? m.name.split(':')[0] : m.id.split('/')[0],
    canonical: m.canonical_slug, repository: hubID(m.hugging_face_id), modalities: m.architecture.input_modalities, outputModalities: m.architecture.output_modalities, parameters: m.supported_parameters ?? [], context: m.context_length,
    routerContext:m.top_provider?.context_length??m.context_length,
    routerExpiry:Number.isFinite(Date.parse(m.expiration_date))?new Date(m.expiration_date).toISOString():null,
    facts:[reportedFact('creator',m.name.includes(':')?m.name.split(':')[0]:m.id.split('/')[0],sourceURLs.models,'Creator attribution reported by OpenRouter.'),...(Number.isFinite(m.created)?[reportedFact('listedAt',new Date(m.created*1000).toISOString(),sourceURLs.models,'OpenRouter listing timestamp; not a model release date.')]:[])],
    inputPrice: number(m.pricing?.prompt) === null || number(m.pricing?.prompt) < 0 ? null : Number(m.pricing.prompt) * 1e6,
    outputPrice: number(m.pricing?.completion) === null || number(m.pricing?.completion) < 0 ? null : Number(m.pricing.completion) * 1e6,
    speed: null, evidence: [],
  })).map(m => ({ ...m, endpoints: [routerEndpoint(m, checkedAt)] })) : (previous?.catalogue ?? previous?.models ?? []).map(m => ({ ...m, endpoints: (m.endpoints ?? [routerEndpoint(m, previous.checkedAt)]).filter(e => e.source === 'models' && textOutputOnly(e.outputModalities)), speed: null, evidence: [] })).filter(m => m.endpoints.length);
  const models = mergeCatalogues(routerModels, independent);
  // Catalogue models no feed above lists join before benchmark rows are matched.
  // Without the D1 catalogue, the previous generation's ones are kept.
  const offered = catalogueSupply ? catalogueSupply.models(models, checkedAt) : (previous?.catalogue ?? []).filter(m => m.listedBy === catalogueRouteSource).map(m => ({ ...m, evidence: [], speed: null }));
  for (const entry of contracts.entries) if (!sources.some(s => s.id === entry.source)) sources.push({ id: entry.source, name: `${entry.provider} · typed endpoints`, url: entry.url, status: 'ok', checkedAt: contracts.reviewedAt, refreshPolicy: 'manual-contract-review', attribution: 'Provider-documented endpoint contract and quoted rates; versioned metadata, not a live performance probe.' });
  // A name two models share maps to null; claimants keeps who shares it.
  const lookup = new Map(), claimants = new Map(), aliases = model => [model.id.split('/').slice(1).join('/'), model.canonical?.split('/').slice(1).join('/'), model.name].filter(Boolean).map(norm);
  const claim = (key, model) => { const previous = lookup.get(key); lookup.set(key, lookup.has(key) && previous !== model ? null : model); claimants.set(key, (claimants.get(key) ?? new Set()).add(model.id)); };
  for (const model of models) for (const key of aliases(model)) claim(key, model);
  // A catalogue model whose name or slug an existing model already uses may be
  // that model under another catalogue ID (Models.dev has such duplicates), so it stays out.
  const listed = offered.filter(m => !models.some(x => x.id === m.id) && !aliases(m).some(key => lookup.has(key)));
  for (const model of listed) for (const key of aliases(model)) claim(key, model);
  models.push(...listed);
  const explicitAliases = { 'claudesonnet4520250929': 'anthropic/claude-sonnet-4.5', 'claudehaiku4520251001': 'anthropic/claude-haiku-4.5', 'chatgpt4olatest': 'openai/chatgpt-4o-latest', 'claude37sonnet20250219': 'anthropic/claude-3.7-sonnet', 'gemini25propreview0325': 'google/gemini-2.5-pro-preview-03-25', 'gemini3flash': 'google/gemini-3-flash-preview', 'gemini31pro': 'google/gemini-3.1-pro-preview', 'claudehaiku45': 'anthropic/claude-haiku-4.5', 'qwen3vl235b': 'qwen/qwen3-vl-235b-a22b-instruct' };
  // Catalogue names (provider model IDs, listing and repository names) of the models above; Scout's own names win.
  const catalogueAliases = catalogueSupply?.aliases(models) ?? new Map(), linked = catalogueSupply?.families(models) ?? new Map(), byId = new Map(models.map(m => [m.id, m]));
  // Scout can list one canonical model under two IDs (OpenRouter and native), so their shared
  // name is ambiguous to Scout. It still resolves when the catalogue links every claimant to one model family.
  const sameModel = key => { const ids = [...claimants.get(key) ?? []], first = linked.get(ids[0]); return !!first && ids.every(id => linked.get(id) === first); };
  function resolve(name) {
    // A parenthetical naming a base (pretrained) checkpoint names a different model, never a run setting.
    if (/\([^)]*\bbase\b[^)]*\)/i.test(String(name))) return { model: undefined, tier: 1 };
    const base = String(name).replace(/_(?:none|low|medium|high|xhigh|max|unknown|thinking|nothinking)$/, '').replace(/\s*\([^)]*\)\s*$/, '');
    // Then without run settings: reasoning effort, thinking budgets and every trailing parenthetical.
    // A dash suffix is stripped only for efforts and budgets; "-max" and "-thinking" name distinct models.
    const bare = String(name).replace(/(?:\s*\([^)]*\))+\s*$/, '').replace(/_(?:none|minimal|low|medium|high|xhigh|max|unknown|thinking|nothinking|\d+k)$/i, '').replace(/-(?:minimal|low|medium|high|xhigh|\d+k)$/i, '');
    // Tier 0 is Scout's own name for the model; tier 1 needed stripping or a catalogue alias.
    for (const [tier, key] of [norm(base), norm(bare)].entries()) {
      const own = lookup.get(key) ?? byId.get(explicitAliases[key]);
      if (own) return { model: own, tier: tier === 0 ? 0 : 1 };
      const alias = lookup.has(key) && !sameModel(key) ? undefined : byId.get(catalogueAliases.get(key));
      if (alias) return { model: alias, tier: 1 };
    }
    return { model: undefined, tier: 1 };
  }
  function addBenchmark(id, name, source, definition, extra = {}) { const b = { id, name, tags: [], source, definition, ...extra }; benchmarks.push(b); return b; }
  // Distinct model names each source offered with a usable score, and whether each matched.
  const rowNames = new Map();
  function add(modelName, benchmark, value, details) {
    const { model, tier } = resolve(modelName), score = number(value);
    if (score === null || score < 0 || score > 1) return;
    const names = rowNames.get(benchmark.source) ?? new Map(); names.set(modelName, names.get(modelName) || !!model); rowNames.set(benchmark.source, names);
    if (!model) return;
    // A row under Scout's own name for the model outranks rows matched more loosely (an
    // older dated snapshot or another run setting), so those never shift its score.
    const key = `${model.id}|${benchmark.id}`, old = observations.get(key);
    if (old && old.tier < tier) return;
    const record = old && old.tier === tier ? old : { model, benchmark, tier, values: [], variants: new Set(), records: [] };
    record.values.push(score); record.variants.add(modelName); record.records.push(details); observations.set(key, record);
  }
  // Each source commits independently. A broken feed cannot freeze fresh prices or other benchmarks.
  function collect(id, name, url, attribution, work, extra = {}) {
    const start = benchmarks.length;
    try {
      if (failures[id]) throw new Error(failures[id]);
      const metadata = work() ?? {};
      const oldIDs = new Set(previous?.benchmarks.filter(b => b.source === id).map(b => b.id) ?? []);
      const oldCount = previous?.models.reduce((n, m) => n + m.evidence.filter(e => oldIDs.has(e.benchmark)).length, 0) ?? 0;
      const newCount = [...observations.values()].filter(o => o.benchmark.source === id).length;
      if (oldCount > 10 && newCount < oldCount * .3) throw new Error('Source coverage dropped unexpectedly; previous evidence retained.');
      // A refreshed public table may omit archived configurations. Retain only
      // explicitly historical observations of the same unchanged series, for
      // models still in the catalogue, without relabelling them as current.
      const priorBenchmarks=new Map(previous?.benchmarks.map(b=>[b.id,b])??[]);
      const unchanged=new Set(benchmarks.filter(b=>b.source===id&&JSON.stringify(b.definition)===JSON.stringify(priorBenchmarks.get(b.id)?.definition)).map(b=>b.id));
      for(const model of models){const old=previous?.models.find(m=>m.id===model.id);for(const e of old?.evidence??[])if(e.historical&&unchanged.has(e.benchmark)&&!observations.has(`${model.id}|${e.benchmark}`)&&!model.evidence.some(x=>x.benchmark===e.benchmark))model.evidence.push(e);}
      const names = [...(rowNames.get(id)?.values() ?? [])];
      sources.push({ id, name, url, attribution, status: 'ok', checkedAt, publishedAt: null, ...extra, ...metadata, matching: { models: names.length, matched: names.filter(Boolean).length } });
    } catch (error) {
      benchmarks.splice(start);
      for (const [key, value] of observations) if (value.benchmark.source === id) observations.delete(key);
      benchmarks.push(...(previous?.benchmarks.filter(b => b.source === id) ?? []));
      const ids = new Set(benchmarks.filter(b => b.source === id).map(b => b.id));
      for (const model of models) {
        const old = previous?.models.find(m => m.id === model.id);
        model.evidence.push(...(old?.evidence.filter(e => ids.has(e.benchmark)) ?? []));
        if (id === 'analysis') model.speed = old?.speed ?? null;
      }
      sources.push({ name, url, attribution, ...failed(id, error.message) });
    }
  }
  collect('epoch', 'Epoch AI', 'https://epoch.ai/benchmarks', 'Epoch AI, Capabilities & benchmarking. Normalized and matched by Scout. CC BY 4.0.', () => {
  let inflated = 0;
  const files = unzipSync(epochZip, { filter: entry => { if (entry.originalSize > 8_000_000 || (inflated += entry.originalSize) > 40_000_000) throw new Error('Expanded source exceeded size limit.'); return entry.name.endsWith('.csv'); } });
  const read = file => files[file] ? parseCSV(strFromU8(files[file])) : [];
  const metadata = read('benchmark_metadata.csv');
  if (metadata.length < 10) throw new Error('Epoch benchmark metadata is missing.');
  for (const meta of metadata) {
    const benchmark = addBenchmark(`epoch:${meta.benchmark}`, meta.benchmark, 'epoch', { title: meta.benchmark, ...descriptions[benchmarkIdentity(meta.benchmark)], metric: meta.score_column, sourceURL: 'https://epoch.ai/data/benchmark_data.zip' }, { releaseDate: meta.release_date || null, superseded: !!meta.superseded_by });
    if (!meta.source_file || !meta.score_column || benchmark.superseded) continue;
    for (const row of read(meta.source_file)) {
      const raw = number(row[meta.score_column]); if (raw === null) continue;
      add(row['Model version'], benchmark, raw * Number(meta.scale || 1), { url: safeURL(row['Source link']) ?? 'https://epoch.ai/benchmarks',
        observedAt: row['Started at'] || row['Last updated'] || null, sourceModel: row['Model version'], metric: meta.score_column });
    }
  }
  }, { license: 'https://creativecommons.org/licenses/by/4.0/' });
  collect('analysis', 'Artificial Analysis', sourceURLs.analysis, 'Benchmark results and reference speed by Artificial Analysis. Archived configurations remain labelled.', () => {
  const aa = parseAnalysis(analysisHTML), speedByModel = new Map(), descriptions = analysisDescriptions(analysisHTML);
  for (const [field, [slug, name]] of Object.entries(aaBenchmarks)) {
    // The page no longer carries descriptions; a series keeps the one it was published with.
    const prior = previous?.benchmarks.find(b => b.id === `aa:${field}`)?.definition?.description ?? null;
    const benchmark = addBenchmark(`aa:${field}`, name, 'analysis', { title: name, description: descriptions[field] ?? prior, metric: field, sourceURL: sourceURLs.analysis });
    for (const row of aa) {
      add(row.name, benchmark, row.scores?.[slug], { url: `https://artificialanalysis.ai/models/${encodeURIComponent(row.slug)}`, observedAt: null, sourceModel: row.name, metric: field, historical: !!row.deprecated });
    }
  }
  for (const [field, [slug, name]] of Object.entries(aaRatings)) {
    const rated = aa.filter(row => Number.isFinite(row.scores?.[slug])), sorted = rated.map(row => row.scores[slug]).sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    const benchmark = addBenchmark(`aa:${field}`, name, 'analysis', { title: name, description: `Artificial Analysis ${slug} rating, as the expected win rate against the median-rated model.`, metric: 'Win rate vs median model', sourceURL: sourceURLs.analysis });
    for (const row of rated) add(row.name, benchmark, 1 / (1 + 10 ** ((median - row.scores[slug]) / 400)), { url: `https://artificialanalysis.ai/models/${encodeURIComponent(row.slug)}`, observedAt: null, sourceModel: row.name, metric: 'Win rate vs median model', historical: !!row.deprecated });
  }
  for (const row of aa) {
    const { model } = resolve(row.name); if (!model || !(row.medianOutputTokensPerSecond > 0)) continue;
    const entries = speedByModel.get(model.id) ?? []; entries.push(row); speedByModel.set(model.id, entries);
  }
  for (const model of models) {
    const rows = speedByModel.get(model.id); if (!rows) continue;
    // Reasoning may stream before the answer. Preserve each measured configuration
    // so the ranker never combines one mode's startup time with another's throughput.
    const measurements = rows.map(r => ({ configuration: r.name, tokensPerSecond: r.medianOutputTokensPerSecond,
      timeToFirstAnswer: number(r.medianTimeToFirstAnswerTokenSeconds) ?? (r.isReasoning ? null : number(r.medianTimeToFirstTokenSeconds)) }));
    model.speed = { tokensPerSecond: median(rows.map(r => r.medianOutputTokensPerSecond)), timeToFirstToken: median(rows.map(r => r.medianTimeToFirstTokenSeconds).filter(v => v > 0)),
      timeToFirstAnswer: median(measurements.map(m => m.timeToFirstAnswer).filter(v => v !== null && v >= 0)), measurements,
      source: 'Artificial Analysis', url: `https://artificialanalysis.ai/models/${rows[0].slug}`, configurations: rows.map(r => r.name), observedAt: null, historical: rows.every(r => r.deprecated) };
  }
  });
  collect('openvlm', 'OpenCompass / VLMEvalKit', 'https://huggingface.co/spaces/opencompass/open_vlm_leaderboard', 'OpenVLM leaderboard, OpenCompass / VLMEvalKit. Older vision results; source date is preserved.', () => {
  if (!openvlm?.results) throw new Error('Invalid visual benchmark feed.');
  const visionDate = /^\d{14}$/.test(openvlm.time) ? `${openvlm.time.slice(0, 4)}-${openvlm.time.slice(4, 6)}-${openvlm.time.slice(6, 8)}` : null;
  const visionKeys = [...new Set(Object.values(openvlm.results).flatMap(v => Object.keys(v)))].filter(k => k !== 'META').sort();
  for (const key of visionKeys) {
    const benchmark = addBenchmark(`vlm:${key}`, key.replaceAll('_', ' '), 'openvlm', { title: key.replaceAll('_', ' '), description: 'Visual understanding evaluation from the OpenVLM leaderboard. Models receive image inputs.', metric: key, sourceURL: sourceURLs.openvlm });
    for (const [name, row] of Object.entries(openvlm.results)) {
      const result = row[key]; if (!result) continue;
      const value = key === 'OCRBench' ? number(result['Final Score']) : number(result.Overall);
      if (value !== null) add(name, benchmark, value / (key === 'OCRBench' ? 1000 : 100), { url: 'https://huggingface.co/spaces/opencompass/open_vlm_leaderboard',
        observedAt: visionDate, sourceModel: name, metric: key === 'OCRBench' ? 'Final Score / 1000' : 'Overall / 100' });
    }
  }
  return { publishedAt: visionDate };
  });
  collect('omnidoc', 'OmniDocBench', 'https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation', 'Document parsing results from OmniDocBench, v1.6_full leaderboard. Per-model evaluation dates are not supplied.', () => {
    const rows = parseOmniDoc(omnidocHTML);
    const benchmark = addBenchmark('omnidoc:v1.6_full', 'OmniDocBench v1.6 full', 'omnidoc', { title: 'OmniDocBench v1.6 full', description: 'End-to-end parsing of text, tables, formulas and layout in document images. General VLMs section; Overall score.', sourceURL: sourceURLs.omnidoc });
    for (const row of rows) add(row.name, benchmark, row.score / 100, { url: 'https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation', observedAt: null, sourceModel: row.name, metric: 'Overall / 100' });
  });
  collect('idp', 'IDP Leaderboard', sourceURLs.idp, 'Intelligent Document Processing Leaderboard by Nanonets (MIT). Component series only; per-model evaluation dates are not supplied.', () => {
    const rows = parseIDP(idpHTML);
    for (const [id, , name, description] of idpSeries) {
      const benchmark = addBenchmark(`idp:${id}`, name, 'idp', { title: name, description, metric: 'Score / 100', suite: 'IDP Leaderboard', sourceURL: sourceURLs.idp });
      for (const row of rows) add(row.name, benchmark, row.scores[id] / 100, { url: sourceURLs.idp, observedAt: null, sourceModel: row.name, metric: 'Score / 100' });
    }
  }, { license: 'https://opensource.org/licenses/MIT' });
  collect('vectara', 'Vectara Hallucination Leaderboard', 'https://github.com/vectara/hallucination-leaderboard', 'Vectara Hallucination Leaderboard (Apache-2.0). Summaries scored with HHEM-2.3; models answering fewer than 90% of documents are excluded. Per-model evaluation dates are not supplied.', () => {
    const { rows, publishedAt } = parseVectara(vectaraMarkdown);
    const benchmark = addBenchmark('vectara:factual-consistency', 'Vectara Hallucination Leaderboard · Factual consistency', 'vectara', { title: 'Vectara Hallucination Leaderboard · Factual consistency', description: 'Each model summarizes thousands of supplied news and other documents using only facts in the document. HHEM-2.3 scores whether each summary is supported by its source. Score is the share of summaries without hallucinated content.', metric: 'Factual consistency rate / 100', sourceURL: 'https://github.com/vectara/hallucination-leaderboard' });
    // Entries use provider/model-date identifiers.
    for (const row of rows) add(row.name.split('/').pop().replace(/[-_]\d{4}-?\d{2}-?\d{2}$/, '').replace(/:\d+$/, ''), benchmark, row.consistency / 100, { url: 'https://github.com/vectara/hallucination-leaderboard', observedAt: publishedAt, sourceModel: row.name, metric: 'Factual consistency rate / 100' });
    return { publishedAt };
  }, { license: 'https://www.apache.org/licenses/LICENSE-2.0' });
  collect('arena', 'Arena', 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset', 'Arena leaderboard dataset: style-controlled ratings from crowdsourced pairwise human votes, by prompt category. Converted to expected win rate against the median-rated model; ratings with confidence intervals wider than 60 points are excluded. Human preference, not verified correctness.', () => {
    const text = parseArena(arenaRows, arenaCategories.map(c => c[0])), document = parseArena(arenaDocumentRows, ['overall']);
    for (const [category, name, description] of arenaCategories) {
      const benchmark = addBenchmark(`arena:${category}`, name, 'arena', { title: name, description: `${description} Crowdsourced pairwise votes on real user prompts, style-controlled. Score is the expected win rate against the median-rated model in this category.`, metric: 'Win rate vs median model', suite: 'Arena text', sourceURL: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset' });
      for (const row of text.categories[category]) add(row.name, benchmark, row.score, { url: 'https://arena.ai/leaderboard/text', observedAt: text.dates[category], sourceModel: row.name, metric: 'Win rate vs median model' });
    }
    const benchmark = addBenchmark('arena:document', 'Arena · Document', 'arena', { title: 'Arena · Document', description: 'Human preference on prompts about uploaded documents such as PDFs: users ask questions, request summaries or extract information, and vote between two anonymous answers. Style-controlled. Score is the expected win rate against the median-rated model.', metric: 'Win rate vs median model', suite: 'Arena document', sourceURL: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset' });
    for (const row of document.categories.overall) add(row.name, benchmark, row.score, { url: 'https://arena.ai/leaderboard/document', observedAt: document.publishedAt, sourceModel: row.name, metric: 'Win rate vs median model' });
    return { publishedAt: text.publishedAt };
  }, { license: 'https://creativecommons.org/licenses/by/4.0/' });
  // Vision, Code Arena and text factuality are separate sources, so a missing board never withholds another.
  for (const [id, name, rows, categories, suite, page, url, prefix, factuality = false] of [
    ['arenaVision', 'Arena · Vision', arenaVisionRows, arenaVisionCategories, 'Arena vision', 'https://arena.ai/leaderboard/vision', sourceURLs.arenaVision, 'arena:vision'],
    ['arenaWebdev', 'Arena · WebDev', arenaWebdevRows, arenaWebdevCategories, 'Arena WebDev', 'https://arena.ai/leaderboard/webdev', sourceURLs.arenaWebdev, 'arena:webdev'],
    ['arenaFactuality', 'Arena · Factuality', arenaFactualityRows, arenaFactualityCategories, 'Arena text factuality', 'https://arena.ai/leaderboard/text/overall-factuality', sourceURLs.arenaFactuality, 'arena:factuality', true],
  ]) collect(id, name, 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset', `Arena leaderboard dataset, ${suite} board: ${factuality ? "ratings from crowdsourced pairwise human votes combined with automated web verification of each response's factual claims (25% weight)" : 'style-controlled ratings from crowdsourced pairwise human votes'} by category. Converted to expected win rate against the median-rated model; ratings with confidence intervals wider than 60 points are excluded. ${factuality ? 'Claim checks cover web-verifiable facts only, not reasoning or task completion.' : 'Human preference, not verified correctness.'}`, () => {
    const board = parseArena(rows, categories.map(c => c[0]));
    for (const [category, title, description] of categories) {
      const benchmark = addBenchmark(category === 'overall' ? prefix : `${prefix}:${category}`, title, id, { title, description: `${description}${factuality ? '' : ' Style-controlled.'} Score is the expected win rate against the median-rated model in this category.`, metric: 'Win rate vs median model', suite, sourceURL: url });
      for (const row of board.categories[category]) add(row.name, benchmark, row.score, { url: page, observedAt: board.dates[category], sourceModel: row.name, metric: 'Win rate vs median model' });
    }
    return { publishedAt: board.publishedAt };
  }, { license: 'https://creativecommons.org/licenses/by/4.0/' });
  collect('vals', 'Vals AI', 'https://www.vals.ai/benchmarks', 'Benchmark results run and published by Vals AI, many on private test sets. Overall accuracy only. Per-model evaluation dates are not supplied; each series records the date Vals AI last updated it. Matched by Scout.', () => {
    if (!vals) throw new Error('Vals AI benchmarks unavailable.');
    for (const v of vals.benchmarks) {
      const benchmark = addBenchmark(`vals:${v.slug}`, `${v.name} · Vals AI`, 'vals', { title: v.name, description: `${v.description}${v.industry ? ` Vals AI ${v.industry} benchmark.` : ''} ${v.publicData ? 'Public' : 'Private'} test set. Score is overall accuracy.`,
        metric: 'Accuracy / 100', suite: `Vals AI · ${v.family}`, sourceURL: `https://www.vals.ai/benchmarks/${v.slug}` }, { publishedAt: v.updated });
      for (const row of v.rows) {
        // Keys are "provider/model ID"; a host's key adds the model's own namespace. Vals marks
        // extended thinking with a "-thinking" suffix unless the model ID already has one.
        const own = row.id.split('/').slice(1).join('/'), last = row.id.split('/').pop();
        const name = [own, last, last.replace(/-thinking$/, '')].find(n => resolve(n).model) ?? own;
        add(name, benchmark, row.score, { url: `https://www.vals.ai/benchmarks/${v.slug}`, observedAt: null, sourceModel: row.id, metric: 'Accuracy / 100' });
      }
    }
    // A benchmark whose page failed this run keeps its previous definition and evidence.
    for (const slug of vals.missing) {
      const old = previous?.benchmarks.find(b => b.id === `vals:${slug}`);
      if (!old) continue;
      benchmarks.push(old);
      for (const model of models) model.evidence.push(...(previous.models.find(m => m.id === model.id)?.evidence.filter(e => e.benchmark === old.id) ?? []));
    }
    return { publishedAt: vals.benchmarks.map(v => v.updated).filter(Boolean).sort().at(-1) ?? null };
  });
  // Vendor-reported results are their own series, never merged into third-party measurements of the same benchmark.
  collect('vendor', 'Vendor-reported · LLM Stats', 'https://llm-stats.com/benchmarks', 'Benchmark scores model developers report in their announcements, papers and model cards, compiled by LLM Stats (llm-stats.com). Self-reported by each vendor and not independently verified; settings such as tools, attempts and reasoning effort follow the vendor and can differ between models.', () => {
    for (const v of parseVendorScores(vendorScores)) {
      const benchmark = addBenchmark(`vendor:${v.id}`, `${v.name} · vendor-reported`, 'vendor', { title: v.name, description: `${v.description} Scores reported by each model's developer, compiled by LLM Stats; not independently verified.`,
        metric: v.scale === 100 ? 'Reported score / 100' : 'Reported score', suite: `Vendor-reported · ${v.id}`, sourceURL: `https://llm-stats.com/benchmarks/${encodeURIComponent(v.id)}`, reportedBy: 'vendor' });
      for (const row of v.rows) {
        // IDs carry dates and effort settings ("gpt-5.1-medium-2025-11-12"); the display name is a fallback.
        const undated = row.id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
        const name = [row.id, undated, row.name].find(n => resolve(n).model) ?? row.id;
        add(name, benchmark, row.score, { url: `https://llm-stats.com/models/${encodeURIComponent(row.id)}`, observedAt: null, sourceModel: row.id, metric: benchmark.definition.metric });
      }
    }
  }, { license: 'https://llm-stats.com/terms' });
  collect('bfcl', 'Berkeley Function Calling Leaderboard', 'https://gorilla.cs.berkeley.edu/leaderboard', 'BFCL v4 native function-calling evaluations. Memory uses the named external backend, not built-in model memory. Per-model measurement dates are not supplied.', () => {
    const rows = parseBFCL(bfclCSV);
    if (rows.length < 3) throw new Error('Too few native BFCL configurations.');
    for (const [id, field, name] of bfclMetrics) {
      const benchmark = addBenchmark(`bfcl:${id}`, name, 'bfcl', { title: name, metric: field, suite: 'Berkeley Function Calling Leaderboard v4', description: 'Native function-calling evaluation. Only the named subset/metric is measured by this series.', sourceURL: sourceURLs.bfcl });
      for (const row of rows) if (row.scores[id] !== undefined) add(row.name, benchmark, row.scores[id], {
        url: id.startsWith('memory') ? 'https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html' : 'https://gorilla.cs.berkeley.edu/leaderboard',
        observedAt: null, sourceModel: row.name, metric: `${field} / 100`,
      });
    }
  });
  for (const { model, benchmark, values, variants, records } of observations.values()) {
    const dates = [...new Set(records.map(r => r.observedAt))];
    model.evidence.push({ benchmark: benchmark.id, score: median(values), metric: records[0].metric,
      url: records[0].url, urls: [...new Set(records.map(r => r.url))], observedAt: dates.length === 1 ? dates[0] : null,
      observedDates: dates.filter(Boolean), historical: records.every(r => r.historical), configurations: [...variants] });
  }
  const usable = models.filter(m => m.evidence.length && m.inputPrice >= 0 && m.outputPrice >= 0 && m.inputPrice !== null && m.outputPrice !== null);
  if (usable.length < 10) throw new Error('Too few matched models; previous index retained.');
  if (!sources.some(s => s.status === 'ok')) throw new Error('All public sources failed; previous index retained.');
  let specialists = previous?.specialists ?? [];
  if (hubRows !== undefined || previous?.specialists) {
    try {
      const next = parseHubModels(hubRows, checkedAt);
      if (specialists.length > 10 && next.length < specialists.length * .3) throw new Error('Hub coverage dropped unexpectedly.');
      specialists = next;
      sources.push({ id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/models', status: 'ok', checkedAt, publishedAt: null, attribution: 'Public repository metadata and reported evaluation results. Up to 30 most-downloaded repositories in each of fourteen task queries, including two OCR-filtered pipelines; not an exhaustive Hub index.' });
    } catch { sources.push({ ...failed('huggingface', failures.huggingface ?? 'Hub metadata unavailable.'), name: 'Hugging Face', url: 'https://huggingface.co/models', attribution: 'Public repository metadata and reported evaluation results; last complete discovery snapshot retained.' }); }
  }
  // Unmatched names are diagnostics for the collection step; records do not keep them.
  const unmatchedRows = Object.fromEntries([...rowNames].map(([source, names]) => [source, [...names].filter(([, matched]) => !matched).map(([n]) => n)]));
  return { version: 1, dataVersion: 7, selectionMetadataVersion:'1',providerMetadata:providerMetadata(modelsDev),checkedAt, sources, unmatchedRows, benchmarks, benchmarkDescriptions: descriptions, benchmarkMethodologies: benchmarkMethodologies ?? previous?.benchmarkMethodologies ?? {}, models: usable, specialists, availableModels: models.length,
    catalogue: models.map(({ evidence: _e, speed: _s, ...model }) => model) };
}

export async function refreshSnapshot(fetcher = fetch, previous, options = {}) {
  async function read(url, type, maxBytes = 12_000_000) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'OpenMerit-Scout/0.1 (+https://openmerit.ai/scout)' } });
    if (!response.ok) throw new Error(`Source returned ${response.status}: ${new URL(url).hostname}`);
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('Source exceeded size limit.'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (type === 'zip') return bytes;
    if (type === 'parquet') return parquetReadObjects({ file: bytes.buffer, columns: ['model_name', 'rating', 'rating_lower', 'rating_upper', 'category', 'leaderboard_publish_date'] });
    const text = new TextDecoder().decode(bytes); return type === 'json' ? JSON.parse(text) : text;
  }
  const methodologies = Promise.allSettled([
    read(sourceURLs.analysisMethodology, 'text', 3_000_000).then(methodologySections),
    read(sourceURLs.bfclMethodology, 'text', 1_000_000).then(methodologySections),
    read(sourceURLs.bfclMemory, 'text', 1_000_000).then(methodologySections),
  ]).then(results => ({
    value: { analysis: results[0].status === 'fulfilled' ? { url: sourceURLs.analysisMethodology, sections: results[0].value } : previous?.benchmarkMethodologies?.analysis ?? null,
      bfcl: results.slice(1).every(r => r.status === 'fulfilled') ? { urls: [sourceURLs.bfclMethodology, sourceURLs.bfclMemory], sections: results.slice(1).flatMap(r => r.value) } : previous?.benchmarkMethodologies?.bfcl ?? null },
    failed: [...(results[0].status === 'rejected' ? ['analysis'] : []), ...(results.slice(1).some(r => r.status === 'rejected') ? ['bfcl'] : [])],
  }));
  const valsRead = readVals(read);
  const descriptions = readEpochDefinitions(read).then(value => ({ value }), () => ({ value: previous?.benchmarkDescriptions, failed: true }));
  const specs = [['epoch', 'epochZip', 'zip'], ['analysis', 'analysisHTML', 'text'], ['openvlm', 'openvlm', 'json'], ['models', 'router', 'json'], ['omnidoc', 'omnidocHTML', 'text'], ['idp', 'idpHTML', 'text'], ['vectara', 'vectaraMarkdown', 'text'], ['arena', 'arenaRows', 'parquet'], ['arenaDocument', 'arenaDocumentRows', 'parquet'], ['arenaVision', 'arenaVisionRows', 'parquet'], ['arenaWebdev', 'arenaWebdevRows', 'parquet'], ['arenaFactuality', 'arenaFactualityRows', 'parquet'], ['vendor', 'vendorScores', 'json'], ['bfcl', 'bfclCSV', 'text'], ['modelsdev', 'modelsDev', 'json']];
  const results = await Promise.allSettled([...specs.map(([id, , type]) => read(sourceURLs[id], type)), ...hubQueries.map(query => read(query.url, 'json', 2_000_000))]);
  const inputs = { previous, failures: {}, catalogueSupply: options.catalogueSupply };
  results.slice(0, specs.length).forEach((result, i) => {
    const [id, field] = specs[i];
    if (result.status === 'fulfilled') inputs[field] = result.value;
    else inputs.failures[id] = result.reason.message;
  });
  const hubResults = results.slice(specs.length);
  if (hubResults.every(r => r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length <= 30)) inputs.hubRows = hubResults.flatMap(r => r.value);
  else { inputs.hubRows = null; inputs.failures.huggingface = 'One or more bounded Hub queries failed; previous complete snapshot retained.'; }
  if (inputs.hubRows) {
    // Bounded, pinned configs add label vocabularies without downloading weights.
    const rows = [...new Map(inputs.hubRows.filter(m => hubID(m.id)).map(m => [m.id, m])).values()];
    const selected = ['image-classification', 'object-detection', 'image-segmentation'].flatMap(p => rows.filter(m => m.pipeline_tag === p).slice(0, 6));
    await Promise.allSettled(selected.map(async m => { if (/^[a-f0-9]{40,64}$/.test(m.sha ?? '')) m.config = await read(`https://huggingface.co/${m.id}/resolve/${m.sha}/config.json`, 'json', 500_000); }));
    inputs.hubRows = rows;
  }
  const described = await descriptions, methods = await methodologies;
  try { inputs.vals = await valsRead; } catch (error) { inputs.failures.vals = error.message; }
  inputs.benchmarkMethodologies = methods.value;
  inputs.benchmarkDescriptions = described.value;
  const snapshot = compileSnapshot(inputs);
  if (described.failed) snapshot.sources = snapshot.sources.map(s => s.id === 'epoch' ? { ...s, status: 'failed', error: 'Benchmark descriptions unavailable; previous descriptions retained when available.' } : s);
  if (methods.failed.length) snapshot.sources = snapshot.sources.map(s => methods.failed.includes(s.id) ? { ...s, status: 'failed', error: 'Benchmark methodology unavailable; previous methodology retained when available.' } : s);
  if (options.collectOnly) return snapshot;
  const prepared=await refreshModelMetadata(snapshot,previous,{...options,fetcher});
  const interpreted = await refreshBenchmarks(prepared, previous, { ...options, fetcher });
  return refreshSpecialists(interpreted, previous, { ...options, fetcher });
}
