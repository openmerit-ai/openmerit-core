import type { Decision, EvalDraft, EvalSource, EvalView, JobView, Run, Task, TaskDetail, TaskState } from "../api.ts";
import { date, day, html, model, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header, install } from "./common.ts";
import { evalForm, formError, measured, readEvalForm } from "./eval-editor.ts";
import { grading, sendGrades } from "./run.ts";
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

/** What the user decided in their coding agent about the task's latest change, or that the agent has not sent it yet. */
export const decisionText = (decision: Decision): string =>
  `${decision.decision === "approved" ? "Approved" : "Declined"} in the coding agent by ${decision.name ?? decision.by} on ${date(decision.at)}`;
function decided(task: Task): Html {
  if (task.decision && (task.decision.decision === "approved" || task.decision.jobId === task.lastJobId)) return html`<span class="sub">${decisionText(task.decision)}</span>`;
  return task.pick ? html`<span class="sub">Waiting for a decision in the coding agent</span>` : html``;
}

// One Tasks list, where each task's status says what it needs from you. A task a repository review found is a
// draft (found) until someone measures it: Measure approves the draft, which adds the task, and starts its first run.
// Grade answers: a run waits for a person's grades, which the task page asks for. Recommendation: a pick waits for the
// decision in the coding agent, which edits the code. The rest need nothing.
type Status = "found" | "grade" | "agent" | "eval" | "measure" | "recommend" | "measuring" | TaskState;
const NEEDS = new Set<Status>(["found", "grade", "agent", "eval", "measure", "recommend"]);
const STATUS: Partial<Record<Status, (task: Task) => Html>> = {
  found: () => html`<span class="pill warn">Found in code</span>`,
  grade: () => html`<span class="pill warn">Grade answers</span>`,
  agent: () => html`<span class="pill warn">Answer in your coding agent</span>`,
  eval: () => html`<span class="pill warn">Check its eval</span>`,
  measure: () => html`<span class="pill tag">Not measured</span>`,
  recommend: () => html`<span class="pill warn">Recommendation</span>`,
  measuring: () => html`<span class="pill live">Measuring</span>`,
};
const pending = (task: Task): boolean => task.status === "picked" && !(task.decision && task.decision.jobId === task.lastJobId);
// The task's status from its row and the run that waits for a person, if any.
function statusOf(task: Task, waiting: JobView | undefined): Status {
  const state = stateOf(task);
  if (state === "retired") return "retired";
  if (state === "review") return "eval";
  if (waiting) return waiting.phase === "grading" ? "grade" : "agent";
  if (task.status === "running") return "measuring";
  if (notRun(task)) return "measure";
  if (pending(task)) return "recommend";
  return state;
}
const pill = (status: Status, task: Task): Html => (STATUS[status] ?? states[status as TaskState])(task);

// What the person does next, or what the latest run found.
function next(status: Status, task: Task, waiting: JobView | undefined): Html {
  switch (status) {
    case "grade": return html`<a href="${taskLink(task)}">Grade ${plural(waiting?.questions.length ?? 0, "answer")}</a><span class="sub">the run continues once every answer has a grade</span>`;
    case "agent": return html`<span class="sub">OpenMerit asked ${plural(waiting?.questions.length ?? 1, "question")} in your coding agent</span>`;
    case "eval": return html`<a href="${taskLink(task, "eval")}">Check its eval</a><span class="sub">your coding agent sent it changed; no runs until you accept it</span>`;
    case "measure": return html`<a href="${taskLink(task)}">Measure it</a><span class="sub">it neither runs nor watches until then</span>`;
    case "measuring": return task.lastJobId ? html`<a href="/r/${task.lastJobId}/">See its progress</a>` : html`<span class="sub">Measuring</span>`;
    default: return html`${result(task, (text) => (task.lastJobId ? html`<a href="/r/${task.lastJobId}/">${text}</a>` : html`${text}`))}${decided(task)}`;
  }
}

type Row = { kind: "task"; task: Task; status: Status } | { kind: "found"; draft: EvalDraft };
const statusOfRow = (row: Row): Status => (row.kind === "found" ? "found" : row.status);

