import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

test("scenario scores require every labelled coding finding and reject false positives", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sahra-scores-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let record: object;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "GET" ? [record] : {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const cases = [
    { name: "complete", findings: [{ activityId: "A4", kind: "unbundling" }, { activityId: "A3", kind: "unbundling" }], expected: true },
    { name: "non-coding integrity warning is outside the coding metric", findings: [{ activityId: "A3", kind: "unbundling" }, { activityId: "A4", kind: "unbundling" }, { kind: "other" }], expected: true },
    { name: "coding stays scored after a downstream failure", pipelineError: true, findings: [{ activityId: "A3", kind: "unbundling" }, { activityId: "A4", kind: "unbundling" }], expected: true },
    { name: "missing second component", findings: [{ activityId: "A3", kind: "unbundling" }], expected: false },
    { name: "wrong activity", findings: [{ activityId: "A2", kind: "unbundling" }, { activityId: "A3", kind: "unbundling" }], expected: false },
    { name: "extra finding", findings: [{ activityId: "A3", kind: "unbundling" }, { activityId: "A4", kind: "unbundling" }, { activityId: "A1", kind: "upcoding" }], expected: false },
    { name: "clean control", control: true, findings: [], expected: true },
    { name: "false positive on control", control: true, findings: [{ activityId: "A3", kind: "unbundling" }], expected: false },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    record = {
      id: scenario.control ? "FICT-CLM-1016" : "FICT-CLM-1015", state: scenario.pipelineError ? "error" : "awaiting_approval", extraction: {},
      coding: { findings: [
        ...scenario.findings.map(item => ({ ...item, code: "fixture", severity: "warn", message: "fixture" })),
        { kind: "other", severity: "info", code: "fixture", message: "Informational findings are not errors" },
      ] },
      adjudication: {
        lines: scenario.control ? [{ activityId: "A1" }, { activityId: "A2" }, { activityId: "A3" }]
          : [{ activityId: "A1" }, { activityId: "A2" }, { activityId: "A3", denialCode: "SH-CODE-03" }, { activityId: "A4", denialCode: "SH-CODE-03" }],
        totals: { payment: scenario.control ? 288_00 : 224_00 },
      },
      fraud: { recommendation: "pay" },
    };
    const output = join(directory, "results.json");
    await exec(process.execPath, [fileURLToPath(new URL("../scripts/run-scenarios.ts", import.meta.url)),
      "--only", scenario.control ? "independent-labs-control" : "nested-metabolic-unbundling", "--out", output], {
      env: { ...process.env, PLAYGROUND_URL: `http://127.0.0.1:${address.port}`, PLAYGROUND_TOKEN: "fixture-token", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" },
      timeout: 10_000,
    });
    const result = JSON.parse(await readFile(output, "utf8")) as { results: { check: string; pass: boolean }[] };
    assert.equal(result.results.find(item => item.check === "coding-findings-match")?.pass, scenario.expected);
  });
});

test("scenario publishes measured numeric cost and known latency for aggregate import", async t => {
  let generationCost = 0;
  let latency: number | null = null;
  const scores: { name: string; value: number; dataType: string; traceId: string }[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/public/")) {
      assert.equal(request.headers.authorization, `Basic ${btoa("fixture-public:fixture-secret")}`);
      if (request.url.startsWith("/api/public/v2/observations")) {
        response.end(JSON.stringify({ data: [
          { type: "AGENT", endTime: "2026-11-06T00:00:00Z", metadata: { generations: 1 }, latency },
          { type: "GENERATION", totalCost: generationCost },
        ] }));
      } else {
        if (request.url === "/api/public/scores") {
          let body = "";
          for await (const chunk of request) body += chunk;
          scores.push(...JSON.parse(body) as typeof scores);
        }
        response.end(JSON.stringify({ id: "fixture-dataset" }));
      }
      return;
    }
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.end(JSON.stringify(request.method === "GET" ? [{
      id: "FICT-CLM-1018", state: "awaiting_approval", extraction: {}, coding: { findings: [] },
      adjudication: { lines: [{ activityId: "A1" }], totals: { payment: 128_00 } }, fraud: { recommendation: "pay" },
    }] : {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  for (const scenario of [{ cost: 0, latency: null }, { cost: 0.0123, latency: 2.7 }]) await t.test(`cost ${scenario.cost}, latency ${scenario.latency}`, async () => {
    generationCost = scenario.cost;
    latency = scenario.latency;
    scores.length = 0;
    const env = {
      ...process.env, PLAYGROUND_URL: `http://127.0.0.1:${address.port}`, PLAYGROUND_TOKEN: "fixture-token",
      LANGFUSE_PUBLIC_KEY: "fixture-public", LANGFUSE_SECRET_KEY: "fixture-secret",
    };
    Object.assign(env, { LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}` });
    await exec(process.execPath, [fileURLToPath(new URL("../scripts/run-scenarios.ts", import.meta.url)), "--only", "valid-code-prefix-control"], {
      env,
      timeout: 10_000,
    });
    const costs = scores.filter(score => score.name === "usd-per-agent-run");
    assert.equal(costs.length, 4);
    assert.equal(new Set(costs.map(score => score.traceId)).size, 4);
    assert(costs.every(score => score.dataType === "NUMERIC" && score.value === scenario.cost));
    const times = scores.filter(score => score.name === "seconds-per-agent-run");
    assert.equal(times.length, scenario.latency === null ? 0 : 4);
    assert(times.every(score => score.dataType === "NUMERIC" && score.value === scenario.latency));
  });
});
