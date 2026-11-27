// /api/* for app.openmerit.ai, and reports as Markdown for agents. Requests carry a Clerk session
// token; the account is the caller's active Clerk organization, which holds its tasks, runs, endpoints,
// guardrails, plan and members. Changing endpoints, environment guardrails, billing and the account itself
// needs the organization's admin role.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { specOf, type EvalCommandSpec } from "../job/workflow.ts";
import type { AppDeps } from "./app.ts";
import type { AuthResult, Identity } from "./auth.ts";
import { confirmUrl } from "./config.ts";
import { LEVELS, type Guardrails, type Level } from "./engine.ts";
import { explain, type JobResult } from "../job/report.ts";
import { bundleProblem, redactBundle, rerunJob, runTask, settleOrphans } from "./start.ts";
import type { ConfirmationView, EvalSpec, EvalView } from "./actors/account.ts";
import { OPENROUTER } from "../job/pool.ts";
import type { Answers } from "./actors/job.ts";
import type { Case, TaskBundle } from "../ranking/index.ts";
import { isSubscriptionProvider } from "./subscriptions.ts";
import type { EndpointKind } from "../ranking/index.ts";

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

/**
 * A public report link carries its account sealed with the key-encryption key (AES-256-GCM), so the
 * app finds the report without a global index, the link does not show the organization's ID, and a
 * forged link opens no account actor.
 */
function shareToken(key: Buffer, accountId: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("share"));
  const body = Buffer.concat([cipher.update(accountId, "utf8"), cipher.final()]);
  return `${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}.${secret}`;
}
function parseShare(key: Buffer | null, token: string): { accountId: string; secret: string } | null {
  const [sealed, secret] = token.split(".");
  if (!key || !sealed || !secret) return null;
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length <= 28) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from("share"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return { accountId: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"), secret };
  } catch { return null; }
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

/**
 * A task's eval command as the coding agent sent it (`command`, `root`, `cwd`, `env`, `threshold`, `timeoutSeconds`),
 * checked: root is an existing absolute directory on this server's machine, and env names are variable names.
 */
export function evalCommandSpec(input: Json | null): { ok: true; spec: EvalCommandSpec } | { ok: false; error: string } {
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  if (!command || command.length > 4000) return { ok: false, error: "Send the eval command as a string of at most 4,000 characters, such as \"node evals/classify.mjs\"." };
  const root = typeof input?.root === "string" ? input.root : "";
  if (!isAbsolute(root)) return { ok: false, error: "Send root, the repository's absolute path on this machine." };
  try { if (!statSync(root).isDirectory()) return { ok: false, error: `${root} is not a directory.` }; } catch { return { ok: false, error: `${root} does not exist on the machine this server runs on.` }; }
  const cwd = input?.cwd === undefined || input.cwd === null ? undefined : String(input.cwd);
  if (cwd !== undefined && (isAbsolute(cwd) || cwd.split(/[\\/]/).includes(".."))) return { ok: false, error: "cwd is a directory inside root, relative to it." };
  const env = input?.env ?? undefined;
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env) || !Object.entries(env).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string"))) return { ok: false, error: "env maps variable names to strings." };
  const threshold = input?.threshold ?? null;
  if (threshold !== null && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) return { ok: false, error: "threshold is the eval's minimum pass rate, from 0 to 1, or null." };
  const seconds = input?.timeoutSeconds ?? null;
  if (seconds !== null && (typeof seconds !== "number" || seconds < 10 || seconds > 7200)) return { ok: false, error: "timeoutSeconds is from 10 to 7,200." };
  return { ok: true, spec: { command, root, ...(cwd ? { cwd } : {}), ...(env ? { env: env as Record<string, string> } : {}), threshold: threshold as number | null, ...(seconds ? { timeoutMs: seconds * 1000 } : {}) } };
}
export const HOSTED_EVAL_COMMAND = "Measuring with your own eval command runs on a self-hosted OpenMerit server for now (OPENMERIT_MODE=self-hosted); the hosted app cannot run commands on your machine yet.";

