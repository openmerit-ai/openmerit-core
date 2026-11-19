// Clerk sign-in for app.openmerit.ai. ClerkJS and its UI load from the Clerk
// instance's frontend API, as on openmerit.ai/scout/; the cloud app verifies
// each session token it receives. A page that already defines clerkGlobals.Clerk,
// as the local preview does, uses it instead.
export interface ClerkSession {
  status: string;
  getToken(): Promise<string | null>;
  // Starts a re-verification and lists the factors Clerk can check; empty for a Google-only account.
  startVerification?(params: { level: string }): Promise<{ supportedFirstFactors?: unknown[] | null }>;
}
export interface ClerkUser { fullName?: string | null; primaryEmailAddress?: { emailAddress: string } | null }
export interface Clerk {
  session?: ClerkSession | null;
  user?: ClerkUser | null;
  organization?: { name: string } | null;
  load(options: Record<string, unknown>): Promise<void>;
  addListener(listener: (state: { user?: ClerkUser | null; session?: ClerkSession | null }) => void): unknown;
  openSignIn(options: Record<string, unknown>): void;
  signOut(options?: Record<string, unknown>): Promise<void>;
  // Clerk's re-verify prompt, which its useReverification hook opens; ClerkJS has no public name for it.
  __internal_openReverification?(props: { level?: string; afterVerification?: () => void; afterVerificationCancelled?: () => void }): void;
}
// ClerkJS and its UI register themselves on window.
export const clerkGlobals = globalThis as unknown as { Clerk?: Clerk; __internal_ClerkUICtor?: unknown };

export interface AppConfig { publishableKey: string; frontendApi: string; apiOrigin: string }

export const unavailable = "Sign-in could not load. Check your connection and reload this page to try again.";

function deadline<T>(operation: Promise<T>, message: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function loadScript(src: string, publishableKey?: string): Promise<void> {
  return deadline(new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src; script.async = true; script.crossOrigin = "anonymous";
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(unavailable)); };
    document.head.append(script);
  }), unavailable);
}

// Clerk's sign-in and verify screens in the app's own look: the dialog's card, the page titles'
// serif, left-aligned headers and the app's buttons and inputs, from the same CSS variables.
export function appearance(): Record<string, unknown> {
  const button = { height: "32px", borderRadius: "7px", fontSize: "13.5px", fontWeight: 500, letterSpacing: "-.005em", textTransform: "none", boxShadow: "none" };
  return {
    variables: { fontFamily: "var(--sans)", fontSize: "14px", colorPrimary: "var(--ink)", colorPrimaryForeground: "var(--paper)", colorBackground: "var(--surface)", colorForeground: "var(--ink)", colorMutedForeground: "var(--muted)", colorInputForeground: "var(--ink)", colorInput: "var(--paper)", colorBorder: "var(--line)", colorDanger: "var(--error)", colorSuccess: "var(--good)", colorShadow: "var(--shadow)", borderRadius: "7px" },
    layout: { socialButtonsVariant: "blockButton", socialButtonsPlacement: "top" },
    elements: {
      modalContent: { outline: "none" },
      modalBackdrop: { background: "#0000004d", alignItems: "flex-start", paddingTop: "14vh" },
      cardBox: { width: "400px", maxWidth: "calc(100vw - 32px)", borderRadius: "12px", border: "1px solid var(--line)", boxShadow: "0 20px 60px var(--shadow)", background: "var(--surface)" },
      card: { background: "var(--surface)", boxShadow: "none", border: "0", borderRadius: "0", padding: "28px 28px 24px", gap: "22px" },
      header: { alignItems: "flex-start", textAlign: "left", gap: "6px" },
      headerTitle: { fontFamily: "var(--serif)", fontSize: "26px", fontWeight: 400, lineHeight: 1.15, letterSpacing: "-.02em", color: "var(--ink)" },
      headerSubtitle: { fontSize: "14px", color: "var(--prose)" },
      socialButtons: { display: "grid", gridTemplateColumns: "1fr", gap: "8px" },
      socialButtonsBlockButton: { ...button, height: "36px", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)",
        "&:hover": { background: "color-mix(in srgb, var(--ink) 3%, var(--surface))", borderColor: "color-mix(in srgb, var(--ink) 16%, var(--line))" } },
      socialButtonsBlockButtonText: { fontWeight: 500, color: "var(--ink)" },
      dividerLine: { background: "var(--line)" },
      dividerText: { color: "var(--muted)", fontSize: "12px" },
      formFieldLabel: { fontSize: "13.5px", fontWeight: 500, color: "var(--ink)" },
      formFieldInput: { height: "34px", borderRadius: "7px", border: "1px solid var(--line)", background: "var(--paper)", boxShadow: "none", fontSize: "14px",
        "&:focus": { borderColor: "var(--green)", boxShadow: "0 0 0 1px var(--green)" } },
      otpCodeFieldInput: { borderRadius: "7px", border: "1px solid var(--line)", background: "var(--paper)", boxShadow: "none" },
      formButtonPrimary: { ...button, background: "var(--ink)", color: "var(--paper)", boxShadow: "inset 0 1px 0 color-mix(in srgb, var(--paper) 16%, transparent), 0 1px 2px var(--shadow)",
        "&:hover": { background: "color-mix(in srgb, var(--ink) 88%, var(--paper))" }, "&::after": { display: "none" } },
      formButtonReset: { ...button, color: "var(--ink)" },
      alternativeMethodsBlockButton: { ...button, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)" },
      footer: { background: "var(--surface)", borderTop: "1px solid var(--line)", "& > div": { background: "transparent" } },
      footerAction: { justifyContent: "flex-start", padding: "14px 28px" },
      footerActionText: { color: "var(--muted)", fontSize: "13.5px" },
      footerActionLink: { color: "var(--link)", fontWeight: 500, textDecoration: "underline", textDecorationColor: "var(--link-line)", textUnderlineOffset: "3px" },
      identityPreview: { border: "1px solid var(--line)", borderRadius: "7px", background: "var(--paper)" },
      identityPreviewEditButton: { color: "var(--link)" },
      modalCloseButton: { color: "var(--muted)", top: "20px", right: "20px", borderRadius: "6px" },
      alert: { borderRadius: "7px", border: "1px solid color-mix(in srgb, var(--error) 30%, var(--line))", background: "color-mix(in srgb, var(--error) 6%, var(--surface))", color: "var(--error)" },
    },
  };
}

export async function loadClerk(config: AppConfig): Promise<Clerk> {
  await Promise.all([
    clerkGlobals.__internal_ClerkUICtor || loadScript(`https://${config.frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
    clerkGlobals.Clerk || loadScript(`https://${config.frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, config.publishableKey),
  ]);
  const clerk = clerkGlobals.Clerk;
  if (!clerk) throw new Error(unavailable);
  const here = location.href;
  await deadline(clerk.load({
    ui: { ClerkUI: clerkGlobals.__internal_ClerkUICtor },
    telemetry: false,
    signInForceRedirectUrl: here, signUpForceRedirectUrl: here, afterSignOutUrl: `${location.origin}/`,
    appearance: appearance(),
    localization: {
      signIn: { start: { title: "Sign in to OpenMerit", subtitle: "Use the GitHub or Google account your team signs in with." } },
      signUp: { start: { title: "Create your OpenMerit account", subtitle: "Sign up with GitHub or Google." } },
    },
  }), "Sign-in took too long. Please reload to try again.");
  return clerk;
}

export const signedIn = (clerk: Clerk): boolean => clerk.session?.status === "active" && !!clerk.user;
