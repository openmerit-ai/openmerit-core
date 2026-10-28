// Scout's page: one conversation with the Scout agent (scout/agent/).
// A turn is one POST that can run for minutes; the page polls the same
// conversation for progress meanwhile, and reads the answer from it if the POST
// connection drops before the turn ends.
import { initAuth } from './auth.js';
import { providerIdentity } from './providers.js';
import type { Brief, Component, RecommendedModel, Recommendation } from '../../scout/agent/recommendation.ts';
import type { Answer } from '../../scout/agent/tools.ts';
import type { AgentState, BriefEdits, TurnAnswer, TurnRequest } from '../../scout/agent/turn.ts';

type Clarification = Extract<Answer, { kind: 'clarification' }>;
type Question = Clarification['questions'][number];
type Reply = AgentState & { conversationId?: string; error?: string };

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const api = `${new URL('.', import.meta.url).pathname.replace(/\/$/, '')}/api/agent`;
const conversationList = $<HTMLOListElement>('#conversation'), composer = $<HTMLFormElement>('#composer'), prompt = $<HTMLTextAreaElement>('#prompt');
const errorBox = $('#error'), announcement = $('#announcement');
const componentLabels: Record<Component, string> = { input: 'Input', work: 'Work', output: 'Output', criteria: 'Criteria', constraints: 'Constraints' };
const pollMs = 3000, turnLimitMs = 8 * 60_000, firstPlaceholder = prompt.placeholder;

