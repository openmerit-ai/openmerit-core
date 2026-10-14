import { providerIdentity } from './providers.js';

const $ = selector => document.querySelector(selector);
const examples = {
  invoice: 'I want to upload an invoice and extract 6 fields from it as JSON.',
  coding: 'Find and fix a tricky bug in a TypeScript repository, then write unit tests.',
  research: 'Research a scientific question, compare the evidence, and explain the answer clearly.',
  writing: 'Rewrite a product announcement as a warm, clear email that sounds like a person.',
};
const money = value => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: value < 1 ? 2 : 0 }).format(value)}`;
let result = null, activeRequest = null, requestID = 0;

function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function link(text, url) { const node = element('a', '', text); try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) { node.href = parsed.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } } catch {} return node; }
function metric(value, label) {
  const node = element('td', 'metric-cell'); node.title = label;
  node.append(element('span', value === '—' ? 'metric-unavailable' : '', value));
  if (value === '—') node.append(element('span', 'sr-only', label));
  return node;
}
function tableMessage(message, height = 120) {
  const row = element('tr'), cell = element('td', 'table-message'); cell.colSpan = 5; cell.style.height = `${Math.max(120, height)}px`; cell.append(element('span', '', message)); row.append(cell); return row;
}
function providerIcon(provider) {
  if (!provider.file) return null;
  const img = element('img', 'provider-icon'); img.alt = ''; img.width = 13; img.height = 13; img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true'); img.addEventListener('error', () => img.remove());
  img.src = `/scout/providers/${provider.file}`; return img;
}
async function copy(text, button, label = 'Copied') {
  const previous = button.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = label; $('#announcement').textContent = label; }
  catch { button.textContent = 'Select and copy'; $('#announcement').textContent = 'Clipboard access is unavailable. Select the text to copy it.'; }
  setTimeout(() => { if (button.isConnected) button.textContent = previous; }, 1800);
}
function evidenceItem(e) {
  const item = element('div', 'evidence-item'); item.append(link(`${e.benchmark} ↗`, e.url), element('span', '', `${e.score.toFixed(1)}`));
  item.append(element('small', '', `${e.cohortSize} comparable models · ${e.observedAt ? `Source date: ${e.observedAt.slice(0, 10)}` : 'Measurement date not supplied'} · ${e.configurations.join(', ')}${e.historical ? ' · archived evaluation' : ''}`)); return item;
}
function modelRow(model) {
  const fragment = document.createDocumentFragment(), row = element('tr', 'model-row'), nameCell = element('th', 'model-cell'); nameCell.scope = 'row';
  const provider = providerIdentity(model), identity = element('div', 'model-identity'), name = element('div'), title = element('span', 'model-title', model.name), byline = element('span', 'model-provider', provider.label);
  const icon = providerIcon(provider); if (icon) byline.prepend(icon);
  name.append(title, byline); identity.append(element('span', 'model-number', String(model.rank).padStart(2, '0')), name); nameCell.append(identity);
  const qualityValue = model.measured ? model.measured.quality * 100 : model.quality;
  const quality = metric(`${qualityValue.toFixed(0)}${model.measured ? '%' : ''}`, model.measured ? 'Mean field accuracy on separate calibration cases. Not predicted accuracy on your prompt.' : 'Relative result of shared-benchmark comparisons. Not predicted task accuracy.');
  row.append(nameCell, quality, metric(model.reference?.costUsd != null ? money(model.reference.costUsd * 1000) : '—', model.measured ? `Mean reported charge, scaled to 1,000 similar tasks; cost known for ${model.measured.costKnownCalls}/${model.measured.cases} requests.` : 'Illustrative USD per 1,000 tasks at the workload below; excludes hidden reasoning and modality-specific charges.'), metric(model.reference?.completionSeconds != null ? `${model.reference.completionSeconds.toFixed(1)}s` : '—', model.measured ? 'Median full request time on the calibration cases, including failures.' : 'Reference first-answer delay plus generation time; actual endpoint latency may differ.'));
  const action = element('td'), toggle = element('button', 'evidence-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-label', `Evidence for ${model.name}`); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `model-evidence-${model.rank}`);
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chevron.setAttribute('viewBox', '0 0 16 16'); chevron.setAttribute('fill', 'none'); chevron.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm4 6 4 4 4-4'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); chevron.append(path);
  toggle.append(document.createTextNode('Evidence'), chevron); action.append(toggle); row.append(action);
  const detail = element('tr', 'model-detail'), detailCell = element('td', 'model-detail-cell'); detailCell.colSpan = 5; detail.id = `model-evidence-${model.rank}`; detail.hidden = true;
  toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; toggle.setAttribute('aria-expanded', String(!detail.hidden)); row.dataset.expanded = String(!detail.hidden); });
  const body = element('div', 'model-evidence'); body.append(element('p', 'evidence-intro', `${model.reason} ${model.evidenceCoverage}% capability coverage · ${model.comparison?.capabilityCoverage ?? 0}% average shared-capability coverage · ${model.confidence}.`));
  const idLine = element('div', 'model-id-line'), copyID = element('button', '', 'Copy ID'); copyID.type = 'button'; copyID.addEventListener('click', () => copy(model.id, copyID));
  idLine.append(element('code', '', model.id), copyID); body.append(idLine);
  if (model.measured) { const observed = element('p', 'price-detail'); observed.append(link('Measured task evidence ↗', model.measured.url), document.createTextNode(` · ${model.measured.cases} cases · ${new Date(model.measured.measuredAt).toLocaleDateString()} · charges known for ${model.measured.costKnownCalls}/${model.measured.cases} calls.`)); body.append(observed); }
  const grid = element('div', 'evidence-grid'); model.evidence.slice(0, 4).forEach(e => grid.append(evidenceItem(e))); body.append(grid);
  if (model.evidence.length > 4) { const more = element('details', 'evidence-more'); more.append(element('summary', '', `All ${model.evidence.length} benchmark results`)); const rest = element('div', 'evidence-grid'); model.evidence.slice(4).forEach(e => rest.append(evidenceItem(e))); more.append(rest); body.append(more); }
  const pricing = element('p', 'price-detail'); pricing.append(document.createTextNode(`${money(model.pricing.inputPerMillion)} input / ${money(model.pricing.outputPerMillion)} output per million tokens. `), link('View model & pricing ↗', model.pricing.url)); body.append(pricing);
  if (model.speed && !model.measured) { const speed = element('p', 'price-detail'); speed.append(link('Reference timing by Artificial Analysis ↗', model.speed.url), document.createTextNode(` · ${model.speed.configurations.join(', ')}. ${model.speed.historical ? 'Archived reference measurement. ' : ''}Endpoint performance may differ.`)); body.append(speed); }
  detailCell.append(body); detail.append(detailCell); fragment.append(row, detail); return fragment;
}
function showSources(sources) {
  $('#source-list').replaceChildren(...sources.map(source => {
    const p = element('p'); const a = link(`${source.name} ↗`, source.url); a.className = 'source-link'; p.append(a, document.createTextNode(` — ${source.attribution}${source.publishedAt ? ` Published ${source.publishedAt}.` : ''} Last checked: ${source.checkedAt ? new Date(source.checkedAt).toLocaleString() : 'unavailable'}.${source.status === 'failed' ? ' Refresh failed; previous data retained.' : ''}`));
    if (source.license) p.append(document.createTextNode(' '), link('Source license', source.license)); return p;
  }));
}
function showResult(data, roundTripMs) {
  result = data;
  $('#results-title').textContent = data.recommendations.length ? 'Recommendations' : 'No matching models';
  $('#capabilities').replaceChildren(...(data.task.capabilities.length ? data.task.capabilities.map(c => c.label) : ['General purpose']).map(label => element('span', '', label)));
  $('#query-time').textContent = `${(roundTripMs / 1000).toFixed(2)}s`;
  $('#query-time').title = 'Total search time, including task interpretation and network time';
  $('#model-list').replaceChildren(...data.recommendations.map(modelRow));
  if (!data.recommendations.length) $('#model-list').append(tableMessage(data.warnings[0] || 'Try describing the task in more detail.'));
  $('#copy-results').disabled = !data.recommendations.length;
  $('#warnings').replaceChildren(...data.warnings.map(warning => element('p', '', warning)));
  const workload = data.ranking?.workload, profile = data.ranking?.profile;
  $('#quality-heading').replaceChildren(document.createTextNode(profile ? 'Accuracy ' : 'Quality '), element('span', 'column-unit', profile ? 'calibration cases' : 'relative / 100'));
  $('#time-unit').textContent = profile ? 'measured seconds' : 'reference seconds';
  $('#table-caption').textContent = profile ? 'Models in Scout rank order among tested eligible candidates. Accuracy, mean cost and median full request time come from separate calibration cases, not executions of your prompt.' : 'Models in Scout rank order using shared benchmarks and an illustrative workload. Quality is a ranking signal, not predicted task accuracy.';
  $('#results-caption').textContent = profile ? `${profile.casesPerModel} calibration cases per model · ${profile.eligibleTestedModels} tested models · ${new Date(profile.measuredAt).toLocaleDateString()}. Not measured on your task.` : workload ? `Reference workload: ${workload.inputTokens.toLocaleString()} input + ${workload.outputTokens.toLocaleString()} output tokens per task · ${workload.priority} priority. Cost and time are comparisons, not task-specific measurements.` : 'Based on published benchmarks. Evaluate these models on your own examples.';
  $('#limitations').hidden = false;
  $('#results-caption').hidden = false;
  showIndex(data);
  $('#announcement').textContent = `${data.recommendations.length} models found. ${data.task.capabilities.map(c => c.label).join(', ')}.`;
}
function showIndex(data) {
  $('#index-status').textContent = `${data.degraded ? 'Some sources need attention' : data.stale ? 'Index needs a refresh' : 'Checked'} · ${new Date(data.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${data.refreshStatus === 'failed' ? ' · Refresh failed' : ''}`;
  $('#status-dot').dataset.stale = String(data.stale || data.degraded || data.refreshStatus === 'failed');
  $('#index-counts').textContent = `${data.models} models · ${data.benchmarks} benchmark series`;
  $('#index-counts').title = `${data.benchmarksWithResults} benchmark series have matched results`;
  showSources(data.sources);
  const capabilities = (data.wordCloud ?? []).map(c => ({ ...c, matched: !!data.task?.weights[c.id] }));
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
  $('#results').hidden = false; $('#error').hidden = true; $('#results').setAttribute('aria-busy', 'true'); $('#copy-results').disabled = true;
  result = null; $('#results-title').textContent = 'Searching…'; $('#model-list').replaceChildren(tableMessage('Interpreting task…', $('#model-list').getBoundingClientRect().height));
  $('#capabilities').replaceChildren(); $('#query-time').textContent = ''; $('#limitations').hidden = true; $('#results-caption').hidden = true;
  $('.find-button span').textContent = 'Searching…';
  document.querySelectorAll('[data-example]').forEach(button => button.setAttribute('aria-pressed', String(examples[button.dataset.example] === prompt)));
  const started = performance.now(), timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('/scout/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }), signal: controller.signal });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Scout API is not available on this server. Start the Scout server and try again.');
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Scout could not complete this search.');
    if (id === requestID) showResult(data, performance.now() - started);
  } catch (error) {
    if (id !== requestID) return;
    result = null; $('#model-list').replaceChildren(tableMessage('No results loaded. Try your search again.')); $('#results-title').textContent = 'Search unavailable'; $('#capabilities').replaceChildren(); $('#query-time').textContent = '';
    $('#error').textContent = error.name === 'AbortError' ? 'This request took too long. Please try again.' : error instanceof TypeError ? 'Couldn’t reach Scout. Check the connection and try again.' : error.message; $('#error').hidden = false;
  } finally { clearTimeout(timeout); if (id === requestID) { $('#results').setAttribute('aria-busy', 'false'); $('.find-button span').textContent = 'Find models'; } }
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
$('#scout-form').addEventListener('submit', event => { event.preventDefault(); void search(); });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#scout-form').requestSubmit(); } });
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { $('#prompt').value = examples[button.dataset.example]; fitPrompt(); void search(); }));
$('#copy-results').addEventListener('click', () => { if (result) void copy(JSON.stringify(result, null, 2), $('#copy-results')); });
new ResizeObserver(() => { const table = $('.table-scroll'); $('.table-scroll-hint').hidden = table.scrollWidth <= table.clientWidth + 1; }).observe($('.table-scroll'));
const command = `curl ${location.origin}/scout/api/recommend \\\n  -H 'Content-Type: application/json' \\\n  -d '{"prompt":"Extract six invoice fields as JSON"}'`;
$('#agent-code').textContent = command;
$('#copy-command').addEventListener('click', () => copy(command, $('#copy-command')));
const mcpURL = `${location.origin}/scout/mcp`;
$('#mcp-url').textContent = mcpURL;
$('#copy-mcp').addEventListener('click', () => copy(mcpURL, $('#copy-mcp')));
fetch('/scout/api/status').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => { if (!result) showIndex(data); }).catch(() => { $('#index-status').textContent = 'Could not reach the index. Try a search to reconnect.'; $('#status-dot').dataset.stale = 'true'; });

// Deep links reveal the native disclosure before moving focus to its summary.
function revealSection() {
  if (location.hash !== '#for-agents') return;
  const section = $('#for-agents'); section.open = true; section.querySelector('summary').focus({ preventScroll: true });
}
window.addEventListener('hashchange', revealSection);
document.querySelector('a[href="#for-agents"]').addEventListener('click', () => { $('#for-agents').open = true; });
revealSection();
