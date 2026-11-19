import type { Endpoint, EndpointKind, ViktorConnection, ViktorTask } from "../api.ts";
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

// The Viktor connection: OpenMerit tests a task's cheaper presets on paused copies in Viktor's test mode, and proposes the change.
const VIKTOR_TASKS = "https://app.viktor.com/scheduled-tasks";
const credits = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : Math.round(value).toLocaleString("en-US"));

function taskStatus(task: ViktorTask, admin: boolean): Html {
  switch (task.status) {
    case "skipped": return html`<span class="pill">Skipped</span><span class="sub">${task.reason ?? ""}</span>`;
    case "evaluating": return html`<span class="pill live">Evaluating</span>${task.jobId ? html`<span class="sub"><a href="/r/${task.jobId}/">Open the run</a></span>` : ""}`;
    case "failed": return html`<span class="pill bad">Did not finish</span><span class="sub">${task.reason ?? ""}</span>${admin ? html` <button class="btn" type="button" data-action="start" data-id="${task.id}">Start again</button>` : ""}`;
    case "waiting": return html`<span class="pill warn">Waiting</span><span class="sub">About ${credits(task.estimatedCredits)} credits. ${task.reason ?? ""}</span>${admin ? html` <button class="btn" type="button" data-action="start" data-id="${task.id}">Start</button>` : ""}`;
    case "done": {
      const result = task.result;
      const approved = result?.approval ? html`<span class="sub">Approved by ${result.approval.by} on ${date(result.approval.at)}</span>` : "";
      return html`${result?.change ? html`<span class="pill good">${result.change}</span>` : html`<span class="pill tag">Keep ${task.model ?? "its model"}</span>`}${approved}<span class="sub"><a href="/r/${task.jobId}/">${result?.change && !result.approval ? "Review and approve" : "Open the result"}</a></span>`;
    }
  }
}

function viktorSection(viktor: ViktorConnection, admin: boolean): Html {
  if (!viktor.connected) return html`<div class="card">
        <div class="row"><span>Viktor<span class="sub">Scheduled AI tasks in your Viktor workspace. Not connected.</span></span><span></span></div>
        ${admin ? html`<form class="form" data-action="connect-viktor" autocomplete="off" style="margin-top: 10px">
          <label>Viktor API key
            <input name="apiKey" type="password" required autocomplete="off" spellcheck="false" placeholder="zt_live_sk_…">
            <span class="sub">From Viktor's Settings → API Keys, on a paid or Enterprise plan. It needs the scopes scripts:execute, usage:read, threads:create, threads:read, runs:create, runs:read, messages:create and messages:read. OpenMerit stores it encrypted and shows only its last four characters.</span>
          </label>
          <label>Credit cap
            <input name="creditCap" type="number" min="100" max="100000" step="100" value="2000" required>
            <span class="sub">The most Viktor credits OpenMerit's test runs may use from your workspace, about $5 per 2,000. Tasks past it wait with a Start button.</span>
          </label>
          <p class="note">To measure a task, OpenMerit makes temporary copies of it in your workspace: personal, paused, each set to a cheaper preset and titled "OpenMerit: &lt;task title&gt;". It runs each copy in Viktor's test mode, which captures Slack posts and other outside actions instead of sending them, then deletes the copies. It never changes your tasks: a result proposes the change, and you make it in Viktor after you approve it.</p>
          <p class="form-error" role="alert" hidden></p>
          <p><button class="btn primary" type="submit">Connect Viktor</button></p>
        </form>` : html`<p class="note">Only an admin can connect Viktor.</p>`}
      </div>`;
  return html`<div class="card">
        <div class="row"><span>Viktor<span class="sub">Key ending ${viktor.keyLast4 ?? ""} · ${viktor.keyType ?? "API"} key · connected ${date(viktor.connectedAt ?? null)}</span><span class="sub">${credits(viktor.creditsUsed)} of ${credits(viktor.creditCap)} credits used${viktor.creditsReserved ? `, ${credits(viktor.creditsReserved)} expected by running evaluations` : ""}</span></span>
          ${admin ? html`<span class="endpoint-meta"><button class="btn" type="button" data-action="refresh-viktor">Refresh</button><button class="btn danger" type="button" data-action="disconnect-viktor">Disconnect</button></span>` : html`<span></span>`}</div>
        ${viktor.listingError ? html`<p class="note bad" role="alert">The last listing failed: ${viktor.listingError}</p>` : ""}
      </div>
      <div class="tablewrap" style="margin-top: 10px">
        <table>
          <thead><tr><th>Task</th><th>Model</th><th class="num">Credits, 30 days</th><th>Status</th></tr></thead>
          <tbody>
            ${viktor.tasks.map((task) => html`<tr><td>${task.title}<span class="sub">${task.path}${task.paused ? " · paused" : ""}</span></td><td>${task.model ? html`<code>${task.model}</code>` : html`<span class="sub">workspace default</span>`}</td><td class="num">${credits(task.credits30d)}</td><td>${taskStatus(task, admin)}</td></tr>`)}
          </tbody>
        </table>
      </div>
      <p class="note">Changes are made in <a href="${VIKTOR_TASKS}" target="_blank" rel="noopener">Viktor's scheduled tasks</a>; OpenMerit does not change a task.</p>`;
}

