// Test fixtures: the app in a child process on a local Rivet engine, a fake OpenAI-compatible model
// server standing in for OpenRouter and customer endpoints (and the case writer), and signed Stripe events. No real
// credential reaches the child and no paid model is called.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signStripePayload } from "../../src/server/billing.ts";
import type { Catalogue } from "../../src/server/engine.ts";

export const catalogue = JSON.parse(readFileSync(new URL("../../data/catalogue.json", import.meta.url), "utf8")) as Catalogue;

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
/** Clerk settings that sign people in through the test sign-in. */
export const CLERK = { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` };
export type Data = Record<string, unknown>;
export type Result = { status: string; pick: { model: string; passes: number; total: number; savingPerCallUsd: number | null; paybackCalls: number | null } | null; edit: { edits: { before: string; after: string }[] }; reportUrl: string; spend: { openmeritUsd: number; customerUsd: number } };
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** `cost`, when set, overrides what a call to that model reports it cost. */
/** `keyStatus`, when set, is what GET /key answers instead of 200, such as 401 for an expired key. */
/**
 * Offered tools, the fake acts as an agent: it looks the ticket up once, then answers. A model `misuse`
 * picks calls a tool the request does not offer instead, then answers the same.
 */
/** `writes: false` makes the case writer answer with no cases. */
export interface FakeModels { url: string; calls: { model: string; ticket: string; auth: string }[]; onCall: ((index: number) => Promise<void>) | null; cost: ((model: string) => number | undefined) | null; keyStatus?: number; misuse?: (model: string) => boolean; writes?: boolean; close: () => Promise<void> }
/** The calls the fake answered as the case writer. */
export const writerCalls = (models: FakeModels) => models.calls.filter(call => call.ticket.startsWith("writer:"));

/**
 * An OpenAI chat completions answer with OpenRouter's usage and cost: streamed as server-sent events
 * when the request asks, as openmerit/ranking's Pi client does, else one JSON body.
 */
export function chatAnswer(res: ServerResponse, request: { stream?: boolean }, answer: string | { tool: string; args: object }, usage: Record<string, number>): void {
  const billed = { ...usage, is_byok: false };
  const message = typeof answer === "string" ? { role: "assistant", content: answer }
    : { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] };
  const finish = typeof answer === "string" ? "stop" : "tool_calls";
  if (!request.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: billed }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [{ choices: [{ index: 0, delta: message, finish_reason: finish }] }, { choices: [], usage: billed }]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

export async function fakeModels(): Promise<FakeModels> {
  const eci = new Map(catalogue.models.map(model => [model.id, model.eci]));
  const fake: FakeModels = { url: "", calls: [], onCall: null, cost: null, close: async () => {} };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      // OpenMerit checks its model key with OpenRouter's free GET /key before a job starts.
      if (req.url === "/key") { res.writeHead(fake.keyStatus ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(fake.keyStatus ? { error: { code: fake.keyStatus, message: "API key expired" } } : { data: { label: "test" } })); return; }
      const parsed = JSON.parse(body) as { model: string; stream?: boolean; tools?: unknown[]; messages: { role: string; content: string }[] };
      const text = parsed.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
      // openmerit/ranking's case writer: the same two cases each time, so its second request adds nothing new.
      const writer = parsed.messages[0]?.role === "system" && parsed.messages[0].content.startsWith("You write test cases");
      // The grading loop's reviser, on the cases' writer model: it adds one criterion from the grades.
      const reviser = parsed.messages[0]?.role === "system" && parsed.messages[0].content.startsWith("You are OpenMerit Harness revising");
      const ticket = reviser ? "reviser" : writer ? `writer:${/Write (\d+) cases/.exec(text)?.[1] ?? "?"}` : Object.keys(QUEUES).find(item => text.includes(item)) ?? "";
      const index = fake.calls.push({ model: parsed.model, ticket, auth: String(req.headers.authorization ?? "") }) - 1;
      if (fake.onCall) await fake.onCall(index);
      const weak = (eci.get(parsed.model) ?? 200) < WEAK_BELOW;
      // A writer asked through a harness (the reviser's) gives each input as a list of {name, value}.
      const listed = text.includes("list of {name, value}");
      const answer = reviser ? JSON.stringify({ criteria: ["The queue is the one the ticket's main problem belongs to."], guardrails: [] })
        : writer ? JSON.stringify({ cases: Object.entries(fake.writes === false ? {} : WRITTEN).map(([written, queue]) => (listed ? { kind: "typical", input: [{ name: "ticket", value: written }], expected: queue, toolResults: [] } : { input: { ticket: written }, expected: queue })) })
        : weak ? "other" : QUEUES[ticket] ?? "other";
      const usage = { prompt_tokens: 50, completion_tokens: 2, cost: fake.cost?.(parsed.model) ?? costOf(parsed.model) };
      if (parsed.tools?.length && !parsed.messages.some(message => message.role === "tool")) {
        return chatAnswer(res, parsed, fake.misuse?.(parsed.model) ? { tool: "close_ticket", args: { ticket } } : { tool: "lookup_ticket", args: { ticket } }, usage);
      }
      chatAnswer(res, parsed, answer, usage);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

/** A fake PostHog capture endpoint: the events the app posted, in order. Point POSTHOG_HOST at `url`. */
export interface CapturedEvent { event: string; distinct_id: string; uuid: string; timestamp: string; properties: Record<string, unknown>; api_key: string }
export async function fakeCapture(): Promise<{ url: string; events: CapturedEvent[]; close: () => Promise<void> }> {
  const events: CapturedEvent[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/i/v0/e/") events.push(JSON.parse(body) as CapturedEvent);
      res.writeHead(200, { "content-type": "application/json" }).end("{\"status\":\"Ok\"}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
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
    // OPENMERIT_HOME in the storage: a self-hosted app reads `openmerit connect`'s harness there, never this machine's.
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OPENMERIT_HOME: storage, TEST_STORAGE: storage, TEST_LOCAL_TOKEN: LOCAL_TOKEN, TEST_ENGINE_PORT: String(port), PORT: "0", RIVET_LOG_LEVEL: "error",
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

/** Stops the app and its engine for good and deletes its storage, about 130 MB of engine data each. */
export async function stop(app: App): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null) await crash(app);
  rmSync(app.storage, { recursive: true, force: true });
}

async function stopEngine(app: App): Promise<void> {
  try {
    const { pid } = JSON.parse(readFileSync(join(app.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8")) as { pid: number };
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
  for (let waited = 0; waited < 20_000 && !(await free(app.enginePort)); waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
}

/** A self-hosted test server's token: the coding agent's and scripts' sign-in, never a person's. */
export const LOCAL_TOKEN = "omt_test-local-token";

/** The person on a self-hosted server: signed in to its web app through a sign-in link, with the session cookie and the server's own origin. */
export async function signedInPerson(app: App) {
  const link = await (await fetch(`${app.url}/api/session/link`, { method: "POST", headers: { authorization: `Bearer ${LOCAL_TOKEN}` } })).json() as { url: string };
  const opened = await fetch(new URL(new URL(link.url).pathname + new URL(link.url).search, app.url), { redirect: "manual" });
  const cookie = opened.headers.get("set-cookie")?.split(";")[0];
  if (opened.status !== 303 || !cookie) throw new Error(`the sign-in link did not open a session: ${opened.status}`);
  return {
    cookie, link: link.url,
    api: async <T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
      const response = await fetch(`${app.url}${path}`, { ...init, headers: { cookie, origin: app.url, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
      return { status: response.status, body: await response.json() as T };
    },
  };
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
    tool: async (name: string, args: Record<string, unknown>, extra: Record<string, string> = {}) => {
      const response = await fetch(`${app.url}/mcp`, { method: "POST", headers: headers(extra), body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
      const body = await response.json() as { result?: { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean }; error?: unknown };
      if (!body.result) throw new Error(`${name} answered ${response.status} without a result: ${JSON.stringify(body)}`);
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
    codeRefs: [{ file: "src/classify.ts", line: 12, spelling: 'const MODEL = "gpt-5.4";' }],
  };
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls a job's openmerit_result until it ends, grading its answers on the way as OpenMerit graded them:
 * a person who agrees with the eval on every sample accepts it in the first round.
 */
/**
 * A person's grade of a grading question, which shows the answer without the eval's own grade: right when the answer
 * names the ticket's queue, by `truth` when a test's person changed an expected answer. Like the eval's judge, it grades
 * the answer; the agent eval checks the tool calls.
 */
export function personGrade(detail: string, truth: Record<string, string> = QUEUES): "good" | "bad" {
  const input = /Input:\n([^]*?)\nAnswer:/.exec(detail)?.[1] ?? "";
  const answer = /Answer:\n([^]*?)(?:\nTool calls: |$)/.exec(detail)?.[1]?.trim() ?? "";
  const ticket = Object.keys(truth).find(item => input.includes(item));
  return ticket && answer === truth[ticket] ? "good" : "bad";
}

/**
 * Polls openmerit_result until the job finishes. A grading round is graded as a person would (personGrade),
 * relayed by the coding agent and confirmed by the same caller as the person, as the app would.
 */
/** Runs a job to its end, grading each answer as a person would; `onGrades` sees each set of grading questions. */
export async function untilDone<T extends { text: string; data: Record<string, unknown> }>(agent: { tool: (name: string, args: Record<string, unknown>) => Promise<T>; api: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }> }, jobId: string, timeoutMs = 180_000, onGrades?: (questions: { id: string; detail: string }[]) => void, truth?: Record<string, string>): Promise<T> {
  return waitFor(async () => {
    const value = await agent.tool("openmerit_result", { job_id: jobId });
    if (value.data.status === "needs_input" && value.data.phase === "grading") {
      const questions = value.data.questions as { id: string; detail: string }[];
      onGrades?.(questions);
      const held = await agent.tool("openmerit_answer", { job_id: jobId, answers: Object.fromEntries(questions.map(question => [question.id, personGrade(question.detail, truth)])) });
      const confirmation = held.data.confirmation as { id: string } | undefined;
      if (!confirmation) throw new Error(`Grades were not held for confirmation: ${held.text}`);
      await agent.api(`/api/confirmations/${confirmation.id}`, { method: "POST", body: JSON.stringify({ confirm: true }) });
    }
    return value;
  }, value => ["done", "failed", "stopped"].includes(String(value.data.status)), timeoutMs);
}

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
