// Shared select-only combobox. Focus stays on the trigger; the list is portaled
// outside panels so their overflow cannot clip it. Selection commits explicitly.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chevron = '<svg class="select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>';
const check = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg>';
export function selectControl({ id, label, value, options, disabled = false }) {
  const selected = options.find(option => option.value === value);
  return `<button type="button" id="${escape(id)}" class="select-trigger" role="combobox" aria-label="${escape(label)}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${escape(id)}-options" value="${escape(value)}" data-select-options="${escape(JSON.stringify(options))}" ${disabled ? 'disabled' : ''}><span class="select-value">${escape(selected?.label ?? 'Choose an option')}</span>${chevron}</button>`;
}

let active = null;
export const selectIsOpen = () => active !== null;
export function closeSelect(restoreFocus = false) {
  if (!active) return;
  const { trigger, menu } = active;
  active = null;
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-activedescendant');
  menu.remove();
  if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
}
function highlight(index, scroll = true) {
  if (!active || index < 0 || active.options[index]?.disabled) return;
  active.index = index;
  const rows = [...active.menu.children];
  rows.forEach((row, i) => row.classList.toggle('is-active', i === index));
  active.trigger.setAttribute('aria-activedescendant', rows[index].id);
  if (scroll) rows[index].scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function position() {
  if (!active) return;
  const { trigger, menu } = active, rect = trigger.getBoundingClientRect();
  const margin = 12, gap = 6, below = innerHeight - rect.bottom - margin - gap, above = rect.top - margin - gap;
  const up = below < Math.min(300, menu.scrollHeight) && above > below;
  menu.style.width = `${Math.min(Math.max(rect.width, 250), innerWidth - margin * 2)}px`;
  menu.style.maxHeight = `${Math.max(60, Math.min(340, up ? above : below))}px`;
  menu.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - menu.offsetWidth - margin))}px`;
  menu.style.top = `${up ? Math.max(margin, rect.top - menu.offsetHeight - gap) : rect.bottom + gap}px`;
}
function openSelect(trigger) {
  if (trigger.disabled) return;
  closeSelect();
  const options = JSON.parse(trigger.dataset.selectOptions);
  if (!options.some(option => !option.disabled)) return;
  const menu = document.createElement('div');
  menu.id = trigger.getAttribute('aria-controls');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));
  menu.innerHTML = options.map((option, index) => `<div class="select-option" id="${escape(menu.id)}-${index}" role="option" aria-selected="${option.value === trigger.value}" ${option.disabled ? 'aria-disabled="true"' : ''} data-option-index="${index}"><span>${escape(option.label)}</span>${option.value === trigger.value ? check : '<span class="select-check-space" aria-hidden="true"></span>'}</div>`).join('');
  (trigger.closest('dialog') ?? document.body).append(menu);
  const selected = options.findIndex(option => option.value === trigger.value && !option.disabled);
  active = { trigger, menu, options, index: selected < 0 ? options.findIndex(option => !option.disabled) : selected, query: '', typedAt: 0 };
  trigger.setAttribute('aria-expanded', 'true');
  trigger.focus({ preventScroll: true });
  position(); highlight(active.index);
}
function commit() {
  if (!active) return;
  const { trigger, options, index } = active;
  const value = options[index]?.value;
  if (value === undefined || options[index].disabled) return;
  const changed = trigger.value !== value;
  trigger.value = value;
  trigger.querySelector('.select-value').textContent = options[index].label;
  closeSelect(true);
  if (changed) trigger.dispatchEvent(new Event('change', { bubbles: true }));
}
function move(delta) {
  if (!active) return;
  let index = active.index;
  while (index + delta >= 0 && index + delta < active.options.length) {
    index += delta;
    if (!active.options[index].disabled) { highlight(index); return; }
  }
}
document.addEventListener('pointerdown', event => {
  if (!active) return;
  if (active.menu.contains(event.target)) { if (event.pointerType === 'mouse') event.preventDefault(); return; }
  if (!active.trigger.contains(event.target)) closeSelect();
});
document.addEventListener('click', event => {
  const option = event.target.closest('[data-option-index]');
  if (active && option && active.menu.contains(option)) {
    const index = Number(option.dataset.optionIndex);
    if (!active.options[index].disabled) { highlight(index, false); commit(); }
    return;
  }
  const trigger = event.target.closest('[data-select-options]');
  if (trigger) { if (active?.trigger === trigger) closeSelect(true); else openSelect(trigger); }
});
document.addEventListener('pointermove', event => {
  if (!active || event.pointerType !== 'mouse') return;
  const option = event.target.closest('[data-option-index]');
  if (option && active.menu.contains(option)) highlight(Number(option.dataset.optionIndex), false);
});
document.addEventListener('keydown', event => {
  const trigger = event.target.closest('[data-select-options]');
  if (!trigger || event.metaKey || event.ctrlKey || (event.altKey && !['ArrowDown', 'ArrowUp'].includes(event.key))) return;
  const opened = active?.trigger === trigger;
  if (event.key === 'Tab') { if (opened) commit(); return; }
  if (event.key === 'Escape') { if (opened) { event.preventDefault(); event.stopPropagation(); closeSelect(true); } return; }
  const character = event.key.length === 1 && event.key !== ' ';
  if (!character && !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
  document.body.classList.add('keyboard');
  event.preventDefault(); event.stopPropagation();
  if (!opened) openSelect(trigger);
  if (!active) return;
  if (event.key === 'Enter' || event.key === ' ') { if (opened) commit(); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { active.query = ''; active.typedAt = 0; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (opened) move(event.key === 'ArrowDown' ? 1 : -1); return; }
  if (event.key === 'Home') { highlight(active.options.findIndex(option => !option.disabled)); return; }
  if (event.key === 'End') { highlight(active.options.findLastIndex(option => !option.disabled)); return; }
  if (character) {
    const now = performance.now();
    active.query = now - active.typedAt > 700 ? event.key : active.query + event.key;
    active.typedAt = now;
    const query = active.query.toLocaleLowerCase();
    const repeated = [...query].every(char => char === query[0]);
    const search = repeated ? query[0] : query;
    const start = repeated ? active.index + 1 : active.index;
    for (let step = 0; step < active.options.length; step++) {
      const index = (start + step) % active.options.length, option = active.options[index];
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(search)) { highlight(index); break; }
    }
  }
}, true);
document.addEventListener('focusin', event => { if (active && event.target !== active.trigger && !active.menu.contains(event.target)) closeSelect(); });
document.addEventListener('scroll', event => { if (active && !active.menu.contains(event.target)) closeSelect(); }, true);
window.addEventListener('resize', position);
