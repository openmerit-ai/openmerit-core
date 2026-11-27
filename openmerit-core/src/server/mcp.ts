// MCP over streamable HTTP at /mcp, stateless per request: every call carries its Clerk access
// token, and all state lives in the actors, so any node can answer. Responses are plain JSON, which
// the streamable HTTP transport allows when a server sends no notifications.
import { randomBytes } from "node:crypto";
import { capture } from "./analytics.ts";
import { NO_ORGANIZATION, type Auth, type AuthResult, type Identity } from "./auth.ts";
import { confirmUrl, type Config } from "./config.ts";
import type { Answers, JobView } from "./actors/job.ts";
import { explain, nearMissLine, paybackLine, reasonFor, type Fix, type JobResult } from "../job/report.ts";
import type { AppClient } from "./registry.ts";
import type { TaskBundle } from "../ranking/index.ts";
import { bundleProblem, DEFAULT_ENVIRONMENT, redactBundle, rerunJob, runTask, startJob, taskIdFor } from "./start.ts";
import type { Decision, Project } from "./actors/account.ts";
import { evalCommandSpec, heldReply, HOSTED_EVAL_COMMAND } from "./api.ts";
import { estimateLine } from "../job/workflow.ts";
import { TOOLS } from "./tools.ts";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));

type Json = Record<string, unknown>;
interface ToolResult { text: string; data: Json; isError?: boolean }

export interface McpDeps { client: AppClient; auth: Auth | null; config: Config }

const rpc = (id: unknown, body: Json) => ({ jsonrpc: "2.0", id: id ?? null, ...body });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const resourceMetadataUrl = (config: Config) => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

/** Why the job's state stands where it does, for the coding agent. */
export function describeJob(view: JobView, decision: Decision | null = null): string {
  const lines = [`Job ${view.jobId} for ${view.task}: ${view.status} (${view.phase}).`];
  if (view.questions.length) {
    lines.push(view.phase === "grading"
      ? `It needs a person to grade its answers: show the user each answer below with its detail, ask whether it looks right, and send their verdicts with openmerit_answer, job_id "${view.jobId}", answers keyed by question id: good or bad, with their note after a colon ("bad: <why>"). Never grade for them. They can also grade on the run's page at app.openmerit.ai.`
      : `It needs the user. Ask them, then call openmerit_answer with job_id "${view.jobId}" and answers keyed by question id:`);
    for (const question of view.questions) lines.push(`- [${question.id}] (${question.kind}) ${question.prompt}${question.options ? `\n  Options: ${question.options.map(option => option.value).join(" | ")}` : ""}${question.detail ? `\n  ${question.detail.split("\n").join("\n  ")}` : ""}${question.hint ? `\n  ${question.hint}` : ""}`);
  }
  const result = view.result;
  if (result?.pick) {
    lines.push(`Measured pick: ${result.pick.model} on ${result.pick.endpoint}, ${result.pick.passes}/${result.pick.total} cases passed${result.baseline ? ` (current model ${result.baseline.passes}/${result.baseline.total})` : ""}.`);
    const payback = paybackLine(result);
    if (payback) lines.push(payback);
    if (result.edit.edits.length) lines.push("Edits:", ...result.edit.edits.map(edit => `- ${edit.file}:${edit.line}: ${edit.before} → ${edit.after}`));
    if (result.edit.instructions) lines.push(result.edit.instructions);
    if (decision) lines.push(decisionLine(decision));
    else lines.push(`Ask the user before applying the edit${result.approval ? `: "${result.approval.prompt}" (${result.approval.detail})` : ""}. Apply it if they say yes, then send their answer with openmerit_answer, job_id "${view.jobId}" and answers {"${result.approval?.id ?? "configure"}": true}, or false if they decline.`);
  } else if (result) lines.push(`No switch proposed (${result.status}). ${reasonFor(result, result.baseline?.model ?? "the current model")}`);
  if (result?.baseline) lines.push(`Current model ${result.baseline.model}: ${result.baseline.passes}/${result.baseline.total} cases passed, ${perCall(result.baseline.costPerCallUsd)} per call, ${result.baseline.latencyMs === null ? "latency unknown" : `${result.baseline.latencyMs} ms`}.`);
  if (result?.failedCases?.length) lines.push(`Cases it failed, with the grader's reason${(result.baselineByKind?.length ?? 0) > 1 ? ` (passed by kind: ${result.baselineByKind!.map(rate => `${rate.kind} ${rate.passes}/${rate.total}`).join(", ")})` : ""}:`, ...result.failedCases.map(item => `- ${item.caseId} (${item.kind}): ${item.reason}`));
  const misses = result && nearMissLine(result);
  if (misses) lines.push(misses);
  if (result?.basedOn?.length) lines.push(`Based on: ${result.basedOn.join(" ")}`);
  if (result) lines.push(`Report: ${result.reportUrl}`);
  else if (view.status === "running" || view.status === "queued") lines.push(`Provisional pick while it runs: ${view.provisional!.model}. ${view.provisional!.reason} Measured ${view.progress.measured}${view.progress.planned ? ` of about ${view.progress.planned}` : ""} candidate runs so far (updated ${view.updatedAt}); call openmerit_result again later.`);
  // A result's notices include the job's and those of its last stages, such as challengers left out.
  // A failed job's error is its own line; jobs that ended before that also kept it as a notice.
  const notices = (result?.notices ?? view.notices).filter(notice => notice !== view.error);
  for (const notice of notices) {
    lines.push(`Note: ${notice}`);
    const fix = result?.fixes?.find(item => item.notice === notice);
    if (fix) lines.push(`Fix: ${fixLine(fix, view.jobId, new URL(result!.reportUrl).origin)}`);
  }
  if (view.status === "failed" && !result) lines.push(`Fix: ask the user, then call openmerit_recommend with job_id "${view.jobId}" to run the task again.`);
  if (view.error) lines.push(`Error: ${view.error}`);
  return lines.join("\n");
}

