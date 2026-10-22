import { providerIdentity } from './providers.js';
import { initAuth } from './auth.js';
import { analytics } from './analytics.js';

const $ = selector => document.querySelector(selector);
const basePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const money = value => value == null ? '—' : `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: value < 1 ? 2 : 0 }).format(value)}`;
let result = null, activeRequest = null, requestID = 0, resultTrace;

function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function link(text, url) { const node = element('a', '', text); try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) { node.href = parsed.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } } catch {} return node; }
function metric(value, label, tag = 'td') {
  const node = element(tag, 'metric-cell'); node.title = label;
  node.append(element('span', value === '—' ? 'metric-unavailable' : '', value));
  if (value === '—') node.append(element('span', 'sr-only', label));
  return node;
}
function tableMessage(message, height = 120) {
  const row = element('tr'), cell = element('td', 'table-message'); cell.colSpan = 4; cell.style.height = `${Math.max(120, height)}px`; cell.append(element('span', '', message)); row.append(cell); return row;
}
function providerIcon(provider) {
  if (!provider.file) return null;
  const img = element('img', `provider-icon${provider.invertOnDark ? ' provider-icon-monochrome' : ''}`); img.alt = ''; img.width = 13; img.height = 13; img.decoding = 'async';
  img.title = provider.title ?? provider.label;
  img.setAttribute('aria-hidden', 'true'); img.addEventListener('error', () => img.remove());
  img.src = `${basePath}/providers/${provider.file}`; return img;
}
async function copy(text, button, label = 'Copied') {
  const previous = button.textContent; let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; button.textContent = label; $('#announcement').textContent = label; }
  catch { button.textContent = 'Select and copy'; $('#announcement').textContent = 'Clipboard access is unavailable. Select the text to copy it.'; }
  setTimeout(() => { if (button.isConnected) button.textContent = previous; }, 1800);
  return copied;
}
function evidenceItem(e) {
  const item = element('div', 'evidence-item'); item.append(link(`${e.benchmark} ↗`, e.url), element('span', '', `${e.score.toFixed(1)}`));
  item.append(element('small', '', `${e.cohortSize} comparable models · ${e.observedAt ? `Source date: ${e.observedAt.slice(0, 10)}` : 'Measurement date not supplied'} · ${e.configurations.join(', ')}${e.historical ? ' · archived evaluation' : ''}`)); return item;
}
function modelEntry(model, prefix, taskTitle, steps = 0, taskIndex = 1) {
  const position = { rank: model.rank, task_index: taskIndex, trace_id: resultTrace };
  const row = element(steps ? 'td' : 'tr', steps ? 'sequence-cell' : 'model-row'), nameCell = element(steps ? 'div' : 'th', 'model-cell');
  if (!steps) nameCell.scope = 'row';
  const provider = providerIdentity(model), identity = element('span', 'model-identity'), name = element('span'), title = element('span', 'model-title', model.name), byline = element('span', 'model-provider', provider.label);
  const toggle = element('button', 'model-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-label', `Details for ${model.name}${taskTitle ? ` · ${taskTitle}` : ''}`); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${prefix}-model-${model.rank}`);
  if (taskTitle) toggle.title = `${taskTitle} · rank ${model.rank}`;
  const icon = providerIcon(provider); if (icon) byline.prepend(icon);
  if (model.endpoint) byline.append(document.createTextNode(` · ${model.endpoint.protocol === 'decisions' ? 'Decisions' : model.endpoint.protocol === 'systemone' ? 'System One' : model.endpoint.deployment === 'self-hosted' ? 'Self-hosted' : model.endpoint.provider}`));
  name.append(title, byline);
  if (!steps) identity.append(element('span', 'model-number', String(model.rank).padStart(2, '0')));
  identity.append(name); toggle.append(identity); nameCell.append(toggle);
  const qualityValue = model.measured ? model.measured.quality * 100 : model.quality;
  const tag = steps ? 'dd' : 'td';
  const quality = metric(qualityValue == null ? '—' : `${qualityValue.toFixed(0)}${model.measured ? '%' : ''}`, model.measured ? 'Mean task-check accuracy on separate calibration cases. Not predicted accuracy on your prompt.' : model.quality == null ? 'No comparable task-quality measurement. Ordered by task fit, not proven performance.' : 'Relative result of shared-benchmark comparisons. Not predicted task accuracy.', tag);
  const cost = metric(model.reference?.costUsd != null ? money(model.reference.costUsd * 1000) : '—', model.measured ? `Mean reported charge, scaled to 1,000 similar tasks; cost known for ${model.measured.costKnownCalls}/${model.measured.cases} tasks.` : 'Illustrative USD per 1,000 tasks at the workload below; excludes hidden reasoning and modality-specific charges.', tag);
  const time = metric(model.reference?.completionSeconds != null ? `${model.reference.completionSeconds.toFixed(1)}s` : '—', model.measured ? 'Median full task time on the calibration cases, including failures.' : 'Reference first-answer delay plus generation time; actual endpoint latency may differ.', tag);
  row.append(nameCell);
  if (steps) {
    const metrics = element('dl', 'sequence-metrics');
    for (const [label, value] of [[model.measured ? 'Accuracy' : 'Quality / 100', quality], ['Cost / 1k', cost], ['Time', time]]) {
      const item = element('div'); item.append(element('dt', '', label), value); metrics.append(item);
    }
    row.append(metrics);
  } else row.append(quality, cost, time);
  const detail = element('tr', 'model-detail'), detailCell = element('td', 'model-detail-cell'); detailCell.colSpan = steps ? steps + 1 : 4; detail.id = `${prefix}-model-${model.rank}`; detail.hidden = true;
  toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; toggle.setAttribute('aria-expanded', String(!detail.hidden)); row.dataset.expanded = String(!detail.hidden); if (!detail.hidden) analytics.track('scout_evidence_opened', position); });
  // Preserve table semantics and native Enter/Space behavior; any other part of
  // the row activates the same button. Links and buttons keep their own action.
  row.addEventListener('click', event => { if (!event.target.closest('button, a')) toggle.click(); });
  const body = element('div', 'model-evidence');
  if (taskTitle) body.append(element('p', 'price-detail', taskTitle));
  const idLine = element('div', 'model-id-line'), copyID = element('button', '', 'Copy ID'); copyID.type = 'button'; copyID.addEventListener('click', async () => { if (await copy(model.endpoint?.modelId ?? model.id, copyID)) analytics.track('scout_model_id_copied', position); });
  idLine.append(element('code', '', model.endpoint?.modelId ?? model.id), copyID); body.append(idLine);
  if (model.endpoint) {
    const endpoint = element('p', 'price-detail'); endpoint.append(element('code', '', model.endpoint.id), document.createTextNode(` · ${model.endpoint.status ?? 'listed'} · ${model.endpoint.deployment}.`)); body.append(endpoint);
    if (model.taskFit) body.append(element('p', 'price-detail', model.reason));
    if (model.endpoint.limits && !model.taskFit) body.append(element('p', 'price-detail', model.endpoint.limits));
    if (model.endpoint.licenseURL) { const license = element('p', 'price-detail'); license.append(link(`Declared license: ${model.endpoint.license ?? 'check model card'} ↗`, model.endpoint.licenseURL)); body.append(license); }
    if (model.endpoint.cardURL) { const card = element('p', 'price-detail'); card.append(link('Pinned model card ↗', model.endpoint.cardURL)); body.append(card); }
  }
  if (model.measured) { const observed = element('p', 'price-detail'); observed.append(link('Measured task evidence ↗', model.measured.url), document.createTextNode(` · ${model.measured.cases} cases · ${new Date(model.measured.measuredAt).toLocaleDateString()} · charges known for ${model.measured.costKnownCalls}/${model.measured.cases} tasks.`)); body.append(observed); }
  const grid = element('div', 'evidence-grid'); model.evidence.slice(0, 4).forEach(e => grid.append(evidenceItem(e))); body.append(grid);
  if (model.evidence.length > 4) { const more = element('details', 'evidence-more'); more.append(element('summary', '', `All ${model.evidence.length} benchmark results`)); const rest = element('div', 'evidence-grid'); model.evidence.slice(4).forEach(e => rest.append(evidenceItem(e))); more.append(rest); body.append(more); }
  const pricing = element('p', 'price-detail', `${money(model.pricing.inputPerMillion)} input / ${money(model.pricing.outputPerMillion)} output per million tokens, ${model.pricing.basis ?? 'Advertised rates.'}`);
  if (model.pricing.url) {
    const providerLink = link('Provider page ↗', model.pricing.url);
    const followed = event => { if (providerLink.href && (event.type === 'click' || event.button === 1)) analytics.track('scout_provider_opened', position); };
    providerLink.addEventListener('click', followed); providerLink.addEventListener('auxclick', followed);
    pricing.append(document.createTextNode(' '), providerLink);
  }
  body.append(pricing);
  if (model.speed && !model.measured) { const speed = element('p', 'price-detail'); speed.append(link('Reference timing by Artificial Analysis ↗', model.speed.url), document.createTextNode(` · ${model.speed.configurations.join(', ')}. ${model.speed.historical ? 'Archived reference measurement. ' : ''}Endpoint performance may differ.`)); body.append(speed); }
  detailCell.append(body); detail.append(detailCell); return { row, detail };
}
function showSources(sources, calibration) {
  $('#source-list').replaceChildren(...sources.map(source => {
    const detail = element('details', 'source-detail'), heading = element('summary'), coverage = source.coverage;
    heading.append(element('span', '', source.name), element('span', 'source-role', source.role ?? 'Public source')); detail.append(heading);
    if (coverage) detail.append(element('p', 'source-counts', source.refreshPolicy === 'manual-contract-review' ? 'Reviewed endpoint contract' : ['models', 'modelsdev'].includes(source.id) ? `${coverage.cataloguedModels} catalogued models` : source.id === 'huggingface' ? `${coverage.repositories} repositories · ${coverage.repositoriesWithReportedResults} with structured reported results` : `${coverage.benchmarkSeries} benchmark series · ${coverage.matchedModels} matched models · ${coverage.measurements} results`));
    detail.append(element('p', '', source.measures ?? source.attribution), element('p', '', source.limits));
    const date = element('p', 'source-dates', `${source.refreshPolicy === 'manual-contract-review' ? 'Contract reviewed' : 'Collected'} ${source.checkedAt ? new Date(source.checkedAt).toLocaleString() : '—'}.${source.publishedAt ? ` Published ${source.publishedAt}.` : ''}${source.status === 'failed' ? ' Refresh failed; previous data retained.' : ''}`);
    if (coverage?.measurements) date.append(document.createTextNode(` Source dates supplied for ${coverage.datedResults}/${coverage.measurements} results; these may be publication dates.${coverage.latestSourceDate ? ` Latest: ${coverage.latestSourceDate.slice(0, 10)}.` : ''}${coverage.historicalResults ? ` Includes ${coverage.historicalResults} archived results.` : ''}`));
    detail.append(date); const links = element('p', 'source-links'); links.append(link('Source ↗', source.url));
    if (source.license) links.append(link('Source license ↗', source.license)); detail.append(links); return detail;
  }));
  if (calibration) {
    const detail = element('details', 'source-detail'); detail.append(element('summary', '', calibration.name), element('p', '', calibration.limits));
    for (const p of calibration.profiles) detail.append(element('p', 'source-dates', `${p.label} · ${p.casesPerModel} cases × ${p.testedModels} models · measured ${new Date(p.measuredAt).toLocaleDateString()} · ${p.active ? 'within seven-day window' : 'expired'}. ${p.scope.input} input / ${p.scope.output} output.`));
    const links = element('p', 'source-links'); links.append(link('Calibration data ↗', calibration.url)); detail.append(links); $('#source-list').append(detail);
  }
}
function showSpecialists(discovery, root) {
  const $ = selector => root.querySelector(`[data-field="${selector.slice(1)}"]`);
  const candidates = discovery?.candidates ?? [];
  $('#specialists').hidden = !candidates.length;
  $('#specialists-title').textContent = `Specialist models · ${candidates.length}`;
  $('#specialist-list').replaceChildren(...candidates.map(m => {
    const item = element('article', 'specialist-item'), title = element('p', 'specialist-title');
    const icon = providerIcon(providerIdentity({ ...m, source: 'huggingface', provider: m.id.split('/')[0] }));
    if (icon) title.append(icon); title.append(link(`${m.id} ↗`, m.url)); item.append(title, element('p', '', m.fit));
    item.append(element('p', 'source-dates', `${m.pipeline} · ${m.languages.length ? m.languages.join(', ') : 'Language not declared'} · ${m.library ?? 'Runtime not declared'}. ${m.parameters ? `${(m.parameters / 1e6).toFixed(0)}M parameters; hardware needs unmeasured.` : 'Size and hardware needs not established.'}`));
    const license = element('p', 'source-dates'); license.append(link(`Declared license: ${m.license ?? 'not supplied'} ↗`, m.licenseURL), document.createTextNode(` · ${m.gated ? 'Access approval required' : 'Not marked gated'}. ${m.providers.length ? `Hub lists hosting via ${m.providers.map(p => p.provider).join(', ')}; prices and latency unmeasured.` : 'No live hosting route listed by the Hub; check hosting or local deployment.'}`)); item.append(license);
    const evidence = element('details', 'specialist-evidence'); evidence.append(element('summary', '', m.evaluations.length ? `${m.evaluations.length} reported evaluation results` : 'No structured evaluation results indexed'));
    if (m.evaluations.length) evidence.append(element('p', 'source-dates', 'Reported by the repository or evaluation source; not independently verified by Scout. Scores keep their original units. Dates may be publication dates.'));
    for (const e of m.evaluations) { const p = element('p'); p.append(link(`${e.dataset} · ${e.metric ?? e.task} · ${e.value} ↗`, e.url), element('small', 'source-dates', `${e.split ? ` Split: ${e.split}.` : ''}${e.configuration ? ` Configuration: ${e.configuration}.` : ''}${e.date ? ` Reported ${e.date.slice(0, 10)}.` : ' Date not supplied.'}${e.notes ? ` ${e.notes}` : ''}`)); evidence.append(p); }
    const card = element('p'); card.append(link('Pinned model card ↗', m.cardURL), document.createTextNode(` · checked ${new Date(m.checkedAt).toLocaleDateString()}`)); evidence.append(card); item.append(evidence); return item;
  }));
  $('#specialist-coverage').textContent = candidates.length ? `${discovery.indexedRepositories} repositories indexed in a bounded Hub sample. Matches use task metadata, not measured performance. Model-card claims and licenses need checking; missing results do not mean a model is poor.` : '';
}
const tableObserver = new ResizeObserver(entries => {
  for (const {target} of entries) {
    const horizontal = target.scrollWidth > target.clientWidth + 1, vertical = target.scrollHeight > target.clientHeight + 1;
    const hint = target.closest('.result-table').querySelector('.table-scroll-hint');
    hint.hidden = !horizontal && !vertical;
    hint.querySelector('span').textContent = [vertical ? '↕' : '', horizontal ? '↔' : ''].filter(Boolean).join(' ');
  }
});
function renderContext(data, taskTitle) {
  const root = $('#result-context-template').content.firstElementChild.cloneNode(true);
  const field = name => root.querySelector(`[data-field="${name}"]`);
  const qualityGate = data.ranking?.frontier?.qualityGate;
  field('task-title').textContent = taskTitle ?? ''; field('task-title').hidden = !taskTitle;
  field('warnings').replaceChildren(...data.warnings.map(warning => element('p', '', warning)));
  const workload = data.ranking?.workload, profile = data.ranking?.profile;
  field('ranking-note').textContent = data.ranking?.mode === 'task-fit' ? 'Candidates ordered by task fit and deployment readiness, then known reference costs. Quality is unmeasured.' : profile ? 'Models in Scout rank order among tested eligible candidates. Accuracy, mean cost and median full task time come from separate calibration cases, not executions of your prompt.' : qualityGate?.status === 'unverified' ? 'Unverified shortlist: no comparable quality cohort. Known reference cost first; these candidates have not passed the relative quality screen.' : qualityGate ? ({ cost: 'Lowest known reference cost first among models not credibly worse than the strongest benchmark estimate.', latency: 'Fastest known reference time first among models not credibly worse than the strongest benchmark estimate.' }[data.ranking.frontier.priority] ?? 'Strongest benchmark estimate first, keeping the best-value and fastest qualifying models. Quality uses one relative benchmark estimate, not verified task accuracy.') : 'Models in Scout rank order using shared benchmarks and an illustrative workload. Quality is a ranking signal, not predicted task accuracy.';
  field('workload-note').textContent = data.ranking?.mode === 'task-fit' ? 'Task-compatible shortlist. No comparable endpoint-quality measurements; self-hosted costs and unmeasured latency remain unknown.' : profile ? `${profile.casesPerModel} calibration cases per model · ${profile.eligibleTestedModels} tested models · ${new Date(profile.measuredAt).toLocaleDateString()}. Not measured on your task.` : workload ? `Reference workload: ${workload.inputTokens.toLocaleString()} input + ${workload.outputTokens.toLocaleString()} output tokens per task · ${workload.priority} priority. Cost and time are comparisons, not task-specific measurements.` : 'Based on published benchmarks. Evaluate these models on your own examples.';
  showSpecialists(data.specialists, root);
  return root;
}
function showResult(data, roundTripMs) {
  result = data; tableObserver.disconnect();
  const tasks = data.tasks ?? [{title:'Your task',slots:[data]}], count = tasks.reduce((n,t) => n+t.slots.reduce((n,s) => n+s.recommendations.length,0),0);
  $('#results-title').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} · ${count} candidates`;
  $('#query-time').textContent = `Search ${(roundTripMs / 1000).toFixed(2)}s`;
  $('#query-time').title = 'Total search time, including task interpretation and network time';
  $('#results-basis').hidden = false;
  const root = $('#result-template').content.firstElementChild.cloneNode(true), table = root.querySelector('table');
  const steps = tasks.map(task => ({ task, data: task.slots[0], text: task.sourceText ?? (tasks.length === 1 ? data.prompt : null) }));
  const heading = (step, i) => {
    const node = element('div', 'task-caption');
    if (steps.length > 1) node.append(element('span', 'task-order', String(i + 1)));
    const text = element(step.text ? 'q' : 'span', 'task-excerpt', step.text ?? step.task.title); text.title = step.text ?? step.task.title;
    node.append(text); return node;
  };
  const body = element('tbody');
  if (steps.length === 1) {
    const step = steps[0], slot = step.data, profile = slot.ranking?.profile;
    root.prepend(heading(step, 0));
    $('#results-basis').textContent = 'Up to five candidates · quality, cost and latency trade-offs';
    root.querySelector('[data-field="quality-heading"]').replaceChildren(document.createTextNode(profile ? 'Accuracy ' : 'Quality '), element('span', 'column-unit', profile ? 'calibration cases' : slot.ranking?.mode === 'task-fit' ? 'not measured' : 'relative / 100'));
    root.querySelector('[data-field="time-unit"]').textContent = profile ? 'measured seconds' : 'reference seconds';
    for (const model of slot.recommendations) { const entry = modelEntry(model, 'task-1', step.text ?? step.task.title); body.append(entry.row, entry.detail); }
    if (!slot.recommendations.length) body.append(tableMessage(slot.warnings[0] || 'No matching models with verified evidence.'));
  } else {
    root.dataset.sequence = ''; table.className = 'data-table sequence-table'; table.style.setProperty('--steps', steps.length);
    $('#results-basis').textContent = 'Read left to right · alternatives ranked within each task';
    const header = element('tr'), rank = element('th', 'rank-column', 'Rank'); rank.scope = 'col'; header.append(rank);
    steps.forEach((step, i) => { const cell = element('th', 'step-column'); cell.scope = 'col'; cell.append(heading(step, i)); header.append(cell); });
    table.querySelector('thead').replaceChildren(header);
    const rows = Math.max(1, ...steps.map(step => step.data.recommendations.length));
    for (let i = 0; i < rows; i++) {
      const row = element('tr', 'sequence-row'), number = element('th', 'sequence-rank', String(i + 1).padStart(2, '0')), details = [];
      number.scope = 'row'; row.append(number);
      steps.forEach((step, j) => {
        const model = step.data.recommendations[i];
        if (!model) { row.append(element('td', 'sequence-empty', step.data.recommendations.length ? 'No further candidate' : 'No eligible model')); return; }
        const entry = modelEntry(model, `task-${j+1}`, step.text ?? step.task.title, steps.length, j + 1);
        row.append(entry.row); details.push(entry.detail);
      });
      body.append(row, ...details);
    }
  }
  table.append(body);
  steps.forEach(step => root.querySelector('[data-field="contexts"]').append(renderContext(step.data, step.text ?? step.task.title)));
  $('#task-results').replaceChildren(root);
  tableObserver.observe(root.querySelector('.table-scroll'));
  showIndex(data);
  $('#announcement').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}. ${count} model candidates.`;
  analytics.track('scout_results_viewed', { task_count: tasks.length, candidate_count: count, duration_ms: Math.round(roundTripMs), trace_id: resultTrace });
}
function showIndex(data) {
  $('#index-counts').replaceChildren(...[`${data.availableModels ?? data.models} API models`, `${data.specialistRepositories ?? 0} HF repositories`, `${data.benchmarks} benchmark series`, `${data.sources.length} sources`].map(text => element('span', '', text)));
  $('#index-counts').title = `${data.benchmarksWithResults} benchmark series have matched results · ${data.endpoints ?? data.models} hosted endpoints · ${data.independentModels ?? 0} models with independent provider metadata · ${data.specialistRepositories ?? 0} specialist repositories`;
  showSources(data.sources, data.calibration);
  const capabilities = (data.wordCloud ?? []).map(c => ({ ...c, matched: !!data.task?.capabilities?.some(match => match.id === c.id) }));
  capabilities.sort((a, b) => Number(b.matched) - Number(a.matched));
  $('#capability-list').replaceChildren(...capabilities.map(c => {
    const item = element('li', 'capability-item'), name = element('div', 'capability-name', c.label);
    item.dataset.matched = String(c.matched);
    if (c.matched) {
      const match = element('span', 'capability-match', '✓'); match.setAttribute('aria-hidden', 'true'); match.title = 'Task match';
      name.append(match, element('span', 'sr-only', ' — Task match'));
    }
    item.append(name, element('span', 'capability-coverage', `${c.benchmarks} benchmark series · ${c.models} models`));
    return item;
  }));
}
async function search() {
  const prompt = $('#prompt').value.trim(); if (!prompt) { $('#error').textContent = 'Describe the task you want a model to do.'; $('#error').hidden = false; $('#prompt').focus(); return; }
  activeRequest?.abort(); const controller = new AbortController(); activeRequest = controller; const id = ++requestID;
  let token;
  try { token = await auth.getToken(); }
  catch (error) { if (id === requestID) { $('#error').textContent = error.message; $('#error').hidden = false; } return; }
  if (!token || id !== requestID) return;
  $('#results').hidden = false; $('#error').hidden = true; $('#results').setAttribute('aria-busy', 'true');
  result = null; tableObserver.disconnect(); $('#results-title').textContent = 'Searching…';
  $('#task-results').replaceChildren(element('p', 'search-state', 'Understanding tasks and comparing the prepared index…'));
  $('#query-time').textContent = ''; $('#results-basis').hidden = true;
  $('#announcement').textContent = 'Searching the prepared index.';
  $('.find-button span').textContent = 'Searching…'; $('.find-button').setAttribute('aria-busy', 'true');
  const started = performance.now(), timeout = setTimeout(() => controller.abort(), 35_000);
  let failureCode = 'network_error', httpStatus, traceId;
  try {
    const response = await fetch(`${basePath}/api/recommend`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...analytics.headers() }, body: JSON.stringify({ prompt }), signal: controller.signal });
    if (id !== requestID) return;
    traceId = response.headers.get('x-scout-trace-id');
    httpStatus = response.status; failureCode = response.ok ? 'invalid_response' : 'http_error';
    if (response.status === 401) { await auth.signIn(); throw new Error('Your session has expired. Sign in and try again.'); }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Scout API is not available on this server. Start the Scout server and try again.');
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Scout could not complete this search.');
    failureCode = 'render_error';
    if (id === requestID) { resultTrace = traceId; showResult(data, performance.now() - started); }
  } catch (error) {
    if (id !== requestID) return;
    analytics.exception(error, error.name === 'AbortError' ? 'search_timeout' : failureCode, { trace_id: traceId, ...(httpStatus >= 400 ? { http_status: httpStatus } : {}) });
    result = null; tableObserver.disconnect(); $('#task-results').replaceChildren(); $('#results-title').textContent = 'Search unavailable'; $('#query-time').textContent = '';
    $('#error').textContent = error.name === 'AbortError' ? 'This request took too long. Please try again.' : error instanceof TypeError ? 'Couldn’t reach Scout. Check the connection and try again.' : error.message; $('#error').hidden = false;
  } finally { clearTimeout(timeout); if (id === requestID) { $('#results').setAttribute('aria-busy', 'false'); $('.find-button span').textContent = 'Find models'; $('.find-button').setAttribute('aria-busy', 'false'); } }
}
// Re-measure after content or width changes; CSS bounds very long prompts.
function fitPrompt() {
  const input = $('#prompt');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
$('#prompt').addEventListener('input', fitPrompt);
window.addEventListener('resize', fitPrompt);
window.addEventListener('pageshow', fitPrompt);
fitPrompt();
// Examples are hints only: never insert text or submit a request.
const promptExamples = [
  $('#prompt').placeholder,
  'Review a TypeScript API that sometimes creates duplicate orders. Trace the cause, suggest a small fix, and write regression tests. The model needs to read several files and use tools to run the tests.',
  'Compare five research papers about battery recycling. Summarize their methods, separate measured results from claims, and cite the passages behind each conclusion. Flag anything the papers leave uncertain.',
  'Turn release notes into a customer email under 200 words. Explain what changed, who benefits, and how to get started. Keep the tone direct and friendly, preserve the facts, and avoid promotional language.',
  'Build a support assistant that checks order status with tools and remembers customer preferences across conversations. It should use the latest information, ask before changing an order, and respond quickly.',
];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let exampleIndex = 0;
let exampleTransition;
function canRotateExample() {
  const input = $('#prompt');
  return !input.value && document.activeElement !== input && !document.hidden && !reducedMotion.matches;
}
function stopExampleTransition() {
  clearTimeout(exampleTransition);
  $('#prompt').classList.remove('example-changing');
}
setInterval(() => {
  if (!canRotateExample()) return;
  const input = $('#prompt');
  input.classList.add('example-changing');
  exampleTransition = setTimeout(() => {
    if (canRotateExample()) {
      exampleIndex = (exampleIndex + 1) % promptExamples.length;
      input.placeholder = promptExamples[exampleIndex];
    }
    stopExampleTransition();
  }, 180);
}, 10000);
$('#prompt').addEventListener('focus', stopExampleTransition);
$('#prompt').addEventListener('input', stopExampleTransition);
document.addEventListener('visibilitychange', stopExampleTransition);
reducedMotion.addEventListener('change', stopExampleTransition);
$('#scout-form').addEventListener('submit', event => { event.preventDefault(); void search(); });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#scout-form').requestSubmit(); } });
const auth = initAuth(() => {
  activeRequest?.abort(); requestID++; result = null; resultTrace = undefined; tableObserver.disconnect();
  $('#task-results').replaceChildren(); $('#results').hidden = true; $('#results').setAttribute('aria-busy', 'false'); $('#error').hidden = true;
  $('#prompt').value = ''; fitPrompt(); $('.find-button span').textContent = 'Find models'; $('.find-button').setAttribute('aria-busy', 'false');
});
const command = `curl ${location.origin}${basePath}/api/recommend \\\n  -H "Authorization: Bearer $SCOUT_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"prompt":"Extract six invoice fields as JSON"}'`;
$('#agent-code').textContent = command;
$('#copy-command').addEventListener('click', () => copy(command, $('#copy-command')));
const mcpURL = `${location.origin}${basePath}/mcp`;
$('#mcp-url').textContent = mcpURL;
$('#copy-mcp').addEventListener('click', () => copy(mcpURL, $('#copy-mcp')));
fetch(`${basePath}/api/status`).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => { if (!result) showIndex(data); }).catch(() => { if (!result) { $('#index-counts').textContent = 'Index unavailable'; } });

