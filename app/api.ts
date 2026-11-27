// The cloud app's /api/* (openmerit-core/src/server/api.ts), which the app calls from the browser with
// the Clerk session token. These types mirror what it returns; app/dev/fake-api.ts
// serves the same shapes for local development and tests. Guardrail names and kinds
// come from openmerit/engine, which the cloud app also resolves guardrails with.
import type { GuardrailKey, Guardrails, Level } from "../openmerit-core/src/engine/guardrails.ts";

export { GUARDRAIL_KINDS } from "../openmerit-core/src/engine/guardrails.ts";
export type { GuardrailKey, Guardrails, Level };

export interface Plan {
  name: string | null;
  // active, trialing, past_due, canceled or none, as Stripe reports them.
  status: string;
  periodEnd: string | null;
  includedEvals: number;
  usedEvals: number;
}

export interface Me {
  user: { id: string };
  // The Clerk organization; its name is null when the organization has no slug.
  account: { id: string; name: string | null };
  role: "admin" | "member";
  plan: Plan;
}

// The member's own ChatGPT subscription (GET /api/me/subscriptions), for every organization they belong to.
// writer is who writes the cases of the runs they start. A sign-in under way has the code to enter; no
// token is ever sent to the page.
export type SubscriptionProvider = "chatgpt";
export type CaseWriter = "openmerit" | SubscriptionProvider;
export interface Subscription {
  provider: SubscriptionProvider; name: string; connected: boolean; connectedAt: string | null; problem: string | null;
  signIn: { startedAt: string; userCode: string; verificationUri: string } | null;
}
export interface Subscriptions { writer: CaseWriter; subscriptions: Subscription[] }

export interface Task {
  id: string;
  environment: string;
  agent: string | null;
  name: string;
  currentModel: string;
  pick: string | null;
  // new, running, the last result's status (picked, keep_current, baseline_failed, no_cases,
  // no_candidates, agent_eval_failed), switched (the user approved the pick, now currentModel),
  // or a job that ended early (failed, stopped).
  status: string;
  watching: boolean;
  // Watching is automatic. Proposed for the cloud app, which does not send it yet; the preview's
  // fake API does. idle: no coding agent call for 30 days, until the next one. frozen: a
  // watch: false guardrail. retired: the coding agent retired it. review: its eval waits for a person,
  // and no run starts until they accept it. Without it, watching decides.
  state?: TaskState;
  idleSince?: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
  monthlySavingUsd: number | null;
  // The latest decision the user gave in their coding agent on one of the task's changes.
  decision?: Decision | null;
}

// A task's eval (openmerit-core/src/server/actors/account.ts): what the judge checks (spec) and the cases. The cloud is
// its source of truth. The accepted eval runs unchanged; its version counts acceptances. A draft is the
// eval under review, edited in place: reopened because the coding agent sent the task with a different
// prompt, tools or output (task_changed, with the new output shape), or by a person (revise). While a
// draft is open the task's runs and watch wait.
export interface EvalCase { id: string; input: Record<string, string>; expected?: unknown; origin: "example" | "written" | "trace"; kind?: string; approved?: boolean; toolResults?: unknown }
export interface EvalSpec { description?: string; input?: { description: string }; steps?: { description: string; tools?: string[]; access?: string; required?: boolean; after?: number[] }[]; criteria?: string[]; guardrails?: string[] }
export type EvalSource = "openmerit" | "chatgpt" | "examples" | "app" | "grading";
export type TaskPart = "prompt" | "tools" | "output";
export interface EvalAccepted { version: number; spec: EvalSpec; cases: EvalCase[]; source: EvalSource; by: string | null; byName?: string | null; at: string; runs: number }
export interface EvalRevision { reason: "task_changed" | "revise"; changed: TaskPart[]; spec: EvalSpec; cases: EvalCase[]; output: TaskOutput | null; by: string | null; byName?: string | null; at: string }
export interface EvalView {
  taskId: string;
  accepted: EvalAccepted | null;
  draft: EvalRevision | null;
}
// A task's output shape, from the bundle the coding agent sent, for editing expected answers.
export type TaskOutput = { kind: "text" } | { kind: "json"; schema: object } | { kind: "label"; labels: string[] };
// GET /api/tasks/:id: the task's row with its bundle, eval summary and latest runs.
export interface TaskDetail extends Task { bundle: { output: TaskOutput; current: { model: string } } | null; eval: { version: number; cases: number; review: EvalRevision["reason"] | null } | null; jobs: Run[] }

