import type { Account } from "../view.ts";
import { html, installCommand, type Html } from "../html.ts";

export function header(me: Account, title: string, lede: string, facts: (string | Html)[] = []): Html {
  return html`<div class="eyebrow"><span>${me.account.name}</span>${facts.map((fact) => html`<span>${fact}</span>`)}</div>
    <h1 class="title">${title}</h1>
    <p class="lede">${lede}</p>`;
}

// The state of a page that has nothing to show yet: what fills it, and the first step.
export function empty(title: string, body: string, action: Html = install()): Html {
  return html`<div class="card empty"><p class="empty-title">${title}</p><p class="sub">${body}</p>${action}</div>`;
}

export const install = (): Html => html`<div class="diff"><div>${installCommand}</div></div><p class="note">Run this once in a terminal. The coding agent's first OpenMerit call opens sign-in.</p>`;
