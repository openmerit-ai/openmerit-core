// The Ranking primitive against a local fake that speaks OpenRouter's and OpenAI's chat completions
// and Anthropic's Messages API: no paid calls. Each model name scripts one behavior, and costs are
// distinct per role (candidate $0.001 a call, judge $0.01, writer $0.1), so a cost counted in the
// wrong place or twice shows up in the totals.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { loadCatalogue } from "../catalogue/catalogue.ts";
import {
  applyLabelCheck, BudgetRefused, CandidateUnavailable, completeWith, createClient, createMeasure, exactMatch, graderFor, jsonSchema, judge,
  labelMatch, LABEL_CHECK_QUESTION, DEFAULT_MAX_TURNS, flow, invalidCases, MemoryLedger, stepChecksFor, checksBasedOn, writeCases, type Case, type EndpointConfig, type Ledger, type TaskBundle,
} from "./index.ts";

const LABELS: Record<string, string> = { "I was charged twice": "billing", "The app crashes on login": "technical", "Where is my parcel?": "shipping" };

interface Seen { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
const seen: Seen[] = [];
/** Requests the fake answers with HTTP 429 before it answers properly, per model. */
const rateLimits = new Map<string, number>();
/** The fake answers this model's next request with HTTP 500 that still reports a cost, as some providers do. */
let costlyFailure = "";

const lastUser = (body: Record<string, unknown>) => {
  const messages = body.messages as { role: string; content: unknown }[];
  const user = messages.filter(message => message.role === "user").at(-1);
  return user === undefined ? "" : typeof user.content === "string" ? user.content : JSON.stringify(user.content);
};
const toolResults = (body: Record<string, unknown>, anthropic: boolean): string[] => {
  const messages = body.messages as { role: string; content: unknown; tool_call_id?: string }[];
  if (!anthropic) return messages.filter(message => message.role === "tool").map(message => String(message.content));
  return messages.flatMap(message => (Array.isArray(message.content) ? (message.content as { type: string; content?: string }[]).filter(block => block.type === "tool_result").map(block => String(block.content)) : []));
};

/** What one scripted model says: text, or a tool call. */
function script(model: string, body: Record<string, unknown>, anthropic: boolean): { text?: string; tool?: { name: string; args: object }; cost: number } {
  const user = lastUser(body);
  switch (model) {
    case "good": return { text: LABELS[user] ?? "other", cost: 0.001 };
    case "wordy": return { text: `This is about **${LABELS[user] ?? "other"}**.`, cost: 0.001 };
    case "hedger": return { text: "billing or technical", cost: 0.001 };
    case "looper": return { tool: { name: "lookup_order", args: { id: "1" } }, cost: 0.001 };
    case "tool-user": {
      const results = toolResults(body, anthropic);
      return results.length ? { text: results.join(" ").includes("refunded") ? "billing" : "other", cost: 0.001 } : { tool: { name: "lookup_order", args: { id: "42" } }, cost: 0.001 };
    }
    // An agent: looks the order up, then refunds it, then answers from both results.
    case "agent": {
      const results = toolResults(body, anthropic);
      if (results.length === 0) return { tool: { name: "lookup_order", args: { id: "42" } }, cost: 0.001 };
      if (results.length === 1) return { tool: { name: "refund_order", args: { id: "42", reason: results[0]!.includes("damaged") ? "damaged" : "other" } }, cost: 0.001 };
      return { text: results[1]!.includes("refund-7") ? "billing" : "other", cost: 0.001 };
    }
    // Calls a tool the task does not offer, then answers.
    case "inventor": return toolResults(body, anthropic).length ? { text: "billing", cost: 0.001 } : { tool: { name: "delete_account", args: { id: "42" } }, cost: 0.001 };
    // Calls lookup_order without its required id; `fixer` then calls it again correctly, `stubborn` answers anyway.
    case "fixer": case "stubborn": {
      const results = toolResults(body, anthropic);
      if (results.length === 0) return { tool: { name: "lookup_order", args: {} }, cost: 0.001 };
      if (results.length === 1 && model === "fixer") return { tool: { name: "lookup_order", args: { id: "42" } }, cost: 0.001 };
      return { text: results.at(-1)!.includes("refunded") ? "billing" : "other", cost: 0.001 };
    }
    // The agent's two tools the other way round: refunds, then looks the order up.
    case "refund-first": {
      const results = toolResults(body, anthropic);
      if (results.length === 0) return { tool: { name: "refund_order", args: { id: "42", reason: "other" } }, cost: 0.001 };
      if (results.length === 1) return { tool: { name: "lookup_order", args: { id: "42" } }, cost: 0.001 };
      return { text: "billing", cost: 0.001 };
    }
    // Looks up two codes, then answers with both results.
    case "coder": {
      const results = toolResults(body, anthropic);
      if (results.length < 2) return { tool: { name: "lookup_code", args: { code: results.length ? "Z99" : "M54.5" } }, cost: 0.001 };
      return { text: results.join(" | "), cost: 0.001 };
    }
    case "json": return { text: "```json\n{\"queue\": \"billing\", \"urgent\": true, \"note\": \"anything\"}\n```", cost: 0.001 };
    // Says the right queue and, for the guardrail case, also promises what it must not.
    case "promiser": return { text: `${LABELS[user] ?? "billing"}. ${user.includes("refund") ? "I promise you a full refund today." : ""}`.trim(), cost: 0.001 };
    // A judge that passes the rubric but fails guardrail G1 when the answer promises a refund, with a reason that holds a secret.
    case "checker": return { text: user.includes("I promise you a full refund") ? JSON.stringify({ checks: [{ id: "C1", pass: true, reason: "right queue" }, { id: "G1", pass: false, reason: "It promised a refund, using key sk-or-v1-0123456789abcdef0123456789abcdef0123." }], pass: true, reason: "fine" }) : JSON.stringify({ checks: [{ id: "C1", pass: true, reason: "ok" }], pass: true, reason: "ok" }), cost: 0.01 };
    case "spec-writer": return { text: JSON.stringify({ cases: [
      { kind: "guardrail", input: { ticket: "Refund me now or I sue" }, expected: "billing", toolResults: { lookup_order: { status: "refunded" }, drop_tables: true } },
      { kind: "edge", input: { ticket: "Parcel arrived broken and I was charged twice" }, expected: "billing" },
      { kind: "made-up", input: { ticket: "My login code never comes" }, expected: "technical" },
    ] }), cost: 0.1 };
    case "judge": return { text: user.includes("Answer to grade:\nbilling") ? "{\"pass\": true, \"reason\": \"right queue\"}" : "{\"pass\": false, \"reason\": \"wrong\"}", cost: 0.01 };
    case "writer": return {
      text: JSON.stringify({ cases: [
        { input: { ticket: "Refund my order" }, expected: "billing" },
        { input: { ticket: "I was charged twice" }, expected: "billing" }, // repeats an example
        { input: { ticket: "Hello" }, expected: "sales" }, // not a label
        { input: { other: "x" }, expected: "other" }, // no {{ticket}}
        { input: { ticket: "Password reset never arrives" }, expected: "Technical" },
      ] }),
      cost: 0.1,
    };
    default: return { text: "", cost: 0 };
  }
}

/** The engine's in-memory ledger, also recording every key reserved, to count calls by key. */
function memoryLedger(caps: ConstructorParameters<typeof MemoryLedger>[0] = {}): Ledger & { keys: Set<string> } {
  const inner = new MemoryLedger(caps), keys = new Set<string>();
  return {
    keys,
    reserve: input => { keys.add(input.key); return inner.reserve(input); },
    settle: (key, cost) => inner.settle(key, cost),
    release: key => inner.release(key),
    spent: () => inner.spent(),
  };
}

/** A streamed answer, as Pi asks for: Anthropic's named events, or OpenAI's chunks and [DONE]. */
function events(res: import("node:http").ServerResponse, items: Record<string, unknown>[], anthropic: boolean) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const item of items) res.write(`${anthropic ? `event: ${String(item.type)}\n` : ""}data: ${JSON.stringify(item)}\n\n`);
  res.end(anthropic ? "" : "data: [DONE]\n\n");
}

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = (req.url ?? "").replace(/\?.*/, "");
      seen.push({ path, headers: req.headers, body });
      const model = String(body.model);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      const limited = rateLimits.get(model) ?? 0;
      if (limited > 0) { rateLimits.set(model, limited - 1); return json(429, { error: { message: "slow down" } }, { "retry-after": "0" }); }
      if (model === costlyFailure) { costlyFailure = ""; return json(500, { error: { message: "overloaded" }, usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.5 } }, { "retry-after": "0" }); }
      // A model that takes the request and never answers.
      if (model === "silent") return;
      if (model === "missing") return json(404, { error: { message: `The model ${model} does not exist` } });
      const anthropic = path.endsWith("/messages");
      const answer = script(model, body, anthropic);
      if (anthropic) {
        if (req.headers["x-api-key"] !== "sk-ant-fake" || req.headers["anthropic-version"] !== "2023-06-01") return json(401, { error: { message: "bad key" } });
        const block = answer.tool ? { type: "tool_use", id: `toolu_${seen.length}`, name: answer.tool.name, input: {} } : { type: "text", text: "" };
        const delta = answer.tool ? { type: "input_json_delta", partial_json: JSON.stringify(answer.tool.args) } : { type: "text_delta", text: answer.text };
        return events(res, [
          { type: "message_start", message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_delta", index: 0, delta }, { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: answer.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 100 } }, { type: "message_stop" },
        ], true);
      }
      if (req.headers.authorization !== "Bearer sk-fake") return json(401, { error: { message: "bad key" } });
      const delta = answer.tool
        ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }
        : { role: "assistant", content: answer.text };
      // OpenRouter reports what the call cost; OpenAI-style endpoints report only tokens.
      const usage = { prompt_tokens: 1000, completion_tokens: 100, ...(path.startsWith("/openrouter") ? { cost: answer.cost, is_byok: false } : {}) };
      events(res, [{ choices: [{ index: 0, delta, finish_reason: answer.tool ? "tool_calls" : "stop" }] }, { choices: [], usage }], false);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { seen.length = 0; rateLimits.clear(); costlyFailure = ""; });

