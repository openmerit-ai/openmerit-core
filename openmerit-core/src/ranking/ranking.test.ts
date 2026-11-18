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
  labelMatch, LABEL_CHECK_QUESTION, MAX_TOOL_ROUNDS, MemoryLedger, writeCases, type Case, type EndpointConfig, type Ledger, type TaskBundle,
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
    case "json": return { text: "```json\n{\"queue\": \"billing\", \"urgent\": true, \"note\": \"anything\"}\n```", cost: 0.001 };
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

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = req.url ?? "";
      seen.push({ path, headers: req.headers, body });
      const model = String(body.model);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      const limited = rateLimits.get(model) ?? 0;
      if (limited > 0) { rateLimits.set(model, limited - 1); return json(429, { error: { message: "slow down" } }, { "retry-after": "0" }); }
      if (model === costlyFailure) { costlyFailure = ""; return json(500, { error: { message: "overloaded" }, usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.5 } }, { "retry-after": "0" }); }
      if (model === "missing") return json(404, { error: { message: `The model ${model} does not exist` } });
      const anthropic = path.endsWith("/messages");
      const answer = script(model, body, anthropic);
      if (anthropic) {
        if (req.headers["x-api-key"] !== "sk-ant-fake" || req.headers["anthropic-version"] !== "2023-06-01") return json(401, { error: { message: "bad key" } });
        const content = answer.tool ? [{ type: "tool_use", id: `toolu_${seen.length}`, name: answer.tool.name, input: answer.tool.args }] : [{ type: "text", text: answer.text }];
        return json(200, { content, stop_reason: answer.tool ? "tool_use" : "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } });
      }
      if (req.headers.authorization !== "Bearer sk-fake") return json(401, { error: { message: "bad key" } });
      const message = answer.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${seen.length}`, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }
        : { role: "assistant", content: answer.text };
      // OpenRouter reports what the call cost; OpenAI-style endpoints report only tokens.
      const usage = { prompt_tokens: 1000, completion_tokens: 100, ...(path.startsWith("/openrouter") ? { cost: answer.cost } : {}) };
      json(200, { choices: [{ message, finish_reason: answer.tool ? "tool_calls" : "stop" }], usage });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
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
    assert.deepEqual(looped.results, [{ caseId: "c1", pass: false, failure: "tool_loop" }]);
    assert.equal(seen.length, MAX_TOOL_ROUNDS + 1, `${endpoint}: calls stop`);
    assert.equal(ledger.keys.size, 2 + MAX_TOOL_ROUNDS + 1, `${endpoint}: each call has its own ledger key`);
  }
});

test("Anthropic gets its own request shape and the cost is estimated from its tokens", async () => {
  const ledger = memoryLedger();
  const measure = createMeasure({ bundle, cases: cases.slice(0, 1), client: client(), grader: labelMatch(), ledger, key: "job-1" });
  const result = await measure({ model: "good", endpoint: "anthropic" }, ["c1"]);
  assert.equal(result.results[0]!.pass, true);
  near(result.costUsd, 0.002);
  assert.equal(seen[0]!.path, "/anthropic/v1/messages");
  assert.equal(seen[0]!.body.system, bundle.prompt.system);
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
    assert.deepEqual(wrong.results, [{ caseId: "t-tool-call", pass: false }], `${endpoint}: other arguments fail`);
    assert.equal(seen.length, 1);
  }
  const anthropicRequest = (await (async () => { seen.length = 0; await measure({ model: "good", endpoint: "anthropic" }, ["t-text"]); return seen[0]!.body; })());
  assert.equal(anthropicRequest.system, "Route tickets.");

  seen.length = 0;
  const textInsteadOfTool = await measure({ model: "good", endpoint: "openrouter" }, ["t-tool-call"]);
  assert.equal(textInsteadOfTool.results[0]!.pass, false, "text where the recorded answer called a tool");
});
