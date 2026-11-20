// /api/* for app.openmerit.ai, and reports as Markdown for agents. Requests carry a Clerk session
// token; the account is the caller's active Clerk organization. Changing endpoints, environment
// guardrails, billing and the account itself needs the organization's admin role.
import type { AppDeps } from "./app.ts";
import type { AuthResult, Identity } from "./auth.ts";
import { LEVELS, type Guardrails, type Level } from "./engine.ts";
import { explain, type JobResult } from "./report.ts";
import { rerunJob } from "./start.ts";
import { connectLangfuse, LANGFUSE, langfuseTaskId, langfuseView, startLangfuseTasks } from "./langfuse.ts";
import { approveChange, disarmRelist, labelRuns, connectViktor, currentViktorView, namedApproval, startRelist, startViktorTasks, VIKTOR, viktorTaskId, viktorView } from "./viktor.ts";
import type { EndpointKind } from "../../openmerit-core/src/ranking/index.ts";

type Json = Record<string, unknown>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const error = (status: number, message: string) => json(status, { error: message });
/**
 * Destructive actions need a first-factor verification in the last REVERIFY_MINUTES. Otherwise the
 * 403 body is the one Clerk's reverification helpers (`useReverification`) recognize, so the app can
 * open Clerk's prompt and retry. A token without `fva` fails closed.
 */
const REVERIFY_MINUTES = 10;
const reverify = (who: Identity) => who.firstFactorAgeMinutes !== null && who.firstFactorAgeMinutes < REVERIFY_MINUTES ? null
  : json(403, { clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: { level: "first_factor", afterMinutes: REVERIFY_MINUTES } } } });
const markdown = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });

/** A public report link names its account, so the app finds the report without a global index. */
const shareToken = (accountId: string, secret: string) => `${Buffer.from(accountId).toString("base64url")}.${secret}`;
function parseShare(token: string): { accountId: string; secret: string } | null {
  const [account, secret] = token.split(".");
  if (!account || !secret) return null;
  const accountId = Buffer.from(account, "base64url").toString("utf8");
  return /^[\w-]+$/.test(accountId) ? { accountId, secret } : null;
}

export function cors(request: Request, deps: AppDeps): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = deps.config.clerk?.authorizedParties ?? [deps.config.appUrl];
  if (!origin || !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "false", vary: "Origin" };
}

async function body(request: Request): Promise<Json | null> {
  try { const value = await request.json() as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null; } catch { return null; }
}

