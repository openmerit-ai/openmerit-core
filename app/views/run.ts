import { ApiError, type Endpoint, type Fix, type JobView, type MeasuredModel, type Report } from "../api.ts";
import { liveText } from "../live.ts";
import { date, endpointName, html, setEndpoints, model, modelName, per1k, plural, seconds, usd, type Html } from "../html.ts";
import type { Ctx, View } from "../view.ts";
import { show } from "./guardrails.ts";
import { retried } from "./connections.ts";
import { decisionText } from "./tasks.ts";

// GET /api/runs/:id returns the saved report once the job has one, and the job's live state before.
type Data = Report | JobView;
const isLive = (data: Data): data is JobView => "report" in data && data.report === null;

const verdicts: Record<Report["status"], string> = {
  picked: "",
  keep_current: "No cheaper model passed as many cases, so the model in use now stays.",
  baseline_failed: "The model in use now could not be measured, or passed too few cases to compare against. The notes say which.",
  below_floor: "The model in use now passed under 80% of its own eval, so the eval cannot tell models apart and no model is recommended. Its failed cases below say why.",
  no_cases: "No case had a known correct answer, so nothing was measured.",
  no_candidates: "No allowed model is cheaper than the one in use now.",
  agent_eval_failed: "Every cheaper switch failed the agent's eval, so none is proposed.",
  not_accepted: "After the last round of grading, the eval still disagreed with your grades, so no model is recommended. Run the task again to start over.",
  stopped: "The run stopped at its budget before the finalists were measured, so it proposes no switch. These are the measurements so far.",
  failed: "The run failed before it finished, so it proposes no switch. These are the measurements so far.",
};

/**
 * A run whose current model never ran, such as when a model key stopped working: it failed, so it is no
 * verdict on the model. A current model that ran and passed too few cases is measured, and stays "no switch".
 */
const notRun = (data: Report): boolean => data.status === "baseline_failed" && !data.baseline;

