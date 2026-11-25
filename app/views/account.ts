// Account settings: the member's own ChatGPT subscription, which they sign in to once for every
// organization they belong to, and whether it writes the test cases of the runs they start. The page never sees a token: the cloud app keeps them encrypted.
import type { CaseWriter, Subscription, SubscriptionProvider, Subscriptions } from "../api.ts";
import { date, html, logo, type Html } from "../html.ts";
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

const POLL_MS = 3000;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

export const accountView: View<Subscriptions> = {
  load: ({ api }) => retried(() => api.get<Subscriptions>("/api/me/subscriptions")),
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
  render(data, { me }) {
    const connected = new Set(data.subscriptions.filter((item) => item.connected).map((item) => item.provider));
    return html`${header(me, "Account settings", "Your own settings, the same in every organization you belong to. Sign in to your ChatGPT plan, and it writes the test cases of the runs you start instead of OpenMerit's key.")}

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
    </section>`;
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
    async setWriter(target, _data, { api, refresh, toast }) {
      if (!(target instanceof HTMLSelectElement)) return;
      await api.send("PUT", "/api/me/case-writer", { writer: target.value });
      await refresh();
      toast("Saved.");
    },
  },
};
