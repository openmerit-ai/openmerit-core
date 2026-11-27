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

// On a self-hosted server, the coding agent connects to that server with its token instead (setLocalServer).
let localServer: string | null = null;
export const setLocalServer = (origin: string): void => { localServer = origin; };
export const install = (): Html => localServer
  ? html`<div class="diff"><div>claude mcp add --transport http openmerit ${localServer}/mcp --header "Authorization: Bearer $(cat ~/.openmerit/server/token)"</div></div><p class="note">Run this once in a terminal on this machine. The token in <code>~/.openmerit/server/token</code> signs the coding agent in to this server.</p>`
  : html`<div class="diff"><div>${installCommand}</div></div><p class="note">Run this once in a terminal. The coding agent's first OpenMerit call opens sign-in.</p>`;
