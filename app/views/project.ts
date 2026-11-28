// Project settings: the project's name, the GitHub repositories whose code OpenMerit reads, the model
// endpoints it measures on, each the project's own, and deleting the project. The organization's plan,
// members and coding agents stay on their own pages; the member's GitHub connection is on Account settings.
import type { Endpoint, GitHubAccess, Me, Project, Repo, TaskSpec } from "../api.ts";
import { ApiError, DEFAULT_PROJECT } from "../api.ts";
import { ago, html, logo, model, plural, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";
import { addEndpoint, bindKindSelect, endpointsSection, removeEndpoint, retried } from "./connections.ts";

// A repository's review: what it found, that it is running, or why it failed with what the last one found.
const REVIEWING = new Set(["queued", "reviewing"]);
function reviewText(repo: Repo): Html {
  const { review } = repo, result = review.result;
  const found = result
    ? html`<span class="sub">${result.totalCalls ? html`${plural(result.totalCalls, "model call")}: ${result.models.slice(0, 4).map((item, index) => html`${index ? ", " : ""}${item.catalogueId ? model(item.catalogueId) : item.value}`)}${result.models.length > 4 ? ` and ${result.models.length - 4} more` : ""}` : "No model calls in application code"}${result.notListed ? ` · ${result.notListed}` : ""}${result.tasks.length ? ` · ${plural(result.tasks.length, "task spec")}` : ""} · ${plural(result.files, "file")} at ${result.commit.slice(0, 7)} on ${result.branch}</span>`
    : html``;
  if (REVIEWING.has(review.status)) return html`<span class="sub">Reviewing the code, read-only…</span>${found}`;
  if (review.status === "failed") return html`<span class="sub no">The last review failed: ${review.error ?? "no reason recorded"}</span>${found}`;
  return found;
}

function modelCalls(repo: Repo): Html {
  const result = repo.review.result;
  if (!result?.modelCalls.length) return result?.notListed ? html`<p class="note">${result.notListed}.</p>` : html``;
  const more = result.totalCalls - result.modelCalls.length;
  return html`<details><summary>Show the ${plural(result.totalCalls, "model call")}</summary>
          <table class="calls"><tbody>${result.modelCalls.map((call) => html`<tr><td><a href="${repo.url}/blob/${result.commit}/${call.file}#L${call.line}" target="_blank" rel="noreferrer">${call.file}:${call.line}</a></td><td>${call.catalogueId ? model(call.catalogueId) : html`<code>${call.value}</code>`}${call.envVar ? html`<span class="sub">from ${call.envVar}</span>` : call.dynamic ? html`<span class="sub">set at run time</span>` : ""}</td></tr>`)}</tbody></table>
          ${more > 0 ? html`<p class="note">And ${plural(more, "more call")}.</p>` : ""}
          ${result.notListed ? html`<p class="note">${result.notListed}.</p>` : ""}
        </details>`;
}

// The task specs the review wrote from the code: what each task does, what makes its answer right and what it must never do.
function taskSpecs(repo: Repo): Html {
  const result = repo.review.result;
  if (!result) return html``;
  const unmapped = result.unmapped ?? [];
  if (!result.tasks.length && !unmapped.length) return html``;
  const output = (spec: TaskSpec) => spec.output.kind === "label" ? `answers one of ${plural(spec.output.labels?.length ?? 0, "label")}` : spec.output.kind === "json" ? "answers JSON" : "answers in text";
  const list = (title: string, items: string[] | undefined) => items?.length ? html`<p class="sub">${title}</p><ul class="spec">${items.map((item) => html`<li>${item}</li>`)}</ul>` : "";
  return html`<details><summary>Show the ${plural(result.tasks.length, "task spec")}</summary>
          ${result.tasks.map((spec) => html`<div class="spec">
            <p><strong>${spec.task}</strong>${spec.description ? ` · ${spec.description}` : ""}</p>
            <p class="sub">${[output(spec), spec.tools?.length ? plural(spec.tools.length, "tool") : "", spec.codeRefs?.length ? spec.codeRefs.map((ref) => `${ref.file}:${ref.line}`).join(", ") : ""].filter(Boolean).join(" · ")}</p>
            ${list("A right answer", spec.criteria)}${list("It must never", spec.guardrails)}
          </div>`)}
          ${unmapped.map((item) => html`<p class="note">${plural(item.usageIds.length, "model call")} in no spec: ${item.reason}</p>`)}
          ${result.tasks.length ? html`<p class="note">A task this project does not have yet is listed on <a href="/tasks/">Tasks</a> as Found in code, to measure or ignore.</p>` : ""}
          ${result.costUsd ? html`<p class="note">This review cost OpenMerit $${result.costUsd.toFixed(2)} in model calls, counted in your spend; it is not one of your plan's evaluations.</p>` : ""}
        </details>`;
}

function repoRow(repo: Repo, admin: boolean): Html {
  const reviewing = REVIEWING.has(repo.review.status);
  const reviewed = repo.review.status === "done" && repo.review.finishedAt ? html`<span class="sub">Reviewed ${ago(repo.review.finishedAt)}</span>` : html``;
  return html`<div class="repo">
        <div class="row">
          <span>${logo("github")}<a href="${repo.url}" target="_blank" rel="noreferrer">${repo.fullName}</a>${reviewText(repo)}</span>
          <span class="endpoint-meta"><span class="pill tag">${repo.access === "github" ? `${repo.private ? "Private" : "Public"} · GitHub connection` : repo.tokenLast4 ? `Private · token ending ${repo.tokenLast4}` : "Public"}</span>${reviewing ? html`<span class="sub"><span class="pill live">Reviewing</span></span>` : reviewed}</span>
          ${admin ? html`<span class="actions"><button class="btn" type="button" data-action="review" data-id="${repo.id}"${reviewing ? html` disabled` : ""} aria-label="Review ${repo.fullName} again">Review again</button><button class="btn danger" type="button" data-action="removeRepo" data-id="${repo.id}" aria-label="Remove ${repo.fullName}">Remove</button></span>` : html`<span></span>`}
        </div>
        ${modelCalls(repo)}
        ${taskSpecs(repo)}
      </div>`;
}

// The repositories the member's GitHub connection reaches, to add to this project without a token.
function githubPicker({ github, repos, project }: Data, admin: boolean, canAdd: boolean): Html {
  if (!github.app || !admin) return html``;
  if (!github.signedIn) return html`<p class="note">Connect GitHub on <a href="/account/">Account settings</a> to pick repositories, private ones included, without a token.</p>`;
  if (github.error) return html`<div class="card notice bad" role="alert" style="margin-top: 12px"><p>${github.error}</p></div>`;
  const added = new Set(repos.map((repo) => repo.fullName.toLowerCase()));
  const choices = github.installations.flatMap((item) => item.repos);
  if (!choices.length) return html`<p class="note">Your GitHub connection reaches no repositories yet. Choose some for the OpenMerit GitHub App on <a href="/account/">Account settings</a>.</p>`;
  return html`<div class="card" style="margin-top: 12px">
        <p>From your GitHub connection<span class="sub">Repositories you gave the OpenMerit GitHub App. Change them on <a href="/account/">Account settings</a>.</span></p>
        <table class="calls"><tbody>${choices.map((repo) => html`<tr><td>${repo.fullName}</td><td>${repo.private ? html`<span class="pill tag">Private</span>` : ""}</td><td>${added.has(repo.fullName.toLowerCase()) ? html`<span class="sub">In ${project.name}</span>`
          : html`<button class="btn" type="button" data-action="addGithubRepo" data-repo="${repo.fullName}"${canAdd ? "" : html` disabled`} aria-label="Add ${repo.fullName} to ${project.name}">Add</button>`}</td></tr>`)}</tbody></table>
      </div>`;
}

type Data = { project: Project; endpoints: Endpoint[]; repos: Repo[]; github: GitHubAccess };

const REVIEW_POLL_MS = 3000;
// The server's plan check: on openmerit.ai repository reviews, like evaluations, need a plan Stripe says is active or
// trialing; a self-hosted server has no plans.
const paid = (me: Pick<Me, "mode" | "plan">): boolean => me.mode === "self-hosted" || me.plan.status === "active" || me.plan.status === "trialing";
let reviewTimer: ReturnType<typeof setTimeout> | undefined;

export const projectView: View<Data> = {
  async load({ api, project }) {
    const [endpoints, repos, github] = await Promise.all([retried(() => api.get<Endpoint[]>("/api/endpoints")), retried(() => api.get<Repo[]>("/api/repos")), retried(() => api.get<GitHubAccess>("/api/github"))]);
    return { project, endpoints, repos, github };
  },
  title: ({ project }) => `${project.name} settings`,
  bind(root, { refresh }, { repos }) {
    bindKindSelect(root);
    // While a review runs, the page looks again every few seconds and shows what it found.
    clearTimeout(reviewTimer);
    if (repos.some((repo) => REVIEWING.has(repo.review.status))) reviewTimer = setTimeout(() => { if (root.isConnected) void refresh(); }, REVIEW_POLL_MS);
  },
  render(data, { me }) {
    const { project, endpoints, repos } = data;
    const own = endpoints.filter((endpoint) => !endpoint.builtIn);
    const admin = me.role === "admin";
    return html`${header(me, project.name, "A project holds its own tasks, runs and guardrails, the GitHub repositories OpenMerit reads, and the model endpoints it measures on. A coding agent's call from one of these repositories lands in this project. The plan, members and coding agents stay the organization's.", ["Project settings", plural(repos.length, "repository", "repositories"), `${plural(own.length, "endpoint")} of yours`])}

    <section aria-labelledby="name">
      <h2 id="name">Name</h2>
      ${admin ? html`<form class="card form" data-action="rename" autocomplete="off">
        <label>Project name
          <input name="name" type="text" required maxlength="64" spellcheck="false" value="${project.name}">
        </label>
        <p class="form-error" role="alert" hidden></p>
        <p><button class="btn" type="submit">Rename</button></p>
      </form>` : html`<div class="card"><p>${project.name}</p><p class="sub">Only an admin of ${me.account.name} can rename the project.</p></div>`}
    </section>

    <section aria-labelledby="repos">
      <h2 id="repos">Repositories</h2>
      <p class="note" style="margin: -2px 0 8px">OpenMerit copies the default branch into a temporary folder, reads it to find the model calls and write each task's spec, and deletes the copy. It never runs your code, pushes, or opens a pull request. It keeps where each model call is, the model it names, and the task specs, which quote the prompts, tool schemas and examples they were written from; not your files.</p>
      ${paid(me) ? "" : html`<div class="card notice warn" role="status" style="margin: 0 0 24px"><p>Reviewing a repository needs an active plan. ${repos.length ? "Your repositories stay listed with their last review. " : ""}<a href="/plan/">Choose a plan</a> to add or review one.</p></div>`}
      ${repos.length ? html`<div class="card">${repos.map((repo) => repoRow(repo, admin))}</div>` : html`<div class="card"><p class="sub">No repositories yet.${admin ? " Add one below." : ""}</p></div>`}
      ${githubPicker(data, admin, paid(me))}
      ${admin ? html`<form class="card form" data-action="addRepo" autocomplete="off" style="margin-top: 12px">
        <label>GitHub repository
          <input name="url" type="text" required spellcheck="false" placeholder="https://github.com/acme/app">
        </label>
        <label>Fine-grained token, for a private repository
          <input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
          <span class="sub">Leave this empty for a public repository, or for one you add from your GitHub connection above. Otherwise, for a private one, <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">create a fine-grained token</a> with Repository access set to only the repositories OpenMerit reviews and Contents: Read-only. OpenMerit stores it encrypted and shows only its last four characters.</span>
        </label>
        <p class="form-error" role="alert" hidden></p>
        <p><button class="btn primary" type="submit">Add repository</button></p>
      </form>` : html`<p class="note">Only an admin of ${me.account.name} can add, review or remove repositories.</p>`}
    </section>

    ${endpointsSection(endpoints, me)}

    ${admin && project.id !== DEFAULT_PROJECT ? html`<section aria-labelledby="delete">
      <h2 id="delete">Delete Project</h2>
      <div class="card"><div class="row"><span>Delete ${project.name}<span class="sub">${project.tasks ? `Delete its ${plural(project.tasks, "task")} first, on Your data. ` : ""}Deletes the project's repositories, eval drafts, endpoint keys and guardrails. The organization's plan and spend are kept.</span></span><button class="btn danger" type="button" data-action="deleteProject"${project.tasks ? html` disabled` : ""}>Delete project</button></div></div>
    </section>` : ""}`;
  },
  actions: {
    add: (form, _data, ctx) => addEndpoint(form, ctx),
    remove: (target, { endpoints }, ctx) => removeEndpoint(target, endpoints, ctx),
    async addRepo(form, _data, { api, refresh, toast }) {
      if (!(form instanceof HTMLFormElement)) return;
      const fields = new FormData(form);
      const error = form.querySelector<HTMLElement>(".form-error");
      const token = String(fields.get("token") ?? "").trim();
      let added: Repo;
      try {
        added = await api.send<Repo>("POST", "/api/repos", { url: String(fields.get("url") ?? "").trim(), ...(token ? { token } : {}) });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      form.reset();
      await refresh();
      toast(`${added.fullName} added. OpenMerit is reviewing its code.`);
    },
    async addGithubRepo(target, { project }, { api, refresh, toast }) {
      const name = target.dataset.repo ?? "";
      try {
        await api.send<Repo>("POST", "/api/repos", { url: `https://github.com/${name}`, via: "github" });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400) throw failure;
        toast(failure.message);
        return;
      }
      await refresh();
      toast(`${name} added to ${project.name}. OpenMerit is reviewing its code.`);
    },
    async review(target, _data, { api, refresh }) {
      await api.send("POST", `/api/repos/${encodeURIComponent(target.dataset.id ?? "")}/review`);
      await refresh();
    },
    async removeRepo(target, { repos }, { api, refresh, toast, confirm }) {
      const repo = repos.find((item) => item.id === target.dataset.id);
      if (!repo || !await confirm({ title: "Remove this repository?", body: `OpenMerit deletes what it found in ${repo.fullName}${repo.tokenLast4 ? ` and the token ending ${repo.tokenLast4}` : ""}, and its drafts still waiting for review, and stops reading it. Tasks already approved are kept.`, confirm: "Remove repository", danger: true })) return;
      await api.send("DELETE", `/api/repos/${encodeURIComponent(repo.id)}`);
      await refresh();
      toast("Repository removed.");
    },
    async rename(form, { project }, { api }) {
      if (!(form instanceof HTMLFormElement)) return;
      const error = form.querySelector<HTMLElement>(".form-error");
      const name = String(new FormData(form).get("name") ?? "").trim();
      try {
        await api.send("PUT", `/api/projects/${encodeURIComponent(project.id)}`, { name });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      // The switcher shows the name too.
      location.reload();
    },
    async deleteProject(_target, { project }, { api, confirm, go }) {
      if (!await confirm({ title: `Delete ${project.name}?`, body: "OpenMerit deletes the project's repositories, eval drafts, endpoint keys and guardrails. This cannot be undone.", confirm: "Delete project", danger: true, typeToConfirm: project.name })) return;
      await api.send("DELETE", `/api/projects/${encodeURIComponent(project.id)}`);
      go(`/?project=${DEFAULT_PROJECT}`);
    },
  },
};
