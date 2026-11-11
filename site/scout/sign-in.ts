// Clerk sign-in for openmerit.ai. ClerkJS and its UI load from the instance's
// frontend API; the Worker verifies each session token at /scout/api/session.
interface ClerkSession { status: string; getToken(): Promise<string | null> }
interface ClerkUser { id: string; primaryEmailAddress?: { emailAddress: string } | null }
interface Clerk {
  session?: ClerkSession | null;
  load(options: Record<string, unknown>): Promise<void>;
  addListener(listener: (state: { user?: ClerkUser | null; session?: ClerkSession | null }) => void): void;
  openSignIn(options: Record<string, unknown>): void;
  closeSignIn(): void;
  mountUserButton(element: HTMLElement): void;
  unmountUserButton(element: HTMLElement): void;
}
declare global { interface Window { Clerk?: Clerk; __internal_ClerkUICtor?: unknown } }

const api = `${new URL('.', import.meta.url).pathname.replace(/\/$/, '')}/api`;
const unavailable = 'Sign-in could not load. Check your connection and reload this page to try again.';

function deadline<T>(operation: Promise<T>, message: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function loadScript(src: string, publishableKey?: string): Promise<void> {
  return deadline(new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(unavailable)); };
    document.head.append(script);
  }), unavailable);
}

// openSignIn returns before Clerk's lazy UI renders. A modal shell alone does
// not mean its provider buttons loaded; observe public appearance classes.
async function openSignIn(clerk: Clerk, returnUrl: string): Promise<void> {
  let observer: MutationObserver | undefined, shown = false;
  const ready = new Promise<void>((resolve, reject) => {
    const check = () => {
      const modal = document.querySelector('.sign-in-modal');
      if (document.querySelector('.sign-in-ready')) resolve();
      else if (shown && !modal) reject(new Error(unavailable));
      shown ||= !!modal;
    };
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, appearance: { elements: { card: 'sign-in-ready', modalBackdrop: 'sign-in-modal' } } });
    check();
  });
  try { await deadline(ready, unavailable, 30_000); }
  catch (error) { clerk.closeSignIn(); throw error; }
  finally { observer?.disconnect(); }
}

const button = document.querySelector<HTMLButtonElement>('#sign-in')!;
const account = document.querySelector<HTMLElement>('#user-account')!;
const status = document.querySelector<HTMLElement>('#sign-in-status')!;
const error = document.querySelector<HTMLElement>('#sign-in-error')!;
const returnUrl = `${location.origin}${location.pathname}`;
const showError = (message: string) => { error.textContent = message; error.hidden = false; };
let loading: Promise<Clerk> | null = null, mounted = false, epoch = 0;

// The page says "signed in" only after the Worker has verified the session.
async function confirm(session: ClerkSession, user: ClerkUser, current: number) {
  try {
    const token = await session.getToken();
    const response = await fetch(`${api}/session`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
    if (current !== epoch) return;
    if (!response.ok) throw new Error('Your session could not be verified. Please sign in again.');
    status.textContent = `Signed in as ${user.primaryEmailAddress?.emailAddress ?? 'your OpenMerit account'}.`;
  } catch (failure) {
    if (current === epoch) showError(failure instanceof Error ? failure.message : unavailable);
  }
}

function client(): Promise<Clerk> {
  loading ??= (async () => {
    const response = await fetch(`${api}/auth`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again later.');
    const { publishableKey, frontendApi } = await response.json() as { publishableKey: string; frontendApi: string };
    await Promise.all([
      window.__internal_ClerkUICtor || loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
      window.Clerk || loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
    ]);
    const clerk = window.Clerk!;
    await deadline(clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      telemetry: false,
      signInForceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, afterSignOutUrl: returnUrl,
      appearance: {
        variables: { fontFamily: 'var(--sans)', colorPrimary: 'var(--ink)', colorPrimaryForeground: 'var(--paper)', colorBackground: 'var(--surface)', colorForeground: 'var(--ink)', colorMutedForeground: 'var(--muted)', colorInputForeground: 'var(--ink)', colorBorder: 'var(--line)', borderRadius: '6px' },
        layout: { socialButtonsVariant: 'blockButton', socialButtonsPlacement: 'top' },
      },
    }), 'Sign-in took too long. Please try again.');
    clerk.addListener(({ user, session }) => {
      const active = session?.status === 'active' && user ? { session, user } : null;
      const current = ++epoch;
      button.hidden = !!active; account.hidden = !active; error.hidden = true;
      if (active && !mounted) { clerk.mountUserButton(account); mounted = true; }
      if (!active && mounted) { clerk.unmountUserButton(account); mounted = false; }
      if (active) { status.textContent = 'Checking your session…'; void confirm(active.session, active.user, current); }
      else status.textContent = 'Sign in to your OpenMerit account.';
    });
    return clerk;
  })().catch(() => {
    loading = null;
    throw new Error(unavailable);
  });
  return loading;
}

button.addEventListener('click', async () => {
  button.disabled = true; error.hidden = true;
  try { await openSignIn(await client(), returnUrl); }
  catch (failure) { showError(failure instanceof Error ? failure.message : unavailable); }
  finally { button.disabled = false; }
});
// Restore an existing session without waiting for a click.
void client().catch(() => {});

export {};
