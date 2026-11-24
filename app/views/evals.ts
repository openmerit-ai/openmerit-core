// Review evals: tasks whose eval waits for review (the task changed, or someone revised it), which link to
// the task's Eval tab, and the evals a repository review found, waiting for a person. Approving one creates the
// task with the draft as its eval's first version; the task runs when someone starts it. Dismissing
// one drops it, and later reviews do not offer it again. The sidebar shows this page only while drafts wait.
import type { EvalDraft, Task } from "../api.ts";
import { date, html, model, plural } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";
import { evalForm, formError, measured, readEvalForm } from "./eval-editor.ts";

type Data = { drafts: EvalDraft[]; tasks: Task[] };

const specOf = ({ task: _task, current: _current, output: _output, ...spec }: EvalDraft["bundle"]) => spec;

export const evalsView: View<Data> = {
  async load({ api }) {
    const [drafts, tasks] = await Promise.all([api.get<EvalDraft[]>("/api/eval-drafts"), api.get<Task[]>("/api/tasks")]);
    return { drafts, tasks: tasks.filter((task) => task.state === "review") };
  },
  title: ({ drafts, tasks }) => `Review evals (${drafts.length + tasks.length})`,
  render({ drafts, tasks }, { me, params }) {
    const top = header(me, "Review evals", "Evals wait here for a person: a task's eval when the task changed or someone revised it, and the evals a repository review wrote for model calls with no task yet. Check what the judge looks for and each case's expected answer, then accept or approve it.", [plural(drafts.length + tasks.length, "eval")]);
    const changed = tasks.length ? html`<section aria-labelledby="changed">
      <h2 id="changed">Tasks waiting for their eval</h2>
      <div class="card">${tasks.map((task) => html`<div class="row"><span><a href="/tasks/?task=${encodeURIComponent(task.id)}&amp;tab=eval">${task.name}</a><span class="sub">${task.environment} · no runs until its eval is accepted</span></span><a class="btn" href="/tasks/?task=${encodeURIComponent(task.id)}&amp;tab=eval">Review</a></div>`)}</div>
    </section>` : "";
    if (!drafts.length) return html`${top}${changed}${tasks.length ? "" : html`<section>${empty("Nothing to review", "A task's eval appears here when your coding agent sends the task with a different prompt, tools or output, and a draft appears when a repository review in Project settings finds a model call this project has no task for.", html`<p><a class="btn" href="/project/">Project settings</a></p>`)}</section>`}`;
    const open = drafts.find((item) => item.id === params.get("draft")) ?? drafts[0]!;
    return html`${top}${changed}
    ${tasks.length ? html`<h2 style="margin-top: 20px">From repository reviews</h2>` : ""}
    <nav class="tabs" aria-label="Evals to review">${drafts.map((item) => html`<a href="?draft=${item.id}"${item.id === open.id ? html` aria-current="page"` : ""}>${item.name}</a>`)}</nav>
    <section aria-labelledby="draft">
      <h2 id="draft">${open.name}</h2>
      <p class="note" style="margin: -2px 0 10px">From ${open.environment}, reviewed ${date(open.createdAt)}. The code uses ${model(open.bundle.current.model)}. ${open.bundle.description ?? ""} ${plural(open.cases.filter(measured).length, "case")} of ${open.cases.length} can be measured now.</p>
      ${evalForm(specOf(open.bundle), open.cases, open.bundle.output, { action: "approve", id: open.id, submit: "Approve and add task", base: null, editable: true,
        extra: html`<button class="btn" type="button" data-action="dismiss" data-id="${open.id}" data-name="${open.name}">Dismiss</button>` })}
      <p class="note">Approving adds ${open.name} to Tasks as not run yet. It does not watch or spend until its first run, which you or your coding agent start. Your coding agent then offers to write the eval to <code>.openmerit/evals/</code>, where it is a copy: edit it here.</p>
    </section>`;
  },
  actions: {
    async approve(target, { drafts }, { api, go, toast }) {
      const form = target as HTMLFormElement;
      const draft = drafts.find((item) => item.id === form.dataset.id);
      if (!draft) return;
      try {
        const edited = readEvalForm(form, specOf(draft.bundle), draft.cases, draft.bundle.output);
        const approved = await api.send<{ taskId: string }>("POST", `/api/eval-drafts/${encodeURIComponent(draft.id)}/approve`, edited);
        toast(`${draft.name} added to Tasks.`);
        go(`/tasks/?task=${encodeURIComponent(approved.taskId)}&tab=eval`);
      } catch (failure) { formError(form, failure); }
    },
    async dismiss(target, _data, { api, confirm, go, toast }) {
      const { id = "", name = "" } = target.dataset;
      if (!(await confirm({ title: `Dismiss ${name}?`, body: "The draft is deleted, and later reviews of the repository do not offer it again. A coding agent that asks about this model call still starts the task.", confirm: "Dismiss" }))) return;
      await api.send("DELETE", `/api/eval-drafts/${encodeURIComponent(id)}`);
      toast(`${name} dismissed.`);
      go("/evals/");
    },
  },
};
