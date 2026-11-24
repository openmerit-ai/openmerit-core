// The app.openmerit.ai pages: signs in with Clerk, then fills the page named by
// #view[data-view] from the cloud app's /api/* with the session token.
import { trackPageview } from "./analytics.ts";
import { ApiError, createApi, DEFAULT_PROJECT, type Api, type Me, type Project } from "./api.ts";
import { loadClerk, needsOrganization, signedIn, unavailable, type AppConfig, type Clerk } from "./auth.ts";
import { html, setLogos, type Html } from "./html.ts";
import { startLive, stopLive } from "./live.ts";
import { mount, type Account, type ConfirmOptions, type Ctx, type Mounted } from "./view.ts";
import { accountView } from "./views/account.ts";
import { install } from "./views/common.ts";
import { connectionsView } from "./views/connections.ts";
import { dataView } from "./views/data.ts";
import { evalsView } from "./views/evals.ts";
import { guardrailsView } from "./views/guardrails.ts";
import { planView } from "./views/plan.ts";
import { projectView } from "./views/project.ts";
import { runView } from "./views/run.ts";
import { runsView } from "./views/runs.ts";
import { tasksView } from "./views/tasks.ts";

declare const __LOGOS__: Record<string, string>;
setLogos(__LOGOS__);

const views: Record<string, (ctx: Ctx) => Promise<Mounted>> = {
  runs: mount(runsView), run: mount(runView), tasks: mount(tasksView), evals: mount(evalsView), connections: mount(connectionsView),
  guardrails: mount(guardrailsView), plan: mount(planView), data: mount(dataView), project: mount(projectView), account: mount(accountView),
};

const root = document.querySelector<HTMLElement>("#view");
const pageTitle = root?.dataset.title ?? "OpenMerit";
const params = new URLSearchParams(location.search);
const runId = /^\/r\/([\w-]+)\/?$/.exec(location.pathname)?.[1] ?? null;
const brand = html`<a class="brand" href="/" aria-label="OpenMerit"><svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg><span class="label">openmerit</span></a>`;
let clerk: Clerk | null = null;
let api: Api | null = null;
let mounted: Mounted | null = null;
// The project the sidebar's switcher has open; every project-scoped /api/* call names it.
let projectId: string | null = null;
let accountId = "";

const put = (content: Html): void => {
  if (!root) return;
  stopLive();
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

function confirmDialog(options: ConfirmOptions): Promise<boolean | "alternative"> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.innerHTML = html`<form method="dialog">
    <h2 class="dialog-title">${options.title}</h2>
    <p>${options.body}</p>
    ${options.items?.length ? html`<ul class="dialog-list">${options.items.map((item) => html`<li>${item}</li>`)}</ul>` : ""}
    ${options.typeToConfirm ? html`<label><span>Type <b>${options.typeToConfirm}</b> to confirm</span><input name="confirm" autocomplete="off" spellcheck="false"></label>` : ""}
    <div class="dialog-actions"><button class="btn" value="cancel">Cancel</button>${options.alternative ? html`<button class="btn" value="alternative">${options.alternative}</button>` : ""}<button class="btn ${options.danger ? "danger" : "primary"}" value="ok"${options.typeToConfirm ? html` disabled` : ""}>${options.confirm}</button></div>
  </form>`.__html;
  const ok = dialog.querySelector<HTMLButtonElement>("button[value=ok]");
  dialog.querySelector<HTMLInputElement>("input[name=confirm]")?.addEventListener("input", (event) => {
    if (ok && event.target instanceof HTMLInputElement) ok.disabled = event.target.value.trim() !== options.typeToConfirm;
  });
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => { resolve(dialog.returnValue === "alternative" ? "alternative" : dialog.returnValue === "ok"); dialog.remove(); }));
}

// A deletion needs a sign-in in the last 10 minutes. Clerk's prompt checks a password, code or
// passkey; an account that signs in only with Google has none, so it signs in again instead, and
// the fresh sign-in counts. The user then repeats the action.
async function reverify(level: string | undefined): Promise<boolean> {
  const open = clerk?.__internal_openReverification?.bind(clerk);
  const factors = await clerk?.session?.startVerification?.({ level: level ?? "first_factor" }).then((found) => found.supportedFirstFactors ?? [], () => null);
  if (open && factors?.length !== 0) {
    return new Promise((resolve) => open({ ...(level ? { level } : {}), afterVerification: () => resolve(true), afterVerificationCancelled: () => resolve(false) }));
  }
  const ok = await confirmDialog({
    title: "Sign in again to continue",
    body: "Deleting needs a sign-in from the last 10 minutes. Sign in again with Google, then repeat the delete.",
    confirm: "Sign in again",
  });
  if (ok) await clerk?.signOut({ redirectUrl: location.href });
  return false;
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : "Something went wrong. Try again.");

