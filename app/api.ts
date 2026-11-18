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
  // no_candidates, agent_eval_failed), or a job that ended early (failed, stopped).
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
}

export type TaskState = "watching" | "idle" | "frozen" | "retired";

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "stopped";

// What a finished run's report found: its result status, the model it picked and the one in use then.
export interface RunResult { status: string; model: string | null; from: string | null; savingPerCallUsd: number | null }
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

export interface JobResult {
  status: "picked" | "keep_current" | "baseline_failed" | "no_cases" | "no_candidates" | "agent_eval_failed";
  pick: { model: string; endpoint: string; endpointModel: string; passes: number; total: number; costPerCallUsd: number | null; savingPerCallUsd: number | null } | null;
  top: MeasuredModel[];
  baseline: MeasuredModel | null;
  candidates: MeasuredModel[];
  search: { pool: number; unplaced: number; samples: string[]; finalists: string[]; challengers: string[]; shortfall: string | null };
  agentEval: { status: "checked" | "missing"; passed: boolean; warning: string | null; baseline: { passes: number; total: number } | null; tried: { model: string; passes: number; total: number; passed: boolean }[] } | null;
  edit: { edits: { file: string; line: number; before: string; after: string }[]; instructions: string | null };
  spend: { openmeritUsd: number; customerUsd: number };
  guardrails: { effective: Guardrails; from: Partial<Record<GuardrailKey, Level>>; rejected: { key: string; level: Level; reason: string }[] };
  notices: string[];
  reportUrl: string;
  catalogueVersion: string;
  cases: { total: number; fromExamples: number; written: number };
}

// GET /api/runs/:id: the saved report once the job has one.
export interface Report extends JobResult { jobId: string; task: string; createdAt: string }

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
  // While a job measures: the candidate under test, its passes so far against the model in use
  // today, and its pass rate over time. Proposed for the cloud app, which does not send it yet;
  // the preview's fake API does. Pages fall back to progress without it.
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

export function createApi(origin: string, token: () => Promise<string | null>, fetcher: typeof fetch = fetch): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
