// A local fake of the cloud app's /api/* (cloud/src/api.ts) for the preview server and
// tests, with the same paths, shapes, admin checks and validation messages. Guardrails
// resolve with openmerit/engine's resolver, as in the cloud app. The bearer token picks a
// scenario: preview-tonic (the fully populated Tonic Ultra account in tonic-ultra.ts),
// preview-populated, preview-empty, preview-noplan, preview-member, preview-neworg (an organization
// just created), preview-noorg (a token without an organization), preview-error, preview-slow and preview-expired. Each scenario keeps its own in-memory
// state, so actions change what later requests return. Every name and number is fictional.
import { GUARDRAIL_KINDS, LEVELS, resolveGuardrails, type Guardrails, type Level } from "../../openmerit-core/src/engine/guardrails.ts";
import type { Decision, DeletedTask, Endpoint, JobView, LiveProgress, MeasuredModel, Me, Report, Run, Spend, Task } from "../api.ts";
import { tonicUltra } from "./tonic-ultra.ts";

export interface State { me: Me; tasks: Task[]; runs: Run[]; reports: Record<string, Report>; jobs: Record<string, JobView>; endpoints: Endpoint[]; spend: Spend; guardrails: Record<Level, Record<string, Guardrails>>; disconnected: number; deleted: DeletedTask[] }

const ENV = "sahra-health/claims";
const measured = (model: string, endpoint: string, fields: Partial<MeasuredModel>): MeasuredModel => ({
  model, endpoint, endpointModel: model.split("/").at(-1) ?? model, role: "candidate", stage: "search", eci: 120, inCatalogue: true, funding: "openmerit",
  status: "measured", passes: 38, total: 40, costPerCallUsd: 0.0001, costIsEstimate: false, latencyMs: 900, qualified: false, note: "", ...fields,
});

