// MCP over streamable HTTP at /mcp, stateless per request: every call carries its Clerk access
// token, and all state lives in the actors, so any node can answer. Responses are plain JSON, which
// the streamable HTTP transport allows when a server sends no notifications.
import { randomBytes } from "node:crypto";
import { NO_ORGANIZATION, type Auth, type AuthResult, type Identity } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Answers, JobView } from "./actors/job.ts";
import type { AppClient } from "./registry.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { bundleProblem, DEFAULT_ENVIRONMENT, startJob } from "./start.ts";

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
    codeRefs: { type: "array", description: "Where the code names the model, so the result can include the edit", items: { type: "object", required: ["file", "line", "spelling"], properties: { file: string, line: { type: "number" }, spelling: string } } },
  },
};

export const TOOLS = [
  {
    name: "openmerit_recommend", title: "OpenMerit: recommend a model",
    description: "Starts measuring cheaper models for one model call in the user's code. Send a task bundle: the task, the current model, the prompt, tools, output shape, examples and where the code names the model. Returns a provisional pick from the catalogue at once, and a job_id; call openmerit_result with it later for the measured pick. Measuring makes paid model calls within the account's plan and budget.",
    inputSchema: { type: "object", required: ["bundle"], additionalProperties: false, properties: { bundle: BUNDLE_SCHEMA, environment: { type: "string", description: "The repository or workspace, such as owner/repo. Default: default" }, agent: { type: "string", description: "The agent this task belongs to, when the code groups calls into agents" } } },
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
    description: "Sends the user's answers to a job's questions, keyed by question id, such as a label check. Returns the job's state, as openmerit_result does.",
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

type Json = Record<string, unknown>;
interface ToolResult { text: string; data: Json; isError?: boolean }

export interface McpDeps { client: AppClient; auth: Auth | null; config: Config }

const rpc = (id: unknown, body: Json) => ({ jsonrpc: "2.0", id: id ?? null, ...body });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const resourceMetadataUrl = (config: Config) => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

/** Why the job's state stands where it does, for the coding agent. */
export function describeJob(view: JobView): string {
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
    lines.push("Ask the user before applying the edit.");
  } else if (result) lines.push(`No switch proposed (${result.status}).`);
  if (result) lines.push(`Report: ${result.reportUrl}`);
  else if (view.status === "running" || view.status === "queued") lines.push(`Provisional pick while it runs: ${view.provisional.model}. ${view.provisional.reason} Measured ${view.progress.measured} so far; call openmerit_result again later.`);
  if (view.notices.length) lines.push(...view.notices.map(notice => `Note: ${notice}`));
  if (view.error) lines.push(`Error: ${view.error}`);
  return lines.join("\n");
}

const jobData = (view: JobView): Json => ({
  job_id: view.jobId, task: view.task, status: view.status, phase: view.phase, questions: view.questions, notices: view.notices, progress: view.progress,
  provisional: view.provisional, ...(view.error ? { error: view.error } : {}),
  ...(view.result ? { result: { status: view.result.status, pick: view.result.pick, top: view.result.top, reportUrl: view.result.reportUrl, edit: view.result.edit, spend: view.result.spend } } : {}),
});

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
    if (typeof jobId !== "string" || !(await account.job(jobId))) return { text: `No job ${String(jobId)} in this account.`, data: {}, isError: true };
    return client.job.get([jobId]).status();
  };
  if (name === "openmerit_recommend") {
    const unknown = Object.keys(args).filter(key => !["bundle", "environment", "agent"].includes(key));
    if (unknown.length) return { text: `Unknown argument ${unknown.join(", ")}. No tool takes keys: the user adds endpoint keys at ${deps.config.appUrl}.`, data: {}, isError: true };
    const problem = bundleProblem(args.bundle);
    if (problem) return { text: `The task bundle is not usable: ${problem}.`, data: {}, isError: true };
    const environment = typeof args.environment === "string" && args.environment.trim() ? args.environment.trim().replaceAll(":", "-").slice(0, 200) : DEFAULT_ENVIRONMENT;
    const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim().slice(0, 200) : null;
    const started = await startJob(client, { accountId: identity.accountId, environment, agent, bundle: args.bundle as TaskBundle, kind: "run", askedBy });
    if (!started.ok) return { text: started.error, data: { status: "refused" }, isError: true };
    const { provisional } = started;
    return {
      text: `Started job ${started.jobId}. Provisional pick: ${provisional.model} on ${provisional.endpoint}. ${provisional.reason}\nCall openmerit_result with job_id "${started.jobId}" for questions and the measured result.`,
      data: { job_id: started.jobId, provisional, status: "queued" },
    };
  }
  if (name === "openmerit_result") {
    const view = await jobView(args.job_id);
    return "jobId" in view ? { text: describeJob(view), data: jobData(view), ...(view.status === "failed" ? { isError: true } : {}) } : view;
  }
  if (name === "openmerit_answer") {
    const view = await jobView(args.job_id);
    if (!("jobId" in view)) return view;
    const answers = args.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { text: "answers must be an object keyed by question id.", data: {}, isError: true };
    if (!view.questions.length) return { text: `Job ${view.jobId} has no open questions.\n${describeJob(view)}`, data: jobData(view) };
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
    const [tasks, ready] = await Promise.all([account.tasks(), account.readySince(identity.userId)]);
    const text = tasks.length
      ? [`${tasks.length} task${tasks.length === 1 ? "" : "s"}:`, ...tasks.map(item => `- ${item.name} [${item.id}] (${item.environment}${item.agent ? `, agent ${item.agent}` : ""}): ${item.currentModel}${item.pick ? ` → ${item.pick}` : ""}, ${item.status}, ${item.state}${item.idleSince ? ` since ${item.idleSince.slice(0, 10)}` : ""}`),
        ready.length ? `Ready since the last session: ${ready.map(item => `${item.id} (${item.status})`).join(", ")}. Call openmerit_result for each.` : "Nothing new since the last session."].join("\n")
      : "No tasks yet. Call openmerit_recommend with a task bundle to start one.";
    return { text, data: { tasks, readySinceLastSession: ready } };
  }
  if (name === "openmerit_retire") {
    const row = typeof args.task_id === "string" ? await account.task(args.task_id) : null;
    if (!row) return { text: `No task ${String(args.task_id)} in this account. openmerit_tasks lists the task ids.`, data: {}, isError: true };
    await client.task.get([identity.accountId, row.id]).retire();
    return { text: `Retired ${row.name}: OpenMerit no longer re-runs it. Its runs and reports are kept; openmerit_recommend for the same task brings it back.`, data: { task_id: row.id, state: "retired" } };
  }
  return { text: `Unknown tool ${name}`, data: {}, isError: true };
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
        try { result = await callTool(deps, identity, String(params.name ?? ""), (params.arguments ?? {}) as Json, askedBy); }
        catch (error) { result = { text: `OpenMerit could not complete the call: ${error instanceof Error ? error.message : String(error)}`, data: {}, isError: true }; }
      }
      replies.push(rpc(id, { result: { content: [{ type: "text", text: result.text }], structuredContent: result.data, ...(result.isError ? { isError: true } : {}) } }));
    } else replies.push(rpc(id, { error: { code: -32601, message: `Method not found: ${method}` } }));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(200, Array.isArray(body) ? replies : replies[0], session ? { "mcp-session-id": session } : {});
}
