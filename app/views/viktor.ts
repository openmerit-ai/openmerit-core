// The Viktor app on Connections: its tile, the connect dialog, and the connected view. OpenMerit
// tests a scheduled task's cheaper presets on paused copies in Viktor's test mode and proposes the
// change; it never changes a task. The connection is cloud/src/viktor.ts's /api/connections/viktor.
import { ApiError, type ViktorConnection, type ViktorTask } from "../api.ts";
import { date, html, logo, plural, type Html } from "../html.ts";
import type { Ctx } from "../view.ts";

const VIKTOR_TASKS = "https://app.viktor.com/scheduled-tasks";
const VIKTOR_KEYS = "https://app.viktor.com/settings/api-keys";
// openmerit-core/src/connectors/viktor/api.ts's REQUIRED_SCOPES.
export const SCOPES = ["scripts:execute", "usage:read", "threads:create", "threads:read", "runs:create", "runs:read", "messages:create", "messages:read"];
// openmerit-core/src/connectors/viktor/scripts.ts's TOOLS: they must run without approval in the workspace.
export const TOOLS = ["list_crons", "get_path_info", "get_usage_threads", "create_agent_cron", "pause_cron", "test_cron_as_subagent", "delete_cron"];
const ASK = `Set these tools to run automatically, without approval, so OpenMerit's API scripts can list and test my scheduled tasks: ${TOOLS.join(", ")}.`;
const PRESETS = [1000, 2000, 5000];
// Viktor sells credits at $2.50 per 1,000.
const dollars = (credits: number): string => `$${(credits * 0.0025).toFixed(credits * 0.0025 % 1 ? 2 : 0)}`;
export const credits = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : Math.round(value).toLocaleString("en-US"));

type Group = "approve" | "evaluating" | "waiting" | "failed" | "done" | "skipped";
const groupOf = (task: ViktorTask): Group => task.status === "done" ? (task.result?.change && !task.result.approval ? "approve" : "done") : task.status;
const ORDER: Group[] = ["approve", "evaluating", "waiting", "failed", "done", "skipped"];

function status(task: ViktorTask): Html {
  switch (groupOf(task)) {
    case "approve": return html`<span class="pill good">${task.result!.change}</span><span class="sub"><a href="/r/${task.jobId}/">Review and approve</a></span>`;
    case "done": return html`${task.result?.change ? html`<span class="pill good">${task.result.change}</span>` : html`<span class="pill tag">Keep ${task.model ?? "its model"}</span>`}${task.result?.approval ? html`<span class="sub">Approved on ${date(task.result.approval.at)}</span>` : ""}<span class="sub"><a href="/r/${task.jobId}/">Open the result</a></span>`;
    case "evaluating": return html`<span class="pill live">Evaluating</span>${task.jobId ? html`<span class="sub"><a href="/r/${task.jobId}/">Open the run</a></span>` : ""}`;
    case "waiting": return html`<span class="pill warn">Waiting</span><span class="sub">About ${credits(task.estimatedCredits)} credits</span>`;
    case "failed": return html`<span class="pill bad">Did not finish</span><span class="sub">${task.reason ?? ""}</span>`;
    case "skipped": return html`<span class="sub">${task.reason ?? "Skipped"}</span>`;
  }
}

function action(task: ViktorTask, admin: boolean): Html {
  if (!admin) return html``;
  const group = groupOf(task);
  if (group === "waiting") return html`<button class="btn" type="button" data-action="start" data-id="${task.id}">Start</button>`;
  if (group === "failed") return html`<button class="btn" type="button" data-action="start" data-id="${task.id}">Start again</button>`;
  return html``;
}

const row = (task: ViktorTask, admin: boolean): Html => html`<tr${groupOf(task) === "evaluating" ? html` data-viktor-evaluating` : ""}>
  <td>${task.title}<span class="sub">${task.path}${task.paused ? " · paused" : ""}</span></td>
  <td>${task.model ? html`<code>${task.model}</code>` : html`<span class="sub">Workspace default</span>`}</td>
  <td class="num">${credits(task.credits30d)}</td>
  <td>${status(task)}</td>
  <td class="num">${action(task, admin)}</td>
</tr>`;

function tile(viktor: ViktorConnection, admin: boolean): Html {
  const ready = viktor.tasks.filter((task) => groupOf(task) === "approve").length;
  const state = !viktor.connected ? html`<span class="pill tag">Not connected</span>`
    : ready ? html`<span class="pill good">${plural(ready, "change")} to approve</span>`
    : html`<span class="pill tag good">Connected</span>`;
  return html`<div class="app-tile">
    <span class="app-mark">${logo("viktor")}</span>
    <span class="app-name">Viktor<span class="sub">Your AI employee's scheduled tasks. OpenMerit tests cheaper presets in Viktor's test mode and proposes the change for you to approve.</span></span>
    ${state}
    ${!viktor.connected ? (admin ? html`<button class="btn primary" type="button" data-action="connect-viktor">Connect</button>` : html`<span class="sub">An admin connects apps</span>`) : ""}
  </div>`;
}