const endpoints = (): EndpointConfig[] => [
  { id: "openrouter", kind: "openrouter", baseUrl: `${base}/openrouter/v1`, apiKey: "sk-fake", funding: "openmerit" },
  { id: "acme", kind: "openai-compatible", baseUrl: `${base}/acme/v1`, apiKey: "sk-fake", funding: "customer" },
  { id: "anthropic", kind: "anthropic", baseUrl: `${base}/anthropic/v1`, apiKey: "sk-ant-fake", funding: "customer" },
];
// $1 per million input tokens and $10 per million output: 1000 in and 100 out is $0.002.
const priced = { ...loadCatalogue().models[0]!, inputPerM: 1, outputPerM: 10 };
const client = () => createClient(endpoints(), { model: () => priced });

const bundle: TaskBundle = {
  task: "ticket triage", current: { model: "openai/gpt-5" },
  prompt: { system: "Route the ticket to one queue: billing, technical or shipping.", messages: [{ role: "user", content: "{{ticket}}" }] },
  output: { kind: "label", labels: ["billing", "technical", "shipping"] },
  examples: [{ input: { ticket: "I was charged twice" }, expected: "billing" }, { input: { ticket: "The app crashes on login" }, expected: "technical" }],
};
const cases: Case[] = Object.entries(LABELS).map(([ticket, expected], index) => ({ id: `c${index + 1}`, input: { ticket }, expected, origin: "example" }));
const ids = cases.map(item => item.id);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("OpenRouter's reported cost is the cost; an OpenAI-compatible endpoint's is estimated from its tokens and billed to the customer", async () => {
  const ledger = memoryLedger();
  const measure = createMeasure({ bundle, cases, client: client(), grader: labelMatch(), ledger, key: "job-1" });
  const onOpenRouter = await measure({ model: "good", endpoint: "openrouter" }, ids);
  assert.deepEqual(onOpenRouter.results.map(item => item.pass), [true, true, true]);
  near(onOpenRouter.costUsd, 0.003);
  assert.equal(onOpenRouter.costIsEstimate, false);
  assert.equal(seen[0]!.headers.authorization, "Bearer sk-fake");
  assert.deepEqual(seen[0]!.body.usage, { include: true });
  assert.equal(seen[0]!.body.max_tokens, 4096);
  const onAcme = await measure({ model: "good", endpoint: "acme" }, ids);
  near(onAcme.costUsd, 0.006);
  assert.equal(onAcme.costIsEstimate, true);
  assert.ok(onAcme.latencyMs !== null && onAcme.latencyMs >= 0);
  const spent = await ledger.spent();
  near(spent.openmeritUsd, 0.003);
  near(spent.customerUsd, 0.006);
});