let conversationId: string | null = null, working = false, epoch = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
const money = (usd: number) => `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: usd < 0.1 ? 3 : 2 }).format(usd)}`;
// Catalogue dates are calendar days (YYYY-MM-DD); format in UTC so no time zone shifts them. 2026-10-25 → Oct 25, 2026.
const releaseDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function age(days: number): string {
  if (days < 45) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30.4);
  return months < 18 ? `${months} months ago` : `${(days / 365).toFixed(1)} years ago`;
}
function showError(message: string) { errorBox.textContent = message; errorBox.hidden = !message; }
function scrollIntoView(node: Element) { node.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
function entry(role: 'user' | 'scout'): HTMLLIElement {
  const item = element('li', `turn turn-${role}`);
  item.append(element('span', 'turn-role', role === 'user' ? 'You' : 'Scout'));
  conversationList.append(item);
  return item;
}

// The task brief as a form: each component is edited in place, and Scout's
// questions sit under the component they would change. Only components the
// user changed are sent.
function briefForm(brief: Brief, questions: Question[], onSend: (edits: BriefEdits, skip: boolean) => void): HTMLFormElement {
  const form = element('form', 'brief-form'), list = element('dl', 'brief brief-editable');
  const prefix = `b-${epoch}-${conversationList.children.length}`, fields = new Map<Component, HTMLTextAreaElement>();
  for (const key of Object.keys(componentLabels) as Component[]) {
    const part = brief[key], row = element('div', 'brief-row'), badge = element('span');
    const term = element('dt'), label = element('label', '', componentLabels[key]); label.htmlFor = `${prefix}-${key}`;
    term.append(label, badge);
    const field = element('textarea', 'brief-field'); field.id = label.htmlFor; field.rows = 1; field.maxLength = 1000; field.value = part.text;
    field.placeholder = 'Not known yet. Add it here.';
    const value = element('dd'); value.append(field);
    const asked = questions.filter(q => q.component === key);
    asked.forEach((q, i) => {
      const box = element('div', 'brief-question'), text = element('p', 'brief-question-text', q.question); text.id = `${prefix}-${key}-${i}`;
      box.append(text);
      value.append(box);
    });
    if (asked.length) { row.classList.add('brief-asked'); field.setAttribute('aria-describedby', asked.map((_, i) => `${prefix}-${key}-${i}`).join(' ')); }
    const sync = () => {
      fit(field);
      const source = field.value.trim() === part.text.trim() ? part.source : 'edited';
      badge.className = `brief-source brief-${source}`; badge.textContent = source;
    };
    field.addEventListener('input', sync);
    field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    // Heights can only be measured once the form is on the page.
    requestAnimationFrame(sync); sync();
    row.append(term, value); list.append(row); fields.set(key, field);
  }
  const actions = element('div', 'question-actions'), send = element('button', 'primary-button', 'Continue'); send.type = 'submit';
  actions.append(send);
  form.append(list, actions);
  const edits = (): BriefEdits => Object.fromEntries([...fields].filter(([key, f]) => f.value.trim() !== brief[key].text.trim()).map(([key, f]) => [key, f.value.trim()]));
  const submit = (skip: boolean) => {
    if (working) return;
    const changed = edits();
    if (!skip && !Object.keys(changed).length) { showError('Edit the brief, or skip the questions.'); fields.values().next().value?.focus(); return; }
    onSend(changed, skip);
  };
  form.addEventListener('submit', event => { event.preventDefault(); submit(false); });
  const skip = element('button', 'secondary-button', 'Skip questions'); skip.type = 'button';
  skip.addEventListener('click', () => submit(true));
  actions.append(skip, element('span', 'question-hint', 'Skipping lets Scout recommend now with stated assumptions.'));
  return form;
}
// What the user said, as their side of the conversation.
function describeEdits(edits: BriefEdits, skip: boolean): string {
  const lines = (Object.keys(componentLabels) as Component[]).filter(key => key in edits).map(key => `${componentLabels[key]}: ${edits[key] || 'none'}`);
  if (skip) lines.push(lines.length ? 'Skip the remaining questions.' : 'Skipped the questions.');
  return lines.join('\n');
}
const sendEdits = (brief: BriefEdits, skip: boolean) => { void runTurn({ brief, skip }, describeEdits(brief, skip)); };

function clarificationView(answer: Clarification, item: HTMLLIElement) {
  // Open while the user edits; collapses to one line once they send it (see runTurn).
  const box = element('details', 'brief-turn'); box.open = true;
  box.append(element('summary', '', 'Task brief and questions'),
    element('p', 'turn-text', 'Here is what I understood. Correct anything in place. Answering the questions under a part would change which models I recommend.'),
    briefForm(answer.brief, answer.questions, sendEdits));
  item.append(box);
  requestAnimationFrame(() => item.querySelector<HTMLTextAreaElement>('.brief-asked .brief-field')?.focus({ preventScroll: true }));
}

function metricCell(value: string | null, title: string): HTMLTableCellElement {
  const cell = element('td', 'metric-cell'); cell.title = title;
  cell.append(element('span', value ? '' : 'metric-unavailable', value ?? 'unknown'));
  return cell;
}
function modelRows(model: RecommendedModel, prefix: string): HTMLTableRowElement[] {
  const row = element('tr', 'model-row'), name = element('th', 'model-cell'); name.scope = 'row';
  const provider = providerIdentity(model), toggle = element('button', 'model-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${prefix}-${model.rank}`);
  toggle.setAttribute('aria-label', `Details for ${model.name}`);
  const identity = element('span', 'model-identity'), text = element('span'), byline = element('span', 'model-provider', provider.label);
  if (provider.file) {
    const icon = element('img', `provider-icon${provider.invertOnDark ? ' provider-icon-monochrome' : ''}`); icon.alt = ''; icon.width = icon.height = 13;
    icon.setAttribute('aria-hidden', 'true'); icon.addEventListener('error', () => icon.remove()); icon.src = `/scout/providers/${provider.file}`; byline.prepend(icon);
  }
  text.append(element('span', 'model-title', model.name), byline);
  identity.append(text); toggle.append(identity); name.append(toggle);
  row.append(name,
    metricCell(String(model.quality.score), 'Scout’s estimate for this task from the cited benchmark standings, out of 100. Not measured accuracy.'),
    // Per-token list prices on the model's cheapest eligible route.
    metricCell(model.cost ? money(model.cost.inputPerMillion) : null, model.cost ? `Input price via ${model.cost.route}.` : 'No eligible priced route.'),
    metricCell(model.cost ? money(model.cost.outputPerMillion) : null, model.cost ? `Output price via ${model.cost.route}.` : 'No eligible priced route.'),
    metricCell(model.recency ? releaseDate(model.recency.released) : null, model.recency ? `Released ${age(model.recency.ageDays)}.` : 'Release date not recorded.'));
  const detail = element('tr', 'model-detail'), cell = element('td', 'model-detail-cell'); cell.colSpan = 5; detail.id = `${prefix}-${model.rank}`; detail.hidden = true;
  const body = element('div', 'model-evidence');
  body.append(element('p', 'model-rationale', model.rationale));
  if (model.watchOut) body.append(element('p', 'model-watch', `Watch out: ${model.watchOut}`));
  const idLine = element('div', 'model-id-line'), copy = element('button', '', 'Copy ID'); copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(model.id); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
    setTimeout(() => { copy.textContent = 'Copy ID'; }, 1800);
  });
  idLine.append(element('code', '', model.id), copy); body.append(idLine);
  if (model.quality.evidence.length) {
    const grid = element('div', 'evidence-grid');
    for (const e of model.quality.evidence) {
      const item = element('div', 'evidence-item');
      item.append(element('span', 'evidence-name', e.name), element('span', '', e.rank ? `#${e.rank} of ${e.of}` : '—'));
      grid.append(item);
    }
    body.append(grid);
  } else body.append(element('p', 'price-detail', 'No benchmark results cited; the quality estimate is Scout’s judgement.'));
  if (model.cost) body.append(element('p', 'price-detail', `Prices are for ${model.cost.route}, the cheapest eligible route.`));
  if (model.latency) body.append(element('p', 'price-detail', `${model.latency.firstTokenSeconds.toFixed(1)}s to first token, ${model.latency.tokensPerSecond} tokens per second${model.latency.source ? ` (${model.latency.source})` : ''}. Endpoint performance may differ.`));
  cell.append(body); detail.append(cell);
  toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; toggle.setAttribute('aria-expanded', String(!detail.hidden)); row.dataset.expanded = String(!detail.hidden); });
  row.addEventListener('click', event => { if (!(event.target as Element).closest('button, a')) toggle.click(); });
  return [row, detail];
}
function recommendationView(answer: Recommendation, item: HTMLLIElement) {
  const table = element('table', 'data-table model-table agent-table'), head = element('thead'), header = element('tr');
  for (const [label, unit] of [['Model', ''], ['Quality', 'estimate / 100'], ['Input', '$ / 1M tokens'], ['Output', '$ / 1M tokens'], ['Released', 'recency']] as const) {
    const th = element('th', label === 'Model' ? 'model-column' : 'numeric-column', label); th.scope = 'col';
    if (unit) th.append(element('span', 'column-unit', unit));
    header.append(th);
  }
  head.append(header); table.append(element('caption', 'sr-only', 'Five recommended models, best overall first. Expand a model for its rationale and evidence.'), head);
  const body = element('tbody'), prefix = `m-${epoch}-${conversationList.children.length}`;
  for (const model of answer.models) body.append(...modelRows(model, prefix));
  table.append(body);
  const scroll = element('div', 'table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Model comparison');
  scroll.append(table);
  const frame = element('div', 'table-frame'); frame.append(scroll);
  const hint = element('p', 'table-scroll-hint agent-scroll-hint'); hint.append('Scroll to compare ', element('span', '', '↔'));
  item.append(frame, hint, element('p', 'turn-text', answer.summary), element('p', 'results-warning', 'Results could be wrong. Please verify before choosing a model.'));
}
function answerView(answer: TurnAnswer | null, item: HTMLLIElement) {
  item.classList.remove('turn-working'); item.removeAttribute('aria-busy');
  if (!answer) { item.append(element('p', 'turn-error', 'Scout could not finish this turn. Please try again.')); return; }
  if (answer.kind === 'clarification') clarificationView(answer, item);
  else if (answer.kind === 'recommendation') recommendationView(answer, item);
  else if (answer.kind === 'message') item.append(element('p', 'turn-text', answer.text));
  else item.append(element('p', 'turn-error', answer.message));
}