/** The user's recorded decision on a result's change, in one line. */
export function decisionLine(decision: Decision): string {
  const who = decision.name ?? decision.by, on = decision.at.slice(0, 10);
  return decision.decision === "approved" ? `Decision: ${decision.change}, approved by ${who} on ${on}.` : `Decision: ${decision.change}, declined by ${who} on ${on}.`;
}

/** What the coding agent does about a notice. */
function fixLine(fix: Fix, jobId: string, appOrigin: string): string {
  switch (fix.kind) {
    case "raise_budget": return `ask the user to raise this task's budget per job to $${fix.budgetUsd}, then call openmerit_recommend with job_id "${jobId}" and budget_usd ${fix.budgetUsd}.`;
    case "rerun": return `ask the user, then call openmerit_recommend with job_id "${jobId}" to run the task again.`;
    case "open": return `the user can do this at ${appOrigin}${fix.path} (${fix.label}).`;
    case "ask_agent": return fix.prompt;
  }
}

const jobData = (view: JobView, decision: Decision | null = null): Json => ({
  job_id: view.jobId, task: view.task, status: view.status, phase: view.phase, questions: view.questions, notices: view.notices, progress: view.progress,
  provisional: view.provisional, ...(view.error ? { error: view.error } : {}),
  ...(view.result ? { result: { ...resultData(view.result), decision } } : {}),
});

/** The result for the agent: the verdict and why, the current model's figures, and whether each top model is cheaper than it. */
function resultData(result: JobResult): Json {
  const baseline = result.baseline;
  const { reason, top, nearMisses } = explain(result);
  return {
    status: result.status, reason, pick: result.pick,
    baseline: baseline ? { model: baseline.model, endpoint: baseline.endpoint, passes: baseline.passes, total: baseline.total, costPerCallUsd: baseline.costPerCallUsd, latencyMs: baseline.latencyMs } : null,
    top,
    nearMisses: nearMisses.map(item => ({ model: item.model, endpoint: item.endpoint, passes: item.passes, total: item.total, costPerCallUsd: item.costPerCallUsd, cheaperThanCurrent: item.cheaperThanCurrent })),
    reportUrl: result.reportUrl, edit: result.edit, spend: result.spend, fixes: result.fixes ?? [], basedOn: result.basedOn ?? [], approval: result.approval ?? null,
  };
}
const perCall = (value: number | null) => (value === null ? "unknown cost" : `$${value.toFixed(5)}`);