test("a call retried after a rate limit or a failure that reports a cost is charged once, for the answer kept", async () => {
  const ledger = memoryLedger();
  rateLimits.set("good", 2);
  costlyFailure = "good";
  const measure = createMeasure({ bundle, cases: cases.slice(0, 1), client: client(), grader: labelMatch(), ledger, key: "job-1", concurrency: 1 });
  const result = await measure({ model: "good", endpoint: "openrouter" }, ["c1"]);
  assert.equal(seen.length, 4, "two rate limits, one costly failure, one answer");
  assert.equal(result.results[0]!.pass, true);
  near(result.costUsd, 0.001);
  assert.equal(ledger.keys.size, 1);
  near((await ledger.spent()).openmeritUsd, 0.001);
});

test("a replayed measure is charged once in the ledger; a deliberate repeat is charged again", async () => {
  // Model calls are not exactly-once: a replay may send a call again, but its key was settled already.
  const ledger = memoryLedger();
  const measure = createMeasure({ bundle, cases, client: client(), grader: labelMatch(), ledger, key: "job-1" });
  await measure({ model: "good", endpoint: "openrouter" }, ids);
  await measure({ model: "good", endpoint: "openrouter" }, ids);
  near((await ledger.spent()).openmeritUsd, 0.003);
  await measure({ model: "good", endpoint: "openrouter" }, ids, { run: "repeat-2" });
  near((await ledger.spent()).openmeritUsd, 0.006);
});

test("the judge's cost is metered but not charged to the candidate", async () => {
  const ledger = memoryLedger();
  const textBundle: TaskBundle = { ...bundle, output: { kind: "text" } };
  const grader = judge({ client: client(), endpoint: "openrouter", model: "judge", rubric: "Names the right queue." });
  const measure = createMeasure({ bundle: textBundle, cases, client: client(), grader, ledger, key: "job-1" });
  const result = await measure({ model: "good", endpoint: "acme" }, ids);
  assert.deepEqual(result.results.map(item => item.pass), [true, false, false]);
  near(result.costUsd, 0.006);
  near(result.graderCostUsd, 0.03);
  const spent = await ledger.spent();
  near(spent.customerUsd, 0.006);
  near(spent.openmeritUsd, 0.03);
  const judged = seen.filter(item => item.body.model === "judge");
  assert.equal(judged.length, 3);
  assert.match(lastUser(judged[0]!.body), /Reference answer:\nbilling/);
});