function title(data: Data): string {
  if (!isLive(data) && notRun(data)) return `${data.task}: the run did not finish`;
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

// The grading loop: each sampled answer with OpenMerit's grade, and Looks good or Doesn't look right with an optional
// note. The run writes the eval again where a person disagrees with it, and accepts it once they agree on every answer.
function grading(job: JobView): Html {
  return html`<form class="grade-form" data-action="grade">
    <p>Does each answer look right? OpenMerit graded them with the eval it wrote. Where you disagree, it writes the eval again from your grades and measures again; once you agree on every answer, you have accepted the eval.</p>
    ${job.questions.map((question, index) => {
      const lines = (question.detail ?? "").split("\n"), grade = [...lines].reverse().find((line) => line.startsWith("OpenMerit's grade: ")) ?? "";
      const passed = grade === "OpenMerit's grade: passed";
      return html`<fieldset class="card grade" aria-labelledby="grade-${String(index)}">
        <legend id="grade-${String(index)}">${question.prompt}</legend>
        <span class="sub">${lines[0] ?? ""}</span>
        <pre class="grade-detail">${lines.slice(1).filter((line) => line !== grade).join("\n")}</pre>
        <p><span class="pill ${passed ? "good" : "bad"}">${passed ? "OpenMerit: passed" : "OpenMerit: failed"}</span>${passed ? "" : html` <span class="sub">${grade.replace(/^OpenMerit's grade: failed:? ?/, "")}</span>`}</p>
        <div class="grade-choice" role="radiogroup" aria-label="Your grade">
          <label><input type="radio" name="${question.id}" value="good" required> Looks good</label>
          <label><input type="radio" name="${question.id}" value="bad"> Doesn't look right</label>
        </div>
        <label class="grade-note"><span class="sub">Note (optional): why, in your words</span><textarea name="${question.id}.note" rows="2"></textarea></label>
      </fieldset>`;
    })}
    <p class="form-error" role="alert" hidden></p>
    <p><button class="btn primary" type="submit">Send ${plural(job.questions.length, "grade")}</button></p>
  </form>`;
}

const again = () => html`<p style="margin-top: 10px"><button class="btn" type="button" data-action="rerun">Run again</button></p>`;

function live(job: JobView): Html {
  const progress = job.progress.planned ? `${job.progress.measured} of about ${job.progress.planned} measurements done` : `${plural(job.progress.measured, "measurement")} done`;
  const body = {
    queued: html`<span class="pill">Queued</span><p class="note">The run starts in a moment.</p>`,
    running: job.live ? measuring(job) : html`<span class="pill live">Evaluating</span><span class="sub">${job.phase.replace("_", " ")} · ${progress}</span><p class="note">Your coding agent gets the result on its next OpenMerit call, and this page shows the report.</p>`,
    needs_input: job.phase === "grading"
      ? html`<span class="pill warn">Grade its answers</span><p class="note">Grade them here or in your coding agent, which shows you the same ${plural(job.questions.length, "answer")}. The run continues once every answer has a grade.</p>`
      : html`<span class="pill warn">Needs input</span><p class="note">OpenMerit asked ${plural(job.questions.length, "question")} in your coding agent, such as a check of the test labels. The run continues once it answers.</p>`,
    failed: html`<p>${job.error ?? "The run stopped before it could recommend a model."}</p>${again()}`,
    stopped: html`<p>The run was stopped${job.error ? `: ${job.error}` : "."}</p>${again()}`,
    done: html`<p>The run finished; its report is being saved. Reload in a moment.</p>`,
  }[job.status];
  return html`<div class="eyebrow" data-live="${job.jobId}" data-status="${job.status}"><a href="/">Runs</a><span>›</span><span>${job.jobId}</span><span>Started ${date(job.createdAt)}</span></div>
    <h1 class="title">${title(job)}</h1>
    <div class="card${job.status === "failed" ? " notice bad" : ""}" style="margin-top: 20px"${job.status === "failed" ? html` role="alert"` : ""}>${body}${job.notices.filter((notice) => notice !== job.error).map((notice) => html`<p class="note">${notice}</p>`)}</div>
    ${job.status === "needs_input" && job.phase === "grading" && job.questions.length ? html`<section aria-labelledby="grades"><h2 id="grades">Grade the Answers</h2>${grading(job)}</section>` : ""}
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
        ${pick.savingPerCallUsd && pick.savingPerCallUsd > 0 ? html`<p class="note">It saves about ${per1k(pick.savingPerCallUsd)} per 1,000 calls.</p>` : ""}
        ${report.grading?.bar === "criteria" && report.grading.summary ? html`<p class="note">${report.grading.summary}</p>` : ""}
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
        ${report.decision ? html`<p style="margin-top: 10px"><span class="pill ${report.decision.decision === "approved" ? "good" : "tag"}">${report.decision.decision === "approved" ? "Approved" : "Declined"}</span> <span class="sub">${decisionText(report.decision)}</span></p>`
          : edits.length ? html`<p class="note">Your coding agent received this change with the result, asks you before applying it, and sends your answer back here.</p>` : html`<p class="note">Your coding agent received this change with the result.</p>`}
      </div>`;
}

// The failed run's card: why the current model could not run, and the button that starts the task again.
function failedRun(data: Report, admin: boolean): Html {
  const why = (data.fixes ?? []).find((fix) => fix.kind === "rerun")?.notice ?? notes(data.notices).at(-1) ?? verdicts.baseline_failed;
  const button = admin ? html`<p style="margin-top: 10px"><button class="btn" type="button" data-action="rerun">Run again</button></p>` : "";
  return html`<div class="card notice bad" role="alert" style="margin-top: 20px"><p>The run did not finish: ${prose(why)}</p><p class="note">Nothing was compared, so this is no verdict on the model in use now.</p>${button}</div>`;
}

function report(data: Report, admin: boolean): Html {
  if (notRun(data)) {
    const shown = notes(data.notices).filter((notice) => !(data.fixes ?? []).some((fix) => fix.kind === "rerun" && fix.notice === notice));
    return html`<div class="eyebrow"><a href="/">Runs</a><span>›</span><span>${data.jobId}</span><span>Started ${date(data.createdAt)}</span></div>
    <h1 class="title">${title(data)}</h1>
    ${failedRun(data, admin)}
    ${shown.length ? html`<section aria-labelledby="notes"><h2 id="notes">Notes</h2><div class="card">${shown.map((notice) => html`<div class="row note-row"><span>${prose(notice)}</span></div>`)}</div></section>` : ""}`;
  }
  const models = [data.baseline, ...data.candidates].filter((item): item is MeasuredModel => item !== null);
  const pick = data.pick?.model ?? null;
  const from = Object.entries(data.guardrails.from);
  const misses = data.nearMisses ?? [];
  const shown = notes(data.notices);
  const near = (item: MeasuredModel) => item.role === "candidate" && misses.some((miss) => miss.model === item.model && miss.endpoint === item.endpoint);
  return html`<div class="eyebrow"><a href="/">Runs</a><span>›</span><span>${data.jobId}</span><span>Measured ${date(data.createdAt)}</span></div>
    <h1 class="title">${title(data)}</h1>
    <div class="pick">${pickCard(data)}${change(data)}</div>

    ${models.length ? html`<section aria-labelledby="compare">
      <h2 id="compare">Models Compared</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Model</th><th class="num">Passed</th><th class="num">Per 1,000 calls</th><th class="num">Latency</th><th>Result</th></tr></thead>
          <tbody>
            ${models.map((item) => html`<tr class="${item.role === "baseline" ? "current" : item.model === pick ? "picked" : ""}">
              <td>${model(item.model)}<span class="sub">${endpointName(item.endpoint)}${item.funding === "customer" ? " · your key" : ""}${item.inCatalogue ? "" : " · placed by measurement only"}${item.note ? ` · ${item.note}` : ""}</span></td>
              <td class="num">${item.status === "unavailable" ? "–" : `${item.passes}/${item.total}`}</td>
              <td class="num">${per1k(item.costPerCallUsd)}${item.costIsEstimate && item.costPerCallUsd !== null ? html`<span class="sub">estimate</span>` : ""}</td>
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
        ${misses.map((item) => html`<div class="row"><span>${model(item.model)}<span class="sub">${endpointName(item.endpoint)} · ${item.passes}/${item.total} passed · ${per1k(item.costPerCallUsd)} per 1,000 calls${item.cheaperThanCurrent === true ? " · cheaper than now" : item.cheaperThanCurrent === false ? " · not cheaper than now" : ""}</span></span></div>`)}
      </div>
    </section>` : ""}

    ${data.failedCases?.length && data.baseline ? html`<section aria-labelledby="failed-cases">
      <h2 id="failed-cases">Cases ${modelName(data.baseline.model)} Failed</h2>
      <div class="card">
        ${(data.baselineByKind?.length ?? 0) > 1 ? html`<p class="note">Passed by kind of case: ${data.baselineByKind!.map((rate) => `${rate.kind} ${rate.passes}/${rate.total}`).join(", ")}.</p>` : ""}
        ${data.failedCases.map((item) => html`<div class="row"><span>${item.caseId}<span class="sub">${item.kind} · ${item.reason}</span></span></div>`)}
      </div>
    </section>` : ""}

    ${data.grading ? html`<section aria-labelledby="grading">
      <h2 id="grading">Your Grades</h2>
      <div class="card"><p>${data.grading.accepted ? `You accepted the eval${data.grading.rounds ? ` after ${plural(data.grading.rounds, "round")} of grading` : ""}.` : "You did not accept the eval."}${data.grading.bar === "criteria" ? " Since you marked answers of the model in use now wrong, every model was measured against the eval's checks, and the cheapest that meets them is recommended, even when it costs more." : ""}</p>
        ${data.grading.bar === "criteria" && data.grading.summary && !data.pick ? html`<p class="note">${data.grading.summary}</p>` : ""}</div>
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
    // The endpoints name each endpoint ID's provider; the report still shows without them. A run is
    // asked for again while the cloud app wakes after a deploy, as Connections does.
    const [data, endpoints] = await Promise.all([retried(() => api.get<Data>(`/api/runs/${encodeURIComponent(id ?? "")}`)), api.get<Endpoint[]>("/api/endpoints").catch((): Endpoint[] => [])]);
    setEndpoints(endpoints);
    return data;
  },
  title,
  render: (data, { me }) => (isLive(data) ? live(data) : report(data, me.role === "admin")),
  actions: {
    // The grades: good or bad per answer, with the note after a colon, as the coding agent sends them.
    async grade(form, data, ctx) {
      if (!(form instanceof HTMLFormElement) || !isLive(data)) return;
      const values = new FormData(form), error = form.querySelector<HTMLElement>(".form-error");
      const answers = Object.fromEntries(data.questions.flatMap((question) => {
        const verdict = values.get(question.id), note = String(values.get(`${question.id}.note`) ?? "").trim();
        return verdict ? [[question.id, note ? `${String(verdict)}: ${note}` : String(verdict)]] : [];
      }));
      try {
        await ctx.api.send("POST", `/api/runs/${encodeURIComponent(data.jobId)}/answers`, { answers });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status >= 500 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      ctx.toast("Grades sent.");
      await ctx.refresh();
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
