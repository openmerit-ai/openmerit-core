import type { Endpoint, JobView, Run, Task } from "../api.ts";
import { liveText } from "../live.ts";
import { ago, date, endpointName, harness, html, logo, setEndpoints, model, per1k, plural, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

// A result in the words the pages use: a task's latest one, or any finished run's.
function describe(found: { status: string; pick: string | null; current: string; saving: string }, link: (text: Html | string) => Html): Html {
  switch (found.status) {
    case "new": return html`<span class="sub">Not measured yet</span>`;
    case "running": return html`<span class="pill live">Evaluating</span>`;
    case "picked": return found.pick
      ? html`${link(html`Switch to ${model(found.pick)}`)}<span class="sub">from ${model(found.current)}${found.saving ? ` · ${found.saving}` : ""}</span>`
      : link("Cheaper model found");
    case "keep_current": return html`${link(html`Keep ${model(found.current)}`)}<span class="sub">no cheaper model passed as many cases</span>`;
    case "agent_eval_failed": return html`${link("Keep the current models")}<span class="sub">every cheaper switch failed the agent's eval</span>`;
    case "no_candidates": return html`${link("Keep the current model")}<span class="sub">no allowed model is cheaper</span>`;
    case "no_cases": return html`<span class="pill warn">No usable cases</span><span class="sub">${link("no case had a known answer")}</span>`;
    case "baseline_failed": return html`<span class="pill warn">Current model not measured</span><span class="sub">${link("nothing to compare against")}</span>`;
    case "stopped": return html`<span class="pill">Stopped</span><span class="sub">${link("View run")}</span>`;
    default: return html`<span class="pill bad">Did not finish</span><span class="sub">${link("View run")}</span>`;
  }
}

// A task's latest result. The cloud app records the job's result status on the task, or the
// job's own status when it ended without one.
export const result = (task: Task, link: (text: Html | string) => Html = (text) => html`${text}`): Html =>
  describe({ status: task.status, pick: task.pick, current: task.currentModel, saving: task.monthlySavingUsd ? `saves about ${usd(task.monthlySavingUsd)} a month` : "" }, link);

const jobStatus: Record<string, Html> = {
  queued: html`<span class="pill">Queued</span>`,
  running: html`<span class="pill live">Evaluating</span>`,
  needs_input: html`<span class="pill warn">Needs input</span><span class="sub">in your coding agent</span>`,
  failed: html`<span class="pill bad">Did not finish</span>`,
  stopped: html`<span class="pill">Stopped</span>`,
};

// Each finished run says what its report found. The task's latest run also shows the monthly
// saving, which the task estimates from its traffic; older runs show the saving per 1,000 calls.
function outcome(run: Run, task: Task | undefined): Html {
  if (run.status !== "done") return jobStatus[run.status] ?? html`${run.status}`;
  if (task && task.lastJobId === run.id) return result(task);
  const found = run.result;
  if (!found) return html`<span class="sub">Done</span>`;
  const saving = found.savingPerCallUsd ? `saves ${per1k(found.savingPerCallUsd)} per 1,000 calls` : "";
  return describe({ status: found.status, pick: found.model, current: found.from ?? task?.currentModel ?? "", saving }, (text) => html`${text}`);
}

// A connected app's runs, by the job's kind.
const CONNECTIONS: Record<string, string> = { viktor: "Viktor", langfuse: "Langfuse" };

// Who started the run: the coding agent that asked, by the name its MCP client sent, a watch, or a connection, on its own or from the app.
function askedBy(run: Run): Html {
  const app = CONNECTIONS[run.kind];
  if (app) return run.startedBy ? html`Started from the app by ${run.startedByName ?? run.startedBy}` : html`${app} connection (automatic)`;
  if (run.kind === "watch") return html`${logo("openmerit")}OpenMerit<span class="sub">watching this task</span>`;
  if (!run.askedBy) return html`Coding agent`;
  const found = harness(run.askedBy);
  return html`${logo(found.logo)}${found.name}${found.custom ? html`<span class="sub">custom harness</span>` : ""}`;
}

const ACTIVE = new Set(["queued", "running", "needs_input"]);
const when = (iso: string): Html => html`<span title="${date(iso)}">${ago(iso)}</span>`;

// Runs still measuring. Each row polls its run (app/live.ts): Torph morphs the cases, pass rate
// and status, and Liveline draws the pass rate so far against the model in use today. A run the
// cloud reports no live data for shows its measurements and the provisional pick instead.
// Rows go by what they need: runs waiting for input first, oldest first; then runs evaluating,
// least time left first; then the queue in the order it runs, oldest first.
const RANK: Record<string, number> = { needs_input: 0, running: 1, queued: 2 };
function remaining(job: JobView): number {
  if (job.live?.minutesLeft != null) return job.live.minutesLeft;
  const planned = job.progress.planned;
  return planned ? (planned - job.progress.measured) / planned * 1e6 : Infinity;
}
function ordered(jobs: JobView[], startOf: (job: JobView) => string): JobView[] {
  return jobs.slice().sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3)
    || (a.status === "running" ? remaining(a) - remaining(b) : 0)
    || startOf(a).localeCompare(startOf(b)));
}
const agentName = (run: Run | undefined): string | undefined => (run?.askedBy ? harness(run.askedBy).name : run?.kind === "watch" ? "OpenMerit" : undefined);

