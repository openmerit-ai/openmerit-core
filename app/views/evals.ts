// New tasks: the tasks a repository review found that the project does not have, as drafts, each with what the
// review wrote: what the task does, what a right answer does, what it must never do, and the examples it found.
// Adding one creates the task and starts its first run, which runs the cases on the model in use and a cheaper
// one and asks the person to grade the answers case by case before any search; their grades accept the eval's
// version 1. Dismissing one drops it, and later reviews do not offer it again. The sidebar shows this page only
// while drafts wait. A task whose eval waits for review is on Tasks instead.
import type { EvalDraft } from "../api.ts";
import { ApiError } from "../api.ts";
import { date, html, model, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

type Data = { drafts: EvalDraft[] };

const shown = (value: unknown): string => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
const list = (title: string, items: string[] | undefined): Html => items?.length ? html`<p class="sub">${title}</p><ul class="spec">${items.map((item) => html`<li>${item}</li>`)}</ul>` : html``;

function draftCard(draft: EvalDraft): Html {
  const { bundle, cases } = draft;
  const output = bundle.output.kind === "label" ? `Answers one of: ${bundle.output.labels.join(", ")}` : bundle.output.kind === "json" ? "Answers JSON" : "Answers in text";
  return html`<div class="card">
        <p>${bundle.description ?? draft.name}</p>
        <p class="sub">From ${draft.environment}, reviewed ${date(draft.createdAt)} · the code uses ${model(bundle.current.model)} · ${output}</p>
        ${list("A right answer", bundle.criteria)}${list("It must never", bundle.guardrails)}
      </div>
      ${cases.length ? html`<div class="tablewrap" style="margin-top: 12px"><table>
        <thead><tr><th>Example from the repository</th><th>Input</th><th>Expected answer</th></tr></thead>
        <tbody>${cases.map((item) => html`<tr><td>${item.id}</td><td>${Object.entries(item.input).map(([key, value]) => html`<span class="sub">${key}</span>${value}`)}</td><td>${item.expected === undefined ? html`<span class="sub">None yet</span>` : shown(item.expected)}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="note">The review found no examples in the repository; the first run writes every case.</p>`}`;
}

export const evalsView: View<Data> = {
  async load({ api }) {
    return { drafts: await api.get<EvalDraft[]>("/api/eval-drafts") };
  },
  title: ({ drafts }) => `New tasks (${drafts.length})`,
  render({ drafts }, { me, params }) {
    const top = header(me, "New tasks", "Tasks a review of the project's GitHub repositories found in the code that the project does not have yet. Add one to measure it, or dismiss it if it is not a task you want measured.", [plural(drafts.length, "task")]);
    if (!drafts.length) return html`${top}<section>${empty("Nothing new", "A task appears here when a repository review in Project settings finds a model call this project has no task for. A task whose eval changed waits on Tasks.", html`<p><a class="btn" href="/project/">Project settings</a> <a class="btn" href="/tasks/">Tasks</a></p>`)}</section>`;
    const open = drafts.find((item) => item.id === params.get("draft")) ?? drafts[0]!;
    return html`${top}
    <nav class="tabs" aria-label="New tasks">${drafts.map((item) => html`<a href="?draft=${item.id}"${item.id === open.id ? html` aria-current="page"` : ""}>${item.name}</a>`)}</nav>
    <section aria-labelledby="draft">
      <h2 id="draft">${open.name}</h2>
      ${draftCard(open)}
      <p class="note">Adding it starts its first run: OpenMerit writes test cases from this and the examples, runs them on ${model(open.bundle.current.model)} and a cheaper model, and asks you to grade the answers one by one before it searches. Your grades fix the eval; nothing is searched until you accept it.</p>
      <p class="eval-actions"><button class="btn primary" type="button" data-action="approve" data-id="${open.id}">Add task and grade its answers</button><button class="btn" type="button" data-action="dismiss" data-id="${open.id}" data-name="${open.name}">Dismiss</button></p>
    </section>`;
  },
  actions: {
    async approve(target, { drafts }, { api, go, toast }) {
      const draft = drafts.find((item) => item.id === target.dataset.id);
      if (!draft) return;
      const approved = await api.send<{ taskId: string }>("POST", `/api/eval-drafts/${encodeURIComponent(draft.id)}/approve`);
      const task = `/tasks/?task=${encodeURIComponent(approved.taskId)}`;
      try {
        const started = await api.send<{ jobId: string }>("POST", `/api/tasks/${encodeURIComponent(approved.taskId)}/run`);
        go(`/r/${started.jobId}/`);
      } catch (failure) {
        // Such as no active plan: the task is added and waits, and its page offers Run now.
        if (!(failure instanceof ApiError)) throw failure;
        toast(`${draft.name} added to Tasks, but its first run did not start: ${failure.message}`);
        go(task);
      }
    },
    async dismiss(target, _data, { api, confirm, go, toast }) {
      const { id = "", name = "" } = target.dataset;
      if (!(await confirm({ title: `Dismiss ${name}?`, body: "The draft is deleted, and later reviews of the repository do not offer it again. A coding agent that asks about this task still starts it.", confirm: "Dismiss" }))) return;
      await api.send("DELETE", `/api/eval-drafts/${encodeURIComponent(id)}`);
      toast(`${name} dismissed.`);
      go("/evals/");
    },
  },
};
