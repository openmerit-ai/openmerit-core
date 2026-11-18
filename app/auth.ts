// Clerk sign-in for app.openmerit.ai. ClerkJS and its UI load from the Clerk
// instance's frontend API, as on openmerit.ai/scout/; the cloud app verifies
// each session token it receives. A page that already defines clerkGlobals.Clerk,
// as the local preview does, uses it instead.
export interface ClerkSession { status: string; getToken(): Promise<string | null> }
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
    appearance: {
      variables: { fontFamily: "var(--sans)", colorPrimary: "var(--ink)", colorPrimaryForeground: "var(--paper)", colorBackground: "var(--surface)", colorForeground: "var(--ink)", colorMutedForeground: "var(--muted)", colorInputForeground: "var(--ink)", colorBorder: "var(--line)", borderRadius: "6px" },
      layout: { socialButtonsVariant: "blockButton", socialButtonsPlacement: "top" },
    },
  }), "Sign-in took too long. Please reload to try again.");
  return clerk;
}

export const signedIn = (clerk: Clerk): boolean => clerk.session?.status === "active" && !!clerk.user;