export type TaskState = "watching" | "idle" | "frozen" | "retired" | "review";

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "stopped";

// What a finished run's report found: its result status, the model it picked and the one in use then.
export interface RunResult { status: string; task?: string | null; model: string | null; from: string | null; savingPerCallUsd: number | null }
// askedBy is the name the asking coding agent's MCP client sent, such as claude-code; null for a watch run or an unnamed client.
// evalVersion: the eval version the run measured on, once its cases are set; runs on different versions are not comparable.
export interface Run { id: string; taskId: string; kind: string; status: JobStatus | string; startedAt: string; finishedAt: string | null; askedBy: string | null; evalVersion?: number | null; result: RunResult | null }

export interface MeasuredModel {
  model: string;
  endpoint: string;
  endpointModel: string;
  role: "baseline" | "candidate";
  stage: "baseline" | "search" | "neighbour" | "challenger";
  eci: number | null;
  // False for a model outside the catalogue, placed by measurement only.
  inCatalogue: boolean;
  funding: "openmerit" | "customer";
  status: "measured" | "screened_out" | "unavailable";
  passes: number;
  total: number;
  costPerCallUsd: number | null;
  costIsEstimate: boolean;
  latencyMs: number | null;
  qualified: boolean;
  note: string;
}

// What fixes one of a result's notices, which it names by its exact text (openmerit-core/src/server/report.ts).
export type Fix =
  | { kind: "raise_budget"; notice: string; budgetUsd: number }
  | { kind: "rerun"; notice: string }
  | { kind: "open"; notice: string; label: string; path: string }
  | { kind: "ask_agent"; notice: string; prompt: string };

export interface JobResult {
  status: "picked" | "keep_current" | "baseline_failed" | "below_floor" | "no_cases" | "no_candidates" | "agent_eval_failed" | "not_accepted" | "stopped" | "failed";
  // The grading loop, when a person graded the run's answers: its rounds, whether they accepted the eval, and the bar the
  // result was measured against; with "criteria", summary says what the current model misses. Absent when nobody graded.
  grading?: { rounds: number; accepted: boolean; bar: "current" | "criteria"; failedChecks: string[]; summary: string | null; barSet?: { round: number; cases: string[] } | null };
  // Up to 20 cases the current model failed, with the grader's reason; and its passes per kind of case. Absent from reports saved before 24 Nov 2026.
  failedCases?: { caseId: string; kind: string; reason: string }[];
  baselineByKind?: { kind: string; passes: number; total: number }[];
  pick: { model: string; endpoint: string; endpointModel: string; passes: number; total: number; costPerCallUsd: number | null; savingPerCallUsd: number | null; paybackCalls: number | null } | null;
  top: MeasuredModel[];
  // Measured models within one case per run of the current model's passes, with whether each costs less per call. Absent from reports saved before 19 Nov 2026.
  nearMisses?: (MeasuredModel & { cheaperThanCurrent: boolean | null })[];
  baseline: MeasuredModel | null;
  candidates: MeasuredModel[];
  search: { pool: number; unplaced: number; samples: string[]; finalists: string[]; challengers: string[]; shortfall: string | null };
  agentEval: { status: "checked" | "missing"; passed: boolean; warning: string | null; baseline: { passes: number; total: number } | null; tried: { model: string; passes: number; total: number; passed: boolean }[] } | null;
  edit: { edits: { file: string; line: number; before: string; after: string }[]; instructions: string | null };
  spend: { openmeritUsd: number; customerUsd: number };
  guardrails: { effective: Guardrails; from: Partial<Record<GuardrailKey, Level>>; rejected: { key: string; level: Level; reason: string }[] };
  notices: string[];
  // Absent from reports saved before fixes were added.
  fixes?: Fix[];
  reportUrl: string;
  catalogueVersion: string;
  cases: { total: number; fromExamples: number; written: number };
  // The evidence each decision used, such as "Grader: the expected labels of your examples, from agent-bundle". Absent from older reports.
  basedOn?: string[];
}

// What the user decided about a result's change, as their coding agent sent it with openmerit_answer:
// approved (the agent applied the edit) or declined. by is the user's ID; name is their name in Clerk, null when the lookup failed.
export interface Decision { jobId: string; taskId: string; decision: "approved" | "declined"; change: string; by: string; name: string | null; email: string | null; at: string }