test("tool calls get the bundle's mocked results, and a model that never stops calling tools fails after a bounded number of calls", async () => {
  const withTool: TaskBundle = { ...bundle, tools: [{ name: "lookup_order", description: "Finds an order", parameters: { type: "object", properties: { id: { type: "string" } } }, mockResult: { status: "refunded" } }] };
  for (const endpoint of ["openrouter", "anthropic"]) {
    seen.length = 0;
    const ledger = memoryLedger();
    const measure = createMeasure({ bundle: withTool, cases: cases.slice(0, 1), client: client(), grader: labelMatch(), ledger, key: "job-1" });
    const used = await measure({ model: "tool-user", endpoint }, ["c1"]);
    assert.equal(used.results[0]!.pass, true, `${endpoint}: the tool's mocked result reached the model`);
    assert.equal(seen.length, 2);
    const tools = seen[0]!.body.tools as Record<string, unknown>[];
    assert.ok(endpoint === "anthropic" ? tools[0]!.input_schema : (tools[0]!.function as Record<string, unknown>).parameters);

    seen.length = 0;
    const looped = await measure({ model: "looper", endpoint }, ["c1"]);
    assert.deepEqual(looped.results, [{ caseId: "c1", pass: false, failure: "tool_loop", reason: "It kept calling tools past the limit and never answered." }]);
    assert.equal(seen.length, DEFAULT_MAX_TURNS, `${endpoint}: calls stop`);
    assert.equal(ledger.keys.size, 2 + DEFAULT_MAX_TURNS, `${endpoint}: each call has its own ledger key`);
  }
});

test("an agent's tools answer from the case's mocked results in order, and the task's turn limit stops it", async () => {
  const agent: TaskBundle = {
    ...bundle, constraints: { maxTurns: 3 },
    tools: [
      { name: "lookup_order", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, mockResult: { status: "delivered" } },
      { name: "refund_order", parameters: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] }, mockResult: "refund-7" },
    ],
  };
  // The case's own result for lookup_order replaces the tool's; refund_order keeps its mockResult.
  const agentCases: Case[] = [{ ...cases[0]!, toolResults: { lookup_order: { status: "damaged" } } }];
  for (const endpoint of ["openrouter", "anthropic"]) {
    seen.length = 0;
    const runs: { toolCalls: { name: string; arguments: string }[]; roles: string[] }[] = [];
    const measure = createMeasure({
      bundle: agent, cases: agentCases, client: client(), grader: labelMatch(), ledger: memoryLedger(), key: "job-1",
      onCase: (_result, run) => runs.push({ toolCalls: run!.toolCalls, roles: run!.transcript.map(item => item.role) }),
    });
    const result = await measure({ model: "agent", endpoint }, ["c1"]);
    assert.deepEqual(result.results.map(item => item.pass), [true], `${endpoint}: the refund's mocked result reached the answer`);
    assert.equal(seen.length, 3);
    assert.deepEqual(runs[0]!.toolCalls.map(call => [call.name, JSON.parse(call.arguments)]), [["lookup_order", { id: "42" }], ["refund_order", { id: "42", reason: "damaged" }]], `${endpoint}: in order, on the case's result`);
    assert.deepEqual(runs[0]!.roles.filter(role => role !== "system"), ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
    assert.doesNotMatch(JSON.stringify(result), /refund-7|damaged/, "the measure keeps no output or transcript");

    seen.length = 0;
    const tight = createMeasure({ bundle: { ...agent, constraints: { maxTurns: 2 } }, cases: agentCases, client: client(), grader: labelMatch(), ledger: memoryLedger(), key: "job-1" });
    assert.deepEqual((await tight({ model: "agent", endpoint }, ["c1"])).results, [{ caseId: "c1", pass: false, failure: "tool_loop", reason: "It kept calling tools past the limit and never answered." }], `${endpoint}: two calls are not enough`);
    assert.equal(seen.length, 2, `${endpoint}: no third call`);
  }
});

const order = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const refund = { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] };
const orderTools: TaskBundle = { ...bundle, tools: [{ name: "lookup_order", parameters: order, mockResult: { status: "refunded" } }, { name: "refund_order", parameters: refund, mockResult: "refund-7" }] };
const flowOf = async (task: TaskBundle, model: string, endpoint: string, caseList: Case[] = cases.slice(0, 1)) => {
  const runs: NonNullable<Parameters<NonNullable<Parameters<typeof createMeasure>[0]["onCase"]>>[1]>[] = [];
  const measure = createMeasure({ bundle: task, cases: caseList, client: client(), grader: flow(labelMatch()), ledger: memoryLedger(), key: "job-1", onCase: (_result, run) => { if (run) runs.push(run); } });
  const result = await measure({ model, endpoint }, caseList.map(item => item.id));
  return { result: result.results[0]!, run: runs[0]! };
};

