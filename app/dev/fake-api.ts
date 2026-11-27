// A local fake of the cloud app's /api/* (openmerit-core/src/server/api.ts) for the preview server and
// tests, with the same paths, shapes, admin checks and validation messages. Guardrails
// resolve with openmerit/engine's resolver, as in the cloud app. The bearer token picks a
// scenario: preview-tonic (the fully populated Tonic Ultra account in tonic-ultra.ts),
// preview-populated, preview-empty, preview-noplan, preview-member, preview-neworg (an organization
// just created), preview-noorg (a token without an organization), preview-error, preview-slow and preview-expired. Each scenario keeps its own in-memory
// state, so actions change what later requests return. Every name and number is fictional.
import { GUARDRAIL_KINDS, LEVELS, resolveGuardrails, type Guardrails, type Level } from "../../openmerit-core/src/engine/guardrails.ts";
import type { Decision, DeletedTask, Endpoint, Project, EvalAccepted, EvalCase, EvalDraft, EvalRevision, EvalSpec, EvalView, GitHubAccess, JobView, LiveProgress, MeasuredModel, Me, Repo, RepoReview, Report, Run, Spend, Subscriptions, Task, TaskOutput } from "../api.ts";
import { tonicUltra } from "./tonic-ultra.ts";

// A task's eval in the fake: the accepted one, any draft under review, and the task's output shape.
export interface FakeEval { accepted: Omit<EvalAccepted, "runs">; draft: EvalRevision | null; output: TaskOutput }
const later = new Date(Date.now() + 23 * 3600_000).toISOString();
const confirmations: Record<string, { id: string; title: string; items: string[]; checks: "person" | "reverify"; requestedVia: string | null; status: string; createdAt: string; expiresAt: string; result: { status: number; body: unknown } | null }> = {
  budget: { id: "budget", title: "Run support ticket triage again with a budget of $8 per job", items: ["Raises the task's budget per job to $8, then starts a paid run"], checks: "reverify", requestedVia: "claude-code", status: "pending", createdAt: new Date().toISOString(), expiresAt: later, result: null },
  switch: { id: "switch", title: "Approve the switch for support ticket triage", items: ["openai/gpt-5.4 → google/gemini-3-flash (openrouter)", "src/triage/classify.ts:14: const MODEL = \"openai/gpt-5.4\"; → const MODEL = \"google/gemini-3-flash\";"], checks: "person", requestedVia: "codex", status: "pending", createdAt: new Date().toISOString(), expiresAt: later, result: null },
};

export interface State { me: Me; tasks: Task[]; runs: Run[]; reports: Record<string, Report>; jobs: Record<string, JobView>; endpoints: Endpoint[]; repos: Repo[]; spend: Spend; guardrails: Record<Level, Record<string, Guardrails>>; disconnected: number; deleted: DeletedTask[]; evals: Record<string, FakeEval>; drafts: EvalDraft[] }

// What a project other than the default holds; the State's own fields are the default project's.
const SLICE = ["tasks", "runs", "endpoints", "repos", "guardrails", "deleted", "evals", "drafts"] as const;
type Slice = Pick<State, (typeof SLICE)[number]>;
const emptySlice = (): Slice => ({ tasks: [], runs: [], endpoints: [], repos: [], guardrails: { environment: {}, task: {} }, deleted: [], evals: {}, drafts: [] });

const ROUTER_OUTPUT: TaskOutput = { kind: "label", labels: ["claims", "billing", "enrollment", "clinical", "other"] };
const routerCase = (id: string, ticket: string, expected: string | undefined, origin: EvalCase["origin"], fields: Partial<EvalCase> = {}): EvalCase => ({ id, input: { ticket }, ...(expected === undefined ? {} : { expected }), origin, ...fields });
// Version 2 dropped a duplicate case and fixed one answer in the app.
function routerEval(): FakeEval {
  const spec: EvalSpec = {
    description: "Routes an incoming member ticket to the team that handles it.",
    input: { description: "A member's support message, often forwarded from email, sometimes with a claim number." },
    criteria: ["Picks the one queue whose team can resolve the ticket", "Treats a claim number with a billing question as billing"],
    guardrails: ["Never routes a ticket that mentions self-harm anywhere but clinical"],
  };
  const cases: EvalCase[] = [
    routerCase("example-1", "My claim CLM-20931 was denied, why?", "claims", "example"),
    routerCase("example-2", "I was charged twice for my November premium", "billing", "example"),
    routerCase("example-3", "How do I add my newborn to my plan?", "enrollment", "example"),
    routerCase("written-1", "Fwd: invoice for claim CLM-11872 shows the wrong amount", "billing", "written", { kind: "edge", approved: true }),
    routerCase("written-2", "Can my doctor prescribe a 90-day supply?", "clinical", "written", { kind: "typical", approved: true }),
    routerCase("written-4", "I feel hopeless since my diagnosis and can't pay", "clinical", "written", { kind: "guardrail", approved: true }),
  ];
  return {
    output: ROUTER_OUTPUT, draft: null,
    accepted: { version: 2, source: "app", by: "user_amira", byName: "Amira Haddad", at: "2026-11-18T10:01:00Z", spec, cases },
  };
}

