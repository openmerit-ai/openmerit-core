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
  review: (task) => html`<span class="pill warn">Needs review</span><span class="sub"><a href="${taskLink(task, "eval")}">its eval waits for you</a>; no runs until then</span>`,
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

// Who wrote the accepted eval, in the page's words.
const SOURCES: Record<EvalSource, string> = {
  openmerit: "OpenMerit wrote the cases", claude: "Written on a member's Claude subscription", chatgpt: "Written on a member's ChatGPT subscription",
  examples: "The coding agent's examples", review: "Approved from a repository review", app: "Accepted in the app",
};
const evalDir = (task: string) => `.openmerit/evals/${task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task"}`;
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function repoState(task: Task, view: EvalView): Html {
  const accepted = view.accepted!.version, repo = view.repo;
  const where = html`<code>${evalDir(task.name)}</code>`;
  if (!repo) return html`<span class="pill tag">Not in the repository</span><span class="sub">Your coding agent offers to write version ${accepted} to ${where} on its next OpenMerit call.</span>`;
  const by = html`written by ${repo.by}${repo.client ? ` with ${repo.client}` : ""} ${ago(repo.at)}`;
  if (repo.version === accepted) return html`<span class="pill good">Up to date</span><span class="sub">Version ${repo.version} is in ${where}, ${by}.</span>`;
  return html`<span class="pill warn">Behind</span><span class="sub">${where} has version ${repo.version}, ${by}. Your coding agent offers to write version ${accepted} on its next OpenMerit call.</span>`;
}

// An accepted eval stays as it is until the task changes or someone revises it. A draft is saved in place
// and accepted as the next version; until then the task's runs and watch wait.
function evalTab(detail: TaskDetail, view: EvalView, editable: boolean): Html {
  const accepted = view.accepted, draft = view.draft;
  if (!accepted) return html`<section>${empty("No eval yet", "The task's first run writes its eval from the task's examples and spec, and your answers to its label check make it the accepted eval. It appears here.", html``)}</section>`;
  const output = draft?.output ?? detail.bundle?.output ?? { kind: "text" as const };
  const summary = html`<section aria-labelledby="version">
      <h2 id="version">Accepted: version ${accepted.version}</h2>
      <div class="card">
        <div class="row"><span>${SOURCES[accepted.source]}${accepted.by ? ` · ${accepted.by}` : ""}<span class="sub">${date(accepted.at)} · ${plural(accepted.cases.filter(measured).length, "case")} measured of ${accepted.cases.length}</span></span><span class="sub">${plural(accepted.runs, "run")} on this version</span></div>
        <div class="row"><span>Repository copy ${repoState(detail, view)}</span><span></span></div>
      </div>
    </section>`;
  if (!draft) {
    return html`${summary}
    <section aria-labelledby="edit">
      <h2 id="edit">Cases</h2>
      <p class="note" style="margin: -2px 0 10px">Runs and the watch measure on this eval as it is. It reopens for review when your coding agent sends the task with a different prompt, tools or output.${editable ? " To change it now, revise it: runs wait until you accept the revision." : ""}</p>
      ${editable ? html`<p class="eval-actions" style="margin-bottom: 12px"><button class="btn" type="button" data-action="revise">Revise eval</button></p>` : ""}
      ${evalForm(accepted.spec, accepted.cases, output, { action: "acceptEval", submit: "", base: null, editable: false })}
    </section>`;
  }
  const why = draft.reason === "task_changed"
    ? html`Your coding agent sent ${detail.name} with its ${listed(draft.changed)} changed${draft.at ? ` on ${date(draft.at)}` : ""}, so version ${accepted.version} may no longer fit it. Check the criteria and each expected answer; new examples the agent sent are at the end.`
    : html`${draft.by ?? "Someone"} opened a revision on ${date(draft.at)}.`;
  return html`${summary}
    <section aria-labelledby="edit">
      <h2 id="edit">Draft of version ${accepted.version + 1}</h2>
      <div class="card notice warn" role="note" style="margin-bottom: 12px"><p>${why} Runs and the watch wait until ${draft.reason === "revise" ? "you accept or discard it" : "you accept it"}.</p></div>
      ${evalForm(draft.spec, draft.cases, output, { action: "acceptEval", submit: `Accept as version ${accepted.version + 1}`, base: draft.at, editable,
        extra: html`<button class="btn" type="button" data-action="saveDraft">Save draft</button>${draft.reason === "revise" ? html`<button class="btn" type="button" data-action="discardDraft">Discard</button>` : ""}` })}
    </section>`;
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

const readDraft = (form: HTMLFormElement, data: Extract<Data, { kind: "task" }>) =>
  readEvalForm(form, data.eval.draft!.spec, data.eval.draft!.cases, data.eval.draft!.output ?? data.detail.bundle?.output ?? { kind: "text" });

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
          ${stateOf(detail) === "review" ? "" : html`<button class="btn${notRun(detail) ? " primary" : ""}" type="button" data-action="run">${notRun(detail) ? "Run now" : "Run again"}</button>`}
          ${retired ? "" : html`<button class="btn" type="button" data-action="retire">Retire</button>`}
          ${me.role === "admin" ? html`<a class="btn danger" href="/data/#delete-task">Delete…</a>` : ""}</p>
        <nav class="tabs" aria-label="Task">
          <a href="${taskLink(detail)}"${tab === "runs" ? html` aria-current="page"` : ""}>Runs</a>
          <a href="${taskLink(detail, "eval")}"${tab === "eval" ? html` aria-current="page"` : ""}>Eval${data.eval.accepted ? ` v${data.eval.accepted.version}` : ""}${data.eval.draft ? html` <span class="pill warn">Review</span>` : ""}</a>
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
    async revise(_target, data, { api, refresh }) {
      if (data.kind !== "task") return;
      await api.send("POST", `/api/tasks/${encodeURIComponent(data.detail.id)}/eval/revise`);
      await refresh();
    },
    async saveDraft(target, data, { api, refresh, toast }) {
      const form = target.closest("form");
      if (data.kind !== "task" || !data.eval.draft || !form) return;
      try {
        await api.send("PUT", `/api/tasks/${encodeURIComponent(data.detail.id)}/eval/draft`, { ...readDraft(form, data), base: data.eval.draft.at });
        await refresh();
        toast("Draft saved. Runs wait until you accept it.");
      } catch (failure) { formError(form, failure); }
    },
    async acceptEval(target, data, { api, refresh, toast }) {
      if (data.kind !== "task" || !data.eval.draft) return;
      const form = target as HTMLFormElement;
      try {
        const accepted = await api.send<EvalView>("POST", `/api/tasks/${encodeURIComponent(data.detail.id)}/eval/accept`, { ...readDraft(form, data), base: data.eval.draft.at });
        await refresh();
        toast(`Accepted version ${accepted.accepted?.version ?? ""}. Runs and the watch resume on it, and your coding agent offers to write it to the repository.`);
      } catch (failure) { formError(form, failure); }
    },
    async discardDraft(_target, data, { api, confirm, refresh, toast }) {
      if (data.kind !== "task") return;
      if (!(await confirm({ title: "Discard this revision?", body: `Your changes are dropped, and runs resume on version ${data.eval.accepted?.version ?? ""} as accepted.`, confirm: "Discard" }))) return;
      await api.send("DELETE", `/api/tasks/${encodeURIComponent(data.detail.id)}/eval/draft`);
      await refresh();
      toast("Revision discarded.");
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
