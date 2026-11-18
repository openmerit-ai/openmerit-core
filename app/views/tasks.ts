import type { Task } from "../api.ts";
import { day, html, model, plural, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

function latest(task: Task): Html {
  const run = (text: Html | string): Html => (task.latestRunId ? html`<a href="/r/${task.latestRunId}/">${text}</a>` : html`${text}`);
  switch (task.status) {
    case "measuring": return html`<span class="pill">Measuring</span>`;
    case "switched": return run(task.monthlySavingUsd ? `Switched · saves ${usd(task.monthlySavingUsd)} a month` : "Switched");
    case "cheaper-fit": return html`<span class="pill good">Cheaper fit found</span><span class="sub">${run("View run")}</span>`;
    case "failed": return html`<span class="pill bad">Last run did not finish</span><span class="sub">${run("View run")}</span>`;
    default: return run("Keep current model");
  }
}

export const tasksView: View<Task[]> = {
  load: ({ api }) => api.get<Task[]>("/api/tasks"),
  render(tasks, { me }) {
    const watching = tasks.filter((task) => task.watching).length;
    const top = header(me, "Tasks", "OpenMerit re-runs each watched task's tests when a new model could fit it or prices change, and tells you when a cheaper model matches the one you use.", [plural(tasks.length, "task"), `${watching} watched`]);
    if (!tasks.length) return html`${top}<section aria-labelledby="tasks"><h2 id="tasks">All tasks</h2>${empty("No tasks yet", "A task appears the first time a coding agent asks OpenMerit which model it should use.")}</section>`;
    return html`${top}
    <section aria-labelledby="tasks">
      <h2 id="tasks">All tasks</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Model</th><th class="hide-sm">Last checked</th><th>Latest</th><th class="num">Watch</th></tr></thead>
          <tbody>
            ${tasks.map((task) => html`<tr>
              <td>${task.name}<span class="sub">${task.environment}${task.codeRef ? ` · ${task.codeRef}` : ""} · <a href="/guardrails/?level=task&amp;id=${encodeURIComponent(task.id)}">Guardrails</a></span></td>
              <td>${model(task.pick && task.status === "switched" ? task.pick : task.currentModel)}${task.status === "switched" && task.pick ? html`<span class="sub">was ${model(task.currentModel)}</span>` : ""}</td>
              <td class="hide-sm">${task.status === "measuring" ? "Running" : day(task.lastRunAt)}</td>
              <td>${latest(task)}</td>
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
