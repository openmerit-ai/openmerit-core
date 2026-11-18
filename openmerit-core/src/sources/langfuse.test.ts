import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createLangfuseSource, replayRequest, type TraceTask } from "./index.ts";

const SYSTEM = "Classify the support ticket as billing, bug or other.";
const lookup = (id: string) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "lookup_order", arguments: { order: id } } }] });

/** Generations of "support › classify" on gpt-5-mini, newest first, as Langfuse's v2 API returns them: input and output as raw strings. */
function classifyGenerations() {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 9, minute)).toISOString();
  const first = (minute: number, ticket: string, label: string, extra: object = {}) => ({
    id: `g${minute}`, traceId: `t${minute}`, startTime: at(minute), endTime: new Date(Date.parse(at(minute)) + 800).toISOString(), level: "DEFAULT", totalCost: 0.002,
    input: JSON.stringify([{ role: "system", content: SYSTEM }, { role: "user", content: ticket }]), output: JSON.stringify({ role: "assistant", content: label }), ...extra,
  });
  return [
    first(1, "Charged twice", "billing"),
    first(2, "App crashes on login", "bug"),
    first(3, "Charged twice", "billing"), // the same request as g1, recorded later
    first(4, "Where is my invoice?", "billing"),
    first(5, "Dark mode please", "other"),
    first(6, "Refund?", "billing"),
    first(7, "Export is broken", "bug"),
    first(8, "Timeout", "", { level: "ERROR" }),
    first(9, "Nothing came back", "", { output: "" }),
    { id: "g10", traceId: "t10", startTime: at(10), level: "DEFAULT", input: JSON.stringify({ unexpected: true }), output: "billing" },
    { id: "g11", traceId: "t11", startTime: at(11), level: "DEFAULT", input: JSON.stringify([{ role: "system", content: SYSTEM }, { role: "user", content: "Order 7 is late" }, lookup("c1"), { role: "tool", tool_call_id: "c1", content: '{"status":"shipped"}' }]), output: "other" },
    { id: "g12", traceId: "t12", startTime: at(12), level: "DEFAULT", input: JSON.stringify([{ role: "system", content: SYSTEM }, { role: "user", content: "Order 9 is late" }, lookup("c2"), { role: "tool", tool_call_id: "c2", content: '{"status":"lost"}' }]), output: "bug" },
    { id: "g13", traceId: "t13", startTime: at(13), level: "DEFAULT", input: JSON.stringify([{ role: "system", content: SYSTEM }, { role: "user", content: "Order 3 is late, my key is sk-live-abcdefghijklmnop" }]), output: JSON.stringify(lookup("c3")) },
  ].reverse();
}

