// MOCKED: every test here replaces fetch with a local router. None of them reach Langfuse.
// live.test.ts holds the checks against a real Langfuse project.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionFromEnv, createLangfuseConnector, evaluatePass, LangfuseError, recordedTraceId } from "./index.ts";

const connection = { baseUrl: "https://langfuse.example.test/lf/", publicKey: "pk-lf-test-public", secretKey: "sk-lf-test-SECRET-value" };

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}
type Route = (call: Call) => Response | undefined;

function mockFetch(...routes: Route[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return new Response(JSON.stringify({ message: `unmocked ${call.method} ${url.pathname}` }), { status: 500 });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const on = (method: string, path: string, respond: (call: Call) => Response): Route => (call) => (call.method === method && call.url.pathname === `/lf${path}` ? respond(call) : undefined);
const noSleep = { sleep: async () => {} };

describe("connectionFromEnv", () => {
  it("names the missing variables without echoing any value", () => {
    assert.throws(() => connectionFromEnv({ LANGFUSE_SECRET_KEY: "sk-lf-should-not-leak" }), (error: Error) => error.message.includes("LANGFUSE_PUBLIC_KEY") && !error.message.includes("LANGFUSE_SECRET_KEY and") && !error.message.includes("should-not-leak"));
  });
  it("accepts LANGFUSE_HOST, keeps a self-hosted path prefix and drops the trailing slash", () => {
    assert.equal(connectionFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "http://langfuse.internal:3000/langfuse/" }).baseUrl, "http://langfuse.internal:3000/langfuse");
    assert.equal(connectionFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }).baseUrl, "https://cloud.langfuse.com");
  });
  it("prefers LANGFUSE_BASE_URL and rejects a URL carrying credentials", () => {
    assert.equal(connectionFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com", LANGFUSE_HOST: "https://other" }).baseUrl, "https://us.cloud.langfuse.com");
    assert.throws(() => connectionFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://user:pass@lf.test" }), LangfuseError);
  });
});