export function apiRoutes(deps: AppDeps) {
  const { client, config } = deps;

  const authenticate = async (request: Request, agentsToo = false): Promise<AuthResult> => {
    if (!deps.auth) return { ok: false, status: 401, error: "Sign-in is not configured on this server." };
    const session = await deps.auth.api(request);
    if (session.ok || !agentsToo) return session;
    // Agents read reports with the MCP access token they already hold.
    return deps.auth.mcp(request);
  };

  const routes = async (request: Request, url: URL, who: Identity): Promise<Response | null> => {
    const path = url.pathname;
    const method = request.method;
    const account = client.account.getOrCreate([who.accountId]);
    await account.touch({ userId: who.userId, role: who.role, name: who.accountName });
    const admin = () => who.role === "admin" ? null : error(403, "Only an organization admin can do this.");
    let match: RegExpExecArray | null;

    if (path === "/api/me" && method === "GET") {
      const info = await account.info();
      const plan = info.plan;
      return json(200, {
        user: { id: who.userId }, account: { id: info.id, name: info.name ?? who.accountName }, role: who.role,
        plan: plan
          ? { name: plan.name, status: plan.status, periodEnd: plan.periodEnd ? new Date(plan.periodEnd * 1000).toISOString() : null, includedEvals: plan.includedEvals, usedEvals: plan.usedEvals }
          : { name: null, status: "none", periodEnd: null, includedEvals: 0, usedEvals: 0 },
      });
    }

    if (path === "/api/tasks" && method === "GET") return json(200, await account.tasks());
    if (path === "/api/tasks/deleted" && method === "GET") return json(200, await account.deletions());
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin() ?? reverify(who); if (denied) return denied;
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const jobs = await account.jobs({ taskId: row.id, limit: 100_000 });
      // A job that is computing would write its result back after the delete; one that waits for answers can go.
      if (jobs.some(job => job.status === "queued" || job.status === "running")) return error(409, "This task has a run in progress. Delete it when the run finishes.");
      // The task first, so the catalogue stops telling it; then its jobs, which hold its bundle and cases; then its rows.
      await client.task.get([who.accountId, row.id]).destroy().catch(() => null);
      for (const job of jobs) await client.job.get([job.id]).destroy().catch(() => null);
      const deleted = await account.deleteTask({ taskId: row.id, userId: who.userId });
      return json(200, { deleted: true, jobs: deleted.jobs });
    }
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "GET") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const info = await client.task.get([who.accountId, row.id]).info();
      return json(200, { ...row, bundle: info.bundle, lastResult: info.lastResult, notices: info.notices, jobs: await account.jobs({ taskId: row.id, limit: 20 }), guardrails: await account.resolveGuardrails({ environment: row.environment, agent: row.agent, taskId: row.id }) });
    }

    if (path === "/api/runs" && method === "GET") return json(200, await labelRuns(client, deps.auth, who.accountId, await account.jobs({ limit: Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50) })));
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const jobId = match[1]!;
      const row = await account.job(jobId);
      if (!row) return error(404, "No such run in this account.");
      const report = await account.report({ jobId });
      // A connected app's task as its connection lists it now, for the run page's Evaluate again: its estimate, and why it cannot start now.
      const listed = row.kind === VIKTOR ? (await viktorView(client, who.accountId)).tasks.find(task => viktorTaskId(task) === row.taskId)
        : row.kind === LANGFUSE ? (await langfuseView(client, who.accountId)).tasks.find(task => langfuseTaskId(task) === row.taskId) : undefined;
      const evaluate = listed && listed.status !== "skipped" ? { evaluating: listed.status === "evaluating", blocked: listed.blocked, estimatedCredits: "estimatedCredits" in listed ? listed.estimatedCredits : null, budgetUsd: "budgetUsd" in listed ? listed.budgetUsd : null } : null;
      // The saved report, with the same reason and cheaperThanCurrent the coding agent gets, and a connection result's approval.
      if (report) return json(200, { ...(report.json as JobResult), ...explain(report.json as JobResult), approved: await namedApproval(client, deps.auth, who.accountId, jobId), evaluate });
      return json(200, { ...(row.kind === VIKTOR ? await client.viktorJob.get([jobId]).status() : await client.job.get([jobId]).status()), report: null, evaluate });
    }
    // Approve change: records who approved a connection result's change, and when. It changes nothing in the connected app.
    if ((match = /^\/api\/runs\/([\w-]+)\/approve$/.exec(path)) && method === "POST") {
      const denied = admin(); if (denied) return denied;
      if (!(await account.job(match[1]!))) return error(404, "No such run in this account.");
      const approved = await approveChange(client, deps.auth, { accountId: who.accountId, userId: who.userId, jobId: match[1]! });
      return approved.ok ? json(200, approved.approval) : error(approved.status, approved.error);
    }
    // A fix from a run's notes: run its task again, optionally with a higher budget per job.
    if ((match = /^\/api\/runs\/([\w-]+)\/rerun$/.exec(path)) && method === "POST") {
      // A Viktor task has no bundle: run again evaluates it again, as Start again on Connections does.
      const job = await account.job(match[1]!);
      if (job?.kind === VIKTOR) {
        const denied = admin(); if (denied) return denied;
        const started = await startViktorTasks(client, { accountId: who.accountId, userId: who.userId, taskIds: [job.taskId.replace(/^viktor_/, "")] });
        return started.jobIds[0] ? json(201, { jobId: started.jobIds[0], taskId: job.taskId }) : error(409, started.refused ?? "This task cannot be evaluated now, or is being evaluated.");
      }
      // A Langfuse task reads its cases from Langfuse again: run again evaluates it through the connection.
      if (job?.kind === LANGFUSE) {
        const denied = admin(); if (denied) return denied;
        const started = await startLangfuseTasks(client, { accountId: who.accountId, userId: who.userId, taskIds: [job.taskId.replace(/^langfuse_/, "")] });
        return started.jobIds[0] ? json(201, { jobId: started.jobIds[0], taskId: job.taskId }) : error(409, started.refused ?? "This task cannot be evaluated now, or is being evaluated.");
      }
      const input = await body(request) ?? {};
      if (input.budgetUsd !== undefined && input.budgetUsd !== null && typeof input.budgetUsd !== "number") return error(400, "budgetUsd must be a number of US dollars.");
      const started = await rerunJob(client, { accountId: who.accountId, userId: who.userId, jobId: match[1]!, budgetUsd: typeof input.budgetUsd === "number" ? input.budgetUsd : null, trigger: "app" });
      return started.ok ? json(201, { jobId: started.jobId, taskId: started.taskId }) : error(/^No run /.test(started.error) ? 404 : 409, started.error);
    }
    if ((match = /^\/api\/runs\/([\w-]+)\/share$/.exec(path)) && method === "POST") {
      const secret = await account.share(match[1]!);
      if (!secret) return error(404, "This run has no report yet.");
      return json(200, { url: `${config.publicUrl}/api/share/${shareToken(who.accountId, secret)}.md` });
    }

    if (path === "/api/endpoints" && method === "GET") return json(200, await account.endpoints());
    if (path === "/api/endpoints" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const input = await body(request);
      if (!input) return error(400, "Send the endpoint as JSON: {kind, baseUrl, apiKey, allowedModels}.");
      const added = await account.addEndpoint({ kind: input.kind as EndpointKind, baseUrl: String(input.baseUrl ?? ""), apiKey: String(input.apiKey ?? ""), allowedModels: input.allowedModels as string[] | "all" });
      return added.ok ? json(201, added.endpoint) : error(400, added.error);
    }
    if ((match = /^\/api\/endpoints\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      return (await account.removeEndpoint(match[1]!)) ? json(200, { deleted: true }) : error(404, "No such endpoint.");
    }

    // App connections: Viktor, with an API key. Connecting checks the key's scopes and lists the tasks; an admin picks which to evaluate.
    if (path === "/api/connections/viktor" && method === "GET") return json(200, await currentViktorView(client, who.accountId, deps.auth));
    if (path === "/api/connections/viktor" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const input = await body(request);
      if (!input || typeof input.apiKey !== "string") return error(400, "Send the connection as JSON: {apiKey, creditCap}.");
      if (input.creditCap !== undefined && typeof input.creditCap !== "number") return error(400, "creditCap must be a number of Viktor credits.");
      const connected = await connectViktor(client, { accountId: who.accountId, userId: who.userId, apiKey: input.apiKey, ...(typeof input.creditCap === "number" ? { creditCap: input.creditCap } : {}) });
      return connected.ok ? json(201, connected.view) : error(connected.status, connected.error);
    }
    if (path === "/api/connections/viktor" && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      if (!(await account.removeConnection(VIKTOR))) return error(404, "Viktor is not connected.");
      await disarmRelist(client, who.accountId, VIKTOR);
      return json(200, { deleted: true });
    }
    if (path === "/api/connections/viktor/refresh" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      // Returns once the listing has started, or at once when one is running: the page polls `listing`.
      const { started } = await startRelist(client, who.accountId, VIKTOR);
      return json(202, { ...await viktorView(client, who.accountId, deps.auth), started });
    }
    // Someone opened a listed task's row, Viktor's or Langfuse's: it is no longer marked New.
    if ((match = /^\/api\/connections\/(viktor|langfuse)\/tasks\/([\w-]+)\/seen$/.exec(path)) && method === "POST") {
      return (await account.markSeen({ kind: match[1]!, taskId: match[2]! })) ? json(200, { seen: true }) : error(404, "No such task in this connection's listing.");
    }
    if ((match = /^\/api\/connections\/viktor\/tasks\/([\w-]+)\/start$/.exec(path)) && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const started = await startViktorTasks(client, { accountId: who.accountId, userId: who.userId, taskIds: [match[1]!] });
      return started.started.length ? json(201, { started: started.started, jobIds: started.jobIds }) : error(409, started.refused ?? "This task cannot be evaluated, or is being evaluated now.");
    }

    // Langfuse, with a Viewer key pair: connecting refuses a key that can write and lists the tasks; an admin picks which to evaluate.
    if (path === "/api/connections/langfuse" && method === "GET") return json(200, await langfuseView(client, who.accountId, deps.auth));
    if (path === "/api/connections/langfuse" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const input = await body(request);
      if (!input || typeof input.publicKey !== "string" || typeof input.secretKey !== "string" || (input.baseUrl !== undefined && typeof input.baseUrl !== "string")) return error(400, "Send the connection as JSON: {baseUrl, publicKey, secretKey}.");
      const connected = await connectLangfuse(client, { accountId: who.accountId, userId: who.userId, publicKey: input.publicKey, secretKey: input.secretKey, ...(typeof input.baseUrl === "string" ? { baseUrl: input.baseUrl } : {}) });
      return connected.ok ? json(201, connected.view) : error(connected.status, connected.error);
    }
    if (path === "/api/connections/langfuse" && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      if (!(await account.removeConnection(LANGFUSE))) return error(404, "Langfuse is not connected.");
      await disarmRelist(client, who.accountId, LANGFUSE);
      return json(200, { deleted: true });
    }
    if (path === "/api/connections/langfuse/refresh" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const { started } = await startRelist(client, who.accountId, LANGFUSE);
      return json(202, { ...await langfuseView(client, who.accountId, deps.auth), started });
    }
    if ((match = /^\/api\/connections\/langfuse\/tasks\/([\w-]+)\/start$/.exec(path)) && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const started = await startLangfuseTasks(client, { accountId: who.accountId, userId: who.userId, taskIds: [match[1]!] });
      return started.started.length ? json(201, { started: started.started, jobIds: started.jobIds }) : error(409, started.refused ?? "This task cannot be evaluated, or is being evaluated now.");
    }

    if (path === "/api/guardrails" && method === "GET") {
      const level = url.searchParams.get("level") as Level | null, id = url.searchParams.get("id") ?? "";
      if (!level || !LEVELS.includes(level) || !id) return error(400, "Pass level (environment, agent or task) and id (an environment name, environment:agent, or a task ID).");
      const settings = await account.guardrails({ level, scope: id });
      // The effective values at this level, with the level each came from.
      const task = level === "task" ? await account.task(id) : null;
      const split = id.indexOf(":");
      const environment = level === "agent" ? id.slice(0, split) : task?.environment ?? id;
      const agent = level === "agent" ? id.slice(split + 1) : task?.agent ?? null;
      if (level === "agent" && (split <= 0 || !agent)) return error(400, "An agent's id is environment:agent, such as acme/app:claims.");
      const effective = await account.resolveGuardrails({ environment, agent, ...(task ? { taskId: task.id } : {}) });
      return json(200, { level, id, settings, effective: effective.effective, from: effective.from, rejected: effective.rejected });
    }
    if (path === "/api/guardrails" && method === "PUT") {
      const input = await body(request);
      const level = input?.level as Level | undefined, id = typeof input?.id === "string" ? input.id : "";
      if (!level || !LEVELS.includes(level) || !id || !input?.settings || typeof input.settings !== "object") return error(400, "Send {level, id, settings}.");
      // Constraints protect the customer: only an admin sets the environment level, from which every constraint starts.
      if (level === "environment") { const denied = admin(); if (denied) return denied; }
      const saved = await account.setGuardrails({ level, scope: id, settings: input.settings as Guardrails });
      return json(200, saved);
    }

    if (path === "/api/spend" && method === "GET") return json(200, await account.spent());

    if (path === "/api/billing/checkout" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      if (!deps.billing) return error(503, "Billing is not configured on this server.");
      const info = await account.info();
      return json(200, await deps.billing.checkout({ accountId: who.accountId, customerId: info.plan?.customerId ?? null,
        // Stripe uses the email only for a new customer: an existing one keeps theirs.
        email: info.plan?.customerId || !deps.auth ? null : await deps.auth.email(who.userId), successUrl: `${config.appUrl}/plan/?checkout=done`, cancelUrl: `${config.appUrl}/plan/` }));
    }
    if (path === "/api/billing/portal" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      if (!deps.billing) return error(503, "Billing is not configured on this server.");
      const customerId = (await account.info()).plan?.customerId;
      if (!customerId) return error(409, "This account has no Stripe customer yet: subscribe first.");
      return json(200, await deps.billing.portal({ customerId, returnUrl: `${config.appUrl}/plan/` }));
    }

    if (path === "/api/account/export" && method === "POST") return json(200, await account.export(), { "content-disposition": `attachment; filename="openmerit-${who.accountId}.json"` });
    if (path === "/api/disconnect" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      await account.disconnect();
      return json(200, { disconnected: true });
    }
    if (path === "/api/account" && method === "DELETE") {
      const denied = admin() ?? reverify(who); if (denied) return denied;
      const [tasks, jobs] = await Promise.all([account.tasks(), account.jobs({ limit: 100_000 })]);
      await client.catalogue.getOrCreate(["global"]).unsubscribe({ accountId: who.accountId });
      for (const job of jobs) await (job.kind === VIKTOR ? client.viktorJob.get([job.id]) : client.job.get([job.id])).destroy().catch(() => null);
      for (const task of tasks) await client.task.get([who.accountId, task.id]).destroy().catch(() => null);
      await account.destroy();
      return json(200, { deleted: true, tasks: tasks.length, jobs: jobs.length });
    }
    return null;
  };

  return async (request: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    const report = /^\/api\/r\/([\w-]+)\.md$/.exec(path);
    const share = /^\/api\/share\/([\w-]+\.[\w-]+)\.md$/.exec(path);
    if (!path.startsWith("/api/") && !report) return null;
    const headers = cors(request, deps);
    const withCors = (response: Response) => { for (const [name, value] of Object.entries(headers)) response.headers.set(name, value); return response; };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" } });
    }
    if (share && request.method === "GET") {
      const parsed = parseShare(share[1]!);
      const found = parsed ? await client.account.getOrCreate([parsed.accountId]).report({ shareToken: parsed.secret }) : null;
      return found ? markdown(found.markdown) : new Response("No such report.\n", { status: 404 });
    }
    const auth = await authenticate(request, report !== null);
    if (!auth.ok) return withCors(error(auth.status, auth.error));
    if (report && request.method === "GET") {
      const found = await client.account.getOrCreate([auth.identity.accountId]).report({ jobId: report[1]! });
      return found ? markdown(found.markdown) : new Response("No such report in this account.\n", { status: 404 });
    }
    const response = await routes(request, url, auth.identity);
    return response ? withCors(response) : null;
  };
}

