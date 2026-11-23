import type { Decision, Task, TaskState } from "../api.ts";
import { date, day, html, model, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";
import { result } from "./runs.ts";

const guardrails = (level: string, id: string, text: string) => html`<a href="/guardrails/?level=${level}&amp;id=${encodeURIComponent(id)}">${text}</a>`;

// Watching is automatic; the cloud app reports why a task is not watched. Before it sends state,
// a task that is not watching is taken as frozen by its watch guardrail.
const stateOf = (task: Task): TaskState => task.state ?? (task.watching ? "watching" : "frozen");
const states: Record<TaskState, (task: Task) => Html> = {
  watching: () => html`<span class="pill good">Watching</span>`,
  idle: (task) => html`<span class="pill">Idle</span><span class="sub">no call since ${day(task.idleSince ?? task.lastRunAt)}</span>`,
  frozen: (task) => html`<span class="pill tag">Frozen</span><span class="sub">${guardrails("task", task.id, "watch guardrail off")}</span>`,
  retired: () => html`<span class="pill tag">Retired</span>`,
};

/** What the user decided in their coding agent about the task's latest change, or that the agent has not sent it yet. */
export const decisionText = (decision: Decision): string =>
  `${decision.decision === "approved" ? "Approved" : "Declined"} in the coding agent by ${decision.name ?? decision.by} on ${date(decision.at)}`;
function decided(task: Task): Html {
  if (task.decision && (task.decision.decision === "approved" || task.decision.jobId === task.lastJobId)) return html`<span class="sub">${decisionText(task.decision)}</span>`;
  return task.pick ? html`<span class="sub">Waiting for a decision in the coding agent</span>` : html``;
}

function table(tasks: Task[]): Html {
  return html`<div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Model in use</th><th>Last run</th><th>Latest</th><th>Watch</th></tr></thead>
          <tbody>
            ${tasks.map((task) => html`<tr>
              <td>${task.name}<span class="sub">${task.environment}${task.agent ? html` · agent ${guardrails("agent", `${task.environment}:${task.agent}`, task.agent)}` : ""} · ${guardrails("task", task.id, "Guardrails")}</span></td>
              <td>${model(task.currentModel)}</td>
              <td>${task.status === "running" ? "Running" : day(task.lastRunAt)}</td>
              <td>${result(task, (text) => (task.lastJobId ? html`<a href="/r/${task.lastJobId}/">${text}</a>` : html`${text}`))}${decided(task)}</td>
              <td>${states[stateOf(task)](task)}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>`;
}

type Data = { tasks: Task[] };

export const tasksView: View<Data> = {
  async load({ api }) {
    return { tasks: await api.get<Task[]>("/api/tasks") };
  },
  render({ tasks: all }, { me }) {
    const tasks = all.filter((task) => stateOf(task) !== "retired"), retired = all.filter((task) => stateOf(task) === "retired");
    const watching = all.filter((task) => stateOf(task) === "watching").length;
    const top = header(me, "Tasks", "OpenMerit watches every task: it re-runs a task's tests when a new model could fit it or prices change, and tells you when a cheaper model matches the one you use.", [plural(tasks.length, "task"), `${watching} watched`]);
    if (!all.length) return html`${top}<section aria-labelledby="tasks"><h2 id="tasks">All Tasks</h2>${empty("No tasks yet", "A task appears the first time a coding agent asks OpenMerit which model it should use.")}</section>`;
    return html`${top}
    <section aria-labelledby="tasks">
      <h2 id="tasks">All Tasks</h2>
      ${table(tasks)}
      <p class="note">A task goes idle after 30 days without a call from a coding agent, and its next call resumes the watch. A <code>watch</code> guardrail set to off freezes the model choice. Your coding agent retires a task when it removes the call; its runs are kept.</p>
    </section>
    ${retired.length ? html`<section aria-labelledby="retired">
      <details><summary id="retired">${plural(retired.length, "retired task")}</summary>${table(retired)}</details>
    </section>` : ""}`;
  },
};
