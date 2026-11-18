import type { Basis, Report } from "../api.ts";
import { agent, date, html, model, plural, seconds, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { outcome } from "./runs.ts";

const title = (run: Report): string => {
  const pick = run.pick?.label ?? run.pick?.model, current = run.current.label ?? run.current.model;
  if (run.status === "running") return `${run.task}: measuring`;
  if (run.status === "failed") return `${run.task}: the run did not finish`;
  if (run.outcome === "switch" || run.outcome === "cheaper") return `${run.task}: switch to ${pick}`;
  return `${run.task}: keep ${current}`;
};

const basisCells: [Basis, string, string, string][] = [
  ["context", "Context from your agent", "The prompt, output shape and examples it sent", "Not used"],
  ["code", "Code", "The code your agent sent", "Not used"],
  ["traces", "Production traces", "Inputs from your traces", "None for this task"],
  ["eval", "Your own eval", "Your eval's scores", "None"],
];

function pickCard(run: Report): Html {
  const pick = run.candidates.find((c) => c.role === "pick"), current = run.candidates.find((c) => c.role === "current");
  if (!pick || !run.pick) return html``;
  const vs = (value: string): Html => (current && current !== pick ? html`<br>${current.model.label ?? current.model.model}: ${value}` : html``);
  return html`<div class="card">
        <div class="pick-head"><span class="pick-model">${model(run.pick)}</span><span class="pill good">Recommended</span></div>
        <span class="sub">${run.pick.endpoint} · <code>${run.pick.model}</code></span>
        <div class="stats">
          <div class="stat"><b>${pick.passed}/${pick.total}</b><span>test runs passed${vs(`${current?.passed}/${current?.total}`)}</span></div>
          <div class="stat"><b>${usd(pick.costPer1kUsd)}</b><span>per 1,000 calls${vs(usd(current?.costPer1kUsd))}</span></div>
          <div class="stat"><b>${seconds(pick.latencyMs)}</b><span>median latency${vs(seconds(current?.latencyMs ?? null))}</span></div>
        </div>
        ${run.monthlyCalls && pick.costPer1kUsd !== null && current?.costPer1kUsd != null
          ? html`<p class="note">At the ${run.monthlyCalls.toLocaleString("en-US")} calls a month your agent reported, about ${usd(current.costPer1kUsd * run.monthlyCalls / 1000)} a month becomes about ${usd(pick.costPer1kUsd * run.monthlyCalls / 1000)}.</p>` : ""}
      </div>`;
}

function change(run: Report): Html {
  if (!run.edit) return html`<div><h2>The change</h2><p class="note">No code change: keep the model in use today.</p></div>`;
  return html`<div>
        <h2>The change</h2>
        <div class="diff" role="img" aria-label="Code change in ${run.edit.file}">
          <div class="file">${run.edit.file}</div>
          <div class="del">- ${run.edit.before}</div>
          <div class="add">+ ${run.edit.after}</div>
        </div>
        <p class="note">${run.edit.applied ? "Your coding agent applied it in your working tree; it is not committed." : "Your coding agent has not applied it yet."}</p>
      </div>`;
}

const rowClass = { current: "current", pick: "picked", candidate: "", outside: "outside" } as const;

export const runView: View<Report> = {
  load: ({ api, id }) => api.get<Report>(`/api/runs/${encodeURIComponent(id ?? "")}`),
  title,
  render(run, { me }) {
    const shown = run.candidates.filter((c) => c.role !== "outside").slice(0, 3);
    const approved = run.cases.filter((c) => c.approved).length;
    const steps = run.search.map((step) => html`<span class="step">${step.step === "baseline" ? "" : `${step.step[0]?.toUpperCase()}${step.step.slice(1)} `}${model(step.model)}${step.pass === null ? "" : step.pass ? " · pass" : " · fail"}</span>`);
    return html`<div class="eyebrow">
      <a href="/">Runs</a><span>›</span><span>${run.id}</span><span>${run.measuredAt ? `Measured ${date(run.measuredAt)}` : `Started ${date(run.startedAt)}`}</span><span>Requested by ${agent(run.requestedBy)} in ${run.environment}</span>
    </div>
    <h1 class="title">${title(run)}</h1>
    ${run.summary ? html`<p class="lede">${run.summary}</p>` : ""}
    ${run.status === "running" ? html`<div class="card" style="margin-top: 28px">${outcome(run)}<p class="note">OpenMerit is measuring the candidates. Your coding agent gets the result on its next OpenMerit call, and this page fills in.</p></div>` : ""}
    ${run.status === "failed" ? html`<div class="card notice bad" style="margin-top: 28px" role="alert"><p>${run.error ?? "The run stopped before it could recommend a model."}</p></div>` : ""}
    ${run.status === "done" ? html`<div class="pick">${pickCard(run)}${change(run)}</div>` : ""}

    <section aria-labelledby="basis">
      <h2 id="basis">What this is based on</h2>
      <div class="basis">${basisCells.map(([key, label, on, off]) => html`<div class="${run.basis.includes(key) ? "on" : ""}"><b>${label}</b>${run.basis.includes(key) ? on : off}</div>`)}</div>
      ${run.casesTotal ? html`<p class="note">OpenMerit used ${plural(run.casesTotal, "test case")}${approved ? `; you confirmed ${approved} of them before the run` : ""}.${run.passRule ? ` Pass rule: ${run.passRule}.` : ""} Each model ran every case ${plural(run.repeats, "time")}.</p>` : ""}
    </section>

    ${run.candidates.length ? html`<section aria-labelledby="compare">
      <h2 id="compare">How the models compared</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Model</th><th class="num">Passed</th><th class="num">Per 1,000 calls</th><th class="num">Latency</th><th>Result</th></tr></thead>
          <tbody>
            ${run.candidates.map((c) => html`<tr class="${rowClass[c.role]}"><td>${model(c.model)}<span class="sub">${c.model.endpoint}${c.role === "current" ? " · in use today" : ""}${c.measuredOnly ? " · placed by measurement only" : ""}${c.funding === "customer" ? " · your key" : ""}</span></td><td class="num">${c.passed}/${c.total}</td><td class="num">${usd(c.costPer1kUsd)}</td><td class="num">${seconds(c.latencyMs)}</td><td><span class="pill${c.role === "pick" ? " good" : ""}">${c.verdict}</span></td></tr>`)}
          </tbody>
        </table>
      </div>
      ${run.candidates.some((c) => c.measuredOnly) ? html`<p class="note">Models outside the catalogue, such as a fine-tune on your own endpoint, have no capability index, so they were measured on every run rather than placed by the search.</p>` : ""}
    </section>` : ""}

    ${run.cases.length ? html`<section aria-labelledby="items">
      <h2 id="items">The test cases</h2>
      <div class="tablewrap">
        <table class="items">
          <thead><tr><th>Case</th><th>Expected</th>${shown.map((c, i) => html`<th class="num${i > 1 ? " hide-sm" : ""}">${model(c.model)}</th>`)}</tr></thead>
          <tbody>
            ${run.cases.map((item) => html`<tr><td>${item.input}<span class="sub">${item.id}${item.approved ? " · confirmed by you" : ""}</span></td><td><span class="label-code">${item.expected}</span></td>${shown.map((c, i) => {
              const result = item.results.find((r) => r.model === c.model.model);
              return html`<td class="num ${result ? (result.passed === result.runs ? "ok" : "no") : ""}${i > 1 ? " hide-sm" : ""}">${result ? `${result.passed}/${result.runs}` : "–"}</td>`;
            })}</tr>`)}
          </tbody>
        </table>
      </div>
      ${run.casesTotal > run.cases.length ? html`<p class="note">Showing ${run.cases.length} of ${run.casesTotal} cases.</p>` : ""}
    </section>` : ""}

    ${steps.length ? html`<section aria-labelledby="search">
      <h2 id="search">How OpenMerit searched</h2>
      <div class="path">${steps.map((step, i) => html`${i ? html`<span class="arrow">→</span>` : ""}${step}`)}</div>
      <p class="note">This run cost ${usd(run.spend.openmeritUsd)} on OpenMerit's account${run.spend.customerUsd ? ` and ${usd(run.spend.customerUsd)} on your own endpoints' keys` : ""}.</p>
    </section>` : ""}

    ${run.status === "done" ? html`<section aria-labelledby="share">
      <h2 id="share">Share</h2>
      <div class="card split">
        ${run.shareUrl
          ? html`<p>Anyone with this link can read the report: <a href="${run.shareUrl}">${run.shareUrl}</a></p>`
          : html`<p>Only members of ${me.account.name} can open this page. A public link lets pull request reviewers read it.</p><button class="btn" type="button" data-action="share">Create public link</button>`}
      </div>
    </section>` : ""}

    <section aria-labelledby="watch">
      <h2 id="watch">Watching</h2>
      <div class="card split">
        <p>OpenMerit re-runs these cases when a new model could fit this task.</p>
        <a class="btn" href="/tasks/">Manage tasks</a>
      </div>
    </section>`;
  },
  actions: {
    async share(_target, run, { api, refresh, toast }) {
      await api.send<{ url: string }>("POST", `/api/runs/${encodeURIComponent(run.id)}/share`);
      await refresh();
      toast("Public link created.");
    },
  },
};