function table(rows: Row[], waiting: Record<string, JobView>): Html {
  return html`<div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Next</th></tr></thead>
          <tbody>
            ${rows.map((row) => {
              if (row.kind === "found") {
                const { draft } = row;
                return html`<tr>
                <td><a href="/tasks/?draft=${encodeURIComponent(draft.id)}">${draft.name}</a><span class="sub">${draft.environment} · ${model(draft.bundle.current.model)}</span></td>
                <td>${STATUS.found!({} as Task)}</td>
                <td><a href="/tasks/?draft=${encodeURIComponent(draft.id)}">Measure it or ignore it</a><span class="sub">a repository review found it ${day(draft.createdAt)}</span></td>
              </tr>`;
              }
              const { task, status } = row;
              return html`<tr${task.status === "switched" ? html` class="switch"` : ""}>
              <td><a href="${taskLink(task)}">${task.name}</a><span class="sub">${task.environment}${task.agent ? ` · agent ${task.agent}` : ""} · ${model(task.currentModel)}${task.lastRunAt ? ` · last run ${day(task.lastRunAt)}` : ""}</span></td>
              <td>${pill(status, task)}</td>
              <td>${next(status, task, waiting[task.id])}</td>
            </tr>`;
            })}
          </tbody>
        </table>
      </div>`;
}

// Who wrote the accepted eval, in the page's words.
const SOURCES: Record<EvalSource, string> = {
  openmerit: "OpenMerit wrote the cases", chatgpt: "Written on a member's ChatGPT subscription", harness: "Written by OpenMerit Harness on your plan",
  examples: "The coding agent's examples", app: "Accepted in the app",
  grading: "Accepted by grading a run's answers",
};
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// An accepted eval stays as it is until the task changes or someone revises it. A draft is saved in place
// and accepted as the next version; until then the task's runs and watch wait.
function evalTab(detail: TaskDetail, view: EvalView, editable: boolean): Html {
  const accepted = view.accepted, draft = view.draft;
  if (!accepted) return html`<section>${empty("No eval yet", "The task's first run writes its eval from the task's examples and spec, and your answers to its label check make it the accepted eval. It appears here.", html``)}</section>`;
  const output = draft?.output ?? detail.bundle?.output ?? { kind: "text" as const };
  const summary = html`<section aria-labelledby="version">
      <h2 id="version">Accepted: version ${accepted.version}</h2>
      <div class="card">
        <div class="row"><span>${SOURCES[accepted.source]}${accepted.by ? ` · ${accepted.byName ?? accepted.by}` : ""}<span class="sub">${date(accepted.at)} · ${plural(accepted.cases.filter(measured).length, "case")} measured of ${accepted.cases.length}</span></span><span class="sub">${plural(accepted.runs, "run")} on this version</span></div>
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
    : html`${draft.byName ?? draft.by ?? "Someone"} opened a revision on ${date(draft.at)}.`;
  return html`${summary}
    <section aria-labelledby="edit">
      <h2 id="edit">Draft of version ${accepted.version + 1}</h2>
      <div class="card notice warn" role="note" style="margin-bottom: 12px"><p>${why} Runs and the watch wait until ${draft.reason === "revise" ? "you accept or discard it" : "you accept it"}.</p></div>
      ${evalForm(draft.spec, draft.cases, output, { action: "acceptEval", submit: `Accept as version ${accepted.version + 1}`, base: draft.at, editable,
        extra: html`<button class="btn" type="button" data-action="saveDraft">Save draft</button>${draft.reason === "revise" ? html`<button class="btn" type="button" data-action="discardDraft">Discard</button>` : ""}` })}
    </section>`;
}

function runsTab(detail: TaskDetail, waiting: JobView | null): Html {
  if (!detail.jobs.length) return html`<section>${empty("Not measured yet", "Measuring writes the task's test cases, runs them on the model in use now and a cheaper one, and asks you to grade the answers; it searches cheaper models only once your grades accept the eval. After that OpenMerit watches it.", html`<p><button class="btn primary" type="button" data-action="run">Measure</button></p>`)}</section>`;
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
            <td>${waiting?.jobId === run.id && waiting.phase === "grading" ? html`<span class="pill warn">Waiting for your grades</span>` : outcome(run, detail)}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    </section>`;
}

