import type { Approval, Endpoint, Fix, JobView, MeasuredModel, Report } from "../api.ts";
import { liveText } from "../live.ts";
import { date, endpointName, html, setEndpoints, model, modelName, per1k, plural, seconds, usd, type Html } from "../html.ts";
import type { Ctx, View } from "../view.ts";
import { show } from "./guardrails.ts";

// GET /api/runs/:id returns the saved report once the job has one, and the job's live state before.
type Data = Report | JobView;
const isLive = (data: Data): data is JobView => "report" in data && data.report === null;

const verdicts: Record<Report["status"], string> = {
  picked: "",
  keep_current: "No cheaper model passed as many cases, so the model in use now stays.",
  baseline_failed: "The model in use now could not be measured or passed none of the cases, so there was nothing to compare against.",
  no_cases: "No case had a known correct answer, so nothing was measured.",
  no_candidates: "No allowed model is cheaper than the one in use now.",
  agent_eval_failed: "Every cheaper switch failed the agent's eval, so none is proposed.",
  stopped: "The run stopped at its budget before the finalists were measured, so it proposes no switch. These are the measurements so far.",
  failed: "The run failed before it finished, so it proposes no switch. These are the measurements so far.",
};

function title(data: Data): string {
  if (isLive(data)) return data.status === "failed" ? `${data.task}: the run did not finish` : data.status === "stopped" ? `${data.task}: stopped` : data.status === "needs_input" ? `${data.task}: needs input` : `${data.task}: evaluating`;
  if (data.status === "picked" && data.pick) return `${data.task}: switch to ${modelName(data.pick.model)}`;
  if (data.status === "keep_current" && data.baseline) return `${data.task}: keep ${modelName(data.baseline.model)}`;
  return `${data.task}: no switch`;
}

// A measuring run with live data: the candidate's pass rate so far as a Liveline chart against
// the model in use today, with the numbers Torph morphs as each case finishes (app/live.ts).
function measuring(job: JobView): Html {
  const live = job.live!, text = liveText(job), id = job.jobId;
  return html`<div class="pick-head"><span class="pick-model">${model(live.model)}</span><span class="pill live" data-live="${id}" data-morph="status">${text.status}</span></div>
      <span class="sub">on ${endpointName(live.endpoint)}${live.baseline ? html` · against ${model(live.baseline.model)}, which passed ${Math.round(live.baseline.rate)}%` : ""}</span>
      <div class="live-chart" data-live="${id}" role="img" aria-label="Pass rate so far"></div>
      <div class="stats"><div class="stat"><b data-live="${id}" data-morph="cases">${text.cases}</b><span>cases run</span></div><div class="stat"><b data-live="${id}" data-morph="rate">${text.rate}</b><span>passed so far</span></div></div>
      <p class="note">Your coding agent gets the result on its next OpenMerit call, and this page shows the report.</p>`;
}

const again = html`<p style="margin-top: 10px"><button class="btn" type="button" data-action="rerun">Run again</button></p>`;

function live(job: JobView): Html {
  const progress = job.progress.planned ? `${job.progress.measured} of about ${job.progress.planned} measurements done` : `${plural(job.progress.measured, "measurement")} done`;
  const body = {
    queued: html`<span class="pill">Queued</span><p class="note">The run starts in a moment.</p>`,
    running: job.live ? measuring(job) : html`<span class="pill live">Evaluating</span><span class="sub">${job.phase.replace("_", " ")} · ${progress}</span><p class="note">Your coding agent gets the result on its next OpenMerit call, and this page shows the report.</p>`,
    needs_input: html`<span class="pill warn">Needs input</span><p class="note">OpenMerit asked ${plural(job.questions.length, "question")} in your coding agent, such as a check of the test labels. The run continues once it answers.</p>`,
    failed: html`<p>${job.error ?? "The run stopped before it could recommend a model."}</p>${again}`,
    stopped: html`<p>The run was stopped${job.error ? `: ${job.error}` : "."}</p>${again}`,
    done: html`<p>The run finished; its report is being saved. Reload in a moment.</p>`,
  }[job.status];
  return html`<div class="eyebrow" data-live="${job.jobId}" data-status="${job.status}"><a href="/">Runs</a><span>›</span><span>${job.jobId}</span><span>Started ${date(job.createdAt)}</span></div>
    <h1 class="title">${title(job)}</h1>
    <div class="card${job.status === "failed" ? " notice bad" : ""}" style="margin-top: 20px"${job.status === "failed" ? html` role="alert"` : ""}>${body}${job.notices.map((notice) => html`<p class="note">${notice}</p>`)}</div>
    ${job.provisional ? html`<section aria-labelledby="provisional"><h2 id="provisional">Provisional Pick</h2><div class="card"><p>${model(job.provisional.model)} on ${endpointName(job.provisional.endpoint)}${job.provisional.estCostPerCallUsd !== null ? html` · about ${per1k(job.provisional.estCostPerCallUsd)} per 1,000 calls` : ""}</p><p class="note">${job.provisional.reason} Chosen from the catalogue before measuring.</p></div></section>` : ""}
`;
}