// The coding agent sent the reply drafter with a new tool, so its eval waits for review and the task's runs wait for it.
function drafterEval(): FakeEval {
  const spec: EvalSpec = { criteria: ["Answers the member's question in plain language", "Offers the next step"] };
  const cases: EvalCase[] = [{ id: "written-1", input: { message: "When will my reimbursement arrive?" }, expected: "Reimbursements arrive within 14 days of approval; the member can track it under Claims.", origin: "written", kind: "typical", approved: true }];
  return {
    output: { kind: "text" },
    // Accepted by grading its first run's answers (run m5d8q2).
    accepted: { version: 1, source: "grading", by: "user_amira", byName: "Amira Haddad", at: "2026-11-18T08:31:00Z", spec, cases },
    draft: { reason: "task_changed", changed: ["tools"], spec, cases: [...cases, { id: "example-1", input: { message: "Where is claim CLM-30112?" }, origin: "example" }], output: { kind: "text" }, by: null, at: "2026-11-23T15:12:00Z" },
  };
}

// The member's subscriptions, kept beside each scenario's state.
// The organization's projects and the member's subscriptions, kept beside each scenario's state.
interface Extra { projects: { id: string; name: string; createdAt: string }[]; slices: Record<string, Slice>; subscriptions: Subscriptions; polls: number }
function extra(name: string): Extra {
  const projects = [{ id: "default", name: name === "tonic" ? "Tonic platform" : name === "populated" || name === "member" || name === "noplan" ? "Claims" : "Default project", createdAt: "2026-10-01T09:00:00Z" }];
  if (name === "tonic" || name === "populated" || name === "member") projects.push({ id: "prj_enrollment", name: "Enrollment", createdAt: "2026-11-21T09:00:00Z" });
  return {
    projects, slices: Object.fromEntries(projects.slice(1).map((item) => [item.id, emptySlice()])), polls: 0,
    subscriptions: { writer: "openmerit", subscriptions: [
      { provider: "chatgpt", name: "ChatGPT", connected: false, connectedAt: null, problem: null, signIn: null },
    ] },
  };
}

function seedDrafts(): EvalDraft[] {
  const bundle = (task: string, output: TaskOutput, spec: EvalSpec) => ({ task, current: { model: "openai/gpt-5" }, output, ...spec });
  return [
    { id: "draft_summary", projectId: "default", repoId: "repo_sahrahealthclaimsapi", environment: "sahra-health/claims-api", name: "Claim summary writer", status: "pending", createdAt: "2026-11-23T16:02:00Z", taskId: null,
      bundle: bundle("Claim summary writer", { kind: "text" }, { description: "Writes a two-sentence summary of a claim for the adjuster's queue.", criteria: ["States the claim's amount and its service date", "Says whether a prior authorization is on file"], guardrails: ["Never includes the member's diagnosis codes"] }),
      cases: [
        { id: "example-1", input: { claim: "CLM-30112: MRI lumbar spine, $1,840, 2026-10-02, PA-7781 approved" }, expected: "An MRI of the lumbar spine on 2 October 2026 for $1,840, with prior authorization PA-7781 approved.", origin: "example" },
        { id: "example-2", input: { claim: "CLM-30140: physical therapy x6, $720, 2026-10-09, no PA" }, expected: "Six physical therapy sessions from 9 October 2026 for $720; no prior authorization is on file.", origin: "example" },
        { id: "example-3", input: { claim: "CLM-30177: ER visit, $3,210, 2026-10-15, PA not required" }, origin: "example" },
      ] },
    { id: "draft_denial", projectId: "default", repoId: "repo_sahrahealthclaimsapi", environment: "sahra-health/claims-api", name: "Denial letter checker", status: "pending", createdAt: "2026-11-23T16:02:00Z", taskId: null,
      bundle: bundle("Denial letter checker", { kind: "label", labels: ["complete", "missing_reason", "missing_appeal_rights"] }, { criteria: ["A letter with a reason and appeal rights is complete"] }),
      cases: [
        { id: "example-1", input: { letter: "Your claim was denied: the service is not covered. You may appeal within 180 days." }, expected: "complete", origin: "example" },
        { id: "example-2", input: { letter: "Your claim was denied. Contact us with questions." }, expected: "missing_reason", origin: "example" },
      ] },
  ];
}
const ENV = "sahra-health/claims";
const measured = (model: string, endpoint: string, fields: Partial<MeasuredModel>): MeasuredModel => ({
  model, endpoint, endpointModel: model.split("/").at(-1) ?? model, role: "candidate", stage: "search", eci: 120, inCatalogue: true, funding: "openmerit",
  status: "measured", passes: 38, total: 40, costPerCallUsd: 0.0001, costIsEstimate: false, latencyMs: 900, qualified: false, note: "", ...fields,
});

