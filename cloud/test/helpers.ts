// Test fixtures: the app in a child process on a local Rivet engine, a fake OpenAI-compatible model
// server standing in for OpenRouter and customer endpoints (and the case writer), and signed Stripe events. No real
// credential reaches the child and no paid model is called.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signStripePayload } from "../src/billing.ts";
import type { Catalogue } from "../src/engine.ts";

export const catalogue = JSON.parse(readFileSync(new URL("../../openmerit-core/data/catalogue.json", import.meta.url), "utf8")) as Catalogue;

export const TICKETS: Record<string, string> = {
  "My card was charged twice": "billing", "The app crashes on login": "technical", "How do I change my plan?": "billing",
  "I cannot reset my password": "account", "Export fails with error 500": "technical", "Please close my account": "account",
  "Where is my invoice for March?": "billing",
};
/** The tickets the fake case writer writes, with their queues. */
export const WRITTEN: Record<string, string> = { "I was charged after I cancelled": "billing", "The dashboard shows a blank page": "technical" };
const QUEUES = { ...TICKETS, ...WRITTEN };
/** Models the fake answers wrongly: those the catalogue rates below this ECI, so the search has something to find. */
export const WEAK_BELOW = 140;
/** What the fake reports a call cost: 50 prompt and 2 output tokens at list price, or $0.0005 for a model outside the catalogue. */
export function costOf(model: string): number {
  const entry = catalogue.models.find(item => item.id === model);
  return entry?.inputPerM != null && entry.outputPerM != null ? (50 * entry.inputPerM + 2 * entry.outputPerM) / 1e6 : 0.0005;
}

/** One call the fake answered. `ticket` is the ticket it classified, or `writer:<n>` for a request to write n cases. */
export interface FakeModels { url: string; calls: { model: string; ticket: string; auth: string }[]; onCall: ((index: number) => Promise<void>) | null; close: () => Promise<void> }

