import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createEval, starterCases, Scorer, score } from "../../core/src/index.ts";
import {
  compile,
  PlatformAdapter,
  checkUrl,
  destinationReadiness,
  scorerCompatibility,
} from "../src/index.ts";
import { runtimeSource } from "../src/runtime-source.ts";
function fixture() {
  const s = createEval();
  s.task.questions = [];
  s.scorers = [s.scorers[0]];
  s.requirements = [s.requirements[0]];
  s.cases = starterCases(s);
  return s;
}
test("runtime source has not drifted from the export", () =>
  assert.equal(runtimeSource, readFileSync("runner/openmerit_runner/runtime.py", "utf8")));
test("every destination compiles standalone Python with pinned dependencies", () => {
  const spec = fixture();
  for (const d of ["local", "langfuse", "braintrust", "langsmith"] as const) {
    const bundle = compile(spec, d);
    assert.equal(bundle.report.valid, true);
    assert(!bundle.files["run.py"].includes("api.openmerit"));
    assert.equal(bundle.contentHash, compile(spec, d).contentHash);
    const dir = mkdtempSync(join(tmpdir(), "om-compile-"));
    for (const [name, value] of Object.entries(bundle.files)) writeFileSync(join(dir, name), value);
    execFileSync("python3", [
      "-m",
      "py_compile",
      join(dir, "run.py"),
      join(dir, "openmerit_runtime.py"),
    ]);
  }
});
test("unsupported scopes and local media block compilation readiness", () => {
  const spec = fixture();
  spec.scorers[0].scope = "session";
  assert.equal(compile(spec, "langsmith").report.valid, false);
  spec.scorers[0].scope = "output";
  spec.cases[0].attachments = [{ path: "/tmp/x.png", mimeType: "image/png" }];
  assert.equal(compile(spec, "braintrust").report.valid, false);
});
test("portable Python and TypeScript scorers agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-parity-"));
  writeFileSync(join(dir, "openmerit_runtime.py"), runtimeSource);
  const cases = [
    ["exact", { x: 1 }, { x: 1 }, {}],
    ["normalized", " YES ", "yes", {}],
    ["contains", "hello there", null, { value: "there" }],
    ["numeric", 1.05, 1, { tolerance: 0.1 }],
    ["set", ["b", "a", "a"], ["a", "b"], {}],
  ] as const;
  for (const [kind, output, expected, config] of cases) {
    const s = Scorer.parse({ id: "s", name: "test", kind, requirementIds: ["r"], config });
    const py = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `import json,sys;sys.path.insert(0,${JSON.stringify(dir)});from openmerit_runtime import score; a=json.loads(sys.argv[1]);print(json.dumps(score(a[0],a[1],a[2])))`,
          JSON.stringify([s, output, expected]),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(py.value, score(s, output, expected).value);
  }
});
test("server rejects private and redirected credential destinations", () => {
  assert.throws(() => checkUrl("http://127.0.0.1:1234"));
  assert.throws(() => checkUrl("https://cloud.langfuse.com@evil.test"));
  assert.equal(checkUrl("https://cloud.langfuse.com"), "https://cloud.langfuse.com");
});
test("resuming deployment avoids duplicates and detects remote edits", async () => {
  const spec = fixture();
  let dataset: any = null;
  const items: any[] = [];
  let posts = 0;
  const mock = (async (input: any, init: any) => {
    const url = String(input),
      method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    if (method === "POST") {
      posts++;
      if (url.endsWith("/datasets")) {
        dataset = { id: "ds", ...body };
        return Response.json(dataset);
      }
      if (url.endsWith("/dataset-items")) {
        items.push(body);
        return Response.json(body);
      }
    }
    if (url.includes("/dataset-items?")) return Response.json({ data: items });
    if (url.includes("/datasets/"))
      return dataset ? Response.json(dataset) : new Response("", { status: 404 });
    throw Error("Unexpected URL " + url);
  }) as typeof fetch;
  const adapter = new PlatformAdapter(
    {
      id: "c",
      destination: "langfuse",
      baseUrl: "https://cloud.langfuse.com",
      apiKey: "secret",
      publicKey: "public",
      projectId: "p",
      name: "test",
    },
    mock,
  );
  const done = await adapter.deploy(spec, adapter.planDeployment(spec));
  assert.equal(done.status, "sdk-required");
  assert.equal(posts, 2);
  await adapter.deploy(spec, done);
  assert.equal(posts, 2);
  items[0].input = "remote edit";
  await assert.rejects(() => adapter.deploy(spec, done), /drift/);
});
test("destination awareness distinguishes wrappers, local harnesses, and blockers", () => {
  const spec = fixture();
  assert.equal(scorerCompatibility(spec.scorers[0], "local").mode, "native");
  assert.equal(scorerCompatibility(spec.scorers[0], "langfuse").mode, "sdk-wrapper");
  spec.scorers[0].scope = "trace";
  assert.equal(scorerCompatibility(spec.scorers[0], "local").mode, "local-harness");
  assert.equal(scorerCompatibility(spec.scorers[0], "braintrust").mode, "blocked");
  const readiness = destinationReadiness(spec, "braintrust");
  assert.equal(readiness.valid, false);
  assert.match(readiness.blockers[0].message, /trace scope/);
});
test("Braintrust and LangSmith deployments conform to resumable dataset publishing", async () => {
  for (const destination of ["braintrust", "langsmith"] as const) {
    const spec = fixture();
    let dataset: any;
    const items: any[] = [];
    let posts = 0;
    const mock = (async (input: any, init: any) => {
      const url = String(input),
        method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(init.body) : undefined;
      if (method === "POST") {
        posts++;
        if (url.endsWith(destination === "braintrust" ? "/v1/dataset" : "/datasets")) {
          dataset = { id: "ds", ...body };
          return Response.json(dataset);
        }
        if (destination === "braintrust") {
          items.push(...body.events);
          return Response.json({});
        }
        items.push(body);
        return Response.json(body);
      }
      if (url.includes(destination === "braintrust" ? "/v1/dataset?" : "/datasets?"))
        return Response.json({ objects: [] });
      if (url.includes(destination === "braintrust" ? "/fetch" : "/examples?"))
        return Response.json(destination === "braintrust" ? { events: items } : { objects: items });
      if (url.endsWith(destination === "braintrust" ? "/v1/dataset/ds" : "/datasets/ds"))
        return Response.json(dataset);
      throw Error("Unexpected URL " + url);
    }) as typeof fetch;
    const adapter = new PlatformAdapter(
      {
        id: "c-" + destination,
        destination,
        baseUrl:
          destination === "braintrust"
            ? "https://api.braintrust.dev"
            : "https://api.smith.langchain.com",
        apiKey: "secret",
        projectId: "p",
        name: "test",
      },
      mock,
    );
    const done = await adapter.deploy(spec, adapter.planDeployment(spec));
    assert.equal(done.status, "sdk-required");
    assert.equal(done.completed.length, spec.cases.length);
    const firstPosts = posts;
    await adapter.deploy(spec, done);
    assert.equal(posts, firstPosts);
  }
});
