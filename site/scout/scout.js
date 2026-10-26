import { providerIdentity } from './providers.js';
import { initAuth } from './auth.js';
import { analytics } from './analytics.js';

const $ = selector => document.querySelector(selector);
const basePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const money = value => value == null ? '—' : `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: value < 1 ? 2 : 0 }).format(value)}`;
let result = null, activeRequest = null, requestID = 0, resultTrace;
let failedSearch, privacyEpoch = 0;

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
  const position = () => ({ rank: model.rank, task_index: taskIndex, trace_id: resultTrace });
  const row = element(steps ? 'td' : 'tr', steps ? 'sequence-cell' : 'model-row'), nameCell = element(steps ? 'div' : 'th', 'model-cell');
  if (!steps) nameCell.scope = 'row';
  const provider = providerIdentity(model), identity = element('span', 'model-identity'), name = element('span'), title = element('span', 'model-title', model.name), byline = element('span', 'model-provider', provider.label);
  const toggle = element('button', 'model-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-label', `Details for ${model.name}${taskTitle ? ` · ${taskTitle}` : ''}`); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${prefix}-model-${model.rank}`);
  if (taskTitle) toggle.title = taskTitle;
  const icon = providerIcon(provider); if (icon) byline.prepend(icon);
  if (model.endpoint) byline.append(document.createTextNode(` · ${model.endpoint.protocol === 'decisions' ? 'Decisions' : model.endpoint.protocol === 'systemone' ? 'System One' : model.endpoint.deployment === 'self-hosted' ? 'Self-hosted' : model.endpoint.provider}`));
  name.append(title, byline);
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
  const detail = element('tr', 'model-detail'), detailCell = element('td', 'model-detail-cell'); detailCell.colSpan = steps || 4; detail.id = `${prefix}-model-${model.rank}`; detail.hidden = true;
  toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; toggle.setAttribute('aria-expanded', String(!detail.hidden)); row.dataset.expanded = String(!detail.hidden); if (!detail.hidden) analytics.track('scout_evidence_opened', position()); });
  // Preserve table semantics and native Enter/Space behavior; any other part of
  // the row activates the same button. Links and buttons keep their own action.
  row.addEventListener('click', event => { if (!event.target.closest('button, a')) toggle.click(); });
  const body = element('div', 'model-evidence');
  if (taskTitle) body.append(element('p', 'price-detail', taskTitle));
  const idLine = element('div', 'model-id-line'), copyID = element('button', '', 'Copy ID'); copyID.type = 'button'; copyID.addEventListener('click', async () => { const epoch = privacyEpoch; if (await copy(model.endpoint?.modelId ?? model.id, copyID) && copyID.isConnected && epoch === privacyEpoch) analytics.track('scout_model_id_copied', position()); });
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
    const followed = event => { if (providerLink.href && (event.type === 'click' || event.button === 1)) analytics.track('scout_provider_opened', position()); };
    providerLink.addEventListener('click', followed); providerLink.addEventListener('auxclick', followed);
    pricing.append(document.createTextNode(' '), providerLink);
  }
  body.append(pricing);
  if (model.speed && !model.measured) { const speed = element('p', 'price-detail'); speed.append(link('Reference timing by Artificial Analysis ↗', model.speed.url), document.createTextNode(` · ${model.speed.configurations.join(', ')}. ${model.speed.historical ? 'Archived reference measurement. ' : ''}Endpoint performance may differ.`)); body.append(speed); }
  detailCell.append(body); detail.append(detailCell); return { row, detail };
}
const tableObserver = new ResizeObserver(entries => {
  for (const {target} of entries) {
    const horizontal = target.scrollWidth > target.clientWidth + 1, vertical = target.scrollHeight > target.clientHeight + 1;
    const hint = target.closest('.result-table').querySelector('.table-scroll-hint');
    hint.hidden = !horizontal && !vertical;
    hint.querySelector('span').textContent = [vertical ? '↕' : '', horizontal ? '↔' : ''].filter(Boolean).join(' ');
  }
});
function resultFeedback(taskCount, candidateCount) {
  const root = element('div', 'result-feedback'), question = element('span', '', 'Was this shortlist useful?');
  const controls = element('div', 'feedback-controls'), useful = element('button', '', 'Useful'), notUseful = element('button', '', 'Not useful');
  const reason = element('select'), send = element('button', '', 'Send feedback'), status = element('span', 'feedback-status');
  reason.setAttribute('aria-label', 'Why was this shortlist not useful?');
  for (const [value, label] of [['', 'Reason (optional)'], ['wrong_task', 'Misunderstood my task'], ['missing_model', 'Missing a model'], ['too_expensive', 'Too expensive'], ['insufficient_evidence', 'Not enough evidence'], ['other', 'Something else']]) {
    const option = element('option', '', label); option.value = value; reason.append(option);
  }
  useful.type = notUseful.type = send.type = 'button'; reason.hidden = send.hidden = true;
  status.setAttribute('role', 'status');
  const epoch = privacyEpoch, trace = resultTrace;
  async function submit(rating) {
    if (epoch !== privacyEpoch || !root.isConnected) return;
    if (!analytics.preferences().enabled) { status.textContent = 'Enable usage analytics in Privacy & analytics to send feedback.'; return; }
    for (const control of [useful, notUseful, reason, send]) control.disabled = true;
    status.textContent = 'Sending…';
    const accepted = await analytics.track('scout_recommendation_feedback', { rating, ...(rating === 'not_useful' && reason.value ? { reason: reason.value } : {}), task_count: taskCount, candidate_count: candidateCount, trace_id: trace });
    if (epoch !== privacyEpoch || !root.isConnected) return;
    status.textContent = accepted ? 'Feedback submitted. Thank you.' : 'Couldn’t send feedback. Please try again.';
    if (accepted) controls.hidden = true;
    else for (const control of [useful, notUseful, reason, send]) control.disabled = false;
  }
  useful.addEventListener('click', () => void submit('useful'));
  notUseful.addEventListener('click', () => { reason.hidden = send.hidden = false; notUseful.setAttribute('aria-expanded', 'true'); reason.focus(); });
  notUseful.setAttribute('aria-expanded', 'false');
  send.addEventListener('click', () => void submit('not_useful'));
  controls.append(useful, notUseful, reason, send); root.append(question, controls, status);
  return root;
}
function showResult(data, roundTripMs) {
  result = data; tableObserver.disconnect();
  const tasks = data.tasks ?? [{title:'Your task',slots:[data]}], count = tasks.reduce((n,t) => n+t.slots.reduce((n,s) => n+s.recommendations.length,0),0);
  $('#results-title').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} · ${count} Model ${count === 1 ? 'Choice' : 'Choices'}`;
  $('#query-time').textContent = `Took ${(roundTripMs / 1000).toFixed(1)}s`;
  $('#query-time').title = 'Elapsed time from submission to response, including authentication, task interpretation and network time';
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
    $('#results-basis').textContent = 'Up to five model choices · quality, cost and latency trade-offs';
    root.querySelector('[data-field="quality-heading"]').replaceChildren(document.createTextNode(profile ? 'Accuracy ' : 'Quality '), element('span', 'column-unit', profile ? 'calibration cases' : slot.ranking?.mode === 'task-fit' ? 'not measured' : 'relative / 100'));
    root.querySelector('[data-field="time-unit"]').textContent = profile ? 'measured seconds' : 'reference seconds';
    for (const model of slot.recommendations) { const entry = modelEntry(model, 'task-1', step.text ?? step.task.title); body.append(entry.row, entry.detail); }
    if (!slot.recommendations.length) body.append(tableMessage(slot.warnings[0] || 'No matching models with verified evidence.'));
  } else {
    root.dataset.sequence = ''; table.className = 'data-table sequence-table'; table.style.setProperty('--steps', steps.length);
    $('#results-basis').hidden = true;
    const header = element('tr');
    steps.forEach((step, i) => { const cell = element('th', 'step-column'); cell.scope = 'col'; cell.append(heading(step, i)); header.append(cell); });
    table.querySelector('thead').replaceChildren(header);
    const rows = Math.max(1, ...steps.map(step => step.data.recommendations.length));
    for (let i = 0; i < rows; i++) {
      const row = element('tr', 'sequence-row'), details = [];
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
  $('#task-results').replaceChildren(root, resultFeedback(tasks.length, count));
  tableObserver.observe(root.querySelector('.table-scroll'));
  showIndex(data);
  $('#announcement').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}. ${count} model ${count === 1 ? 'choice' : 'choices'}.`;
  analytics.track('scout_results_viewed', { task_count: tasks.length, candidate_count: count, duration_ms: Math.round(roundTripMs), trace_id: resultTrace });
}
function showIndex(data) {
  $('#index-counts').replaceChildren(...[`${data.availableModels ?? data.models} API models`, `${data.specialistRepositories ?? 0} HF repositories`, `${data.benchmarks} benchmark series`, `${data.sources.length} sources`].map(text => element('span', '', text)));
  $('#index-counts').title = `${data.benchmarksWithResults} benchmark series have matched results · ${data.endpoints ?? data.models} hosted endpoints · ${data.independentModels ?? 0} models with independent provider metadata · ${data.specialistRepositories ?? 0} specialist repositories`;
}
async function search() {
  const prompt = $('#prompt').value.trim(); if (!prompt) { $('#error').textContent = 'Describe the task you want a model to do.'; $('#error').hidden = false; $('#prompt').focus(); return; }
  activeRequest?.abort(); const controller = new AbortController(); activeRequest = controller; const id = ++requestID;
  const started = performance.now();
  $('#results').hidden = false; $('#error').hidden = true; $('#results').setAttribute('aria-busy', 'true');
  result = null; tableObserver.disconnect(); $('#results-title').textContent = 'Finding model choices';
  const loading = element('div', 'search-state'), status = element('p', 'search-status', 'Preparing your search');
  status.setAttribute('role', 'status');
  const context = element('p', 'search-context', prompt); context.title = prompt;
  loading.append(status, context); $('#task-results').replaceChildren(loading);
  $('#query-time').textContent = '0.0s elapsed'; $('#query-time').title = 'Live elapsed time since submission'; $('#results-basis').hidden = true;
  $('#announcement').textContent = 'Finding model choices for your task.';
  $('.find-button span').textContent = 'Searching…'; $('.find-button').setAttribute('aria-busy', 'true');
  const messages = ['Matching models to your requirements', 'Considering quality, cost and speed', 'Looking for supporting model evidence'];
  let authenticated = false, lastMessage = '', timeout, epoch = privacyEpoch, traceId, httpStatus, failureCode = 'auth_unavailable';
  const updateProgress = () => {
    const elapsed = performance.now() - started;
    $('#query-time').textContent = `${(elapsed / 1000).toFixed(1)}s elapsed`;
    // These are rotating search perspectives, not reported backend stages.
    const message = authenticated ? messages[Math.floor(elapsed / 4000) % messages.length] : 'Preparing your search';
    if (message === lastMessage) return;
    status.textContent = message;
    if (lastMessage && !matchMedia('(prefers-reduced-motion: reduce)').matches) status.animate(
      [{ opacity: .4, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
    lastMessage = message;
  };
  updateProgress();
  const progress = setInterval(updateProgress, 250);
  controller.signal.addEventListener('abort', () => clearInterval(progress), { once: true });
  try {
    const token = await auth.getToken();
    if (id !== requestID) return;
    if (!token) { $('#results').hidden = true; $('#query-time').textContent = ''; return; }
    authenticated = true; updateProgress();
    timeout = setTimeout(() => controller.abort(), 35_000);
    epoch = privacyEpoch;
    const settings = analytics.preferences(), headers = analytics.headers();
    traceId = settings.enabled && settings.linkAccount ? crypto.randomUUID() : undefined;
    if (traceId) headers['X-Scout-Trace-Id'] = traceId;
    // Retry attribution compares only this tab's failed draft, in memory.
    if (traceId && failedSearch?.prompt === prompt && Date.now() - failedSearch.at < 300000) headers['X-Scout-Retry-Of'] = failedSearch.trace;
    failedSearch = undefined;
    analytics.webInteraction('search_submit');
    failureCode = 'network_error';
    const response = await fetch(`${basePath}/api/recommend`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ prompt }), signal: controller.signal });
    if (id !== requestID) return;
    const receivedTrace = response.headers.get('x-scout-trace-id');
    if (traceId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receivedTrace)) traceId = receivedTrace;
    httpStatus = response.status; failureCode = response.ok ? 'invalid_response' : 'http_error';
    if (response.status === 401) { await auth.signIn(); throw new Error('Your session has expired. Sign in and try again.'); }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Scout API is not available on this server. Start the Scout server and try again.');
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Scout could not complete this search.');
    failureCode = 'render_error';
    if (id === requestID) { resultTrace = epoch === privacyEpoch ? traceId : undefined; showResult(data, performance.now() - started); }
  } catch (error) {
    if (id !== requestID) return;
    if (epoch !== privacyEpoch) traceId = undefined;
    if (traceId) failedSearch = { prompt, trace: traceId, at: Date.now() };
    analytics.exception(error, error.name === 'AbortError' ? 'search_timeout' : failureCode, { trace_id: traceId, duration_ms: Math.round(performance.now() - started), ...(httpStatus >= 400 ? { http_status: httpStatus } : {}) });
    result = null; tableObserver.disconnect(); $('#task-results').replaceChildren(); $('#results-title').textContent = 'Search unavailable'; $('#query-time').textContent = '';
    $('#error').textContent = error.name === 'AbortError' ? 'This request took too long. Please try again.' : error instanceof TypeError ? 'Couldn’t reach Scout. Check the connection and try again.' : error.message; $('#error').hidden = false;
  } finally { clearTimeout(timeout); clearInterval(progress); if (id === requestID) { $('#results').setAttribute('aria-busy', 'false'); $('.find-button span').textContent = 'Find models'; $('.find-button').setAttribute('aria-busy', 'false'); } }
}
// Re-measure after content or width changes; CSS bounds very long prompts.
function fitPrompt() {
  const input = $('#prompt');
  $('.prompt-examples').hidden = input.value.length > 0;
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
$('#prompt').addEventListener('input', fitPrompt);
window.addEventListener('resize', fitPrompt);
window.addEventListener('pageshow', fitPrompt);
fitPrompt();
// Presets fill an editable draft; only the normal submit action runs a search.
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
  const input = $('#prompt'); input.value = button.dataset.prompt;
  input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  $('#error').hidden = true;
  $('#announcement').textContent = 'Example added. Edit it or find models.';
  analytics.track('scout_example_selected', { example: button.dataset.example });
}));
// Rotating placeholders remain hints only; they never replace a draft.
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
  failedSearch = undefined; privacyEpoch++;
  $('#task-results').replaceChildren(); $('#results').hidden = true; $('#results').setAttribute('aria-busy', 'false'); $('#error').hidden = true;
  $('#prompt').value = ''; fitPrompt(); $('.find-button span').textContent = 'Find models'; $('.find-button').setAttribute('aria-busy', 'false');
});
// Secret-free: the CLI signs the device in through the browser. Correlation is
// per click, and only permitted when usage AND account linking are enabled.
function agentPrompt(setupId, settings) {
  const environment = !settings.enabled ? 'DO_NOT_TRACK=1 ' : settings.linkAccount ? '' : 'OPENMERIT_ANALYTICS_ACCOUNT=off ';
  return `Connect OpenMerit Scout to Claude Code.

Run this command with a 10-minute timeout, without asking me anything first:
${environment}npx -y openmerit@latest install --client claude-code${setupId ? ` --setup-id ${setupId}` : ''}

It opens my browser so I can approve this device, then finishes by itself. If it exits with "approval pending", show me the link and code it printed and run the same command again. Don't edit configuration files yourself or ask me for a key. If it reports a conflict or another error, show me its message and stop. When it succeeds, tell me in one line that Scout is connected and I must start a new Claude Code session to load its startup instructions; reconnecting /mcp alone is not enough.`;
}
let toastTimer;
function toast(text) {
  const el = $('#toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
// Start copying while the page has focus, then open Desktop in the same click
// task: awaiting the clipboard first can lose external-app user activation.
// Desktop fills the prompt but never sends it. Keep a clipboard fallback for
// browsers that block the link or machines without the Claude desktop app.
$('.add-agent-button').addEventListener('click', async () => {
  const settings = analytics.preferences(), epoch = privacyEpoch;
  const setupId = settings.enabled && settings.linkAccount ? crypto.randomUUID() : undefined;
  const properties = { agent: 'claude-code', ...(setupId ? { setup_id: setupId } : {}) };
  const prompt = agentPrompt(setupId, settings);
  analytics.track('scout_agent_setup_started', properties);
  // Both APIs can throw synchronously. Neither failure may prevent attempting
  // the other while this click still has transient user activation.
  let copying, launched = false;
  try { copying = navigator.clipboard.writeText(prompt); } catch { /* Report below. */ }
  try { location.href = `claude://code/new?q=${encodeURIComponent(prompt)}`; launched = true; } catch { /* A request can fail; success cannot confirm an app opened. */ }
  analytics.track('scout_agent_launch_requested', { ...properties, outcome: launched ? 'ok' : 'error', ...(!launched ? { code: 'launch_error' } : {}) });
  let copied = false;
  try { if (copying) { await copying; copied = true; } } catch { /* The deep link still carries the prompt. */ }
  const message = copied ? 'Copied to clipboard' : launched ? 'Claude launch requested' : 'Couldn’t copy or request Claude. Please try again.';
  toast(message); $('#announcement').textContent = message;
  const current = analytics.preferences();
  if (epoch === privacyEpoch && current.enabled === settings.enabled && current.linkAccount === settings.linkAccount) analytics.track('scout_agent_setup_copied', { ...properties, outcome: copied ? 'ok' : 'error', ...(!copied ? { code: 'clipboard_error' } : {}) });
});
fetch(`${basePath}/api/status`).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => { if (!result) showIndex(data); }).catch(() => { if (!result) { $('#index-counts').textContent = 'Index unavailable'; } });

if (location.hash === '#analytics-settings') location.replace('/scout/privacy/');
window.addEventListener('scout-analytics-change', () => {
  privacyEpoch++; failedSearch = undefined; resultTrace = undefined;
  // Existing result closures must not carry an earlier identity into feedback.
  document.querySelector('.result-feedback')?.remove();
});