type Data = { endpoints: Endpoint[]; viktor: ViktorConnection };

export const connectionsView: View<Data> = {
  async load({ api }) {
    const [endpoints, viktor] = await Promise.all([api.get<Endpoint[]>("/api/endpoints"), api.get<ViktorConnection>("/api/connections/viktor").catch((): ViktorConnection => ({ connected: false, tasks: [] }))]);
    return { endpoints, viktor };
  },
  bind: bindKindSelect,
  render({ endpoints, viktor }, { me }) {
    const own = endpoints.filter((endpoint) => !endpoint.builtIn);
    const admin = me.role === "admin";
    return html`${header(me, "Connections", "Your coding agents are how OpenMerit gets its work. Your own endpoints are optional: OpenMerit measures on OpenRouter at its own cost.", [`${plural(own.length, "endpoint")} of yours`])}

    <section aria-labelledby="agents">
      <h2 id="agents">Coding Agents</h2>
      <div class="card">
        <p>Add OpenMerit to a coding agent:</p>
        <div style="margin-top: 8px">${install()}</div>
        <div class="row" style="margin-top: 10px"><span>Disconnect every coding agent<span class="sub">Signs out every coding agent session for ${me.account.name}. Each one's next call opens sign-in again. Tasks and runs are kept.</span></span>${admin ? html`<button class="btn danger" type="button" data-action="disconnect">Disconnect</button>` : html`<span class="sub">Admins only</span>`}</div>
      </div>
    </section>

    <section aria-labelledby="apps">
      <h2 id="apps">Apps</h2>
      <p class="note" style="margin: -2px 0 8px">Apps whose AI tasks OpenMerit evaluates on their own: it lists the tasks, evaluates the ones it can, highest spend first, and proposes a cheaper model for you to approve.</p>
      ${viktorSection(viktor, admin)}
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
    async "connect-viktor"(form, _data, { api, refresh, toast }) {
      if (!(form instanceof HTMLFormElement)) return;
      const fields = new FormData(form);
      const error = form.querySelector<HTMLElement>(".form-error");
      try {
        await api.send("POST", "/api/connections/viktor", { apiKey: String(fields.get("apiKey")).trim(), creditCap: Number(fields.get("creditCap")) });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      form.reset();
      await refresh();
      toast("Viktor connected. OpenMerit is evaluating the tasks it can.");
    },
    async "refresh-viktor"(_target, _data, { api, refresh, toast }) {
      const listed = await api.send<{ refused: string | null; started: string[] }>("POST", "/api/connections/viktor/refresh");
      await refresh();
      toast(listed.refused ?? (listed.started.length ? `Started ${plural(listed.started.length, "evaluation")}.` : "Tasks listed again."));
    },
    async start(target, data, { api, refresh, toast, confirm }) {
      const task = data.viktor.tasks.find((item) => item.id === target.dataset.id);
      if (!task || !await confirm({ title: `Evaluate ${task.title}?`, body: `OpenMerit tests ${task.title}'s cheaper presets on paused copies in Viktor's test mode, for about ${credits(task.estimatedCredits)} credits from your workspace. It counts as one evaluation on your plan.`, confirm: "Start" })) return;
      await api.send("POST", `/api/connections/viktor/tasks/${encodeURIComponent(task.id)}/start`);
      await refresh();
      toast(`Evaluating ${task.title}.`);
    },
    async "disconnect-viktor"(_target, _data, { api, refresh, toast, confirm }) {
      if (!await confirm({ title: "Disconnect Viktor?", body: "OpenMerit deletes the key and stops listing and evaluating your Viktor tasks. Past results and approvals are kept.", confirm: "Disconnect", danger: true })) return;
      await api.send("DELETE", "/api/connections/viktor");
      await refresh();
      toast("Viktor disconnected.");
    },
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
