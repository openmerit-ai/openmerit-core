import { unzipSync, strFromU8 } from 'fflate';
import { refreshBenchmarks } from './benchmarks.mjs';
import { readEpochDefinitions, analysisDescriptions, benchmarkIdentity, methodologySections } from './benchmark-metadata.mjs';
import { catalogueURL, parseProviderCatalogue, mergeCatalogues, routerEndpoint, textOutputOnly, reportedFact, providerMetadata } from './catalogue.mjs';
import contracts from './endpoint-contracts.json' with { type: 'json' };
import { hubQueries, parseHubModels, hubID } from './huggingface.mjs';
import { refreshSpecialists } from './specialists.mjs';
import { refreshModelMetadata } from './metadata.mjs';

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
  bfclMethodology: 'https://gorilla.cs.berkeley.edu/leaderboard',
  bfclMemory: 'https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html',
};
const norm = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
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

const aaBenchmarks = {
  gpqa: 'GPQA Diamond · AA', hle: 'Humanity’s Last Exam · AA',
  scicode: 'SciCode · AA', ifbench: 'IFBench · AA', lcr: 'AA Long Context Reasoning',
  terminalbenchHard: 'Terminal-Bench Hard · AA', terminalBench21: 'Terminal-Bench 2.1 · AA',
  terminalBench40: 'Terminal-Bench 4.0 · AA', tau2: 'τ²-Bench · AA', tauBanking: 'τ-Bench Banking · AA',
  critpt: 'CritPt · AA', apexAgents: 'APEX-Agents · AA', itbenchSre: 'ITBench SRE · AA',
  mmmuPro: 'MMMU Pro · AA', omniscienceAccuracy: 'AA Omniscience accuracy',
  analystAgent: 'Analyst Agent · AA', gdpvalNormalized: 'GDPval · AA',
};

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

export function compileSnapshot({ epochZip, analysisHTML, openvlm, router, omnidocHTML, bfclCSV, hubRows, modelsDev, benchmarkDescriptions, benchmarkMethodologies, previous, failures = {}, checkedAt = new Date().toISOString() }) {
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
  for (const entry of contracts.entries) if (!sources.some(s => s.id === entry.source)) sources.push({ id: entry.source, name: `${entry.provider} · typed endpoints`, url: entry.url, status: 'ok', checkedAt: contracts.reviewedAt, refreshPolicy: 'manual-contract-review', attribution: 'Provider-documented endpoint contract and quoted rates; versioned metadata, not a live performance probe.' });
  const lookup = new Map();
  for (const model of models) for (const alias of [model.id.split('/').slice(1).join('/'), model.canonical?.split('/').slice(1).join('/'), model.name]) {
    if (!alias) continue; const key = norm(alias); const previous = lookup.get(key);
    lookup.set(key, lookup.has(key) && previous !== model ? null : model);
  }
  const explicitAliases = { 'claudesonnet4520250929': 'anthropic/claude-sonnet-4.5', 'claudehaiku4520251001': 'anthropic/claude-haiku-4.5', 'chatgpt4olatest': 'openai/chatgpt-4o-latest', 'claude37sonnet20250219': 'anthropic/claude-3.7-sonnet', 'gemini25propreview0325': 'google/gemini-2.5-pro-preview-03-25', 'gemini3flash': 'google/gemini-3-flash-preview', 'qwen3vl235b': 'qwen/qwen3-vl-235b-a22b-instruct' };
  function resolve(name) {
    const base = String(name).replace(/_(?:none|low|medium|high|xhigh|max|unknown|thinking|nothinking)$/, '').replace(/\s*\([^)]*\)\s*$/, '');
    return lookup.get(norm(base)) ?? models.find(m => m.id === explicitAliases[norm(base)]);
  }
  function addBenchmark(id, name, source, definition, extra = {}) { const b = { id, name, tags: [], source, definition, ...extra }; benchmarks.push(b); return b; }
  function add(modelName, benchmark, value, details) {
    const model = resolve(modelName), score = number(value);
    if (!model || score === null || score < 0 || score > 1) return;
    const key = `${model.id}|${benchmark.id}`;
    const record = observations.get(key) ?? { model, benchmark, values: [], variants: new Set(), records: [] };
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
      sources.push({ id, name, url, attribution, status: 'ok', checkedAt, publishedAt: null, ...extra, ...metadata });
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
  for (const [field, name] of Object.entries(aaBenchmarks)) {
    const benchmark = addBenchmark(`aa:${field}`, name, 'analysis', { title: name, description: descriptions[field] ?? null, metric: field, sourceURL: sourceURLs.analysis });
    for (const row of aa) {
      add(row.name, benchmark, row[field], { url: `https://artificialanalysis.ai/models/${encodeURIComponent(row.slug)}`, observedAt: null, sourceModel: row.name, metric: field, historical: !!row.deprecated });
    }
  }
  for (const row of aa) {
    const model = resolve(row.name); if (!model || !(row.medianOutputTokensPerSecond > 0)) continue;
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
  return { version: 1, dataVersion: 7, selectionMetadataVersion:'1',providerMetadata:providerMetadata(modelsDev),checkedAt, sources, benchmarks, benchmarkDescriptions: descriptions, benchmarkMethodologies: benchmarkMethodologies ?? previous?.benchmarkMethodologies ?? {}, models: usable, specialists, availableModels: models.length,
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
  const descriptions = readEpochDefinitions(read).then(value => ({ value }), () => ({ value: previous?.benchmarkDescriptions, failed: true }));
  const specs = [['epoch', 'epochZip', 'zip'], ['analysis', 'analysisHTML', 'text'], ['openvlm', 'openvlm', 'json'], ['models', 'router', 'json'], ['omnidoc', 'omnidocHTML', 'text'], ['bfcl', 'bfclCSV', 'text'], ['modelsdev', 'modelsDev', 'json']];
  const results = await Promise.allSettled([...specs.map(([id, , type]) => read(sourceURLs[id], type)), ...hubQueries.map(query => read(query.url, 'json', 2_000_000))]);
  const inputs = { previous, failures: {} };
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