// GET /api/runs/:id: the saved report once the job has one, with the user's decision on its change.
export interface Report extends JobResult { jobId: string; task: string; createdAt: string; decision?: Decision | null }

// A job's question. In the grading loop (phase "grading") each is one sampled answer: detail holds the model, the
// input, the answer and OpenMerit's grade, and the answer is good or bad, with an optional note after a colon.
export interface Question { id: string; kind: "choice" | "multi" | "confirm" | "text"; prompt: string; detail?: string; options?: { value: string; label: string }[]; hint?: string }

// GET /api/runs/:id before then: the job's live state, with report null.
export interface JobView {
  jobId: string;
  taskId: string;
  task: string;
  status: JobStatus;
  phase: string;
  questions: Question[];
  notices: string[];
  progress: { measured: number; planned: number | null };
  result: JobResult | null;
  error: string | null;
  provisional: { model: string; endpoint: string; reason: string; estCostPerCallUsd: number | null } | null;
  createdAt: string;
  report: null;
  // While a measure step runs: the candidate under test, its passes so far against the model in
  // use today, and its pass rate after each case (openmerit-core/src/server/actors/job.ts). Null between steps and
  // absent from jobs that started before it; pages fall back to progress then.
  live?: LiveProgress | null;
}
export interface LiveProgress {
  model: string;
  endpoint: string;
  // The model in use today and its pass rate on the same cases, 0 to 100.
  baseline: { model: string; rate: number } | null;
  done: number;
  total: number;
  passes: number;
  // Pass rate so far, 0 to 100, after each case; time is Unix seconds.
  history: { time: number; rate: number }[];
  minutesLeft: number | null;
}

export type EndpointKind = "openrouter" | "openai-compatible" | "anthropic";
export interface Endpoint { id: string; kind: EndpointKind; baseUrl: string; allowedModels: string[] | "all"; keyLast4: string; verifiedAt: string | null; builtIn: boolean }

export interface GuardrailsAt {
  level: Level;
  id: string;
  // Only the settings made at this level.
  settings: { key: string; value: unknown; kind: "constraint" | "default" }[];
  effective: Guardrails;
  from: Partial<Record<GuardrailKey, Level>>;
  rejected: { key: string; level: Level; reason: string }[];
}

// GET /api/tasks/deleted: who deleted which task, with no task content. The export includes it.
export interface DeletedTask { taskId: string; name: string; environment: string; userId: string; jobs: number; deletedAt: string }

export interface Spend { openmeritUsd: number; customerUsd: number; monthlyCapUsd: number; customerCapUsd: number; period: { start: string; end: string | null } }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}

// A critical action needs a recent sign-in. The cloud app answers 403 with Clerk's reverification hint;
// reverify opens Clerk's prompt and resolves true once the user verified, and the call is retried once.
export type Reverify = (level: string | undefined) => Promise<boolean>;
interface ReverificationHint { clerk_error: { reason: "reverification-error"; metadata?: { reverification?: { level?: string } } } }
const isReverificationHint = (data: unknown): data is ReverificationHint =>
  typeof data === "object" && data !== null && (data as Partial<ReverificationHint>).clerk_error?.reason === "reverification-error";

// token is null on a self-hosted server, whose pages sign in with a browser session cookie instead of a bearer token.
export function createApi(origin: string, token: (() => Promise<string | null>) | null, fetcher: typeof fetch = fetch, reverify?: Reverify): Api {
  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const bearer = token ? await token() : null;
    if (token && !bearer) throw new ApiError(401, "Sign in to continue.", "sign_in_required");
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin), {
        method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ApiError(0, "OpenMerit could not be reached. Check your connection and try again.");
    }
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* a proxy's HTML error page */ }
    if (response.status === 403 && isReverificationHint(data)) {
      if (!retried && reverify && await reverify(data.clerk_error.metadata?.reverification?.level)) return call(method, path, body, true);
      throw new ApiError(403, "Confirm it's you to continue: verify your sign-in, then try again.", "reverification");
    }
    if (!response.ok) {
      const detail = typeof data === "object" && data !== null ? data as { error?: unknown; code?: unknown } : {};
      const message = typeof detail.error === "string" ? detail.error : `OpenMerit answered ${response.status}. Try again in a moment.`;
      throw new ApiError(response.status, message, typeof detail.code === "string" ? detail.code : null);
    }
    return data as T;
  }
  return {
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
  };
}