function progressView(item: HTMLLIElement) {
  const box = element('details', 'progress'), summary = element('summary'), steps = element('ol', 'progress-steps');
  const current = element('div', 'progress-current'), status = element('p', 'progress-status', 'Reading your request'), time = element('span', 'query-time');
  box.open = true; status.setAttribute('role', 'status'); current.append(status, time);
  box.append(summary, steps, current); item.append(box);
  const started = performance.now(), elapsed = () => Math.round((performance.now() - started) / 1000);
  // Seconds and milliseconds, redrawn every frame, so the wait visibly moves. 12s 045ms keeps a fixed width.
  let timer = 0;
  const tick = () => {
    const ms = Math.floor(performance.now() - started);
    time.textContent = `${Math.floor(ms / 1000)}s ${String(ms % 1000).padStart(3, '0')}ms`;
    timer = requestAnimationFrame(tick);
  };
  tick();
  let last: string[] = [];
  return {
    // Finished steps above, the step in progress last.
    update(progress: string[]) {
      if (progress.length === last.length) return;
      last = progress;
      steps.replaceChildren(...progress.slice(0, -1).map(step => element('li', '', step)));
      status.textContent = progress.at(-1) ?? 'Reading your request';
    },
    stop() { cancelAnimationFrame(timer); },
    // Once the turn ends every step is done; keep them as a collapsed record of the work.
    finish(progress = last) {
      current.remove();
      if (!progress.length) { box.remove(); return; }
      steps.replaceChildren(...progress.map(step => element('li', '', step)));
      summary.textContent = `Worked for ${elapsed()}s · ${progress.length} ${progress.length === 1 ? 'step' : 'steps'}`;
      box.classList.add('progress-done'); box.open = false;
    },
  };
}