// The server keeps no sessions, so the session ID it returns on initialize carries the client's
// name (clientInfo.name, such as claude-code or codex). Clients send it back on every request,
// which lets a run record which coding agent asked. It labels runs only and grants nothing.
const SESSION_PREFIX = "oms1.";
export function sessionFor(clientInfo: unknown): string {
  const name = clientInfo && typeof clientInfo === "object" && typeof (clientInfo as { name?: unknown }).name === "string" ? (clientInfo as { name: string }).name.trim().slice(0, 64) : "";
  return `${SESSION_PREFIX}${Buffer.from(name).toString("base64url")}.${randomBytes(12).toString("hex")}`;
}
export function clientOf(session: string | null): string | null {
  if (!session?.startsWith(SESSION_PREFIX)) return null;
  const name = Buffer.from(session.slice(SESSION_PREFIX.length).split(".")[0] ?? "", "base64url").toString("utf8").trim();
  return name && name.length <= 64 && !/[\u0000-\u001f]/.test(name) ? name : null;
}

/**
 * The project a new task goes in: the one the call names (its ID or name, ignoring case), else the project whose
 * tasks already use the environment, else the default project.
 */
async function projectFor(account: { projects(): Promise<Project[]>; projectForEnvironment(environment: string): Promise<string> }, environment: string, named: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (named === undefined || named === null) return { ok: true, id: await account.projectForEnvironment(environment) };
  if (typeof named !== "string" || !named.trim()) return { ok: false, error: "project must be a project's name or ID." };
  const projects = await account.projects(), wanted = named.trim().toLowerCase();
  const found = projects.find(item => item.id === named.trim() || item.name.toLowerCase() === wanted);
  return found ? { ok: true, id: found.id } : { ok: false, error: `No project ${named} in this account. Its projects: ${projects.map(item => item.name).join(", ")}.` };
}

