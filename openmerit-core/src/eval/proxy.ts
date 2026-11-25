// The eval metering proxy: an OpenAI-compatible HTTP endpoint on 127.0.0.1 that exists only while
// Scout runs approved evals. Each eval unit gets its own bearer token. For every request it:
// 1. refuses models outside the repository's allowed pool for that endpoint;
// 2. reserves the request's expected cost (prompt size + max output at list price) in the run's
//    ledger (SQLite) and refuses it, before anything is sent, when that would pass the run's budget;
// 3. forwards it with the endpoint's key, then settles the reservation with the provider-reported
//    cost (OpenRouter) or a list-price estimate from the reported tokens (OpenAI-style endpoints).
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { requestPrice, type CatalogueModel } from "../engine/catalogue.ts";
import { expectedCost, readUsage, sizeEstimate, type Ledger, type Settlement } from "../engine/ledger.ts";
import type { State } from "../state/db.ts";

export interface ProxyUnit {
  runId: string;
  unitId: string;
  endpointId: string;
  baseUrl: string;
  apiKey: string;
  /** The candidate (or baseline) the unit evaluates, as the endpoint names it. */
  model: string;
  /** Endpoint model ID → catalogue model, for every model the pool allows on this endpoint. */
  allowed: (endpointModel: string) => CatalogueModel | null | undefined;
}

export interface UnitTally {
  requests: number; refused: number; budgetHit: boolean; poolViolations: string[]; upstreamErrors: number[];
  /** Answers the output token limit cut off before any text, as when the provider has the model reason first. */
  cutOff: number;
  /** The largest request refused on the budget: what it needed, and the output tokens it allowed. */
  refusedLargest?: { usd: number; outputTokens: number };
}

/** True when an OpenAI-style answer (body or SSE stream) stopped at its token limit without any text. */
export function cutOffBeforeText(text: string): boolean {
  const chunks = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(line => line.startsWith("{"));
  let content = "", length = false;
  for (const chunk of chunks) {
    try {
      const value = JSON.parse(chunk) as { choices?: { finish_reason?: string | null; message?: { content?: unknown }; delta?: { content?: unknown } }[] };
      for (const choice of value.choices ?? []) {
        const part = choice.message?.content ?? choice.delta?.content;
        if (typeof part === "string") content += part;
        if (choice.finish_reason === "length") length = true;
      }
    } catch { /* not JSON */ }
  }
  return length && !content.trim();
}

const send = (res: ServerResponse, status: number, message: string, type: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: status } }));
};

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 50_000_000) throw new Error("request too large"); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks);
}

/** How often a failed model call is sent again before the eval sees the failure. */
export const MODEL_CALL_RETRIES = 3;
/** Failures that may pass: timeouts, rate limits and server errors. Rejections such as 400 or 404 get the same answer again. */
export const retryable = (status: number) => status === 408 || status === 429 || status >= 500;
/** Retry-After when the endpoint sends one (at most 30 s), else 2, 4 and 8 s. */
const retryDelayMs = (retryAfter: string | null, attempt: number) => {
  const seconds = Number(retryAfter);
  return retryAfter !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : 2000 * 2 ** attempt;
};

/**
 * Sends a model call, and again up to MODEL_CALL_RETRIES times while it fails in a way that may pass.
 * `forward` returns the response, or the error when nothing came back. Discarded answers are not charged.
 */
export async function withRetries(forward: () => Promise<Response | Error>, signal?: AbortSignal): Promise<Response | Error> {
  let upstream = await forward();
  for (let attempt = 0; attempt < MODEL_CALL_RETRIES && (upstream instanceof Error || retryable(upstream.status)); attempt++) {
    if (!(upstream instanceof Error)) await upstream.body?.cancel();
    await sleep(retryDelayMs(upstream instanceof Error ? null : upstream.headers.get("retry-after"), attempt), undefined, signal ? { signal } : {});
    upstream = await forward();
  }
  return upstream;
}

