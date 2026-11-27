// Account settings: the member's own connections, made once for every organization they belong to: their
// ChatGPT subscription, and whether it writes the test cases of the runs they start, and GitHub, whose
// OpenMerit GitHub App installations each project picks repositories from. The page never sees a token.
import type { CaseWriter, GitHubAccess, Subscription, SubscriptionProvider, Subscriptions } from "../api.ts";
import { clerkGlobals } from "../auth.ts";
import { date, html, logo, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";
import { retried } from "./connections.ts";

const plans: Record<SubscriptionProvider, { plan: string; logo: string; site: string }> = {
  chatgpt: { plan: "ChatGPT Plus or Pro", logo: "openai", site: "chatgpt.com" },
};

function signIn(item: Subscription): Html {
  const started = item.signIn;
  if (!started) return html``;
  return html`<div class="sign-in">
          <ol class="steps">
            <li>Open <a href="${started.verificationUri}" target="_blank" rel="noreferrer">${started.verificationUri.replace(/^https:\/\//, "")}</a> and sign in with the account that has your ChatGPT plan.</li>
            <li>Enter this code: <code class="device-code">${started.userCode}</code></li>
          </ol>
          <p class="sub"><span class="pill live">Waiting</span> This page connects once you enter the code. It expires 15 minutes after you start.</p>
          <p><button class="btn" type="button" data-action="disconnect" data-provider="chatgpt">Cancel</button></p>
        </div>`;
}

function row(item: Subscription): Html {
  const { plan, logo: mark } = plans[item.provider];
  const status = item.connected
    ? html`<span class="pill tag good">Connected</span>${item.connectedAt ? html`<span class="sub">Since ${date(item.connectedAt)}</span>` : ""}`
    : item.signIn ? html`<span class="pill tag">Signing in</span>` : html`<span class="pill tag">Not connected</span>`;
  const action = item.connected
    ? html`<button class="btn danger" type="button" data-action="disconnect" data-provider="${item.provider}" aria-label="Disconnect ${item.name}">Disconnect</button>`
    : item.signIn ? html`<span></span>` : html`<button class="btn primary" type="button" data-action="startChatgpt">Sign in with ${item.name}</button>`;
  return html`<div class="repo">
        <div class="row">
          <span>${logo(mark)}${item.name}<span class="sub">${plan}</span>${item.problem ? html`<span class="sub no">${item.problem}</span>` : ""}</span>
          <span class="endpoint-meta">${status}</span>
          ${action}
        </div>
        ${signIn(item)}
      </div>`;
}

const writers: { value: CaseWriter; label: string }[] = [
  { value: "openmerit", label: "OpenMerit's key (OpenMerit pays)" },
  { value: "chatgpt", label: "My ChatGPT subscription" },
];

// GitHub: connect it to the OpenMerit sign-in through Clerk, then install the OpenMerit GitHub App and choose its
// repositories on GitHub, whose Setup URL brings the member back with installation_id and setup_action.
function githubSection(github: GitHubAccess, params: URLSearchParams): Html {
  if (!github.app) return html``;
  const install = (label: string) => html`<a class="btn${github.installations.length ? "" : " primary"}" href="${github.installUrl ?? ""}" target="_blank" rel="noreferrer">${label}</a>`;
  const back = params.get("installation_id") ? html`<div class="card notice" role="status" style="margin: 0 0 12px"><p>${params.get("setup_action") === "update" ? "The OpenMerit GitHub App's repositories were updated." : "The OpenMerit GitHub App is installed."} Add its repositories to a project in Project settings.</p></div>` : "";
  const body = !github.signedIn
    ? html`<div class="card"><div class="row"><span>${logo("github")}GitHub<span class="sub">Connect GitHub to add repositories, private ones included, to your projects without a token.</span></span><span class="endpoint-meta"><span class="pill tag">Not connected</span></span><button class="btn primary" type="button" data-action="connectGithub">Connect GitHub</button></div></div>`
    : github.error ? html`<div class="card notice bad" role="alert"><p>${github.error}</p></div>`
    : !github.installations.length ? html`<div class="card"><div class="row"><span>${logo("github")}GitHub<span class="sub">Install the OpenMerit GitHub App on your account or an organization, and choose the repositories OpenMerit may read.</span></span><span class="endpoint-meta"><span class="pill tag good">Connected</span></span>${install("Install the GitHub App")}</div></div>`
    : html`<div class="card">${github.installations.map((item) => html`<div class="repo">
          <div class="row"><span>${logo("github")}${item.account}<span class="sub">${item.selection === "all" ? "Every repository" : plural(item.repos.length, "repository", "repositories")}: ${item.repos.slice(0, 5).map((repo) => repo.fullName).join(", ")}${item.repos.length > 5 ? ` and ${item.repos.length - 5} more` : ""}</span></span><span class="endpoint-meta"><span class="pill tag good">Connected</span></span><a class="btn" href="${item.manageUrl}" target="_blank" rel="noreferrer">Choose repositories</a></div>
        </div>`)}
        <p style="margin-top: 12px">${install("Install on another account or organization")}</p></div>`;
  return html`<section aria-labelledby="github">
      <h2 id="github">GitHub</h2>
      <p class="note" style="margin: -2px 0 8px">The OpenMerit GitHub App reads code only: Contents read-only. OpenMerit never pushes or opens a pull request. Each project adds the repositories it reviews in Project settings.</p>
      ${back}${body}
    </section>`;
}

type Data = Subscriptions & { github: GitHubAccess };

const POLL_MS = 3000;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

export const accountView: View<Data> = {
  async load({ api }) {
    const [subscriptions, github] = await Promise.all([retried(() => api.get<Subscriptions>("/api/me/subscriptions")), retried(() => api.get<GitHubAccess>("/api/github"))]);
    return { ...subscriptions, github };
  },
  bind(root, { api, refresh, toast }, data) {
    // While a ChatGPT code waits to be entered, the page asks the cloud app to check every few seconds.
    clearTimeout(pollTimer);
    if (!data.subscriptions.some((item) => item.provider === "chatgpt" && item.signIn)) return;
    pollTimer = setTimeout(() => {
      if (!root.isConnected) return;
      api.send<{ status: string }>("POST", "/api/me/subscriptions/chatgpt/poll").then(async (polled) => {
        if (polled.status === "connected") toast("ChatGPT connected.");
        await refresh();
      }, async (failure: unknown) => {
        toast(failure instanceof Error ? failure.message : "The ChatGPT sign-in failed.");
        await refresh();
      });
    }, POLL_MS);
  },
  render(data, { me, params }) {
    const connected = new Set(data.subscriptions.filter((item) => item.connected).map((item) => item.provider));
    return html`${header(me, "Account settings", "Your own settings, the same in every organization you belong to. Sign in to your ChatGPT plan, and it writes the test cases of the runs you start instead of OpenMerit's key. Connect GitHub, and your projects add repositories from it.")}

    <section aria-labelledby="subscriptions">
      <h2 id="subscriptions">Subscriptions</h2>
      <p class="note" style="margin: -2px 0 8px">The sign-in is the one Codex uses. OpenMerit keeps its tokens encrypted, never shows them, and uses them only to write your tasks' test cases. Those calls count toward your plan's usage limits.</p>
      <div class="card">${data.subscriptions.map(row)}</div>
    </section>

    <section aria-labelledby="writer">
      <h2 id="writer">Test Cases</h2>
      <div class="card">
        <div class="row">
          <span>Write test cases with<span class="sub">For the runs you start from a coding agent. A watch run reuses the cases you approved and writes none. The judge that grades every model stays on OpenMerit's key, so each candidate is graded the same way.</span></span>
          <select name="writer" data-action="setWriter" aria-label="Write test cases with">${writers.map((item) => html`<option value="${item.value}"${item.value === data.writer ? html` selected` : ""}${item.value !== "openmerit" && !connected.has(item.value) ? html` disabled` : ""}>${item.label}</option>`)}</select>
        </div>
      </div>
    </section>

    ${githubSection(data.github, params)}`;
  },
  actions: {
    async startChatgpt(_target, _data, { api, refresh }) {
      await api.send("POST", "/api/me/subscriptions/chatgpt");
      await refresh();
    },
    async disconnect(target, data, { api, refresh, confirm }) {
      const item = data.subscriptions.find((entry) => entry.provider === target.dataset.provider);
      if (!item) return;
      if (item.connected && !await confirm({ title: `Disconnect ${item.name}?`, body: `OpenMerit deletes the ${item.name} sign-in. The runs you start write their cases on OpenMerit's key until you sign in again.`, confirm: "Disconnect", danger: true })) return;
      await api.send("DELETE", `/api/me/subscriptions/${item.provider}`);
      await refresh();
    },
    // Links GitHub to the member's sign-in through Clerk, which sends the browser to GitHub and back here.
    async connectGithub(_target, _data, { toast }) {
      const user = clerkGlobals.Clerk?.user;
      const fallback = "GitHub could not be connected. Sign out, then sign in with GitHub.";
      if (!user?.createExternalAccount) { toast(fallback); return; }
      try {
        const linked = await user.createExternalAccount({ strategy: "oauth_github", redirectUrl: location.href });
        const next = linked.verification?.externalVerificationRedirectURL;
        if (next) { location.href = String(next); return; }
      } catch { /* such as GitHub already linked to another user */ }
      toast(fallback);
    },
    async setWriter(target, _data, { api, refresh, toast }) {
      if (!(target instanceof HTMLSelectElement)) return;
      await api.send("PUT", "/api/me/case-writer", { writer: target.value });
      await refresh();
      toast("Saved.");
    },
  },
};