async function callTool(deps: McpDeps, identity: Identity, name: string, args: Json, askedBy: string | null): Promise<ToolResult> {
  const { client } = deps;
  const account = client.account.getOrCreate([identity.accountId]);
  // Clerk's OAuth access tokens carry org_id but no role or slug, so the member's recorded role and the account's name stay as the web app last saw them. No MCP tool depends on the role.
  await account.touch({ userId: identity.userId, role: null, name: null });
  const jobView = async (jobId: unknown): Promise<JobView | ToolResult> => {
    const row = typeof jobId === "string" ? await account.job(jobId) : null;
    if (!row) return { text: `No job ${String(jobId)} in this account.`, data: {}, isError: true };
    return client.job.get([row.id]).status();
  };
  /** Holds a critical request for the user to confirm; it runs, as the /api request it names, once they do. */
  const hold = async (input: { projectId: string; method: string; path: string; body: Json; checks: "person" | "reverify"; title: string; items: string[] }): Promise<ToolResult> => {
    const view = await account.requestConfirmation({ ...input, body: JSON.stringify(input.body), requestedBy: identity.userId, requestedVia: askedBy });
    const reply = heldReply(deps.config, view);
    return { text: `${reply.text} Then call openmerit_confirmation with confirmation_id "${view.id}" for the outcome.`, data: { status: reply.status, confirmation: reply.confirmation } };
  };
  if (name === "openmerit_recommend") {
    const unknown = Object.keys(args).filter(key => !["bundle", "environment", "agent", "project", "job_id", "task_id", "budget_usd", "idempotency_key"].includes(key));
    if (unknown.length) return { text: `Unknown argument ${unknown.join(", ")}. No tool takes keys: the user adds endpoint keys at ${deps.config.appUrl}.`, data: {}, isError: true };
    if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== "string" || !args.idempotency_key.trim() || args.idempotency_key.length > 200)) return { text: "idempotency_key must be a non-empty string of at most 200 characters.", data: {}, isError: true };
    const key = typeof args.idempotency_key === "string" ? args.idempotency_key.trim() : null;
    // A higher budget spends more of the user's money: the user confirms it, and the run starts then.
    if (args.budget_usd !== undefined && (args.job_id !== undefined || args.task_id !== undefined)) {
      if (typeof args.budget_usd !== "number" || !Number.isFinite(args.budget_usd) || args.budget_usd <= 0) return { text: "budget_usd must be a positive number of US dollars.", data: {}, isError: true };
      const viaTask = args.task_id !== undefined;
      if (viaTask && (args.bundle !== undefined || args.job_id !== undefined || args.environment !== undefined || args.agent !== undefined || args.project !== undefined)) return { text: "Send task_id on its own: the task keeps its project, environment, agent and bundle.", data: {}, isError: true };
      if (!viaTask && (args.bundle !== undefined || args.environment !== undefined || args.agent !== undefined || args.project !== undefined)) return { text: "Send either a bundle, or the job_id of a past job to run its task again, not both: a rerun keeps the job's project, environment and agent.", data: {}, isError: true };
      const job = viaTask ? null : await account.job(String(args.job_id));
      const task = await account.task(viaTask ? String(args.task_id) : job?.taskId ?? "");
      if (!task) return { text: viaTask ? `No task ${String(args.task_id)} in this account.` : `No run ${String(args.job_id)} in this account.`, data: {}, isError: true };
      return hold({
        projectId: task.projectId, method: "POST", path: viaTask ? `/api/tasks/${task.id}/run` : `/api/runs/${job!.id}/rerun`, body: { budgetUsd: args.budget_usd }, checks: "reverify",
        title: `Run ${task.name} ${viaTask ? "" : "again "}with a budget of $${args.budget_usd} per job`, items: [`Raises the task's budget per job to $${args.budget_usd}, then starts a paid run`],
      });
    }
    if (key) {
      const claim = await account.claimRecommendKey(key);
      if (!claim.claimed) {
        if (!claim.jobId) return { text: "A call with this idempotency_key is still starting its job. Call openmerit_recommend again with the same key in a few seconds.", data: { status: "starting" }, isError: true };
        const view = await client.job.get([claim.jobId]).status();
        return { text: `This idempotency_key already started job ${claim.jobId} (${view.status}); no new job started. Call openmerit_result with job_id "${claim.jobId}".`, data: { job_id: claim.jobId, status: view.status, repeated: true } };
      }
    }
    let started;
    try {
    if (args.task_id !== undefined) {
      if (args.bundle !== undefined || args.job_id !== undefined || args.environment !== undefined || args.agent !== undefined || args.project !== undefined) return { text: "Send task_id on its own: the task keeps its project, environment, agent and bundle.", data: {}, isError: true };
      started = await runTask(client, { accountId: identity.accountId, userId: identity.userId, taskId: String(args.task_id), budgetUsd: typeof args.budget_usd === "number" ? args.budget_usd : null, trigger: "mcp", askedBy });
    } else if (args.job_id !== undefined) {
      if (args.bundle !== undefined || args.environment !== undefined || args.agent !== undefined || args.project !== undefined) return { text: "Send either a bundle, or the job_id of a past job to run its task again, not both: a rerun keeps the job's project, environment and agent.", data: {}, isError: true };
      if (args.budget_usd !== undefined && typeof args.budget_usd !== "number") return { text: "budget_usd must be a number of US dollars.", data: {}, isError: true };
      started = await rerunJob(client, { accountId: identity.accountId, userId: identity.userId, jobId: String(args.job_id), budgetUsd: typeof args.budget_usd === "number" ? args.budget_usd : null, trigger: "mcp", askedBy });
    } else {
      if (args.budget_usd !== undefined) return { text: "budget_usd goes with job_id. For a new bundle, the task's budget is a guardrail at app.openmerit.ai.", data: {}, isError: true };
      const problem = bundleProblem(args.bundle);
      if (problem) return { text: `The task bundle is not usable: ${problem}.`, data: {}, isError: true };
      const environment = typeof args.environment === "string" && args.environment.trim() ? args.environment.trim().replaceAll(":", "-").slice(0, 200) : DEFAULT_ENVIRONMENT;
      const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim().slice(0, 200) : null;
      const project = await projectFor(account, environment, args.project);
      if (!project.ok) return { text: project.error, data: {}, isError: true };
      started = await startJob(client, { accountId: identity.accountId, projectId: project.id, environment, agent, bundle: args.bundle as TaskBundle, kind: "run", trigger: "mcp", userId: identity.userId, askedBy });
    }
    } finally {
      if (key) await account.settleRecommendKey({ key, jobId: started?.ok ? started.jobId : null });
    }
    if (!started.ok) return { text: started.error, data: { status: "refused" }, isError: true };
    const { provisional, estimate } = started;
    return {
      text: `Started job ${started.jobId}. Provisional pick: ${provisional.model} on ${provisional.endpoint}. ${provisional.reason}\n${estimateLine(estimate)}\nCall openmerit_result with job_id "${started.jobId}" for questions and the measured result.`,
      data: { job_id: started.jobId, provisional, estimate, status: "queued" },
    };
  }
  if (name === "openmerit_result") {
    const view = await jobView(args.job_id);
    if (!("jobId" in view)) return view;
    const decision = await account.decision(view.jobId);
    const head = view.result ? (await account.evalHeads())[view.taskId] : undefined;
    return { text: describeJob(view, decision), data: { ...jobData(view, decision), eval: head ?? null }, ...(view.status === "failed" ? { isError: true } : {}) };
  }
  if (name === "openmerit_answer") {
    const view = await jobView(args.job_id);
    if (!("jobId" in view)) return view;
    const answers = args.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { text: "answers must be an object keyed by question id.", data: {}, isError: true };
    // The user's decision on a finished result's change: recorded once, and an approval moves the task onto the pick.
    const approval = view.result?.approval;
    if (approval && Object.hasOwn(answers, approval.id)) return decide(view, (answers as Answers)[approval.id], await account.decision(view.jobId), (await account.job(view.jobId))!.projectId, hold);
    if (!view.questions.length) return { text: `Job ${view.jobId} has no open questions.\n${describeJob(view, await account.decision(view.jobId))}`, data: jobData(view) };
    // Grades are the user's judgment of the answers: they confirm the grades you relay.
    const grades = view.questions.filter(question => question.id.startsWith("grade_") && Object.hasOwn(answers, question.id));
    if (grades.length) {
      const row = await account.job(view.jobId);
      return hold({ projectId: row!.projectId, method: "POST", path: `/api/runs/${view.jobId}/answers`, body: { answers }, checks: "person", title: `Grades for ${view.task}`,
        items: grades.map(question => {
          const [grade = "", ...note] = String((answers as Answers)[question.id]).split(":");
          const label = question.options?.find(option => option.value === grade.trim())?.label ?? grade;
          return `${question.prompt.replace(/: does it look right\?$/, "")}: ${label}${note.length ? ` (${note.join(":").trim()})` : ""}`;
        }) });
    }
    const handle = client.job.get([view.jobId]);
    await handle.send("answers", { answers: answers as Answers, by: identity.userId });
    // The job applies the answers in a moment; return the state once it has, or as it stands after a few seconds.
    let next = view;
    for (let waited = 0; waited < 5000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      next = await handle.status();
      if (next.updatedAt !== view.updatedAt) break;
    }
    return { text: describeJob(next), data: jobData(next) };
  }
  if (name === "openmerit_eval_command") {
    if (deps.config.mode === "hosted") return { text: HOSTED_EVAL_COMMAND, data: { status: "refused" }, isError: true };
    let task = typeof args.task_id === "string" ? await account.task(args.task_id) : null;
    if (args.task_id !== undefined && !task) return { text: `No task ${String(args.task_id)} in this account. openmerit_tasks lists the task ids.`, data: {}, isError: true };
    if (!task) {
      const problem = bundleProblem(args.bundle);
      if (problem) return { text: `Name the task by task_id, or send its bundle and environment. The bundle is not usable: ${problem}.`, data: {}, isError: true };
      const bundle = redactBundle(args.bundle as TaskBundle);
      const environment = typeof args.environment === "string" && args.environment.trim() ? args.environment.trim().replaceAll(":", "-").slice(0, 200) : DEFAULT_ENVIRONMENT;
      const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim().slice(0, 200) : null;
      const project = await projectFor(account, environment, args.project);
      if (!project.ok) return { text: project.error, data: {}, isError: true };
      const taskId = taskIdFor(project.id, environment, bundle.task);
      await account.createTask({ taskId, projectId: project.id, environment, agent, name: bundle.task, currentModel: bundle.current.model });
      const handle = client.task.getOrCreate([identity.accountId, taskId], { createWithInput: { accountId: identity.accountId, taskId, projectId: project.id, environment, name: bundle.task } });
      if (!(await handle.info()).bundle) await handle.prepare(bundle);
      task = await account.task(taskId);
    }
    const row = task!;
    if (args.clear === true) return hold({ projectId: row.projectId, method: "DELETE", path: `/api/tasks/${row.id}/eval-command`, body: {}, checks: "person", title: `Stop measuring ${row.name} with its eval command`, items: ["Its next run measures on OpenMerit's own cases"] });
    const body: Json = { command: args.command, root: args.root, cwd: args.cwd, env: args.env, threshold: args.threshold ?? null, timeoutSeconds: args.timeout_seconds ?? null };
    const checked = evalCommandSpec(body);
    if (!checked.ok) return { text: checked.error, data: {}, isError: true };
    const { spec } = checked;
    const held = await hold({ projectId: row.projectId, method: "PUT", path: `/api/tasks/${row.id}/eval-command`, body, checks: "person", title: `Measure ${row.name} by running a command on this machine`,
      items: [`Command: ${spec.command}`, `In: ${spec.cwd ? `${spec.root}/${spec.cwd}` : spec.root}`, ...(spec.env ? [`Environment: ${Object.entries(spec.env).map(([key, value]) => `${key}=${value}`).join(", ")}`] : []), `It runs once per model measured, with its model calls through OpenMerit's proxy${spec.threshold != null ? `; models need a pass rate of at least ${spec.threshold}` : ""}`] });
    return { ...held, text: `${held.text} Once it is confirmed, call openmerit_recommend with task_id "${row.id}" to measure.`, data: { ...held.data, task_id: row.id } };
  }
  if (name === "openmerit_confirmation") {
    const found = typeof args.confirmation_id === "string" ? await account.confirmation(args.confirmation_id) : null;
    if (!found) return { text: `No confirmation ${String(args.confirmation_id)} in this account.`, data: {}, isError: true };
    const { nonce: _nonce, ...view } = found;
    const answer = (view.result?.body ?? {}) as Json;
    const started = typeof answer.jobId === "string" ? ` It started job ${answer.jobId}: call openmerit_result with job_id "${answer.jobId}".` : "";
    const text = view.status === "pending" ? `Waiting for the user to confirm ${view.title} at ${heldReply(deps.config, view).confirmation.url}.`
      : view.status === "expired" ? `${view.title}: the user did not confirm it in time. Ask them, then make the request again.`
      : view.status === "declined" ? `The user declined: ${view.title}.`
      : view.status === "confirming" ? `The user confirmed ${view.title}; it is running.`
      : view.status === "done" ? `The user confirmed ${view.title}, and it is done.${started}`
      : `The user confirmed ${view.title}, but it failed: ${typeof answer.error === "string" ? answer.error : `status ${view.result?.status}`}.`;
    return { text, data: { confirmation: view }, ...(view.status === "failed" ? { isError: true } : {}) };
  }
  if (name === "openmerit_tasks") {
    const [tasks, ready, decisions, heads, projects] = await Promise.all([account.tasks(), account.readySince(identity.userId), account.taskDecisions(), account.evalHeads(), account.projects()]);
    // With more than one project, each task says which it is in.
    const projectName = new Map(projects.map(item => [item.id, item.name]));
    const inProject = (item: (typeof tasks)[number]) => (projects.length > 1 ? `project ${projectName.get(item.projectId) ?? item.projectId}, ` : "");
    const decided = (item: (typeof tasks)[number]) => {
      const decision = decisions[item.id];
      if (decision && (decision.jobId === item.lastJobId || decision.decision === "approved")) return `, ${decision.decision === "approved" ? "switched" : "declined"}: ${decisionLine(decision).replace(/^Decision: /, "").replace(/\.$/, "")}`;
      return item.pick ? ", waiting for a decision" : "";
    };
    const text = tasks.length
      ? [`${tasks.length} task${tasks.length === 1 ? "" : "s"}:`, ...tasks.map(item => `- ${item.name} [${item.id}] (${inProject(item)}${item.environment}${item.agent ? `, agent ${item.agent}` : ""}): ${item.currentModel}${item.pick ? ` → ${item.pick}` : ""}, ${item.lastRunAt ? `${item.status}, ${item.state}` : "not run yet; ask the user, then call openmerit_recommend with its task_id"}${item.idleSince ? ` since ${item.idleSince.slice(0, 10)}` : ""}${decided(item)}${heads[item.id] ? `, eval v${heads[item.id]!.version}${heads[item.id]!.review ? " (a draft waits for review in the app)" : ""}` : ""}`),
        ready.length ? `Ready since the last session: ${ready.map(item => `${item.id} (${item.status})`).join(", ")}. Call openmerit_result for each.` : "Nothing new since the last session."].join("\n")
      : "No tasks yet. Call openmerit_recommend with a task bundle to start one.";
    return { text, data: { tasks: tasks.map(item => ({ ...item, decision: decisions[item.id] ?? null, eval: heads[item.id] ?? null })), readySinceLastSession: ready } };
  }
  if (name === "openmerit_eval") {
    const taskId = typeof args.task_id === "string" ? args.task_id : "";
    const row = await account.task(taskId);
    if (!row) return { text: `No task ${taskId} in this account. openmerit_tasks lists the task ids.`, data: {}, isError: true };
    const view = await account.eval(taskId);
    const latest = view?.accepted;
    if (!latest) return { text: `${row.name} has no eval yet: its first run writes one.`, data: {}, isError: true };
    const url = `${deps.config.appUrl}/tasks/?task=${encodeURIComponent(taskId)}&tab=eval`;
    return {
      text: [`${row.name}'s accepted eval, version ${latest.version}: ${latest.cases.length} cases, measured against ${latest.bar === "criteria" ? "the eval's checks" : "the current model's score"}.${view.draft ? ` A draft of the next version waits for review at ${url}.` : ""}`,
        `Spec: ${JSON.stringify(latest.spec)}`, ...latest.cases.map(item => `- ${item.id}: ${JSON.stringify(item.input)} → ${JSON.stringify(item.expected)}`)].join("\n"),
      data: { task_id: taskId, version: latest.version, bar: latest.bar, spec: latest.spec, cases: latest.cases, draft: view.draft !== null, url },
    };
  }
  if (name === "openmerit_retire") {
    const row = typeof args.task_id === "string" ? await account.task(args.task_id) : null;
    if (!row) return { text: `No task ${String(args.task_id)} in this account. openmerit_tasks lists the task ids.`, data: {}, isError: true };
    await client.task.get([identity.accountId, row.id]).retire();
    return { text: `Retired ${row.name}: OpenMerit no longer re-runs it. Its runs and reports are kept; openmerit_recommend for the same task brings it back.`, data: { task_id: row.id, state: "retired" } };
  }
  return { text: `Unknown tool ${name}`, data: {}, isError: true };
}