describe("transport", () => {
  it("waits out Retry-After on 429 and sends Basic auth to the prefixed base URL", async () => {
    let hits = 0;
    const waits: number[] = [];
    const { fetch, calls } = mockFetch(on("GET", "/api/public/projects", () => (++hits === 1 ? json({ message: "Rate limit exceeded" }, 429, { "retry-after": "49" }) : json({ data: [{ id: "p1", name: "eval-runner" }] }))));
    const connector = createLangfuseConnector(connection, { fetch, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(await connector.check(), { baseUrl: "https://langfuse.example.test/lf", projectId: "p1", projectName: "eval-runner" });
    assert.deepEqual(waits, [49_000]);
    assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from("pk-lf-test-public:sk-lf-test-SECRET-value").toString("base64")}`);
  });
  it("refuses redirects and keeps secrets out of 401 errors", async () => {
    const redirect = createLangfuseConnector(connection, { fetch: mockFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.test" } })).fetch, ...noSleep });
    await assert.rejects(redirect.check(), /redirected \(HTTP 302\)/);
    const denied = createLangfuseConnector(connection, { fetch: mockFetch(() => json({ message: "Invalid credentials" }, 401)).fetch, ...noSleep });
    await assert.rejects(denied.check(), (error: LangfuseError) => error.status === 401 && /Invalid credentials/.test(error.message) && !error.message.includes("SECRET-value") && !error.message.includes("pk-lf-test"));
  });
});

describe("evaluatePass", () => {
  it("treats a missing score as a fail and honours inclusive bounds", () => {
    assert.equal(evaluatePass({ score: "s" }, undefined), false);
    assert.equal(evaluatePass({ score: "s" }, true), true);
    assert.equal(evaluatePass({ score: "s" }, 0.99), false);
    assert.equal(evaluatePass({ score: "s", equals: false }, false), true);
    assert.equal(evaluatePass({ score: "s", equals: true }, 1), true);
    assert.equal(evaluatePass({ score: "s", min: 0.8 }, 0.8), true);
    assert.equal(evaluatePass({ score: "s", max: 30 }, 30.5), false);
    assert.equal(evaluatePass({ score: "s", min: 0 }, "0"), false);
  });
});

const item = (itemId: string, traceId: string, startTime: string, scores: { name: string; value: unknown; dataType: string; timestamp?: string }[], experimentId = "run-1--enrollments") => ({
  id: `obs-${traceId}`, traceId, startTime, experimentId, experimentName: "haiku-run-1", experimentItemId: itemId, experimentDatasetId: "ds-1",
  scores: scores.map((score) => ({ timestamp: "2026-11-06T13:00:00Z", ...score, subject: { kind: "observation", id: `obs-${traceId}`, traceId } })),
});

describe("experimentResults", () => {
  it("counts each item's latest run, normalises BOOLEAN values and fills trace-level pass scores", async () => {
    const { fetch, calls } = mockFetch(
      on("GET", "/api/public/experiment-items", (call) =>
        call.url.searchParams.get("cursor") === "c2"
          ? json({ data: [item("APP-2003", "t3", "2026-11-06T13:01:00Z", [])], meta: {} })
          : json({
              data: [
                // APP-2001 was retried: the older run passed and the newer one failed, so it fails.
                item("APP-2001", "t1-old", "2026-11-06T13:00:00Z", [{ name: "enrollment-correct", value: true, dataType: "BOOLEAN" }]),
                item("APP-2001", "t1-new", "2026-11-06T13:05:00Z", [{ name: "enrollment-correct", value: 0, dataType: "BOOLEAN" }]),
                item("APP-2002", "t2", "2026-11-06T13:01:00Z", [{ name: "enrollment-correct", value: 1, dataType: "BOOLEAN" }, { name: "model-calls", value: 4, dataType: "NUMERIC" }]),
              ],
              meta: { cursor: "c2" },
            }),
      ),
      // APP-2003's score was posted on the trace, which experiment items omit.
      on("GET", "/api/public/v3/scores", () => json({ data: [{ name: "enrollment-correct", dataType: "BOOLEAN", value: true, timestamp: "2026-11-06T13:02:00Z", subject: { kind: "trace", id: "t3" } }], meta: {} })),
    );
    const result = await createLangfuseConnector(connection, { fetch, ...noSleep }).experimentResults({ experimentId: "run-1--enrollments", pass: { score: "enrollment-correct" }, itemIds: ["APP-2001", "APP-2002", "APP-2003", "APP-2004"], since: "2026-11-01" });
    assert.deepEqual(result.items.map((i) => [i.itemId, i.traceId, i.passed]), [["APP-2001", "t1-new", false], ["APP-2002", "t2", true], ["APP-2003", "t3", true]]);
    assert.equal(result.passes, 2);
    assert.equal(result.total, 3);
    assert.deepEqual(result.missing, ["APP-2004"]);
    assert.deepEqual(result.missingScores, []);
    assert.equal(result.items[1]!.scores["model-calls"], 4);
    const first = calls.find((call) => call.url.pathname.endsWith("/experiment-items"))!;
    assert.equal(first.url.searchParams.get("experimentId"), "run-1--enrollments");
    assert.equal(first.url.searchParams.get("fromStartTime"), "2026-11-01T00:00:00.000Z");
    assert.match(first.url.searchParams.get("fields") ?? "", /scores/);
    assert.equal(calls.find((call) => call.url.pathname.endsWith("/v3/scores"))!.url.searchParams.get("traceId"), "t3");
  });

  it("reports an unscored item as missingScore, not as a silent pass, and sums recorded cost", async () => {
    const { fetch, calls } = mockFetch(
      on("GET", "/api/public/experiment-items", () => json({ data: [item("A", "ta", "2026-11-06T13:00:00Z", [{ name: "claim-correct", value: true, dataType: "BOOLEAN" }]), item("B", "tb", "2026-11-06T13:00:00Z", [])], meta: {} })),
      on("GET", "/api/public/v3/scores", () => json({ data: [], meta: {} })),
      on("GET", "/api/public/v2/observations", () => json({ data: [{ traceId: "ta", totalCost: 0.0125 }, { traceId: "ta", totalCost: 0.0005 }, { traceId: "tb", totalCost: null }], meta: {} })),
    );
    const result = await createLangfuseConnector(connection, { fetch, ...noSleep }).experimentResults({ experimentId: "x", pass: { score: "claim-correct" }, includeCost: true });
    assert.deepEqual(result.missingScores, ["B"]);
    assert.equal(result.items[1]!.passed, false);
    assert.ok(Math.abs(result.items[0]!.costUsd! - 0.013) < 1e-12);
    assert.equal(result.items[1]!.costUsd, null);
    assert.ok(Math.abs(result.costUsd! - 0.013) < 1e-12);
    const filter = JSON.parse(calls.find((call) => call.url.pathname.endsWith("/v2/observations"))!.url.searchParams.get("filter")!);
    assert.deepEqual(filter[0].value, ["ta", "tb"]);
  });

  it("refuses an experiment name that matches two experiments", async () => {
    const { fetch } = mockFetch(on("GET", "/api/public/experiment-items", () => json({ data: [item("A", "t1", "2026-11-06T13:00:00Z", [], "run-1"), item("B", "t2", "2026-11-06T13:00:00Z", [], "run-1--enrollments")], meta: {} })));
    await assert.rejects(createLangfuseConnector(connection, { fetch, ...noSleep }).experimentResults({ experimentName: "haiku-run-1", pass: { score: "s" } }), /matches 2 experiments/);
  });

  it("fails on a repeated pagination cursor instead of looping", async () => {
    const { fetch } = mockFetch(on("GET", "/api/public/experiment-items", () => json({ data: [], meta: { cursor: "same" } })));
    await assert.rejects(createLangfuseConnector(connection, { fetch, ...noSleep }).experimentResults({ experimentId: "x", pass: { score: "s" } }), /repeated a pagination cursor/);
  });

  it("waitForExperiment polls until the expected items are scored", async () => {
    let polls = 0;
    const { fetch } = mockFetch(
      on("GET", "/api/public/experiment-items", () => json({ data: ++polls < 3 ? [] : [item("A", "ta", "2026-11-06T13:00:00Z", [{ name: "ok", value: 1, dataType: "BOOLEAN" }])], meta: {} })),
    );
    const result = await createLangfuseConnector(connection, { fetch, ...noSleep }).waitForExperiment({ experimentId: "x", pass: { score: "ok" } }, { expectItems: 1, intervalMs: 1, timeoutMs: 1000 });
    assert.equal(polls, 3);
    assert.equal(result.passes, 1);
  });
});

describe("listExperiments", () => {
  it("resolves the dataset by name and reports model_<role> metadata as models", async () => {
    const { fetch, calls } = mockFetch(
      on("GET", "/api/public/v2/datasets/sahra-enrollments", () => json({ id: "ds-1", name: "sahra-enrollments" })),
      on("GET", "/api/public/experiments", () => json({ data: [{ id: "run-1--enrollments", name: "haiku-run-1", datasetId: "ds-1", itemCount: 6, startTime: "2026-11-06T13:00:00Z", metadata: { openmerit_version: "0.3.9", model_enrollment: "openrouter/anthropic/claude-haiku-5.5" } }], meta: {} })),
    );
    const [experiment] = await createLangfuseConnector(connection, { fetch, ...noSleep }).listExperiments({ datasetName: "sahra-enrollments", since: "2026-11-01" });
    assert.deepEqual(experiment!.models, { enrollment: "openrouter/anthropic/claude-haiku-5.5" });
    assert.equal(calls[1]!.url.searchParams.get("datasetId"), "ds-1");
  });
});

describe("ensureDataset and getDatasetItems", () => {
  it("creates a missing dataset and upserts items under stable IDs", async () => {
    const { fetch, calls } = mockFetch(
      on("GET", "/api/public/v2/datasets/local-tasks", () => json({ message: "not found" }, 404)),
      on("POST", "/api/public/v2/datasets", () => json({ id: "ds-new", name: "local-tasks" })),
      on("POST", "/api/public/dataset-items", (call) => json({ id: (call.body as { id: string }).id })),
    );
    const connector = createLangfuseConnector(connection, { fetch, ...noSleep });
    const input = { name: "local-tasks", items: [{ input: { a: 1, b: 2 }, expectedOutput: "x" }, { id: "fixed-id", input: "q", expectedOutput: "y" }] };
    const first = await connector.ensureDataset(input);
    // Key order must not change a derived ID.
    const second = await connector.ensureDataset({ ...input, items: [{ input: { b: 2, a: 1 }, expectedOutput: "x" }, input.items[1]!] });
    assert.equal(first.datasetId, "ds-new");
    assert.match(first.itemIds[0]!, /^om-[0-9a-f]{16}$/);
    assert.deepEqual(second.itemIds, first.itemIds);
    assert.equal(first.itemIds[1], "fixed-id");
    const posted = calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/dataset-items")).map((call) => call.body as { datasetName: string; id: string });
    assert.deepEqual(posted.map((body) => body.id), [...first.itemIds, ...first.itemIds]);
    assert.ok(posted.every((body) => body.datasetName === "local-tasks"));
  });

  it("pages dataset items and skips archived ones", async () => {
    const { fetch } = mockFetch(on("GET", "/api/public/dataset-items", (call) => json(call.url.searchParams.get("page") === "1" ? { data: [{ id: "A", input: 1, expectedOutput: 2, status: "ACTIVE" }, { id: "Z", status: "ARCHIVED" }], meta: { totalPages: 2 } } : { data: [{ id: "B", input: 3, expectedOutput: 4, metadata: { fixture: "f" } }], meta: { totalPages: 2 } })));
    const items = await createLangfuseConnector(connection, { fetch, ...noSleep }).getDatasetItems("sahra-enrollments");
    assert.deepEqual(items, [{ id: "A", input: 1, expectedOutput: 2, metadata: {} }, { id: "B", input: 3, expectedOutput: 4, metadata: { fixture: "f" } }]);
  });
});

describe("recordExperimentItems", () => {
  const recording = {
    datasetId: "ds-1", experimentId: "scout-screen-abc", experimentName: "scout screen deepseek", metadata: { model_enrollment: "openrouter/deepseek/deepseek-v4-pro", stage: "screen" },
    items: [{ itemId: "APP-2005", model: "openrouter/deepseek/deepseek-v4-pro", input: { q: 1 }, output: { decision: "eligible" }, startMs: 1_000, endMs: 3_500, usage: { input: 10, output: 5, total: 15 }, costUsd: 0.002, metadata: { stage: "screen", eci: 142.5 }, scores: [{ name: "enrollment-correct", value: false }, { name: "usd", value: 0.002 }] }],
  };
  const routes = () => mockFetch(
    on("POST", "/api/public/otel/v1/traces", () => json({})),
    on("POST", "/api/public/scores", () => json({ successes: 2 }, 202)),
    on("GET", "/api/public/projects", () => json({ data: [{ id: "p1", name: "eval-runner" }] })),
  );

  it("links each trace to the experiment item and posts root-observation scores with stable IDs", async () => {
    const { fetch, calls } = routes();
    const result = await createLangfuseConnector(connection, { fetch, ...noSleep }).recordExperimentItems(recording);
    const traceId = recordedTraceId("scout-screen-abc", "APP-2005");
    assert.deepEqual(result.traceIds, { "APP-2005": traceId });
    assert.equal(result.url, "https://langfuse.example.test/lf/project/p1/datasets/ds-1/runs/scout-screen-abc");
    const otlp = calls.find((call) => call.url.pathname.endsWith("/otel/v1/traces"))!;
    assert.equal(otlp.headers["x-langfuse-ingestion-version"], "4");
    type Span = { traceId: string; spanId: string; parentSpanId?: string; startTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] };
    const spans = (otlp.body as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans[0]!.scopeSpans[0]!.spans;
    const attr = (s: Span, key: string) => s.attributes.find((a) => a.key === key)?.value;
    const [root, generation] = spans;
    assert.equal(root!.traceId, traceId);
    assert.equal(generation!.parentSpanId, root!.spanId);
    assert.equal(root!.startTimeUnixNano, "1000000000");
    assert.deepEqual(attr(root!, "langfuse.experiment.item.root_observation_id"), { stringValue: root!.spanId });
    assert.deepEqual(attr(root!, "langfuse.experiment.item.id"), { stringValue: "APP-2005" });
    assert.deepEqual(attr(root!, "langfuse.experiment.dataset.id"), { stringValue: "ds-1" });
    assert.deepEqual(attr(root!, "langfuse.experiment.metadata.model_enrollment"), { stringValue: "openrouter/deepseek/deepseek-v4-pro" });
    assert.deepEqual(attr(root!, "langfuse.trace.metadata.eci"), { stringValue: "142.5" });
    assert.deepEqual(attr(root!, "langfuse.trace.tags"), { arrayValue: { values: [{ stringValue: "openmerit" }, { stringValue: "experiment:scout-screen-abc" }] } });
    assert.deepEqual(attr(generation!, "langfuse.observation.cost_details"), { stringValue: '{"total":0.002}' });
    const scores = calls.find((call) => call.url.pathname.endsWith("/scores"))!.body as { id: string; traceId: string; observationId: string; value: number; dataType: string }[];
    assert.deepEqual(scores.map((s) => [s.value, s.dataType, s.traceId, s.observationId]), [[0, "BOOLEAN", traceId, root!.spanId], [0.002, "NUMERIC", traceId, root!.spanId]]);
    const again = routes();
    await createLangfuseConnector(connection, { fetch: again.fetch, ...noSleep }).recordExperimentItems(recording);
    assert.deepEqual((again.calls.find((call) => call.url.pathname.endsWith("/scores"))!.body as { id: string }[]).map((s) => s.id), scores.map((s) => s.id));
  });

  it("fails on a 207 partial score rejection and on a categorical score with a number", async () => {
    const { fetch } = mockFetch(on("POST", "/api/public/otel/v1/traces", () => json({})), on("POST", "/api/public/scores", () => json({ errors: [{ message: "bad" }] }, 207)));
    await assert.rejects(createLangfuseConnector(connection, { fetch, ...noSleep }).recordExperimentItems(recording), (error: LangfuseError) => error.status === 207);
    const bad = { ...recording, items: [{ ...recording.items[0]!, scores: [{ name: "label", value: 3, dataType: "CATEGORICAL" as const }] }] };
    await assert.rejects(createLangfuseConnector(connection, { fetch: routes().fetch, ...noSleep }).recordExperimentItems(bad), /CATEGORICAL/);
  });
});