function inProgress(all: JobView[], runs: Run[], byId: Map<string, Task>): Html {
  if (!all.length) return html``;
  const runOf = new Map(runs.map((run) => [run.id, run]));
  const jobs = ordered(all, (job) => runOf.get(job.jobId)?.startedAt ?? job.createdAt);
  return html`<section aria-labelledby="progress">
      <h2 id="progress">In Progress <span class="count">${jobs.length}</span></h2>
      <div class="tablewrap">
        <table class="running">
          <thead><tr><th>Task</th><th>Testing</th><th class="num">Cases</th><th class="num">Passed</th><th>So far</th><th class="num">Status</th></tr></thead>
          <tbody>
            ${jobs.map((job) => {
              const run = runOf.get(job.jobId);
              const task = byId.get(job.taskId);
              const agent = agentName(run);
              const text = liveText(job, agent), id = job.jobId, live = job.live;
              const testing = live?.model ?? job.provisional?.model;
              return html`<tr data-live="${id}" data-status="${job.status}"${agent ? html` data-agent="${agent}"` : ""}>
              <td><a href="/r/${id}/">${job.task}</a><span class="sub">${task?.environment ?? ""}${run ? html` · ${when(run.startedAt)}` : ""}</span></td>
              <td>${testing ? model(testing) : html`<span class="sub">–</span>`}${live?.baseline ? html`<span class="sub">vs ${model(live.baseline.model)} · ${Math.round(live.baseline.rate)}%</span>` : job.provisional ? html`<span class="sub">on ${endpointName(job.provisional.endpoint)}</span>` : ""}</td>
              <td class="num"><span data-live="${id}" data-morph="cases">${text.cases}</span></td>
              <td class="num"><span data-live="${id}" data-morph="rate">${text.rate}</span></td>
              <td>${live ? html`<div class="live-spark" data-live="${id}" role="img" aria-label="Pass rate so far"></div>` : job.progress.planned ? html`<div class="meter" data-live="${id}" aria-hidden="true"><i style="width: ${Math.round((job.progress.measured / job.progress.planned) * 100)}%"></i></div>` : ""}</td>
              <td class="num"><span class="pill${job.status === "needs_input" ? " warn" : job.status === "running" ? " live" : ""}" data-live="${id}" data-morph="status">${text.status}</span></td>
            </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </section>`;
}

export const runsView: View<{ runs: Run[]; tasks: Task[]; jobs: JobView[] }> = {
  async load({ api }) {
    const [runs, tasks] = await Promise.all([api.get<Run[]>("/api/runs"), api.get<Task[]>("/api/tasks")]);
    // A run still measuring returns its live state; a few at a time is the norm.
    const active = runs.filter((run) => ACTIVE.has(run.status));
    const [jobs, endpoints] = await Promise.all([
      Promise.all(active.map((run) => api.get<JobView>(`/api/runs/${encodeURIComponent(run.id)}`).catch(() => null))),
      active.length ? api.get<Endpoint[]>("/api/endpoints").catch((): Endpoint[] => []) : Promise.resolve([]),
    ]);
    setEndpoints(endpoints);
    return { runs, tasks, jobs: jobs.filter((job): job is JobView => job !== null && "report" in job && job.report === null) };
  },
  render({ runs, tasks, jobs }, { me }) {
    const top = header(me, "Runs", "Each time a coding agent asks which model to use, OpenMerit runs the task's tests on the candidates and the answer lands here with its evidence. Link a run in a pull request so reviewers can see why.", [plural(tasks.length, "task")]);
    if (!runs.length) return html`${top}<section aria-labelledby="all"><h2 id="all">All Runs</h2>${empty("No runs yet", "Add OpenMerit to a coding agent, then ask it which model a task should use. The run and its evidence appear here.")}</section>`;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return html`${top}
    ${inProgress(jobs, runs, byId)}
    <section aria-labelledby="all">
      <h2 id="all">All Runs <span class="count">${runs.length.toLocaleString("en-US")}</span></h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Task</th><th>Outcome</th><th>Asked by</th><th class="num">Last run</th></tr></thead>
          <tbody>
            ${runs.map((run) => {
              const task = byId.get(run.taskId);
              return html`<tr><td><a href="/r/${run.id}/">${task?.name ?? run.title ?? run.result?.task ?? run.taskId}</a><span class="sub">${task?.environment ?? ""}</span></td><td>${outcome(run, task)}</td><td>${askedBy(run)}</td><td class="num">${when(run.startedAt)}</td></tr>`;
            })}
          </tbody>
        </table>
      </div>
      <p class="note">Agents read each report as Markdown at <code>https://openmerit.ai/api/r/&lt;run&gt;.md</code>.</p>
    </section>`;
  },
};
