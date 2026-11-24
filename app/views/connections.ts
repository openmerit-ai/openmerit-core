// Coding agents: adding OpenMerit to a coding agent, and signing every one out; and GitHub: a member
// signed in with GitHub picks repositories from installations of the OpenMerit GitHub App, whose Setup
// URL returns here. A project's repositories and model endpoints are on its Project settings page.
import { ApiError, type GitHubAccess, type Project, type Repo } from "../api.ts";
import { clerkGlobals } from "../auth.ts";
import { html, logo, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { header, install } from "./common.ts";

// The cloud app can take a while to answer the first requests after a deploy, while it starts the
// account. A request that timed out or failed on the server is tried again before the page gives up.
export const RETRY_DELAYS_MS = [1000, 3000];
export async function retried<T>(load: () => Promise<T>, delays: readonly number[] = RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await load(); } catch (failure) {
      const transient = failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);
      if (!transient || attempt >= delays.length) throw failure;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

type Data = { github: GitHubAccess; repos: Repo[]; project: Project };

// The cloud app's plan check: repository reviews need a plan Stripe says is active or trialing.
const paid = (me: { plan: { status: string } }): boolean => me.plan.status === "active" || me.plan.status === "trialing";

function githubSection({ github, repos, project }: Data, admin: boolean, canAdd: boolean, params: URLSearchParams): Html {
  if (!github.app) return html``;
  const added = new Set(repos.map((repo) => repo.fullName.toLowerCase()));
  const install = (label: string) => html`<a class="btn${github.installations.length ? "" : " primary"}" href="${github.installUrl}" target="_blank" rel="noreferrer">${label}</a>`;
  // GitHub's Setup URL brings the member back here with installation_id and setup_action (install or update).
  const back = params.get("installation_id") ? html`<div class="card notice" role="status" style="margin: 0 0 12px"><p>${params.get("setup_action") === "update" ? "The OpenMerit GitHub App's repositories were updated." : "The OpenMerit GitHub App is installed."} Its repositories are below.</p></div>` : "";
  const body = !github.signedIn
    ? html`<div class="card"><p>Sign in with GitHub to pick repositories, private ones included, without making a token.</p>
        <p class="sub">OpenMerit then reads the repositories you give its GitHub App, with Contents read-only, through your GitHub sign-in.</p>
        <p style="margin-top: 10px"><button class="btn primary" type="button" data-action="connectGithub">Connect GitHub</button></p></div>`
    : github.error ? html`<div class="card notice bad" role="alert"><p>${github.error}</p></div>`
    : !github.installations.length ? html`<div class="card"><p>Install the OpenMerit GitHub App on your account or an organization, and choose the repositories OpenMerit may read. GitHub brings you back here.</p><p style="margin-top: 10px">${install("Install the GitHub App")}</p></div>`
    : html`<div class="card">${github.installations.map((item) => html`<div class="repo">
          <div class="row"><span>${logo("github")}${item.account}<span class="sub">${item.selection === "all" ? "Every repository" : plural(item.repos.length, "repository", "repositories")} · <a href="${item.manageUrl}" target="_blank" rel="noreferrer">Choose repositories on GitHub</a></span></span><span></span><span></span></div>
          ${item.repos.length ? html`<table class="calls"><tbody>${item.repos.map((repo) => html`<tr><td>${repo.fullName}</td><td>${repo.private ? html`<span class="pill tag">Private</span>` : ""}</td><td>${added.has(repo.fullName.toLowerCase()) ? html`<span class="sub">In ${project.name}</span>`
            : admin ? html`<button class="btn" type="button" data-action="addGithubRepo" data-repo="${repo.fullName}"${canAdd ? "" : html` disabled`} aria-label="Add ${repo.fullName} to ${project.name}">Add to ${project.name}</button>` : ""}</td></tr>`)}</tbody></table>` : html`<p class="sub">No repositories selected yet.</p>`}
        </div>`)}
        <p style="margin-top: 12px">${install("Install on another account or organization")}</p></div>`;
  return html`<section aria-labelledby="github">
      <h2 id="github">GitHub</h2>
      <p class="note" style="margin: -2px 0 8px">The OpenMerit GitHub App reads code only: Contents read-only. OpenMerit never pushes or opens a pull request. Public repositories and fine-grained tokens still work on <a href="/project/">Project settings</a>.</p>
      ${back}
      ${body}
      ${github.signedIn && !canAdd && admin ? html`<p class="note">Reviewing a repository needs an active plan. <a href="/plan/">Choose a plan</a> to add one.</p>` : ""}
      ${github.signedIn && !admin ? html`<p class="note">Only an admin can add repositories.</p>` : ""}
    </section>`;
}

export const connectionsView: View<Data> = {
  async load({ api, project }) {
    const [github, repos] = await Promise.all([retried(() => api.get<GitHubAccess>("/api/github")), retried(() => api.get<Repo[]>("/api/repos"))]);
    return { github, repos, project };
  },
  render(data, { me, params }) {
    const admin = me.role === "admin";
    return html`${header(me, "Coding agents", "Your coding agents are how OpenMerit gets its work: each asks which model a call should use, and gets the result with its evidence. A project's GitHub repositories and model endpoints are on its Project settings page.")}

    <section aria-labelledby="agents">
      <h2 id="agents">Coding Agents</h2>
      <div class="card">
        <p>Add OpenMerit to a coding agent:</p>
        <div style="margin-top: 8px">${install()}</div>
        <div class="row" style="margin-top: 10px"><span>Disconnect every coding agent<span class="sub">Signs out every coding agent session for ${me.account.name}. Each one's next call opens sign-in again. Tasks and runs are kept.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="disconnect">Disconnect</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
      <p class="note">To write your tasks' test cases on your own Claude or ChatGPT plan, sign in on <a href="/account/">Account settings</a>.</p>
    </section>

    ${githubSection(data, admin, paid(me), params)}`;
  },
  actions: {
    async addGithubRepo(target, { project }, { api, refresh, toast }) {
      const name = target.dataset.repo ?? "";
      try {
        await api.send<Repo>("POST", "/api/repos", { url: `https://github.com/${name}`, via: "github" });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400) throw failure;
        toast(failure.message);
        return;
      }
      await refresh();
      toast(`${name} added to ${project.name}. OpenMerit is reviewing its code; see Project settings.`);
    },
    // Links GitHub to the member's sign-in through Clerk, which sends the browser to GitHub and back here.
    async connectGithub(_target, _data, { toast }) {
      const user = clerkGlobals.Clerk?.user;
      const fallback = "Sign out, then sign in with GitHub to pick repositories.";
      if (!user?.createExternalAccount) { toast(fallback); return; }
      try {
        const linked = await user.createExternalAccount({ strategy: "oauth_github", redirectUrl: location.href });
        const next = linked.verification?.externalVerificationRedirectURL;
        if (next) { location.href = String(next); return; }
      } catch { /* such as GitHub already linked to another user */ }
      toast(fallback);
    },
    async disconnect(_target, _data, { api, toast, confirm, me }) {
      if (!await confirm({ title: "Disconnect every coding agent?", body: `Every coding agent signed in to ${me.account.name} loses access to OpenMerit's tools until it signs in again. Tasks, runs and watches are kept.`, confirm: "Disconnect", danger: true })) return;
      await api.send("POST", "/api/disconnect");
      toast("Coding agents disconnected. Their next call opens sign-in.");
    },
  },
};
