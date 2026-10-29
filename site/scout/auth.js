// Optional analytics must not prevent the sign-in module from evaluating.
let analytics, analyticsConfig, analyticsAccount;
void import('./analytics.js').then(module => {
  analytics = module.analytics;
  if (analyticsConfig) analytics.configure(...analyticsConfig);
  if (analyticsAccount) analytics.account(...analyticsAccount);
}).catch(() => { /* Authentication works even when analytics is blocked. */ });

const basePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const draftKey = 'scout-sign-in-draft';
const submissionKey = 'scout-sign-in-submission';

function deadline(operation, message, milliseconds = 15_000) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    const timeout = setTimeout(() => { script.remove(); reject(new Error('Sign-in could not load. Please try again.')); }, 15_000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Sign-in could not load. Please try again.')); };
    document.head.append(script);
  });
}

// openSignIn returns before Clerk's lazy UI renders. A modal shell alone does
// not mean its provider buttons loaded; observe public appearance classes.
async function openSignIn(clerk, options) {
  const message = 'Sign-in could not load. Check your connection and reload this page to try again.';
  let observer, shown = false;
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      const modal = document.querySelector('.scout-auth-modal');
      if (document.querySelector('.scout-auth-ready')) resolve();
      else if (shown && !modal) reject(new Error(message));
      shown ||= !!modal;
    };
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    clerk.openSignIn({ ...options, appearance: { elements: { card: 'scout-auth-ready', modalBackdrop: 'scout-auth-modal', modalCloseButton: 'scout-auth-close' } } });
    check();
  });
  try { await deadline(ready, message, 30_000); }
  catch (error) { clerk.closeSignIn(); throw error; }
  finally { observer?.disconnect(); }
}

export function initAuth(onAccountChange, onAuthenticatedSubmit, onSessionChange = (_id) => {}) {
  const button = document.querySelector('#sign-in'), account = document.querySelector('#user-account');
  const prompt = document.querySelector('#prompt'), error = document.querySelector('#error');
  const returnUrl = `${location.origin}${location.pathname}`;
  let loading, previousUser, pendingPrompt, mounted = false;
  try {
    const draft = sessionStorage.getItem(draftKey); if (prompt) sessionStorage.removeItem(draftKey);
    if (draft && prompt && !prompt.value) { prompt.value = draft.slice(0, 4000); prompt.dispatchEvent(new Event('input')); }
    if (onAuthenticatedSubmit) pendingPrompt = sessionStorage.getItem(submissionKey);
  } catch { /* Storage can be disabled; sign-in still works. */ }

  function clearSubmission() {
    pendingPrompt = null;
    try { sessionStorage.removeItem(submissionKey); } catch { /* Optional storage. */ }
  }
  prompt?.addEventListener('input', () => { if (prompt.value.trim() !== pendingPrompt) clearSubmission(); });
  document.addEventListener('click', event => {
    if (event.target.closest?.('.scout-auth-close') || event.target.matches?.('.scout-auth-modal')) clearSubmission();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('.scout-auth-modal')) clearSubmission();
  }, true);

  function client() {
    if (!loading) loading = (async () => {
      const response = await fetch(`${basePath}/api/auth`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again later.');
      const { publishableKey, frontendApi, analytics: config } = await response.json();
      analyticsConfig = [config?.enabled, config?.accountSync, config?.content, config?.contentDefault];
      analytics?.configure(...analyticsConfig);
      await Promise.all([
        window.__internal_ClerkUICtor || loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
        window.Clerk || loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
      ]);
      const clerk = window.Clerk;
      await deadline(clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        telemetry: false,
        signInForceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, afterSignOutUrl: returnUrl,
        appearance: {
          variables: { fontFamily: 'var(--sans)', colorPrimary: 'var(--button)', colorPrimaryForeground: 'var(--button-ink)', colorBackground: 'var(--surface)', colorForeground: 'var(--ink)', colorMutedForeground: 'var(--muted)', colorInput: 'var(--input)', colorInputForeground: 'var(--ink)', colorBorder: 'var(--line)', borderRadius: '6px' },
          layout: { socialButtonsVariant: 'blockButton', socialButtonsPlacement: 'top' },
        },
      }), 'Sign-in took too long. Please try again.');
      clerk.addListener(({ user, session }) => {
        const id = session?.status === 'active' ? user?.id ?? null : null;
        if (previousUser && previousUser !== id) { clearSubmission(); onAccountChange(); }
        previousUser = id;
        analyticsAccount = [id, id ? session : null, clerk.client?.signIn];
        analytics?.account(...analyticsAccount);
        button.hidden = !!id; account.hidden = !id;
        if (id && !mounted) { clerk.mountUserButton(account); mounted = true; }
        if (!id && mounted) { clerk.unmountUserButton(account); mounted = false; }
        onSessionChange(id);
        if (id) {
          try { sessionStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
          const resume = pendingPrompt && prompt?.value.trim() === pendingPrompt;
          // Consume before submitting: session refreshes and reloads must not replay it.
          clearSubmission();
          if (resume) onAuthenticatedSubmit?.();
        }
      });
      return clerk;
    })().catch(error => {
      loading = null; analyticsAccount = [null, null]; analytics?.account(...analyticsAccount);
      analytics?.exception(error, 'auth_unavailable');
      onSessionChange(null);
      throw new Error('Sign-in could not load. Check your connection and try again.');
    });
    return loading;
  }

  async function signIn(submittedPrompt = null) {
    if (!submittedPrompt) clearSubmission();
    const clerk = await client();
    if (submittedPrompt && onAuthenticatedSubmit && prompt?.value.trim() === submittedPrompt) {
      pendingPrompt = submittedPrompt;
      try { sessionStorage.setItem(submissionKey, pendingPrompt); } catch { /* Same-page sign-in can still resume. */ }
    }
    try { if (prompt?.value) sessionStorage.setItem(draftKey, prompt.value); } catch { /* Optional storage. */ }
    try { await openSignIn(clerk, { forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl }); }
    catch (failure) { clearSubmission(); throw failure; }
    analytics?.track('scout_sign_in_opened');
  }
  button.addEventListener('click', async () => {
    button.disabled = true; error.hidden = true;
    try { await signIn(); } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { button.disabled = false; }
  });
  // An unavailable identity service must not prevent browsing the public index.
  void client().catch(() => {});
  return {
    signIn,
    async getToken() {
      const submittedPrompt = prompt?.value.trim();
      const clerk = await client();
      if (clerk.session?.status !== 'active') { await signIn(submittedPrompt); return null; }
      const token = await clerk.session.getToken();
      if (!token) { await signIn(submittedPrompt); return null; }
      clearSubmission();
      return token;
    },
  };
}
