// Tonic Ultra: a fictional growth marketing agency that runs leads, ads, reviews and booking
// for home and office maintenance companies. It is the preview's fully populated account for
// product work (?preview=tonic): six repositories, three agents, 19 tasks across most
// providers, three months of runs in every state, five endpoints of its own, and spend near its
// caps. The fake API's other scenarios keep the smaller Sahra Health account, which the tests
// use. Every name, number and price is fictional.
import { resolveGuardrails, type Guardrails, type Level } from "../../openmerit-core/src/engine/guardrails.ts";
import type { Endpoint, JobView, MeasuredModel, Report, Run, Task, TaskState } from "../api.ts";
import { repo, repoReview, type State } from "./fake-api.ts";

// Per call, on the task's typical prompt. eci is the catalogue's capability index; null is a model
// outside the catalogue.
const MODELS: Record<string, { cost: number; eci: number | null; latency: number }> = {
  "anthropic/claude-opus-5": { cost: 0.0121, eci: 158, latency: 4200 },
  "anthropic/claude-sonnet-5-5": { cost: 0.0036, eci: 152, latency: 2600 },
  "anthropic/claude-haiku-5-5": { cost: 0.0007, eci: 139, latency: 900 },
  "openai/gpt-5": { cost: 0.0047, eci: 150, latency: 3100 },
  "openai/gpt-5-mini": { cost: 0.00065, eci: 132, latency: 1800 },
  "openai/gpt-5-nano": { cost: 0.00015, eci: 118, latency: 1300 },
  "google/gemini-3-pro": { cost: 0.0031, eci: 151, latency: 2900 },
  "google/gemini-3-flash": { cost: 0.0004, eci: 138, latency: 950 },
  "deepseek/deepseek-v4": { cost: 0.0009, eci: 145, latency: 2300 },
  "deepseek/deepseek-v4-flash": { cost: 0.0003, eci: 130, latency: 1100 },
  "mistralai/mistral-medium-3-5": { cost: 0.0012, eci: 136, latency: 1500 },
  "mistralai/ministral-8b": { cost: 0.0001, eci: 112, latency: 600 },
  "qwen/qwen3-5-plus": { cost: 0.0008, eci: 140, latency: 1700 },
  "meta-llama/llama-4-maverick": { cost: 0.0004, eci: 128, latency: 1000 },
  "meta-llama/llama-4-scout": { cost: 0.00012, eci: 115, latency: 700 },
  "x-ai/grok-4-1-fast": { cost: 0.0003, eci: 134, latency: 800 },
  "moonshotai/kimi-k3": { cost: 0.0011, eci: 144, latency: 2000 },
  "tonic-leadscore-ft-3": { cost: 0.00008, eci: null, latency: 450 },
};

