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
    ? 'Beta: we log shared task text and recommendations to improve Scout. Shared task text has a 30-day retention window. Don’t include confidential data.'
    : 'Task text sharing is off. Our AI processing provider still processes your task to generate recommendations.';
  status.textContent = !settings.available ? 'Analytics is unavailable or disabled by your browser privacy settings.'
    : !settings.contentAvailable ? 'Prompt sharing is not enabled on this deployment.'
    : settings.contentDefault ? 'Beta prompt sharing defaults on unless you previously opted out. Shared task text has a 30-day retention window; recommendation metrics may remain longer.'
    : 'Prompt sharing is optional and off by default on this deployment. Shared task text has a 30-day retention window; recommendation metrics may remain longer.';
}

for (const input of [usage, content, unlinked]) input.addEventListener('change', () => analytics.setPreferences(usage.checked, content.checked, !unlinked.checked));
window.addEventListener('scout-analytics-change', updateAnalyticsControls);
updateAnalyticsControls();
initAuth(() => {});