function populated(): State {
  const task = (id: string, name: string, fields: Partial<Task>): Task => ({
    id, environment: ENV, agent: null, name, currentModel: "openai/gpt-5", pick: null, status: "keep_current", watching: true, lastRunAt: "2026-11-18T10:03:00Z", lastJobId: null, monthlySavingUsd: null, ...fields,
  });
  // The user's decisions in their coding agent: they declined the ticket router's earlier switch, and approved the latest.
  const decision = (jobId: string, value: Decision["decision"], at: string, change: string): Decision => ({ jobId, taskId: "ticket-router", decision: value, change, by: "user_amira", name: "Amira Haddad", email: null, at });
  const approved = decision("k7m2q9", "approved", "2026-11-18T10:12:00Z", "openai/gpt-5 → anthropic/claude-haiku-5-5 (openrouter)");
  const declined = decision("b2v5h3", "declined", "2026-10-30T10:30:00Z", "openai/gpt-5 → openai/gpt-5-mini (ep_openai)");
  const tasks: Task[] = [
    // Approving the pick made it the task's current model.
    task("ticket-router", "Ticket router", { currentModel: "anthropic/claude-haiku-5-5", status: "switched", monthlySavingUsd: 233.5, lastJobId: "k7m2q9", decision: approved }),
    task("bill-matcher", "Bill and claim matcher", { agent: "claim pipeline", currentModel: "anthropic/claude-sonnet-5-5", status: "agent_eval_failed", lastRunAt: "2026-11-17T08:00:00Z", lastJobId: "p3x8d1" }),
    task("fraud-reviewer", "Fraud reviewer", { agent: "claim pipeline", currentModel: "anthropic/claude-sonnet-5-5", watching: false, state: "frozen", lastRunAt: "2026-11-16T12:00:00Z", lastJobId: "f9q2w7" }),
    task("enrollment-checker", "Enrollment checker", { environment: "sahra-health/enroll", currentModel: "openai/gpt-5-mini", status: "running", lastRunAt: "2026-11-18T11:40:00Z", lastJobId: "e4n6t0" }),
    task("reply-drafter", "Reply drafter", { pick: "anthropic/claude-haiku-5-5", status: "picked", monthlySavingUsd: 96.4, lastRunAt: "2026-11-18T08:30:00Z", lastJobId: "m5d8q2" }),
    task("coding-reviewer", "Coding reviewer", { currentModel: "anthropic/claude-sonnet-5-5", status: "failed", lastRunAt: "2026-11-12T10:00:00Z", lastJobId: "z1c7m4" }),
  ];
  const run = (id: string, taskId: string, status: string, startedAt: string, kind = "run", askedBy: string | null = kind === "watch" ? null : "claude-code"): Run => ({ id, taskId, kind, status, startedAt, finishedAt: status === "done" || status === "failed" ? startedAt : null, askedBy, result: null });
  const runs: Run[] = [
    run("e4n6t0", "enrollment-checker", "running", "2026-11-18T11:40:00Z"),
    run("w8r3k1", "ticket-router", "needs_input", "2026-11-18T11:20:00Z"),
    run("k7m2q9", "ticket-router", "done", "2026-11-18T09:40:00Z"),
    run("p3x8d1", "bill-matcher", "done", "2026-11-17T08:00:00Z", "watch"),
    run("f9q2w7", "fraud-reviewer", "done", "2026-11-16T12:00:00Z", "run", "codex"),
    run("m5d8q2", "reply-drafter", "done", "2026-11-18T08:30:00Z"),
    run("z1c7m4", "coding-reviewer", "failed", "2026-11-12T10:00:00Z"),
    run("b2v5h3", "ticket-router", "done", "2026-10-30T10:00:00Z"),
  ];
  const baseline = measured("openai/gpt-5", "openrouter", { role: "baseline", stage: "baseline", passes: 39, total: 40, costPerCallUsd: 0.00475, latencyMs: 3100 });
  const haiku = measured("anthropic/claude-haiku-5-5", "openrouter", { passes: 40, total: 40, costPerCallUsd: 0.00007, latencyMs: 500, qualified: true });
  const report: Report = {
    jobId: "k7m2q9", task: "Ticket router", createdAt: "2026-11-18T10:03:00Z",
    status: "picked",
    pick: { model: haiku.model, endpoint: "openrouter", endpointModel: "anthropic/claude-haiku-5-5", passes: 40, total: 40, costPerCallUsd: 0.00007, savingPerCallUsd: 0.00468 },
    top: [haiku], baseline,
    nearMisses: [{ ...measured("openai/gpt-5-mini", "ep_openai", { funding: "customer", endpointModel: "gpt-5-mini", passes: 38, costPerCallUsd: 0.00065, latencyMs: 1800, note: "1 case below the current model" }), cheaperThanCurrent: true }],
    candidates: [
      haiku,
      measured("openai/gpt-5-mini", "ep_openai", { funding: "customer", endpointModel: "gpt-5-mini", passes: 38, costPerCallUsd: 0.00065, latencyMs: 1800, note: "1 case below the current model" }),
      measured("openai/gpt-5-nano", "ep_openai", { funding: "customer", endpointModel: "gpt-5-nano", status: "screened_out", passes: 3, total: 5, costPerCallUsd: 0.00015, latencyMs: 1400 }),
      measured("sahra-triage-ft-2", "ep_baseten", { funding: "customer", stage: "challenger", inCatalogue: false, eci: null, passes: 35, costPerCallUsd: 0.00004, costIsEstimate: true, latencyMs: 700 }),
      measured("deepseek/deepseek-v4-flash", "openrouter", { stage: "neighbour", status: "unavailable", passes: 0, total: 0, costPerCallUsd: null, latencyMs: null, note: "provider returned 503" }),
    ],
    search: { pool: 14, unplaced: 1, samples: ["c01", "c02", "c07", "c13", "c18"], finalists: [haiku.model, "openai/gpt-5-mini"], challengers: ["sahra-triage-ft-2"], shortfall: null },
    agentEval: null,
    edit: { edits: [{ file: "src/triage.ts", line: 14, before: 'process.env.TRIAGE_MODEL ?? "gpt-5"', after: 'process.env.TRIAGE_MODEL ?? "anthropic/claude-haiku-5-5"' }], instructions: "The code's literal is a fallback; production's model comes from elsewhere (for example an environment variable). Set it to `anthropic/claude-haiku-5-5`. Call it on OpenRouter (https://openrouter.ai/api/v1) instead of ep_openai." },
    spend: { openmeritUsd: 1.84, customerUsd: 0.62 },
    guardrails: resolveGuardrails({ environment: { allowedProviders: ["openai", "anthropic"], repeats: 3, minPassRate: 0.95 }, task: { latencyMs: 1000, allowedProviders: ["openai", "anthropic", "deepseek"] } }),
    notices: ["Model calls were sent through OpenRouter; your app calls OpenAI directly, so latency there may differ."],
    reportUrl: "https://openmerit.ai/api/r/k7m2q9.md", catalogueVersion: "2026-11-18", cases: { total: 40, fromExamples: 8, written: 32 },
  };
  const keep: Report = { ...report, jobId: "f9q2w7", task: "Fraud reviewer", createdAt: "2026-11-16T12:00:00Z", status: "keep_current", pick: null, top: [], baseline: { ...baseline, model: "anthropic/claude-sonnet-5-5" }, candidates: report.candidates.slice(1, 3), nearMisses: [], edit: { edits: [], instructions: null }, notices: [], spend: { openmeritUsd: 0.92, customerUsd: 0 } };
  const failedEval: Report = { ...keep, jobId: "p3x8d1", task: "Bill and claim matcher", createdAt: "2026-11-17T08:00:00Z", status: "agent_eval_failed", agentEval: { status: "checked", passed: false, warning: null, baseline: { passes: 18, total: 20 }, tried: [{ model: "google/gemini-3.5-flash", passes: 15, total: 20, passed: false }] } };
  const job = (jobId: string, taskId: string, name: string, fields: Partial<JobView>): JobView => ({
    jobId, taskId, task: name, status: "running", phase: "ranking", questions: [], notices: [], progress: { measured: 12, planned: 30 }, result: null, error: null,
    provisional: { model: "openai/gpt-5-mini", endpoint: "openrouter", reason: "The cheapest catalogue model above the current one's capability index.", estCostPerCallUsd: 0.0006 }, createdAt: "2026-11-18T11:40:00Z", report: null, ...fields,
  });
  return {
    me: { user: { id: "user_amira" }, account: { id: "org_sahra", name: "Sahra Health" }, role: "admin", plan: { name: "Cloud", status: "active", periodEnd: "2026-12-01T00:00:00Z", includedEvals: 100, usedEvals: 38 } },
    tasks, runs,
    reports: {
      k7m2q9: { ...report, decision: approved },
      // Picked, and the coding agent has not sent the user's answer yet.
      m5d8q2: { ...report, jobId: "m5d8q2", task: "Reply drafter", createdAt: "2026-11-18T08:50:00Z", decision: null }, f9q2w7: keep, p3x8d1: failedEval,
      b2v5h3: { ...report, jobId: "b2v5h3", createdAt: "2026-10-30T10:20:00Z", pick: { ...report.pick!, model: "openai/gpt-5-mini", endpoint: "ep_openai", endpointModel: "gpt-5-mini", passes: 39, costPerCallUsd: 0.00065, savingPerCallUsd: 0.0041 }, top: [], nearMisses: [], decision: declined,
        edit: { edits: [{ file: "src/triage.ts", line: 14, before: 'process.env.TRIAGE_MODEL ?? "gpt-5"', after: 'process.env.TRIAGE_MODEL ?? "gpt-5-mini"' }], instructions: null } },
    },
    jobs: {
      e4n6t0: job("e4n6t0", "enrollment-checker", "Enrollment checker", {}),
      w8r3k1: job("w8r3k1", "ticket-router", "Ticket router", { status: "needs_input", phase: "label_check", questions: [{ id: "labels" }], progress: { measured: 0, planned: null }, createdAt: "2026-11-18T11:20:00Z" }),
      z1c7m4: job("z1c7m4", "coding-reviewer", "Coding reviewer", { status: "failed", phase: "cases", error: "The task's examples had no known answers, and no case could be written from it.", provisional: null, createdAt: "2026-11-12T10:00:00Z" }),
    },
    endpoints: [
      { id: "ep_openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", allowedModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano"], keyLast4: "4f2a", verifiedAt: "2026-11-12T09:00:00Z", builtIn: false },
      { id: "ep_baseten", kind: "openai-compatible", baseUrl: "https://model-7q2.api.baseten.co/v1", allowedModels: ["sahra-triage-ft-2"], keyLast4: "91be", verifiedAt: null, builtIn: false },
    ],
    spend: { openmeritUsd: 18.42, customerUsd: 6.1, monthlyCapUsd: 250, customerCapUsd: 50, period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } },
    guardrails: {
      environment: { [ENV]: { allowedProviders: ["openai", "anthropic"], spendCapUsd: 25, repeats: 3, minPassRate: 0.95, watch: true, actionPolicy: "ask_first" }, "sahra-health/enroll": { region: "uae" } },
      agent: { [`${ENV}:claim pipeline`]: { agentEvalRequired: "required", minAgentPassRate: 0.9 } },
      task: { "ticket-router": { latencyMs: 1000, allowedProviders: ["openai", "anthropic", "deepseek"] } },
    },
    disconnected: 0, deleted: [],
  };
}

