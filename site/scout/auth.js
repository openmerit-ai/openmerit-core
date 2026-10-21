import { analytics } from './analytics.js';

const basePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const draftKey = 'scout-sign-in-draft';

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

export function initAuth(onAccountChange) {
  const button = document.querySelector('#sign-in'), account = document.querySelector('#user-account');
  const prompt = document.querySelector('#prompt'), error = document.querySelector('#error');
  const returnUrl = `${location.origin}${basePath}/`;
  let loading, previousUser, mounted = false;
  try {
    const draft = sessionStorage.getItem(draftKey); sessionStorage.removeItem(draftKey);
    if (draft && !prompt.value) { prompt.value = draft.slice(0, 4000); prompt.dispatchEvent(new Event('input')); }
  } catch { /* Storage can be disabled; sign-in still works. */ }

  function client() {
    if (!loading) loading = (async () => {
      const response = await fetch(`${basePath}/api/auth`);
      if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again later.');
      const { publishableKey, frontendApi, analytics: config } = await response.json();
      analytics.configure(config?.enabled);
      await Promise.all([
        window.__internal_ClerkUICtor || loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
        window.Clerk || loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
      ]);
      const clerk = window.Clerk;
      await clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        telemetry: false,
        signInForceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, afterSignOutUrl: returnUrl,
        appearance: {
          variables: { fontFamily: 'var(--sans)', colorPrimary: 'var(--button)', colorPrimaryForeground: 'var(--button-ink)', colorBackground: 'var(--surface)', colorForeground: 'var(--ink)', colorMutedForeground: 'var(--muted)', colorInput: 'var(--input)', colorInputForeground: 'var(--ink)', colorBorder: 'var(--line)', borderRadius: '6px' },
          layout: { socialButtonsVariant: 'blockButton', socialButtonsPlacement: 'top' },
        },
      });
      clerk.addListener(({ user, session }) => {
        const id = session?.status === 'active' ? user?.id ?? null : null;
        if (previousUser && previousUser !== id) onAccountChange();
        previousUser = id;
        analytics.account(id, id ? session : null);
        button.hidden = !!id; account.hidden = !id;
        if (id && !mounted) { clerk.mountUserButton(account); mounted = true; }
        if (!id && mounted) { clerk.unmountUserButton(account); mounted = false; }
        if (id) { try { sessionStorage.removeItem(draftKey); } catch { /* Optional storage. */ } }
      });
      return clerk;
    })().catch(error => { loading = null; analytics.account(null, null); analytics.track('scout_client_error', { code: 'auth_unavailable' }); throw error; });
    return loading;
  }

  async function signIn() {
    const clerk = await client();
    try { if (prompt.value) sessionStorage.setItem(draftKey, prompt.value); } catch { /* Optional storage. */ }
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
    analytics.track('scout_sign_in_opened');
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
      const clerk = await client();
      if (clerk.session?.status !== 'active') { await signIn(); return null; }
      const token = await clerk.session.getToken();
      if (!token) { await signIn(); return null; }
      return token;
    },
  };
}
