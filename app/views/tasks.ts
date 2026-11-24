import type { Decision, EvalSource, EvalView, Run, Task, TaskDetail, TaskState } from "../api.ts";
import { ago, date, day, html, model, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";
import { evalForm, formError, measured, readEvalForm } from "./eval-editor.ts";
import { outcome, result } from "./runs.ts";

const guardrails = (level: string, id: string, text: string) => html`<a href="/guardrails/?level=${level}&amp;id=${encodeURIComponent(id)}">${text}</a>`;
const taskLink = (task: Task, tab = "") => `/tasks/?task=${encodeURIComponent(task.id)}${tab ? `&amp;tab=${tab}` : ""}`;

// Watching is automatic; the cloud app reports why a task is not watched. Before it sends state,
// a task that is not watching is taken as frozen by its watch guardrail.
const stateOf = (task: Task): TaskState => task.state ?? (task.watching ? "watching" : "frozen");
// A task approved from a repository review has no run yet: it neither watches nor spends until its first.
const notRun = (task: Task): boolean => task.lastRunAt === null && task.status === "new";
const states: Record<TaskState, (task: Task) => Html> = {
  watching: () => html`<span class="pill good">Watching</span>`,
  idle: (task) => html`<span class="pill">Idle</span><span class="sub">no call since ${day(task.idleSince ?? task.lastRunAt)}</span>`,
  frozen: (task) => html`<span class="pill tag">Frozen</span><span class="sub">${guardrails("task", task.id, "watch guardrail off")}</span>`,
  retired: () => html`<span class="pill tag">Retired</span>`,
};
const watch = (task: Task): Html => (notRun(task) && stateOf(task) !== "retired" ? html`<span class="pill tag">Not run yet</span><span class="sub">starts with its first run</span>` : states[stateOf(task)](task));

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
              <td><a href="${taskLink(task)}">${task.name}</a><span class="sub">${task.environment}${task.agent ? html` · agent ${guardrails("agent", `${task.environment}:${task.agent}`, task.agent)}` : ""} · <a href="${taskLink(task, "eval")}">Eval</a> · ${guardrails("task", task.id, "Guardrails")}</span></td>
              <td>${model(task.currentModel)}</td>
              <td>${task.status === "running" ? "Running" : day(task.lastRunAt)}</td>
              <td>${notRun(task) ? html`<span class="sub">Not run yet</span>` : result(task, (text) => (task.lastJobId ? html`<a href="/r/${task.lastJobId}/">${text}</a>` : html`${text}`))}${decided(task)}</td>
              <td>${watch(task)}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>`;
}

// Who wrote an eval version, in the page's words.
const SOURCES: Record<EvalSource, string> = {
  openmerit: "OpenMerit wrote the cases", claude: "Written on a member's Claude subscription", chatgpt: "Written on a member's ChatGPT subscription",
  examples: "The coding agent's examples", review: "Approved from a repository review", app: "Edited in the app", label_check: "Answers to a run's label check",
};
const evalDir = (task: string) => `.openmerit/evals/${task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task"}`;

function repoState(task: Task, view: EvalView): Html {
  const latest = view.latest!.version, repo = view.repo;
  const where = html`<code>${evalDir(task.name)}</code>`;
  if (!repo) return html`<span class="pill tag">Not in the repository</span><span class="sub">Your coding agent offers to write version ${latest} to ${where} on its next OpenMerit call.</span>`;
  const by = html`written by ${repo.by}${repo.client ? ` with ${repo.client}` : ""} ${ago(repo.at)}`;
  if (repo.version === latest) return html`<span class="pill good">Up to date</span><span class="sub">Version ${repo.version} is in ${where}, ${by}.</span>`;
  return html`<span class="pill warn">Behind</span><span class="sub">${where} has version ${repo.version}, ${by}. Your coding agent offers to write version ${latest} on its next OpenMerit call.</span>`;
}

function evalTab(detail: TaskDetail, view: EvalView, editable: boolean): Html {
  const latest = view.latest;
  if (!latest) return html`<section>${empty("No eval yet", "The task's first run writes its eval from the task's examples and spec. It appears here, and you can edit it before later runs.", html``)}</section>`;
  const output = detail.bundle?.output ?? { kind: "text" as const };
  const runs = detail.jobs.filter((run) => run.evalVersion !== undefined && run.evalVersion !== null);
  return html`<section aria-labelledby="version">
      <h2 id="version">Version ${latest.version}</h2>
      <div class="card">
        <div class="row"><span>${SOURCES[latest.source]}${latest.author ? ` · ${latest.author}` : ""}<span class="sub">${latest.note ?? ""}${latest.note ? " · " : ""}${date(latest.createdAt)} · ${plural(latest.cases.filter(measured).length, "case")} measured of ${latest.cases.length}</span></span><span class="sub">${plural(latest.runs, "run")} on this version</span></div>
        <div class="row"><span>Repository copy ${repoState(detail, view)}</span><span></span></div>
      </div>
      ${runs.length ? html`<p class="note">Saving makes version ${latest.version + 1}. Runs on different versions are not comparable: the cases or what the judge checks changed between them.</p>` : ""}
    </section>
    <section aria-labelledby="edit">
      <h2 id="edit">${editable ? "Edit" : "Cases"}</h2>
      ${evalForm(latest.spec, latest.cases, output, { action: "saveEval", submit: `Save as version ${latest.version + 1}`, baseVersion: latest.version, editable })}
    </section>
    ${view.versions.length > 1 ? html`<section aria-labelledby="versions">
      <h2 id="versions">Versions</h2>
      <div class="card">${view.versions.map((item) => html`<div class="row"><span>Version ${item.version}${item.version === latest.version ? html` <span class="pill tag">Latest</span>` : ""}<span class="sub">${SOURCES[item.source]}${item.author ? ` · ${item.author}` : ""}${item.note ? ` · ${item.note}` : ""}</span></span><span class="sub">${plural(item.runs, "run")} · ${date(item.createdAt)}</span></div>`)}</div>
    </section>` : ""}`;
}

function runsTab(detail: TaskDetail): Html {
  if (!detail.jobs.length) return html`<section>${empty("Not run yet", "This task was approved from a repository review. Its first run measures cheaper models on its eval; after that OpenMerit watches it.", html`<p><button class="btn primary" type="button" data-action="run">Run now</button></p>`)}</section>`;
  const versions = new Set(detail.jobs.map((run) => run.evalVersion).filter((value) => value !== null && value !== undefined));
  return html`<section aria-labelledby="runs">
      <h2 id="runs">Runs</h2>
      ${versions.size > 1 ? html`<div class="card notice warn eval-warning" role="note"><p>These runs measured on ${versions.size} eval versions. Results from different versions are not comparable: <a href="${taskLink(detail, "eval")}">see what changed</a>.</p></div>` : ""}
      <div class="tablewrap" style="margin-top: 12px">
        <table>
          <thead><tr><th>Run</th><th>Started</th><th>Eval</th><th>Result</th></tr></thead>
          <tbody>${detail.jobs.map((run: Run) => html`<tr>
            <td><a href="/r/${run.id}/">${run.id}</a><span class="sub">${run.kind === "watch" ? "watch" : run.askedBy ?? "app"}</span></td>
            <td>${date(run.startedAt)}</td>
            <td>${run.evalVersion ? html`<a href="${taskLink(detail, "eval")}">v${run.evalVersion}</a>` : html`<span class="sub">–</span>`}</td>
            <td>${outcome(run, detail)}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    </section>`;
}

type Data = { kind?: "list"; tasks: Task[] } | { kind: "task"; detail: TaskDetail; eval: EvalView };

export const tasksView: View<Data> = {
  async load({ api, params }) {
    const id = params.get("task");
    if (!id) return { kind: "list", tasks: await api.get<Task[]>("/api/tasks") };
    const [detail, evaluation] = await Promise.all([api.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`), api.get<EvalView>(`/api/tasks/${encodeURIComponent(id)}/eval`)]);
    return { kind: "task", detail, eval: evaluation };
  },
  title: (data) => (data.kind === "task" ? data.detail.name : "Tasks"),
  render(data, { me, params }) {
    if (data.kind === "task") {
      const { detail } = data, tab = params.get("tab") === "eval" ? "eval" : "runs";
      const retired = stateOf(detail) === "retired";
      return html`<div class="eyebrow"><a href="/tasks/">Tasks</a><span>›</span><span>${detail.environment}</span></div>
        <h1 class="title">${detail.name}</h1>
        <p class="lede">The code uses ${model(detail.currentModel)}. ${notRun(detail) ? "Approved from a repository review; it has not run yet." : html`Latest: ${result(detail)}`}</p>
        <p class="task-actions">${watch(detail)}
          <button class="btn${notRun(detail) ? " primary" : ""}" type="button" data-action="run">${notRun(detail) ? "Run now" : "Run again"}</button>
          ${retired ? "" : html`<button class="btn" type="button" data-action="retire">Retire</button>`}
          ${me.role === "admin" ? html`<a class="btn danger" href="/data/#delete-task">Delete…</a>` : ""}</p>
        <nav class="tabs" aria-label="Task">
          <a href="${taskLink(detail)}"${tab === "runs" ? html` aria-current="page"` : ""}>Runs</a>
          <a href="${taskLink(detail, "eval")}"${tab === "eval" ? html` aria-current="page"` : ""}>Eval${data.eval.latest ? ` v${data.eval.latest.version}` : ""}</a>
        </nav>
        ${tab === "eval" ? evalTab(detail, data.eval, !retired) : runsTab(detail)}`;
    }
    const all = data.tasks;
    // Tasks not run yet go last: they have nothing to show until their first run.
    const active = all.filter((task) => stateOf(task) !== "retired");
    const tasks = [...active.filter((task) => !notRun(task)), ...active.filter(notRun)], retired = all.filter((task) => stateOf(task) === "retired");
    const watching = all.filter((task) => stateOf(task) === "watching" && !notRun(task)).length;
    const top = header(me, "Tasks", "OpenMerit watches every task: it re-runs a task's tests when a new model could fit it or prices change, and tells you when a cheaper model matches the one you use.", [plural(tasks.length, "task"), `${watching} watched`]);
    if (!all.length) return html`${top}<section aria-labelledby="tasks"><h2 id="tasks">All Tasks</h2>${empty("No tasks yet", "A task appears the first time a coding agent asks OpenMerit which model it should use, or when you approve an eval from a repository review.")}</section>`;
    return html`${top}
    <section aria-labelledby="tasks">
      <h2 id="tasks">All Tasks</h2>
      ${table(tasks)}
      <p class="note">A task goes idle after 30 days without a call from a coding agent, and its next call resumes the watch. A <code>watch</code> guardrail set to off freezes the model choice. Retiring a task stops its watch and keeps its eval and runs.</p>
    </section>
    ${retired.length ? html`<section aria-labelledby="retired">
      <details><summary id="retired">${plural(retired.length, "retired task")}</summary>${table(retired)}</details>
    </section>` : ""}`;
  },
  actions: {
    async saveEval(target, data, { api, refresh, toast }) {
      if (data.kind !== "task" || !data.eval.latest) return;
      const form = target as HTMLFormElement, latest = data.eval.latest;
      try {
        const edited = readEvalForm(form, latest.spec, latest.cases, data.detail.bundle?.output ?? { kind: "text" });
        const saved = await api.send<EvalView>("PUT", `/api/tasks/${encodeURIComponent(data.detail.id)}/eval`, { ...edited, baseVersion: latest.version });
        await refresh();
        toast(saved.latest?.version === latest.version ? "Nothing changed." : `Saved version ${saved.latest?.version ?? ""}. Your coding agent offers to write it to the repository.`);
      } catch (failure) { formError(form, failure); }
    },
    async run(_target, data, { api, go }) {
      if (data.kind !== "task") return;
      const started = await api.send<{ jobId: string }>("POST", `/api/tasks/${encodeURIComponent(data.detail.id)}/run`);
      go(`/r/${started.jobId}/`);
    },
    async retire(_target, data, { api, confirm, refresh, toast }) {
      if (data.kind !== "task") return;
      if (!(await confirm({ title: `Retire ${data.detail.name}?`, body: "OpenMerit stops watching it. Its eval, runs and reports stay, and a coding agent that asks about it again brings it back.", confirm: "Retire" }))) return;
      await api.send("POST", `/api/tasks/${encodeURIComponent(data.detail.id)}/retire`);
      await refresh();
      toast(`${data.detail.name} retired.`);
    },
  },
};