function emptyState(me: Me): State {
  const state = populated();
  return { ...state, me: { ...me, plan: { ...me.plan, usedEvals: 0 } }, tasks: [], runs: [], reports: {}, jobs: {}, endpoints: [], spend: { ...state.spend, openmeritUsd: 0, customerUsd: 0 }, guardrails: { environment: {}, agent: {}, task: {} } };
}

function scenario(name: string): State {
  if (name === "tonic") return tonicUltra();
  const state = populated();
  if (name === "empty") return emptyState(state.me);
  // An organization the preview just created: nothing in it yet, no plan, and no name in the token
  // (the instance has organization slugs off), so the app names it from Clerk.
  if (name === "neworg") return emptyState({ user: { id: "user_jordan" }, account: { id: "org_new", name: null }, role: "admin", plan: { name: null, status: "none", periodEnd: null, includedEvals: 0, usedEvals: 0 } });
  if (name === "noplan") state.me.plan = { name: null, status: "none", periodEnd: null, includedEvals: 0, usedEvals: 0 };
  if (name === "member") state.me.role = "member";
  return state;
}

const json = (status: number, data: unknown): Response => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const error = (status: number, message: string): Response => json(status, { error: message });

// A measuring job advances one case every TICK_MS from when the fake API starts, so polling pages
// move. Each job fails a fixed set of cases, and starts over once it has run them all.
const TICK_MS = 2500;
function advance(job: JobView, task: Task | undefined, since: number, now = Date.now()): JobView {
  if (job.status !== "running" || !job.provisional) return job;
  const total = job.progress.planned ?? 30, start = Math.min(job.progress.measured, total - 1);
  const seed = [...job.jobId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const fails = (i: number) => (i * 7 + seed) % 9 === 0 || (i + seed) % 13 === 0;
  const done = start + (Math.floor((now - since) / TICK_MS) % (total - start + 1));
  const history: LiveProgress["history"] = [];
  let passes = 0;
  for (let i = 1; i <= done; i += 1) {
    passes += fails(i) ? 0 : 1;
    history.push({ time: (now - (done - i) * TICK_MS) / 1000, rate: (passes / i) * 100 });
  }
  const live: LiveProgress = {
    model: job.provisional.model, endpoint: job.provisional.endpoint, baseline: task ? { model: task.currentModel, rate: seed % 2 ? 90 : 95 } : null,
    done, total, passes, history: history.slice(-60), minutesLeft: done < total ? Math.max(1, Math.ceil((total - done) * 0.6)) : null,
  };
  return { ...job, progress: { measured: done, planned: total }, live };
}

export function createFakeApi(options: { appUrl?: string } = {}): (request: Request) => Promise<Response> {
  const states = new Map<string, State>();
  const since = Date.now();
  return async (request) => {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const bearer = /^Bearer preview-([a-z]+)(?:\.v(\d+))?$/.exec(request.headers.get("authorization") ?? "");
    const name = bearer?.[1];
    // As in the cloud app, deleting needs a first-factor verification in the last 10 minutes.
    const unverified = Date.now() / 1000 - Number(bearer?.[2] ?? 0) > 600
      ? json(403, { clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: { level: "first_factor", afterMinutes: 10 } } } })
      : null;
    if (!name || name === "expired") return error(401, "Sign in first.");
    if (name === "noorg") return error(403, "This token names no Clerk organization. OpenMerit accounts are organizations: sign in again and choose an organization, or create one at app.openmerit.ai.");
    if (name === "error") return error(500, "The cloud app is having trouble. Try again in a minute.");
    if (name === "slow") await new Promise((done) => setTimeout(done, 60_000));
    let state = states.get(name);
    if (!state) states.set(name, state = scenario(name));
    let input: Record<string, unknown> | null = null;
    if (method === "POST" || method === "PUT") {
      try { const value = await request.json() as unknown; input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { input = null; }
    }
    const denied = state.me.role === "admin" ? null : error(403, "Only an organization admin can do this.");
    let match: RegExpExecArray | null;

    if (path === "/api/me" && method === "GET") return json(200, state.me);
    if (path === "/api/tasks" && method === "GET") return json(200, state.tasks);
    if (path === "/api/runs" && method === "GET") {
      // As the cloud app does, each finished run carries what its report found.
      return json(200, state.runs.map((run): Run => {
        const report = state.reports[run.id];
        return { ...run, result: report ? { status: report.status, model: report.pick?.model ?? null, from: report.baseline?.model ?? null, savingPerCallUsd: report.pick?.savingPerCallUsd ?? null } : null };
      }));
    }
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const id = match[1] ?? "";
      if (!state.runs.some((run) => run.id === id)) return error(404, "No such run in this account.");
      const job = state.jobs[id];
      const found = state.reports[id] ?? (job && advance(job, state.tasks.find((task) => task.id === job.taskId), since));
      return found ? json(200, found) : error(404, "No such run in this account.");
    }
    // As the cloud app does: run the task again, after setting its budget per job when budgetUsd is given.
    if ((match = /^\/api\/runs\/([\w-]+)\/rerun$/.exec(path)) && method === "POST") {
      const run = state.runs.find((item) => item.id === match?.[1]);
      const task = run && state.tasks.find((item) => item.id === run.taskId);
      if (!run || !task) return error(404, `No run ${match[1]} in this account.`);
      const budgetUsd = input?.budgetUsd;
      if (budgetUsd !== undefined && budgetUsd !== null) {
        if (typeof budgetUsd !== "number" || budgetUsd <= 0 || budgetUsd > 1000) return error(409, "The budget must be more than $0 and at most $1000.");
        state.guardrails.task[task.id] = { ...state.guardrails.task[task.id], budgetUsd };
      }
      const jobId = `rr${Date.now().toString(36).slice(-4)}`, startedAt = new Date().toISOString();
      const pick = state.reports[run.id]?.candidates.find((item) => item.status === "measured")?.model ?? "openai/gpt-5-mini";
      state.runs.unshift({ id: jobId, taskId: task.id, kind: "run", status: "running", startedAt, finishedAt: null, askedBy: null, result: null });
      state.jobs[jobId] = {
        jobId, taskId: task.id, task: task.name, status: "running", phase: "ranking", questions: [], notices: [], progress: { measured: 0, planned: 30 }, result: null, error: null,
        provisional: { model: pick, endpoint: "openrouter", reason: "Measured for this task before; this run measures it again.", estCostPerCallUsd: null }, createdAt: startedAt, report: null,
      };
      Object.assign(task, { status: "running", lastJobId: jobId, lastRunAt: startedAt });
      return json(201, { jobId, taskId: task.id });
    }
    if (path === "/api/endpoints" && method === "GET") return json(200, state.endpoints);
    if (path === "/api/endpoints" && method === "POST") {
      if (denied) return denied;
      if (!input) return error(400, "Send the endpoint as JSON: {kind, baseUrl, apiKey, allowedModels}.");
      const { kind, baseUrl, apiKey, allowedModels } = input;
      if (kind !== "openrouter" && kind !== "openai-compatible" && kind !== "anthropic") return error(400, "kind must be openrouter, openai-compatible or anthropic");
      if (typeof baseUrl !== "string" || !/^https:\/\/[^\s/]+/.test(baseUrl)) return error(400, "baseUrl must be an https:// URL");
      if (typeof apiKey !== "string" || apiKey.trim().length < 8) return error(400, "apiKey is missing");
      const models = allowedModels === "all" ? "all" : Array.isArray(allowedModels) ? allowedModels.map(String).filter(Boolean) : null;
      if (!models || (models !== "all" && !models.length)) return error(400, "allowedModels must be \"all\" or a list of model IDs");
      if (models === "all" && kind !== "openrouter") return error(400, "List the models this endpoint may run: only an OpenRouter endpoint can allow all");
      // Only the last four characters are kept; the fake never stores or returns the key.
      const endpoint: Endpoint = { id: `ep_${state.endpoints.length + 3}`, kind, baseUrl, allowedModels: models, keyLast4: apiKey.trim().slice(-4), verifiedAt: null, builtIn: false };
      state.endpoints.push(endpoint);
      return json(201, endpoint);
    }
    if ((match = /^\/api\/endpoints\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      if (denied) return denied;
      const before = state.endpoints.length;
      state.endpoints = state.endpoints.filter((item) => item.id !== match?.[1]);
      return before === state.endpoints.length ? error(404, "No such endpoint.") : json(200, { deleted: true });
    }
    if (path === "/api/guardrails" && method === "GET") {
      const level = url.searchParams.get("level") as Level | null, id = url.searchParams.get("id") ?? "";
      if (!level || !LEVELS.includes(level) || !id) return error(400, "Pass level (environment, agent or task) and id (an environment name, environment:agent, or a task ID).");
      const split = id.indexOf(":");
      if (level === "agent" && split <= 0) return error(400, "An agent's id is environment:agent, such as acme/app:claims.");
      const task = level === "task" ? state.tasks.find((item) => item.id === id) : undefined;
      const environment = level === "agent" ? id.slice(0, split) : task?.environment ?? id;
      const agent = level === "agent" ? id.slice(split + 1) : task?.agent ?? null;
      const settings = state.guardrails[level][id] ?? {};
      const chain: Partial<Record<Level, Guardrails>> = { environment: state.guardrails.environment[environment] ?? {} };
      if (agent) chain.agent = state.guardrails.agent[`${environment}:${agent}`] ?? {};
      if (task) chain.task = state.guardrails.task[task.id] ?? {};
      const resolved = resolveGuardrails(chain);
      return json(200, { level, id, settings: Object.entries(settings).map(([key, value]) => ({ key, value, kind: GUARDRAIL_KINDS[key as keyof typeof GUARDRAIL_KINDS] })), ...resolved });
    }
    if (path === "/api/guardrails" && method === "PUT") {
      const level = input?.level as Level | undefined, id = typeof input?.id === "string" ? input.id : "";
      if (!level || !LEVELS.includes(level) || !id || !input?.settings || typeof input.settings !== "object") return error(400, "Send {level, id, settings}.");
      if (level === "environment" && denied) return denied;
      const entries = Object.entries(input.settings as Record<string, unknown>);
      const rejected = entries.filter(([key]) => !Object.hasOwn(GUARDRAIL_KINDS, key)).map(([key]) => ({ key, reason: "not a guardrail" }));
      state.guardrails[level][id] = Object.fromEntries(entries.filter(([key, value]) => Object.hasOwn(GUARDRAIL_KINDS, key) && value !== null && value !== undefined)) as Guardrails;
      return json(200, { rejected });
    }
    if (path === "/api/spend" && method === "GET") return json(200, state.spend);
    if (path === "/api/billing/checkout" && method === "POST") {
      if (denied) return denied;
      state.me.plan = { name: "Cloud", status: "active", periodEnd: "2026-12-18T00:00:00Z", includedEvals: 100, usedEvals: 0 };
      return json(200, { url: `${options.appUrl ?? ""}/__preview-stripe?checkout` });
    }
    if (path === "/api/billing/portal" && method === "POST") {
      if (denied) return denied;
      if (state.me.plan.status === "none") return error(409, "This account has no Stripe customer yet: subscribe first.");
      return json(200, { url: `${options.appUrl ?? ""}/__preview-stripe?portal` });
    }
    if (path === "/api/account/export" && method === "POST") {
      const { tasks, runs, reports, endpoints, guardrails } = state;
      return json(200, { account: state.me.account.id, exportedAt: new Date().toISOString(), endpoints, guardrails, tasks, jobs: runs, reports: Object.values(reports) });
    }
    if (path === "/api/disconnect" && method === "POST") { if (denied) return denied; state.disconnected += 1; return json(200, { disconnected: true }); }
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      if (denied) return denied;
      const id = match[1] ?? "";
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return error(404, "No such task in this account.");
      if (unverified) return unverified;
      if (state.runs.some((run) => run.taskId === id && (run.status === "queued" || run.status === "running"))) return error(409, "This task has a run in progress. Delete it once the run finishes.");
      const gone = state.runs.filter((run) => run.taskId === id);
      for (const run of gone) { delete state.reports[run.id]; delete state.jobs[run.id]; }
      state.tasks = state.tasks.filter((task) => task.id !== id);
      state.runs = state.runs.filter((run) => run.taskId !== id);
      state.deleted.unshift({ taskId: id, name: task.name, environment: task.environment, userId: state.me.user.id, jobs: gone.length, deletedAt: new Date().toISOString() });
      return json(200, { deleted: true, jobs: gone.length });
    }
    if (path === "/api/tasks/deleted" && method === "GET") return json(200, state.deleted);
    if (path === "/api/account" && method === "DELETE") {
      if (denied) return denied;
      if (unverified) return unverified;
      const { tasks, runs } = state;
      states.set(name, emptyState(state.me));
      return json(200, { deleted: true, tasks: tasks.length, jobs: runs.length });
    }
    return error(404, "Not found.");
  };
}
