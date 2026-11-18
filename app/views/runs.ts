import type { RunSummary, Task } from "../api.ts";
import { agent, day, html, model, plural, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

export function outcome(run: RunSummary): Html {
  if (run.status === "running") return html`<span class="pill">Measuring</span>${run.provisional ? html`<span class="sub">provisional pick: ${model(run.provisional)}</span>` : ""}`;
  if (run.status === "failed") return html`<span class="pill bad">Did not finish</span><span class="sub">no recommendation</span>`;
  if (run.outcome === "switch" && run.pick) return html`Switch to ${model(run.pick)}<span class="sub">from ${model(run.current)}${run.savingPct !== null ? ` · saves ${Math.round(run.savingPct)}%` : ""}</span>`;
  if (run.outcome === "cheaper" && run.pick) return html`<span class="pill good">Cheaper fit found</span><span class="sub">${model(run.pick)} · not applied yet</span>`;
  return html`Keep ${model(run.current)}<span class="sub">no cheaper model matched it</span>`;
}

const basisLabels: Record<string, string> = { context: "Context from agent", code: "Code", traces: "Production traces", eval: "Your eval" };
const basis = (run: RunSummary): string => run.basis.map((item) => basisLabels[item] ?? item).join(", ") || "–";

export const runsView: View<{ runs: RunSummary[]; tasks: Task[] }> = {
  async load({ api }) {
    const [runs, tasks] = await Promise.all([api.get<RunSummary[]>("/api/runs"), api.get<Task[]>("/api/tasks")]);
    return { runs, tasks };
  },
  render({ runs, tasks }, { me }) {
    const top = header(me, "Runs", "Each time a coding agent asks which model to use, OpenMerit runs the task's tests on the candidates and the answer lands here with its evidence. Link a run in a pull request so reviewers can see why.", [plural(tasks.length, "task"), plural(runs.length, "run")]);
    if (!runs.length) return html`${top}<section aria-labelledby="all"><h2 id="all">All runs</h2>${empty("No runs yet", "Add OpenMerit to a coding agent, then ask it which model a task should use. The run and its evidence appear here.")}</section>`;
    const saving = tasks.reduce((sum, task) => sum + (task.status === "switched" ? task.monthlySavingUsd ?? 0 : 0), 0);
    const month = new Date().toISOString().slice(0, 7);
    const recent = runs.filter((run) => (run.measuredAt ?? run.startedAt).startsWith(month));
    const count = (test: (run: RunSummary) => boolean): number => recent.filter(test).length;
    const breakdown = [
      [count((run) => run.outcome === "switch"), "switched"], [count((run) => run.outcome === "keep"), "kept"],
      [count((run) => run.outcome === "cheaper"), "cheaper fit waiting"], [count((run) => run.status === "running"), "running"],
      [count((run) => run.status === "failed"), "did not finish"],
    ].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(", ");
    const plan = me.plan;
    return html`${top}
    <section aria-labelledby="summary">
      <h2 id="summary">This month</h2>
      <div class="grid3">
        <div class="card"><span class="big">${usd(saving)}</span><span class="sub">estimated monthly saving from switches you applied</span></div>
        <div class="card"><span class="big">${recent.length}</span><span class="sub">${recent.length === 1 ? "run" : "runs"}${breakdown ? ` · ${breakdown}` : ""}</span></div>
        <div class="card">${plan && plan.status !== "none"
          ? html`<span class="big">${plan.usedEvals} / ${plan.includedEvals}</span><span class="sub">evaluations used on the ${plan.name} plan</span>`
          : html`<span class="big">No plan</span><span class="sub"><a href="/plan/">Choose a plan</a> to measure new tasks</span>`}</div>
      </div>
    </section>
    <section aria-labelledby="all">
      <h2 id="all">All runs</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Outcome</th><th class="hide-sm">Based on</th><th class="hide-sm">Asked by</th><th class="num">Measured</th></tr></thead>
          <tbody>
            ${runs.map((run) => html`<tr><td><a href="/r/${run.id}/">${run.task}</a><span class="sub">${run.environment}</span></td><td>${outcome(run)}</td><td class="hide-sm">${basis(run)}</td><td class="hide-sm">${agent(run.requestedBy)}</td><td class="num">${run.status === "running" ? "Running" : day(run.measuredAt)}</td></tr>`)}
          </tbody>
        </table>
      </div>
    </section>`;
  },
};
