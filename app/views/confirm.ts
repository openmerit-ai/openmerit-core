// /confirm/?id=: a coding agent's critical request, such as a higher budget, grades or a switch, which
// runs only once a person here confirms it. A page of its own, without the sidebar, so it works on a phone.
import { date, html } from "../html.ts";
import type { View } from "../view.ts";

interface Confirmation {
  id: string; title: string; items: string[]; checks: "person" | "reverify"; requestedVia: string | null;
  status: "pending" | "confirming" | "done" | "failed" | "declined" | "expired"; createdAt: string; expiresAt: string;
  result: { status: number; body: unknown } | null;
}

const outcome = (item: Confirmation): string => {
  const body = (item.result?.body ?? {}) as { error?: unknown; jobId?: unknown };
  if (item.status === "declined") return "You declined it. Tell your coding agent.";
  if (item.status === "expired") return "It expired before anyone confirmed it. Ask your coding agent to make the request again.";
  if (item.status === "confirming") return "Confirmed. It is running.";
  if (item.status === "failed") return `Confirmed, but it failed: ${typeof body.error === "string" ? body.error : `status ${item.result?.status ?? "unknown"}`}`;
  return typeof body.jobId === "string" ? "Confirmed. The run started; your coding agent follows it." : "Confirmed and done. Tell your coding agent.";
};

export const confirmView: View<Confirmation | null> = {
  async load({ api, params }) {
    const id = params.get("id");
    return id ? api.get<Confirmation>(`/api/confirmations/${encodeURIComponent(id)}`) : null;
  },
  title: (item) => item?.title ?? "Confirm",
  render(item, { me }) {
    if (!item) return html`<div class="confirm-page"><h1 class="title">Nothing to confirm</h1><p class="lede">This link names no request. Open the link your coding agent gave you.</p></div>`;
    const body = (item.result?.body ?? {}) as { jobId?: unknown };
    return html`<div class="confirm-page">
      <p class="sub">A coding agent${item.requestedVia ? ` (${item.requestedVia})` : ""} asks you to confirm, in <b>${me.account.name}</b></p>
      <h1 class="title">${item.title}</h1>
      <ul class="confirm-items">${item.items.map((line) => html`<li>${line}</li>`)}</ul>
      ${item.status === "pending"
        ? html`<p class="sub">${item.checks === "reverify" ? "You may be asked to verify your sign-in first. " : ""}Expires ${date(item.expiresAt)}, ${new Date(item.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.</p>
          <div class="confirm-actions"><button class="btn" type="button" data-action="decline">Decline</button><button class="btn primary" type="button" data-action="confirm">Confirm</button></div>`
        : html`<div class="card notice${item.status === "failed" ? " bad" : ""}" role="status"><p>${outcome(item)}</p>${typeof body.jobId === "string" ? html`<p style="margin-top: 8px"><a href="/r/${body.jobId}/">Open the run</a></p>` : ""}</div>`}
    </div>`;
  },
  bind() { document.body.classList.add("standalone"); },
  actions: {
    async confirm(_target, item, { api, refresh }) {
      if (!item) return;
      await api.send("POST", `/api/confirmations/${encodeURIComponent(item.id)}`, { confirm: true });
      await refresh();
    },
    async decline(_target, item, { api, refresh }) {
      if (!item) return;
      await api.send("POST", `/api/confirmations/${encodeURIComponent(item.id)}`, { confirm: false });
      await refresh();
    },
  },
};
