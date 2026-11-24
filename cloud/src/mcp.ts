// MCP over streamable HTTP at /mcp, stateless per request: every call carries its Clerk access
// token, and all state lives in the actors, so any node can answer. Responses are plain JSON, which
// the streamable HTTP transport allows when a server sends no notifications.
import { randomBytes } from "node:crypto";
import { capture } from "./analytics.ts";
import { NO_ORGANIZATION, type Auth, type AuthResult, type Identity } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Answers, JobView } from "./actors/job.ts";
import { explain, nearMissLine, reasonFor, type Fix, type JobResult } from "./report.ts";
import type { AppClient } from "./registry.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { bundleProblem, DEFAULT_ENVIRONMENT, rerunJob, startJob } from "./start.ts";
import type { Decision } from "./actors/account.ts";
import { OPENROUTER } from "./pool.ts";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

const string = { type: "string" } as const;
const BUNDLE_SCHEMA = {
  type: "object",
  description: "Everything OpenMerit needs to measure models on this task without your code. Do not include API keys or secrets: the user adds endpoint keys at app.openmerit.ai.",
  required: ["task", "current", "prompt", "output"],
  properties: {
    task: { type: "string", description: "The task's name, such as \"ticket classifier\". The same name continues the same task." },
    description: string,
    current: { type: "object", required: ["model"], properties: { model: { type: "string", description: "The model ID the code uses now, as the code spells it" }, endpoint: { type: "string", description: "The ID of the user's endpoint at app.openmerit.ai that serves it, when not OpenRouter" } } },
    prompt: {
      type: "object", required: ["messages"], description: "The prompt the code sends, with {{name}} placeholders for each example's input variables",
      properties: { system: string, messages: { type: "array", items: { type: "object", required: ["role", "content"], properties: { role: { enum: ["user", "assistant"] }, content: string } } } },
    },
    tools: { type: "array", items: { type: "object", required: ["name", "parameters"], properties: { name: string, description: string, parameters: { type: "object" }, mockResult: {} } } },
    output: {
      oneOf: [
        { type: "object", required: ["kind"], properties: { kind: { const: "text" } } },
        { type: "object", required: ["kind", "schema"], properties: { kind: { const: "json" }, schema: { type: "object" } } },
        { type: "object", required: ["kind", "labels"], properties: { kind: { const: "label" }, labels: { type: "array", items: string } } },
      ],
    },
    examples: { type: "array", description: "Real inputs from the code or its tests, with the correct answer when known. These become the first test cases.", items: { type: "object", required: ["input"], properties: { input: { type: "object", additionalProperties: string }, expected: {} } } },
    constraints: { type: "object", properties: { maxLatencyMs: { type: "number" }, needsVision: { type: "boolean" } } },
    input: { type: "object", required: ["description"], description: "The task spec: what the call's input is and how it varies in production", properties: { description: string } },
    steps: { type: "array", description: "The task spec: what the model does, in order, with the tools each step uses and their access", items: { type: "object", required: ["description"], properties: { description: string, tools: { type: "array", items: string }, access: { enum: ["none", "read", "write"] } } } },
    criteria: { type: "array", description: "The task spec: what a right answer does, one statement each, from the code and its prompt. OpenMerit judges every case on each", items: string },
    guardrails: { type: "array", description: "The task spec: what the call must never do, one statement each, such as rules the code enforces after the call. OpenMerit judges every case on each, and writes cases that test them", items: string },
    codeRefs: { type: "array", description: "Where the code names the model, so the result can include the edit. spelling is the exact string literal that holds the model ID as the code writes it, with its quotes, such as '\"gpt-4.1-mini\"', or the expression around it, such as 'process.env.CLASSIFIER_MODEL ?? \"gpt-4.1-mini\"'; only that literal is edited. A config file or environment value that holds the model belongs in a ref of its own, at the line that sets it", items: { type: "object", required: ["file", "line", "spelling"], properties: { file: string, line: { type: "number" }, spelling: string } } },
  },
};

