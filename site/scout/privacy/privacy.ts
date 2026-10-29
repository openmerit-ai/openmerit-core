import { initAuth } from '../auth.js';
import { analytics } from '../analytics.js';

const usage = document.querySelector<HTMLInputElement>('#analytics-usage')!;
const content = document.querySelector<HTMLInputElement>('#analytics-content')!;
const unlinked = document.querySelector<HTMLInputElement>('#analytics-unlinked')!;
const notice = document.querySelector<HTMLElement>('#beta-data-notice')!;
const status = document.querySelector<HTMLElement>('#analytics-status')!;

function updateAnalyticsControls() {
  const settings = analytics.preferences();
  usage.checked = settings.enabled; usage.disabled = !settings.available;
  content.checked = settings.content; content.disabled = !settings.enabled || !settings.contentAvailable;
  unlinked.checked = !settings.linkAccount; unlinked.disabled = !settings.enabled;
  notice.textContent = settings.content
    ? 'Shared task text has a 30-day retention window. Other analytics may remain longer.'
    : 'Prompt sharing is off. Tasks are still processed to provide the service.';
  status.textContent = !settings.available ? 'Analytics is unavailable or blocked by browser privacy settings.'
    : !settings.contentAvailable ? 'Prompt sharing is unavailable.'
    : settings.contentDefault ? 'Prompt sharing defaults on. Saved opt-outs are respected.'
    : 'Prompt sharing defaults off.';
}

for (const input of [usage, content, unlinked]) input.addEventListener('change', () => analytics.setPreferences(usage.checked, content.checked, !unlinked.checked));
window.addEventListener('scout-analytics-change', updateAnalyticsControls);
updateAnalyticsControls();
initAuth(() => {});