/** Guardrails that spend money: setting one is a critical action. */
const MONEY_GUARDRAILS = ["budgetUsd", "spendCapUsd", "customerSpendCapUsd"];
/** What the coding agent or a self-hosted client gets back for a critical request held for a person. */
export function heldReply(config: AppDeps["config"], view: ConfirmationView) {
  const url = confirmUrl(config, view.id);
  return {
    status: "needs_confirmation", confirmation: { id: view.id, url, title: view.title, expiresAt: view.expiresAt },
    text: `${view.title}: this needs a person's confirmation, which a coding agent cannot give. Ask the user to open ${url} and confirm it before ${view.expiresAt.slice(0, 16).replace("T", " ")} UTC.`,
  };
}

export function apiRoutes(deps: AppDeps) {
  const { client, config } = deps;
  /** Re-verification is Clerk's: on a self-hosted server, the browser session the sign-in link opened is enough. */
  const recent = (who: Identity) => config.mode === "hosted" ? reverify(who) : null;

  const authenticate = async (request: Request, agentsToo = false): Promise<AuthResult> => {
    if (!deps.auth) return { ok: false, status: 401, error: "Sign-in is not configured on this server." };
    const session = await deps.auth.api(request);
    if (session.ok || !agentsToo) return session;
    // Agents read reports with the MCP access token they already hold.
    return deps.auth.mcp(request);
  };

  /**
   * `confirmed`: a person confirmed this request on a confirm page, so a critical route runs it. Otherwise a
   * critical route holds a self-hosted caller's request for a person, since the server's one token is also the
   * coding agent's. Hosted, /api takes only the web app's Clerk sessions, which are a person's.
   */
  const routes = async (request: Request, url: URL, who: Identity, confirmed = false): Promise<Response | null> => {
    const path = url.pathname;
    const method = request.method;
    const account = client.account.getOrCreate([who.accountId]);
    await account.touch({ userId: who.userId, role: who.role, name: who.accountName });
    const admin = () => who.role === "admin" ? null : error(403, "Only an organization admin can do this.");
    let match: RegExpExecArray | null;
    // A task's eval with the names of the people its by fields name, which the app shows in place of Clerk user IDs.
    const evalOf = async (taskId: string): Promise<EvalView | null> => {
      const view = await account.eval(taskId);
      if (!view) return null;
      const names = new Map<string, Promise<string | null>>();
      const nameOf = (id: string | null | undefined) => {
        if (!id) return Promise.resolve(null);
        if (!names.has(id)) names.set(id, (deps.auth?.person(id) ?? Promise.resolve(null)).then(person => person?.name ?? person?.email ?? null).catch(() => null));
        return names.get(id)!;
      };
      const [accepted, draft] = await Promise.all([nameOf(view.accepted?.by), nameOf(view.draft?.by)]);
      return { ...view, accepted: view.accepted && { ...view.accepted, byName: accepted }, draft: view.draft && { ...view.draft, byName: draft } };
    };

    // The member's own ChatGPT subscription, which write the cases of the runs they start. They are the user's, in every organization.
    if (path.startsWith("/api/me/")) {
      const mine = client.user.getOrCreate([who.userId]);
      if (!config.keyEncryptionKey && method !== "GET") return error(503, "Subscriptions are not available yet: the app has no key-encryption key.");
      if (path === "/api/me/subscriptions" && method === "GET") return json(200, await mine.subscriptions());
      if (path === "/api/me/subscriptions/chatgpt" && method === "POST") {
        const started = await mine.startChatgpt();
        return started.ok ? json(200, started.view) : error(502, started.error);
      }
      if (path === "/api/me/subscriptions/chatgpt/poll" && method === "POST") {
        const polled = await mine.pollChatgpt();
        return polled.status === "failed" ? json(400, { error: polled.error, ...polled.view }) : json(200, { status: polled.status, ...polled.view });
      }
      if ((match = /^\/api\/me\/subscriptions\/([\w-]+)$/.exec(path)) && method === "DELETE") {
        if (!isSubscriptionProvider(match[1])) return error(404, "No such subscription: chatgpt.");
        return json(200, await mine.disconnect(match[1]));
      }
      if (path === "/api/me/case-writer" && method === "PUT") {
        const writer = (await body(request))?.writer;
        if (writer !== "openmerit" && !isSubscriptionProvider(writer)) return error(400, "Send {writer}: openmerit or chatgpt.");
        const saved = await mine.setWriter(writer);
        return saved.ok ? json(200, saved.view) : error(409, saved.error);
      }
      return null;
    }

    // A coding agent's critical request, for a person to read and confirm or decline. Confirming runs it as the person.
    if ((match = /^\/api\/confirmations\/([\w-]+)$/.exec(path)) && method === "GET") {
      const found = await account.confirmation(match[1]!);
      if (!found) return error(404, "No such confirmation in this organization. It may belong to another organization: switch to the one the coding agent works in.");
      const { nonce: _nonce, ...view } = found;
      return json(200, view);
    }
    if ((match = /^\/api\/confirmations\/([\w-]+)$/.exec(path)) && method === "POST") {
      // A person confirms, signed in to the web app: never a coding agent's or a script's token.
      if (!who.person) return error(403, `A person confirms this, signed in to the web app at ${confirmUrl(config, match[1]!)}, not with a token.`);
      const input = await body(request);
      if (typeof input?.confirm !== "boolean") return error(400, "Send {confirm: true} to confirm or {confirm: false} to decline.");
      const found = await account.confirmation(match[1]!);
      if (!found) return error(404, "No such confirmation in this organization.");
      if (input.confirm && found.checks === "reverify") { const denied = recent(who); if (denied) return denied; }
      const decided = await decideConfirmation(who, found.id, input.confirm, url.origin);
      return decided.ok ? json(200, decided.view) : error(409, decided.error);
    }

    /** Holds a critical request for a person, or null to run it: it was confirmed, or a person sent it from the web app. */
    const hold = async (title: string, items: string[], input: Json | null, checks: "person" | "reverify" = "person"): Promise<Response | null> => {
      if (confirmed || who.person) return null;
      const view = await account.requestConfirmation({ method, path, body: input ? JSON.stringify(input) : "", checks, title, items, requestedBy: who.userId, requestedVia: null });
      return json(202, heldReply(config, view));
    };

    if (path === "/api/me" && method === "GET") {
      const info = await account.info();
      const plan = info.plan;
      return json(200, {
        mode: deps.config.mode, user: { id: who.userId }, account: { id: info.id, name: info.name ?? who.accountName }, role: who.role,
        plan: plan
          ? { name: plan.name, status: plan.status, periodEnd: plan.periodEnd ? new Date(plan.periodEnd * 1000).toISOString() : null, includedEvals: plan.includedEvals, usedEvals: plan.usedEvals }
          : { name: null, status: "none", periodEnd: null, includedEvals: 0, usedEvals: 0 },
      });
    }

    if (path === "/api/tasks" && method === "GET") {
      const [tasks, decisions] = await Promise.all([account.tasks(), account.taskDecisions()]);
      return json(200, tasks.map(task => ({ ...task, decision: decisions[task.id] ?? null })));
    }
    if (path === "/api/tasks/deleted" && method === "GET") return json(200, await account.deletions());
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin() ?? recent(who); if (denied) return denied;
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const held = await hold(`Delete the task ${row.name}`, [`${row.environment}: its eval, every run and run page`], null, "reverify"); if (held) return held;
      // A job whose start failed has no actor and never finishes: it is not a run in progress.
      await settleOrphans(client, who.accountId, row.id);
      const jobs = await account.jobs({ taskId: row.id, limit: 100_000 });
      // A job that is computing would write its result back after the delete; one that waits for answers can go.
      if (jobs.some(job => job.status === "queued" || job.status === "running")) return error(409, "This task has a run in progress. Delete it when the run finishes.");
      // The task first, so the catalogue stops telling it; then its jobs, which hold its bundle and cases; then its rows.
      await client.task.get([who.accountId, row.id]).destroy().catch(() => null);
      for (const job of jobs) await client.job.get([job.id]).destroy().catch(() => null);
      const deleted = await account.deleteTask({ taskId: row.id, userId: who.userId });
      return json(200, { deleted: true, jobs: deleted.jobs });
    }
    // A task's eval: the accepted one runs unchanged; a draft is reviewed in the app, saved in place and accepted as the next version.
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval$/.exec(path)) && method === "GET") {
      const view = await evalOf(match[1]!);
      return view ? json(200, view) : error(404, "No such task in this account.");
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval\/(revise|draft|accept)$/.exec(path)) && (method === "POST" || method === "PUT" || method === "DELETE")) {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const action = `${method} ${match[2]!}`;
      if (action === "POST revise") return (await account.reviseEval({ taskId: row.id, by: who.userId })) ? json(200, await evalOf(row.id)) : error(409, "This eval has no accepted version, or a draft is open already.");
      if (action === "DELETE draft") {
        const discarded = await account.discardEvalDraft(row.id);
        return discarded.ok ? json(200, await evalOf(row.id)) : error(409, discarded.error);
      }
      if (action !== "PUT draft" && action !== "POST accept") return error(405, "Use POST revise, PUT draft, DELETE draft or POST accept.");
      const view = await evalOf(row.id);
      const input = await body(request);
      const bundle = (await client.task.get([who.accountId, row.id]).info()).bundle;
      if (!view?.draft || !bundle) return error(409, "This eval has no draft. Choose Revise eval first.");
      // A changed task's draft is checked against its new output shape.
      const target = view.draft.output ? { ...bundle, output: view.draft.output } : bundle;
      const spec = (input?.spec ?? view.draft.spec) as EvalSpec, cases = (input?.cases ?? view.draft.cases) as Case[];
      const problem = evalProblem(target, spec, cases);
      if (problem) return error(400, problem);
      const edit = { taskId: row.id, spec: redactBundle(specOf(spec as TaskBundle)), cases: redactBundle(cases), by: who.userId, base: typeof input?.base === "string" ? input.base : null };
      if (action === "PUT draft") {
        const saved = await account.saveEvalDraft(edit);
        return saved.ok ? json(200, await evalOf(row.id)) : error(saved.status, saved.error);
      }
      const accepted = await account.acceptEval(edit);
      if (!accepted.ok) return error(accepted.status, accepted.error);
      // The changed task's bundle becomes the one its runs and watch use.
      if (accepted.bundle) await client.task.get([who.accountId, row.id]).prepare(accepted.bundle);
      return json(200, await evalOf(row.id));
    }
    // A task approved from a review has not run: this starts its first run. Any task can run again from here.
    if ((match = /^\/api\/tasks\/([\w-]+)\/run$/.exec(path)) && method === "POST") {
      const input = await body(request) ?? {};
      if (input.budgetUsd !== undefined && input.budgetUsd !== null && typeof input.budgetUsd !== "number") return error(400, "budgetUsd must be a number of US dollars.");
      const budgetUsd = typeof input.budgetUsd === "number" ? input.budgetUsd : null;
      if (budgetUsd !== null) {
        const row = await account.task(match[1]!);
        if (!row) return error(404, "No such task in this account.");
        const held = await hold(`Run ${row.name} with a budget of $${budgetUsd} per job`, [`Raises the task's budget per job to $${budgetUsd}, then starts a paid run`], input, "reverify"); if (held) return held;
      }
      const started = await runTask(client, { accountId: who.accountId, userId: who.userId, taskId: match[1]!, budgetUsd, trigger: confirmed ? "mcp" : "app" });
      return started.ok ? json(201, { jobId: started.jobId, taskId: started.taskId }) : error(409, started.error);
    }
    // The task's own eval command: a self-hosted server runs it to measure each model. Setting it runs a shell command on this machine, so a person confirms it.
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval-command$/.exec(path)) && (method === "GET" || method === "PUT" || method === "DELETE")) {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      if (method === "GET") return json(200, { evalCommand: await account.evalCommandFor(row.id) });
      if (config.mode === "hosted") return error(409, HOSTED_EVAL_COMMAND);
      if (method === "DELETE") {
        const held = await hold(`Stop measuring ${row.name} with its eval command`, ["Its next run measures on OpenMerit's own cases"], null); if (held) return held;
        await account.setEvalCommand({ taskId: row.id, spec: null, by: who.userId });
        return json(200, { evalCommand: null });
      }
      const input = await body(request);
      const checked = evalCommandSpec(input);
      if (!checked.ok) return error(400, checked.error);
      const { spec } = checked;
      const held = await hold(`Measure ${row.name} by running a command on this machine`, [`Command: ${spec.command}`, `In: ${spec.cwd ? `${spec.root}/${spec.cwd}` : spec.root}`, ...(spec.env ? [`Environment: ${Object.entries(spec.env).map(([name, value]) => `${name}=${value}`).join(", ")}`] : []), `It runs once per model measured, with its model calls through OpenMerit's proxy${spec.threshold != null ? `; models need a pass rate of at least ${spec.threshold}` : ""}`], input); if (held) return held;
      await account.setEvalCommand({ taskId: row.id, spec, by: who.userId });
      return json(200, { evalCommand: spec });
    }
    // Retire instead of delete: the task stops watching and keeps its eval and runs. The next recommend call brings it back.
    if ((match = /^\/api\/tasks\/([\w-]+)\/retire$/.exec(path)) && method === "POST") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      await client.task.getOrCreate([who.accountId, row.id], { createWithInput: { accountId: who.accountId, taskId: row.id, environment: row.environment, name: row.name } }).retire();
      return json(200, await account.task(row.id));
    }

    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "GET") {
      const row = await account.task(match[1]!);
      if (!row) return error(404, "No such task in this account.");
      const info = await client.task.get([who.accountId, row.id]).info();
      const evaluation = await evalOf(row.id);
      const latest = evaluation?.accepted;
      return json(200, { ...row, eval: latest ? { version: latest.version, cases: latest.cases.length, review: evaluation.draft?.reason ?? null } : null, bundle: info.bundle, lastResult: info.lastResult, notices: info.notices, jobs: await account.jobs({ taskId: row.id, limit: 20 }), guardrails: await account.resolveGuardrails({ environment: row.environment, agent: row.agent, taskId: row.id }) });
    }

    if (path === "/api/runs" && method === "GET") return json(200, await account.jobs({ limit: Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50) }));
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const jobId = match[1]!;
      const row = await account.job(jobId);
      if (!row) return error(404, "No such run in this account.");
      const report = await account.report({ jobId });
      // The saved report, with the same reason and cheaperThanCurrent the coding agent gets, and the decision the coding agent sent back.
      if (report) return json(200, { ...(report.json as JobResult), ...explain(report.json as JobResult), decision: await account.decision(jobId) });
      return json(200, { ...await client.job.get([jobId]).status(), report: null });
    }
    // Answers to a running job's questions, such as a member's grades in the grading loop ({"grade_<task>_r1_1": "bad: <why>"}).
    if ((match = /^\/api\/runs\/([\w-]+)\/answers$/.exec(path)) && method === "POST") {
      const jobId = match[1]!;
      if (!await account.job(jobId)) return error(404, "No such run in this account.");
      const input = await body(request);
      const answers = input?.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return error(400, "Send the answers as JSON: {answers: {<question id>: <answer>}}.");
      const handle = client.job.get([jobId]);
      const view = await handle.status();
      if (!view.questions.length) return error(409, "This run has no open questions.");
      // Grades are a person's judgment of the answers: the coding agent relays them, and the person confirms them.
      const grades = view.questions.filter(question => question.id.startsWith("grade_") && Object.hasOwn(answers, question.id));
      if (grades.length) {
        const held = await hold(`Grades for ${view.task}`, grades.map(question => `${question.prompt.replace(/: does it look right\?$/, "")}: ${String((answers as Answers)[question.id])}`), input); if (held) return held;
      }
      await handle.send("answers", { answers: answers as Answers, by: who.userId });
      // The job applies them in a moment: answer with its state once it has, or as it stands after a few seconds.
      let next = view;
      for (let waited = 0; waited < 5000 && next.updatedAt === view.updatedAt; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
        next = await handle.status();
      }
      return json(200, next);
    }
    // A fix from a run's notes: run its task again, optionally with a higher budget per job.
    if ((match = /^\/api\/runs\/([\w-]+)\/rerun$/.exec(path)) && method === "POST") {
      const input = await body(request) ?? {};
      if (input.budgetUsd !== undefined && input.budgetUsd !== null && typeof input.budgetUsd !== "number") return error(400, "budgetUsd must be a number of US dollars.");
      if (typeof input.budgetUsd === "number") {
        const row = await account.job(match[1]!);
        if (!row) return error(404, `No run ${match[1]!} in this account.`);
        const task = await account.task(row.taskId);
        const held = await hold(`Run ${task?.name ?? "the task"} again with a budget of $${input.budgetUsd} per job`, [`Raises the task's budget per job to $${input.budgetUsd}, then starts a paid run`], input, "reverify"); if (held) return held;
      }
      const started = await rerunJob(client, { accountId: who.accountId, userId: who.userId, jobId: match[1]!, budgetUsd: typeof input.budgetUsd === "number" ? input.budgetUsd : null, trigger: confirmed ? "mcp" : "app" });
      return started.ok ? json(201, { jobId: started.jobId, taskId: started.taskId }) : error(/^No run /.test(started.error) ? 404 : 409, started.error);
    }
    // The person's decision on a finished run's change: recorded once, and an approval moves the task onto the pick.
    if ((match = /^\/api\/runs\/([\w-]+)\/decision$/.exec(path)) && method === "POST") {
      const row = await account.job(match[1]!);
      if (!row) return error(404, "No such run in this account.");
      const input = await body(request);
      if (typeof input?.approved !== "boolean") return error(400, "Send {approved: true} once the edit is applied, or {approved: false} to decline it.");
      const view = await client.job.get([row.id]).status();
      const result = view.result, pick = result?.pick;
      if (!result?.approval || !pick) return error(409, "This run proposes no change to decide on.");
      const change = `${result.baseline?.model ?? view.task} → ${pick.model} (${pick.endpoint})`;
      const held = await hold(`${input.approved ? "Approve" : "Decline"} the switch for ${view.task}`, [change, ...result.edit.edits.map(edit => `${edit.file}:${edit.line}: ${edit.before} → ${edit.after}`)], input); if (held) return held;
      const person = await deps.auth?.person(who.userId).catch(() => null) ?? null;
      const { recorded, decision } = await account.decide({ jobId: row.id, taskId: view.taskId, decision: input.approved ? "approved" : "declined", change, by: who.userId, name: person?.name ?? null, email: person?.email ?? null });
      if (!recorded) return json(409, { error: "The decision on this run was already recorded.", decision });
      if (decision.decision === "approved") await client.task.get([who.accountId, view.taskId]).adopt({ model: pick.endpoint === OPENROUTER ? pick.model : pick.endpointModel, endpoint: pick.endpoint === OPENROUTER ? null : pick.endpoint, edits: result.edit.edits });
      return json(200, { decision, model: pick.model });
    }
    if ((match = /^\/api\/runs\/([\w-]+)\/share$/.exec(path)) && method === "POST") {
      if (!config.keyEncryptionKey) return error(503, "Share links are not available yet: the app has no key-encryption key.");
      const secret = await account.share(match[1]!);
      if (!secret) return error(404, "This run has no report yet.");
      return json(200, { url: `${config.publicUrl}/api/share/${shareToken(config.keyEncryptionKey, who.accountId, secret)}.md` });
    }

    if (path === "/api/endpoints" && method === "GET") return json(200, await account.endpoints());
    if (path === "/api/endpoints" && method === "POST") {
      const denied = admin() ?? recent(who); if (denied) return denied;
      const input = await body(request);
      if (!input) return error(400, "Send the endpoint as JSON: {kind, baseUrl, apiKey, allowedModels}.");
      const held = await hold(`Add the endpoint ${String(input.baseUrl ?? "")}`, [`A ${String(input.kind ?? "")} endpoint with the key ending ${String(input.apiKey ?? "").slice(-4)}`, `Models: ${Array.isArray(input.allowedModels) ? input.allowedModels.join(", ") : "all"}`], input, "reverify"); if (held) return held;
      const added = await account.addEndpoint({ kind: input.kind as EndpointKind, baseUrl: String(input.baseUrl ?? ""), apiKey: String(input.apiKey ?? ""), allowedModels: input.allowedModels as string[] | "all" });
      return added.ok ? json(201, added.endpoint) : error(400, added.error);
    }
    if ((match = /^\/api\/endpoints\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const denied = admin() ?? recent(who); if (denied) return denied;
      const endpoint = (await account.endpoints()).find(item => item.id === match![1]);
      if (!endpoint) return error(404, "No such endpoint.");
      const held = await hold(`Remove the endpoint ${endpoint.baseUrl}`, [`Its key ending ${endpoint.keyLast4} is deleted`], null, "reverify"); if (held) return held;
      return (await account.removeEndpoint(match[1]!)) ? json(200, { deleted: true }) : error(404, "No such endpoint.");
    }

    if (path === "/api/guardrails" && method === "GET") {
      const level = url.searchParams.get("level") as Level | null, id = url.searchParams.get("id") ?? "";
      if (!level || !LEVELS.includes(level) || !id) return error(400, "Pass level (environment or task) and id (an environment name or a task ID).");
      const task = level === "task" ? await account.task(id) : null;
      if (level === "task" && !task) return error(404, "No such task in this account.");
      const settings = await account.guardrails({ level, scope: id });
      // The effective values at this level, with the level each came from.
      const effective = await account.resolveGuardrails({ environment: task?.environment ?? id, ...(task ? { taskId: task.id } : {}) });
      return json(200, { level, id, settings, effective: effective.effective, from: effective.from, rejected: effective.rejected });
    }
    if (path === "/api/guardrails" && method === "PUT") {
      const input = await body(request);
      const level = input?.level as Level | undefined, id = typeof input?.id === "string" ? input.id : "";
      if (!level || !LEVELS.includes(level) || !id || !input?.settings || typeof input.settings !== "object") return error(400, "Send {level, id, settings}.");
      // Constraints protect the customer: only an admin sets the environment level, from which every constraint starts.
      if (level === "environment") { const denied = admin(); if (denied) return denied; }
      const task = level === "task" ? await account.task(id) : null;
      const money = Object.entries(input.settings as Json).filter(([key]) => MONEY_GUARDRAILS.includes(key));
      if (money.length) {
        const held = await hold(`Change spending limits for ${task?.name ?? id}`, money.map(([key, value]) => `${key === "budgetUsd" ? "Budget per job" : key === "spendCapUsd" ? "Monthly cap on OpenMerit's key" : "Monthly cap on your endpoints"}: ${value === null ? "inherited" : `$${String(value)}`}`), input); if (held) return held;
      }
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
      const denied = admin() ?? recent(who); if (denied) return denied;
      const held = await hold("Disconnect every coding agent", ["Their access tokens stop working; each signs in again"], null, "reverify"); if (held) return held;
      await account.disconnect();
      return json(200, { disconnected: true });
    }
    if (path === "/api/account" && method === "DELETE") {
      const denied = admin() ?? recent(who); if (denied) return denied;
      const held = await hold("Delete everything in this account", ["Every task, eval, run, guardrail, endpoint and key. This cannot be undone"], null, "reverify"); if (held) return held;
      const [tasks, jobs] = await Promise.all([account.tasks(), account.jobs({ limit: 100_000 })]);
      await client.catalogue.getOrCreate(["global"]).unsubscribe({ accountId: who.accountId });
      for (const job of jobs) await client.job.get([job.id]).destroy().catch(() => null);
      for (const task of tasks) await client.task.get([who.accountId, task.id]).destroy().catch(() => null);
      await account.destroy();
      return json(200, { deleted: true, tasks: tasks.length, jobs: jobs.length });
    }
    return null;
  };

  /** Records a person's answer to a confirmation and, when they confirmed, runs the held request as them. */
  async function decideConfirmation(who: Identity, id: string, confirm: boolean, origin: string): Promise<{ ok: true; view: ConfirmationView } | { ok: false; error: string }> {
    const account = client.account.getOrCreate([who.accountId]);
    const decided = await account.decideConfirmation({ id, confirm, by: who.userId });
    if (!decided.ok) return { ok: false, error: !decided.view ? "No such confirmation." : decided.view.status === "expired" ? "This confirmation expired: ask the coding agent to make the request again." : `This request was already ${decided.view.status === "declined" ? "declined" : "confirmed"}.` };
    if (!confirm) return { ok: true, view: decided.view };
    const held = decided.view;
    const replay = new Request(`${origin}${held.path}`, { method: held.method, headers: { "content-type": "application/json" }, ...(decided.body ? { body: decided.body } : {}) });
    let status = 500, answer: unknown = { error: "OpenMerit hit an internal error." };
    try {
      const response = await routes(replay, new URL(replay.url), who, true);
      status = response?.status ?? 404;
      const text = response ? await response.text() : "";
      try { answer = text ? JSON.parse(text) as unknown : null; } catch { answer = text; }
    } catch (failure) { console.error(`confirmation ${id} failed:`, failure); }
    return { ok: true, view: await account.finishConfirmation({ id, result: { status, body: answer } }) };
  }

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
      const parsed = parseShare(deps.config.keyEncryptionKey, share[1]!);
      const found = parsed ? await client.account.get([parsed.accountId]).report({ shareToken: parsed.secret }).catch(() => null) : null;
      return found ? markdown(found.markdown) : new Response("No such report.\n", { status: 404 });
    }
    const auth = await authenticate(request, report !== null);
    if (!auth.ok) return withCors(error(auth.status, auth.error));
    // A self-hosted browser session rides on a cookie: a change must come from the server's own pages.
    if (config.mode !== "hosted" && auth.identity.person && request.method !== "GET" && request.headers.get("origin") !== url.origin) return error(403, "Send this from this server's own pages.");
    if (report && request.method === "GET") {
      const found = await client.account.getOrCreate([auth.identity.accountId]).report({ jobId: report[1]! });
      return found ? markdown(found.markdown) : new Response("No such report in this account.\n", { status: 404 });
    }
    const response = await routes(request, url, auth.identity);
    return response ? withCors(response) : null;
  };
}