// The credit meter: used by finished evaluations, then expected by running ones, against the cap.
function meter(viktor: ViktorConnection, admin: boolean): Html {
  const cap = viktor.creditCap ?? 0, used = viktor.creditsUsed ?? 0, reserved = viktor.creditsReserved ?? 0;
  const share = (value: number): string => `${cap ? Math.min(100, (value / cap) * 100).toFixed(1) : 0}%`;
  return html`<div class="credit-meter">
    <div class="credit-head"><span><b>${credits(used)}</b> of ${credits(cap)} credits${reserved ? html` <span class="sub inline">· ${credits(reserved)} in progress</span>` : ""}</span>
      ${admin ? html`<button class="btn link" type="button" data-action="viktor-cap">Edit cap</button>` : ""}</div>
    <div class="meter split" role="img" aria-label="${credits(used)} credits used and ${credits(reserved)} expected of ${credits(cap)}"><i style="width: ${share(used)}"></i><i class="reserved" style="width: ${share(reserved)}"></i></div>
    <span class="sub">About ${dollars(cap)} of Viktor credits at most. Evaluations past the cap wait ${admin ? "for Start" : "for an admin to start them"}.</span>
  </div>`;
}

export function viktorSection(viktor: ViktorConnection, admin: boolean): Html {
  if (!viktor.connected) return html`<div class="card">${tile(viktor, admin)}</div>`;
  const tasks = [...viktor.tasks].sort((a, b) => ORDER.indexOf(groupOf(a)) - ORDER.indexOf(groupOf(b)) || b.credits30d - a.credits30d);
  const shown = tasks.filter((task) => groupOf(task) !== "skipped"), skipped = tasks.filter((task) => groupOf(task) === "skipped");
  const count = (group: Group): number => tasks.filter((task) => groupOf(task) === group).length;
  const facts = [
    plural(viktor.tasks.length, "task"),
    ...(count("approve") ? [`${count("approve")} ready to approve`] : []),
    ...(count("evaluating") ? [`${count("evaluating")} evaluating`] : []),
    ...(count("waiting") ? [`${count("waiting")} waiting`] : []),
    ...(count("failed") ? [`${count("failed")} did not finish`] : []),
  ];
  return html`<div class="card viktor-card">
      ${tile(viktor, admin)}
      <div class="viktor-meta">
        <div><span class="facts">${facts.join(" · ")}</span><span class="sub">Key ending ${viktor.keyLast4 ?? ""} · ${viktor.keyType ?? "API"} key · connected ${date(viktor.connectedAt ?? null)}${viktor.listedAt ? ` · listed ${date(viktor.listedAt)}` : ""}</span></div>
        ${meter(viktor, admin)}
      </div>
      ${viktor.listingError ? html`<div class="card notice bad" role="alert"><p>The last listing failed: ${viktor.listingError}</p>${admin ? html`<p class="sub">Refresh lists the tasks again.</p>` : ""}</div>` : ""}
      ${admin ? html`<div class="viktor-actions"><button class="btn" type="button" data-action="refresh-viktor">Refresh tasks</button><a class="btn" href="${VIKTOR_TASKS}" target="_blank" rel="noopener">Open Viktor</a><span class="spacer"></span><button class="btn danger" type="button" data-action="disconnect-viktor">Disconnect</button></div>` : ""}
    </div>
    ${shown.length ? html`<div class="tablewrap" style="margin-top: 10px">
      <table class="viktor-tasks">
        <thead><tr><th>Task</th><th>Model</th><th class="num">Credits, 30 days</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown.map((task) => row(task, admin))}</tbody>
      </table>
    </div>` : viktor.listingError ? "" : html`<p class="note">No scheduled task OpenMerit can evaluate yet.</p>`}
    ${skipped.length ? html`<details class="skipped"><summary>${plural(skipped.length, "task")} OpenMerit cannot evaluate</summary>
      <div class="tablewrap" style="margin-top: 8px"><table class="viktor-tasks"><tbody>${skipped.map((task) => row(task, admin))}</tbody></table></div>
    </details>` : ""}
    <p class="note">Approving records the change; you make it in <a href="${VIKTOR_TASKS}" target="_blank" rel="noopener">Viktor's scheduled tasks</a>. OpenMerit does not change a task.</p>`;
}

// While a task evaluates, the page lists the connection again every 10 seconds, so its counts stay current.
let poll: ReturnType<typeof setTimeout> | undefined;
export function pollViktor(root: HTMLElement, ctx: Ctx): void {
  clearTimeout(poll);
  if (!root.querySelector("[data-viktor-evaluating]")) return;
  const tick = (): void => {
    if (!root.isConnected) return;
    if (document.hidden || document.querySelector("dialog[open]")) { poll = setTimeout(tick, 10_000); return; }
    void ctx.refresh();
  };
  poll = setTimeout(tick, 10_000);
}

