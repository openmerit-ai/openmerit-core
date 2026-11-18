// The app.openmerit.ai pages: signs in with Clerk, then fills the page named by
// #view[data-view] from the cloud app's /api/* with the session token.
import { ApiError, createApi, type Api, type Me } from "./api.ts";
import { loadClerk, signedIn, unavailable, type AppConfig, type Clerk } from "./auth.ts";
import { html, setLogos, type Html } from "./html.ts";
import { mount, type Account, type ConfirmOptions, type Ctx, type Mounted } from "./view.ts";
import { install } from "./views/common.ts";
import { connectionsView } from "./views/connections.ts";
import { dataView } from "./views/data.ts";
import { guardrailsView } from "./views/guardrails.ts";
import { planView } from "./views/plan.ts";
import { runView } from "./views/run.ts";
import { runsView } from "./views/runs.ts";
import { tasksView } from "./views/tasks.ts";

declare const __LOGOS__: Record<string, string>;
setLogos(__LOGOS__);

const views: Record<string, (ctx: Ctx) => Promise<Mounted>> = {
  runs: mount(runsView), run: mount(runView), tasks: mount(tasksView), connections: mount(connectionsView),
  guardrails: mount(guardrailsView), plan: mount(planView), data: mount(dataView),
};

const root = document.querySelector<HTMLElement>("#view");
const pageTitle = root?.dataset.title ?? "OpenMerit";
const params = new URLSearchParams(location.search);
const runId = /^\/r\/([\w-]+)\/?$/.exec(location.pathname)?.[1] ?? null;
let clerk: Clerk | null = null;
let api: Api | null = null;
let mounted: Mounted | null = null;

const put = (content: Html): void => {
  if (!root) return;
  root.innerHTML = content.__html;
  root.removeAttribute("aria-busy");
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, error = false): void {
  let box = document.querySelector<HTMLElement>(".toast");
  if (!box) {
    box = document.createElement("div");
    box.className = "toast";
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  box.textContent = message;
  box.classList.toggle("bad", error);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (box) box.hidden = true; }, 6000);
}

function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.innerHTML = html`<form method="dialog">
    <h2 class="dialog-title">${options.title}</h2>
    <p>${options.body}</p>
    ${options.typeToConfirm ? html`<label><span>Type <b>${options.typeToConfirm}</b> to confirm</span><input name="confirm" autocomplete="off" spellcheck="false"></label>` : ""}
    <div class="dialog-actions"><button class="btn" value="cancel">Cancel</button><button class="btn ${options.danger ? "danger" : "primary"}" value="ok"${options.typeToConfirm ? html` disabled` : ""}>${options.confirm}</button></div>
  </form>`.__html;
  const ok = dialog.querySelector<HTMLButtonElement>("button[value=ok]");
  dialog.querySelector<HTMLInputElement>("input[name=confirm]")?.addEventListener("input", (event) => {
    if (ok && event.target instanceof HTMLInputElement) ok.disabled = event.target.value.trim() !== options.typeToConfirm;
  });
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => { resolve(dialog.returnValue === "ok"); dialog.remove(); }));
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : "Something went wrong. Try again.");

function showError(failure: unknown): void {
  if (failure instanceof ApiError && failure.status === 401) {
    put(html`<h1 class="title">${pageTitle}</h1><div class="card notice bad" role="alert"><p>Your session could not be verified. Sign in again to continue.</p><p style="margin-top: 10px"><button class="btn primary" type="button" data-global="sign-in-again">Sign in again</button></p></div>`);
  } else if (failure instanceof ApiError && failure.status === 404 && runId) {
    put(html`<div class="eyebrow"><a href="/">Runs</a><span>›</span><span>${runId}</span></div><h1 class="title">Run not found</h1><p class="lede">It may have been deleted, or it belongs to another account. <a href="/">Back to runs</a></p>`);
  } else {
    put(html`<h1 class="title">${pageTitle}</h1><div class="card notice bad" role="alert"><p>${pageTitle} could not load. ${message(failure)}</p><p style="margin-top: 10px"><button class="btn" type="button" data-global="retry">Try again</button></p></div>`);
  }
}

function showSignedOut(): void {
  fillProfile(null);
  put(html`<div class="eyebrow"><span>OpenMerit</span></div>
    <h1 class="title">Sign in to OpenMerit</h1>
    <p class="lede">Runs, tasks, endpoints and billing for your coding agents' model choices.</p>
    <div class="card signin">
      <p><button class="btn primary" type="button" data-global="sign-in">Sign in</button></p>
      <p class="sub" style="margin-top: 10px">New to OpenMerit? Add it to a coding agent; its first call signs you in.</p>
      <div style="margin-top: 10px">${install()}</div>
    </div>`);
}

