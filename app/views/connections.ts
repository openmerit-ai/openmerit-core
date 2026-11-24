import type { Endpoint, EndpointKind, Repo } from "../api.ts";
import { ApiError } from "../api.ts";
import { ago, date, html, logo, model, plural, provider, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { header, install } from "./common.ts";

const kinds: Record<EndpointKind, { label: string; baseUrl: string }> = {
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
};
const isKind = (value: string): value is EndpointKind => value in kinds;

// OpenRouter on OpenMerit's key is always there; /api/endpoints lists only the customer's own.
const builtIn = (): Html => html`<div class="row">
          <span>${logo("openrouter")}OpenRouter<span class="sub">https://openrouter.ai/api/v1 · OpenRouter API</span><span class="sub">Every model</span></span>
          <span class="endpoint-meta"><span class="pill tag">OpenMerit's key · OpenMerit pays</span></span>
          <span></span>
        </div>`;

function endpointRow(endpoint: Endpoint, admin: boolean): Html {
  const models = endpoint.allowedModels === "all" ? "Every model" : endpoint.allowedModels.join(", ");
  const found = provider(endpoint.baseUrl);
  return html`<div class="row">
          <span>${logo(found.logo)}${found.name}<span class="sub">${endpoint.baseUrl} · ${kinds[endpoint.kind]?.label ?? endpoint.kind} API</span><span class="sub">${models}</span></span>
          <span class="endpoint-meta"><span class="pill tag">Key ending ${endpoint.keyLast4} · you pay</span><span class="sub">${endpoint.verifiedAt ? `Checked ${date(endpoint.verifiedAt)}` : "Not checked yet"}</span></span>
          ${admin ? html`<button class="btn danger" type="button" data-action="remove" data-id="${endpoint.id}" aria-label="Remove ${endpoint.baseUrl}">Remove</button>` : html`<span></span>`}
        </div>`;
}

// A repository's review: what it found, that it is running, or why it failed with what the last one found.
const REVIEWING = new Set(["queued", "reviewing"]);
function reviewText(repo: Repo): Html {
  const { review } = repo, result = review.result;
  const found = result
    ? html`<span class="sub">${result.totalCalls ? html`${plural(result.totalCalls, "model call")}: ${result.models.slice(0, 4).map((item, index) => html`${index ? ", " : ""}${item.catalogueId ? model(item.catalogueId) : item.value}`)}${result.models.length > 4 ? ` and ${result.models.length - 4} more` : ""}` : "No model calls in application code"}${result.notListed ? ` · ${result.notListed}` : ""} · ${plural(result.files, "file")} at ${result.commit.slice(0, 7)} on ${result.branch}</span>`
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

function repoRow(repo: Repo, admin: boolean): Html {
  const reviewing = REVIEWING.has(repo.review.status);
  const reviewed = repo.review.status === "done" && repo.review.finishedAt ? html`<span class="sub">Reviewed ${ago(repo.review.finishedAt)}</span>` : html``;
  return html`<div class="repo">
        <div class="row">
          <span>${logo("github")}<a href="${repo.url}" target="_blank" rel="noreferrer">${repo.fullName}</a>${reviewText(repo)}</span>
          <span class="endpoint-meta"><span class="pill tag">${repo.tokenLast4 ? `Private · token ending ${repo.tokenLast4}` : "Public"}</span>${reviewing ? html`<span class="sub"><span class="pill live">Reviewing</span></span>` : reviewed}</span>
          ${admin ? html`<span class="actions"><button class="btn" type="button" data-action="review" data-id="${repo.id}"${reviewing ? html` disabled` : ""} aria-label="Review ${repo.fullName} again">Review again</button><button class="btn danger" type="button" data-action="removeRepo" data-id="${repo.id}" aria-label="Remove ${repo.fullName}">Remove</button></span>` : html`<span></span>`}
        </div>
        ${modelCalls(repo)}
      </div>`;
}

type Data = { endpoints: Endpoint[]; repos: Repo[] };

// The cloud app can take a while to answer the first requests after a deploy, while it starts the
// account. A request that timed out or failed on the server is tried again before the page gives up.
export const RETRY_DELAYS_MS = [1000, 3000];
export async function retried<T>(load: () => Promise<T>, delays: readonly number[] = RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await load(); } catch (failure) {
      const transient = failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);
      if (!transient || attempt >= delays.length) throw failure;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

const REVIEW_POLL_MS = 3000;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;

export const connectionsView: View<Data> = {
  async load({ api }) {
    const [endpoints, repos] = await Promise.all([retried(() => api.get<Endpoint[]>("/api/endpoints")), retried(() => api.get<Repo[]>("/api/repos"))]);
    return { endpoints, repos };
  },
  bind(root, { refresh }, { repos }) {
    bindKindSelect(root);
    // While a review runs, the page looks again every few seconds and shows what it found.
    clearTimeout(reviewTimer);
    if (repos.some((repo) => REVIEWING.has(repo.review.status))) reviewTimer = setTimeout(() => { if (root.isConnected) void refresh(); }, REVIEW_POLL_MS);
  },
  render({ endpoints, repos }, { me }) {
    const own = endpoints.filter((endpoint) => !endpoint.builtIn);
    const admin = me.role === "admin";
    return html`${header(me, "Connections", "Your coding agents are how OpenMerit gets its work. Add a GitHub repository and OpenMerit reads its code to find the model calls, read-only. Your own endpoints are optional: OpenMerit measures on OpenRouter at its own cost.", [plural(repos.length, "repository", "repositories"), `${plural(own.length, "endpoint")} of yours`])}

    <section aria-labelledby="agents">
      <h2 id="agents">Coding Agents</h2>
      <div class="card">
        <p>Add OpenMerit to a coding agent:</p>
        <div style="margin-top: 8px">${install()}</div>
        <div class="row" style="margin-top: 10px"><span>Disconnect every coding agent<span class="sub">Signs out every coding agent session for ${me.account.name}. Each one's next call opens sign-in again. Tasks and runs are kept.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="disconnect">Disconnect</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
    </section>

    <section aria-labelledby="repos">
      <h2 id="repos">Repositories</h2>
      <p class="note" style="margin: -2px 0 8px">OpenMerit copies the default branch into a temporary folder, reads it to find the model calls, and deletes the copy. It never runs your code, pushes, or opens a pull request. It keeps where each model call is and the model it names, not your code.</p>
      ${repos.length ? html`<div class="card">${repos.map((repo) => repoRow(repo, admin))}</div>` : html`<div class="card"><p class="sub">No repositories yet.${admin ? " Add one below." : ""}</p></div>`}
      ${admin ? html`<form class="card form" data-action="addRepo" autocomplete="off" style="margin-top: 12px">
        <label>GitHub repository
          <input name="url" type="text" required spellcheck="false" placeholder="https://github.com/acme/app">
        </label>
        <label>Fine-grained token, for a private repository
          <input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
          <span class="sub">Leave this empty for a public repository. For a private one, <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">create a fine-grained token</a> with Repository access set to only the repositories OpenMerit reviews and Contents: Read-only. OpenMerit stores it encrypted and shows only its last four characters.</span>
        </label>
        <p class="form-error" role="alert" hidden></p>
        <p><button class="btn primary" type="submit">Add repository</button></p>
      </form>` : html`<p class="note">Only an admin of ${me.account.name} can add, review or remove repositories.</p>`}
    </section>

    <section aria-labelledby="endpoints">
      <h2 id="endpoints">Measuring Endpoints</h2>
      <p class="note" style="margin: -2px 0 8px">Calls on your own endpoints use your key and bill your provider account. Add the endpoint your app calls so its current model is measured where it really runs.</p>
      <div class="card">${builtIn()}${own.map((endpoint) => endpointRow(endpoint, admin))}</div>
    </section>

    ${admin ? html`<section aria-labelledby="add">
      <h2 id="add">Add an Endpoint</h2>
      <form class="card form" data-action="add" autocomplete="off">
        <label>Kind
          <select name="kind">${Object.entries(kinds).map(([kind, { label }]) => html`<option value="${kind}">${label}</option>`)}</select>
        </label>
        <label>Base URL
          <input name="baseUrl" type="url" required value="${kinds["openai-compatible"].baseUrl}" spellcheck="false">
        </label>
        <label>API key
          <input name="apiKey" type="password" required autocomplete="off" spellcheck="false" placeholder="Paste the key">
          <span class="sub">Sent only to OpenMerit, which stores it encrypted. It is never shown again; this page shows only its last four characters.</span>
        </label>
        <label>Allowed models
          <input name="allowedModels" type="text" spellcheck="false" placeholder="gpt-5-mini, gpt-5-nano">
          <span class="sub">Comma-separated model IDs this endpoint may run. Only an OpenRouter endpoint may leave this empty to allow every model.</span>
        </label>
        <p class="form-error" role="alert" hidden></p>
        <p><button class="btn primary" type="submit">Add endpoint</button></p>
      </form>
    </section>` : html`<p class="note">Only an admin of ${me.account.name} can add or remove endpoints.</p>`}`;
  },
  actions: {
    async add(form, _data, { api, refresh, toast }) {
      if (!(form instanceof HTMLFormElement)) return;
      const fields = new FormData(form);
      const kind = String(fields.get("kind"));
      const error = form.querySelector<HTMLElement>(".form-error");
      if (!isKind(kind)) return;
      const models = String(fields.get("allowedModels")).split(",").map((name) => name.trim()).filter(Boolean);
      try {
        await api.send("POST", "/api/endpoints", {
          kind,
          baseUrl: String(fields.get("baseUrl")).trim(),
          apiKey: String(fields.get("apiKey")).trim(),
          allowedModels: models.length ? models : "all",
        });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      // The key leaves the page with the form; the list shows only its last four characters.
      form.reset();
      await refresh();
      toast("Endpoint added. Its key will not be shown again.");
    },
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
    async review(target, _data, { api, refresh }) {
      await api.send("POST", `/api/repos/${encodeURIComponent(target.dataset.id ?? "")}/review`);
      await refresh();
    },
    async removeRepo(target, { repos }, { api, refresh, toast, confirm }) {
      const repo = repos.find((item) => item.id === target.dataset.id);
      if (!repo || !await confirm({ title: "Remove this repository?", body: `OpenMerit deletes what it found in ${repo.fullName}${repo.tokenLast4 ? ` and the token ending ${repo.tokenLast4}` : ""}, and stops reading it.`, confirm: "Remove repository", danger: true })) return;
      await api.send("DELETE", `/api/repos/${encodeURIComponent(repo.id)}`);
      await refresh();
      toast("Repository removed.");
    },
    async remove(target, { endpoints }, { api, refresh, toast, confirm }) {
      const endpoint = endpoints.find((item) => item.id === target.dataset.id);
      if (!endpoint || !await confirm({ title: "Remove this endpoint?", body: `OpenMerit deletes the key ending ${endpoint.keyLast4} and stops measuring on ${endpoint.baseUrl}. Past runs keep their results.`, confirm: "Remove endpoint", danger: true })) return;
      await api.send("DELETE", `/api/endpoints/${encodeURIComponent(endpoint.id)}`);
      await refresh();
      toast("Endpoint removed.");
    },
    async disconnect(_target, _data, { api, toast, confirm, me }) {
      if (!await confirm({ title: "Disconnect every coding agent?", body: `Every coding agent signed in to ${me.account.name} loses access to OpenMerit's tools until it signs in again. Tasks, runs and watches are kept.`, confirm: "Disconnect", danger: true })) return;
      await api.send("POST", "/api/disconnect");
      toast("Coding agents disconnected. Their next call opens sign-in.");
    },
  },
};

// Changing the kind fills in its usual base URL unless the user has typed their own.
function bindKindSelect(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("form[data-action=add]");
  const select = form?.querySelector<HTMLSelectElement>("select[name=kind]");
  const base = form?.querySelector<HTMLInputElement>("input[name=baseUrl]");
  if (!select || !base) return;
  select.addEventListener("change", () => {
    const defaults = Object.values(kinds).map((kind) => kind.baseUrl);
    if (isKind(select.value) && (!base.value || defaults.includes(base.value))) base.value = kinds[select.value].baseUrl;
  });
}
