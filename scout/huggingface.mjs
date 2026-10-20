// Public metadata discovery only. Never download weights or execute repository code.
import { specialistMatch, relevantProfiles } from './specialists.mjs';
const pipelines = ['document-question-answering', 'token-classification', 'text-classification', 'sentence-similarity', 'text2text-generation', 'text-generation', 'image-to-text', 'image-text-to-text', 'image-classification', 'zero-shot-image-classification', 'object-detection', 'image-segmentation', 'zero-shot-object-detection', 'mask-generation'];
const fields = ['cardData', 'config', 'pipeline_tag', 'tags', 'sha', 'gated', 'private', 'disabled', 'lastModified', 'library_name', 'safetensors', 'inferenceProviderMapping', 'evalResults'];
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
  if (!Array.isArray(rows) || rows.length > hubQueries.length * 30) throw new Error('Invalid Hugging Face catalogue');
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
      labels: Object.values(m.config?.id2label ?? {}).filter(v => typeof v === 'string').slice(0, 2000),
      pipeline: m.pipeline_tag, library: text(m.library_name), tags, languages: list(card.language), license: text(card.license), licenseName: text(card.license_name),
      licenseURL: safeURL(card.license_link) ?? `https://huggingface.co/${m.id}/tree/${m.sha}`, gated: m.gated === true || ['auto', 'manual'].includes(m.gated),
      baseModels: list(card.base_model), parameters: Number.isFinite(m.safetensors?.total) ? m.safetensors.total : null, providers,
      evaluations: evaluations(m), updatedAt: text(m.lastModified), checkedAt });
  }
  return [...unique.values()];
}
export function discoverSpecialists(snapshot, task, _prompt, selected = []) {
  const catalogue = snapshot.specialists ?? [], selectedRepos = new Set(selected.map(c => c.model?.repository).filter(Boolean));
  const relevant = new Set(relevantProfiles(snapshot.specialistProfiles ?? [], task).map(p => p.id));
  const descriptions = {
    documents: 'Document reading component; field assembly and output validation may be required.',
    entities: 'Entity extraction component; field mapping and output validation may be required.',
    text_labels: 'Text classification component; evaluate the declared label contract on your examples.',
    image_labels: 'Image classification component; evaluate the declared label contract on your examples.',
    retrieval: 'Embedding component for retrieval; requires an index and retrieval evaluation.',
    code: 'Code generation candidate; instruction format and executable correctness need testing.',
    boxes: 'Object localization component; evaluate category coverage and localization accuracy.',
    masks: 'Segmentation component; check required points, boxes or other inputs.',
  };
  const choices = catalogue.flatMap(m => {
    const match = specialistMatch(m, task);
    if (!match || !relevant.has(m.semantic.profileId) || selectedRepos.has(m.id) || task.selection?.required.length&&!task.selection.allowedRepositories?.includes(m.id)) return [];
    return [{ ...m, fit: descriptions[m.semantic.spec.operation], matchedTerms: [], semanticMatch: match, quality: null, costUsd: null, latencySeconds: null }];
  });
  // Compatibility is eligibility, not a quality score. Preserve deterministic
  // metadata completeness and component diversity without prompt-word overlap.
  const completeness = m => [m.license, m.library, m.parameters, m.evaluations.length, m.languages.length].filter(Boolean).length;
  choices.sort((a, b) => completeness(b) - completeness(a) || a.id.localeCompare(b.id));
  const candidates = [], names = new Set(), seenPipelines = new Set();
  for (const diverse of [true, false]) for (const m of choices) {
    const name = m.id.split('/')[1].toLowerCase();
    if (candidates.length === 3 || names.has(name) || (diverse && seenPipelines.has(m.pipeline))) continue;
    candidates.push(m); names.add(name); seenPipelines.add(m.pipeline);
  }
  return { mode: 'discovery', indexedRepositories: catalogue.length, matchedRepositories: choices.length, candidates,
    basis: 'Decisions compatibility with hourly-prepared metadata profiles, followed by component diversity and metadata completeness; not a performance ranking. Bounded sample of 30 most-downloaded repositories per pipeline. Downloads select coverage only.',
    limitations: 'Metadata and semantic interpretation can be incomplete or wrong. No common task evaluation, endpoint cost, latency or hardware fit has been measured. No weights are downloaded or executed.' };
}