// A repository's review, as the cloud app returns it: its model calls, and the task specs when the reviewer wrote them.
export function repoReview(fields: Partial<RepoReview> & Pick<RepoReview, "modelCalls">): RepoReview {
  const groups = new Map<string, RepoReview["models"][number]>();
  for (const call of fields.modelCalls.filter((item) => !item.dynamic || item.catalogueId)) {
    const key = call.catalogueId ?? call.value;
    const group = groups.get(key) ?? { value: key, catalogueId: call.catalogueId, calls: 0 };
    group.calls += 1;
    groups.set(key, group);
  }
  return { reviewer: "scan", commit: "4be1c07d9a3f2e6b8c5d1a0f7e9b3c2d4a6f8e10", branch: "main", files: 214, bytes: 3_400_000, models: [...groups.values()].sort((a, b) => b.calls - a.calls),
    totalCalls: fields.modelCalls.length, supportCalls: 0, notListed: null, tasks: [], durationMs: 6200, ...fields };
}
export function repo(fullName: string, fields: Partial<Repo> & { result?: RepoReview | null; status?: Repo["review"]["status"]; error?: string | null }): Repo {
  const { result = null, status = "done", error = null, ...rest } = fields;
  return {
    id: `repo_${fullName.replace(/\W/g, "")}`, fullName, url: `https://github.com/${fullName}`, private: false, defaultBranch: "main", tokenLast4: null, access: "public", githubUser: null, addedAt: "2026-11-20T09:00:00Z", checkedAt: "2026-11-20T09:00:00Z",
    review: { status, requestedAt: "2026-11-20T09:00:00Z", finishedAt: status === "done" || status === "failed" ? "2026-11-20T09:00:07Z" : null, error, result }, ...rest,
  };
}
const call = (file: string, line: number, value: string, catalogueId: string | null, envVar: string | null = null) => ({ file, line, value, catalogueId, dynamic: envVar !== null, envVar });

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
    task("reply-drafter", "Reply drafter", { state: "review", watching: false, pick: "anthropic/claude-haiku-5-5", status: "picked", monthlySavingUsd: 96.4, lastRunAt: "2026-11-18T08:30:00Z", lastJobId: "m5d8q2" }),
    task("coding-reviewer", "Coding reviewer", { currentModel: "anthropic/claude-sonnet-5-5", status: "failed", lastRunAt: "2026-11-12T10:00:00Z", lastJobId: "z1c7m4" }),
  ];
  const run = (id: string, taskId: string, status: string, startedAt: string, kind = "run", askedBy: string | null = kind === "watch" ? null : "claude-code"): Run => ({ id, taskId, kind, status, startedAt, finishedAt: status === "done" || status === "failed" ? startedAt : null, askedBy, result: null });
  const runs: Run[] = [
    run("e4n6t0", "enrollment-checker", "running", "2026-11-18T11:40:00Z"),
    run("w8r3k1", "ticket-router", "needs_input", "2026-11-18T11:20:00Z"),
    run("g4r9d2", "coding-reviewer", "needs_input", "2026-11-18T11:30:00Z"),
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
    pick: { model: haiku.model, endpoint: "openrouter", endpointModel: "anthropic/claude-haiku-5-5", passes: 40, total: 40, costPerCallUsd: 0.00007, savingPerCallUsd: 0.00468, paybackCalls: 412 },
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
      // Picked after two rounds of grading against the eval's checks, and the coding agent has not sent the user's answer yet.
      m5d8q2: { ...report, jobId: "m5d8q2", task: "Reply drafter", createdAt: "2026-11-18T08:50:00Z", decision: null,
        grading: { rounds: 2, accepted: true, bar: "criteria", failedChecks: ["G2"], summary: "Your current model fails 1 of your checks (G2); the cheapest model that passes them is anthropic/claude-haiku-5-5, at $0.40 less per 1,000 calls." } }, f9q2w7: keep, p3x8d1: failedEval,
      b2v5h3: { ...report, jobId: "b2v5h3", createdAt: "2026-10-30T10:20:00Z", pick: { ...report.pick!, model: "openai/gpt-5-mini", endpoint: "ep_openai", endpointModel: "gpt-5-mini", passes: 39, costPerCallUsd: 0.00065, savingPerCallUsd: 0.0041 }, top: [], nearMisses: [], decision: declined,
        edit: { edits: [{ file: "src/triage.ts", line: 14, before: 'process.env.TRIAGE_MODEL ?? "gpt-5"', after: 'process.env.TRIAGE_MODEL ?? "gpt-5-mini"' }], instructions: null } },
    },
    jobs: {
      e4n6t0: job("e4n6t0", "enrollment-checker", "Enrollment checker", {}),
      w8r3k1: job("w8r3k1", "ticket-router", "Ticket router", { status: "needs_input", phase: "label_check", questions: [{ id: "label_check", kind: "multi", prompt: "Which written cases have the right answer?" }], progress: { measured: 0, planned: null }, createdAt: "2026-11-18T11:20:00Z" }),
      // The grading loop: a person grades two sampled answers, as openmerit-core's gradeQuestions words them, without the eval's own grade.
      g4r9d2: job("g4r9d2", "coding-reviewer", "Coding reviewer", { status: "needs_input", phase: "grading", progress: { measured: 14, planned: 14 }, createdAt: "2026-11-18T11:30:00Z", questions: [
        { id: "grade_coding_reviewer_r1_1", kind: "choice", prompt: "Coding reviewer, answer 1 of 2: is this answer right?", options: [{ value: "good", label: "Right answer" }, { value: "bad", label: "Wrong answer" }], hint: "or bad: <why> to add a note. A person answers this, not a coding agent.",
          detail: 'anthropic/claude-sonnet-5.5 (your current model), typical case written-1\nInput:\n{\n  "claim_id": "FICT-CLM-1101"\n}\nAnswer:\nI recorded one info finding: the coding is in order and I found no problems.\nTool calls: get_claim({}); record_coding_review({"findings":[{"code":"ALL","severity":"info","kind":"other","message":"All codes valid for 2024."}]})' },
        { id: "grade_coding_reviewer_r1_2", kind: "choice", prompt: "Coding reviewer, answer 2 of 2: is this answer right?", options: [{ value: "good", label: "Right answer" }, { value: "bad", label: "Wrong answer" }], hint: "or bad: <why> to add a note. A person answers this, not a coding agent.",
          detail: 'google/gemini-4-carbon (a candidate), edge case written-8\nInput:\n{\n  "claim_id": "FICT-CLM-1108"\n}\nAnswer:\nR5O.9 is not a valid 2024 ICD-10-CM code, and 85027 is included in 85025 on the same claim.\nTool calls: get_claim({}); record_coding_review({"findings":[{"code":"R5O.9","severity":"error","kind":"invalid_code"}]})' },
      ] }),
      z1c7m4: job("z1c7m4", "coding-reviewer", "Coding reviewer", { status: "failed", phase: "cases", error: "The task's examples had no known answers, and no case could be written from it.", provisional: null, createdAt: "2026-11-12T10:00:00Z" }),
    },
    endpoints: [
      { id: "ep_openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", allowedModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano"], keyLast4: "4f2a", verifiedAt: "2026-11-12T09:00:00Z", builtIn: false },
      { id: "ep_baseten", kind: "openai-compatible", baseUrl: "https://model-7q2.api.baseten.co/v1", allowedModels: ["sahra-triage-ft-2"], keyLast4: "91be", verifiedAt: null, builtIn: false },
    ],
    repos: [
      repo("sahra-health/claims-api", { private: true, tokenLast4: "9c1e", result: repoReview({ modelCalls: [
        call("src/triage.ts", 14, "gpt-5", "openai/gpt-5", "TRIAGE_MODEL"), call("src/claims/match.ts", 41, "anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"),
        call("src/claims/fraud.ts", 22, "anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"), call("src/replies/draft.py", 8, "gpt-5", "openai/gpt-5"),
        call("config/models.yaml", 3, "gpt-5-mini", "openai/gpt-5-mini"), call("src/replies/draft.py", 31, "settings.reply_model", null),
      ], supportCalls: 3, notListed: "3 more in tests, fixtures or docs, not listed", reviewer: "review", costUsd: 0.38,
        tasks: [
          { task: "claim triage", description: "Sorts an incoming claim into its review queue.", output: { kind: "label", labels: ["auto-approve", "adjuster", "fraud-review"] }, codeRefs: [{ file: "src/triage.ts", line: 14 }],
            criteria: ["Sends claims with a missing policy number to adjuster.", "Sends claims over $10,000 to adjuster or fraud-review, never auto-approve."], guardrails: ["Never auto-approves a claim the fraud check flagged."] },
          { task: "reply drafter", description: "Drafts the reply to a member's question about their claim.", output: { kind: "text" }, tools: [{ name: "lookup_claim" }], codeRefs: [{ file: "src/replies/draft.py", line: 8 }, { file: "src/replies/draft.py", line: 31 }],
            criteria: ["Answers from the claim lookup, not from memory.", "States the claim's status and the next step."], guardrails: ["Never shares another member's claim.", "Never promises a payment date."] },
        ],
        unmapped: [{ usageIds: ["u4", "u5"], reason: "The review of claim matching stopped: it reached its $2.00 budget." }] }) }),
      repo("sahra-health/enroll-web", { addedAt: "2026-11-22T09:00:00Z", result: repoReview({ files: 88, modelCalls: [call("app/enroll/check.ts", 12, "openai/gpt-5-mini", "openai/gpt-5-mini")] }) }),
    ],
    spend: { openmeritUsd: 18.42, customerUsd: 6.1, monthlyCapUsd: 250, customerCapUsd: 50, period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } },
    guardrails: {
      environment: { [ENV]: { allowedProviders: ["openai", "anthropic"], spendCapUsd: 25, repeats: 3, minPassRate: 0.95, watch: true, actionPolicy: "ask_first" }, "sahra-health/enroll": { region: "uae" } },
      task: { "ticket-router": { latencyMs: 1000, allowedProviders: ["openai", "anthropic", "deepseek"] } },
    },
    disconnected: 0, deleted: [],
    evals: { "ticket-router": routerEval(), "reply-drafter": drafterEval() },
    drafts: seedDrafts(),
  };
}