type Data =
  | { kind: "list"; tasks: Task[]; drafts: EvalDraft[]; waiting: Record<string, JobView> }
  | { kind: "task"; detail: TaskDetail; eval: EvalView; waiting: JobView | null }
  | { kind: "draft"; draft: EvalDraft };

const readDraft = (form: HTMLFormElement, data: Extract<Data, { kind: "task" }>) =>
  readEvalForm(form, data.eval.draft!.spec, data.eval.draft!.cases, data.eval.draft!.output ?? data.detail.bundle?.output ?? { kind: "text" });

// The run that waits for a person, from GET /api/runs/:id: grades in the app, or a question in the coding agent.
const waitingJob = async (api: Parameters<View<Data>["load"]>[0]["api"], id: string): Promise<JobView | null> => {
  const job = await api.get<JobView | { report: unknown }>(`/api/runs/${encodeURIComponent(id)}`).catch(() => null);
  return job && job.report === null && (job as JobView).status === "needs_input" ? job as JobView : null;
};

// A task a repository review found: what the review read in the code. Measuring is the only way to check it: the
// first run writes cases from this and asks you to grade real answers, so nothing here is edited by hand.
function found(draft: EvalDraft, me: { role: string }): Html {
  const { criteria = [], guardrails: never = [], description } = draft.bundle;
  return html`<div class="eyebrow"><a href="/tasks/">Tasks</a><span>›</span><span>${draft.environment}</span></div>
    <h1 class="title">${draft.name}</h1>
    <p class="task-actions">${STATUS.found!({} as Task)}<span class="sub">A repository review found it in ${draft.environment} on ${date(draft.createdAt)}. The code uses ${model(draft.bundle.current.model)}.</span></p>
    <section aria-labelledby="read">
      <h2 id="read">What the Review Read in the Code</h2>
      <div class="card">
        ${description ? html`<p>${description}</p>` : ""}
        ${criteria.length ? html`<p class="sub">A right answer</p><ul>${criteria.map((item) => html`<li>${item}</li>`)}</ul>` : ""}
        ${never.length ? html`<p class="sub">It must never</p><ul>${never.map((item) => html`<li>${item}</li>`)}</ul>` : ""}
        <p class="sub">${draft.cases.length ? `${plural(draft.cases.length, "example")} found in the repository` : "No examples in the repository: the first run writes every case"}</p>
      </div>
    </section>
    <p class="note">To measure it, OpenMerit writes test cases from this, runs them on ${model(draft.bundle.current.model)} and a cheaper model, and asks you to grade the answers. It searches only once your grades accept the eval. The run counts as one evaluation on your plan.</p>
    ${me.role === "admin" ? html`<p class="task-actions"><button class="btn primary" type="button" data-action="measure">Measure</button><button class="btn" type="button" data-action="ignore">Ignore</button></p>` : html`<p class="note">Only an admin can measure or ignore it.</p>`}`;
}

