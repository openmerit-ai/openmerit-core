// The cloud app's /api/* (cloud/src/api.ts), which the app calls from the browser with
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
  // watch: false guardrail. retired: the coding agent retired it. Without it, watching decides.
  state?: TaskState;
  idleSince?: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
  monthlySavingUsd: number | null;
  // The latest decision the user gave in their coding agent on one of the task's changes.
  decision?: Decision | null;
}

export type TaskState = "watching" | "idle" | "frozen" | "retired";

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "stopped";

// What a finished run's report found: its result status, the model it picked and the one in use then.
export interface RunResult { status: string; task?: string | null; model: string | null; from: string | null; savingPerCallUsd: number | null }
// askedBy is the name the asking coding agent's MCP client sent, such as claude-code; null for a watch run or an unnamed client.
export interface Run { id: string; taskId: string; kind: string; status: JobStatus | string; startedAt: string; finishedAt: string | null; askedBy: string | null; result: RunResult | null }

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

// What fixes one of a result's notices, which it names by its exact text (cloud/src/report.ts).
export type Fix =
  | { kind: "raise_budget"; notice: string; budgetUsd: number }
  | { kind: "rerun"; notice: string }
  | { kind: "open"; notice: string; label: string; path: string }
  | { kind: "ask_agent"; notice: string; prompt: string };

export interface JobResult {
  status: "picked" | "keep_current" | "baseline_failed" | "below_floor" | "no_cases" | "no_candidates" | "agent_eval_failed" | "stopped" | "failed";
  // Up to 20 cases the current model failed, with the grader's reason; and its passes per kind of case. Absent from reports saved before 24 Nov 2026.
  failedCases?: { caseId: string; kind: string; reason: string }[];
  baselineByKind?: { kind: string; passes: number; total: number }[];
  pick: { model: string; endpoint: string; endpointModel: string; passes: number; total: number; costPerCallUsd: number | null; savingPerCallUsd: number | null } | null;
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

// GET /api/runs/:id before then: the job's live state, with report null.
export interface JobView {
  jobId: string;
  taskId: string;
  task: string;
  status: JobStatus;
  phase: string;
  questions: unknown[];
  notices: string[];
  progress: { measured: number; planned: number | null };
  result: JobResult | null;
  error: string | null;
  provisional: { model: string; endpoint: string; reason: string; estCostPerCallUsd: number | null } | null;
  createdAt: string;
  report: null;
  // While a measure step runs: the candidate under test, its passes so far against the model in
  // use today, and its pass rate after each case (cloud/src/actors/job.ts). Null between steps and
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

// A model call a repository's review found: where it is and the model it names, or the expression that picks it (cloud/src/github.ts).
export interface ModelCall { file: string; line: number; value: string; catalogueId: string | null; dynamic: boolean; envVar: string | null }
export interface RepoReview {
  // scan lists the model calls; review, once the review prompt lands, also writes the task specs in tasks.
  reviewer: string;
  commit: string;
  branch: string;
  files: number;
  bytes: number;
  models: { value: string; catalogueId: string | null; calls: number }[];
  modelCalls: ModelCall[];
  totalCalls: number;
  tasks: unknown[];
  durationMs: number;
}
// A GitHub repository the account added (GET /api/repos). tokenLast4 is null for a public one added by its URL.
// review.result is the last review that finished, kept while another runs or after one fails.
export type ReviewStatus = "queued" | "reviewing" | "done" | "failed";
export interface Repo {
  id: string; fullName: string; url: string; private: boolean; defaultBranch: string; tokenLast4: string | null; addedAt: string; checkedAt: string;
  review: { status: ReviewStatus; requestedAt: string; finishedAt: string | null; error: string | null; result: RepoReview | null };
}

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

// Deleting needs a recent sign-in. The cloud app answers 403 with Clerk's reverification hint;
// reverify opens Clerk's prompt and resolves true once the user verified, and the call is retried once.
export type Reverify = (level: string | undefined) => Promise<boolean>;
interface ReverificationHint { clerk_error: { reason: "reverification-error"; metadata?: { reverification?: { level?: string } } } }
const isReverificationHint = (data: unknown): data is ReverificationHint =>
  typeof data === "object" && data !== null && (data as Partial<ReverificationHint>).clerk_error?.reason === "reverification-error";

export function createApi(origin: string, token: () => Promise<string | null>, fetcher: typeof fetch = fetch, reverify?: Reverify): Api {
  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const bearer = await token();
    if (!bearer) throw new ApiError(401, "Sign in to continue.", "sign_in_required");
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin), {
        method,
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