test("flow: an invented tool fails the case; refused arguments go back to the model, which may fix them", async () => {
  for (const endpoint of ["openrouter", "anthropic"]) {
    const invented = await flowOf(orderTools, "inventor", endpoint);
    assert.deepEqual(invented.result, { caseId: "c1", pass: false, reason: "It called delete_account, a tool the task does not offer." }, `${endpoint}: it answered right, but invented a tool`);
    assert.deepEqual(invented.run.refused.map(call => [call.tool, call.kind]), [["delete_account", "unknown_tool"]]);

    const fixed = await flowOf(orderTools, "fixer", endpoint);
    assert.equal(fixed.result.pass, true, `${endpoint}: it called again correctly within the turn limit`);
    assert.deepEqual(fixed.run.refused.map(call => [call.tool, call.kind]), [["lookup_order", "invalid_arguments"]], `${endpoint}: the refused call is recorded`);
    assert.match(fixed.run.refused[0]!.error, /id/, "with the schema's error, which went back as the tool's result");
    const results = fixed.run.transcript.filter(item => item.role === "toolResult");
    assert.deepEqual(results.map(item => item.role === "toolResult" && item.isError), [true, false]);

    const stubborn = await flowOf(orderTools, "stubborn", endpoint);
    assert.deepEqual(stubborn.result, { caseId: "c1", pass: false, reason: "Its call to lookup_order was refused for its arguments, and it never called it again correctly." }, `${endpoint}: never fixed`);
  }
});

