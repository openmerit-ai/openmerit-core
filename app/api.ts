// The cloud app's /api/*, which the app calls from the browser with the Clerk
// session token. The cloud app owns this contract; where it does not yet name a
// field, these types are the shapes the pages assume, and app/dev/fake-api.ts
// serves them for local development and tests.
export type Level = "environment" | "agent" | "task";

export interface ModelRef { model: string; endpoint: string; label?: string }

export interface Plan {
  name: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  periodEnd: string | null;
  includedEvals: number;
  usedEvals: number;
}

export interface Me {
  user: { id: string; name: string | null; email: string | null };
  account: { id: string; name: string };
  role: "admin" | "member";
  plan: Plan | null;
}

export interface Task {
  id: string;
  environment: string;
  agent: string | null;
  name: string;
  currentModel: ModelRef;
  pick: ModelRef | null;
  status: "measuring" | "switched" | "keep" | "cheaper-fit" | "failed";
  watching: boolean;
  lastRunAt: string | null;
  monthlySavingUsd: number | null;
  latestRunId?: string | null;
  codeRef?: string | null;
}

export type Basis = "context" | "code" | "traces" | "eval";

export interface RunSummary {
  id: string;
  taskId: string;
  task: string;
  environment: string;
  status: "running" | "done" | "failed";
  outcome: "switch" | "keep" | "cheaper" | null;
  current: ModelRef;
  pick: ModelRef | null;
  provisional: ModelRef | null;
  requestedBy: string;
  basis: Basis[];
  startedAt: string;
  measuredAt: string | null;
  savingPct: number | null;
}

export interface Candidate {
  model: ModelRef;
  role: "current" | "pick" | "candidate" | "outside";
  passed: number;
  total: number;
  costPer1kUsd: number | null;
  latencyMs: number | null;
  verdict: string;
  // Models outside the catalogue have no ECI, so the search places them by measurement only.
  measuredOnly: boolean;
  funding: "openmerit" | "customer";
}

export interface ReportCase {
  id: string;
  input: string;
  expected: string;
  origin: "example" | "written" | "trace";
  approved: boolean;
  results: { model: string; passed: number; runs: number }[];
}

export interface Report extends RunSummary {
  summary: string | null;
  candidates: Candidate[];
  cases: ReportCase[];
  casesTotal: number;
  passRule: string | null;
  repeats: number;
  edit: { file: string; before: string; after: string; applied: boolean } | null;
  search: { model: ModelRef; step: "baseline" | "screen" | "finalist" | "challenger"; pass: boolean | null }[];
  spend: { openmeritUsd: number; customerUsd: number };
  monthlyCalls: number | null;
  shareUrl: string | null;
  error: string | null;
}

export type EndpointKind = "openrouter" | "openai-compatible" | "anthropic";
export interface Endpoint {
  id: string;
  kind: EndpointKind;
  baseUrl: string;
  allowedModels: string[];
  // Null for OpenRouter on OpenMerit's own key.
  keyLast4: string | null;
  verifiedAt: string | null;
}

export interface GuardrailSetting {
  key: string;
  kind: "constraint" | "default";
  // Set at the requested level, or null when this level inherits it.
  value: unknown;
  effective: unknown;
  from: Level | null;
}
export interface Guardrails { level: Level; id: string; settings: GuardrailSetting[]; rejected: { key: string; level: Level; reason: string }[] }

export interface Spend {
  openmeritUsd: number;
  customerUsd: number;
  monthlyCapUsd: number | null;
  customerCapUsd: number | null;
  period: { start: string; end: string };
}

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