export const TOOLS = [
  {
    name: "openmerit_recommend", title: "OpenMerit: recommend a model",
    description: "Starts measuring cheaper models for one model call in the user's code. Send a task bundle: the task, the current model, the prompt, tools, output shape, examples and where the code names the model. Or, to run a past job's task again on the bundle OpenMerit saved, as a result's Fix line says, send its job_id instead, with budget_usd to raise the task's budget per job first. Returns a provisional pick from the catalogue at once, and a job_id; call openmerit_result with it later for the measured pick. Measuring makes paid model calls within the account's plan and budget: ask the user before a rerun or a higher budget.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      bundle: BUNDLE_SCHEMA, environment: { type: "string", description: "The repository or workspace, such as owner/repo. Default: default" }, agent: { type: "string", description: "The agent this task belongs to, when the code groups calls into agents" },
      job_id: { type: "string", description: "Instead of a bundle: a past job whose task runs again on its saved bundle, environment and agent" },
      budget_usd: { type: "number", description: "With job_id: the task's new budget per job in US dollars, set before the run starts" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openmerit_result", title: "OpenMerit: job result",
    description: "A job's state: running with progress, questions for the user, or the measured result with the code edit and a report link. Show every question to the user, with its detail, and send their answers with openmerit_answer. Never answer for the user.",
    inputSchema: { type: "object", required: ["job_id"], additionalProperties: false, properties: { job_id: string } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_answer", title: "OpenMerit: answer a job's questions",
    description: "Sends the user's answers to a job's questions, keyed by question id, such as a label check. After a result, it also takes the user's decision on its change, keyed by the result's approval id (configure_<task>): true once you applied the edit they approved, false when they declined. Returns the job's state, as openmerit_result does.",
    inputSchema: { type: "object", required: ["job_id", "answers"], additionalProperties: false, properties: { job_id: string, answers: { type: "object", description: "Answers keyed by question id: strings, string lists, booleans or numbers", additionalProperties: { type: ["string", "array", "boolean", "number"] } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "openmerit_tasks", title: "OpenMerit: tasks",
    description: "Lists the account's tasks with their ids and watch state, and the results that finished since the last session. A task is watching (OpenMerit re-runs it when the model catalogue changes), idle (no openmerit_recommend call for a while; the next one resumes it), frozen (a watch guardrail keeps its validated model) or retired.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_retire", title: "OpenMerit: retire a task",
    description: "Call this when you remove a model call from the user's code, so OpenMerit stops re-running that task. The task's runs and report links are kept, and a later openmerit_recommend for the same task brings it back. Do not use it to keep a model the user validated: that is the watch guardrail at app.openmerit.ai. Take the task id from openmerit_tasks.",
    inputSchema: { type: "object", required: ["task_id"], additionalProperties: false, properties: { task_id: string } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
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
    lines.push(`It needs the user. Ask them, then call openmerit_answer with job_id "${view.jobId}" and answers keyed by question id:`);
    for (const question of view.questions) lines.push(`- [${question.id}] (${question.kind}) ${question.prompt}${question.options ? `\n  Options: ${question.options.map(option => option.value).join(" | ")}` : ""}${question.detail ? `\n  ${question.detail.split("\n").join("\n  ")}` : ""}${question.hint ? `\n  ${question.hint}` : ""}`);
  }
  const result = view.result;
  if (result?.pick) {
    lines.push(`Measured pick: ${result.pick.model} on ${result.pick.endpoint}, ${result.pick.passes}/${result.pick.total} cases passed${result.baseline ? ` (current model ${result.baseline.passes}/${result.baseline.total})` : ""}.`);
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
  if (name === "openmerit_recommend") {
    const unknown = Object.keys(args).filter(key => !["bundle", "environment", "agent", "job_id", "budget_usd"].includes(key));
    if (unknown.length) return { text: `Unknown argument ${unknown.join(", ")}. No tool takes keys: the user adds endpoint keys at ${deps.config.appUrl}.`, data: {}, isError: true };
    let started;
    if (args.job_id !== undefined) {
      if (args.bundle !== undefined || args.environment !== undefined || args.agent !== undefined) return { text: "Send either a bundle, or the job_id of a past job to run its task again, not both: a rerun keeps the job's environment and agent.", data: {}, isError: true };
      if (args.budget_usd !== undefined && typeof args.budget_usd !== "number") return { text: "budget_usd must be a number of US dollars.", data: {}, isError: true };
      started = await rerunJob(client, { accountId: identity.accountId, userId: identity.userId, jobId: String(args.job_id), budgetUsd: typeof args.budget_usd === "number" ? args.budget_usd : null, trigger: "mcp", askedBy });
    } else {
      if (args.budget_usd !== undefined) return { text: "budget_usd goes with job_id. For a new bundle, the task's budget is a guardrail at app.openmerit.ai.", data: {}, isError: true };
      const problem = bundleProblem(args.bundle);
      if (problem) return { text: `The task bundle is not usable: ${problem}.`, data: {}, isError: true };
      const environment = typeof args.environment === "string" && args.environment.trim() ? args.environment.trim().replaceAll(":", "-").slice(0, 200) : DEFAULT_ENVIRONMENT;
      const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim().slice(0, 200) : null;
      started = await startJob(client, { accountId: identity.accountId, environment, agent, bundle: args.bundle as TaskBundle, kind: "run", trigger: "mcp", userId: identity.userId, askedBy });
    }
    if (!started.ok) return { text: started.error, data: { status: "refused" }, isError: true };
    const { provisional } = started;
    return {
      text: `Started job ${started.jobId}. Provisional pick: ${provisional.model} on ${provisional.endpoint}. ${provisional.reason}\nCall openmerit_result with job_id "${started.jobId}" for questions and the measured result.`,
      data: { job_id: started.jobId, provisional, status: "queued" },
    };
  }
  if (name === "openmerit_result") {
    const view = await jobView(args.job_id);
    if (!("jobId" in view)) return view;
    const decision = await account.decision(view.jobId);
    return { text: describeJob(view, decision), data: jobData(view, decision), ...(view.status === "failed" ? { isError: true } : {}) };
  }
  if (name === "openmerit_answer") {
    const view = await jobView(args.job_id);
    if (!("jobId" in view)) return view;
    const answers = args.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { text: "answers must be an object keyed by question id.", data: {}, isError: true };
    // The user's decision on a finished result's change: recorded once, and an approval moves the task onto the pick.
    const approval = view.result?.approval;
    if (approval && Object.hasOwn(answers, approval.id)) return decide(deps, identity, view, answers as Answers);
    if (!view.questions.length) return { text: `Job ${view.jobId} has no open questions.\n${describeJob(view, await account.decision(view.jobId))}`, data: jobData(view) };
    const handle = client.job.get([view.jobId]);
    await handle.send("answers", { answers: answers as Answers });
    // The job applies the answers in a moment; return the state once it has, or as it stands after a few seconds.
    let next = view;
    for (let waited = 0; waited < 5000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      next = await handle.status();
      if (next.updatedAt !== view.updatedAt) break;
    }
    return { text: describeJob(next), data: jobData(next) };
  }
  if (name === "openmerit_tasks") {
    const [tasks, ready, decisions] = await Promise.all([account.tasks(), account.readySince(identity.userId), account.taskDecisions()]);
    const decided = (item: (typeof tasks)[number]) => {
      const decision = decisions[item.id];
      if (decision && (decision.jobId === item.lastJobId || decision.decision === "approved")) return `, ${decision.decision === "approved" ? "switched" : "declined"}: ${decisionLine(decision).replace(/^Decision: /, "").replace(/\.$/, "")}`;
      return item.pick ? ", waiting for a decision" : "";
    };
    const text = tasks.length
      ? [`${tasks.length} task${tasks.length === 1 ? "" : "s"}:`, ...tasks.map(item => `- ${item.name} [${item.id}] (${item.environment}${item.agent ? `, agent ${item.agent}` : ""}): ${item.currentModel}${item.pick ? ` → ${item.pick}` : ""}, ${item.status}, ${item.state}${item.idleSince ? ` since ${item.idleSince.slice(0, 10)}` : ""}${decided(item)}`),
        ready.length ? `Ready since the last session: ${ready.map(item => `${item.id} (${item.status})`).join(", ")}. Call openmerit_result for each.` : "Nothing new since the last session."].join("\n")
      : "No tasks yet. Call openmerit_recommend with a task bundle to start one.";
    return { text, data: { tasks: tasks.map(item => ({ ...item, decision: decisions[item.id] ?? null })), readySinceLastSession: ready } };
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
 * Records the user's decision on a finished job's change, which the coding agent sends after asking
 * the result's approval question. The first decision stands. An approval means the agent applied the
 * edit, so the task's later runs measure the pick as its current model.
 */
async function decide(deps: McpDeps, identity: Identity, view: JobView, answers: Answers): Promise<ToolResult> {
  const result = view.result!, approval = result.approval!, pick = result.pick;
  const value = answers[approval.id];
  if (typeof value !== "boolean") return { text: `${approval.id} takes true (the user approved and you applied the edit) or false (they declined).`, data: {}, isError: true };
  if (!pick) return { text: `Job ${view.jobId} proposes no change to decide on.`, data: jobData(view), isError: true };
  const account = deps.client.account.getOrCreate([identity.accountId]);
  const person = await deps.auth?.person(identity.userId).catch(() => null) ?? null;
  const change = `${result.baseline?.model ?? view.task} → ${pick.model} (${pick.endpoint})`;
  const { recorded, decision } = await account.decide({ jobId: view.jobId, taskId: view.taskId, decision: value ? "approved" : "declined", change, by: identity.userId, name: person?.name ?? null, email: person?.email ?? null });
  if (!recorded) return { text: `The decision on job ${view.jobId} was already recorded. ${decisionLine(decision)}`, data: jobData(view, decision), isError: true };
  if (decision.decision === "approved") await deps.client.task.get([identity.accountId, view.taskId]).adopt({ model: pick.endpoint === OPENROUTER ? pick.model : pick.endpointModel, endpoint: pick.endpoint === OPENROUTER ? null : pick.endpoint, edits: result.edit.edits });
  return { text: `Recorded. ${decisionLine(decision)}${decision.decision === "approved" ? ` OpenMerit now watches ${view.task} on ${pick.model}.` : ""}`, data: jobData(view, decision) };
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
      replies.push(rpc(id, { result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "openmerit", title: "OpenMerit", version: VERSION },
        instructions: "OpenMerit finds cheaper models that do a task at least as well as the current one, measured on cases from the task. Send a task bundle with openmerit_recommend, relay every question openmerit_result returns to the user, and ask before applying an edit.",
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