test("a case with no mocked result for one of its tools is invalid for every model, and a measure will not run it", async () => {
  const unmocked: TaskBundle = { ...orderTools, tools: [orderTools.tools![0]!, { name: "refund_order", parameters: refund }] };
  const caseList: Case[] = [{ ...cases[0]!, toolResults: { refund_order: "refund-8" } }, cases[1]!, { ...cases[2]!, origin: "trace", input: { messages: "[]" } }];
  assert.deepEqual(invalidCases(unmocked, caseList), [{ caseId: "c2", reason: "It gives no mocked result for refund_order, so the eval cannot answer a call to it." }], "the case's own result covers c1; a trace case runs no tool");
  const measure = createMeasure({ bundle: unmocked, cases: caseList, client: client(), grader: flow(labelMatch()), ledger: memoryLedger(), key: "job-1" });
  await assert.rejects(measure({ model: "agent", endpoint: "openrouter" }, ["c1", "c2"]), /c2 \(It gives no mocked result for refund_order/);
  assert.equal(seen.length, 0, "nothing was sent");
});

test("a mocked result matched on the call's arguments answers each call, with the entry without `when` as the fallback", async () => {
  const lookup = { name: "lookup_code", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
  const codes: TaskBundle = { ...bundle, output: { kind: "text" }, tools: [lookup] };
  const caseWith = (toolResult: unknown): Case[] => [{ id: "c1", input: { ticket: "x" }, expected: "low back pain | no such code", origin: "written", toolResults: { lookup_code: toolResult } }];
  const run = async (toolResult: unknown) => {
    const runs: string[] = [];
    const measure = createMeasure({ bundle: codes, cases: caseWith(toolResult), client: client(), grader: flow(exactMatch()), ledger: memoryLedger(), key: "job-1", onCase: (_result, ran) => runs.push(JSON.stringify(ran?.refused)) });
    return { result: (await measure({ model: "coder", endpoint: "openrouter" }, ["c1"])).results[0]!, refused: runs[0] };
  };
  // The fallback comes first in the list, so a matcher that took the first entry would answer "no such code" twice.
  const matched = await run([{ result: "no such code" }, { when: { code: "M54.5" }, result: "low back pain" }]);
  assert.deepEqual(matched.result, { caseId: "c1", pass: true });
  const strict = await run([{ when: { code: "M54.5" }, result: "low back pain" }]);
  assert.deepEqual(strict.result, { caseId: "c1", pass: false, reason: "Its call to lookup_code found nothing for its arguments, and it never called it again with ones that did." }, "no entry matched Z99, and there is no fallback");
  assert.match(strict.refused!, /no_match/);
  // A list that is not all `{ when?, result }` entries is one result, sent as it is.
  const plainList = await run([{ code: "M54.5", name: "low back pain" }]);
  assert.match(plainList.result.reason ?? "", /^Answered "\[\{\\"code\\":\\"M54.5\\",\\"name\\":\\"low back pain\\"\}\] \| \[\{/);
});

test("steps: a required step must happen, and order is checked only where a step names earlier ones in `after`", async () => {
  const steps = (after?: number[]): TaskBundle => ({ ...orderTools, steps: [
    { description: "Look the order up", tools: ["lookup_order"], access: "read", required: true },
    { description: "Refund it", tools: ["refund_order"], access: "write", required: true, ...(after ? { after } : {}) },
    { description: "Tell the customer", required: true },
  ] });
  assert.deepEqual(stepChecksFor(steps([1])).unchecked.map(check => check.id), ["S3"], "a required step with no tools cannot be checked");
  assert.equal(checksBasedOn({ ...steps([1]), criteria: ["a", "b"], guardrails: ["c"] }), "Checks: C1–C2 (criteria); G1 (guardrails); S1, S2 (the spec's steps, on each case's tool calls). S3 lists no tools, so it is not checked.");
  for (const endpoint of ["openrouter", "anthropic"]) {
    assert.equal((await flowOf(steps([1]), "agent", endpoint)).result.pass, true, `${endpoint}: in order, and S3 does not fail it`);
    assert.deepEqual((await flowOf(steps([1]), "refund-first", endpoint)).result, { caseId: "c1", pass: false, reason: "S2: it called refund_order before step 1 (Look the order up)." }, `${endpoint}: out of order`);
    assert.equal((await flowOf(steps(), "refund-first", endpoint)).result.pass, true, `${endpoint}: without after, either order passes`);
    assert.equal((await flowOf(steps(), "agent", endpoint)).result.pass, true);
    assert.deepEqual((await flowOf(steps(), "tool-user", endpoint)).result, { caseId: "c1", pass: false, reason: "S2: it never called refund_order (Refund it)." }, `${endpoint}: a required step it skipped`);
  }
});

test("Anthropic gets its own request shape and the cost is estimated from its tokens", async () => {
  const ledger = memoryLedger();
  const measure = createMeasure({ bundle, cases: cases.slice(0, 1), client: client(), grader: labelMatch(), ledger, key: "job-1" });
  const result = await measure({ model: "good", endpoint: "anthropic" }, ["c1"]);
  assert.equal(result.results[0]!.pass, true);
  near(result.costUsd, 0.002);
  assert.equal(seen[0]!.path, "/anthropic/v1/messages");
  assert.deepEqual(seen[0]!.body.system, [{ type: "text", text: bundle.prompt.system }]);
  assert.equal((seen[0]!.body.messages as unknown[]).length, 1);
});

test("a candidate the endpoint refuses on every case is unavailable; a refused budget sends nothing", async () => {
  const measure = createMeasure({ bundle, cases, client: client(), grader: labelMatch(), ledger: memoryLedger(), key: "job-1" });
  await assert.rejects(measure({ model: "missing", endpoint: "openrouter" }, ids), CandidateUnavailable);

  seen.length = 0;
  const capped = createMeasure({ bundle, cases, client: client(), grader: labelMatch(), ledger: memoryLedger({ openmerit: 0.01 }), key: "job-1", concurrency: 1 });
  // 4096 output tokens at $10 a million reserve about $0.041, past the $0.01 cap.
  await assert.rejects(capped({ model: "good", endpoint: "openrouter" }, ["c1"]), BudgetRefused);
  assert.equal(seen.length, 0);
});

test("a candidate that never answers ends its measure within one call timeout, without retries, and other candidates are unaffected", async () => {
  const ledger = memoryLedger();
  const timeoutMs = 400;
  const quick = createClient(endpoints(), { model: () => priced, timeoutMs });
  // One case at a time: after the first silent call, the other cases are not sent.
  const measure = createMeasure({ bundle, cases, client: quick, grader: labelMatch(), ledger, key: "job-1", concurrency: 1 });
  const started = Date.now();
  const [silent, good] = await Promise.allSettled([measure({ model: "silent", endpoint: "openrouter" }, ids), measure({ model: "good", endpoint: "openrouter" }, ids)]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < timeoutMs + 1000, `took ${elapsed} ms`);
  assert.equal(silent.status, "rejected");
  assert.ok(silent.status === "rejected" && silent.reason instanceof CandidateUnavailable);
  assert.match(String((silent as PromiseRejectedResult).reason.message), /^silent on openrouter: openrouter did not answer \(no answer in 0 s\)/);
  assert.equal(seen.filter(item => item.body.model === "silent").length, 1, "a timed-out call is not retried, and no further case is sent");
  assert.deepEqual(good.status === "fulfilled" && good.value.results.map(item => item.pass), [true, true, true]);
  near((await ledger.spent()).openmeritUsd, 0.003);
});

test("results carry pass or fail only, never the candidate's output", async () => {
  const measure = createMeasure({ bundle, cases, client: client(), grader: labelMatch(), ledger: memoryLedger(), key: "job-1" });
  const result = await measure({ model: "wordy", endpoint: "openrouter" }, ids);
  assert.deepEqual(result.results.map(item => item.pass), [true, true, true]);
  assert.doesNotMatch(JSON.stringify(result), /This is about/);
  const hedged = await measure({ model: "hedger", endpoint: "openrouter" }, ["c1"]);
  assert.equal(hedged.results[0]!.pass, false, "an answer naming two labels does not pass for either");
});

test("graders: JSON schema with expected fields, and exact match", async () => {
  const jsonBundle: TaskBundle = { ...bundle, output: { kind: "json", schema: { type: "object", required: ["queue", "urgent"], properties: { queue: { type: "string" }, urgent: { type: "boolean" } } } } };
  const grade = (expected: unknown, output: string) => jsonSchema().grade({ bundle: jsonBundle, caseItem: { id: "c", input: {}, expected, origin: "written" }, output, ledger: memoryLedger(), key: "k" });
  const output = "```json\n{\"queue\": \"billing\", \"urgent\": true, \"note\": \"anything\"}\n```";
  assert.equal((await grade({ queue: "billing" }, output)).pass, true);
  assert.equal((await grade({ queue: "billing", urgent: false }, output)).pass, false);
  assert.equal((await grade({ queue: "billing" }, "{\"queue\": \"billing\"}")).pass, false, "the schema requires urgent");
  assert.equal((await grade(undefined, "not json")).pass, false);
  const exact = (output: string) => exactMatch().grade({ bundle, caseItem: { id: "c", input: {}, expected: "Paris", origin: "written" }, output, ledger: memoryLedger(), key: "k" });
  assert.equal((await exact("  paris \n")).pass, true);
  assert.equal((await exact("Paris, France")).pass, false);
});

test("the case writer puts the examples first, drops written cases that do not fit, and asks the label check", async () => {
  const ledger = memoryLedger();
  const complete = completeWith(client(), { endpoint: "openrouter", model: "writer" }, ledger, "job-1");
  const written = await writeCases({ bundle, complete, count: 3, labelCheck: true });
  assert.deepEqual(written.cases.map(item => [item.id, item.input.ticket, item.expected]), [
    ["example-1", "I was charged twice", "billing"],
    ["example-2", "The app crashes on login", "technical"],
    ["written-1", "Refund my order", "billing"],
    ["written-2", "Password reset never arrives", "technical"],
  ]);
  assert.equal(written.dropped, 8, "three unfit cases in the first answer; the second only repeats or does not fit");
  assert.equal(seen.filter(item => item.body.model === "writer").length, 2, "one more request when the first gives too few");
  near((await ledger.spent()).openmeritUsd, 0.2);
  assert.equal(written.question?.id, LABEL_CHECK_QUESTION);
  assert.deepEqual(written.question?.options?.map(option => option.value), ["written-1", "written-2"]);
  const kept = applyLabelCheck(written.cases, ["written-2"]);
  assert.deepEqual(kept.map(item => [item.id, item.approved]), [["example-1", undefined], ["example-2", undefined], ["written-2", true]]);
});

test("a trace case is sent as its recorded messages in one call, and graded by parity with the recorded answer", async () => {
  const trace: TaskBundle = {
    task: "support › triage", current: { model: "openai/gpt-5" }, output: { kind: "text" },
    prompt: { system: "Informational: the recorded system prompt", messages: [] },
    tools: [{ name: "lookup_order", parameters: {} }],
  };
  const recorded = (messages: object[], expected: object, id: string): Case => ({ id, input: { messages: JSON.stringify(messages) }, expected, origin: "trace" });
  const traced = [
    recorded([{ role: "system", content: "Route tickets." }, { role: "user", content: "Where is my parcel?" }], { role: "assistant", content: "shipping" }, "t-text"),
    recorded([
      { role: "user", content: "Refund order 42" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "lookup_order", arguments: "{\"id\":\"42\"}" } }] },
      { role: "tool", tool_call_id: "call_9", content: "{\"status\":\"refunded\"}" },
    ], { role: "assistant", content: "billing" }, "t-after-tool"),
    recorded([{ role: "user", content: "Check order 42" }], { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "lookup_order", arguments: "{ \"id\": \"42\" }" } }] }, "t-tool-call"),
  ];
  const measure = createMeasure({ bundle: trace, cases: traced, client: client(), grader: graderFor(trace), ledger: memoryLedger(), key: "job-1", concurrency: 1 });

  const text = await measure({ model: "good", endpoint: "openrouter" }, ["t-text"]);
  assert.equal(text.results[0]!.pass, true);
  assert.deepEqual(seen[0]!.body.messages, [{ role: "system", content: "Route tickets." }, { role: "user", content: "Where is my parcel?" }], "the recorded request, not the bundle's prompt");
  assert.deepEqual((seen[0]!.body.tools as { function: { parameters: object } }[])[0]!.function.parameters, { type: "object", properties: {} });

  for (const endpoint of ["openrouter", "anthropic"]) {
    seen.length = 0;
    const result = await measure({ model: "tool-user", endpoint }, ["t-after-tool", "t-tool-call"]);
    assert.deepEqual(result.results.map(item => item.pass), [true, true], `${endpoint}: the recorded tool result reached the model, and the same tool call matches`);
    assert.equal(seen.length, 2, `${endpoint}: one call per trace case, even when the answer is a tool call`);
    seen.length = 0;
    const wrong = await measure({ model: "looper", endpoint }, ["t-tool-call"]);
    assert.deepEqual(wrong.results, [{ caseId: "t-tool-call", pass: false, reason: "Called lookup_order with other arguments than the recorded call." }], `${endpoint}: other arguments fail`);
    assert.equal(seen.length, 1);
  }
  const anthropicRequest = (await (async () => { seen.length = 0; await measure({ model: "good", endpoint: "anthropic" }, ["t-text"]); return seen[0]!.body; })());
  assert.deepEqual(anthropicRequest.system, [{ type: "text", text: "Route tickets." }]);

  seen.length = 0;
  const textInsteadOfTool = await measure({ model: "good", endpoint: "openrouter" }, ["t-tool-call"]);
  assert.equal(textInsteadOfTool.results[0]!.pass, false, "text where the recorded answer called a tool");
});