function verdict(item: MeasuredModel, pick: string | null, near: boolean): Html {
  if (item.role === "baseline") return html`<span class="pill tag">In use now</span>`;
  if (near) return html`<span class="pill warn">Near miss</span>`;
  if (item.model === pick) return html`<span class="pill good">Picked</span>`;
  if (item.status === "unavailable") return html`<span class="pill warn">Unavailable</span>`;
  if (item.status === "screened_out") return html`<span class="pill">Screened out</span>`;
  return item.qualified ? html`<span class="pill good">Qualifies</span>` : html`<span class="pill bad">Below the bar</span>`;
}

function pickCard(report: Report): Html {
  const pick = report.pick, base = report.baseline;
  if (!pick) return base
    ? html`<div class="card"><div class="pick-head"><span class="pick-model">${model(base.model)}</span><span class="pill tag">In use now</span></div><span class="sub">${endpointName(base.endpoint)}</span>
        <div class="stats"><div class="stat"><b>${base.passes}/${base.total}</b><span>cases passed</span></div><div class="stat"><b>${per1k(base.costPerCallUsd)}</b><span>per 1,000 calls</span></div><div class="stat"><b>${seconds(base.latencyMs)}</b><span>mean latency</span></div></div></div>`
    : html`<div class="card"><p>${verdicts[report.status]}</p></div>`;
  const measured = report.candidates.find((item) => item.model === pick.model && item.endpoint === pick.endpoint);
  const vs = (value: string): Html => (base ? html`<br>${modelName(base.model)}: ${value}` : html``);
  return html`<div class="card">
        <div class="pick-head"><span class="pick-model">${model(pick.model)}</span><span class="pill good">Recommended</span></div>
        <span class="sub">${endpointName(pick.endpoint)} · <code>${pick.endpointModel}</code></span>
        <div class="stats">
          <div class="stat"><b>${pick.passes}/${pick.total}</b><span>cases passed${vs(base ? `${base.passes}/${base.total}` : "–")}</span></div>
          <div class="stat"><b>${per1k(pick.costPerCallUsd)}</b><span>per 1,000 calls${vs(per1k(base?.costPerCallUsd ?? null))}</span></div>
          <div class="stat"><b>${seconds(measured?.latencyMs ?? null)}</b><span>mean latency${vs(seconds(base?.latencyMs ?? null))}</span></div>
        </div>
        ${pick.savingPerCallUsd ? html`<p class="note">It saves about ${per1k(pick.savingPerCallUsd)} per 1,000 calls.</p>` : ""}
      </div>`;
}

// The button that fixes a notice: rerun, raise the budget and rerun, open the page that fixes it, or copy
// what the coding agent should do, for the fixes only it can make. data-fix is the fix's index.
function fixButton(fix: Fix, index: number): Html {
  switch (fix.kind) {
    case "raise_budget": return html`<button class="btn" type="button" data-action="fix" data-fix="${String(index)}">Raise budget to ${usd(fix.budgetUsd)} and rerun</button>`;
    case "rerun": return html`<button class="btn" type="button" data-action="fix" data-fix="${String(index)}">Run again</button>`;
    case "open": return html`<a class="btn" href="${fix.path}">${fix.label}</a>`;
    case "ask_agent": return html`<button class="btn" type="button" data-action="fix" data-fix="${String(index)}">Copy prompt for your agent</button>`;
  }
}