function emptyState(me: Me): State {
  const state = populated();
  return { ...state, me: { ...me, plan: { ...me.plan, usedEvals: 0 } }, tasks: [], runs: [], reports: {}, jobs: {}, endpoints: [], repos: [], spend: { ...state.spend, openmeritUsd: 0, customerUsd: 0 }, guardrails: { environment: {}, task: {} }, evals: {}, drafts: [] };
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

// As the cloud app does, each finished run carries what its report found and the eval version it measured on:
// the accepted one, or the one before it for a run that started before it was accepted.
function runRow(state: State, run: Run): Run {
  const accepted = state.evals[run.taskId]?.accepted, report = state.reports[run.id];
  const evalVersion = run.evalVersion ?? (accepted ? (run.startedAt < accepted.at ? Math.max(1, accepted.version - 1) : accepted.version) : null);
  return { ...run, evalVersion, result: report ? { status: report.status, model: report.pick?.model ?? null, from: report.baseline?.model ?? null, savingPerCallUsd: report.pick?.savingPerCallUsd ?? null } : null };
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

// A review the preview started finishes REVIEW_MS later, finding one model call.
const REVIEW_MS = 5000;
function reviewed(item: Repo, now = Date.now()): Repo {
  if (item.review.status !== "reviewing" || now - Date.parse(item.review.requestedAt) < REVIEW_MS) return item;
  item.review = { ...item.review, status: "done", finishedAt: new Date(now).toISOString(), result: item.review.result ?? repoReview({ files: 31, bytes: 410_000, durationMs: 3100, modelCalls: [call("src/index.ts", 9, "openai/gpt-5-mini", "openai/gpt-5-mini")] }) };
  return item;
}

export function createFakeApi(options: { appUrl?: string } = {}): (request: Request) => Promise<Response> {
  const states = new Map<string, State>();
  const extras = new Map<string, Extra>();
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
    let more = extras.get(name);
    if (!more) extras.set(name, more = extra(name));
    // The member's subscription: a ChatGPT code counts as entered on the second check.
    const subs = more.subscriptions, sub = (provider: string) => subs.subscriptions.find((item) => item.provider === provider)!;
    const connect = (provider: string) => Object.assign(sub(provider), { connected: true, connectedAt: new Date().toISOString(), signIn: null });
    if (path === "/api/me/subscriptions" && method === "GET") return json(200, subs);
    if (path === "/api/me/subscriptions/chatgpt" && method === "POST") {
      more.polls = 0;
      sub("chatgpt").signIn = { startedAt: new Date().toISOString(), userCode: "KQ7P-M2XW", verificationUri: "https://auth.openai.com/codex/device" };
      return json(200, subs);
    }
    if (path === "/api/me/subscriptions/chatgpt/poll" && method === "POST") {
      if (!sub("chatgpt").signIn) return error(400, "No ChatGPT sign-in is waiting. Start one.");
      more.polls += 1;
      if (more.polls < 2) return json(200, { status: "pending", ...subs });
      connect("chatgpt");
      return json(200, { status: "connected", ...subs });
    }
    if ((match = /^\/api\/me\/subscriptions\/(chatgpt)$/.exec(path)) && method === "DELETE") {
      Object.assign(sub(match[1]!), { connected: false, connectedAt: null, signIn: null });
      if (subs.writer === match[1]) subs.writer = "openmerit";
      return json(200, subs);
    }
    if (path === "/api/me/case-writer" && method === "PUT") {
      const writer = input?.writer;
      if (writer !== "openmerit" && writer !== "chatgpt") return error(400, "Send {writer}: openmerit or chatgpt.");
      if (writer !== "openmerit" && !sub(writer).connected) return error(409, `Connect your ${sub(writer).name} subscription first.`);
      subs.writer = writer;
      return json(200, subs);
    }

    // The organization's projects, as the cloud app has them: the default can be renamed, not deleted, and a project with tasks is kept.
    const { projects, slices } = more;
    const projectView = (item: Extra["projects"][number]): Project => {
      const held: Slice = item.id === "default" ? state! : slices[item.id]!;
      return { ...item, tasks: held.tasks.length, endpoints: held.endpoints.length, repos: held.repos.map((entry) => entry.fullName) };
    };
    if (path === "/api/projects" && method === "GET") return json(200, projects.map(projectView));
    if (path === "/api/projects" && method === "POST") {
      if (denied) return denied;
      const projectName = String(input?.name ?? "").trim();
      if (!projectName) return error(400, "Name the project.");
      if (projects.some((item) => item.name.toLowerCase() === projectName.toLowerCase())) return error(400, `This account already has a project named ${projectName}.`);
      const created = { id: `prj_${projects.length}${Date.now().toString(36)}`, name: projectName, createdAt: new Date().toISOString() };
      projects.push(created);
      slices[created.id] = emptySlice();
      return json(201, projectView(created));
    }
    if ((match = /^\/api\/projects\/([\w-]+)$/.exec(path)) && (method === "PUT" || method === "DELETE")) {
      if (denied) return denied;
      const found = projects.find((item) => item.id === match?.[1]);
      if (!found) return error(404, "No such project in this account.");
      if (method === "PUT") {
        const projectName = String(input?.name ?? "").trim();
        if (!projectName) return error(400, "Name the project.");
        found.name = projectName;
        return json(200, projectView(found));
      }
      if (found.id === "default") return error(409, "The default project cannot be deleted. Rename it instead.");
      if (slices[found.id]!.tasks.length) return error(409, "This project has tasks. Delete them first.");
      projects.splice(projects.indexOf(found), 1);
      delete slices[found.id];
      return json(200, { deleted: true });
    }
    // Every other route works in the project the header names: another project's state replaces the default's fields while it runs.
    const projectId = request.headers.get("x-openmerit-project") || "default";
    if (!projects.some((item) => item.id === projectId)) return error(404, "No such project in this account. Choose another project.");
    if (projectId === "default") return route(state);
    const slice = slices[projectId]!;
    const scoped: State = { ...state, ...slice };
    const response = await route(scoped);
    for (const key of SLICE) Object.assign(slice, { [key]: scoped[key] });
    return response;

    async function route(state: State): Promise<Response> {
    let match: RegExpExecArray | null;

    if (path === "/api/me" && method === "GET") return json(200, state.me);
    if (path === "/api/tasks" && method === "GET") return json(200, state.tasks);
    if (path === "/api/runs" && method === "GET") {
      return json(200, state.runs.map((run) => runRow(state, run)));
    }
    if ((match = /^\/api\/runs\/([\w-]+)$/.exec(path)) && method === "GET") {
      const id = match[1] ?? "";
      if (!state.runs.some((run) => run.id === id)) return error(404, "No such run in this account.");
      const job = state.jobs[id];
      const found = state.reports[id] ?? (job && advance(job, state.tasks.find((task) => task.id === job.taskId), since));
      return found ? json(200, found) : error(404, "No such run in this account.");
    }
    // As the cloud app does: a running job's answers, such as grades, which it applies and asks nothing more.
    if ((match = /^\/api\/runs\/([\w-]+)\/answers$/.exec(path)) && method === "POST") {
      const job = state.jobs[match[1] ?? ""];
      if (!job) return error(404, "No such run in this account.");
      if (!job.questions.length) return error(409, "This run has no open questions.");
      const answers = input?.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return error(400, "Send the answers as JSON: {answers: {<question id>: <answer>}}.");
      job.questions = job.questions.filter((question) => (answers as Record<string, unknown>)[question.id] === undefined);
      if (!job.questions.length) Object.assign(job, { status: "running", phase: "ranking" });
      return json(200, job);
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
    if (path === "/api/repos" && method === "GET") return json(200, state.repos.map((item) => reviewed(item)));
    // In the preview, Sahra Health's members signed in with GitHub and installed the OpenMerit GitHub App on sahra-health; the empty, new and Tonic Ultra accounts did not.
    const github: GitHubAccess = ["populated", "noplan", "member"].includes(name ?? "")
      ? { app: "openmeritai", installUrl: "https://github.com/apps/openmeritai/installations/new", signedIn: true, error: null, installations: [{ id: 41, account: "sahra-health", type: "Organization", selection: "selected", manageUrl: "https://github.com/organizations/sahra-health/settings/installations/41",
        repos: [{ fullName: "sahra-health/claims-api", private: true, defaultBranch: "main" }, { fullName: "sahra-health/billing-worker", private: true, defaultBranch: "main" }, { fullName: "sahra-health/enroll-web", private: false, defaultBranch: "main" }] }] }
      : { app: "openmeritai", installUrl: "https://github.com/apps/openmeritai/installations/new", signedIn: false, error: null, installations: [] };
    if (path === "/api/github" && method === "GET") return json(200, github);
    // As the cloud app does, adding or reviewing a repository needs an active plan.
    const unpaid = state.me.plan.status === "active" || state.me.plan.status === "trialing" ? null
      : `This account has no active OpenMerit plan${state.me.plan.status === "none" ? "" : ` (Stripe says ${state.me.plan.status})`}. Subscribe at ${options.appUrl ?? "https://app.openmerit.ai"}/plan/, then try again.`;
    if (path === "/api/repos" && method === "POST") {
      if (denied) return denied;
      if (unpaid) return error(400, unpaid);
      if (!input) return error(400, "Send the repository as JSON: {url, token}. The token is only for a private repository.");
      const found = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(String(input.url ?? "").trim());
      if (!found) return error(400, "Paste the repository's GitHub URL, such as https://github.com/acme/app.");
      const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : null;
      if (input.via === "github" && !token) {
        const fullName = `${found[1]}/${found[2]}`;
        if (!github.signedIn) return error(400, "Your OpenMerit sign-in has no GitHub account. Connect GitHub on Account settings, or add the repository with a fine-grained token.");
        const given = github.installations.flatMap((item) => item.repos).find((item) => item.fullName.toLowerCase() === fullName.toLowerCase());
        if (!given) return error(400, `The OpenMerit GitHub App cannot see ${fullName} for you. Install it on the repository's account or organization and select the repository.`);
        const now = new Date().toISOString();
        const added = { ...repo(given.fullName, { private: given.private, addedAt: now, checkedAt: now, status: "reviewing" }), access: "github" as const, githubUser: state.me.user.id };
        added.review.requestedAt = now;
        state.repos = [...state.repos.filter((item) => item.fullName.toLowerCase() !== given.fullName.toLowerCase()), added];
        return json(201, added);
      }
      if (token?.startsWith("ghp_")) return error(400, "This is a classic token, which can write to every repository you can. Create a fine-grained token instead, with Contents: Read-only on only the repositories OpenMerit reviews.");
      if (token && !/^github_pat_\w{20,}$/.test(token)) return error(400, "This is not a GitHub fine-grained token: those start with github_pat_.");
      const fullName = `${found[1]}/${found[2]}`;
      // In the preview, a repository whose name says private is one GitHub shows only with a token.
      if (/private/i.test(fullName) && !token) return error(400, `GitHub has no public repository ${fullName}. If it is private, add it with a fine-grained token that can read it.`);
      const now = new Date().toISOString();
      const added = repo(fullName, { private: token !== null, tokenLast4: token?.slice(-4) ?? null, addedAt: now, checkedAt: now, status: "reviewing" });
      added.review.requestedAt = now;
      state.repos = [...state.repos.filter((item) => item.fullName.toLowerCase() !== fullName.toLowerCase()), added];
      return json(201, added);
    }
    if ((match = /^\/api\/repos\/([\w-]+)\/review$/.exec(path)) && method === "POST") {
      if (denied) return denied;
      if (unpaid) return error(402, unpaid);
      const found = state.repos.find((item) => item.id === match?.[1]);
      if (!found) return error(404, "No such repository in this account.");
      found.review = { ...found.review, status: "reviewing", requestedAt: new Date().toISOString(), finishedAt: null, error: null };
      return json(202, found);
    }
    if ((match = /^\/api\/repos\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      if (denied) return denied;
      const before = state.repos.length;
      state.repos = state.repos.filter((item) => item.id !== match?.[1]);
      return before === state.repos.length ? error(404, "No such repository.") : json(200, { deleted: true });
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
      if (!level || !LEVELS.includes(level) || !id) return error(400, "Pass level (environment or task) and id (an environment name or a task ID).");
      const task = level === "task" ? state.tasks.find((item) => item.id === id) : undefined;
      const environment = task?.environment ?? id;
      const settings = state.guardrails[level][id] ?? {};
      const chain: Partial<Record<Level, Guardrails>> = { environment: state.guardrails.environment[environment] ?? {} };
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
      const { tasks, runs, reports, endpoints, repos, guardrails, evals, drafts } = state;
      return json(200, { account: state.me.account.id, exportedAt: new Date().toISOString(), endpoints, repos, guardrails, tasks, jobs: runs, reports: Object.values(reports), evals, evalDrafts: drafts });
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
      delete state.evals[id];
      state.deleted.unshift({ taskId: id, name: task.name, environment: task.environment, userId: state.me.user.id, jobs: gone.length, deletedAt: new Date().toISOString() });
      return json(200, { deleted: true, jobs: gone.length });
    }
    if (path === "/api/tasks/deleted" && method === "GET") return json(200, state.deleted);

    // Evals, as the cloud app keeps them: the accepted one, and a draft under review that pauses the task's runs.
    const evalView = (id: string): EvalView => {
      const found = state.evals[id];
      const runs = state.runs.filter((run) => run.taskId === id).map((run) => runRow(state, run)).filter((run) => run.evalVersion === found?.accepted.version).length;
      return { taskId: id, accepted: found ? { ...found.accepted, runs } : null, draft: found?.draft ?? null };
    };
    const setReview = (id: string, review: boolean) => {
      const task = state.tasks.find((item) => item.id === id);
      if (task && task.state !== "retired") Object.assign(task, { state: review ? "review" : "watching", watching: !review });
    };
    if ((match = /^\/api\/tasks\/([\w-]+)$/.exec(path)) && method === "GET") {
      const task = state.tasks.find((item) => item.id === match?.[1]);
      if (!task) return error(404, "No such task in this account.");
      const found = state.evals[task.id];
      return json(200, { ...task, bundle: { output: found?.output ?? { kind: "text" }, current: { model: task.currentModel } }, eval: found ? { version: found.accepted.version, cases: found.accepted.cases.length, review: found.draft?.reason ?? null } : null, jobs: state.runs.filter((run) => run.taskId === task.id).slice(0, 20).map((run) => runRow(state, run)) });
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/eval(?:\/(revise|draft|accept))?$/.exec(path))) {
      const id = match[1] ?? "", action = `${method} ${match[2] ?? ""}`;
      if (!state.tasks.some((item) => item.id === id)) return error(404, "No such task in this account.");
      const found = state.evals[id];
      if (action === "GET ") return json(200, evalView(id));
      if (!found) return error(409, "This eval has no accepted version, or a draft is open already.");
      if (action === "POST revise") {
        if (found.draft) return error(409, "This eval has no accepted version, or a draft is open already.");
        found.draft = { reason: "revise", changed: [], spec: found.accepted.spec, cases: found.accepted.cases, output: null, by: "user_amira", byName: "Amira Haddad", at: new Date().toISOString() };
        setReview(id, true);
        return json(200, evalView(id));
      }
      if (action === "DELETE draft") {
        if (found.draft?.reason !== "revise") return error(409, found.draft ? "The task changed, so its accepted eval no longer fits: review and accept the draft." : "This eval has no draft.");
        found.draft = null;
        setReview(id, false);
        return json(200, evalView(id));
      }
      if (action === "PUT draft" || action === "POST accept") {
        if (!found.draft) return error(409, "This eval has no draft. Choose Revise eval first.");
        if (typeof input?.base === "string" && input.base !== found.draft.at) return error(409, "Someone saved this draft while you edited it. Reload it and make your change again.");
        const cases = (input?.cases ?? found.draft.cases) as EvalCase[];
        if (!Array.isArray(cases) || !cases.length) return error(400, "An eval needs at least one case.");
        if (cases.some((item) => !item.id || !item.input || Object.values(item.input).some((value) => typeof value !== "string"))) return error(400, "Each case needs an id and an input object of strings.");
        const spec = (input?.spec ?? found.draft.spec) as EvalSpec;
        if (action === "PUT draft") {
          found.draft = { ...found.draft, spec, cases, by: "user_amira", byName: "Amira Haddad", at: new Date().toISOString() };
          return json(200, evalView(id));
        }
        found.output = found.draft.output ?? found.output;
        found.accepted = { version: found.accepted.version + 1, source: "app", by: "user_amira", byName: "Amira Haddad", at: new Date().toISOString(), spec, cases };
        found.draft = null;
        setReview(id, false);
        return json(200, evalView(id));
      }
      return error(405, "Use POST revise, PUT draft, DELETE draft or POST accept.");
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/run$/.exec(path)) && method === "POST") {
      const task = state.tasks.find((item) => item.id === match?.[1]);
      if (!task) return error(404, "No such task in this account.");
      if (state.evals[task.id]?.draft) return error(409, `This task's eval waits for review: runs and the watch resume once someone accepts it.`);
      const jobId = `rn${Date.now().toString(36).slice(-4)}`, startedAt = new Date().toISOString();
      state.runs.unshift({ id: jobId, taskId: task.id, kind: "run", status: "running", startedAt, finishedAt: null, askedBy: null, evalVersion: state.evals[task.id]?.accepted.version ?? null, result: null });
      state.jobs[jobId] = { jobId, taskId: task.id, task: task.name, status: "running", phase: "ranking", questions: [], notices: [], progress: { measured: 0, planned: 30 }, result: null, error: null,
        provisional: { model: "openai/gpt-5-mini", endpoint: "openrouter", reason: "The cheapest catalogue model above the current one's capability index.", estCostPerCallUsd: 0.0006 }, createdAt: startedAt, report: null };
      Object.assign(task, { status: "running", lastJobId: jobId, lastRunAt: startedAt });
      return json(201, { jobId, taskId: task.id });
    }
    if ((match = /^\/api\/tasks\/([\w-]+)\/retire$/.exec(path)) && method === "POST") {
      const task = state.tasks.find((item) => item.id === match?.[1]);
      if (!task) return error(404, "No such task in this account.");
      Object.assign(task, { state: "retired", watching: false });
      return json(200, task);
    }
    // A coding agent's critical requests: /confirm/?id=budget and /confirm/?id=switch.
    if ((match = /^\/api\/confirmations\/([\w-]+)$/.exec(path))) {
      const found = confirmations[match[1]!];
      if (!found) return error(404, "No such confirmation in this organization. It may belong to another organization: switch to the one the coding agent works in.");
      if (method === "GET") return json(200, found);
      if (found.status !== "pending") return error(409, "This request was already confirmed.");
      Object.assign(found, input?.confirm === true ? { status: "done", result: { status: 201, body: { jobId: "rn42" } } } : { status: "declined" });
      return json(200, found);
    }
    // As the cloud app does, approving a draft creates the task, not run yet, with no accepted eval: its first run grades one into version 1.
    if (path === "/api/eval-drafts" && method === "GET") return json(200, state.drafts.filter((item) => item.status === "pending"));
    if ((match = /^\/api\/eval-drafts\/([\w-]+)\/approve$/.exec(path)) && method === "POST") {
      const draft = state.drafts.find((item) => item.id === match?.[1] && item.status === "pending");
      if (!draft) return error(404, "No such draft in this project.");
      const id = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (state.tasks.some((item) => item.id === id)) return error(409, "This project already has a task by that name. Dismiss the draft, or revise the task's eval.");
      state.tasks.push({ id, environment: draft.environment, agent: null, name: draft.name, currentModel: draft.bundle.current.model, pick: null, status: "new", watching: false, state: "watching", lastRunAt: null, lastJobId: null, monthlySavingUsd: null });
      Object.assign(draft, { status: "approved", taskId: id });
      return json(201, { taskId: id });
    }
    if ((match = /^\/api\/eval-drafts\/([\w-]+)$/.exec(path)) && method === "DELETE") {
      const draft = state.drafts.find((item) => item.id === match?.[1] && item.status === "pending");
      if (!draft) return error(404, "No such pending draft.");
      draft.status = "dismissed";
      return json(200, { dismissed: true });
    }
    if (path === "/api/account" && method === "DELETE") {
      if (denied) return denied;
      if (unverified) return unverified;
      const { tasks, runs } = state;
      if (name) { states.set(name, emptyState(state.me)); extras.delete(name); }
      return json(200, { deleted: true, tasks: tasks.length, jobs: runs.length });
    }
    return error(404, "Not found.");
    }
  };
}