export async function fakeModels(): Promise<FakeModels> {
  const eci = new Map(catalogue.models.map(model => [model.id, model.eci]));
  const fake: FakeModels = { url: "", calls: [], onCall: null, close: async () => {} };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const parsed = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const text = parsed.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
      // openmerit/ranking's case writer: the same two cases each time, so its second request adds nothing new.
      const writer = parsed.messages[0]?.role === "system" && parsed.messages[0].content.startsWith("You write test cases");
      const ticket = writer ? `writer:${/Write (\d+) cases/.exec(text)?.[1] ?? "?"}` : Object.keys(QUEUES).find(item => text.includes(item)) ?? "";
      const index = fake.calls.push({ model: parsed.model, ticket, auth: String(req.headers.authorization ?? "") }) - 1;
      if (fake.onCall) await fake.onCall(index);
      const weak = (eci.get(parsed.model) ?? 200) < WEAK_BELOW;
      const answer = writer ? JSON.stringify({ cases: Object.entries(WRITTEN).map(([written, queue]) => ({ input: { ticket: written }, expected: queue })) })
        : weak ? "other" : QUEUES[ticket] ?? "other";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 50, completion_tokens: 2, cost: costOf(parsed.model) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

export interface App { url: string; child: ChildProcess; storage: string; enginePort: number; env: Record<string, string> }

const free = (port: number) => new Promise<boolean>(resolve => {
  const server = createServer().once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

/** Engine ports: port, port+1, port+10. */
async function enginePort(): Promise<number> {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 400) * 100;
    if ((await Promise.all([port, port + 1, port + 10].map(free))).every(Boolean)) return port;
  }
}

export async function startApp(options: { models: FakeModels; env?: Record<string, string>; storage?: string; enginePort?: number }): Promise<App> {
  const storage = options.storage ?? mkdtempSync(join(tmpdir(), "openmerit-cloud-"));
  const port = options.enginePort ?? await enginePort();
  // Only what the app needs: no credential from the orb reaches it.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TEST_STORAGE: storage, TEST_ENGINE_PORT: String(port), PORT: "0", RIVET_LOG_LEVEL: "error",
    OPENROUTER_API_KEY: "or-test-key", OPENROUTER_BASE_URL: options.models.url, OPENMERIT_ALLOW_PRIVATE_ENDPOINTS: "1",
    OPENMERIT_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), OPENMERIT_PUBLIC_URL: "https://openmerit.test", OPENMERIT_APP_URL: "https://app.openmerit.test",
    ...options.env,
  };
  const child = spawn(process.execPath, [new URL("./serve.ts", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr!.on("data", chunk => { output += chunk; });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The app did not start in 90 s:\n${output}`)), 90_000);
    child.stdout!.on("data", chunk => {
      const match = /ready (\S+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`The app exited with ${code}:\n${output}`)); });
  });
  return { url, child, storage, enginePort: port, env };
}

/** SIGKILLs the app and the engine it started, as a crash or a lost node would. */
export async function crash(app: App): Promise<void> {
  const exited = new Promise(resolve => app.child.once("exit", resolve));
  app.child.kill("SIGKILL");
  await exited;
  await stopEngine(app);
}

export async function stop(app: App): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null) await crash(app);
}

async function stopEngine(app: App): Promise<void> {
  try {
    const { pid } = JSON.parse(readFileSync(join(app.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8")) as { pid: number };
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
  for (let waited = 0; waited < 20_000 && !(await free(app.enginePort)); waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
}

export function caller(app: App, token: string | null) {
  const headers = (extra: Record<string, string> = {}) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extra });
  let id = 0;
  return {
    fetch: (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init, headers: headers(init.headers as Record<string, string> | undefined) }),
    api: async <T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
      const response = await fetch(`${app.url}${path}`, { ...init, headers: headers(init.headers as Record<string, string> | undefined) });
      return { status: response.status, body: await response.json() as T };
    },
    rpc: async (method: string, params: unknown = {}) => {
      const response = await fetch(`${app.url}/mcp`, { method: "POST", headers: headers({ accept: "application/json, text/event-stream" }), body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      return { status: response.status, headers: response.headers, body: await response.json() as { result?: { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; tools?: { name: string }[] } & Record<string, unknown>; error?: { message: string } } };
    },
    tool: async (name: string, args: Record<string, unknown>) => {
      const { body } = await (async () => {
        const response = await fetch(`${app.url}/mcp`, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
        return { body: await response.json() as { result: { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean } } };
      })();
      return { text: body.result.content[0]!.text, data: body.result.structuredContent, isError: body.result.isError === true };
    },
  };
}

/** Sends Stripe's events for a paid subscription to the account, signed as Stripe signs them. */
export async function subscribe(app: App, accountId: string, plan: { includedEvals?: number; overage?: "metered" | "refuse" } = {}) {
  const send = async (event: object) => {
    const payload = JSON.stringify(event);
    return fetch(`${app.url}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(payload, "whsec_test") }, body: payload });
  };
  const now = Math.floor(Date.now() / 1000);
  await send({ id: `evt_co_${accountId}`, type: "checkout.session.completed", created: now, data: { object: { client_reference_id: accountId, customer: `cus_${accountId}` } } });
  return send({
    id: `evt_sub_${accountId}`, type: "customer.subscription.created", created: now,
    data: { object: { id: `sub_${accountId}`, customer: `cus_${accountId}`, status: "active", metadata: { account_id: accountId }, current_period_start: now - 3600, current_period_end: now + 30 * 86400,
      items: { data: [{ price: { nickname: "Team", metadata: { included_evals: String(plan.includedEvals ?? 50), overage: plan.overage ?? "refuse" } } }] } } },
  });
}

/** A label task: six examples with answers and one without, which the label check asks about with the written cases. */
export function bundle(task = "ticket classifier", unlabeled = true) {
  const entries = Object.entries(TICKETS);
  return {
    task, current: { model: "openai/gpt-5.4" },
    prompt: { system: "You route support tickets.", messages: [{ role: "user", content: "Ticket: {{ticket}}" }] },
    output: { kind: "label", labels: ["billing", "technical", "account"] },
    examples: [...entries.slice(0, 6).map(([ticket, queue]) => ({ input: { ticket }, expected: queue })), ...(unlabeled ? [{ input: { ticket: entries[6]![0] } }] : [])],
    codeRefs: [{ file: "src/classify.ts", line: 12, spelling: "gpt-5.4" }],
  };
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls openmerit_result until `done` says so. */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out; last value: ${JSON.stringify(value).slice(0, 2000)}`);
    await sleep(500);
  }
}