// The cloud app's notices that only describe the search's routine bookkeeping. Every other
// notice, such as a budget stop, challengers left unmeasured or an agent-eval warning, changes
// how to read the result and is shown under Notes.
const routine = [/catalogue models? without an ECI left out/, /no capability index, so .* measured as challengers/];
export const notes = (notices: string[]): string[] => notices.filter((notice) => !routine.some((pattern) => pattern.test(notice)));

/** The cloud app's sentences mark model IDs and code with backticks, as in its Markdown report. */
const prose = (text: string): Html[] => text.split("`").map((part, index) => (index % 2 ? html`<code>${part}</code>` : html`${part}`));

// Viktor credits cost $2.50 per 1,000; a connection result's cost per call is per test run.
const CREDIT_USD = 0.0025;
const perRun = (usdPerRun: number | null): string => (usdPerRun === null ? "–" : `${Math.round(usdPerRun / CREDIT_USD).toLocaleString("en-US")} credits`);

// A connected app's result: the change to make there, and Approve change, which records who approved it and when.
function connectionChange(report: Report, admin: boolean): Html {
  const connection = report.connection!, change = connection.change;
  if (!change) return html`<div><h2>Change</h2><p class="note">No change: ${connection.taskTitle} keeps <code>${connection.currentModel}</code>.</p></div>`;
  const approved = report.approved;
  return html`<div>
        <h2>Change</h2>
        <div class="card">
          <p><b>${change.text}</b></p>
          <p class="note">Make it in <a href="${change.link}" target="_blank" rel="noopener">Viktor's scheduled tasks</a>: open ${connection.taskTitle} and set its model to <code>${change.model}</code>. OpenMerit does not change the task.</p>
          ${approved ? html`<p><span class="pill good">Approved</span> <span class="sub">by ${approved.by} on ${date(approved.at)} at ${new Date(approved.at).toISOString().slice(11, 16)} UTC</span></p>`
            : admin ? html`<p style="margin-top: 12px"><button class="btn primary" type="button" data-action="approve">Approve change</button></p><p class="note">Approving records who approved the change and when. You then make the change in Viktor yourself.</p>`
            : html`<p class="note">An admin approves this change.</p>`}
        </div>
      </div>`;
}

function connectionPick(report: Report): Html {
  const pick = report.pick, base = report.baseline, connection = report.connection!;
  const head = pick ?? base;
  if (!head) return html`<div class="card"><p>${verdicts[report.status]}</p></div>`;
  return html`<div class="card">
        <div class="pick-head"><span class="pick-model"><code>${head.model}</code></span>${pick ? html`<span class="pill good">Recommended</span>` : html`<span class="pill tag">In use now</span>`}</div>
        <span class="sub">Viktor preset for ${connection.taskTitle}</span>
        <div class="stats">
          <div class="stat"><b>${head.passes}/${head.total}</b><span>checks passed${pick && base ? html`<br><code>${base.model}</code>: ${base.passes}/${base.total}` : ""}</span></div>
          <div class="stat"><b>${perRun(head.costPerCallUsd)}</b><span>per test run${pick && base ? html`<br><code>${base.model}</code>: ${perRun(base.costPerCallUsd)}` : ""}</span></div>
          <div class="stat"><b>${connection.creditsUsed.toLocaleString("en-US")}</b><span>credits this evaluation used</span></div>
        </div>
      </div>`;
}

function change(report: Report): Html {
  const { edits, instructions } = report.edit;
  if (!edits.length && !instructions) return html`<div><h2>Change</h2><p class="note">No code change: keep the model in use now.</p></div>`;
  return html`<div>
        <h2>Change</h2>
        ${edits.map((edit) => html`<div class="diff" role="img" aria-label="Code change in ${edit.file}" style="margin-bottom: 10px">
          <div class="file">${edit.file}:${edit.line}</div>
          <div class="del">- ${edit.before}</div>
          <div class="add">+ ${edit.after}</div>
        </div>`)}
        ${instructions ? html`<div class="card notice"><p>${prose(instructions)}</p></div>` : ""}
        <p class="note">Your coding agent received this change with the result.</p>
      </div>`;
}

