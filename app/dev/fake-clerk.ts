// Stands in for ClerkJS in the local preview, which cannot use the production
// Clerk instance. ?preview=<scenario> picks the fake API's scenario and is kept
// in localStorage; ?preview=signed-out signs out. It opens on the Tonic Ultra account, and
// sign-in returns to it; the other scenarios are Sahra Health's.
import { clerkGlobals, type Clerk } from "../auth.ts";

// Renamed from om-preview when Tonic Ultra became the default, so an old choice does not stick.
const key = "om-preview-account";
const chosen = new URLSearchParams(location.search).get("preview");
if (chosen) localStorage.setItem(key, chosen);
const scenario = localStorage.getItem(key) ?? "tonic";
const tonic = scenario === "tonic";
const active = scenario !== "signed-out";
const verified = "om-preview-verified";
const oauthOnly = "om-preview-oauth-only";
const flag = new URLSearchParams(location.search).get("oauth-only");
if (flag) { if (flag === "1") localStorage.setItem(oauthOnly, "1"); else localStorage.removeItem(oauthOnly); }

const clerk: Clerk = {
  user: active ? (tonic ? { fullName: "Jordan Pike", primaryEmailAddress: { emailAddress: "jordan@tonicultra.example" } } : { fullName: "Amira Haddad", primaryEmailAddress: { emailAddress: "amira@sahra.example" } }) : null,
  // The token carries when the preview last verified, as a real session token's fva claim does.
  session: active ? {
    status: "active",
    // ?oauth-only=1 previews a Google-only account, which Clerk's prompt cannot verify.
    startVerification: async () => ({ supportedFirstFactors: localStorage.getItem(oauthOnly) ? [] : [{ strategy: "email_code" }] }),
    getToken: async () => `preview-${scenario}${localStorage.getItem(verified) ? `.v${localStorage.getItem(verified)}` : ""}` } : null,
  async load() {},
  addListener() {},
  // A fresh sign-in counts as a recent verification, as it does in Clerk.
  openSignIn() { localStorage.setItem(key, "tonic"); localStorage.setItem(verified, String(Math.floor(Date.now() / 1000))); location.reload(); },
  // Clerk asks for a password or code here; the preview verifies at once.
  __internal_openReverification({ afterVerification }) { localStorage.setItem(verified, String(Math.floor(Date.now() / 1000))); afterVerification?.(); },
  async signOut() { localStorage.setItem(key, "signed-out"); location.reload(); },
};
clerkGlobals.Clerk = clerk;
clerkGlobals.__internal_ClerkUICtor = class {};