// /api/me names the account; Clerk, which the page already holds, names the person.
function fillProfile(me: Account | null): void {
  const user = clerk?.user;
  const name = me ? user?.fullName || user?.primaryEmailAddress?.emailAddress || "Signed in" : "Sign in";
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const sub = me ? `${me.account.name} · ${me.plan.status !== "none" && me.plan.status !== "canceled" ? `${me.plan.name ?? "OpenMerit"} plan` : "No plan"}` : "OpenMerit";
  const initial = (text: string): string => text.trim()[0]?.toUpperCase() ?? "?";
  const avatar = me ? html`${initial(name)}<span class="org-badge">${initial(me.account.name)}</span>` : html`?`;
  const profile = document.querySelector<HTMLElement>(".profile");
  if (profile) {
    profile.title = me ? `${name} · ${me.account.name}` : "Sign in";
    profile.querySelector(".avatar")!.innerHTML = avatar.__html;
    profile.querySelector(".label")!.innerHTML = html`${name}<span class="sub">${sub}</span>`.__html;
  }
  const who = document.querySelector<HTMLElement>(".menu-who");
  if (who) who.innerHTML = html`<span class="avatar" aria-hidden="true">${avatar}</span><span>${name}<span class="sub">${me ? email ?? me.account.name : "Not signed in"}</span></span>`.__html;
  const session = document.querySelector<HTMLElement>("[data-global=sign-out]");
  if (session) session.lastChild!.textContent = me ? "Sign out" : "Sign in";
}

async function render(ctx: Ctx): Promise<void> {
  const view = root ? views[root.dataset.view ?? ""] : undefined;
  if (!root || !view) return;
  mounted = await view(ctx);
  put(mounted.html);
  mounted.bind(root);
  document.title = `${mounted.title ?? pageTitle} · OpenMerit`;
}

async function boot(): Promise<void> {
  try {
    if (!clerk) {
      const response = await fetch("/config.json", { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Sign-in is temporarily unavailable. Please try again later.");
      const config = await response.json() as AppConfig;
      clerk = await loadClerk(config);
      api = createApi(config.apiOrigin, async () => (await clerk?.session?.getToken()) ?? null);
      let was = signedIn(clerk);
      clerk.addListener(() => {
        if (!clerk || signedIn(clerk) === was) return;
        was = signedIn(clerk);
        void boot();
      });
    }
  } catch (failure) {
    fillProfile(null);
    return showError(new Error(failure instanceof Error ? failure.message : unavailable));
  }
  if (!signedIn(clerk) || !api) return showSignedOut();
  try {
    const found = await api.get<Me>("/api/me");
    const me: Account = { ...found, account: { ...found.account, name: found.account.name ?? clerk.organization?.name ?? "Your organization" } };
    fillProfile(me);
    const ctx: Ctx = {
      api, me, params, id: runId, toast, confirm: confirmDialog, download,
      go: (url) => location.assign(url),
      refresh: () => render(ctx),
    };
    await render(ctx);
    if (params.get("deleted")) toast(`Everything for ${me.account.name} was deleted.`);
  } catch (failure) {
    showError(failure);
  }
}

async function act(name: string, target: HTMLElement): Promise<void> {
  const button = target instanceof HTMLButtonElement ? target : target.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try { await mounted?.act(name, target); }
  catch (failure) { toast(message(failure), true); }
  finally { if (button?.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); } }
}

async function global(name: string): Promise<void> {
  if (!clerk) return void boot();
  if (name === "retry") return void boot();
  if (name === "sign-in") return clerk.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  if (name === "sign-out" && !signedIn(clerk)) return clerk.openSignIn({ forceRedirectUrl: location.href });
  if (name === "sign-out") return clerk.signOut();
  if (name === "sign-in-again") { await clerk.signOut({ redirectUrl: location.href }); }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const globalTarget = event.target.closest<HTMLElement>("[data-global]");
  if (globalTarget) { event.preventDefault(); void global(globalTarget.dataset.global ?? "").catch((failure) => toast(message(failure), true)); return; }
  const target = event.target.closest<HTMLElement>("button[data-action]");
  if (target && root?.contains(target)) void act(target.dataset.action ?? "", target);
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.action || !root?.contains(form)) return;
  event.preventDefault();
  void act(form.dataset.action, form);
});
document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.dataset.action && root?.contains(target)) void act(target.dataset.action, target);
});

void boot();
