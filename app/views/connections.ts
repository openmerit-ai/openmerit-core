// Coding agents: adding OpenMerit to a coding agent, and signing every one out. A project's
// repositories and model endpoints are on its Project settings page.
import { ApiError } from "../api.ts";
import { html } from "../html.ts";
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

export const connectionsView: View<null> = {
  load: async () => null,
  render(_data, { me }) {
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
    </section>`;
  },
  actions: {
    async disconnect(_target, _data, { api, toast, confirm, me }) {
      if (!await confirm({ title: "Disconnect every coding agent?", body: `Every coding agent signed in to ${me.account.name} loses access to OpenMerit's tools until it signs in again. Tasks, runs and watches are kept.`, confirm: "Disconnect", danger: true })) return;
      await api.send("POST", "/api/disconnect");
      toast("Coding agents disconnected. Their next call opens sign-in.");
    },
  },
};
