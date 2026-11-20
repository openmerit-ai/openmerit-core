// Viktor's Public API (api.viktor.com/api/public/v1) with a personal or team API key: the key's
// scopes, the credit balance, Python script runs in the workspace sandbox, and API threads, whose
// agent runs a script that `test_cron_as_subagent` needs a parent thread for.
import { randomUUID } from "node:crypto";
import { PAGE, WORK_DIR } from "./scripts.ts";

export const VIKTOR_API = "https://api.viktor.com";

/** Viktor returns at most this many characters of a script run's stdout, keeping the end. */
export const STDOUT_LIMIT = 64_000;
/** Bytes per PAGE run: their base64 is 58,668 characters, under the limit. */
export const PAGE_BYTES = 44_000;

/** The scopes the connection needs: scripts and usage to list and price tasks, threads, runs and messages to test them. */
export const REQUIRED_SCOPES = ["scripts:execute", "usage:read", "threads:create", "threads:read", "runs:create", "runs:read", "messages:create", "messages:read"] as const;

export class ViktorError extends Error {
  override readonly name = "ViktorError";
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) { super(message); this.status = status; this.code = code; }
}

export interface ViktorKey { keyType: string; teamId: string; scopes: string[]; keyPreview: string }
export interface Credits { total: number; monthly: number | null }
export interface RunStatus { id: string; threadId: string | null; status: string; error: string | null }

/** Statuses of a script run or an agent run that has not finished. */
export const PENDING = new Set(["queued", "running", "in_progress"]);

export interface ViktorClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Waits between polls of a script run; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ViktorClient {
  me(): Promise<ViktorKey>;
  credits(): Promise<Credits>;
  /** Runs `code` with `args` as sys.argv[1:] and returns its stdout. Throws when the script fails, or when Viktor cut its stdout at 64,000 characters. */
  runScript(code: string, args?: readonly string[], timeoutSeconds?: number): Promise<string>;
  /** As `runScript`, for a script whose output can pass 64,000 characters: it writes its stdout to a file in the sandbox, read back in pages. */
  runScriptPaged(code: string, args?: readonly string[], timeoutSeconds?: number): Promise<string>;
  /** Starts an API thread whose agent gets `message`; the idempotency key makes a retry return the same run. */
  startThread(message: string, idempotencyKey: string): Promise<{ threadId: string; runId: string }>;
  run(runId: string): Promise<RunStatus>;
  cancelRun(runId: string): Promise<void>;
}

const describe = (status: number, body: unknown): { code: string | null; message: string } => {
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : null;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const { error, message } = detail as { error?: unknown; message?: unknown };
    return { code: typeof error === "string" ? error : null, message: typeof message === "string" ? message : `HTTP ${status}` };
  }
  return { code: null, message: Array.isArray(detail) ? JSON.stringify(detail).slice(0, 300) : `HTTP ${status}` };
};

/**
 * Viktor refuses a script argument over 2,000 characters, and a task's instructions or a batch script
 * are longer, so the arguments travel in the code: a line after the script's first line, its
 * `# openmerit:<kind>` tag, sets `sys.argv`. A JSON string literal is also a Python string literal.
 */
export function withArgs(code: string, args: readonly string[]): string {
  if (!args.length) return code;
  const newline = code.indexOf("\n");
  const head = newline < 0 ? code : code.slice(0, newline), rest = newline < 0 ? "" : code.slice(newline + 1);
  return `${head}\nimport sys as _sys, json as _json; _sys.argv[1:] = _json.loads(${JSON.stringify(JSON.stringify(args))})\n${rest}`;
}

/** `code` with its stdout sent to `path` in the sandbox instead: a line after the script's tag opens the file. */
export function toFile(code: string, path: string): string {
  const newline = code.indexOf("\n");
  const head = newline < 0 ? code : code.slice(0, newline), rest = newline < 0 ? "" : code.slice(newline + 1);
  return `${head}\nimport os as _os, sys as _osys, atexit as _atexit; _os.makedirs(${JSON.stringify(path.slice(0, path.lastIndexOf("/")))}, exist_ok=True); _out = open(${JSON.stringify(path)}, "w", encoding="utf-8"); _osys.stdout = _out; _atexit.register(_out.close)\n${rest}`;
}