/**
 * The user's decision on a finished job's change, which the coding agent relays after asking the result's
 * approval question. The user confirms it; an approval means the agent applied the edit, so the task's
 * later runs measure the pick as its current model.
 */
async function decide(view: JobView, value: unknown, decision: Decision | null, projectId: string, hold: (input: { projectId: string; method: string; path: string; body: Json; checks: "person" | "reverify"; title: string; items: string[] }) => Promise<ToolResult>): Promise<ToolResult> {
  const result = view.result!, approval = result.approval!, pick = result.pick;
  if (typeof value !== "boolean") return { text: `${approval.id} takes true (the user approved and you applied the edit) or false (they declined).`, data: {}, isError: true };
  if (!pick) return { text: `Job ${view.jobId} proposes no change to decide on.`, data: jobData(view), isError: true };
  if (decision) return { text: `The decision on job ${view.jobId} was already recorded. ${decisionLine(decision)}`, data: jobData(view, decision), isError: true };
  return hold({ projectId, method: "POST", path: `/api/runs/${view.jobId}/decision`, body: { approved: value }, checks: "person",
    title: `${value ? "Approve" : "Decline"} the switch for ${view.task}`, items: [`${result.baseline?.model ?? view.task} → ${pick.model} (${pick.endpoint})`, ...result.edit.edits.map(edit => `${edit.file}:${edit.line}: ${edit.before} → ${edit.after}`)] });
}

