// Project settings: the project's name, the model endpoints it measures on, which are the project's own,
// and deleting the project. The organization's plan, members and coding agents stay on its own pages.
import type { Endpoint, Project } from "../api.ts";
import { ApiError, DEFAULT_PROJECT } from "../api.ts";
import { html, plural } from "../html.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";
import { addEndpoint, bindKindSelect, endpointsSection, removeEndpoint, retried } from "./connections.ts";

type Data = { project: Project; endpoints: Endpoint[] };

export const projectView: View<Data> = {
  async load({ api, project }) {
    return { project, endpoints: await retried(() => api.get<Endpoint[]>("/api/endpoints")) };
  },
  title: ({ project }) => `${project.name} settings`,
  bind(root) { bindKindSelect(root); },
  render({ project, endpoints }, { me }) {
    const own = endpoints.filter((endpoint) => !endpoint.builtIn);
    const admin = me.role === "admin";
    return html`${header(me, project.name, "A project holds its own tasks, runs and guardrails, and the model endpoints OpenMerit measures them on. The plan, members and coding agents stay the organization's.", ["Project settings", plural(project.tasks, "task"), `${plural(own.length, "endpoint")} of yours`])}

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

    ${endpointsSection(endpoints, me)}

    ${admin && project.id !== DEFAULT_PROJECT ? html`<section aria-labelledby="delete">
      <h2 id="delete">Delete Project</h2>
      <div class="card"><div class="row"><span>Delete ${project.name}<span class="sub">${project.tasks ? `Delete its ${plural(project.tasks, "task")} first, on Your data. ` : ""}Deletes the project's endpoint keys and guardrails. The organization's plan and spend are kept.</span></span><button class="btn danger" type="button" data-action="deleteProject"${project.tasks ? html` disabled` : ""}>Delete project</button></div></div>
    </section>` : ""}`;
  },
  actions: {
    add: (form, _data, ctx) => addEndpoint(form, ctx),
    remove: (target, { endpoints }, ctx) => removeEndpoint(target, endpoints, ctx),
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
      if (!await confirm({ title: `Delete ${project.name}?`, body: "OpenMerit deletes the project's endpoint keys and guardrails. This cannot be undone.", confirm: "Delete project", danger: true, typeToConfirm: project.name })) return;
      await api.send("DELETE", `/api/projects/${encodeURIComponent(project.id)}`);
      go(`/?project=${DEFAULT_PROJECT}`);
    },
  },
};