async function fakeLangfuse(generations: Record<string, object[]>) {
  const requests: { method: string; path: string; query: URLSearchParams }[] = [];
  const rows = [
    { traceName: "support", name: "classify", promptName: null, providedModelName: "gpt-5", count_count: 20, sum_totalCost: 1.8, p50_latency: 1500 },
    { traceName: null, name: "embed", promptName: null, providedModelName: null, count_count: 30, sum_totalCost: 0 },
    { traceName: "support", name: "reply-retry", promptName: "reply", providedModelName: "claude-x", count_count: 50, sum_totalCost: 2, p50_latency: 3500 },
    { traceName: "support", name: "classify", promptName: null, providedModelName: "gpt-5-mini", count_count: 900, sum_totalCost: 1.8, p50_latency: 800 },
    { traceName: "support", name: "reply", promptName: "reply", providedModelName: "claude-x", count_count: 100, sum_totalCost: 4, p50_latency: 3000 },
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams });
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/public/v2/metrics") return send({ data: rows });
    if (url.pathname === "/api/public/v2/observations") {
      const filter = JSON.parse(url.searchParams.get("filter") ?? "[]") as { column: string; value: unknown }[];
      const key = ["traceName", "promptName", "name", "model"].map(column => { const condition = filter.find(item => item.column === column); return condition ? `${column}=${condition.value === "" ? "null" : String(condition.value)}` : ""; }).filter(Boolean).join(" ");
      const list = generations[key] ?? [];
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      return send({ data: list.slice(offset, offset + 4), meta: offset + 4 < list.length ? { cursor: String(offset + 4) } : {} });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("tasks group generations by trace name, prompt or generation name, and model, ranked by recorded cost then volume", async () => {
  const lf = await fakeLangfuse({});
  try {
    const source = createLangfuseSource({ baseUrl: lf.baseUrl, publicKey: "pk-lf-viewer", secretKey: "sk-lf-viewer" }, { days: 10, environments: ["production"] });
    const scan = await source.tasks();
    assert.deepEqual(scan.tasks.map(task => [task.id, task.generations, task.costUsd]), [
      ["support › prompt reply @ claude-x", 150, 6],
      ["support › classify @ gpt-5-mini", 900, 1.8],
      ["support › classify @ gpt-5", 20, 1.8],
    ]);
    const reply = scan.tasks[0]!;
    assert.deepEqual(reply.generationNames, ["reply-retry", "reply"]);
    assert.equal(reply.p50LatencyMs, 3000, "the busiest generation name's median");
    assert.deepEqual(reply.usage, { callsPerMonth: 450, usdPerMonth: 18 });
    assert.equal(reply.costShare, 6 / 9.6);
    assert.deepEqual(scan.totals, { generations: 1100, costUsd: 9.6 });
    assert.equal(scan.withoutModel, 30);
    const query = JSON.parse(lf.requests[0]!.query.get("query")!) as { filters: unknown[] };
    assert.deepEqual(query.filters[1], { column: "environment", operator: "any of", value: ["production"], type: "stringOptions" });
    assert.ok(lf.requests.every(request => request.method === "GET"));
  } finally {
    await lf.close();
  }
});

test("replay samples unique generations across turn depth and output kind, spread over time, into trace cases and a bundle", async () => {
  const lf = await fakeLangfuse({ "traceName=support promptName=null name=classify model=gpt-5-mini": classifyGenerations() });
  try {
    const source = createLangfuseSource({ baseUrl: lf.baseUrl, publicKey: "pk-lf-viewer", secretKey: "sk-lf-viewer" });
    const task = (await source.tasks()).tasks.find(item => item.id === "support › classify @ gpt-5-mini") as TraceTask;
    const set = await source.replay(task, { count: 5 });

    assert.deepEqual(set.pool, { read: 13, usable: 10, unique: 9 });
    assert.deepEqual(set.skipped, { "the call failed": 1, "no output": 1, "input is not a chat request": 1, "duplicate request": 1 });
    // Strata: 6 first-turn text answers (g1 is a duplicate of g3), 2 answers after a tool call, 1 tool call.
    // With 5 cases each stratum gets an equal share, at most all it has, and the first turn's 2 are spread over its 6.
    assert.deepEqual(set.samples.map(sample => [sample.observationId, sample.stratum]), [
      ["g3", "turn 1 · text"], ["g6", "turn 1 · text"], ["g11", "turns 2–3 · text"], ["g12", "turns 2–3 · text"], ["g13", "turn 1 · tool call"],
    ]);
    assert.equal(set.samples[0]!.latencyMs, 800);

    const [, , afterTool, , toolCall] = set.cases;
    assert.equal(afterTool!.origin, "trace");
    assert.deepEqual(replayRequest(afterTool!), [
      { role: "system", content: SYSTEM }, { role: "user", content: "Order 7 is late" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup_order", arguments: '{"order":"c1"}' } }] },
      { role: "tool", content: '{"status":"shipped"}', tool_call_id: "c1" },
    ]);
    assert.deepEqual(afterTool!.expected, { role: "assistant", content: "other" });
    assert.equal((toolCall!.expected as { tool_calls: { function: { name: string } }[] }).tool_calls[0]!.function.name, "lookup_order");
    assert.match(toolCall!.input.messages!, /my key is \[redacted\]/);
    assert.doesNotMatch(JSON.stringify(set), /sk-live/);

    assert.deepEqual(set.bundle.current, { model: "gpt-5-mini" });
    assert.deepEqual(set.bundle.prompt, { system: SYSTEM, messages: [] });
    assert.deepEqual(set.bundle.tools, [{ name: "lookup_order", parameters: {} }]);
    assert.equal(set.toolDefinitions, "inferred");
    assert.deepEqual(set.bundle.output, { kind: "text" });

    assert.deepEqual((await source.replay(task, { count: 5 })).cases.map(item => item.id), set.cases.map(item => item.id), "the same pool gives the same sample");
    assert.ok(lf.requests.some(request => request.query.get("cursor") === "4"), "pages are followed");
    assert.ok(lf.requests.every(request => request.method === "GET"));
  } finally {
    await lf.close();
  }
});

test("a task linked to a prompt replays every generation name using it, with the tool definitions the trace recorded", async () => {
  const tools = [{ type: "function", function: { name: "send_reply", description: "Send the reply.", parameters: { type: "object", properties: { text: { type: "string" } } } } }];
  const generation = (n: number) => ({
    id: `r${n}`, traceId: `rt${n}`, startTime: new Date(Date.UTC(2026, 10, 11, 9, n)).toISOString(), promptVersion: 2, level: "DEFAULT",
    input: JSON.stringify({ messages: [{ role: "user", content: `Ticket ${n}` }], tools }), output: JSON.stringify({ reply: `Answer ${n}`, tone: "warm" }),
  });
  const lf = await fakeLangfuse({ "traceName=support promptName=reply model=claude-x": [generation(1), generation(2)] });
  try {
    const source = createLangfuseSource({ baseUrl: lf.baseUrl, publicKey: "pk-lf-viewer", secretKey: "sk-lf-viewer" });
    const set = await source.replay((await source.tasks()).tasks[0]!);
    assert.deepEqual(set.samples.map(sample => sample.stratum), ["v2 · turn 1 · text", "v2 · turn 1 · text"]);
    assert.deepEqual(set.cases[0]!.expected, { role: "assistant", content: '{"reply":"Answer 1","tone":"warm"}' });
    assert.deepEqual(set.bundle.tools, [{ name: "send_reply", description: "Send the reply.", parameters: tools[0]!.function.parameters }]);
    assert.equal(set.toolDefinitions, "recorded");
    assert.deepEqual(set.bundle.output, { kind: "json", schema: { type: "object" } });
  } finally {
    await lf.close();
  }
});