/**
 * What a coding agent should know at the start of a session: the organization it works in, and what waits
 * for the user (requests to confirm, and results whose switch nobody decided). Read-only: it does not end
 * the "since the last session" window openmerit_tasks reports.
 */
async function sessionBrief(deps: McpDeps, identity: Identity): Promise<string[]> {
  const account = deps.client.account.getOrCreate([identity.accountId]);
  const [info, pending, tasks, decisions] = await Promise.all([account.info(), account.pendingConfirmations(), account.tasks(), account.taskDecisions()]);
  const name = identity.accountName ?? info.name;
  const lines = [deps.config.mode === "hosted" ? `You act in the OpenMerit organization ${name ? `${name} (${identity.accountId})` : identity.accountId}. Tell the user, so they confirm in the same organization.` : "You act on this self-hosted OpenMerit server, for its one user."];
  for (const item of pending) lines.push(`Waiting for the user to confirm: ${item.title}, at ${confirmUrl(deps.config, item.id)} (expires ${item.expiresAt.slice(0, 16).replace("T", " ")} UTC).`);
  for (const task of tasks) {
    const decision = decisions[task.id];
    if (task.pick && task.state !== "retired" && !(decision && (decision.jobId === task.lastJobId || decision.decision === "approved"))) lines.push(`${task.name} [${task.id}]: switching ${task.currentModel} to ${task.pick} waits for the user's decision; call openmerit_result with job_id "${task.lastJobId}".`);
  }
  if (lines.length > 1) lines.splice(1, 0, "At the start of this session, tell the user what waits for them:");
  return lines;
}

