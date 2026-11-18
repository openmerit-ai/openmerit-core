// Stands in for ClerkJS in the local preview, which cannot use the production
// Clerk instance. ?preview=<scenario> picks the fake API's scenario and is kept
// in localStorage; ?preview=signed-out signs out. Sign-in returns to populated.
import { clerkGlobals, type Clerk } from "../auth.ts";

const key = "om-preview";
const chosen = new URLSearchParams(location.search).get("preview");
if (chosen) localStorage.setItem(key, chosen);
const scenario = localStorage.getItem(key) ?? "populated";
const active = scenario !== "signed-out";

const clerk: Clerk = {
  user: active ? { fullName: "Amira Haddad", primaryEmailAddress: { emailAddress: "amira@sahra.example" } } : null,
  session: active ? { status: "active", getToken: async () => `preview-${scenario}` } : null,
  async load() {},
  addListener() {},
  openSignIn() { localStorage.setItem(key, "populated"); location.reload(); },
  async signOut() { localStorage.setItem(key, "signed-out"); location.reload(); },
};
clerkGlobals.Clerk = clerk;
clerkGlobals.__internal_ClerkUICtor = class {};