const capChoices = (selected: number, name = "creditCap"): Html => {
  const preset = PRESETS.includes(selected);
  return html`<div class="cap-choices" role="radiogroup" aria-label="Credit cap">
    ${PRESETS.map((value) => html`<label class="cap-choice"><input type="radio" name="${name}" value="${String(value)}"${value === selected ? html` checked` : ""}><b>${credits(value)}</b><span>${dollars(value)}</span></label>`)}
    <label class="cap-choice custom"><input type="radio" name="${name}" value="custom"${preset ? "" : html` checked`}><b>Custom</b><input type="number" name="customCap" min="100" max="100000" step="100" value="${preset ? "" : String(selected)}" placeholder="10,000" aria-label="Custom credit cap"></label>
  </div>`;
};
const chosenCap = (form: HTMLFormElement): number => {
  const fields = new FormData(form), choice = String(fields.get("creditCap"));
  return choice === "custom" ? Number(fields.get("customCap")) : Number(choice);
};

function dialogShell(className: string, content: Html): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = `dialog ${className}`;
  dialog.innerHTML = content.__html;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // The custom amount selects Custom, and Custom focuses the amount.
  dialog.querySelectorAll<HTMLInputElement>("input[name=customCap]").forEach((input) => input.addEventListener("focus", () => {
    const radio = input.closest("label")?.querySelector<HTMLInputElement>("input[type=radio]");
    if (radio) radio.checked = true;
  }));
  dialog.querySelectorAll<HTMLInputElement>("input[type=radio][value=custom]").forEach((radio) => radio.addEventListener("change", () => radio.closest("label")?.querySelector<HTMLInputElement>("input[name=customCap]")?.focus()));
  dialog.showModal();
  return dialog;
}