const endpoints: Endpoint[] = [
  { id: "ep_openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", allowedModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano"], keyLast4: "a81c", verifiedAt: "2026-09-02T09:10:00Z", builtIn: false },
  { id: "ep_anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", allowedModels: ["claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"], keyLast4: "7d0e", verifiedAt: "2026-09-02T09:12:00Z", builtIn: false },
  { id: "ep_fireworks", kind: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", allowedModels: ["tonic-leadscore-ft-3", "llama-4-maverick"], keyLast4: "f3b9", verifiedAt: "2026-10-14T15:30:00Z", builtIn: false },
  { id: "ep_groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", allowedModels: ["llama-4-scout", "kimi-k3"], keyLast4: "22c4", verifiedAt: "2026-10-21T11:05:00Z", builtIn: false },
  { id: "ep_mistral", kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", allowedModels: ["mistral-medium-3-5", "ministral-8b"], keyLast4: "0be1", verifiedAt: null, builtIn: false },
];

const short = (model: string): string => model.split("/").at(-1) ?? model;
// The customer's own endpoint for a model when it has one; otherwise OpenRouter, which OpenMerit pays for.
const endpointOf = (model: string): string => endpoints.find((item) => item.verifiedAt && Array.isArray(item.allowedModels) && item.allowedModels.includes(short(model)))?.id ?? "openrouter";

function measure(model: string, fields: Partial<MeasuredModel>): MeasuredModel {
  const facts = MODELS[model] ?? { cost: 0.0005, eci: null, latency: 1200 };
  const endpoint = endpointOf(model);
  return {
    model, endpoint, endpointModel: endpoint === "openrouter" ? model : short(model), role: "candidate", stage: facts.eci === null ? "challenger" : "search", eci: facts.eci,
    inCatalogue: facts.eci !== null, funding: endpoint === "openrouter" ? "openmerit" : "customer", status: "measured", passes: 0, total: 40,
    costPerCallUsd: facts.cost, costIsEstimate: facts.eci === null, latencyMs: facts.latency, qualified: false, note: "", ...fields,
  };
}

// Stable six-character run IDs, like the cloud app's.
let seed = 20261118;
function runId(): string {
  const letters = "abcdefghjkmnpqrstvwxyz23456789";
  let id = "";
  for (let i = 0; i < 6; i += 1) { seed = (seed * 1103515245 + 12345) % 2147483648; id += letters[seed % letters.length]; }
  return id;
}

type Outcome = "picked" | "keep_current" | "agent_eval_failed" | "baseline_failed" | "no_candidates" | "no_cases" | "running" | "queued" | "needs_input" | "failed" | "stopped";
// One run: when it started, how it ended, the model it picked, and whether a watch started it.
type Step = [at: string, outcome: Outcome, pick?: string | undefined, kind?: "watch"];
interface Spec {
  id: string; name: string; env: string; agent?: string; model: string; callsPerMonth: number;
  file: string; line: number; candidates: string[]; runs: Step[]; state?: TaskState; idleSince?: string;
}

const ENV = { leads: "tonic-ultra/leadflow", ads: "tonic-ultra/adstudio", reviews: "tonic-ultra/reputation", reports: "tonic-ultra/reporting", hvac: "tonic-ultra/fixright-hvac", clean: "tonic-ultra/sparkclean-offices" } as const;

const specs: Spec[] = [
  { id: "lead-qualifier", name: "Lead qualifier", env: ENV.leads, agent: "lead desk", model: "openai/gpt-5", callsPerMonth: 92_000, file: "src/qualify.ts", line: 22,
    candidates: ["anthropic/claude-haiku-5-5", "google/gemini-3-flash", "openai/gpt-5-mini", "tonic-leadscore-ft-3", "deepseek/deepseek-v4-flash"],
    runs: [["2026-09-04T10:12:00Z", "keep_current"], ["2026-10-02T09:00:00Z", "agent_eval_failed", undefined, "watch"], ["2026-11-17T14:20:00Z", "picked", "anthropic/claude-haiku-5-5"]] },
  { id: "job-classifier", name: "Job type classifier", env: ENV.leads, agent: "lead desk", model: "openai/gpt-5-mini", callsPerMonth: 120_000, file: "src/classify.ts", line: 9,
    candidates: ["mistralai/ministral-8b", "openai/gpt-5-nano", "meta-llama/llama-4-scout", "google/gemini-3-flash"],
    runs: [["2026-09-11T08:30:00Z", "picked", "openai/gpt-5-nano"], ["2026-11-14T08:30:00Z", "picked", "mistralai/ministral-8b", "watch"]] },
  { id: "spam-filter", name: "Spam lead filter", env: ENV.leads, agent: "lead desk", model: "anthropic/claude-haiku-5-5", callsPerMonth: 140_000, file: "src/spam.ts", line: 31,
    candidates: ["openai/gpt-5-nano", "meta-llama/llama-4-scout", "mistralai/ministral-8b"],
    runs: [["2026-10-09T16:00:00Z", "keep_current"], ["2026-11-09T16:00:00Z", "keep_current", undefined, "watch"]] },
  { id: "quote-estimator", name: "Quote estimator from job photos", env: ENV.leads, agent: "lead desk", model: "google/gemini-3-pro", callsPerMonth: 18_000, file: "src/quote.ts", line: 47,
    candidates: ["google/gemini-3-flash", "openai/gpt-5", "anthropic/claude-sonnet-5-5", "qwen/qwen3-5-plus"],
    runs: [["2026-10-28T13:00:00Z", "keep_current"], ["2026-11-18T11:52:00Z", "running"]] },
  { id: "call-summarizer", name: "Call transcript summarizer", env: ENV.leads, model: "openai/gpt-5", callsPerMonth: 64_000, file: "src/calls/summarize.ts", line: 15,
    candidates: ["deepseek/deepseek-v4", "anthropic/claude-haiku-5-5", "moonshotai/kimi-k3", "google/gemini-3-flash", "openai/gpt-5-mini"],
    runs: [["2026-09-18T10:00:00Z", "picked", "openai/gpt-5-mini"], ["2026-10-16T10:00:00Z", "stopped"], ["2026-11-16T10:00:00Z", "picked", "deepseek/deepseek-v4", "watch"]] },
  { id: "emergency-triage", name: "Emergency call triage", env: ENV.leads, model: "anthropic/claude-sonnet-5-5", callsPerMonth: 9_500, file: "src/calls/triage.ts", line: 12,
    candidates: ["anthropic/claude-haiku-5-5", "openai/gpt-5-mini", "google/gemini-3-flash"],
    runs: [["2026-10-01T07:45:00Z", "keep_current"], ["2026-11-01T07:45:00Z", "keep_current", undefined, "watch"]] },
  { id: "ad-copy", name: "Google Ads copy writer", env: ENV.ads, agent: "ads studio", model: "anthropic/claude-sonnet-5-5", callsPerMonth: 41_000, file: "src/copy/google.ts", line: 28,
    candidates: ["qwen/qwen3-5-plus", "anthropic/claude-haiku-5-5", "openai/gpt-5-mini", "moonshotai/kimi-k3"],
    runs: [["2026-09-25T12:00:00Z", "keep_current"], ["2026-11-13T12:10:00Z", "picked", "qwen/qwen3-5-plus"]] },
  { id: "meta-ad-variants", name: "Meta ad variants", env: ENV.ads, agent: "ads studio", model: "openai/gpt-5", callsPerMonth: 36_000, file: "src/copy/meta.ts", line: 19,
    candidates: ["anthropic/claude-haiku-5-5", "x-ai/grok-4-1-fast", "google/gemini-3-flash"],
    runs: [["2026-10-20T09:00:00Z", "picked", "google/gemini-3-flash"], ["2026-11-18T11:31:00Z", "needs_input"]] },
  { id: "seo-pages", name: "Local SEO page writer", env: ENV.ads, model: "openai/gpt-5", callsPerMonth: 150_000, file: "src/seo/pages.ts", line: 40,
    candidates: ["google/gemini-3-flash", "deepseek/deepseek-v4", "meta-llama/llama-4-maverick", "mistralai/mistral-medium-3-5", "openai/gpt-5-mini"],
    runs: [["2026-09-08T15:00:00Z", "baseline_failed"], ["2026-09-09T11:00:00Z", "picked", "deepseek/deepseek-v4"], ["2026-11-15T09:30:00Z", "picked", "google/gemini-3-flash", "watch"]] },
  { id: "keyword-clusters", name: "Keyword clusterer", env: ENV.ads, model: "openai/gpt-5-nano", callsPerMonth: 22_000, file: "src/seo/keywords.ts", line: 8, state: "frozen",
    candidates: [], runs: [["2026-10-07T10:00:00Z", "no_candidates"], ["2026-11-07T10:00:00Z", "no_candidates", undefined, "watch"]] },
  { id: "creative-brief", name: "Creative brief summarizer", env: ENV.ads, agent: "ads studio", model: "anthropic/claude-sonnet-5-5", callsPerMonth: 3_200, file: "src/briefs.ts", line: 11, state: "retired",
    candidates: ["anthropic/claude-haiku-5-5", "openai/gpt-5-mini"], runs: [["2026-11-10T17:20:00Z", "no_cases"]] },
  { id: "review-responder", name: "Google review responder", env: ENV.reviews, model: "openai/gpt-5", callsPerMonth: 27_000, file: "src/respond.ts", line: 33,
    candidates: ["moonshotai/kimi-k3", "anthropic/claude-haiku-5-5", "mistralai/mistral-medium-3-5", "openai/gpt-5-mini"],
    runs: [["2026-09-30T08:00:00Z", "keep_current"], ["2026-10-30T08:00:00Z", "keep_current", undefined, "watch"], ["2026-11-12T08:40:00Z", "picked", "moonshotai/kimi-k3"]] },
  { id: "review-sentiment", name: "Review sentiment tagger", env: ENV.reviews, model: "openai/gpt-5-mini", callsPerMonth: 55_000, file: "src/sentiment.ts", line: 6,
    candidates: ["meta-llama/llama-4-scout", "mistralai/ministral-8b", "openai/gpt-5-nano"],
    runs: [["2026-10-12T09:00:00Z", "picked", "meta-llama/llama-4-scout"], ["2026-11-12T09:00:00Z", "picked", "meta-llama/llama-4-scout", "watch"]] },
  { id: "weekly-report", name: "Weekly client report writer", env: ENV.reports, agent: "client reporting", model: "anthropic/claude-opus-5", callsPerMonth: 1_400, file: "src/weekly.ts", line: 52,
    candidates: ["anthropic/claude-sonnet-5-5", "google/gemini-3-pro", "openai/gpt-5", "deepseek/deepseek-v4"],
    runs: [["2026-10-05T06:00:00Z", "agent_eval_failed"], ["2026-11-02T06:00:00Z", "agent_eval_failed", undefined, "watch"], ["2026-11-18T11:58:00Z", "queued"]] },
  { id: "anomaly-explainer", name: "Campaign anomaly explainer", env: ENV.reports, agent: "client reporting", model: "openai/gpt-5", callsPerMonth: 2_100, file: "src/anomalies.ts", line: 18,
    candidates: ["anthropic/claude-sonnet-5-5", "google/gemini-3-flash"], runs: [["2026-11-06T13:15:00Z", "failed"]] },
  { id: "booking-chat", name: "Booking chat agent", env: ENV.hvac, agent: "booking concierge", model: "openai/gpt-5", callsPerMonth: 48_000, file: "src/chat/agent.ts", line: 64,
    candidates: ["anthropic/claude-haiku-5-5", "openai/gpt-5-mini", "x-ai/grok-4-1-fast", "google/gemini-3-flash"],
    runs: [["2026-10-23T10:00:00Z", "agent_eval_failed"], ["2026-11-18T11:47:00Z", "running"]] },
  { id: "slot-extractor", name: "Appointment slot extractor", env: ENV.hvac, agent: "booking concierge", model: "openai/gpt-5-mini", callsPerMonth: 48_000, file: "src/chat/slots.ts", line: 21,
    candidates: ["x-ai/grok-4-1-fast", "openai/gpt-5-nano", "mistralai/ministral-8b"],
    runs: [["2026-10-23T10:20:00Z", "picked", "x-ai/grok-4-1-fast"]] },
  { id: "rfp-reader", name: "Office cleaning RFP reader", env: ENV.clean, model: "anthropic/claude-sonnet-5-5", callsPerMonth: 600, file: "src/rfp.ts", line: 14, state: "idle", idleSince: "2026-10-15T14:00:00Z",
    candidates: ["google/gemini-3-pro", "anthropic/claude-haiku-5-5", "deepseek/deepseek-v4"],
    runs: [["2026-09-15T14:00:00Z", "keep_current"]] },
  { id: "invoice-disputes", name: "Invoice dispute triage", env: ENV.clean, model: "openai/gpt-5", callsPerMonth: 1_800, file: "src/disputes.ts", line: 26,
    candidates: [], runs: [] },
];

// The coding agents each repository's team works in, by the MCP client name each sends; the
// reporting repository's runner is the agency's own harness.
const AGENTS: Record<string, string[]> = {
  [ENV.leads]: ["claude-code", "claude-code", "codex"], [ENV.ads]: ["codex", "cursor", "codex"], [ENV.reviews]: ["pi", "pi", "opencode"],
  [ENV.reports]: ["tonic-ops-runner"], [ENV.hvac]: ["claude-code", "gemini-cli"], [ENV.clean]: ["amp"],
};

const LIVE = new Set<Outcome>(["running", "queued", "needs_input", "failed", "stopped"]);
const guardrailsFor = (spec: Spec): Report["guardrails"] => resolveGuardrails({
  environment: environmentGuardrails[spec.env] ?? {},
  ...(spec.agent ? { agent: agentGuardrails[`${spec.env}:${spec.agent}`] ?? {} } : {}),
  task: taskGuardrails[spec.id] ?? {},
});

function report(spec: Spec, id: string, at: string, outcome: Outcome, pick: string | undefined, index: number): Report {
  const total = 40 - (index % 3) * 4;
  const baseline = measure(spec.model, { role: "baseline", stage: "baseline", total, passes: outcome === "baseline_failed" ? Math.round(total * 0.55) : total - 1 });
  const target = baseline.passes;
  const candidates = outcome === "no_candidates" || outcome === "no_cases" || outcome === "baseline_failed" ? [] : spec.candidates.map((model, i): MeasuredModel => {
    if (model === pick) return measure(model, { passes: target + (i % 2), total, qualified: true });
    if (i === spec.candidates.length - 1 && spec.candidates.length > 3) return measure(model, { stage: "neighbour", status: "unavailable", passes: 0, total: 0, costPerCallUsd: null, latencyMs: null, note: "provider returned 503" });
    if (i % 3 === 2) return measure(model, { status: "screened_out", passes: 2, total: 5 });
    return measure(model, { passes: target - 2 - i, total, note: `${2 + i} cases below the current model` });
  });
  const picked = candidates.find((item) => item.qualified) ?? null;
  const status = outcome as Report["status"];
  // The notices the cloud app sends with these outcomes, and their fixes.
  const rails = guardrailsFor(spec), budget = rails.effective.budgetUsd ?? 5;
  const challengers = status === "picked" && index % 3 === 0 ? `Challengers not measured: \`x-ai/grok-4.6\`. Stopped while measuring x-ai/grok-4.6: $${budget.toFixed(4)} used or reserved of the $${budget.toFixed(2)} budget for this job.` : null;
  const labels = status === "baseline_failed" ? `${short(spec.model)} passed ${baseline.passes} of ${total} cases, below this environment's 90% minimum, so nothing was compared against it.` : null;
  const saving = picked?.costPerCallUsd != null && baseline.costPerCallUsd != null ? baseline.costPerCallUsd - picked.costPerCallUsd : null;
  const best = candidates.filter((item) => item.status === "measured").sort((a, b) => b.passes - a.passes)[0];
  const openmerit = candidates.concat(baseline).filter((item) => item.funding === "openmerit").length * 0.31 + total * 0.004;
  const customer = candidates.concat(baseline).filter((item) => item.funding === "customer").length * 0.22;
  return {
    jobId: id, task: spec.name, createdAt: at, status,
    pick: status === "picked" && picked ? { model: picked.model, endpoint: picked.endpoint, endpointModel: picked.endpointModel, passes: picked.passes, total, costPerCallUsd: picked.costPerCallUsd, savingPerCallUsd: saving } : null,
    top: status === "picked" && picked ? [picked] : [], baseline, candidates,
    search: {
      pool: 9 + spec.candidates.length * 2, unplaced: spec.candidates.some((model) => MODELS[model]?.eci === null) ? 1 : 0, samples: ["c02", "c05", "c11", "c19", "c27"].slice(0, 3 + (index % 3)),
      finalists: candidates.filter((item) => item.status === "measured").slice(0, 2).map((item) => item.model), challengers: candidates.filter((item) => item.stage === "challenger").map((item) => item.model),
      shortfall: outcome === "no_candidates" ? "Every catalogue model cheaper than the one in use is from a provider this environment does not allow." : null,
    },
    agentEval: !spec.agent ? null : status === "agent_eval_failed" && best
      ? { status: "checked", passed: false, warning: null, baseline: { passes: 18, total: 20 }, tried: [{ model: best.model, passes: 15, total: 20, passed: false }] }
      : status === "picked" && picked ? { status: "checked", passed: true, warning: null, baseline: { passes: 18, total: 20 }, tried: [{ model: picked.model, passes: 19, total: 20, passed: true }] } : null,
    edit: status === "picked" && picked
      ? { edits: [{ file: spec.file, line: spec.line, before: short(spec.model), after: short(picked.model) }], instructions: picked.endpoint === "openrouter" ? "Call it on OpenRouter (https://openrouter.ai/api/v1) with your own OpenRouter key." : `Call it on ${picked.endpoint}, which this account already uses.` }
      : { edits: [], instructions: null },
    spend: { openmeritUsd: Math.round(openmerit * 100) / 100, customerUsd: Math.round(customer * 100) / 100 },
    guardrails: rails,
    notices: ["118 catalogue models without an ECI left out: the search places models by their capability index.", ...(challengers ? [challengers] : []), ...(labels ? [labels] : [])],
    fixes: [
      ...(challengers ? [{ kind: "raise_budget" as const, notice: challengers, budgetUsd: Math.ceil(budget * 2) }] : []),
      ...(labels ? [{ kind: "ask_agent" as const, notice: labels, prompt: `${spec.model}, the model the task "${spec.name}" uses now, failed most of OpenMerit's test cases, so their expected answers may be wrong. Show the user the expected answers in the task bundle's examples, correct the wrong ones with them, and add examples the current model gets right; then call openmerit_recommend again.` }] : []),
    ],
    reportUrl: `https://openmerit.ai/api/r/${id}.md`, catalogueVersion: at.slice(0, 10), cases: { total, fromExamples: 6 + (index % 4) * 2, written: total - 6 - (index % 4) * 2 },
  };
}

function job(spec: Spec, id: string, at: string, outcome: Outcome): JobView {
  const cheapest = spec.candidates.slice().sort((a, b) => (MODELS[a]?.cost ?? 1) - (MODELS[b]?.cost ?? 1))[0];
  return {
    jobId: id, taskId: spec.id, task: spec.name, status: outcome as JobView["status"],
    phase: { running: "ranking", queued: "queued", needs_input: "label_check", failed: "cases", stopped: "ranking" }[outcome as "running"] ?? "ranking",
    questions: outcome === "needs_input" ? [{ id: "label_check", kind: "multi", prompt: "Which written cases have the right answer?" }] : [], notices: [],
    progress: outcome === "running" ? { measured: spec.id === "booking-chat" ? 7 : 21, planned: spec.id === "booking-chat" ? 36 : 28 } : outcome === "stopped" ? { measured: 9, planned: 30 } : { measured: 0, planned: null },
    result: null,
    error: outcome === "failed" ? "The task's examples had no expected outputs, and no case could be written from them." : outcome === "stopped" ? "stopped by Jordan Pike from the coding agent" : null,
    provisional: (outcome === "running" || outcome === "queued" || outcome === "needs_input") && cheapest ? { model: cheapest, endpoint: endpointOf(cheapest), reason: "The cheapest catalogue model above the current one's capability index.", estCostPerCallUsd: MODELS[cheapest]?.cost ?? null } : null,
    createdAt: at, report: null,
  };
}

const environmentGuardrails: Record<string, Guardrails> = {
  [ENV.leads]: { allowedProviders: ["openai", "anthropic", "google", "deepseek", "mistralai", "meta-llama", "moonshotai", "openrouter", "fireworks"], spendCapUsd: 60, customerSpendCapUsd: 40, repeats: 3, minPassRate: 0.9, watch: true, actionPolicy: "open_pr" },
  [ENV.ads]: { allowedProviders: ["openai", "anthropic", "google", "deepseek", "qwen", "x-ai", "meta-llama", "mistralai", "moonshotai", "openrouter"], spendCapUsd: 50, repeats: 2, minPassRate: 0.9, watch: true, actionPolicy: "ask_first" },
  [ENV.reviews]: { allowedProviders: ["openai", "anthropic", "mistralai", "meta-llama", "moonshotai", "openrouter", "groq"], spendCapUsd: 25, minPassRate: 0.92, watch: true, actionPolicy: "open_pr" },
  [ENV.reports]: { spendCapUsd: 30, budgetUsd: 6, minPassRate: 0.95, actionPolicy: "instructions_only" },
  [ENV.hvac]: { allowedProviders: ["openai", "anthropic", "google", "x-ai", "mistralai", "openrouter"], spendCapUsd: 20, latencyMs: 1500, watch: true, actionPolicy: "ask_first" },
  [ENV.clean]: { region: "eu", spendCapUsd: 10, actionPolicy: "ask_first" },
};
const agentGuardrails: Record<string, Guardrails> = {
  [`${ENV.leads}:lead desk`]: { agentEvalRequired: "required", minAgentPassRate: 0.9 },
  [`${ENV.ads}:ads studio`]: { agentEvalRequired: "warn", repeats: 3 },
  [`${ENV.reports}:client reporting`]: { agentEvalRequired: "required", minAgentPassRate: 0.95 },
  [`${ENV.hvac}:booking concierge`]: { agentEvalRequired: "required", minAgentPassRate: 0.9, latencyMs: 1200 },
};
const taskGuardrails: Record<string, Guardrails> = {
  "emergency-triage": { minPassRate: 1, latencyMs: 2000, allowedProviders: ["openai", "anthropic", "openrouter"] },
  "quote-estimator": { budgetUsd: 12, repeats: 2 },
  "seo-pages": { minPassRate: 0.85 },
  "booking-chat": { latencyMs: 1000 },
};

export function tonicUltra(): State {
  seed = 20261118;
  const tasks: Task[] = [], runs: Run[] = [], reports: Record<string, Report> = {}, jobs: Record<string, JobView> = {};
  for (const spec of specs) {
    const steps = spec.runs.map(([at, outcome, pick, kind], index) => ({ id: runId(), at, outcome, pick, kind: kind ?? "run", index }));
    for (const step of steps) {
      const done = !LIVE.has(step.outcome);
      runs.push({ id: step.id, taskId: spec.id, kind: step.kind, status: done ? "done" : step.outcome, startedAt: step.at, finishedAt: done || step.outcome === "failed" || step.outcome === "stopped" ? step.at : null, askedBy: step.kind === "watch" ? null : AGENTS[spec.env]?.[step.index % (AGENTS[spec.env]?.length ?? 1)] ?? null, result: null });
      if (done) reports[step.id] = report(spec, step.id, step.at, step.outcome, step.pick, step.index);
      else jobs[step.id] = job(spec, step.id, step.at, step.outcome);
    }
    const latest = steps.at(-1);
    // A run waiting for an answer leaves the task showing its last result.
    const shown = latest?.outcome === "needs_input" ? steps.at(-2) ?? latest : latest;
    const status = !shown ? "new" : shown.outcome === "queued" ? "running" : shown.outcome;
    const pick = status === "picked" ? shown?.pick ?? null : null;
    const saving = pick ? Math.round(((MODELS[spec.model]?.cost ?? 0) - (MODELS[pick]?.cost ?? 0)) * spec.callsPerMonth) : null;
    tasks.push({ id: spec.id, environment: spec.env, agent: spec.agent ?? null, name: spec.name, currentModel: spec.model, pick, status, watching: (spec.state ?? "watching") === "watching", state: spec.state ?? "watching", idleSince: spec.idleSince ?? null, lastRunAt: latest?.at ?? null, lastJobId: shown?.id ?? null, monthlySavingUsd: saving });
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const ordered = tasks.slice().sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
  return {
    me: { user: { id: "user_jordan" }, account: { id: "org_tonic", name: "Tonic Ultra" }, role: "admin", plan: { name: "Cloud", status: "active", periodEnd: "2026-12-01T00:00:00Z", includedEvals: 100, usedEvals: 87 } },
    tasks: ordered, runs, reports, jobs, endpoints: endpoints.map((item) => ({ ...item })),
    // Each repository the agency's tasks come from, reviewed: every task's model call. The reporting repository is private.
    repos: Object.values(ENV).map((env, index) => repo(env, {
      private: env === ENV.reports, tokenLast4: env === ENV.reports ? "7d0a" : null, addedAt: `2026-09-0${index + 1}T09:00:00Z`,
      result: repoReview({ files: 60 + index * 37, modelCalls: specs.filter((spec) => spec.env === env).map((spec) => ({ file: spec.file, line: spec.line, value: spec.model, catalogueId: spec.model, dynamic: false, envVar: null })) }),
    })),
    spend: { openmeritUsd: 211.4, customerUsd: 143.85, monthlyCapUsd: 250, customerCapUsd: 200, period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } },
    guardrails: { environment: structuredClone(environmentGuardrails), agent: structuredClone(agentGuardrails), task: structuredClone(taskGuardrails) } satisfies Record<Level, Record<string, Guardrails>>,
    disconnected: 0, deleted: [], evals: {}, drafts: [],
  };
}