function showError(failure: unknown): void {
  // The cloud app's answer to a token without an organization, should Clerk's state and the token disagree.
  if (failure instanceof ApiError && failure.status === 403 && /names no Clerk organization/.test(failure.message)) return showOrganization();
  if (failure instanceof ApiError && failure.status === 401) {
    put(html`<h1 class="title">${pageTitle}</h1><div class="card notice bad" role="alert"><p>Your session could not be verified. Sign in again to continue.</p><p style="margin-top: 10px"><button class="btn primary" type="button" data-global="sign-in-again">Sign in again</button></p></div>`);
  } else if (failure instanceof ApiError && failure.status === 404 && runId) {
    put(html`<div class="eyebrow"><a href="/">Runs</a><span>›</span><span>${runId}</span></div><h1 class="title">Run not found</h1><p class="lede">It may have been deleted, or it belongs to another account. <a href="/">Back to runs</a></p>`);
  } else {
    put(html`<h1 class="title">${pageTitle}</h1><div class="card notice bad" role="alert"><p>${pageTitle} could not load. ${message(failure)}</p><p style="margin-top: 10px"><button class="btn" type="button" data-global="retry">Try again</button></p></div>`);
  }
}

// Signed out, the page is only sign-in: no sidebar, and Clerk's sign-in (with sign-up in the same
// card) mounted in the page rather than as a modal over an empty app.
function showSignedOut(): void {
  fillProfile(null);
  document.body.classList.add("standalone");
  document.title = "Sign in · OpenMerit";
  put(html`<div class="signin-page">
    ${brand}
    <div class="signin-mount"></div>
    <div class="signin-note"><p class="sub">New to OpenMerit? Add it to a coding agent; its first call signs you in.</p>${install()}</div>
  </div>`);
  const mount = root?.querySelector<HTMLDivElement>(".signin-mount");
  if (mount && clerk?.mountSignIn) {
    clerk.mountSignIn(mount, { withSignUp: true, forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
    signInMount = mount;
  }
}

let signInMount: HTMLDivElement | null = null;
function leaveStandalone(): void {
  document.body.classList.remove("standalone");
  if (signInMount) { clerk?.unmountSignIn?.(signInMount); signInMount = null; }
}

const initial = (text: string): string => text.trim()[0]?.toUpperCase() ?? "?";

// An OpenMerit account is a Clerk organization. Signed in without one, this is the whole page: pick
// one of the user's organizations or create one. From the profile menu, it switches between them.
function showOrganization(switching = false): void {
  const user = clerk?.user;
  if (!clerk || !user) return showSignedOut();
  leaveStandalone();
  document.body.classList.add("standalone");
  const memberships = user.organizationMemberships ?? [];
  const current = clerk.organization?.id ?? null;
  const first = user.firstName?.trim() || user.fullName?.trim().split(/\s+/)[0] || "";
  const email = user.primaryEmailAddress?.emailAddress ?? user.fullName ?? "";
  document.title = `${memberships.length ? "Choose an organization" : "Create your organization"} · OpenMerit`;
  put(html`<div class="signin-page org-page">
    ${brand}
    <div class="org-card">
      <div class="org-head">
        <h1 class="dialog-title">${memberships.length ? "Choose an organization" : "Create your organization"}</h1>
        <p>${memberships.length ? "Runs, endpoints, guardrails and the plan belong to an organization. Pick one, or create another." : "Runs, endpoints, guardrails and the plan belong to an organization. Name yours; teammates can join it later."}</p>
      </div>
      ${memberships.length ? html`<ul class="org-list" aria-label="Your organizations">${memberships.map(({ organization, role }) => html`<li><button type="button" class="org-choice" data-org="${organization.id}"${organization.id === current ? html` aria-current="true"` : ""}>
        <span class="org-mark" aria-hidden="true">${initial(organization.name)}</span>
        <span class="org-name">${organization.name}<span class="sub">${role === "org:admin" ? "Admin" : "Member"}</span></span>
        ${organization.id === current ? html`<span class="pill tag good">Current</span>` : html`<svg class="org-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`}
      </button></li>`)}</ul>` : ""}
      <form class="org-create">
        <label><span>${memberships.length ? "New organization" : "Organization name"}</span><input name="name" required maxlength="64" autocomplete="organization" spellcheck="false" placeholder="${first ? `${first}'s team` : "Acme"}" value="${memberships.length || !first ? "" : `${first}'s team`}"></label>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">Create organization</button>
      </form>
    </div>
    <p class="sub org-foot">${switching ? html`<a href="${location.pathname}${location.search}">Back</a> · ` : ""}Signed in as ${email} · <a href="#" data-global="sign-out">Sign out</a></p>
  </div>`);
  const page = root?.querySelector<HTMLElement>(".org-page");
  const error = page?.querySelector<HTMLElement>(".form-error");
  const fail = (failure: unknown): void => {
    const text = (failure as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0];
    if (error) { error.textContent = text?.longMessage ?? text?.message ?? message(failure); error.hidden = false; }
  };
  // Setting it active completes Clerk's choose-organization task; the reload starts on fresh tokens.
  const choose = async (id: string): Promise<void> => {
    if (id === current) return location.reload();
    await clerk?.setActive?.({ organization: id });
    location.reload();
  };
  const busy = (button: HTMLButtonElement | null | undefined, on: boolean): void => { if (button) { button.disabled = on; button.toggleAttribute("aria-busy", on); } };
  page?.querySelectorAll<HTMLButtonElement>(".org-choice").forEach((button) => button.addEventListener("click", () => {
    busy(button, true);
    choose(button.dataset.org ?? "").catch((failure) => { busy(button, false); fail(failure); });
  }));
  page?.querySelector<HTMLFormElement>(".org-create")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement, submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name || !clerk?.createOrganization) return;
    busy(submit, true);
    clerk.createOrganization({ name }).then((created) => choose(created.id)).catch((failure) => { busy(submit, false); fail(failure); });
  });
  if (!memberships.length) page?.querySelector<HTMLInputElement>("input[name=name]")?.focus();
}

// /api/me names the account; Clerk, which the page already holds, names the person.
function fillProfile(me: Account | null): void {
  const user = clerk?.user;
  const name = me ? user?.fullName || user?.primaryEmailAddress?.emailAddress || "Signed in" : "Sign in";
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const sub = me ? `${me.account.name} · ${me.plan.status !== "none" && me.plan.status !== "canceled" ? `${me.plan.name ?? "OpenMerit"} plan` : "No plan"}` : "OpenMerit";
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

// The open project is remembered per organization. ?project= opens another, as after deleting one.
const projectKey = (orgId: string): string => `om-project:${orgId}`;
function chooseProject(orgId: string, projects: Project[]): Project {
  let stored: string | null = null;
  try { stored = params.get("project") ?? localStorage.getItem(projectKey(orgId)); } catch { /* private browsing */ }
  const found = projects.find((item) => item.id === stored) ?? projects.find((item) => item.id === DEFAULT_PROJECT) ?? projects[0]!;
  try { localStorage.setItem(projectKey(orgId), found.id); } catch { /* the choice lasts until reload */ }
  return found;
}

const checkIcon = html`<svg class="icon check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>`;
function fillProjects(me: Account, current: Project, projects: Project[]): void {
  const button = document.querySelector<HTMLElement>(".project-switch");
  const menu = document.querySelector<HTMLElement>(".project-menu");
  if (!button || !menu) return;
  button.title = `${current.name} · Switch project`;
  button.querySelector(".project-mark")!.textContent = initial(current.name);
  button.querySelector(".project-name")!.textContent = current.name;
  menu.innerHTML = html`${projects.map((item) => html`<button type="button" role="menuitem" data-global="project" data-project="${item.id}"${item.id === current.id ? html` aria-current="true"` : ""}><span class="project-mark" aria-hidden="true">${initial(item.name)}</span><span class="label">${item.name}</span>${item.id === current.id ? checkIcon : html`<span class="sub">${item.tasks || ""}</span>`}</button>`)}
    <hr>
    ${me.role === "admin" ? html`<button type="button" role="menuitem" data-global="new-project"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New project</button>` : ""}
    <a role="menuitem" href="/project/"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>Project settings</a>`.__html;
}

// Names a new project, creates it and opens its settings, where its repositories and endpoints go.
async function newProject(): Promise<void> {
  if (!api) return;
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.innerHTML = html`<form method="dialog" class="form">
    <h2 class="dialog-title">New project</h2>
    <p>A project has its own tasks, runs, guardrails, GitHub repositories and model endpoints. The plan and members stay the organization's.</p>
    <label><span>Project name</span><input name="name" required maxlength="64" autocomplete="off" spellcheck="false" placeholder="Support bot"></label>
    <p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Create project</button></div>
  </form>`.__html;
  document.body.append(dialog);
  const form = dialog.querySelector("form")!, error = dialog.querySelector<HTMLElement>(".form-error")!;
  form.addEventListener("submit", (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value !== "ok") return;
    event.preventDefault();
    const name = String(new FormData(form).get("name") ?? "").trim();
    api!.send<Project>("POST", "/api/projects", { name }).then((created) => {
      try { localStorage.setItem(projectKey(accountId), created.id); } catch { /* the reload opens the default */ }
      location.assign(`/project/?project=${encodeURIComponent(created.id)}`);
    }, (failure: unknown) => { error.textContent = message(failure); error.hidden = false; });
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

// The sidebar's Review evals item: shown with its count only while a review's drafts wait in this project.
async function fillReview(api: Api): Promise<void> {
  const item = document.querySelector<HTMLElement>(".nav-action[href='/evals/']");
  if (!item) return;
  const waiting = (await api.get<unknown[]>("/api/eval-drafts").catch((): unknown[] => [])).length;
  item.hidden = waiting === 0 && !item.hasAttribute("aria-current");
  item.querySelector(".count")!.textContent = waiting ? String(waiting) : "";
  item.title = waiting ? `Review evals: ${waiting} waiting` : "Review evals";
}

async function render(ctx: Ctx): Promise<void> {
  const view = root ? views[root.dataset.view ?? ""] : undefined;
  if (!root || !view) return;
  mounted = await view(ctx);
  put(mounted.html);
  mounted.bind(root);
  startLive(root, ctx.api, ctx.refresh);
  document.title = `${mounted.title ?? pageTitle} · OpenMerit`;
}

async function boot(): Promise<void> {
  try {
    if (!clerk) {
      const response = await fetch("/config.json", { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Sign-in is temporarily unavailable. Please try again later.");
      const config = await response.json() as AppConfig;
      clerk = await loadClerk(config);
      api = createApi(config.apiOrigin, async () => (await clerk?.session?.getToken()) ?? null, fetch, reverify, () => projectId);
      // Boots again when the user signs in or out, or their session gains or loses an organization.
      const state = (found: Clerk): string => (signedIn(found) ? `in:${found.organization?.id ?? ""}` : needsOrganization(found) ? "organization" : "out");
      let was = state(clerk);
      clerk.addListener(() => {
        if (!clerk || state(clerk) === was) return;
        was = state(clerk);
        void boot();
      });
    }
  } catch (failure) {
    fillProfile(null);
    return showError(new Error(failure instanceof Error ? failure.message : unavailable));
  }
  if (needsOrganization(clerk)) return showOrganization();
  if (!signedIn(clerk) || !api) return showSignedOut();
  leaveStandalone();
  trackPageview(clerk.user?.id);
  try {
    const [found, projects] = await Promise.all([api.get<Me>("/api/me"), api.get<Project[]>("/api/projects")]);
    const me: Account = { ...found, account: { ...found.account, name: found.account.name ?? clerk.organization?.name ?? "Your organization" } };
    accountId = me.account.id;
    const project = chooseProject(accountId, projects);
    projectId = project.id;
    fillProfile(me);
    fillProjects(me, project, projects);
    const ctx: Ctx = {
      api, me, project, projects, params, id: runId, toast, confirm: confirmDialog, download,
      go: (url) => location.assign(url),
      refresh: async () => { await render(ctx); void fillReview(ctx.api); },
    };
    void fillReview(api);
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

async function global(name: string, target: HTMLElement): Promise<void> {
  if (name === "project") {
    const chosen = target.dataset.project ?? DEFAULT_PROJECT;
    try { localStorage.setItem(projectKey(accountId), chosen); } catch { /* opens through the query instead */ }
    // A run's page belongs to its own project: switching opens the new project's runs.
    const url = new URL(runId ? "/" : location.pathname, location.origin);
    url.searchParams.set("project", chosen);
    return location.assign(url.toString());
  }
  if (name === "new-project") return newProject();
  if (!clerk) return void boot();
  if (name === "retry") return void boot();
  if (name === "sign-in") return clerk.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  if (name === "sign-out" && !signedIn(clerk)) return clerk.openSignIn({ forceRedirectUrl: location.href });
  if (name === "sign-out") return clerk.signOut();
  if (name === "sign-in-again") { await clerk.signOut({ redirectUrl: location.href }); }
  if (name === "organizations") showOrganization(true);
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const globalTarget = event.target.closest<HTMLElement>("[data-global]");
  if (globalTarget) { event.preventDefault(); void global(globalTarget.dataset.global ?? "", globalTarget).catch((failure) => toast(message(failure), true)); return; }
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