export class EvalProxy {
  private server: Server | null = null;
  /** Requests being handled, and how to abort each one's upstream call. */
  private readonly inFlight = new Map<Promise<unknown>, AbortController>();
  private readonly units = new Map<string, { unit: ProxyUnit; tally: UnitTally; ledger: Ledger }>();
  private readonly state: State;
  private readonly fetcher: typeof fetch;
  constructor(state: State, fetcher: typeof fetch = fetch) { this.state = state; this.fetcher = fetcher; }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      // The upstream call lives only as long as the eval's request: an eval that gives up (its own
      // timeout, a kill) aborts it, so it does not keep running, and billing, after the eval moved on.
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableFinished) abort.abort(new Error("the eval closed its request")); });
      const handled = this.handle(req, res, abort.signal).catch(error => { if (!res.headersSent) send(res, 500, `OpenMerit proxy: ${error instanceof Error ? error.message : String(error)}`, "openmerit_proxy"); else res.end(); })
        .finally(() => this.inFlight.delete(handled));
      this.inFlight.set(handled, abort);
    });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    // Every request still open is aborted and settled before the step that ran the eval ends, so no
    // reservation is left open across a pause or a stop.
    for (const abort of this.inFlight.values()) abort.abort(new Error("the eval step ended"));
    await Promise.allSettled(this.inFlight.keys());
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  /** A token for one eval unit; requests with it are metered against the unit's run. */
  open(unit: ProxyUnit): { token: string; tally: UnitTally } {
    const token = `om-eval-${randomBytes(18).toString("hex")}`;
    const tally: UnitTally = { requests: 0, refused: 0, budgetHit: false, poolViolations: [], upstreamErrors: [], cutOff: 0 };
    this.units.set(token, { unit, tally, ledger: this.state.ledger({ runId: unit.runId, unitId: unit.unitId }) });
    return { token, tally };
  }

  close(token: string) { this.units.delete(token); }

  private async handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal) {
    const token = /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? "")?.[1] ?? (req.headers["x-api-key"] as string | undefined);
    const entry = token ? this.units.get(token) : undefined;
    if (!entry) return send(res, 401, "OpenMerit proxy: unknown or closed eval token.", "openmerit_auth");
    const { unit, tally, ledger } = entry;
    const path = (req.url ?? "/").replace(/^\/v1/, "");
    if (req.method === "GET" && path.startsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: unit.model, object: "model" }] }));
    }
    if (req.method !== "POST") return send(res, 405, "OpenMerit proxy: only POST model requests are forwarded.", "openmerit_method");
    const raw = await body(req);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return send(res, 400, "OpenMerit proxy: the request body is not JSON.", "openmerit_request"); }
    let model = typeof parsed.model === "string" ? parsed.model : unit.model;
    // An SDK that strips the vendor prefix, as OpenAI's Agents SDK turns openai/gpt-4.1-mini into
    // gpt-4.1-mini, still asks for the model under test: send it as the endpoint names it.
    if (unit.allowed(model) === undefined && model === unit.model.split("/").at(-1)) { model = unit.model; parsed.model = model; }
    const catalogue = unit.allowed(model);
    if (catalogue === undefined) {
      tally.poolViolations.push(model);
      return send(res, 403, `OpenMerit proxy: ${model} is not in this repository's allowed models for endpoint ${unit.endpointId}.`, "openmerit_pool");
    }
    if (parsed.stream === true) parsed.stream_options = { ...(parsed.stream_options as object | undefined), include_usage: true };
    if (unit.baseUrl.includes("openrouter.ai")) parsed.usage = { include: true };
    const forwarded = Buffer.from(JSON.stringify(parsed));
    const expected = expectedCost(catalogue, parsed, forwarded.length);
    // The CLI calls only the user's own endpoints with their keys.
    const key = randomUUID();
    const reservation = await ledger.reserve({ key, usd: expected.usd, funding: "customer", model, endpoint: unit.endpointId });
    if (!reservation.ok) {
      tally.refused++; tally.budgetHit = true;
      if (!tally.refusedLargest || expected.usd > tally.refusedLargest.usd) tally.refusedLargest = { usd: expected.usd, outputTokens: expected.outputTokens };
      return send(res, 402, `OpenMerit eval budget reached: ${reservation.reason}; this request needs about $${reservation.neededUsd.toFixed(4)}. Paid evaluation is paused until the budget is raised.`, "openmerit_budget");
    }
    tally.requests++;
    const started = Date.now();
    // Every reservation is settled, even when the endpoint or the eval drops the connection part-way.
    let settled = false, received = 0;
    const settle = (cost: Settlement) => { settled = true; return ledger.settle(key, cost); };
    try {
      const forward = () => this.fetcher(`${unit.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST", body: forwarded, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
        headers: { authorization: `Bearer ${unit.apiKey}`, "content-type": "application/json", accept: req.headers.accept ?? "application/json", ...(unit.baseUrl.includes("openrouter.ai") ? { "x-title": "OpenMerit Scout eval" } : {}) },
      }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      // A failed call that may pass is sent again, so the eval only sees failures that last; failed calls are not charged.
      const upstream = await withRetries(forward, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      if (upstream instanceof Error) {
        tally.upstreamErrors.push(502);
        await settle({ actualUsd: 0, estimatedUsd: null, latencyMs: Date.now() - started, failed: true });
        return send(res, 502, `OpenMerit proxy: ${unit.endpointId} did not answer (${upstream.message}).`, "openmerit_upstream");
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      let text = "";
      const decoder = new TextDecoder();
      const reader = upstream.body?.getReader();
      for (;;) {
        if (!reader) break;
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        received += value.length;
        text += decoder.decode(value, { stream: true });
      }
      res.end();
      const latencyMs = Date.now() - started;
      const usage = readUsage(text);
      if (!upstream.ok) tally.upstreamErrors.push(upstream.status);
      else if (cutOffBeforeText(text)) tally.cutOff++;
      if (!upstream.ok) await settle({ actualUsd: usage?.costUsd ?? 0, estimatedUsd: null, latencyMs, failed: true });
      // An answer without usage is estimated from its size, not counted at the request's maximum.
      else await settle({ actualUsd: usage?.costUsd ?? null, estimatedUsd: usage ? requestPrice(catalogue ?? null, usage.input, usage.output) : sizeEstimate(catalogue, forwarded.length, received), latencyMs });
    } finally {
      // Cut off part-way: what arrived is estimated by its size; nothing arrived, nothing is charged.
      if (!settled) await settle({ actualUsd: received ? null : 0, estimatedUsd: received ? sizeEstimate(catalogue, forwarded.length, received) : null, latencyMs: Date.now() - started, failed: true });
    }
  }
}