/** /mcp. A missing or invalid token gets 401 with the protected-resource metadata, which starts the client's Clerk sign-in. */
export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") return new Response("Use POST: this server answers each request on its own and opens no streams.\n", { status: 405, headers: { allow: "POST" } });
  if (!deps.auth) return json(503, { error: "Sign-in is not configured on this server." });
  const auth: AuthResult = await deps.auth.mcp(request);
  if (!auth.ok && auth.status === 401) {
    return json(401, { error: "unauthorized", error_description: auth.error }, { "www-authenticate": `Bearer error="invalid_token", error_description="${auth.error.replaceAll("\"", "'")}", resource_metadata="${resourceMetadataUrl(deps.config)}"` });
  }
  const identity: Identity | null = auth.ok ? auth.identity : null;
  if (identity) {
    const info = await deps.client.account.getOrCreate([identity.accountId]).info();
    if (info.mcpRevokedBefore !== null && (identity.issuedAt === null || identity.issuedAt <= info.mcpRevokedBefore)) {
      return json(401, { error: "unauthorized", error_description: "This account disconnected its MCP sessions. Sign in again." }, { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(deps.config)}"` });
    }
  }
  let body: unknown;
  try { body = await request.json(); } catch { return json(400, rpc(null, { error: { code: -32700, message: "Parse error" } })); }
  const messages = Array.isArray(body) ? body : [body];
  const replies: unknown[] = [];
  const askedBy = clientOf(request.headers.get("mcp-session-id"));
  let session: string | null = null;
  for (const message of messages as Json[]) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message && "id" in message) replies.push(rpc(message.id, { error: { code: -32600, message: "Invalid request" } }));
      continue;
    }
    const { id, method } = message;
    const params = (message.params ?? {}) as Json;
    if (id === undefined) continue; // A notification, such as notifications/initialized: nothing to answer.
    if (method === "initialize") {
      session = sessionFor(params.clientInfo);
      const asked = String(params.protocolVersion ?? "");
      const brief = identity ? await sessionBrief(deps, identity) : [];
      replies.push(rpc(id, { result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "openmerit", title: "OpenMerit", version: VERSION },
        instructions: ["OpenMerit finds cheaper models that do a task at least as well as the current one, measured on cases from the task. Send a task bundle with openmerit_recommend, relay every question openmerit_result returns to the user, and ask before applying an edit. A budget, grades and a decision on a switch need the user's confirmation on the page OpenMerit links.", ...brief].join("\n"),
      } }));
    } else if (method === "ping") replies.push(rpc(id, { result: {} }));
    else if (method === "tools/list") replies.push(rpc(id, { result: { tools: TOOLS } }));
    else if (method === "tools/call") {
      let result: ToolResult;
      if (!identity) result = { text: auth.ok ? "" : auth.error || NO_ORGANIZATION, data: { status: "no_account" }, isError: true };
      else {
        const tool = String(params.name ?? "");
        const startedAt = Date.now();
        try { result = await callTool(deps, identity, tool, (params.arguments ?? {}) as Json, askedBy); }
        catch (error) { result = { text: `OpenMerit could not complete the call: ${error instanceof Error ? error.message : String(error)}`, data: {}, isError: true }; }
        // The tool's name is the client's to choose, so an unknown one is sent as such. Never its arguments or result.
        void capture(deps.config.posthog, "mcp_tool_called", identity.userId, {
          interface: "mcp", tool: TOOL_NAMES.has(tool) ? tool : "unknown", ...(askedBy ? { client: askedBy } : {}), ok: !result.isError, duration_ms: Date.now() - startedAt, account_id: identity.accountId,
        });
      }
      replies.push(rpc(id, { result: { content: [{ type: "text", text: result.text }], structuredContent: result.data, ...(result.isError ? { isError: true } : {}) } }));
    } else replies.push(rpc(id, { error: { code: -32601, message: `Method not found: ${method}` } }));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(200, Array.isArray(body) ? replies : replies[0], session ? { "mcp-session-id": session } : {});
}