function report(data: Report, admin: boolean): Html {
  const models = [data.baseline, ...data.candidates].filter((item): item is MeasuredModel => item !== null);
  const pick = data.pick?.model ?? null;
  const from = Object.entries(data.guardrails.from);
  const misses = data.nearMisses ?? [];
  const shown = notes(data.notices);
  const near = (item: MeasuredModel) => item.role === "candidate" && misses.some((miss) => miss.model === item.model && miss.endpoint === item.endpoint);
  return html`<div class="eyebrow"><a href="/">Runs</a><span>›</span><span>${data.jobId}</span><span>Measured ${date(data.createdAt)}</span></div>
    <h1 class="title">${title(data)}</h1>
    <div class="pick">${data.connection ? html`${connectionPick(data)}${connectionChange(data, admin)}` : html`${pickCard(data)}${change(data)}`}</div>

    ${models.length ? html`<section aria-labelledby="compare">
      <h2 id="compare">Models Compared</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Model</th><th class="num">Passed</th><th class="num">${data.connection ? "Per test run" : "Per 1,000 calls"}</th><th class="num">${data.connection ? "Run time" : "Latency"}</th><th>Result</th></tr></thead>
          <tbody>
            ${models.map((item) => html`<tr class="${item.role === "baseline" ? "current" : item.model === pick ? "picked" : ""}">
              <td>${model(item.model)}<span class="sub">${endpointName(item.endpoint)}${item.funding === "customer" ? " · your key" : ""}${item.inCatalogue || data.connection ? "" : " · placed by measurement only"}${item.note ? ` · ${item.note}` : ""}</span></td>
              <td class="num">${item.status === "unavailable" ? "–" : `${item.passes}/${item.total}`}</td>
              <td class="num">${data.connection ? perRun(item.costPerCallUsd) : per1k(item.costPerCallUsd)}${item.costIsEstimate && item.costPerCallUsd !== null ? html`<span class="sub">estimate</span>` : ""}</td>
              <td class="num">${seconds(item.latencyMs)}</td>
              <td>${verdict(item, pick, near(item))}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </section>` : ""}

    ${misses.length && data.baseline ? html`<section aria-labelledby="near-misses">
      <h2 id="near-misses">Near Misses</h2>
      <div class="card">
        <p>${plural(misses.length, "model")} missed ${modelName(data.baseline.model)}'s ${data.baseline.passes}/${data.baseline.total} by at most one case per run, so ${misses.length === 1 ? "it does" : "they do"} not qualify. A rerun may place ${misses.length === 1 ? "it" : "them"} either side of the bar.</p>
        ${misses.map((item) => html`<div class="row"><span>${model(item.model)}<span class="sub">${endpointName(item.endpoint)} · ${item.passes}/${item.total} passed · ${data.connection ? `${perRun(item.costPerCallUsd)} per test run` : `${per1k(item.costPerCallUsd)} per 1,000 calls`}${item.cheaperThanCurrent === true ? " · cheaper than now" : item.cheaperThanCurrent === false ? " · not cheaper than now" : ""}</span></span></div>`)}
      </div>
    </section>` : ""}

    ${data.connection ? html`<section aria-labelledby="checks">
      <h2 id="checks">Checks</h2>
      <div class="card">
        <p class="note">A judge wrote these from ${data.connection.taskTitle}'s instructions and graded every test run on them. Test mode captured each run's Slack posts and other outside actions instead of sending them.</p>
        ${data.connection.checks.map((check) => html`<div class="row"><span><code>${check.id}</code> ${check.check}</span></div>`)}
      </div>
    </section>` : ""}

    ${data.basedOn?.length ? html`<section aria-labelledby="based-on">
      <h2 id="based-on">Based On</h2>
      <div class="card">${data.basedOn.map((line) => html`<p class="note">${prose(line)}</p>`)}</div>
    </section>` : ""}

    ${data.agentEval ? html`<section aria-labelledby="agent-eval">
      <h2 id="agent-eval">Agent Eval</h2>
      <div class="card">${data.agentEval.status === "missing"
        ? html`<p>${data.agentEval.warning ?? "The agent has no eval, so the switch was not checked against it."}</p>`
        : html`<p>${data.agentEval.passed ? "Passed" : "Failed"}${data.agentEval.baseline ? `: with its current models the agent passed ${data.agentEval.baseline.passes}/${data.agentEval.baseline.total}` : ""}.</p>${data.agentEval.tried.map((item) => html`<p class="sub">${modelName(item.model)}: ${item.passes}/${item.total} · ${item.passed ? "passed" : "failed"}</p>`)}`}</div>
    </section>` : ""}

    ${from.length || data.guardrails.rejected.length ? html`<section aria-labelledby="rules">
      <h2 id="rules">Guardrails</h2>
      <div class="card">
        ${from.map(([key, level]) => html`<div class="row"><span><span class="pill tag">${level}</span> <code>${key}</code></span><span>${show(key, (data.guardrails.effective as Record<string, unknown>)[key])}</span></div>`)}
        ${data.guardrails.rejected.map((item) => html`<p class="note">Not applied: <code>${item.key}</code> at the ${item.level} level, which ${item.reason}.</p>`)}
      </div>
    </section>` : ""}

    ${shown.length ? html`<section aria-labelledby="notes">
      <h2 id="notes">Notes</h2>
      <div class="card">${shown.map((notice) => {
        const index = (data.fixes ?? []).findIndex((fix) => fix.notice === notice);
        return html`<div class="row note-row"><span>${prose(notice)}</span>${index >= 0 ? fixButton(data.fixes![index]!, index) : ""}</div>`;
      })}</div>
    </section>` : ""}`;
}

export const runView: View<Data> = {
  async load({ api, id }) {
    // The endpoints name each endpoint ID's provider; the report still shows without them.
    const [data, endpoints] = await Promise.all([api.get<Data>(`/api/runs/${encodeURIComponent(id ?? "")}`), api.get<Endpoint[]>("/api/endpoints").catch((): Endpoint[] => [])]);
    setEndpoints(endpoints);
    return data;
  },
  title,
  render: (data, { me }) => (isLive(data) ? live(data) : report(data, me.role === "admin")),
  actions: {
    // Approve change records who approved and when; it changes nothing in the connected app.
    async approve(_target, data, { api, refresh, toast, confirm }) {
      if (isLive(data) || !data.connection?.change) return;
      if (!await confirm({ title: "Approve this change?", body: `${data.connection.change.text}. OpenMerit records that you approved it, and when. It does not change the task: you make the change in Viktor.`, confirm: "Approve change" })) return;
      await api.send<Approval>("POST", `/api/runs/${encodeURIComponent(data.jobId)}/approve`);
      await refresh();
      toast("Approved. Make the change in Viktor's scheduled tasks.");
    },
    // Run again, or raise the task's budget per job and run again: both spend, so both confirm first.
    async rerun(_target, data, ctx) {
      await rerun(data, null, ctx);
    },
    async fix(target, data, ctx) {
      const fix = isLive(data) ? undefined : data.fixes?.[Number(target.dataset.fix)];
      if (!fix) return;
      if (fix.kind === "ask_agent") {
        await navigator.clipboard.writeText(fix.prompt);
        return ctx.toast("Copied. Paste it into your coding agent.");
      }
      if (fix.kind === "raise_budget" || fix.kind === "rerun") await rerun(data, fix.kind === "raise_budget" ? fix.budgetUsd : null, ctx);
    },
  },
};

async function rerun(data: Data, budgetUsd: number | null, ctx: Ctx): Promise<void> {
  const now = isLive(data) ? undefined : data.guardrails.effective.budgetUsd;
  const ok = await ctx.confirm(budgetUsd === null
    ? { title: "Run again", body: `Runs ${data.task} again on the bundle its coding agent last sent. It counts as one evaluation on your plan.`, confirm: "Run again" }
    : { title: "Raise the budget and run again", body: `Sets ${data.task}'s budget per job to ${usd(budgetUsd)}${now === undefined ? "" : `, up from ${usd(now)}`}, then runs it again. The run spends up to ${usd(budgetUsd)} on model calls and counts as one evaluation on your plan.`, confirm: "Raise and run again" });
  if (!ok) return;
  const started = await ctx.api.send<{ jobId: string }>("POST", `/api/runs/${encodeURIComponent(data.jobId)}/rerun`, budgetUsd === null ? {} : { budgetUsd });
  ctx.go(`/r/${started.jobId}/`);
}