// Connecting checks the key, lists the tasks and starts evaluating them in one call of about 20
// seconds; the dialog stays open and says so until it answers.
export function openConnect(ctx: Ctx): void {
  const dialog = dialogShell("connect-dialog", html`<form method="dialog" autocomplete="off">
    <div class="connect-head"><span class="app-mark">${logo("viktor")}</span><div><h2 class="dialog-title">Connect Viktor</h2><p>OpenMerit finds the scheduled tasks that could run on a cheaper preset, and proves it in Viktor's test mode.</p></div></div>
    <ol class="steps">
      <li><b>Create an API key</b>
        <p>In Viktor, open Settings → API Keys and create a key with these scopes. API keys need a paid or Enterprise plan.</p>
        <div class="scope-chips">${SCOPES.map((scope) => html`<code class="scope" data-scope="${scope}">${scope}</code>`)}</div>
        <p class="step-links"><a class="btn" href="${VIKTOR_KEYS}" target="_blank" rel="noopener">Open Viktor's API keys</a><button class="btn link" type="button" data-copy-scopes>Copy scopes</button></p>
      </li>
      <li><b>Let OpenMerit's tools run</b>
        <p>Viktor can make a tool wait for approval in chat, which an API script never gets. Ask Viktor to let these run automatically; it shows you an approval card.</p>
        <div class="scope-chips">${TOOLS.map((tool) => html`<code class="scope" data-tool="${tool}">${tool}</code>`)}</div>
        <p class="step-links"><button class="btn" type="button" data-copy-ask>Copy the message for Viktor</button></p>
      </li>
      <li><b>Paste the key</b>
        <input name="apiKey" type="password" required autocomplete="off" spellcheck="false" placeholder="zt_live_sk_…" aria-label="Viktor API key">
        <span class="sub">Stored encrypted. Only its last four characters are shown again.</span>
      </li>
      <li><b>Set a credit cap</b>
        <p>The most Viktor credits OpenMerit's test runs may use. One evaluation usually takes a few hundred.</p>
        ${capChoices(2000)}
      </li>
    </ol>
    <details class="disclosure"><summary>What OpenMerit does in your workspace</summary>
      <p>To measure a task, OpenMerit makes temporary copies of it: personal, paused, each set to a cheaper preset and titled "OpenMerit: &lt;task title&gt;". It runs each copy in Viktor's test mode, which captures Slack posts and other outside actions instead of sending them, then deletes the copies. Your tasks are never changed.</p>
    </details>
    <p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" type="submit" value="connect">Connect Viktor</button></div>
  </form>`);
  const form = dialog.querySelector("form")!;
  const error = form.querySelector<HTMLElement>(".form-error")!;
  const submit = form.querySelector<HTMLButtonElement>("button[value=connect]")!;
  let pending = false;
  dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
  form.querySelector("[data-copy-scopes]")?.addEventListener("click", (event) => {
    void navigator.clipboard.writeText(SCOPES.join(" ")).then(() => { (event.target as HTMLElement).textContent = "Copied"; });
  });
  form.querySelector("[data-copy-ask]")?.addEventListener("click", (event) => {
    void navigator.clipboard.writeText(ASK).then(() => { (event.target as HTMLElement).textContent = "Copied: paste it in a Viktor chat"; });
  });
  form.querySelector<HTMLInputElement>("input[name=apiKey]")?.focus();
  form.addEventListener("submit", (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value !== "connect") return;
    event.preventDefault();
    const apiKey = String(new FormData(form).get("apiKey") ?? "").trim(), creditCap = chosenCap(form);
    form.querySelectorAll(".scope.missing").forEach((chip) => chip.classList.remove("missing"));
    if (!Number.isFinite(creditCap) || creditCap < 100 || creditCap > 100_000) { error.textContent = "The credit cap must be between 100 and 100,000 credits."; error.hidden = false; return; }
    pending = true; error.hidden = true;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((input) => { input.disabled = true; });
    submit.setAttribute("aria-busy", "true");
    submit.textContent = "Checking the key and listing tasks…";
    ctx.api.send<ViktorConnection>("POST", "/api/connections/viktor", { apiKey, creditCap }).then((connected) => {
      pending = false;
      dialog.close();
      const evaluating = connected.tasks.filter((task) => task.status === "evaluating").length;
      ctx.toast(connected.listingError ? "Viktor connected, but listing its tasks failed. Refresh to try again." : `Viktor connected: ${plural(connected.tasks.length, "task")} listed${evaluating ? `, ${evaluating} evaluating` : ""}.`);
      return ctx.refresh();
    }, (failure: unknown) => {
      pending = false;
      form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((input) => { input.disabled = false; });
      submit.removeAttribute("aria-busy");
      submit.textContent = "Connect Viktor";
      const data = failure instanceof ApiError ? failure.data as { missingScopes?: unknown; needsApproval?: unknown } | null : null;
      const missing = Array.isArray(data?.missingScopes) ? data.missingScopes.map(String) : [], gated = Array.isArray(data?.needsApproval) ? data.needsApproval.map(String) : [];
      for (const scope of missing) form.querySelector(`.scope[data-scope="${scope}"]`)?.classList.add("missing");
      for (const tool of gated) form.querySelector(`.scope[data-tool="${tool}"]`)?.classList.add("missing");
      error.textContent = missing.length
        ? `This key is missing ${missing.length === 1 ? "the scope marked above" : `the ${missing.length} scopes marked above`}. Edit the key in Viktor to add ${missing.length === 1 ? "it" : "them"}, then connect again.`
        : gated.length
        ? `Viktor saved OpenMerit's calls to ${gated.join(" and ")} as drafts waiting for approval, so they did not run. Send Viktor the message in step 2, approve its card, then connect again. Dismiss the drafts these calls left.`
        : failure instanceof Error ? failure.message : "Viktor could not be connected. Try again.";
      error.hidden = false;
      form.querySelector<HTMLInputElement>("input[name=apiKey]")?.focus();
    });
  });
}

// Only the cap: connecting again would reset the credits used and the results.
export function openCap(viktor: ViktorConnection, ctx: Ctx): void {
  const used = (viktor.creditsUsed ?? 0) + (viktor.creditsReserved ?? 0);
  const dialog = dialogShell("cap-dialog", html`<form method="dialog">
    <h2 class="dialog-title">Viktor credit cap</h2>
    <p>${credits(viktor.creditsUsed)} credits used${viktor.creditsReserved ? `, ${credits(viktor.creditsReserved)} expected by running evaluations` : ""}. Raising the cap starts nothing: a waiting task starts with its Start button.</p>
    ${capChoices(viktor.creditCap ?? 2000)}
    <p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" type="submit" value="save">Save cap</button></div>
  </form>`);
  const form = dialog.querySelector("form")!, error = form.querySelector<HTMLElement>(".form-error")!;
  form.addEventListener("submit", (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value !== "save") return;
    event.preventDefault();
    const creditCap = chosenCap(form);
    if (!Number.isFinite(creditCap) || creditCap < 100 || creditCap > 100_000) { error.textContent = "The credit cap must be between 100 and 100,000 credits."; error.hidden = false; return; }
    ctx.api.send<ViktorConnection>("PATCH", "/api/connections/viktor", { creditCap }).then(() => {
      dialog.close();
      ctx.toast(`Credit cap set to ${credits(creditCap)}${creditCap < used ? `, below the ${credits(used)} already used or expected: nothing more starts` : ""}.`);
      return ctx.refresh();
    }, (failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : "The cap could not be saved."; error.hidden = false; });
  });
}