/** What a script's output is, by its `# openmerit:<kind>` tag, for the error when Viktor cuts it. */
const OUTPUTS: Record<string, string> = { list: "the listing's output", read: "the test runs' progress", describe: "the task's instructions", credits: "the test runs' credits", page: "a page of output", cleanup: "the cleanup's output", put: "the batch setup's output" };

/**
 * The tools Viktor's tool gateway saved as drafts instead of running: a workspace can make a tool wait
 * for approval in chat, which a script run through the API never gets. The SDK prints
 * "[tool-gateway] <tool>: draft created, not executed" to stderr for each, and the call returns a
 * draft receipt, which may fail the tool's response model or look like an empty result.
 */
export function draftedTools(stderr: string): string[] {
  return [...new Set([...stderr.matchAll(/\[tool-gateway\] ([\w.-]+): draft created, not executed/g)].map(match => match[1]!))];
}

/**
 * A short sentence for an error Viktor's API gave as a request validation error, such as
 * "Viktor refused the request: each script argument may be at most 2,000 characters."; null for any
 * other error. It reads the `loc` and `msg` of the first item, so it works on a message cut short.
 */
export function viktorErrorSentence(message: string): string | null {
  const found = /"loc":\[([^\]]*)\],"msg":"((?:[^"\\]|\\.)*)"/.exec(message);
  if (!found) return null;
  const loc = found[1]!, what = loc.includes('"args"') ? "script argument" : null;
  let text = found[2]!.replace(/\\"/g, '"').replace(/^Value error,\s*/i, "").trim();
  if (what) text = text.replace(/\barg\b/, what);
  text = text.replace(/\b\d{4,}\b/g, digits => Number(digits).toLocaleString("en-US"));
  const field = what ? "" : `${/"(\w+)"\s*$/.exec(loc)?.[1] ?? "a field"}: `;
  return text ? `Viktor refused the request: ${field}${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.?$/, ".")}` : null;
}

