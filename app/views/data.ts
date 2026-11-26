import type { DeletedTask, Endpoint, EvalView, Run, Task } from "../api.ts";
import { ago, html, plural } from "../html.ts";
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
        <div class="row"><span>Task context<span class="sub">The prompts, tool schemas, output shapes and examples your coding agents sent, with secrets redacted</span></span><span style="white-space: nowrap">${plural(tasks.length, "task")}</span></div>
        <div class="row"><span>Evals and results<span class="sub">Each task's eval, every version of its cases and what the judge checks, and each model's score per case. Cases can hold real inputs from your examples, with secrets redacted. A run you grade also keeps the answers it showed you, up to 12 a round with secrets redacted, and your grades and notes</span></span><span style="white-space: nowrap">${plural(runs.length, "run")}</span></div>
        <div class="row"><span>Endpoint keys<span class="sub">Keys you added on Coding agents and endpoints, stored encrypted and never shown again</span></span><span style="white-space: nowrap">${plural(keys, "key")}</span></div>
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
      <p class="note">Deletes the task's context, its eval with every version, its runs and run pages. To stop OpenMerit using a task but keep its eval and history, retire it instead. A coding agent that asks about the task again starts it afresh.</p>
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
      download(`openmerit-${me.account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`, data);
      toast("Export downloaded.");
    },
    async deleteTask(target, { runs, tasks }, { api, confirm, refresh, toast }) {
      const { id = "", name = "" } = target.dataset;
      const evaluation = await api.get<EvalView>(`/api/tasks/${encodeURIComponent(id)}/eval`).catch((): null => null);
      const latest = evaluation?.accepted, count = runs.filter((run) => run.taskId === id).length;
      const retired = tasks.find((task) => task.id === id)?.state === "retired";
      const ok = await confirm({
        title: `Delete ${name}?`,
        body: "Deleting cannot be undone. It:",
        items: [
          latest ? `Deletes its eval: accepted version ${latest.version} with ${plural(latest.cases.length, "case")}${evaluation.draft ? ", and the draft under review" : ""}` : "Deletes its task context",
          `Deletes ${plural(count, "run")} with their reports, run pages and decisions`,
        ],
        ...(retired ? {} : { alternative: "Retire instead" }),
        confirm: "Delete task", danger: true, typeToConfirm: name,
      });
      if (ok === "alternative") {
        await api.send("POST", `/api/tasks/${encodeURIComponent(id)}/retire`);
        await refresh();
        return toast(`${name} retired. Its eval and runs are kept.`);
      }
      if (!ok) return;
      await api.send("DELETE", `/api/tasks/${encodeURIComponent(id)}`);
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
      go("/?deleted=1");
    },
  },
};