export const tasksView: View<Data> = {
  async load({ api, params }) {
    const draftId = params.get("draft");
    if (draftId) {
      const draft = (await api.get<EvalDraft[]>("/api/eval-drafts")).find((item) => item.id === draftId);
      // A draft measured or ignored since goes back to the list.
      if (draft) return { kind: "draft", draft };
    }
    const id = params.get("task");
    if (!id) {
      const [tasks, drafts, runs] = await Promise.all([api.get<Task[]>("/api/tasks"), api.get<EvalDraft[]>("/api/eval-drafts").catch((): EvalDraft[] => []), api.get<Run[]>("/api/runs").catch((): Run[] => [])]);
      // Each task's newest run, when it waits for a person.
      const latest = new Map<string, Run>();
      for (const run of runs) if (!latest.has(run.taskId) || latest.get(run.taskId)!.startedAt < run.startedAt) latest.set(run.taskId, run);
      const asks = [...latest.values()].filter((run) => run.status === "needs_input");
      const jobs = await Promise.all(asks.map((run) => waitingJob(api, run.id)));
      return { kind: "list", tasks, drafts, waiting: Object.fromEntries(jobs.flatMap((job) => (job ? [[job.taskId, job]] : []))) };
    }
    const [detail, evaluation] = await Promise.all([api.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`), api.get<EvalView>(`/api/tasks/${encodeURIComponent(id)}/eval`)]);
    const newest = detail.jobs[0];
    return { kind: "task", detail, eval: evaluation, waiting: newest?.status === "needs_input" ? await waitingJob(api, newest.id) : null };
  },
  title: (data) => (data.kind === "task" ? data.detail.name : data.kind === "draft" ? data.draft.name : "Tasks"),
  render(data, { me, params }) {
    if (data.kind === "draft") return found(data.draft, me);
    if (data.kind === "task") {
      const { detail, waiting } = data, tab = params.get("tab") === "eval" ? "eval" : "runs";
      const retired = stateOf(detail) === "retired", status = statusOf(detail, waiting ?? undefined);
      const grades = waiting?.phase === "grading" && waiting.questions.length;
      return html`<div class="eyebrow"><a href="/tasks/">Tasks</a><span>›</span><span>${detail.environment}</span></div>
        <h1 class="title">${detail.name}</h1>
        <p class="lede">The code uses ${model(detail.currentModel)}. ${notRun(detail) ? "It has not been measured yet." : status === "grade" || status === "agent" || status === "measuring" ? "" : html`Latest: ${result(detail)}`}</p>
        <p class="task-actions">${pill(status, detail)}
          ${status === "eval" || status === "grade" || status === "agent" || status === "measuring" ? "" : html`<button class="btn${notRun(detail) ? " primary" : ""}" type="button" data-action="run">${notRun(detail) ? "Measure" : "Run again"}</button>`}
          ${retired ? "" : html`<button class="btn" type="button" data-action="retire">Retire</button>`}
          ${me.role === "admin" ? html`<a class="btn danger" href="/data/#delete-task">Delete…</a>` : ""}</p>
        ${grades ? html`<section aria-labelledby="grades"><h2 id="grades">Grade Its Answers</h2>${grading(waiting)}</section>` : ""}
        ${status === "agent" ? html`<div class="card notice warn" role="note"><p>OpenMerit asked ${plural(waiting?.questions.length ?? 1, "question")} in your coding agent. The run continues once it answers.</p></div>` : ""}
        ${status === "recommend" ? html`<div class="card notice" role="note"><p>${result(detail, (text) => html`<a href="/r/${detail.lastJobId ?? ""}/">${text}</a>`)}</p><p class="note">Your coding agent asks you to switch or keep, and edits the code when you switch.</p></div>` : ""}
        <nav class="tabs" aria-label="Task">
          <a href="${taskLink(detail)}"${tab === "runs" ? html` aria-current="page"` : ""}>Runs</a>
          <a href="${taskLink(detail, "eval")}"${tab === "eval" ? html` aria-current="page"` : ""}>Eval${data.eval.accepted ? ` v${data.eval.accepted.version}` : ""}${data.eval.draft ? html` <span class="pill warn">Review</span>` : ""}</a>
        </nav>
        ${tab === "eval" ? evalTab(detail, data.eval, !retired) : runsTab(detail, waiting)}`;
    }
    const rows: Row[] = [
      ...data.drafts.map((draft): Row => ({ kind: "found", draft })),
      ...data.tasks.map((task): Row => ({ kind: "task", task, status: statusOf(task, data.waiting[task.id]) })),
    ];
    const off = rows.filter((row) => statusOfRow(row) === "retired"), on = rows.filter((row) => statusOfRow(row) !== "retired");
    const needs = on.filter((row) => NEEDS.has(statusOfRow(row)));
    // Needs you first, in the order a person acts on them; the rest keep the cloud app's order.
    const order: Status[] = ["grade", "agent", "eval", "recommend", "found", "measure"];
    needs.sort((a, b) => order.indexOf(statusOfRow(a)) - order.indexOf(statusOfRow(b)));
    const filter = params.get("show") ?? (needs.length ? "needs" : "all");
    const shown = filter === "retired" ? off : filter === "needs" ? needs : [...needs, ...on.filter((row) => !NEEDS.has(statusOfRow(row)))];
    const watching = on.filter((row) => statusOfRow(row) === "watching").length;
    const top = header(me, "Tasks", !rows.length ? "OpenMerit measures each model call your code makes, asks you to grade its answers, and tells you when a cheaper model matches the one you use." : needs.length ? `${plural(needs.length, "task")} ${needs.length === 1 ? "needs" : "need"} you. OpenMerit measures each task, asks you to grade its answers, and watches it after: it tells you when a cheaper model matches the one you use.` : "Nothing needs you. OpenMerit watches every task and tells you when a cheaper model matches the one you use.", [plural(on.length, "task"), `${watching} watched`]);
    if (!rows.length) {
      return html`${top}<section aria-labelledby="tasks"><h2 id="tasks">No Tasks Yet</h2>
        <div class="ways">
          ${empty("Add a repository", "OpenMerit reads the code and lists each model call it finds here, as Found in code.", html`<p><a class="btn primary" href="/project/#repos">Add a repository</a></p>`)}
          ${empty("Add OpenMerit to your coding agent", "A task appears the first time your agent asks which model a call should use.", install())}
        </div></section>`;
    }
    const tab = (value: string, label: string) => html`<a href="/tasks/?show=${value}"${filter === value ? html` aria-current="page"` : ""}>${label}</a>`;
    return html`${top}
    <section aria-labelledby="tasks">
      <h2 id="tasks" class="sr-only">Tasks</h2>
      <nav class="tabs" aria-label="Show">${tab("needs", `Needs you (${needs.length})`)}${tab("all", "All")}${off.length ? tab("retired", `Retired (${off.length})`) : ""}</nav>
      ${shown.length ? table(shown, data.waiting) : html`<p class="note">${filter === "needs" ? "Nothing needs you: every task is measured and decided." : "Nothing here."}</p>`}
      <p class="note">A task goes idle after 30 days without a call from a coding agent, and its next call resumes the watch. A <code>watch</code> guardrail set to off freezes the model choice. Retiring a task stops its watch and keeps its eval and runs.</p>
    </section>`;
  },
  actions: {
    async grade(form, data, ctx) {
      if (data.kind !== "task" || !data.waiting || !(form instanceof HTMLFormElement)) return;
      await sendGrades(form, data.waiting, ctx);
    },
    // Measure: approve the draft, which adds the task, and start its first run, which asks for grades on the task's page.
    async measure(_target, data, { api, go, toast }) {
      if (data.kind !== "draft") return;
      const { taskId } = await api.send<{ taskId: string }>("POST", `/api/eval-drafts/${encodeURIComponent(data.draft.id)}/approve`, {});
      await api.send("POST", `/api/tasks/${encodeURIComponent(taskId)}/run`);
      toast(`Measuring ${data.draft.name}. It asks you to grade its answers here.`);
      go(`/tasks/?task=${encodeURIComponent(taskId)}`);
    },
    async ignore(_target, data, { api, confirm, go, toast }) {
      if (data.kind !== "draft") return;
      if (!(await confirm({ title: `Ignore ${data.draft.name}?`, body: "OpenMerit drops it, and later reviews of the repository do not suggest it again. A coding agent that asks about this task still adds it.", confirm: "Ignore" }))) return;
      await api.send("DELETE", `/api/eval-drafts/${encodeURIComponent(data.draft.id)}`);
      toast(`${data.draft.name} ignored.`);
      go("/tasks/");
    },
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
        toast(`Accepted version ${accepted.accepted?.version ?? ""}. Runs and the watch resume on it.`);
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