export function viktorClient(options: ViktorClientOptions): ViktorClient {
  const base = (options.baseUrl ?? VIKTOR_API).replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetcher(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* an HTML error page */ }
    if (!response.ok) { const { code, message } = describe(response.status, parsed); throw new ViktorError(response.status, code, `Viktor ${method} ${path}: ${message}`); }
    return parsed as T;
  };
  const scriptRun = (id: string) => call<{ id: string; status: string; error: unknown; result: { exit_code?: number; stdout?: string; stderr?: string; stdout_truncated?: boolean } | null }>("GET", `/api/public/v1/scripts/runs/${encodeURIComponent(id)}`);
  const runScript = async (code: string, args: readonly string[] = [], timeoutSeconds = 120): Promise<string> => {
    let run = await call<Awaited<ReturnType<typeof scriptRun>>>("POST", "/api/public/v1/scripts/runs", { code: withArgs(code, args), args: [], timeout_seconds: timeoutSeconds, wait_seconds: Math.min(timeoutSeconds, 30) });
    const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
    while (PENDING.has(run.status) && Date.now() < deadline) { await sleep(2000); run = await scriptRun(run.id); }
    const drafted = draftedTools(run.result?.stderr ?? "");
    if (drafted.length) throw new ViktorError(0, "needs_approval", `Viktor saved OpenMerit's call${drafted.length === 1 ? "" : "s"} to ${drafted.join(", ")} as ${drafted.length === 1 ? "a draft that waits" : "drafts that wait"} for approval in chat, so ${drafted.length === 1 ? "it" : "they"} did not run. In Viktor, let ${drafted.length === 1 ? "this tool" : "these tools"} run without approval, then press Refresh.`);
    if (run.status !== "completed" || (run.result?.exit_code ?? 0) !== 0) {
      const why = run.result?.stderr?.trim().split("\n").slice(-3).join(" ") || (run.error ? JSON.stringify(run.error) : run.status);
      throw new ViktorError(0, "script_failed", `Viktor script run ${run.id} ${run.status}: ${why.slice(0, 500)}`);
    }
    // Viktor keeps only the end of a longer stdout: never hand back part of it.
    if (run.result?.stdout_truncated) {
      const kind = /^# openmerit:(\w+)/.exec(code)?.[1] ?? "";
      throw new ViktorError(0, "stdout_truncated", `Viktor cut ${OUTPUTS[kind] ?? "a script's output"} at ${STDOUT_LIMIT.toLocaleString("en-US")} characters (script run ${run.id}), so OpenMerit did not read it.`);
    }
    return run.result?.stdout ?? "";
  };
  return {
    async me() {
      const body = await call<{ key_type?: string; team_id?: string; scopes?: string[]; key_preview?: string }>("GET", "/api/public/v1/me");
      return { keyType: String(body.key_type ?? ""), teamId: String(body.team_id ?? ""), scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [], keyPreview: String(body.key_preview ?? "") };
    },
    async credits() {
      const body = await call<{ total_credits?: number; monthly_credits?: number }>("GET", "/api/public/v1/credits");
      return { total: Number(body.total_credits ?? 0), monthly: typeof body.monthly_credits === "number" ? body.monthly_credits : null };
    },
    runScript,
    async runScriptPaged(code, args = [], timeoutSeconds = 120) {
      const path = `${WORK_DIR}/out/${randomUUID()}.txt`;
      await runScript(toFile(code, path), args, timeoutSeconds);
      // PAGE prints the file's size, then a page in base64; it deletes the file after the last one.
      const pages: Buffer[] = [];
      for (let offset = 0, size = 1; offset < size; offset += PAGE_BYTES) {
        const page = await runScript(PAGE, [path, String(offset), String(PAGE_BYTES)], 60);
        const newline = page.indexOf("\n");
        size = Number(page.slice(0, newline));
        if (!Number.isFinite(size)) throw new ViktorError(0, "script_failed", `Viktor returned an unreadable page of a script's output (offset ${offset}).`);
        pages.push(Buffer.from(page.slice(newline + 1).trim(), "base64"));
      }
      return Buffer.concat(pages).toString("utf8");
    },
    async startThread(message, idempotencyKey) {
      const body = await call<{ thread: { id: string }; run: { id: string } }>("POST", "/api/public/v1/threads", { message, speed: "faster" }, { "idempotency-key": idempotencyKey });
      return { threadId: body.thread.id, runId: body.run.id };
    },
    async run(runId) {
      const body = await call<{ id: string; thread_id?: string; status: string; error?: unknown }>("GET", `/api/public/v1/runs/${encodeURIComponent(runId)}`);
      return { id: body.id, threadId: body.thread_id ?? null, status: body.status, error: body.error ? JSON.stringify(body.error).slice(0, 300) : null };
    },
    async cancelRun(runId) { await call("POST", `/api/public/v1/runs/${encodeURIComponent(runId)}/cancel`, {}); },
  };
}

/**
 * Why a key cannot connect, or null. A 401 or 403 is an invalid key or a workspace without a paid
 * plan, since Viktor gives API keys only to paid and Enterprise plans.
 */
export async function keyProblem(client: ViktorClient): Promise<{ problem: string } | { key: ViktorKey }> {
  let key: ViktorKey;
  try { key = await client.me(); } catch (error) {
    if (error instanceof ViktorError && (error.status === 401 || error.status === 403)) return { problem: "Viktor did not accept this key. Check that it is a current key from Settings → API Keys; Viktor gives API keys only to workspaces on a paid or Enterprise plan." };
    return { problem: `Viktor could not be reached to check the key: ${error instanceof Error ? error.message : String(error)}` };
  }
  const missing = REQUIRED_SCOPES.filter(scope => !key.scopes.includes(scope));
  if (missing.length) return { problem: `This key is missing the scope${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Edit the key in Viktor's Settings → API Keys to add ${missing.length === 1 ? "it" : "them"}, then connect again.` };
  return { key };
}
