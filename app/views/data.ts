import type { DeletedTask, Endpoint, Run, Task } from "../api.ts";
import { ago, html, plural } from "../html.ts";
import posthog, { isPostHogInitialized } from "../posthog.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";

interface Data { tasks: Task[]; runs: Run[]; endpoints: Endpoint[]; deleted: DeletedTask[] }

export const dataView: View<Data> = {
  async load({ api }) {
    // The deletion log is extra: the page still shows without it.
    const [tasks, runs, endpoints, deleted] = await Promise.all([api.get<Task[]>("/api/tasks"), api.get<Run[]>("/api/runs"), api.get<Endpoint[]>("/api/endpoints"), api.get<DeletedTask[]>("/api/tasks/deleted").catch((): DeletedTask[] => [])]);
    return { tasks, runs, endpoints, deleted };
  },
  render({ tasks, runs, endpoints, deleted }, { me }) {
    const keys = endpoints.filter((endpoint) => !endpoint.builtIn).length;
    const admin = me.role === "admin";
    const count = (id: string) => runs.filter((run) => run.taskId === id).length;
    return html`${header(me, "Your data", "What OpenMerit keeps, where it goes, and how to take it back.")}
    <section aria-labelledby="keeps">
      <h2 id="keeps">What OpenMerit Keeps</h2>
      <div class="card">
        <div class="row"><span>Task context<span class="sub">The prompts, tool schemas, output shapes and examples your coding agents sent, with secrets redacted</span></span><span>${plural(tasks.length, "task")}</span></div>
        <div class="row"><span>Test cases and results<span class="sub">The cases OpenMerit wrote from that context, and each model's score per case</span></span><span>${plural(runs.length, "run")}</span></div>
        <div class="row"><span>Endpoint keys<span class="sub">Keys you added on Connections, stored encrypted and never shown again</span></span><span>${plural(keys, "key")}</span></div>
        <div class="row"><span>Repository code<span class="sub">Only what your agents sent. OpenMerit has no repository access.</span></span><span>None</span></div>
      </div>
    </section>
    <section aria-labelledby="where">
      <h2 id="where">Where It Goes</h2>
      <div class="card">
        <p>Test cases go to the models measured for each task: through OpenRouter to the providers it routes to, and to the endpoints you added. OpenMerit runs on Rivet, Cloudflare, Clerk and Stripe.</p>
      </div>
    </section>
    <section aria-labelledby="control">
      <h2 id="control">Export or Delete</h2>
      <div class="card">
        <div class="row"><span>Export<span class="sub">Every task, test case, run and setting for ${me.account.name} as JSON. Keys are not included.</span></span><button class="btn" type="button" data-action="export">Export</button></div>
        <div class="row"><span>Delete everything<span class="sub">Deletes every task, test case, run, guardrail, endpoint and key for ${me.account.name}. Run pages and public links stop loading. This cannot be undone.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="delete">Delete all data</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
    </section>
    ${tasks.length ? html`<section aria-labelledby="delete-task">
      <h2 id="delete-task">Delete a Task</h2>
      <div class="card">
        ${tasks.map((task) => html`<div class="row"><span>${task.name}<span class="sub">${task.environment} · ${plural(count(task.id), "run")}${task.state === "retired" ? " · retired" : ""}</span></span>${admin ? html`<button class="btn danger" type="button" data-action="deleteTask" data-id="${task.id}" data-name="${task.name}" aria-label="Delete ${task.name}">Delete</button>` : html`<span class="sub">Admins only</span>`}</div>`)}
      </div>
      <p class="note">Deletes the task's context, test cases, runs and run pages. To stop OpenMerit using a task but keep its history, have your coding agent retire it instead. A coding agent that asks about the task again starts it afresh.</p>
    </section>` : ""}
    ${deleted.length ? html`<section aria-labelledby="deleted">
      <h2 id="deleted">Deleted Tasks</h2>
      <div class="card">
        ${deleted.map((item) => html`<div class="row"><span>${item.name}<span class="sub">${item.environment} · ${plural(item.jobs, "run")} · by ${item.userId === me.user.id ? "you" : item.userId}</span></span><span class="sub">${ago(item.deletedAt)}</span></div>`)}
      </div>
    </section>` : ""}`;
  },
  actions: {
    async export(_target, _data, { api, me, download, toast }) {
      const data = await api.send<unknown>("POST", "/api/account/export");
      if (isPostHogInitialized()) posthog.capture("data_exported");
      download(`openmerit-${me.account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`, data);
      toast("Export downloaded.");
    },
    async deleteTask(target, _data, { api, confirm, refresh, toast }) {
      const { id = "", name = "" } = target.dataset;
      const ok = await confirm({
        title: `Delete ${name}?`,
        body: "Its task context, test cases, runs and run pages are deleted and cannot be restored. Links to its runs stop loading. Its spend still counts toward this period's evaluations and caps. You may be asked to confirm it's you.",
        confirm: "Delete task", danger: true, typeToConfirm: name,
      });
      if (!ok) return;
      await api.send("DELETE", `/api/tasks/${encodeURIComponent(id)}`);
      if (isPostHogInitialized()) posthog.capture("task_deleted");
      await refresh();
      toast(`${name} deleted.`);
    },
    async delete(_target, _data, { api, me, confirm, go }) {
      const ok = await confirm({
        title: `Delete everything for ${me.account.name}?`,
        body: "Every task, test case, run, guardrail, endpoint and key is deleted and cannot be restored.",
        confirm: "Delete everything", danger: true, typeToConfirm: me.account.name,
      });
      if (!ok) return;
      await api.send("DELETE", "/api/account");
      if (isPostHogInitialized()) posthog.capture("account_data_deleted");
      go("/?deleted=1");
    },
  },
};