// Deep links reveal the native disclosure before moving focus to its summary.
function revealSection() {
  if (location.hash !== '#for-agents') return;
  const section = $('#for-agents'); section.open = true; section.querySelector('summary').focus({ preventScroll: true });
}
window.addEventListener('hashchange', revealSection);
document.querySelectorAll('a[href="#for-agents"]').forEach(link => link.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  location.hash = '#for-agents';
  revealSection();
  $('#for-agents').scrollIntoView({ block: 'start' });
}));
revealSection();

function updateAnalyticsControls() {
  const settings = analytics.preferences();
  $('#analytics-usage').checked = settings.enabled; $('#analytics-usage').disabled = !settings.available;
  $('#analytics-content').checked = settings.content; $('#analytics-content').disabled = !settings.enabled || !settings.contentAvailable;
  $('#analytics-status').textContent = !settings.available ? 'Analytics is unavailable or disabled by your browser privacy settings.'
    : !settings.contentAvailable ? 'Prompt sharing is not enabled on this deployment.' : 'Prompt sharing is optional and off by default. Do not include secrets or confidential records.';
}
for (const id of ['#analytics-usage', '#analytics-content']) $(id).addEventListener('change', () => analytics.setPreferences($('#analytics-usage').checked, $('#analytics-content').checked));
window.addEventListener('scout-analytics-change', updateAnalyticsControls);
updateAnalyticsControls();
