import type { Run, Task } from "../api.ts";
import { day, harness, html, logo, model, per1k, plural, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

// A result in the words the pages use: a task's latest one, or any finished run's.
function describe(found: { status: string; pick: string | null; current: string; saving: string }, link: (text: Html | string) => Html): Html {
  switch (found.status) {
    case "new": return html`<span class="sub">Not measured yet</span>`;
    case "running": return html`<span class="pill">Measuring</span>`;
    case "picked": return found.pick
      ? html`${link(html`Switch to ${model(found.pick)}`)}<span class="sub">from ${model(found.current)}${found.saving ? ` · ${found.saving}` : ""}</span>`
      : link("Cheaper model found");
    case "keep_current": return html`${link(html`Keep ${model(found.current)}`)}<span class="sub">no cheaper model passed as many cases</span>`;
    case "agent_eval_failed": return html`${link("Keep the current models")}<span class="sub">every cheaper switch failed the agent's eval</span>`;
    case "no_candidates": return html`${link("Keep the current model")}<span class="sub">no allowed model is cheaper</span>`;
    case "no_cases": return html`<span class="pill warn">No usable cases</span><span class="sub">${link("no case had a known answer")}</span>`;
    case "baseline_failed": return html`<span class="pill warn">Current model not measured</span><span class="sub">${link("nothing to compare against")}</span>`;
    case "stopped": return html`<span class="pill">Stopped</span><span class="sub">${link("View run")}</span>`;
    default: return html`<span class="pill bad">Did not finish</span><span class="sub">${link("View run")}</span>`;
  }
}

// A task's latest result. The cloud app records the job's result status on the task, or the
// job's own status when it ended without one.
export const result = (task: Task, link: (text: Html | string) => Html = (text) => html`${text}`): Html =>
  describe({ status: task.status, pick: task.pick, current: task.currentModel, saving: task.monthlySavingUsd ? `saves about ${usd(task.monthlySavingUsd)} a month` : "" }, link);

const jobStatus: Record<string, Html> = {
  queued: html`<span class="pill">Queued</span>`,
  running: html`<span class="pill">Measuring</span>`,
  needs_input: html`<span class="pill warn">Waiting for your answer</span><span class="sub">in your coding agent</span>`,
  failed: html`<span class="pill bad">Did not finish</span>`,
  stopped: html`<span class="pill">Stopped</span>`,
};

// Each finished run says what its report found. The task's latest run also shows the monthly
// saving, which the task estimates from its traffic; older runs show the saving per 1,000 calls.
function outcome(run: Run, task: Task | undefined): Html {
  if (run.status !== "done") return jobStatus[run.status] ?? html`${run.status}`;
  if (task && task.lastJobId === run.id) return result(task);
  const found = run.result;
  if (!found) return html`<span class="sub">Done</span>`;
  const saving = found.savingPerCallUsd ? `saves ${per1k(found.savingPerCallUsd)} per 1,000 calls` : "";
  return describe({ status: found.status, pick: found.model, current: found.from ?? task?.currentModel ?? "", saving }, (text) => html`${text}`);
}

// Who started the run: the coding agent that asked, by the name its MCP client sent, or a watch.
function askedBy(run: Run): Html {
  if (run.kind === "watch") return html`<span class="sub">Watch re-run</span>`;
  if (!run.askedBy) return html`Coding agent`;
  const found = harness(run.askedBy);
  return html`${logo(found.logo)}${found.name}${found.custom ? html`<span class="sub">custom harness</span>` : ""}`;
}

export const runsView: View<{ runs: Run[]; tasks: Task[] }> = {
  async load({ api }) {
    const [runs, tasks] = await Promise.all([api.get<Run[]>("/api/runs"), api.get<Task[]>("/api/tasks")]);
    return { runs, tasks };
  },
  render({ runs, tasks }, { me }) {
    const top = header(me, "Runs", "Each time a coding agent asks which model to use, OpenMerit runs the task's tests on the candidates and the answer lands here with its evidence. Link a run in a pull request so reviewers can see why.", [plural(tasks.length, "task"), plural(runs.length, "run")]);
    if (!runs.length) return html`${top}<section aria-labelledby="all"><h2 id="all">All runs</h2>${empty("No runs yet", "Add OpenMerit to a coding agent, then ask it which model a task should use. The run and its evidence appear here.")}</section>`;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const saving = tasks.reduce((sum, task) => sum + (task.status === "picked" ? task.monthlySavingUsd ?? 0 : 0), 0);
    const month = new Date().toISOString().slice(0, 7);
    const recent = runs.filter((run) => run.startedAt.startsWith(month));
    const breakdown = (["done", "running", "needs_input", "failed"] as const)
      .map((status) => [recent.filter((run) => run.status === status || (status === "running" && run.status === "queued")).length, { done: "done", running: "measuring", needs_input: "waiting for an answer", failed: "did not finish" }[status]] as const)
      .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(", ");
    const plan = me.plan;
    return html`${top}
    <section aria-labelledby="summary">
      <h2 id="summary">This month</h2>
      <div class="grid3">
        <div class="card"><span class="big">${usd(saving)}</span><span class="sub">estimated monthly saving from the cheaper models OpenMerit found</span></div>
        <div class="card"><span class="big">${recent.length}</span><span class="sub">${recent.length === 1 ? "run" : "runs"}${breakdown ? ` · ${breakdown}` : ""}</span></div>
        <div class="card">${plan.status !== "none" && plan.status !== "canceled"
          ? html`<span class="big">${plan.usedEvals} / ${plan.includedEvals}</span><span class="sub">evaluations used${plan.name ? ` on the ${plan.name} plan` : ""}</span>`
          : html`<span class="big">No plan</span><span class="sub"><a href="/plan/">Choose a plan</a> to measure new tasks</span>`}</div>
      </div>
    </section>
    <section aria-labelledby="all">
      <h2 id="all">All runs</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Outcome</th><th>Asked by</th><th class="num">Started</th></tr></thead>
          <tbody>
            ${runs.map((run) => {
              const task = byId.get(run.taskId);
              return html`<tr><td><a href="/r/${run.id}/">${task?.name ?? run.taskId}</a><span class="sub">${task?.environment ?? ""}</span></td><td>${outcome(run, task)}</td><td>${askedBy(run)}</td><td class="num">${day(run.startedAt)}</td></tr>`;
            })}
          </tbody>
        </table>
      </div>
      <p class="note">Agents read each report as Markdown at <code>https://openmerit.ai/api/r/&lt;run&gt;.md</code>.</p>
    </section>`;
  },
};
