import type { Task } from "../api.ts";
import { day, html, model, plural } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";
import { result } from "./runs.ts";

const guardrails = (level: string, id: string, text: string) => html`<a href="/guardrails/?level=${level}&amp;id=${encodeURIComponent(id)}">${text}</a>`;

export const tasksView: View<Task[]> = {
  load: ({ api }) => api.get<Task[]>("/api/tasks"),
  render(tasks, { me }) {
    const watching = tasks.filter((task) => task.watching).length;
    const top = header(me, "Tasks", "OpenMerit re-runs each watched task's tests when a new model could fit it or prices change, and tells you when a cheaper model matches the one you use.", [plural(tasks.length, "task"), `${watching} watched`]);
    if (!tasks.length) return html`${top}<section aria-labelledby="tasks"><h2 id="tasks">All Tasks</h2>${empty("No tasks yet", "A task appears the first time a coding agent asks OpenMerit which model it should use.")}</section>`;
    return html`${top}
    <section aria-labelledby="tasks">
      <h2 id="tasks">All Tasks</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Model in use</th><th>Last run</th><th>Latest</th><th class="num">Watch</th></tr></thead>
          <tbody>
            ${tasks.map((task) => html`<tr>
              <td>${task.name}<span class="sub">${task.environment}${task.agent ? html` · agent ${guardrails("agent", `${task.environment}:${task.agent}`, task.agent)}` : ""} · ${guardrails("task", task.id, "Guardrails")}</span></td>
              <td>${model(task.currentModel)}</td>
              <td>${task.status === "running" ? "Running" : day(task.lastRunAt)}</td>
              <td>${result(task, (text) => (task.lastJobId ? html`<a href="/r/${task.lastJobId}/">${text}</a>` : html`${text}`))}</td>
              <td class="num">${task.watching
                ? html`<button class="btn" type="button" data-action="watch" data-id="${task.id}" data-on="false" aria-label="Stop watching ${task.name}">Stop watching</button>`
                : html`<span class="sub">Not watched</span><button class="btn" type="button" data-action="watch" data-id="${task.id}" data-on="true" aria-label="Watch ${task.name}">Watch</button>`}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      <p class="note">Stopping a watch keeps the task's runs. Your coding agent's next OpenMerit call says when a watched task has a new result.</p>
    </section>`;
  },
  actions: {
    async watch(target, _tasks, { api, refresh, toast }) {
      const on = target.dataset.on === "true";
      await api.send("POST", `/api/tasks/${encodeURIComponent(target.dataset.id ?? "")}/watch`, { on });
      await refresh();
      toast(on ? "Watching again." : "Stopped watching. Its runs are kept.");
    },
  },
};
