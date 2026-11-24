// /api/* for app.openmerit.ai, and reports as Markdown for agents. Requests carry a Clerk session
// token; the account is the caller's active Clerk organization. Tasks, runs, endpoints, GitHub
// repositories and guardrails belong to a project, which the X-OpenMerit-Project header names (the
// default project without it); the plan, members and billing are the organization's. Changing endpoints, GitHub
// repositories, environment guardrails, billing and the account itself needs the organization's admin role.
import type { AppDeps } from "./app.ts";
import type { AuthResult, Identity } from "./auth.ts";
import { LEVELS, type Guardrails, type Level } from "./engine.ts";
import { explain, type JobResult } from "./report.ts";
import { bundleProblem, redactBundle, rerunJob, runTask, taskIdFor } from "./start.ts";
import { DEFAULT_PROJECT, specOf, type EvalSpec } from "./actors/account.ts";
import type { Case, TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { isSubscriptionProvider } from "./subscriptions.ts";
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

/** Why an edited eval cannot be saved, or null: its spec is checked as a bundle's, and each case needs an ID and string inputs. */
function evalProblem(bundle: TaskBundle, spec: unknown, cases: unknown): string | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "Send the eval's spec as an object.";
  const problem = bundleProblem({ ...bundle, ...specOf(spec as TaskBundle), examples: undefined });
  if (problem) return problem;
  if (!Array.isArray(cases) || !cases.length) return "An eval needs at least one case.";
  const ids = new Set<string>();
  for (const item of cases as unknown[]) {
    const value = item as Partial<Case> | null;
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim()) return "Each case needs an id.";
    if (ids.has(value.id)) return `Two cases have the id ${value.id}.`;
    ids.add(value.id);
    if (!value.input || typeof value.input !== "object" || !Object.values(value.input).every(field => typeof field === "string")) return `Case ${value.id} needs an input object of strings.`;
    if (!["example", "written", "trace"].includes(String(value.origin))) return `Case ${value.id} needs an origin: example, written or trace.`;
  }
  return JSON.stringify(cases).length > 1024 * 1024 ? "The cases are larger than 1 MB." : null;
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

    if (path === "/api/projects" && method === "GET") return json(200, await account.projects());
    if (path === "/api/projects" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const created = await account.createProject({ name: String((await body(request))?.name ?? "") });
      return created.ok ? json(201, created.project) : error(400, created.error);
    }
    if ((match = /^\/api\/projects\/([\w-]+)$/.exec(path)) && method === "PUT") {
      const denied = admin(); if (denied) return denied;
      const renamed = await account.renameProject({ id: match[1]!, name: String((await body(request))?.name ?? "") });
      return renamed.ok ? json(200, renamed.project) : error(renamed.status, renamed.error);
    }
    if ((match = /^\/api\/projects\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      const deleted = await account.deleteProject(match[1]!);
      return deleted.ok ? json(200, { deleted: true }) : error(deleted.status, deleted.error);
    }

    // The member's own Claude and ChatGPT subscriptions, which write the cases of the runs they start. They are the user's, in every organization.
    if (path.startsWith("/api/me/")) {
      const mine = client.user.getOrCreate([who.userId]);
      if (!config.keyEncryptionKey && method !== "GET") return error(503, "Subscriptions are not available yet: the app has no key-encryption key.");
      if (path === "/api/me/subscriptions" && method === "GET") return json(200, await mine.subscriptions());
      if (path === "/api/me/subscriptions/claude" && method === "POST") return json(200, await mine.startClaude());
      if (path === "/api/me/subscriptions/claude/code" && method === "POST") {
        const code = (await body(request))?.code;
        if (typeof code !== "string" || !code.trim()) return error(400, "Send {code}: the code Anthropic shows after you sign in.");
        const finished = await mine.finishClaude(code);
        return finished.ok ? json(200, finished.view) : error(400, finished.error);
      }
      if (path === "/api/me/subscriptions/chatgpt" && method === "POST") {
        const started = await mine.startChatgpt();
        return started.ok ? json(200, started.view) : error(502, started.error);
      }
      if (path === "/api/me/subscriptions/chatgpt/poll" && method === "POST") {
        const polled = await mine.pollChatgpt();
        return polled.status === "failed" ? json(400, { error: polled.error, ...polled.view }) : json(200, { status: polled.status, ...polled.view });
      }
      if ((match = /^\/api\/me\/subscriptions\/([\w-]+)$/.exec(path)) && method === "DELETE") {
        if (!isSubscriptionProvider(match[1])) return error(404, "No such subscription: claude or chatgpt.");
        return json(200, await mine.disconnect(match[1]));
      }
      if (path === "/api/me/case-writer" && method === "PUT") {
        const writer = (await body(request))?.writer;
        if (writer !== "openmerit" && !isSubscriptionProvider(writer)) return error(400, "Send {writer}: openmerit, claude or chatgpt.");
        const saved = await mine.setWriter(writer);
        return saved.ok ? json(200, saved.view) : error(409, saved.error);
      }
      return null;
    }

    // The project the rest of the routes work in.
    const projectId = request.headers.get("x-openmerit-project")?.trim() || DEFAULT_PROJECT;
    const project = await account.project(projectId);
    if (!project) return error(404, "No such project in this account. Choose another project.");

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

    if (path === "/api/tasks" && method === "GET") {
      const [tasks, decisions] = await Promise.all([account.tasks(projectId), account.taskDecisions()]);
      return json(200, tasks.map(task => ({ ...task, decision: decisions[task.id] ?? null })));
    }
    if (path === "/api/tasks/deleted" && method === "GET") return json(200, await account.deletions(projectId));
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
    // A task's eval: the cloud keeps every version, the app edits it, and the coding agent writes the latest to the repository.
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval$/.exec(path)) && method === "GET") {
      const view = await account.eval(match[1]!);
      return view ? json(200, view) : error(404, "No such task in this account.");
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval$/.exec(path)) && method === "PUT") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const input = await body(request);
      const bundle = (await client.task.get([who.accountId, row.id]).info()).bundle;
      if (!input || !bundle) return error(400, "Send {spec, cases, baseVersion}.");
      const problem = evalProblem(bundle, input.spec, input.cases);
      if (problem) return error(400, problem);
      const saved = await account.saveEval({
        taskId: row.id, projectId: row.projectId, spec: redactBundle(specOf(input.spec as TaskBundle)), cases: redactBundle(input.cases as Case[]), source: "app", author: who.userId,
        note: typeof input.note === "string" ? input.note.slice(0, 500) : null, baseVersion: typeof input.baseVersion === "number" ? input.baseVersion : null,
      });
      if (!saved.ok) return error(409, saved.error);
      return json(200, await account.eval(row.id));
    }
    // A task approved from a review has not run: this starts its first run. Any task can run again from here.
    if ((match = /^\/api\/tasks\/([\w-]+)\/run$/.exec(path)) && method === "POST") {
      const started = await runTask(client, { accountId: who.accountId, userId: who.userId, taskId: match[1]!, trigger: "app" });
      return started.ok ? json(201, { jobId: started.jobId, taskId: started.taskId }) : error(409, started.error);
    }
    // Retire instead of delete: the task stops watching and keeps its eval and runs. The next recommend call brings it back.
    if ((match = /^\/api\/tasks\/([\w-]+)\/retire$/.exec(path)) && method === "POST") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      await client.task.getOrCreate([who.accountId, row.id], { createWithInput: { accountId: who.accountId, taskId: row.id, projectId: row.projectId, environment: row.environment, name: row.name } }).retire();
      return json(200, await account.task(row.id));
    }

    // Drafts a repository review wrote, until a person approves (creating the task) or dismisses each.
    if (path === "/api/eval-drafts" && method === "GET") return json(200, await account.evalDrafts({ projectId, status: "pending" }));
    if ((match = /^\/api\/eval-drafts\/([\w-]+)\/approve$/.exec(path)) && method === "POST") {
      const draft = (await account.evalDrafts({ projectId })).find(item => item.id === match![1]);
      if (!draft) return error(404, "No such draft in this project.");
      const input = await body(request) ?? {};
      // The reviewer may edit the draft as they approve it.
      const spec = (input.spec ?? specOf(draft.bundle)) as EvalSpec, cases = (input.cases ?? draft.cases) as Case[];
      const problem = evalProblem(draft.bundle, spec, cases);
      if (problem) return error(400, problem);
      const bundle = redactBundle({ ...draft.bundle, ...specOf(spec as TaskBundle) });
      const taskId = taskIdFor(projectId, draft.environment, bundle.task);
      const approved = await account.approveDraft({ id: draft.id, taskId, userId: who.userId, bundle, cases: redactBundle(cases) });
      if (!approved.ok) return error(approved.status, approved.error);
      await client.task.getOrCreate([who.accountId, taskId], { createWithInput: { accountId: who.accountId, taskId, projectId, environment: draft.environment, name: bundle.task } }).prepare(bundle);
      return json(201, { taskId, eval: await account.eval(taskId) });
    }
    if ((match = /^\/api\/eval-drafts\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      return (await account.dismissDraft({ id: match[1]!, userId: who.userId })) ? json(200, { dismissed: true }) : error(404, "No such pending draft.");
    }

    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "GET") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const info = await client.task.get([who.accountId, row.id]).info();
      const evaluation = await account.eval(row.id);
      const latest = evaluation?.latest;
      return json(200, { ...row, eval: latest ? { version: latest.version, cases: latest.cases.length, repo: evaluation.repo } : null, bundle: info.bundle, lastResult: info.lastResult, notices: info.notices, jobs: await account.jobs({ taskId: row.id, limit: 20 }), guardrails: await account.resolveGuardrails({ projectId: row.projectId, environment: row.environment, agent: row.agent, taskId: row.id }) });
    }

    if (path === "/api/runs" && method === "GET") return json(200, await account.jobs({ projectId, limit: Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50) }));
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const jobId = match[1]!;
      const row = await account.job(jobId);
      if (!row) return error(404, "No such run in this account.");
      const report = await account.report({ jobId });
      // The saved report, with the same reason and cheaperThanCurrent the coding agent gets, and the decision the coding agent sent back.
      if (report) return json(200, { ...(report.json as JobResult), ...explain(report.json as JobResult), decision: await account.decision(jobId) });
      return json(200, { ...await client.job.get([jobId]).status(), report: null });
    }
    // A fix from a run's notes: run its task again, optionally with a higher budget per job.
    if ((match = /^\/api\/runs\/([\w-]+)\/rerun$/.exec(path)) && method === "POST") {
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

    if (path === "/api/endpoints" && method === "GET") return json(200, await account.endpoints(projectId));
    if (path === "/api/endpoints" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const input = await body(request);
      if (!input) return error(400, "Send the endpoint as JSON: {kind, baseUrl, apiKey, allowedModels}.");
      const added = await account.addEndpoint({ projectId, kind: input.kind as EndpointKind, baseUrl: String(input.baseUrl ?? ""), apiKey: String(input.apiKey ?? ""), allowedModels: input.allowedModels as string[] | "all" });
      return added.ok ? json(201, added.endpoint) : error(400, added.error);
    }
    if ((match = /^\/api\/endpoints\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      return (await account.removeEndpoint({ projectId, id: match[1]! })) ? json(200, { deleted: true }) : error(404, "No such endpoint.");
    }

    // GitHub repositories OpenMerit reviews, read-only: a public one by its URL, a private one with a fine-grained token.
    if (path === "/api/repos" && method === "GET") return json(200, await account.repos(projectId));
    if (path === "/api/repos" && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const input = await body(request);
      if (!input) return error(400, "Send the repository as JSON: {url, token}. The token is only for a private repository.");
      const added = await account.addRepo({ projectId, url: String(input.url ?? ""), token: typeof input.token === "string" ? input.token : null });
      return added.ok ? json(201, added.repo) : error(400, added.error);
    }
    if ((match = /^\/api\/repos\/([\w-]+)\/review$/.exec(path)) && method === "POST") {
      const denied = admin(); if (denied) return denied;
      const started = await account.reviewRepo({ projectId, id: match[1]! });
      return started.ok ? json(202, started.repo) : error(started.status, started.error);
    }
    if ((match = /^\/api\/repos\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin(); if (denied) return denied;
      return (await account.removeRepo({ projectId, id: match[1]! })) ? json(200, { deleted: true }) : error(404, "No such repository.");
    }

    if (path === "/api/guardrails" && method === "GET") {
      const level = url.searchParams.get("level") as Level | null, id = url.searchParams.get("id") ?? "";
      if (!level || !LEVELS.includes(level) || !id) return error(400, "Pass level (environment, agent or task) and id (an environment name, environment:agent, or a task ID).");
      // A task's guardrails are its project's, whichever project the app has open.
      const task = level === "task" ? await account.task(id) : null;
      const scopeProject = task?.projectId ?? projectId;
      const settings = await account.guardrails({ projectId: scopeProject, level, scope: id });
      // The effective values at this level, with the level each came from.
      const split = id.indexOf(":");
      const environment = level === "agent" ? id.slice(0, split) : task?.environment ?? id;
      const agent = level === "agent" ? id.slice(split + 1) : task?.agent ?? null;
      if (level === "agent" && (split <= 0 || !agent)) return error(400, "An agent's id is environment:agent, such as acme/app:claims.");
      const effective = await account.resolveGuardrails({ projectId: scopeProject, environment, agent, ...(task ? { taskId: task.id } : {}) });
      return json(200, { level, id, settings, effective: effective.effective, from: effective.from, rejected: effective.rejected });
    }
    if (path === "/api/guardrails" && method === "PUT") {
      const input = await body(request);
      const level = input?.level as Level | undefined, id = typeof input?.id === "string" ? input.id : "";
      if (!level || !LEVELS.includes(level) || !id || !input?.settings || typeof input.settings !== "object") return error(400, "Send {level, id, settings}.");
      // Constraints protect the customer: only an admin sets the environment level, from which every constraint starts.
      if (level === "environment") { const denied = admin(); if (denied) return denied; }
      const task = level === "task" ? await account.task(id) : null;
      const saved = await account.setGuardrails({ projectId: task?.projectId ?? projectId, level, scope: id, settings: input.settings as Guardrails });
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
      for (const job of jobs) await client.job.get([job.id]).destroy().catch(() => null);
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
      return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-allow-headers": "authorization, content-type, x-openmerit-project", "access-control-max-age": "600" } });
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

