// A local fake of the cloud app's /api/* for the preview server and tests. The
// bearer token picks a scenario: preview-populated, preview-empty, preview-noplan,
// preview-member, preview-error, preview-slow and preview-expired. Each scenario
// keeps its own in-memory state, so actions change what later requests return.
// Every name and number here is fictional.
import type { Endpoint, Guardrails, GuardrailSetting, Level, Me, Report, RunSummary, Spend, Task } from "../api.ts";

type Settings = Record<string, unknown>;
interface State { me: Me; tasks: Task[]; runs: RunSummary[]; reports: Record<string, Report>; endpoints: Endpoint[]; spend: Spend; guardrails: Record<Level, Record<string, Settings>>; disconnected: number }

const constraints = ["allowedProviders", "allowedModels", "endpoints", "region", "spendCapUsd", "customerSpendCapUsd"];
const defaults = ["budgetUsd", "repeats", "minPassRate", "latencyMs", "watch", "actionPolicy", "agentEvalRequired", "minAgentPassRate"];

const openrouter: Endpoint = { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", allowedModels: [], keyLast4: null, verifiedAt: null };
const gpt5 = { model: "openai/gpt-5", endpoint: "OpenAI", label: "GPT-5" };
const mini = { model: "openai/gpt-5-mini", endpoint: "OpenAI", label: "GPT-5 mini" };
const nano = { model: "openai/gpt-5-nano", endpoint: "OpenAI", label: "GPT-5 nano" };
const haiku = { model: "anthropic/claude-haiku-5-5", endpoint: "Anthropic", label: "Claude Haiku 5.5" };
const sonnet = { model: "anthropic/claude-sonnet-5-5", endpoint: "Anthropic", label: "Claude Sonnet 5.5" };
const flash = { model: "google/gemini-3.5-flash", endpoint: "Google", label: "Gemini 3.5 Flash" };
const deepseek = { model: "deepseek/deepseek-v4-flash", endpoint: "DeepSeek", label: "DeepSeek V4 Flash" };
const tuned = { model: "sahra-triage-ft-2", endpoint: "Baseten", label: "sahra-triage-ft-2" };

function populated(): State {
  const env = "sahra-health/claims";
  const run = (id: string, task: string, taskId: string, fields: Partial<RunSummary>): RunSummary => ({
    id, task, taskId, environment: env, status: "done", outcome: "keep", current: gpt5, pick: null, provisional: null,
    requestedBy: "claude-code", basis: ["context"], startedAt: "2026-11-18T09:40:00Z", measuredAt: "2026-11-18T10:03:00Z", savingPct: null, ...fields,
  });
  const runs: RunSummary[] = [
    run("k7m2q9", "Ticket router", "ticket-router", { outcome: "switch", pick: haiku, savingPct: 98 }),
    run("p3x8d1", "Bill and claim matcher", "bill-matcher", { outcome: "cheaper", current: sonnet, pick: flash, requestedBy: "watch", basis: ["context", "code"], measuredAt: "2026-11-17T08:00:00Z" }),
    run("f9q2w7", "Fraud reviewer", "fraud-reviewer", { current: sonnet, requestedBy: "codex", basis: ["eval"], measuredAt: "2026-11-16T12:00:00Z" }),
    run("e4n6t0", "Enrollment checker", "enrollment-checker", { environment: "sahra-health/enroll", status: "running", outcome: null, provisional: mini, measuredAt: null }),
    run("b2v5h3", "Ticket router", "ticket-router", { measuredAt: "2026-11-02T10:00:00Z" }),
    run("z1c7m4", "Coding reviewer", "coding-reviewer", { status: "failed", outcome: null, current: sonnet, basis: ["traces"], measuredAt: "2026-10-29T10:00:00Z" }),
  ];
  const tasks: Task[] = [
    { id: "ticket-router", environment: env, agent: null, name: "Ticket router", currentModel: gpt5, pick: haiku, status: "switched", watching: true, lastRunAt: "2026-11-18T10:03:00Z", monthlySavingUsd: 233.5, latestRunId: "k7m2q9", codeRef: "src/triage.ts" },
    { id: "bill-matcher", environment: env, agent: "claims-intake", name: "Bill and claim matcher", currentModel: sonnet, pick: flash, status: "cheaper-fit", watching: true, lastRunAt: "2026-11-17T08:00:00Z", monthlySavingUsd: null, latestRunId: "p3x8d1", codeRef: "src/agents/intake.ts" },
    { id: "fraud-reviewer", environment: env, agent: "claims-intake", name: "Fraud reviewer", currentModel: sonnet, pick: null, status: "keep", watching: false, lastRunAt: "2026-11-16T12:00:00Z", monthlySavingUsd: null, latestRunId: "f9q2w7", codeRef: "src/agents/fraud.ts" },
    { id: "enrollment-checker", environment: "sahra-health/enroll", agent: null, name: "Enrollment checker", currentModel: mini, pick: null, status: "measuring", watching: true, lastRunAt: null, monthlySavingUsd: null, latestRunId: "e4n6t0", codeRef: "src/eligibility.ts" },
  ];
  const first = runs[0]!;
  const results = (current: number, pick: number, next: number) => [{ model: gpt5.model, passed: current, runs: 3 }, { model: haiku.model, passed: pick, runs: 3 }, { model: mini.model, passed: next, runs: 3 }];
  const report: Report = {
    ...first,
    summary: "It passed as many tests as GPT-5, the model in use today, at under 2% of the cost and six times faster.",
    candidates: [
      { model: gpt5, role: "current", passed: 117, total: 120, costPer1kUsd: 4.75, latencyMs: 3100, verdict: "Baseline", measuredOnly: false, funding: "customer" },
      { model: haiku, role: "pick", passed: 118, total: 120, costPer1kUsd: 0.07, latencyMs: 500, verdict: "Qualifies · cheapest", measuredOnly: false, funding: "openmerit" },
      { model: mini, role: "candidate", passed: 116, total: 120, costPer1kUsd: 0.65, latencyMs: 1800, verdict: "1 run below baseline", measuredOnly: false, funding: "customer" },
      { model: nano, role: "candidate", passed: 109, total: 120, costPer1kUsd: 0.15, latencyMs: 1400, verdict: "Below baseline", measuredOnly: false, funding: "customer" },
      { model: tuned, role: "candidate", passed: 112, total: 120, costPer1kUsd: 0.04, latencyMs: 700, verdict: "Below baseline", measuredOnly: true, funding: "customer" },
      { model: deepseek, role: "outside", passed: 118, total: 120, costPer1kUsd: 0.06, latencyMs: 900, verdict: "Outside allowed providers", measuredOnly: false, funding: "openmerit" },
    ],
    cases: [
      { id: "t01", input: "\"I was charged twice for November, please refund one.\"", expected: "billing", origin: "example", approved: true, results: results(3, 3, 3) },
      { id: "t02", input: "\"The export button does nothing on Safari.\"", expected: "bug", origin: "example", approved: true, results: results(3, 3, 3) },
      { id: "t07", input: "\"Can I get an invoice with our new VAT number? Also the PDF looks broken.\"", expected: "billing", origin: "written", approved: true, results: results(1, 3, 0) },
      { id: "t13", input: "\"Your card form rejected my card three times, then charged me.\"", expected: "billing", origin: "written", approved: false, results: results(3, 1, 3) },
      { id: "t18", input: "\"Do you have a partner programme?\"", expected: "other", origin: "written", approved: false, results: results(3, 3, 3) },
    ],
    casesTotal: 40, passRule: "the answer must be exactly the expected label", repeats: 3,
    edit: { file: "src/triage.ts", before: 'provider: "openai", model: "gpt-5",', after: 'provider: "anthropic", model: "claude-haiku-5-5",', applied: true },
    search: [{ model: gpt5, step: "baseline", pass: null }, { model: mini, step: "screen", pass: true }, { model: nano, step: "screen", pass: false }, { model: haiku, step: "screen", pass: true }, { model: tuned, step: "challenger", pass: false }, { model: haiku, step: "finalist", pass: true }],
    spend: { openmeritUsd: 1.84, customerUsd: 0.62 }, monthlyCalls: 50_000, shareUrl: null, error: null,
  };
  const reports: Record<string, Report> = { k7m2q9: report };
  for (const item of runs.slice(1)) {
    reports[item.id] = { ...item, summary: null, candidates: [], cases: [], casesTotal: 0, passRule: null, repeats: 3, edit: null, search: [], spend: { openmeritUsd: 0.4, customerUsd: 0 }, monthlyCalls: null, shareUrl: null, error: item.status === "failed" ? "The Langfuse traces for this task had no inputs OpenMerit could replay." : null };
  }
  return {
    me: { user: { id: "user_amira", name: "Amira Haddad", email: "amira@sahra.example" }, account: { id: "org_sahra", name: "Sahra Health" }, role: "admin", plan: { name: "Cloud", status: "active", periodEnd: "2026-12-01T00:00:00Z", includedEvals: 100, usedEvals: 38 } },
    tasks, runs, reports,
    endpoints: [openrouter,
      { id: "ep_openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", allowedModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano"], keyLast4: "4f2a", verifiedAt: "2026-11-12T09:00:00Z" },
      { id: "ep_baseten", kind: "openai-compatible", baseUrl: "https://model-7q2.api.baseten.co/v1", allowedModels: ["sahra-triage-ft-2"], keyLast4: "91be", verifiedAt: null }],
    spend: { openmeritUsd: 18.42, customerUsd: 6.1, monthlyCapUsd: 250, customerCapUsd: 50, period: { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" } },
    guardrails: {
      environment: { [env]: { allowedProviders: ["openai", "anthropic"], spendCapUsd: 25, repeats: 3, minPassRate: 0.95, watch: true, actionPolicy: "propose" }, "sahra-health/enroll": { region: "eu" } },
      agent: { "claims-intake": { agentEvalRequired: true, minAgentPassRate: 0.9 } },
      task: { "ticket-router": { latencyMs: 1000, allowedProviders: ["openai", "anthropic", "deepseek"] } },
    },
    disconnected: 0,
  };
}

function emptyState(): State {
  const state = populated();
  return { ...state, tasks: [], runs: [], reports: {}, endpoints: [openrouter], spend: { ...state.spend, openmeritUsd: 0, customerUsd: 0 }, guardrails: { environment: {}, agent: {}, task: {} }, me: { ...state.me, plan: state.me.plan && { ...state.me.plan, usedEvals: 0 } } };
}

function scenario(name: string): State {
  const state = name === "empty" ? emptyState() : populated();
  if (name === "noplan") state.me.plan = { name: "Cloud", status: "none", periodEnd: null, includedEvals: 0, usedEvals: 0 };
  if (name === "member") state.me.role = "member";
  return state;
}

// Constraints only narrow below; defaults are replaced. Mirrors the contract's resolveGuardrails.
function resolve(state: State, level: Level, id: string): Guardrails {
  const task = state.tasks.find((item) => item.id === id);
  const chain: [Level, Settings | undefined][] = [];
  const environment = level === "environment" ? id : level === "task" ? task?.environment : state.tasks.find((item) => item.agent === id)?.environment;
  if (environment) chain.push(["environment", state.guardrails.environment[environment]]);
  const agent = level === "agent" ? id : task?.agent;
  if (level !== "environment" && agent) chain.push(["agent", state.guardrails.agent[agent]]);
  if (level === "task") chain.push(["task", state.guardrails.task[id]]);
  const rejected: Guardrails["rejected"] = [];
  const settings = [...constraints, ...defaults].map((key): GuardrailSetting => {
    const kind = constraints.includes(key) ? "constraint" : "default";
    let effective: unknown = null, from: Level | null = null;
    for (const [at, values] of chain) {
      const value = values?.[key];
      if (value === undefined || value === null) continue;
      const widens = kind === "constraint" && effective !== null && (Array.isArray(value) && Array.isArray(effective) ? value.some((item) => !(effective as unknown[]).includes(item)) : typeof value === "number" && typeof effective === "number" ? value > effective : value !== effective);
      if (widens) { rejected.push({ key, level: at, reason: `it is wider than the ${from} level allows` }); continue; }
      effective = value; from = at;
    }
    return { key, kind, value: state.guardrails[level][id]?.[key] ?? null, effective, from };
  });
  return { level, id, settings, rejected };
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string, code?: string): Response => json({ error, ...(code ? { code } : {}) }, status);

export function createFakeApi(options: { origin?: string } = {}): (request: Request) => Promise<Response> {
  const states = new Map<string, State>();
  return async (request) => {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const name = /^Bearer preview-([a-z]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!name || name === "expired") return fail(401, "Sign in first.", "sign_in_required");
    if (name === "error") return fail(500, "The cloud app is having trouble. Try again in a minute.");
    if (name === "slow") await new Promise((done) => setTimeout(done, 60_000));
    let state = states.get(name);
    if (!state) states.set(name, state = scenario(name));
    const body = method === "GET" || method === "DELETE" ? {} : await request.json().catch(() => ({})) as Record<string, unknown>;
    const admin = state.me.role === "admin";
    let match: RegExpExecArray | null;

    if (method === "GET" && path === "/api/me") return json(state.me);
    if (method === "GET" && path === "/api/tasks") return json(state.tasks);
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "GET") {
      const task = state.tasks.find((item) => item.id === match?.[1]);
      return task ? json(task) : fail(404, "No such task.");
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/watch$/.exec(path)) && method === "POST") {
      const task = state.tasks.find((item) => item.id === match?.[1]);
      if (!task) return fail(404, "No such task.");
      task.watching = body.on === true;
      return json(task);
    }
    if (method === "GET" && path === "/api/runs") return json(state.runs);
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const report = state.reports[match[1] ?? ""];
      return report ? json(report) : fail(404, "No such run.");
    }
    if ((match = /^\/api\/runs\/([\w-]+)\/share$/.exec(path)) && method === "POST") {
      const report = state.reports[match[1] ?? ""];
      if (!report) return fail(404, "No such run.");
      report.shareUrl = `${options.origin ?? "https://app.openmerit.ai"}/r/${report.id}/?share=pv${report.id.slice(0, 3)}`;
      return json({ url: report.shareUrl });
    }
    if (method === "GET" && path === "/api/endpoints") return json(state.endpoints);
    if (method === "POST" && path === "/api/endpoints") {
      const { kind, baseUrl, apiKey, allowedModels } = body;
      if (!["openrouter", "openai-compatible", "anthropic"].includes(String(kind))) return fail(400, "Choose a kind of endpoint.");
      if (typeof baseUrl !== "string" || !/^https:\/\/[^\s/]+/.test(baseUrl)) return fail(400, "The base URL must start with https://.");
      if (typeof apiKey !== "string" || apiKey.length < 8) return fail(400, "That key is too short to be an API key.");
      // Only the last four characters are kept; the fake never stores or returns the key.
      const endpoint: Endpoint = { id: `ep_${state.endpoints.length + 1}`, kind: kind as Endpoint["kind"], baseUrl, allowedModels: Array.isArray(allowedModels) ? allowedModels.map(String) : [], keyLast4: apiKey.slice(-4), verifiedAt: null };
      state.endpoints.push(endpoint);
      return json(endpoint, 201);
    }
    if ((match = /^\/api\/endpoints\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const before = state.endpoints.length;
      state.endpoints = state.endpoints.filter((item) => item.id !== match?.[1] || item.id === "openrouter");
      return before === state.endpoints.length ? fail(404, "No such endpoint.") : json({ ok: true });
    }
    if (method === "GET" && path === "/api/guardrails") {
      const level = url.searchParams.get("level") as Level, id = url.searchParams.get("id") ?? "";
      if (!["environment", "agent", "task"].includes(level)) return fail(400, "Unknown level.");
      return json(resolve(state, level, id));
    }
    if (method === "PUT" && path === "/api/guardrails") {
      const level = body.level as Level, id = String(body.id ?? ""), settings = body.settings as Settings;
      if (!["environment", "agent", "task"].includes(level) || !id || typeof settings !== "object") return fail(400, "Send a level, an id and settings.");
      for (const [key, value] of Object.entries(settings)) if (typeof value === "number" && Number.isNaN(value)) return fail(400, `${key} must be a number.`);
      state.guardrails[level][id] = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== null));
      return json(resolve(state, level, id));
    }
    if (method === "GET" && path === "/api/spend") return json(state.spend);
    if (method === "POST" && (path === "/api/billing/checkout" || path === "/api/billing/portal")) {
      if (!admin) return fail(403, "Only an admin can change billing.");
      if (path.endsWith("checkout")) state.me.plan = { name: "Cloud", status: "active", periodEnd: "2026-12-18T00:00:00Z", includedEvals: 100, usedEvals: 0 };
      return json({ url: `${options.origin ?? ""}/__preview-stripe?${path.endsWith("checkout") ? "checkout" : "portal"}` });
    }
    if (method === "POST" && path === "/api/account/export") {
      const { tasks, runs, reports, endpoints, guardrails } = state;
      return json({ account: state.me.account, tasks, runs, reports, endpoints, guardrails });
    }
    if (method === "DELETE" && path === "/api/account") {
      if (!admin) return fail(403, "Only an admin can delete the account's data.");
      const fresh = emptyState();
      states.set(name, { ...fresh, me: state.me });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/disconnect") { state.disconnected += 1; return json({ ok: true }); }
    return fail(404, "Not found.");
  };
}
