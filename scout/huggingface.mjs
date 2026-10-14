// Public metadata discovery only. Never download weights or execute repository code.
const pipelines = ['document-question-answering', 'token-classification', 'text-classification', 'sentence-similarity', 'text2text-generation', 'text-generation', 'image-to-text', 'image-text-to-text'];
const fields = ['cardData', 'pipeline_tag', 'tags', 'sha', 'gated', 'private', 'disabled', 'lastModified', 'library_name', 'safetensors', 'inferenceProviderMapping', 'evalResults'];
export const hubQueries = pipelines.map(pipeline => {
  const url = new URL('https://huggingface.co/api/models');
  for (const [key, value] of Object.entries({ pipeline_tag: pipeline, sort: 'downloads', direction: '-1', limit: '30' })) url.searchParams.set(key, value);
  fields.forEach(field => url.searchParams.append('expand', field));
  if (['image-to-text', 'image-text-to-text'].includes(pipeline)) url.searchParams.set('filter', 'ocr');
  return { pipeline, url: url.href };
});
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : null;
const list = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(v => typeof v === 'string').slice(0, 80).map(v => v.slice(0, 200));
export const hubID = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : null;
const safeURL = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
function evaluations(model) {
  const results = [];
  for (const item of (Array.isArray(model.evalResults) ? model.evalResults : []).slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const r = item.data ?? item;
    if (item.error || !hubID(r.dataset?.id) || typeof r.dataset.task_id !== 'string' || !Number.isFinite(r.value)) continue;
    results.push({ format: 'eval-results', dataset: r.dataset.id, task: text(r.dataset.task_id), value: r.value,
      datasetRevision: text(r.dataset.revision), date: text(r.date), notes: text(r.notes, 500), url: safeURL(r.source?.url) ?? `https://huggingface.co/datasets/${r.dataset.id}`,
      provenance: 'Hub-reported result; not independently verified by Scout', verificationProvided: typeof r.verifyToken === 'string' });
  }
  for (const entry of (Array.isArray(model.cardData?.['model-index']) ? model.cardData['model-index'] : []).slice(0, 8)) {
    for (const r of (Array.isArray(entry?.results) ? entry.results : []).slice(0, 20)) for (const metric of (Array.isArray(r?.metrics) ? r.metrics : []).slice(0, 8)) {
      if (!metric || !Number.isFinite(metric.value) || !text(r.dataset?.type) || !text(metric.type)) continue;
      results.push({ format: 'model-card', dataset: text(r.dataset.type), datasetName: text(r.dataset.name), task: text(r.task?.type), metric: text(metric.type), value: metric.value,
        split: text(r.dataset.split), configuration: text(r.dataset.config), date: null, url: safeURL(r.source?.url) ?? `https://huggingface.co/${model.id}`, provenance: 'Model-card claim; not independently verified by Scout', verificationProvided: false });
    }
  }
  return results.slice(0, 40);
}
export function parseHubModels(rows, checkedAt) {
  if (!Array.isArray(rows) || rows.length > 240) throw new Error('Invalid Hugging Face catalogue');
  const unique = new Map();
  for (const m of rows) {
    if (!hubID(m?.id) || m.private || m.disabled || !pipelines.includes(m.pipeline_tag) || !/^[a-f0-9]{40,64}$/.test(m.sha ?? '')) continue;
    const card = m.cardData ?? {}, tags = list(m.tags);
    // Packaging variants and adapters need a base/runtime; do not count them as standalone models.
    if (tags.some(t => /^(?:peft|gguf|gptq|awq)$|^base_model:(?:adapter|quantized):/.test(t)) || ['adapter', 'quantized'].includes(card.base_model_relation)) continue;
    const mapping = m.inferenceProviderMapping;
    const providers = (Array.isArray(mapping) ? mapping : mapping && typeof mapping === 'object' ? Object.entries(mapping).map(([provider, v]) => ({ provider, ...v })) : [])
      .filter(p => p?.status === 'live').map(p => ({ provider: text(p.provider), task: text(p.task), modelId: text(p.providerId, 200) })).filter(p => p.provider).slice(0, 12);
    unique.set(m.id, { id: m.id, url: `https://huggingface.co/${m.id}`, revision: m.sha, cardURL: `https://huggingface.co/${m.id}/blob/${m.sha}/README.md`,
      pipeline: m.pipeline_tag, library: text(m.library_name), tags, languages: list(card.language), license: text(card.license), licenseName: text(card.license_name),
      licenseURL: safeURL(card.license_link) ?? `https://huggingface.co/${m.id}/tree/${m.sha}`, gated: m.gated === true || ['auto', 'manual'].includes(m.gated),
      baseModels: list(card.base_model), parameters: Number.isFinite(m.safetensors?.total) ? m.safetensors.total : null, providers,
      evaluations: evaluations(m), updatedAt: text(m.lastModified), checkedAt });
  }
  return [...unique.values()];
}
const words = value => new Set(String(value).toLowerCase().match(/[a-z][a-z0-9]+/g)?.map(w => w.replace(/s$/, '')) ?? []);
const domainGroups = [ ['medical','clinical','biomedical','radiology','disease','patient'], ['financial','finance','finbert','stock','trading'], ['legal','law','contract'], ['invoice','receipt'], ['code','coding','coder','javascript','python','typescript'] ];
const languages = { english: 'en', arabic: 'ar', chinese: 'zh', french: 'fr', german: 'de', hindi: 'hi', italian: 'it', japanese: 'ja', korean: 'ko', portuguese: 'pt', russian: 'ru', spanish: 'es', turkish: 'tr' };
const fitTerms = new Set([...domainGroups.flat(), ...Object.keys(languages), 'pdf', 'document', 'table', 'form', 'handwritten', 'ocr', 'entity', 'sentiment', 'classification', 'extraction', 'embedding', 'retrieval']);
function overlap(a, b) { return [...a].filter(w => b.has(w)); }
export function discoverSpecialists(snapshot, task, prompt, selected = []) {
  const catalogue = snapshot.specialists ?? [], query = words(prompt), selectedRepos = new Set(selected.map(c => c.model?.repository).filter(Boolean));
  const choices = [];
  const requestedLanguages = Object.entries(languages).filter(([name]) => query.has(name)).map(([, code]) => code);
  for (const m of catalogue) {
    if (selectedRepos.has(m.id)) continue;
    if (requestedLanguages.length && m.languages.length && !m.languages.includes('multilingual') && requestedLanguages.some(code => !m.languages.includes(code))) continue;
    const tags = words([m.id, ...m.tags].join(' '));
    const groups = domainGroups.filter(group => group.some(w => tags.has(w)));
    if (groups.some(group => !group.some(w => query.has(w)))) continue;
    let fit;
    if (task.needsVision && task.weights.documents && m.pipeline === 'document-question-answering') fit = 'Document question answering component; OCR, field assembly and JSON validation may be required.';
    const documentTags = m.tags.some(tag => /^(?:pdf|document-(?:understanding|parsing|parse|intelligence|to-markdown)|layout-analysis)$/.test(tag));
    if (task.needsVision && task.weights.documents && ['image-to-text', 'image-text-to-text'].includes(m.pipeline) && tags.has('ocr') && documentTags) fit = m.tags.includes('structured-extraction') ? 'Document extraction candidate; its schema accuracy and end-to-end runtime need testing.' : 'OCR component; recognized text still needs field extraction and JSON validation.';
    if (!task.needsVision && task.kind === 'extract' && m.pipeline === 'token-classification' && /\b(?:ner|named.entity|entity.extraction|gliner)\b/i.test([m.id, ...m.tags].join(' '))) fit = 'Entity extraction component; check its label set and add field mapping and JSON validation.';
    if (task.kind === 'classify' && m.pipeline === 'text-classification') fit = 'Classification component; its trained labels must match your categories.';
    if (task.kind === 'code' && ['text-generation', 'text2text-generation'].includes(m.pipeline) && groups.some(g => g.includes('code'))) fit = 'Code generation candidate; instruction format, language support and executable correctness need testing.';
    if (task.kind === 'retrieve' && !task.needsVision && m.pipeline === 'sentence-similarity') fit = 'Embedding component for retrieval; requires an index and retrieval evaluation, not a standalone answer generator.';
    if (!fit || task.needsTools || task.needsMemory) continue;
    const matches = overlap(query, tags).filter(w => fitTerms.has(w));
    choices.push({ ...m, fit, matchedTerms: matches.slice(0, 8), quality: null, costUsd: null, latencySeconds: null });
  }
  // Relevance and inspectable metadata aid discovery, never predict quality.
  const completeness = m => [m.license, m.library, m.parameters, m.evaluations.length, m.languages.length].filter(Boolean).length;
  choices.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || completeness(b) - completeness(a) || a.id.localeCompare(b.id));
  // Show different ways to solve the task before filling with similar components.
  // Repositories remain separate identities; repeated names are only display diversity.
  const candidates = [], names = new Set(), seenPipelines = new Set();
  for (const diverse of [true, false]) for (const m of choices) {
    const name = m.id.split('/')[1].toLowerCase();
    if (candidates.length === 3 || names.has(name) || (diverse && seenPipelines.has(m.pipeline))) continue;
    candidates.push(m); names.add(name); seenPipelines.add(m.pipeline);
  }
  return { mode: 'discovery', indexedRepositories: catalogue.length, matchedRepositories: choices.length, candidates,
    basis: 'Task metadata match, with component diversity and metadata completeness, not a performance ranking. Bounded sample of 30 most-downloaded repositories in each of eight pipeline queries (image pipelines filtered to OCR). Downloads select coverage only. Missing results do not establish poor quality.',
    limitations: 'Metadata and scores may be publisher claims. No common task evaluation, endpoint cost, latency or hardware fit has been measured. Public weights do not by themselves establish an open-source license. Check the model card and license. No weights are downloaded or executed.' };
}
