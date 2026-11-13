// The eval metering proxy: an OpenAI-compatible HTTP endpoint on 127.0.0.1 that exists only while
// Scout runs approved evals. Each eval unit gets its own bearer token. For every request it:
// 1. refuses models outside the repository's allowed pool for that endpoint;
// 2. reserves the request's expected cost (prompt size + max output at list price) in SQLite and
//    refuses it, before anything is sent, when that would pass the run's budget;
// 3. forwards it with the endpoint's key, then settles the reservation with the provider-reported
//    cost (OpenRouter) or a list-price estimate from the reported tokens (OpenAI-style endpoints).
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { requestPrice, type CatalogueModel } from "../catalogue/catalogue.ts";
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

export interface UnitTally { requests: number; refused: number; budgetHit: boolean; poolViolations: string[]; upstreamErrors: number[] }

/** Assumed output tokens when a request sets no maximum; reasoning models can use many. */
export const DEFAULT_OUTPUT_TOKENS = 4096;
/** Reservation for a request whose price is unknown. */
export const UNKNOWN_PRICE_RESERVATION_USD = 0.05;

export function expectedCost(model: CatalogueModel | null | undefined, body: Record<string, unknown>, bodyBytes: number): { usd: number; priced: boolean } {
  const output = [body.max_completion_tokens, body.max_tokens, body.max_output_tokens].find(value => typeof value === "number" && value > 0) as number | undefined;
  const price = requestPrice(model ?? null, Math.ceil(bodyBytes / 3), output ?? DEFAULT_OUTPUT_TOKENS);
  return price === null ? { usd: UNKNOWN_PRICE_RESERVATION_USD, priced: false } : { usd: price, priced: true };
}

/** Token counts and provider cost from an OpenAI-style (or OpenRouter) response body or SSE stream. */
export function readUsage(text: string): { input: number; output: number; costUsd: number | null } | null {
  const candidates: string[] = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(line => line.startsWith("{"));
  let found: { input: number; output: number; costUsd: number | null } | null = null;
  for (const chunk of candidates) {
    try {
      const value = JSON.parse(chunk) as { usage?: Record<string, unknown>; response?: { usage?: Record<string, unknown> } };
      const usage = value.usage ?? value.response?.usage;
      if (!usage) continue;
      const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0), output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      found = { input, output, costUsd: typeof usage.cost === "number" ? usage.cost : null };
    } catch { /* not JSON */ }
  }
  return found;
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

export class EvalProxy {
  private server: Server | null = null;
  private readonly units = new Map<string, { unit: ProxyUnit; tally: UnitTally }>();
  private readonly state: State;
  private readonly fetcher: typeof fetch;
  constructor(state: State, fetcher: typeof fetch = fetch) { this.state = state; this.fetcher = fetcher; }

  async start(): Promise<string> {
    this.server = createServer((req, res) => { this.handle(req, res).catch(error => { if (!res.headersSent) send(res, 500, `OpenMerit proxy: ${error instanceof Error ? error.message : String(error)}`, "openmerit_proxy"); else res.end(); }); });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  /** A token for one eval unit; requests with it are metered against the unit's run. */
  open(unit: ProxyUnit): { token: string; tally: UnitTally } {
    const token = `om-eval-${randomBytes(18).toString("hex")}`;
    const tally: UnitTally = { requests: 0, refused: 0, budgetHit: false, poolViolations: [], upstreamErrors: [] };
    this.units.set(token, { unit, tally });
    return { token, tally };
  }

  close(token: string) { this.units.delete(token); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const token = /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? "")?.[1] ?? (req.headers["x-api-key"] as string | undefined);
    const entry = token ? this.units.get(token) : undefined;
    if (!entry) return send(res, 401, "OpenMerit proxy: unknown or closed eval token.", "openmerit_auth");
    const { unit, tally } = entry;
    const path = (req.url ?? "/").replace(/^\/v1/, "");
    if (req.method === "GET" && path.startsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: unit.model, object: "model" }] }));
    }
    if (req.method !== "POST") return send(res, 405, "OpenMerit proxy: only POST model requests are forwarded.", "openmerit_method");
    const raw = await body(req);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return send(res, 400, "OpenMerit proxy: the request body is not JSON.", "openmerit_request"); }
    const model = typeof parsed.model === "string" ? parsed.model : unit.model;
    const catalogue = unit.allowed(model);
    if (catalogue === undefined) {
      tally.poolViolations.push(model);
      return send(res, 403, `OpenMerit proxy: ${model} is not in this repository's allowed models for endpoint ${unit.endpointId}.`, "openmerit_pool");
    }
    if (parsed.stream === true) parsed.stream_options = { ...(parsed.stream_options as object | undefined), include_usage: true };
    if (unit.baseUrl.includes("openrouter.ai")) parsed.usage = { include: true };
    const forwarded = Buffer.from(JSON.stringify(parsed));
    const expected = expectedCost(catalogue, parsed, forwarded.length);
    const reservation = this.state.reserve({ runId: unit.runId, unitId: unit.unitId, model, endpoint: unit.endpointId, expectedUsd: expected.usd });
    if (!reservation.ok) {
      tally.refused++; tally.budgetHit = true;
      return send(res, 402, `OpenMerit eval budget reached: $${reservation.spend.totalUsd.toFixed(4)} used or reserved of $${reservation.budgetUsd.toFixed(2)}; this request needs about $${expected.usd.toFixed(4)}. Paid evaluation is paused until the budget is raised.`, "openmerit_budget");
    }
    tally.requests++;
    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await this.fetcher(`${unit.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST", body: forwarded, redirect: "manual", signal: AbortSignal.timeout(600_000),
        headers: { authorization: `Bearer ${unit.apiKey}`, "content-type": "application/json", accept: req.headers.accept ?? "application/json", ...(unit.baseUrl.includes("openrouter.ai") ? { "x-title": "OpenMerit Scout eval" } : {}) },
      });
    } catch (error) {
      this.state.settle(reservation.id, { actualUsd: 0, estimatedUsd: null, latencyMs: Date.now() - started, failed: true });
      return send(res, 502, `OpenMerit proxy: ${unit.endpointId} did not answer (${error instanceof Error ? error.message : String(error)}).`, "openmerit_upstream");
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
      text += decoder.decode(value, { stream: true });
    }
    res.end();
    const latencyMs = Date.now() - started;
    const usage = readUsage(text);
    if (!upstream.ok) tally.upstreamErrors.push(upstream.status);
    if (!upstream.ok) this.state.settle(reservation.id, { actualUsd: usage?.costUsd ?? 0, estimatedUsd: null, latencyMs, failed: true });
    else this.state.settle(reservation.id, { actualUsd: usage?.costUsd ?? null, estimatedUsd: usage ? requestPrice(catalogue ?? null, usage.input, usage.output) : null, latencyMs });
  }
}
