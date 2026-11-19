// Stands in for ClerkJS in the local preview, which cannot use the production
// Clerk instance. ?preview=<scenario> picks the fake API's scenario and is kept
// in localStorage; ?preview=signed-out signs out. It opens on the Tonic Ultra account, and
// sign-in returns to it; the other scenarios are Sahra Health's. ?preview=noorg is a new user
// whose session waits on Clerk's choose-organization task; the organizations it creates are
// kept in localStorage, and choosing one opens it as the empty neworg scenario.
import { clerkGlobals, type Clerk, type ClerkOrganization } from "../auth.ts";

// Renamed from om-preview when Tonic Ultra became the default, so an old choice does not stick.
const key = "om-preview-account";
const chosen = new URLSearchParams(location.search).get("preview");
if (chosen) localStorage.setItem(key, chosen);
const scenario = localStorage.getItem(key) ?? "tonic";
const tonic = scenario === "tonic" || scenario === "neworg" || scenario === "noorg";
const active = scenario !== "signed-out";
const verified = "om-preview-verified";
const oauthOnly = "om-preview-oauth-only";
const flag = new URLSearchParams(location.search).get("oauth-only");
if (flag) { if (flag === "1") localStorage.setItem(oauthOnly, "1"); else localStorage.removeItem(oauthOnly); }

// The preview user's organizations: Tonic Ultra, then any created here, which ?preview=noorg forgets.
const orgsKey = "om-preview-orgs", currentKey = "om-preview-org";
if (chosen === "noorg") { localStorage.removeItem(orgsKey); localStorage.removeItem(currentKey); }
const created = (): ClerkOrganization[] => JSON.parse(localStorage.getItem(orgsKey) ?? "[]") as ClerkOrganization[];
const tonicOrg: ClerkOrganization = { id: "org_tonic", name: "Tonic Ultra" };
const orgs = scenario === "noorg" ? created() : tonic ? [tonicOrg, ...created()] : [{ id: "org_sahra", name: "Sahra Health" }];
const organization = scenario === "noorg" ? null : scenario === "neworg" ? orgs.find((org) => org.id === localStorage.getItem(currentKey)) ?? null : orgs[0] ?? null;

const clerk: Clerk = {
  user: active ? {
    ...(tonic ? { id: "user_previewTonicUltra", fullName: "Jordan Pike", firstName: "Jordan", primaryEmailAddress: { emailAddress: "jordan@tonicultra.example" } } : { id: "user_previewSahraHealth", fullName: "Amira Haddad", firstName: "Amira", primaryEmailAddress: { emailAddress: "amira@sahra.example" } }),
    organizationMemberships: orgs.map((org) => ({ organization: org, role: "org:admin" })),
  } : null,
  organization,
  // The token carries when the preview last verified, as a real session token's fva claim does.
  session: active ? {
    status: organization ? "active" : "pending",
    currentTask: organization ? null : { key: "choose-organization" },
    // ?oauth-only=1 previews a Google-only account, which Clerk's prompt cannot verify.
    startVerification: async () => ({ supportedFirstFactors: localStorage.getItem(oauthOnly) ? [] : [{ strategy: "email_code" }] }),
    getToken: async () => `preview-${scenario}${localStorage.getItem(verified) ? `.v${localStorage.getItem(verified)}` : ""}` } : null,
  async load() {},
  async createOrganization({ name }) {
    await new Promise((done) => setTimeout(done, 400));
    const org = { id: `org_${Date.now().toString(36)}`, name };
    localStorage.setItem(orgsKey, JSON.stringify([...created(), org]));
    return org;
  },
  async setActive({ organization: id }) {
    await new Promise((done) => setTimeout(done, 300));
    if (id === tonicOrg.id) localStorage.setItem(key, "tonic");
    else { localStorage.setItem(key, "neworg"); localStorage.setItem(currentKey, id); }
    // The app reloads next; ?preview=noorg would start over.
    history.replaceState(null, "", location.pathname);
  },
  // Stands in for Clerk's embedded sign-in card.
  mountSignIn(node) {
    node.innerHTML = `<div class="preview-signin"><p class="dialog-title">Sign in to OpenMerit</p><p class="sub">Preview: sign-in is simulated.</p><button class="btn" type="button" data-preview-sign-in>Continue with GitHub</button><button class="btn" type="button" data-preview-sign-in>Continue with Google</button></div>`;
    node.querySelectorAll("[data-preview-sign-in]").forEach((button) => button.addEventListener("click", () => clerk.openSignIn({})));
  },
  unmountSignIn(node) { node.innerHTML = ""; },
  addListener() {},
  // A fresh sign-in counts as a recent verification, as it does in Clerk.
  openSignIn() { localStorage.setItem(key, "tonic"); localStorage.setItem(verified, String(Math.floor(Date.now() / 1000))); location.reload(); },
  // Clerk asks for a password or code here; the preview verifies at once.
  __internal_openReverification({ afterVerification }) { localStorage.setItem(verified, String(Math.floor(Date.now() / 1000))); afterVerification?.(); },
  async signOut() { localStorage.setItem(key, "signed-out"); location.reload(); },
};
clerkGlobals.Clerk = clerk;
clerkGlobals.__internal_ClerkUICtor = class {};
