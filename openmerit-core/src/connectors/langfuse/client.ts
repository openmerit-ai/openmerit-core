// HTTP transport for the Langfuse public API. It uses only global fetch, so it runs on
// Node.js 22.19+ against Langfuse Cloud or any self-hosted Langfuse.
//
// Secrets are kept out of errors: a message names the method, the path and the status, plus at
// most 300 characters of Langfuse's own error body, and never the Authorization header.

export interface LangfuseConnection {
  /** Langfuse origin, optionally with a path prefix for a reverse proxy, e.g. https://langfuse.internal/langfuse. */
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export interface TransportOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 seconds. */
  timeoutMs?: number;
  /** Retries after 429 (honouring Retry-After) and 502/503/504. Default 5. */
  retries?: number;
  /** Longest single wait for a retry. Default 120 seconds. */
  maxRetryDelayMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export class LangfuseError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LangfuseError";
    this.status = status;
  }
}

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const MAX_BODY_BYTES = 8_000_000;

/**
 * Reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST, the
 * Langfuse SDK's name). Without a base URL it uses Langfuse Cloud EU, like the Langfuse SDKs.
 */
export function connectionFromEnv(env: Record<string, string | undefined> = process.env): LangfuseConnection {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const missing = [!publicKey && "LANGFUSE_PUBLIC_KEY", !secretKey && "LANGFUSE_SECRET_KEY"].filter(Boolean);
  if (missing.length) throw new LangfuseError(`Set ${missing.join(" and ")} to connect Langfuse (and LANGFUSE_BASE_URL for a self-hosted or US instance).`);
  return { baseUrl: normalizeBaseUrl(env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || DEFAULT_BASE_URL), publicKey: publicKey!, secretKey: secretKey! };
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LangfuseError(`LANGFUSE_BASE_URL is not a URL: "${value.slice(0, 200)}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LangfuseError("LANGFUSE_BASE_URL must start with https:// or http://.");
  if (url.username || url.password || url.search || url.hash) throw new LangfuseError("LANGFUSE_BASE_URL must not contain credentials, a query or a fragment.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type Query = Record<string, string | number | undefined | null>;

export interface Transport {
  readonly baseUrl: string;
  request<T>(method: "GET" | "POST", path: string, options?: { query?: Query; body?: unknown; headers?: Record<string, string>; allowNotFound?: boolean }): Promise<{ status: number; data: T | null }>;
}

export function createTransport(connection: LangfuseConnection, options: TransportOptions = {}): Transport {
  const baseUrl = normalizeBaseUrl(connection.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 5;
  const maxDelay = options.maxRetryDelayMs ?? 120_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const authorization = `Basic ${Buffer.from(`${connection.publicKey}:${connection.secretKey}`).toString("base64")}`;

  return {
    baseUrl,
    async request<T>(method: "GET" | "POST", path: string, request: { query?: Query; body?: unknown; headers?: Record<string, string>; allowNotFound?: boolean } = {}) {
      const url = new URL(`${baseUrl}${path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
      const label = `Langfuse ${method} ${path}`;
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetcher(url, {
            method,
            // Never follow a redirect with the key pair attached; a redirect means LANGFUSE_BASE_URL is wrong.
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { authorization, accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...request.headers },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          });
        } catch (error) {
          const reason = error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : error.message) : String(error);
          if (attempt < retries) {
            await sleep(Math.min(maxDelay, 1000 * 2 ** attempt));
            continue;
          }
          throw new LangfuseError(`${label} failed: ${reason}. Check LANGFUSE_BASE_URL (${baseUrl}).`);
        }
        const status = response.status;
        if ((status === 429 || status === 502 || status === 503 || status === 504) && attempt < retries) {
          await response.body?.cancel();
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Math.min(maxDelay, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
          continue;
        }
        if (status >= 300 && status < 400) {
          await response.body?.cancel();
          throw new LangfuseError(`${label} was redirected (HTTP ${status}). Set LANGFUSE_BASE_URL to the final Langfuse URL; credentials are not forwarded across redirects.`, status);
        }
        if (status === 404 && request.allowNotFound) {
          await response.body?.cancel();
          return { status, data: null };
        }
        const text = await readBounded(response, label);
        if (!response.ok) {
          const hint = status === 401 ? " Check LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and that LANGFUSE_BASE_URL is the instance or region that issued them." : status === 429 ? " Langfuse kept rate limiting after retries; try again later." : "";
          throw new LangfuseError(`${label} failed (HTTP ${status}): ${excerpt(text).replace(/[.\s]*$/, ".")}${hint}`, status);
        }
        if (!text) return { status, data: null };
        try {
          return { status, data: JSON.parse(text) as T };
        } catch {
          throw new LangfuseError(`${label} returned invalid JSON (HTTP ${status}). Is LANGFUSE_BASE_URL a Langfuse instance?`, status);
        }
      }
    },
  };
}

/** Every page of a cursor-paginated GET list, such as /api/public/v2/observations. */
export async function* cursorPages(transport: Transport, path: string, query: Query): AsyncGenerator<unknown[]> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await transport.request<{ data?: unknown; meta?: { cursor?: unknown } }>("GET", path, { query: { ...query, cursor } })).data;
    if (!page || !Array.isArray(page.data)) throw new LangfuseError(`Langfuse GET ${path} returned no data array.`);
    yield page.data;
    cursor = typeof page.meta?.cursor === "string" ? page.meta.cursor : undefined;
    if (cursor && seen.has(cursor)) throw new LangfuseError(`Langfuse GET ${path} repeated a pagination cursor.`);
    if (cursor) seen.add(cursor);
  } while (cursor);
}

/** Rows of one GET /api/public/v2/metrics query. */
export async function metricsRows(transport: Transport, query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const data = (await transport.request<{ data?: unknown }>("GET", "/api/public/v2/metrics", { query: { query: JSON.stringify(query) } })).data;
  if (!data || !Array.isArray(data.data)) throw new LangfuseError("Langfuse returned invalid aggregate metrics.");
  return data.data.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
}

async function readBounded(response: Response, label: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new LangfuseError(`${label} returned more than ${MAX_BODY_BYTES} bytes.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function excerpt(text: string): string {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Not JSON; use the raw text.
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "(empty body)";
}
