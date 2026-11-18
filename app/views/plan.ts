import type { Spend } from "../api.ts";
import { date, html, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { header } from "./common.ts";

const statuses: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "good" }, trialing: { label: "Trial", tone: "good" },
  past_due: { label: "Payment overdue", tone: "bad" }, canceled: { label: "Canceled", tone: "" }, none: { label: "No plan", tone: "" },
};
const percent = (used: number, cap: number | null): number => (cap ? Math.min(100, Math.round((used / cap) * 100)) : 0);

function spendCard(title: string, who: string, used: number, cap: number | null, capNote: Html): Html {
  return html`<div class="card">
          <span class="sub">${title}</span>
          <span class="big">${usd(used)}</span>
          ${cap ? html`<div class="meter" aria-hidden="true"><i style="width: ${percent(used, cap)}%"></i></div>` : ""}
          <span class="sub">${cap ? `of the ${usd(cap)} cap · ` : ""}${who}</span>
          <p class="note">${capNote}</p>
        </div>`;
}

export const planView: View<Spend> = {
  load: ({ api }) => api.get<Spend>("/api/spend"),
  render(spend, { me, params }) {
    const plan = me.plan.status !== "none" && me.plan.status !== "canceled" ? me.plan : null;
    const status = statuses[plan?.status ?? "none"] ?? { label: plan?.status ?? "", tone: "" };
    const admin = me.role === "admin";
    const planCard = plan
      ? html`<div class="card">
          <div class="pick-head"><span class="pick-model">${plan.name ?? "OpenMerit"}</span><span class="pill ${status.tone}">${status.label}</span></div>
          <div class="meter" aria-hidden="true"><i style="width: ${percent(plan.usedEvals, plan.includedEvals)}%"></i></div>
          <span class="sub">${plan.usedEvals} of ${plan.includedEvals} evaluations used this period${plan.periodEnd ? ` · renews ${date(plan.periodEnd)}` : ""}</span>
          ${plan.status === "past_due" ? html`<p class="note bad">Stripe could not take the last payment. Update the card to keep measuring new tasks.</p>` : ""}
          <p style="margin-top: 10px">${admin ? html`<button class="btn" type="button" data-action="portal">Manage billing</button>` : html`<span class="sub">Ask an admin of ${me.account.name} to change billing.</span>`}</p>
          <p class="note">Cards, invoices and cancellation are in Stripe's billing portal.</p>
        </div>`
      : html`<div class="card">
          <div class="pick-head"><span class="pick-model">No plan</span>${me.plan.status === "canceled" ? html`<span class="pill">Canceled</span>` : ""}</div>
          <p class="sub" style="margin-top: 8px">A plan lets your coding agents' tasks be measured. OpenMerit pays for the model calls on OpenRouter; calls on your own endpoints bill your keys.</p>
          <p style="margin-top: 10px">${admin ? html`<button class="btn primary" type="button" data-action="checkout">Choose a plan</button>` : html`<span class="sub">Ask an admin of ${me.account.name} to choose a plan.</span>`}</p>
          <p class="note">Checkout opens on Stripe.</p>
        </div>`;
    return html`${header(me, "Plan and usage", "OpenMerit pays for every model call on OpenRouter behind your evaluations. Calls on endpoints you add bill your own keys, and are counted apart.", [spend.period.end ? `${date(spend.period.start)} to ${date(spend.period.end)}` : `Since ${date(spend.period.start)}`])}
    ${params.get("checkout") === "done" && !plan ? html`<div class="card notice" role="status"><p>Checkout finished. Stripe tells OpenMerit in a moment; reload this page if the plan does not show yet.</p></div>` : ""}
    <section aria-labelledby="plan">
      <h2 id="plan">Plan</h2>
      <div class="plan-card">${planCard}</div>
    </section>
    <section aria-labelledby="spend">
      <h2 id="spend">Model spend this period</h2>
      <div class="grid2">
        ${spendCard("Paid by OpenMerit", "included in your plan", spend.openmeritUsd, spend.monthlyCapUsd, html`Calls on OpenRouter with OpenMerit's key, within your plan's monthly cap.`)}
        ${spendCard("Paid by you", "billed to your keys by your providers", spend.customerUsd, spend.customerCapUsd, html`Calls on <a href="/connections/">your own endpoints</a>. Set a cap per job in <a href="/guardrails/">Guardrails</a>.`)}
      </div>
    </section>`;
  },
  actions: {
    async checkout(_target, _spend, { api, go }) {
      go((await api.send<{ url: string }>("POST", "/api/billing/checkout")).url);
    },
    async portal(_target, _spend, { api, go }) {
      go((await api.send<{ url: string }>("POST", "/api/billing/portal")).url);
    },
  },
};
