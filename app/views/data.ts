import type { Endpoint, RunSummary, Task } from "../api.ts";
import { html, plural } from "../html.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";

interface Data { tasks: Task[]; runs: RunSummary[]; endpoints: Endpoint[] }

export const dataView: View<Data> = {
  async load({ api }) {
    const [tasks, runs, endpoints] = await Promise.all([api.get<Task[]>("/api/tasks"), api.get<RunSummary[]>("/api/runs"), api.get<Endpoint[]>("/api/endpoints")]);
    return { tasks, runs, endpoints };
  },
  render({ tasks, runs, endpoints }, { me }) {
    const keys = endpoints.filter((endpoint) => endpoint.keyLast4 !== null).length;
    const admin = me.role === "admin";
    return html`${header(me, "Your data", "What OpenMerit keeps, where it goes, and how to take it back.")}
    <section aria-labelledby="keeps">
      <h2 id="keeps">What OpenMerit keeps</h2>
      <div class="card">
        <div class="row"><span>Task context<span class="sub">The prompts, tool schemas, output shapes and examples your coding agents sent, with secrets redacted</span></span><span>${plural(tasks.length, "task")}</span></div>
        <div class="row"><span>Test cases and results<span class="sub">The cases OpenMerit wrote from that context, and each model's score per case</span></span><span>${plural(runs.length, "run")}</span></div>
        <div class="row"><span>Endpoint keys<span class="sub">Keys you added on Connections, stored encrypted and never shown again</span></span><span>${plural(keys, "key")}</span></div>
        <div class="row"><span>Repository code<span class="sub">Only what your agents sent. OpenMerit has no repository access.</span></span><span>None</span></div>
      </div>
    </section>
    <section aria-labelledby="where">
      <h2 id="where">Where it goes</h2>
      <div class="card">
        <p>Test cases go to the models measured for each task: through OpenRouter to the providers it routes to, and to the endpoints you added. OpenMerit runs on Rivet, Cloudflare, Clerk and Stripe.</p>
      </div>
    </section>
    <section aria-labelledby="control">
      <h2 id="control">Export or delete</h2>
      <div class="card">
        <div class="row"><span>Export<span class="sub">Every task, test case, run and setting for ${me.account.name} as JSON. Keys are not included.</span></span><button class="btn" type="button" data-action="export">Export</button></div>
        <div class="row"><span>Delete everything<span class="sub">Deletes every task, test case, run, guardrail, endpoint and key for ${me.account.name}. Run pages and public links stop loading. This cannot be undone.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="delete">Delete all data</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
    </section>`;
  },
  actions: {
    async export(_target, _data, { api, me, download, toast }) {
      const data = await api.send<unknown>("POST", "/api/account/export");
      download(`openmerit-${me.account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`, data);
      toast("Export downloaded.");
    },
    async delete(_target, _data, { api, me, confirm, go }) {
      const ok = await confirm({
        title: `Delete everything for ${me.account.name}?`,
        body: "Every task, test case, run, guardrail, endpoint and key is deleted and cannot be restored.",
        confirm: "Delete everything", danger: true, typeToConfirm: me.account.name,
      });
      if (!ok) return;
      await api.send("DELETE", "/api/account");
      go("/?deleted=1");
    },
  },
};