async function request(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: Reply }> {
  const response = await fetch(`${api}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Scout agent is not available on this server.');
  return { status: response.status, data: await response.json() as Reply };
}

// Signed-out users are sent to sign in first; onStart runs only once the turn really starts.
async function runTurn(turn: TurnRequest, said: string, onStart?: () => void) {
  if (working) return;
  const token = await auth.getToken();
  if (!token || working) return;
  onStart?.();
  const first = conversationId === null, id = conversationId ?? crypto.randomUUID(), turnEpoch = epoch;
  working = true; showError(''); setComposer();
  // Only the latest answer's brief can be edited; earlier ones are history.
  conversationList.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>('.brief-form :is(textarea, button)').forEach(control => { control.disabled = true; });
  conversationList.querySelectorAll<HTMLDetailsElement>('.brief-turn:not(.brief-sent)').forEach(box => { box.classList.add('brief-sent'); box.open = false; });
  const mine = entry('user'); mine.append(element('p', 'turn-text', said));
  const scout = entry('scout'); scout.classList.add('turn-working'); scout.setAttribute('aria-busy', 'true');
  const progress = progressView(scout); scrollIntoView(scout);
  announcement.textContent = 'Scout is working on your request.';
  let finished: Reply | null = null, failure: string | null = null, posting = true;
  const post = request(token, 'POST', '', { ...turn, conversationId: id })
    .then(({ status, data }) => {
      if (status === 401) failure = 'Your session has expired. Sign in and try again.';
      else if (status === 200) finished = data;
      // 503 and dropped connections leave the turn running; polling reads its outcome.
      else if (status !== 503 && status !== 409) failure = data.error ?? 'Scout could not finish this turn.';
    })
    .catch((error: unknown) => { if (!(error instanceof TypeError)) failure = (error as Error).message; })
    .finally(() => { posting = false; });
  conversationId = id;
  const started = Date.now();
  let sawTurn = false;
  while (!finished && !failure && turnEpoch === epoch) {
    await Promise.race([post, new Promise(resolve => setTimeout(resolve, pollMs))]);
    if (finished || failure || turnEpoch !== epoch) break;
    try {
      const { status, data } = await request(token, 'GET', `/${id}`);
      if (status === 200) {
        sawTurn = true; progress.update(data.progress);
        if (!data.busy && !posting && data.answer) finished = data;
      } else if (status !== 429 && (status !== 404 || !posting)) failure = data.error ?? 'Scout could not finish this turn.'; // 429: a rate-limited poll counts as missed.
    } catch { /* A missed poll is retried; the POST may still succeed. */ }
    if (!posting && !finished && !failure && !sawTurn) failure = 'Couldn’t reach Scout. Check the connection and try again.';
    if (Date.now() - started > turnLimitMs) failure = 'This turn took too long. Please try again.';
  }
  progress.stop();
  if (turnEpoch !== epoch) return;
  working = false;
  const reply = finished as Reply | null;
  progress.finish(reply?.progress);
  if (reply) answerView(reply.answer, scout);
  else {
    answerView({ kind: 'error', message: failure ?? 'Scout could not finish this turn.' }, scout);
    // A first turn that never started leaves nothing to continue.
    if (first && !sawTurn) conversationId = null;
  }
  announcement.textContent = reply?.answer?.kind === 'clarification' ? 'Scout has questions about your task.' : reply?.answer?.kind === 'recommendation' ? 'Scout recommended five models.' : 'Scout replied.';
  setComposer();
  scrollIntoView(scout.querySelector('.turn-text') ?? scout);
}

function setComposer() {
  const started = conversationId !== null;
  $('#new-conversation').hidden = !started;
  $('#prompt-label').textContent = started ? 'Reply to Scout' : 'Describe your work';
  prompt.placeholder = started ? 'Add details, change a constraint, or ask for different trade-offs.' : firstPlaceholder;
  prompt.disabled = working;
  composer.querySelector<HTMLButtonElement>('.find-button')!.setAttribute('aria-busy', String(working));
}
// Grow a text box to its content. A box that is not displayed yet keeps its natural height until it is.
function fit(area: HTMLTextAreaElement) { area.style.height = 'auto'; if (area.scrollHeight) area.style.height = `${area.scrollHeight}px`; }
addEventListener('resize', () => conversationList.querySelectorAll<HTMLTextAreaElement>('.brief-field').forEach(fit));
const fitPrompt = () => fit(prompt);

composer.addEventListener('submit', event => {
  event.preventDefault();
  const message = prompt.value.trim();
  if (!message) { showError('Describe the work you want a model to do.'); prompt.focus(); return; }
  if (working) return;
  // The message stays in the box until the turn starts, so sign-in can keep it as a draft.
  void runTurn({ message }, message, () => { prompt.value = ''; fitPrompt(); });
});
prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } });
prompt.addEventListener('input', fitPrompt);
$('#new-conversation').addEventListener('click', () => reset());
function reset() {
  epoch++; conversationId = null; working = false;
  conversationList.replaceChildren(); showError(''); setComposer(); prompt.focus();
}
const auth = initAuth(reset);
fitPrompt();