const spec: TaskBundle = {
  ...bundle, description: "Route a support ticket to the queue that handles it.", input: { description: "a customer's support ticket, often angry" },
  criteria: ["Names the queue the ticket belongs to."], guardrails: ["promises a refund or compensation"],
};

test("the case writer writes from the task spec, and keeps each case's kind and its own results of the call's tools", async () => {
  const tools = [{ name: "lookup_order", parameters: { type: "object", properties: {} }, mockResult: { status: "shipped" } }];
  const examples = [{ input: { ticket: "Where is order 9?" }, expected: "other", toolResults: { lookup_order: { status: "lost" } } }];
  const written = await writeCases({ bundle: { ...spec, tools, examples }, complete: completeWith(client(), { endpoint: "openrouter", model: "spec-writer" }, memoryLedger(), "job-1"), count: 3 });
  assert.deepEqual(written.cases.map(item => [item.input.ticket, item.kind ?? item.origin]), [["Where is order 9?", "example"], ["Refund me now or I sue", "guardrail"], ["Parcel arrived broken and I was charged twice", "edge"], ["My login code never comes", "typical"]]);
  // Only the tools the call offers keep a result; a case without its own falls back to the tool's mocked result.
  assert.deepEqual(written.cases.map(item => item.toolResults ?? null), [{ lookup_order: { status: "lost" } }, { lookup_order: { status: "refunded" } }, null, null]);
  const prompt = lastUser(seen.find(item => item.body.model === "spec-writer")!.body);
  assert.match(prompt, /Its input: a customer's support ticket, often angry/);
  assert.match(prompt, /A right answer:\n- Names the queue the ticket belongs to\./);
  assert.match(prompt, /Guardrails, which the model must never break:\n- promises a refund or compensation/);
});

test("the judge checks every criterion and guardrail on the task's own rubric, and a failed case keeps its reason, redacted", async () => {
  const guarded: Case[] = [{ id: "g1", input: { ticket: "I want a refund for being charged twice" }, expected: "billing", origin: "written", kind: "guardrail" }, cases[0]!];
  const options = { judge: { client: client(), endpoint: "openrouter", model: "checker" } };
  // Free text: one judge call per case, on the rubric, the reference answer and every check.
  const text = createMeasure({ bundle: { ...spec, output: { kind: "text" } }, cases: guarded, client: client(), grader: graderFor({ ...spec, output: { kind: "text" } }, options), ledger: memoryLedger(), key: "job-1" });
  const promised = await text({ model: "promiser", endpoint: "acme" }, ["g1", "c1"]);
  assert.deepEqual(promised.results.map(item => [item.caseId, item.pass]), [["g1", false], ["c1", true]]);
  const reason = promised.results[0]!.reason!;
  assert.match(reason, /^G1: It promised a refund/);
  assert.ok(!reason.includes("0123456789abcdef"), reason);
  assert.equal(promised.results[1]!.reason, undefined, "a passed case keeps no reason");
  const asked = lastUser(seen.find(item => item.body.model === "checker")!.body);
  assert.match(asked, /^Task: ticket triage\n\nRubric: The answer does what the application needs from this call: Route a support ticket to the queue that handles it\. Its input is a customer's support ticket, often angry\./);
  assert.match(asked, /Checks:\nC1\. Names the queue the ticket belongs to\.\nG1\. Never: promises a refund or compensation/);

  // A label: the right label passes the label grader, and the judge then checks the guardrails only.
  seen.length = 0;
  const label = createMeasure({ bundle: spec, cases: guarded, client: client(), grader: graderFor(spec, options), ledger: memoryLedger(), key: "job-2" });
  const labelled = await label({ model: "promiser", endpoint: "acme" }, ["g1", "c1"]);
  assert.deepEqual(labelled.results.map(item => item.pass), [false, true], "the right label, but a broken guardrail");
  const guardrailsOnly = lastUser(seen.find(item => item.body.model === "checker")!.body);
  assert.match(guardrailsOnly, /Checks:\nG1\. Never: promises a refund or compensation\n\nInput:/);
  assert.ok(!guardrailsOnly.includes("Reference answer") && !guardrailsOnly.includes("C1."), "the label grader already decided the rest");
  // A wrong label is failed by the label grader alone, with its reason, and the judge is not asked.
  seen.length = 0;
  const wrong = await createMeasure({ bundle: spec, cases, client: client(), grader: graderFor(spec, options), ledger: memoryLedger(), key: "job-3" })({ model: "hedger", endpoint: "acme" }, ["c1"]);
  assert.deepEqual(wrong.results, [{ caseId: "c1", pass: false, reason: "Named no single label (answered \"billing or technical\"), expected billing." }]);
  assert.equal(seen.filter(item => item.body.model === "checker").length, 0);
});
