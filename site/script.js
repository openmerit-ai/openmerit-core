// Scout setup analytics uses the installer's default; no prompt prefix is needed.
const prompt = `Connect OpenMerit Scout to Claude Code.

Run this command with a 10-minute timeout:
npx -y openmerit@latest install --client claude-code

It opens my browser so I can approve this device, then finishes by itself. If it exits with "approval pending", show me the link and code it printed and run the same command again. Don't edit configuration files yourself or ask me for a key. If it reports a conflict or another error, show me its message and stop. When it succeeds, tell me that Scout is connected and I must start a new Claude Code session to load its startup instructions; reconnecting /mcp alone is not enough.`;

const cta = document.querySelector('#add-to-claude');
const status = document.querySelector('#setup-status');
cta.href = `claude://code/new?q=${encodeURIComponent(prompt)}`;

cta.addEventListener('click', async () => {
  // Native link navigation keeps external-app user activation. Start the copy
  // before navigation; clipboard permission must never hold up the handoff.
  status.textContent = 'Claude launch requested. Copying the setup prompt…';
  try {
    await navigator.clipboard.writeText(prompt);
    status.textContent = 'Setup prompt copied. If Claude doesn’t open, paste it into Claude Code.';
  } catch {
    status.textContent = 'Couldn’t copy the setup prompt. Allow clipboard access and try again. The Claude link still includes the prompt.';
  }
});

const readingToggle = document.querySelector('#reading-toggle');
const story = document.querySelector('#letter-story');
const full = document.querySelector('#letter-full');
const short = document.querySelector('#letter-short');
const narrow = matchMedia('(max-width: 600px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out');
let shortened = narrow.matches;
let chosen = false;
let animation;

function showReadingMode() {
  full.hidden = shortened;
  short.hidden = !shortened;
  readingToggle.textContent = shortened ? 'Read full' : 'TL;DR';
  readingToggle.setAttribute('aria-expanded', String(!shortened));
}

showReadingMode();
readingToggle.hidden = false;
narrow.addEventListener('change', () => {
  if (chosen) return;
  shortened = narrow.matches;
  showReadingMode();
});

readingToggle.addEventListener('click', async event => {
  chosen = true;
  shortened = !shortened;
  const opacity = getComputedStyle(story).opacity;
  animation?.cancel();
  // Keyboard and reduced-motion switches are immediate. Fade pointer switches
  // while changing the layout, keeping the shared CTA with the story.
  if (event.detail === 0 || reducedMotion.matches) {
    showReadingMode();
    return;
  }
  animation = story.animate([{ opacity }, { opacity: 0 }], { duration: 100, easing });
  try {
    await animation.finished;
  } catch {
    return; // A newer choice interrupted this switch.
  }
  showReadingMode();
  animation = story.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing });
});
