// Review evals: tasks whose eval waits for review (the task changed, or someone revised it), which link to
// the task's Eval tab. The sidebar shows this page only while one waits.
import type { Task } from "../api.ts";
import { html, plural } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

type Data = { tasks: Task[] };

export const evalsView: View<Data> = {
  async load({ api }) {
    const tasks = await api.get<Task[]>("/api/tasks");
    return { tasks: tasks.filter((task) => task.state === "review") };
  },
  title: ({ tasks }) => `Review evals (${tasks.length})`,
  render({ tasks }, { me }) {
    const top = header(me, "Review evals", "A task's eval waits here for a person when the task changed or someone revised it. Check what the judge looks for and each case's expected answer, then accept it.", [plural(tasks.length, "eval")]);
    if (!tasks.length) return html`${top}<section>${empty("Nothing to review", "A task's eval appears here when your coding agent sends the task with a different prompt, tools or output.", html`<p><a class="btn" href="/tasks/">Tasks</a></p>`)}</section>`;
    return html`${top}<section aria-labelledby="changed">
      <h2 id="changed">Tasks waiting for their eval</h2>
      <div class="card">${tasks.map((task) => html`<div class="row"><span><a href="/tasks/?task=${encodeURIComponent(task.id)}&amp;tab=eval">${task.name}</a><span class="sub">${task.environment} · no runs until its eval is accepted</span></span><a class="btn" href="/tasks/?task=${encodeURIComponent(task.id)}&amp;tab=eval">Review</a></div>`)}</div>
    </section>`;
  },
};
