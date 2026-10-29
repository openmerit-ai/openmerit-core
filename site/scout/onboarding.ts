// The introduction is presentation, not authorization: agent endpoints still
// verify tokens. Only Clerk's active-session listener enables the real composer.
const STEPS = [
  { figure: '#welcome-note', eyebrow: '', title: ['Scout beta'], description: 'Hello, we’re building Scout, OpenMerit’s model search agent. This is an early beta.', action: 'Continue' },
  { figure: '#welcome-intro', eyebrow: 'OpenMerit’s model search agent', title: ['Find the right AI models', 'for your task.'], description: 'Explore models across leading labs and the Hugging Face Hub, with evidence to guide your choice.', action: 'Continue' },
  { figure: '#welcome-stack', eyebrow: 'Find models. Keep your stack.', title: ['Your Endpoints.', 'Your Preferences.'], description: 'We’re not a router. We don’t sell tokens or sit in your inference runtime. Keep your providers, endpoints and routers. Scout tailors recommendations to the configuration you share.', action: 'Continue' },
  { figure: '#welcome-product', eyebrow: 'Describe your task', title: ['The right model starts', 'with your task.'], description: 'Tell Scout what you’re making. Get model recommendations, with evidence and pricing to help you choose.', action: 'Continue' },
  { figure: '#welcome-claude', eyebrow: 'Scout in Claude Code', title: ['Model search.', 'Inside Claude Code.'], description: 'Connect Scout to Claude Code to bring model recommendations into your project. Available via MCP, API and CLI.', action: 'Get started' },
] as const;

/* ANIMATION STORYBOARD
 *   0ms  copy and preview change together; controls remain usable
 * 220ms  6px copy / 10px preview settle with a restrained ease-out
 * Keyboard and reduced-motion navigation skip movement entirely.
 */
const MOTION = { duration: 220, copyOffset: 6, previewOffset: 10, initialScale: .985, easing: 'cubic-bezier(.23, 1, .32, 1)' };

export function initOnboarding(signIn: () => Promise<void>) {
  const find = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const welcome = find('#onboarding'), app = find('#scout-app'), title = find('#welcome-title');
  const next = find<HTMLButtonElement>('#welcome-next');
  const error = find('#welcome-error');
  const progress = Array.from(welcome.querySelectorAll<HTMLButtonElement>('[data-welcome-step]'));
  let step = 0, furthestStep = 0, signedIn = false, opening = false;
  let animations: Animation[] = [];

  function showStep(value: number, event?: MouseEvent) {
    step = value;
    furthestStep = Math.max(furthestStep, step);
    const current = STEPS[step]!;
    welcome.dataset.step = String(step);
    find('#welcome-eyebrow').textContent = current.eyebrow;
    find('#welcome-eyebrow').hidden = !current.eyebrow;
    title.replaceChildren(...current.title.map(text => { const span = document.createElement('span'); span.textContent = `${text} `; return span; }));
    title.classList.toggle('sr-only', step === 0);
    find('#welcome-description').textContent = current.description;
    find('#welcome-next-label').textContent = current.action;
    STEPS.forEach(({ figure }, index) => { find(figure).hidden = step !== index; });
    error.hidden = true;
    for (const button of progress) {
      button.disabled = Number(button.dataset.welcomeStep) > furthestStep;
      if (Number(button.dataset.welcomeStep) === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    animations.forEach(animation => animation.cancel()); animations = [];
    if (event) {
      find('.welcome-dialog').scrollTop = 0;
      title.focus({ preventScroll: true });
      if (event.detail > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const options = { duration: MOTION.duration, easing: MOTION.easing };
        animations = [
          find('.welcome-copy').animate([{ opacity: .4, transform: `translateY(${MOTION.copyOffset}px)` }, { opacity: 1, transform: 'none' }], options),
          find('.welcome-stage').animate([{ opacity: .4, transform: `translateY(${MOTION.previewOffset}px) scale(${MOTION.initialScale})` }, { opacity: 1, transform: 'none' }], options),
        ];
      }
    }
  }
  async function authenticate() {
    if (opening || signedIn) return;
    opening = true; error.hidden = true;
    next.disabled = true;
    next.setAttribute('aria-busy', 'true');
    try { await signIn(); }
    catch {
      error.textContent = 'Sign-in could not load. Check your connection and try again.';
      error.hidden = false;
    } finally {
      opening = false; next.disabled = false;
      next.removeAttribute('aria-busy');
    }
  }
  next.addEventListener('click', event => { if (step < STEPS.length - 1) showStep(step + 1, event); else void authenticate(); });
  for (const button of progress) button.addEventListener('click', event => showStep(Number(button.dataset.welcomeStep), event));
  document.addEventListener('keydown', event => {
    // Clerk owns focus while its sign-in modal is above this introduction.
    if (event.key !== 'Tab' || welcome.hidden || document.querySelector('.scout-auth-modal')) return;
    const controls = Array.from(welcome.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')).filter(element => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!welcome.contains(document.activeElement) || document.activeElement === title ||
      (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  });
  showStep(step);
  return {
    session(id: string | null) {
      const entering = !!id && !signedIn, showing = !id && welcome.hidden;
      signedIn = !!id;
      welcome.hidden = signedIn;
      app.inert = !signedIn;
      app.removeAttribute('aria-busy');
      find('.skip-link').hidden = !signedIn;
      document.body.classList.toggle('onboarding-active', !signedIn);
      if (entering) find('#prompt').focus({ preventScroll: true });
      if (!id) showStep(step);
      if (showing) title.focus({ preventScroll: true });
    },
  };
}
