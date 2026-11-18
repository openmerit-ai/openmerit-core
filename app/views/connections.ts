import type { Endpoint, EndpointKind } from "../api.ts";
import { ApiError } from "../api.ts";
import { date, html, logo, plural, provider, type Html } from "../html.ts";
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
          <span class="endpoint-meta"><span class="pill">OpenMerit's key · OpenMerit pays</span></span>
          <span></span>
        </div>`;

function endpointRow(endpoint: Endpoint, admin: boolean): Html {
  const models = endpoint.allowedModels === "all" ? "Every model" : endpoint.allowedModels.join(", ");
  const found = provider(endpoint.baseUrl);
  return html`<div class="row">
          <span>${logo(found.logo)}${found.name}<span class="sub">${endpoint.baseUrl} · ${kinds[endpoint.kind]?.label ?? endpoint.kind} API</span><span class="sub">${models}</span></span>
          <span class="endpoint-meta"><span class="pill">Key ending ${endpoint.keyLast4} · you pay</span><span class="sub">${endpoint.verifiedAt ? `Checked ${date(endpoint.verifiedAt)}` : "Not checked yet"}</span></span>
          ${admin ? html`<button class="btn danger" type="button" data-action="remove" data-id="${endpoint.id}" aria-label="Remove ${endpoint.baseUrl}">Remove</button>` : html`<span></span>`}
        </div>`;
}

export const connectionsView: View<Endpoint[]> = {
  load: ({ api }) => api.get<Endpoint[]>("/api/endpoints"),
  bind: bindKindSelect,
  render(endpoints, { me }) {
    const own = endpoints.filter((endpoint) => !endpoint.builtIn);
    const admin = me.role === "admin";
    return html`${header(me, "Connections", "Your coding agents are how OpenMerit gets its work. Your own endpoints are optional: OpenMerit measures on OpenRouter at its own cost.", [`${plural(own.length, "endpoint")} of yours`])}

    <section aria-labelledby="agents">
      <h2 id="agents">Coding agents</h2>
      <div class="card">
        <p>Add OpenMerit to a coding agent:</p>
        <div style="margin-top: 8px">${install()}</div>
        <div class="row" style="margin-top: 10px"><span>Disconnect every coding agent<span class="sub">Signs out every coding agent session for ${me.account.name}. Each one's next call opens sign-in again. Tasks and runs are kept.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="disconnect">Disconnect</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
    </section>

    <section aria-labelledby="endpoints">
      <h2 id="endpoints">Measuring endpoints</h2>
      <p class="note" style="margin: -2px 0 8px">Calls on your own endpoints use your key and bill your provider account. Add the endpoint your app calls so its current model is measured where it really runs.</p>
      <div class="card">${builtIn()}${own.map((endpoint) => endpointRow(endpoint, admin))}</div>
    </section>

    ${admin ? html`<section aria-labelledby="add">
      <h2 id="add">Add an endpoint</h2>
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
    async add(form, _endpoints, { api, refresh, toast }) {
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
    async remove(target, endpoints, { api, refresh, toast, confirm }) {
      const endpoint = endpoints.find((item) => item.id === target.dataset.id);
      if (!endpoint || !await confirm({ title: "Remove this endpoint?", body: `OpenMerit deletes the key ending ${endpoint.keyLast4} and stops measuring on ${endpoint.baseUrl}. Past runs keep their results.`, confirm: "Remove endpoint", danger: true })) return;
      await api.send("DELETE", `/api/endpoints/${encodeURIComponent(endpoint.id)}`);
      await refresh();
      toast("Endpoint removed.");
    },
    async disconnect(_target, _endpoints, { api, toast, confirm, me }) {
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
