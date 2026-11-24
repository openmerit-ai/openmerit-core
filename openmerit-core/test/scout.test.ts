// Scout end to end against the support-app fixture, with a scripted harness and a local fake
// OpenAI endpoint: no real model calls. The fake endpoint answers correctly for some models and
// wrongly (or with HTTP 500) for others, so the right ranking is known in advance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadCatalogue } from "../src/catalogue/catalogue.ts";
import { renderRun } from "../src/cli/render.ts";
import { EvalProxy } from "../src/eval/proxy.ts";
import type { Harness, JsonRequest } from "../src/harness/harness.ts";
import { startRun } from "../src/local.ts";
import { specBundle, type SpecReply } from "../src/review/index.ts";
import { scanRepo } from "../src/scout/scan.ts";
import { advance, CONFIGURE_QUESTION, TASK_QUESTION, type Answer, type Context, type Question, type Step } from "../src/scout/workflow.ts";
import { readRepoConfig, updateGlobalConfig, updateRepoConfig } from "../src/state/config.ts";
import { State } from "../src/state/db.ts";
import { findRepo } from "../src/state/paths.ts";

const fixture = new URL("./fixtures/support-app/", import.meta.url).pathname;
const tickets = new Map(readFileSync(join(fixture, "data/tickets.jsonl"), "utf8").trim().split("\n").map(line => { const item = JSON.parse(line) as { ticket: string; queue: string }; return [item.ticket, item.queue]; }));
const ALLOWED = ["gpt-5-nano", "gpt-4.1-nano", "gpt-6-luna", "gpt-4o-mini", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-5-mini"];

// Fake OpenAI. Right answers by default; gpt-4o-mini always says "other"; gpt-4.1-nano does not exist
// (HTTP 404); gpt-5.6-luna answers its first five requests (one screen) and then fails with HTTP 500.
// A test can change which models answer wrongly, at length, or fail after five requests.
const requests: string[] = [];
/** The fake endpoint answers HTTP 429 to `model`'s next `remaining` requests. */
const rateLimit = { model: "", remaining: 0 };
/** The fake endpoint stops `model`'s answers at their token limit before any text, as a model that reasons first does. */
const cutOff = { model: "" };
/** Models the fake endpoint answers wrongly. */
const wrong = new Set(["gpt-4o-mini"]);
/** Models whose answers report 2,000 output tokens, so they cost more per item than their list price suggests. */
const verbose = new Set<string>();
/** Judge calls the fake endpoint answered. */
const judged = { count: 0 };
/** The model whose requests after its fifth fail with HTTP 500. */
const flaky = { model: "gpt-5.6-luna" };
let server: Server;
let baseUrl = "";
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; stream?: boolean; messages: { role: string; content: string }[] };
      // A streamed request (openmerit/ranking's Pi client, for a generated eval) gets server-sent events; the fixture's eval gets one JSON body.
      const reply = (content: string, usage: { prompt_tokens: number; completion_tokens: number }) => {
        if (!parsed.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage })); }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [{ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] }, { choices: [], usage }]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return res.end("data: [DONE]\n\n");
      };
      requests.push(parsed.model);
      // Retry-After 0 keeps the proxy's retries of a failing call fast.
      const fail = (status: number, message: string) => { res.writeHead(status, { "content-type": "application/json", "retry-after": "0" }); res.end(JSON.stringify({ error: { message } })); };
      if (req.headers.authorization !== "Bearer sk-fake-endpoint") return fail(401, "bad key");
      if (parsed.model === rateLimit.model && rateLimit.remaining-- > 0) { res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }); return res.end(JSON.stringify({ error: { message: "rate-limited upstream" } })); }
      if (parsed.model === cutOff.model) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }], usage: { prompt_tokens: 100, completion_tokens: 2000 } })); }
      if (parsed.model === "gpt-4.1-nano") return fail(404, "The model `gpt-4.1-nano` does not exist or you do not have access to it.");
      if (parsed.model === flaky.model && requests.filter(model => model === flaky.model).length > 5) return fail(500, "upstream overloaded");
      // A generated eval's judge: every check passes.
      if (parsed.messages[0]?.role === "system" && parsed.messages[0].content.startsWith("You grade one answer")) {
        judged.count++;
        return reply(JSON.stringify({ checks: [{ id: "G1", pass: true, reason: "fine" }], pass: true, reason: "" }), { prompt_tokens: 300, completion_tokens: 20 });
      }
      const ticket = parsed.messages.find(message => message.role === "user")!.content;
      const answer = wrong.has(parsed.model) ? "other" : tickets.get(ticket) ?? "other";
      reply(answer, { prompt_tokens: 100, completion_tokens: verbose.has(parsed.model) ? 2000 : 5 });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => { server.close(); });

/** The classifier's task spec, as the review prompt writes it for the fixture. */
const CLASSIFIER_SPEC = {
  description: "Routes a support ticket to one queue.", input: "a customer's support ticket",
  steps: [{ description: "Read the ticket and pick its queue", tools: [], access: "none" }],
  criteria: ["Picks the queue the ticket belongs in"], guardrails: [],
  system: "Classify the support ticket into exactly one queue: billing, technical, account, other. Reply with the queue name only, in lowercase.", user: "{{ticket}}",
  tools: [], output: { kind: "label", labels: ["billing", "technical", "account", "other"], schemaJson: "" }, examples: [], maxTurns: 0,
};

test("the review's spec keeps per-call lookups and step order as openmerit/ranking takes them", () => {
  const reply = {
    ...CLASSIFIER_SPEC, output: { kind: "text", labels: [], schemaJson: "" },
    steps: [
      { description: "Look up each code", tools: ["lookup"], access: "read", required: true, after: [] },
      { description: "Note the review", tools: ["note"], access: "write", required: false, after: [1] },
      { description: "Answer", tools: [], access: "none", required: true, after: [1, 3, 5] },
    ],
    tools: [{ name: "lookup", description: "", parametersJson: "{}", mockResultJson: "{}" }, { name: "note", description: "", parametersJson: "{}", mockResultJson: "\"ok\"" }],
    examples: [{ input: [{ name: "ticket", value: "A01, B02" }], expected: "done", toolResults: [
      { name: "lookup", whenJson: "{\"code\":\"A01\"}", resultJson: "{\"valid\":true}" },
      { name: "lookup", whenJson: "{\"code\":\"B02\"}", resultJson: "{\"valid\":false}" },
      { name: "note", whenJson: "", resultJson: "\"saved\"" },
      { name: "unknown", whenJson: "", resultJson: "1" },
    ] }],
  } as SpecReply;
  const bundle = specBundle(reply, { name: "coder" }, [], "openai/gpt-5-mini");
  assert.deepEqual(bundle.steps?.map(step => [step.required ?? false, step.after ?? []]), [[true, []], [false, [1]], [true, [1]]]);
  assert.deepEqual(bundle.examples?.[0]?.toolResults, {
    lookup: [{ when: { code: "A01" }, result: { valid: true } }, { when: { code: "B02" }, result: { valid: false } }],
    note: "saved",
  });
});

/**
 * Scripted OpenAI Harness: maps usages by file and finds the fixture's eval. The review writes
 * `spec` (by default the classifier's), and the case writer writes `cases` (by default none, so
 * the repository's eval measures alone).
 */
function scriptedHarness(discover: Record<string, unknown> = {}, generate: { spec?: object; cases?: { kind: string; ticket: string; queue: string }[] } = {}): Harness & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: "codex", label: "codex", calls, usage: { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 },
    async json<T>(request: JsonRequest): Promise<T> {
      this.usage.calls++;
      if (request.system.includes("reviewing an application's code")) {
        calls.push(`review:${/Task: ([^:]+):/.exec(request.prompt)?.[1]}`);
        return { ...CLASSIFIER_SPEC, ...generate.spec } as T;
      }
      if (request.system.includes("You write test cases")) {
        calls.push("write");
        return { cases: (generate.cases ?? []).map(item => ({ kind: item.kind, input: [{ name: "ticket", value: item.ticket }], expected: item.queue })) } as T;
      }
      if (request.system.includes("map model usages")) {
        calls.push("map");
        const byTask = new Map<string, string[]>();
        for (const [, id, file] of request.prompt.matchAll(/^### (u\d+) model[^\n]* at ([^:\n]+):\d+$/gm)) {
          const name = file!.includes("classify") ? "ticket classifier" : file!.includes("draft") ? "reply drafter" : "escalation router";
          byTask.set(name, [...byTask.get(name) ?? [], id!]);
        }
        return { tasks: [...byTask].map(([name, usageIds]) => ({ name, description: `the ${name}`, usageIds, usesTools: false, needsVision: false, structuredOutput: false })) } as T;
      }
      calls.push(`discover:${/Task: ([^:]+):/.exec(request.prompt)?.[1]}`);
      const env = [{ name: "CLASSIFIER_MODEL", value: "{{model}}" }];
      return { found: true, command: "node evals/classify.eval.ts", cwd: ".", env, threshold: null, helpers: [], explanation: "npm run eval:classify", missing: "", items: null, ...discover } as T;
    },
  };
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  cpSync(fixture, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  return root;
}

function context(root: string, home: string, harness = scriptedHarness(), extraEnv: Record<string, string> = {}): Context & { harnessCalls: string[] } {
  const env = { ...process.env, OPENMERIT_HOME: home, FAKE_ENDPOINT_KEY: "sk-fake-endpoint", ...extraEnv };
  updateGlobalConfig({ harness: { kind: "codex" } }, env);
  if (!readRepoConfig(root).endpoints) updateRepoConfig(root, { endpoints: [{ id: "openai", kind: "openai", baseUrl, apiKey: { env: "FAKE_ENDPOINT_KEY" }, allowedModels: ALLOWED }] });
  return { state: new State(env), repo: findRepo(root), catalogue: loadCatalogue(), env, harness: async () => harness, log: () => {}, harnessCalls: harness.calls };
}

const DEFAULTS: Record<string, Answer> = { model: "openai/gpt-4.1-mini", corrections: "", tasks: ["ticket classifier"], approve_evals: true, retry_units: false, configure_ticket_classifier: false };

/** Answers every question from `answers` (falling back to DEFAULTS) until the run stops asking or an answer is missing. */
async function drive(ctx: Context, runId: string, answers: Record<string, Answer> = {}) {
  const asked: Question[] = [];
  let step: Step = await advance(ctx, runId, {});
  for (let guard = 0; step.questions.length && guard < 30; guard++) {
    asked.push(...step.questions);
    const next: Record<string, Answer> = {};
    for (const question of step.questions) {
      const answer = answers[question.id] ?? DEFAULTS[question.id];
      if (answer === undefined) return { step, asked };
      next[question.id] = answer;
    }
    step = await advance(ctx, runId, next);
  }
  return { step, asked };
}

test("the task question lists each task once and takes a mapping correction", async () => {
  const root = repo(), ctx = context(root, mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  const draft = scanRepo(root, loadCatalogue()).usages.find(usage => usage.file === "src/draft-reply.ts" && usage.kind === "model")!;
  let step = await advance(ctx, runId, {});
  assert.deepEqual(step.questions[0]!.options!.map(option => option.value), ["openai/gpt-4.1-mini", "openai/gpt-5.4"], "only catalogue models are offered");
  step = await advance(ctx, runId, { model: "openai/gpt-4.1-mini" });
  assert.deepEqual(step.questions.map(question => question.id), ["tasks"], "no separate corrections question");
  step = await advance(ctx, runId, { tasks: [`${draft.id}=ticket classifier`] });
  const options = step.questions.find(question => question.id === "tasks")!.options!;
  assert.deepEqual(options.map(option => option.value), ["ticket classifier", "escalation router"], "the reply drafter's usage moved to the classifier");
  assert.match(options[0]!.detail!, new RegExp(`${draft.id} draft-reply.ts:3`));
  step = await advance(ctx, runId, { tasks: ["ticket classifier"] });
  assert.ok(!step.questions.some(question => question.id === "tasks"), "a task name answers the question");
});

test("usages in tests, fixtures and docs make no task: they are counted under their model, never offered, mapped or moved", async () => {
  const root = repo();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/classify.test.ts"), `const pinned = "gpt-4.1-mini";\nconst cheap = "gpt-5-nano";\n`);
  execFileSync("git", ["add", "-A"], { cwd: root });
  const ctx = context(root, mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  const inTests = scanRepo(root, loadCatalogue()).usages.filter(usage => usage.file === "tests/classify.test.ts");
  assert.equal(inTests.length, 2);
  let step = await advance(ctx, runId, {});
  const models = step.questions[0]!.options!;
  assert.match(models.find(option => option.value === "openai/gpt-4.1-mini")!.detail!, /\+1 in tests, fixtures or docs/);
  assert.equal(models.find(option => option.value === "openai/gpt-5-nano")!.detail, "only 1 in tests, fixtures or docs");
  // A model only tests name is offered only the tasks whose model is set at run time, which may be it.
  step = await advance(ctx, runId, { model: "openai/gpt-5-nano" });
  assert.ok(step.questions[0]!.options!.length && step.questions[0]!.options!.every(option => /its model is set at run time/.test(option.detail!)), JSON.stringify(step.questions));
  step = await advance(ctx, startRun(ctx), {});
  step = await advance(ctx, step.runId, { model: "openai/gpt-4.1-mini" });
  const second = step.runId;
  const options = step.questions[0]!.options!;
  assert.deepEqual(options.map(option => option.value), ["ticket classifier", "reply drafter", "escalation router"], "no task for tests, fixtures and docs");
  assert.ok(!options[0]!.detail!.includes("classify.test.ts"), "the harness never saw the test's usage, although it maps by file name");
  step = await advance(ctx, second, { tasks: [`${inTests[0]!.id}=ticket classifier`] });
  assert.match(step.notices!.join(" "), /is in tests\/classify\.test\.ts, a test, fixture, doc or saved result/);

  // A repository whose only model usages are in tests stops at the scan, before the harness is asked.
  const only = mkdtempSync(join(tmpdir(), "openmerit-repo-"));
  mkdirSync(join(only, "tests"));
  writeFileSync(join(only, "tests/classify.test.ts"), `const pinned = "gpt-4.1-mini";\n`);
  execFileSync("git", ["init", "-q"], { cwd: only });
  execFileSync("git", ["add", "-A"], { cwd: only });
  const harness = scriptedHarness(), onlyCtx = context(only, mkdtempSync(join(tmpdir(), "openmerit-home-")), harness);
  const stopped = await advance(onlyCtx, startRun(onlyCtx), {});
  assert.match(stopped.error ?? "", /Every model usage in this repository \(1\) is in tests, fixtures, docs or saved results/);
  assert.deepEqual(harness.calls, []);
});

test("history names every harness a run used, in order, when `openmerit connect` switched it between steps", async () => {
  const root = repo(), harness = scriptedHarness(), ctx = context(root, mkdtempSync(join(tmpdir(), "openmerit-home-")), harness);
  const runId = startRun(ctx);
  await advance(ctx, runId, {});
  // The usages were mapped with the first harness; eval discovery runs on the one connected now.
  const switched = { ...harness, label: "api:openrouter/anthropic/claude-sonnet-5.5" };
  const step = await advance({ ...ctx, harness: async () => switched }, runId, { model: "openai/gpt-4.1-mini", tasks: ["ticket classifier"] });
  assert.ok(ctx.harnessCalls.some(call => call.startsWith("discover")), JSON.stringify(step.questions));
  assert.equal(ctx.state.getRun(runId)!.harness, "codex → api:openrouter/anthropic/claude-sonnet-5.5");
  assert.deepEqual(ctx.state.events(runId).filter(event => event.kind === "harness").map(event => event.message), ["Harness switched from codex to api:openrouter/anthropic/claude-sonnet-5.5."]);
});

test("scan finds both models, the model shared by two tasks and dynamic uses, without showing secrets", () => {
  const root = repo();
  const scan = scanRepo(root, loadCatalogue());
  assert.deepEqual(scan.models.map(model => [model.catalogueId, model.usageIds.length]), [["openai/gpt-4.1-mini", 2], ["openai/gpt-5.4", 1]]);
  const shared = scan.usages.filter(usage => usage.catalogueId === "openai/gpt-4.1-mini").map(usage => `${usage.file}:${usage.line}`);
  assert.deepEqual(shared, ["src/classify.ts:3", "src/draft-reply.ts:3"]);
  const classifier = scan.usages.find(usage => usage.file === "src/classify.ts" && usage.kind === "model")!;
  assert.equal(classifier.dynamic, true);
  assert.equal(classifier.envVar, "CLASSIFIER_MODEL");
  assert.ok(scan.usages.some(usage => usage.dynamic && usage.envVar === "ESCALATION_MODEL" && usage.catalogueId === null));
  assert.ok(scan.usages.some(usage => usage.kind === "endpoint" && usage.value === "https://api.openai.com/v1"));
  assert.doesNotMatch(JSON.stringify(scan), /sk-test-abcdefgh/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "", "the scan changes nothing");

  // A JSON file naming more than 20 models is data and skipped; a small JSON config is still scanned; scan.exclude skips the rest.
  const catalogue = loadCatalogue();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "models.json"), JSON.stringify(catalogue.models.slice(0, 21).map(model => ({ model: model.id })), null, 1));
  writeFileSync(join(root, "data", "few.json"), JSON.stringify(catalogue.models.slice(0, 20).map(model => ({ model: model.id })), null, 1));
  writeFileSync(join(root, "app.json"), JSON.stringify({ model: "openai/gpt-5-nano", saved: { model: "catalogue:openrouter:openai/gpt-5.4" } }, null, 1));
  mkdirSync(join(root, "scripts", "old"), { recursive: true });
  writeFileSync(join(root, "scripts", "old", "try.ts"), `const model = "openai/gpt-6-luna";\n`);
  const filtered = scanRepo(root, catalogue, { exclude: ["scripts/old", "data/few.json"] });
  assert.deepEqual(filtered.skipped, ["data/models.json"]);
  assert.ok(filtered.usages.some(usage => usage.file === "app.json" && usage.catalogueId === "openai/gpt-5-nano"), "a small JSON config is scanned");
  assert.deepEqual(filtered.usages.filter(usage => usage.file === "app.json").map(usage => usage.value), ["openai/gpt-5-nano"], "OpenMerit's own catalogue references are not usages");
  assert.ok(!filtered.usages.some(usage => usage.file.startsWith("data/") || usage.file.startsWith("scripts/")));
  assert.deepEqual(filtered.usages.map(usage => usage.id), filtered.usages.map((_, index) => `u${index + 1}`), "usage IDs stay sequential");
  assert.equal(scanRepo(root, catalogue).usages.filter(usage => usage.file === "data/few.json").length, 20, "20 models is still configuration");

  // SDK spellings name catalogue models; a model named often, but only in tests, ranks after the application's models.
  writeFileSync(join(root, "agent.py"), `llm = init_chat_model("openai:gpt-5-nano")\nBEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"\nclaude = "claude-haiku-4-5-20251001"\n`);
  writeFileSync(join(root, "config.yml"), "default-model: gpt-4o-mini # unquoted\nname: gpt-4o\n");
  writeFileSync(join(root, "registry.yml"), catalogue.models.slice(0, 21).map(model => `- model: ${model.id}`).join("\n"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "test_agent.py"), Array.from({ length: 5 }, (_, index) => `model_${index} = "openai/gpt-6-luna"`).join("\n"));
  const sdk = scanRepo(root, catalogue, { exclude: ["data", "scripts", "app.json"] });
  assert.deepEqual(sdk.usages.filter(usage => usage.file === "agent.py").map(usage => usage.catalogueId), ["openai/gpt-5-nano", "anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5"]);
  assert.deepEqual(sdk.models.map(model => model.catalogueId).slice(-1), ["openai/gpt-6-luna"], "five uses in tests rank below one in the application");
  assert.deepEqual(sdk.usages.filter(usage => usage.file === "config.yml").map(usage => usage.catalogueId), ["openai/gpt-4o-mini"], "an unquoted model in configuration, but not any unquoted value");
  assert.deepEqual(sdk.skipped, ["registry.yml"], "a YAML file naming more than 20 models is data");
});

test("a project in a subdirectory of its Git repository keeps its settings, scan and dirty state to that directory", () => {
  // A monorepo: the root and apps/web are projects; docs/ is not. Only apps/web's model may be scanned from it.
  const top = mkdtempSync(join(tmpdir(), "openmerit-mono-"));
  mkdirSync(join(top, "apps", "web", "src"), { recursive: true });
  mkdirSync(join(top, "docs"), { recursive: true });
  writeFileSync(join(top, "package.json"), "{}");
  writeFileSync(join(top, "server.ts"), `const model = "openai/gpt-5.4";\n`);
  writeFileSync(join(top, "apps", "web", "package.json"), "{}");
  writeFileSync(join(top, "apps", "web", "src", "chat.ts"), `const model = "openai/gpt-4.1-mini";\n`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: top, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "monorepo");
  const real = findRepo(top).root;
  const web = findRepo(join(top, "apps", "web", "src"));
  assert.deepEqual([web.root, web.gitRoot], [join(real, "apps", "web"), real]);
  assert.notEqual(web.id, findRepo(top).id);
  assert.deepEqual([findRepo(join(top, "docs")).root, findRepo(join(top, "docs")).gitRoot], [real, null], "a directory without a project file belongs to the repository");
  assert.deepEqual(scanRepo(web.root, loadCatalogue()).usages.map(usage => `${usage.file} ${usage.catalogueId}`), ["src/chat.ts openai/gpt-4.1-mini"]);
  writeFileSync(join(top, "server.ts"), `const model = "openai/gpt-5-nano";\n`);
  assert.deepEqual([findRepo(join(top, "apps", "web")).dirty, findRepo(top).dirty], [false, true], "a change outside the project leaves it clean");
  // A repository set up at its root stays one project, from anywhere inside it.
  updateRepoConfig(real, { budget: { defaultUsd: 3 } });
  assert.equal(findRepo(join(top, "apps", "web", "src")).root, real);
});

test("a run whose every task has no eval finishes, saying what was not reviewed and how to add an eval", async () => {
  // The repository has no eval, and the case writer writes nothing usable.
  const root = repo(), scripted = scriptedHarness();
  const harness: Harness & { calls: string[] } = { ...scripted, json: async <T>(request: JsonRequest) => (!request.system.includes("You find the eval") ? scripted.json<T>(request)
    : { found: false, command: "", cwd: "", env: [], threshold: null, helpers: [], explanation: "", missing: "The repository has no labelled tickets. A runner would also be needed." } as T) };
  const ctx = context(root, mkdtempSync(join(tmpdir(), "openmerit-home-")), harness);
  const runId = startRun(ctx);
  const { step, asked } = await drive(ctx, runId);
  assert.equal(step.status, "done", step.error);
  assert.deepEqual(step.result!.tasks.map(task => task.status), ["no_eval"]);
  assert.match(step.result!.tasks[0]!.note, /^OpenMerit wrote no eval for it \(the harness wrote no usable case from the task's spec\), and the repository has none\. Run `openmerit scout` again to have OpenMerit write its eval/);
  assert.ok(!asked.some(question => question.id === "approve_evals"), "nothing to approve");
});

test("a later run reuses the approved eval although the harness names the task differently", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  updateRepoConfig(root, { evals: { "ticket classifier": { command: "node evals/classify.eval.ts", env: { CLASSIFIER_MODEL: "{{model}}" } } } });
  const scripted = scriptedHarness(), prompts: string[] = [];
  const harness: Harness & { calls: string[] } = { ...scripted, json: async <T>(request: JsonRequest) => {
    prompts.push(request.prompt);
    const reply = await scripted.json<{ tasks?: { name: string }[] }>(request);
    for (const task of reply.tasks ?? []) task.name = task.name.replace("ticket classifier", "Ticket Classifier");
    return reply as T;
  } };
  const ctx = context(root, home, harness);
  const runId = startRun(ctx);
  await advance(ctx, runId, {});
  const step = await advance(ctx, runId, { model: "openai/gpt-4.1-mini", tasks: ["Ticket Classifier"] });
  assert.match(prompts[0]!, /saved evals for these tasks; when usages serve one of them, use its exact name: "ticket classifier"/);
  assert.deepEqual(step.questions.map(question => question.id), ["approve_evals"]);
  assert.ok(!scripted.calls.some(call => call.startsWith("discover")), "no harness call to find the eval again");
  assert.deepEqual(scripted.calls.filter(call => call.startsWith("review")), ["review:Ticket Classifier"], "OpenMerit still reviews the task to write its eval");
});

test("an eval that fails before any model call shows why in the retry question and in history", async () => {
  const root = repo(), scripted = scriptedHarness();
  const command = `node -e "console.error('ModuleNotFoundError: No module named langchain_openai'); process.exit(2)"`;
  const harness: Harness & { calls: string[] } = { ...scripted, json: async <T>(request: JsonRequest) => (!request.system.includes("You find the eval") ? scripted.json<T>(request)
    : { found: true, command, cwd: ".", env: [], threshold: null, helpers: [], explanation: "", missing: "" } as T) };
  const ctx = context(root, mkdtempSync(join(tmpdir(), "openmerit-home-")), harness);
  const runId = startRun(ctx);
  const { step, asked } = await drive(ctx, runId);
  assert.match(asked.find(question => question.id === "retry_units")!.detail!, /eval exited with 2, \$0\.00000 spent\n {4}\| ModuleNotFoundError: No module named langchain_openai/);
  assert.equal(step.result!.tasks[0]!.status, "baseline_failed");
  assert.match(step.result!.tasks[0]!.note, /run `openmerit scout` again/);
  assert.match(renderRun(ctx.state, ctx.state.getRun(runId)!, step), /eval exited with 2\n {4}\| ModuleNotFoundError/);
});

/** The search path the fake endpoint implies over the six-model pool (ascending ECI: gpt-4o-mini 123.9,
 * gpt-4.1-nano 126.8, gpt-5-nano 139.1, gpt-5.4-nano 146.4, gpt-6-luna 156.4, gpt-5.6-luna 156.7). */
const EXPECTED_TRIALS = [
  ["search", "openai/gpt-5-nano", true], // middle of six: passes, so look weaker
  ["search", "openai/gpt-4o-mini", false], // weakest: fails, so look stronger; gpt-4.1-nano is next
  ["neighbour", "openai/gpt-5.4-nano", true], // gpt-4o-mini, the weaker neighbour, already failed: only stronger ones now
  ["neighbour", "openai/gpt-6-luna", true],
  ["neighbour", "openai/gpt-5.6-luna", true],
];
/** Per-item cost at list price for one request of 100 input and 5 output tokens, cheapest first. */
const EXPECTED_TOP = ["openai/gpt-5-nano", "openai/gpt-6-luna", "openai/gpt-5.4-nano"];

function assertSearch(ctx: Context, runId: string, step: Step) {
  const task = step.result!.tasks[0]!;
  const search = task.search!;
  assert.deepEqual(search.trials.map(trial => [trial.stage, trial.model, trial.accepted]), EXPECTED_TRIALS);
  assert.deepEqual(search.skipped.map(item => [item.model, item.stage]), [["openai/gpt-4.1-nano", "search"], ["openai/gpt-5.6-luna", "final"]], "a rejected model, and one whose calls keep failing, are skipped as untested");
  assert.match(search.skipped[0]!.reason, /rejected gpt-4.1-nano \(HTTP 404\)/);
  assert.match(search.skipped[1]!.reason, /kept failing for gpt-5.6-luna \(HTTP 500\)/);
  assert.equal(search.pick, "openai/gpt-5-nano");
  assert.deepEqual(search.finalists, ["openai/gpt-5-nano", "openai/gpt-5.4-nano", "openai/gpt-6-luna", "openai/gpt-5.6-luna"]);
  assert.match(search.shortfall ?? "", /Only 4 finalists/);
  // Screens run on five items the current model passed in every run; finals and the baseline on all ten, three times.
  const units = ctx.state.units(runId);
  const screens = units.filter(unit => unit.role === "screen");
  assert.equal(search.sampleIds.length, 5);
  assert.ok(screens.filter(unit => unit.status === "done").every(unit => JSON.stringify(Object.keys((unit.result as { items: object }).items).sort()) === JSON.stringify([...search.sampleIds].sort())));
  assert.deepEqual([task.baseline!.passes, task.baseline!.total, task.baseline!.runs], [30, 30, 3]);
  assert.deepEqual(task.candidates.map(item => [item.model, item.status, item.total]), [
    ["openai/gpt-5-nano", "measured", 30], ["openai/gpt-5.4-nano", "measured", 30], ["openai/gpt-6-luna", "measured", 30], ["openai/gpt-5.6-luna", "unavailable", 0],
  ]);
  assert.equal(task.candidates.find(item => item.model === "openai/gpt-5.6-luna")!.qualified, false, "a final that failed never qualifies");
  assert.deepEqual(task.top.map(item => item.model), EXPECTED_TOP);
  assert.ok(Math.abs(task.top[0]!.costPerItemUsd! - (100 * 0.05 + 5 * 0.4) / 1e6) < 1e-12);
  assert.ok(task.top[0]!.costIsEstimate);
  // Requests per model: the failing and rejected models stop after their screen; gpt-5-mini costs more than the current model and is never sent.
  const count = (model: string) => requests.filter(item => item === model).length;
  assert.equal(count("gpt-4o-mini"), 5);
  assert.equal(count("gpt-4.1-nano"), 1, "the eval stops at the first rejected request");
  assert.equal(count("gpt-5-mini"), 0);
  assert.equal(count("gpt-4.1-mini"), 30);
  assert.equal(count("gpt-5-nano"), 35);
  assert.ok(requests.every(model => model === "gpt-4.1-mini" || ALLOWED.includes(model)));
  // The proxy sent gpt-5.6-luna's failing final request three more times; the ledger meters it once.
  assert.equal(ctx.state.spend(runId).requests, requests.length - 3, "the ledger accounts for every eval request");
}

test("Scout Model Binary Search screens the ECI-ranked pool, runs finalists on every item, and ranks the cheapest at least as good as the current model", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  requests.length = 0;
  const before = readFileSync(join(root, "src/classify.ts"), "utf8");
  const { step, asked } = await drive(ctx, runId);
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  assert.ok(asked.some(question => question.prompt === TASK_QUESTION));
  const offered = asked.find(question => question.id === "tasks")!.options!;
  assert.deepEqual(offered.map(option => option.value), ["ticket classifier", "reply drafter", "escalation router"], "both tasks of the shared model are offered, then the task whose model is set at run time");
  assert.match(offered[2]!.detail!, /model is set at run time by ESCALATION_MODEL, so choose it if that is openai\/gpt-4\.1-mini/);
  assert.ok(!asked.some(question => question.id === "retry_units"), "a final whose model calls keep failing is skipped, not asked about");
  assert.ok(asked.some(question => question.prompt === CONFIGURE_QUESTION));
  // Only the selected task is discovered and evaluated.
  assert.deepEqual(ctx.harnessCalls.filter(call => call.startsWith("discover")), ["discover:ticket classifier"]);
  assert.ok(ctx.state.units(runId).every(unit => unit.task === "ticket classifier"));
  assertSearch(ctx, runId, step);
  assert.equal(step.result!.tasks[0]!.top[0]!.source, "eval");
  assert.equal(readFileSync(join(root, "src/classify.ts"), "utf8"), before);
  assert.equal(ctx.state.decisions(runId).find(item => item.kind === "configure")!.decision, "no");
  // History: the untracked .openmerit/ that setup wrote does not mark the revision dirty, and a budget nothing touched still shows.
  const shown = renderRun(ctx.state, ctx.state.getRun(runId)!, step);
  assert.match(shown, new RegExp(`^Run ${runId} \\(done\\)\n  Repository \\S+ at [0-9a-f]{40}\n`));
  assert.match(shown, /\nBudget:\n  \$10\.00 for this run; not reached or changed\.\n/);
  // A finished run replays from SQLite: resuming sends nothing.
  const sent = requests.length;
  await advance(ctx, runId, {});
  assert.equal(requests.length, sent);
  // A search that stopped recommends nothing, but each measured finalist keeps its real comparison with the current model.
  const run = ctx.state.getRun(runId)!;
  ctx.state.updateRun(runId, { phase: "compare", status: "running", state: { ...run.state, stopped: { "ticket classifier": "a screen failed and was not retried" } } });
  const stopped = (await advance(ctx, runId, {})).result!.tasks[0]!;
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.top, []);
  assert.deepEqual(stopped.candidates.filter(item => item.status === "measured").map(item => [item.model, item.qualified]),
    step.result!.tasks[0]!.candidates.filter(item => item.status === "measured").map(item => [item.model, item.qualified]), "measured finalists are not all labelled below the current model");
  assert.ok(stopped.candidates.some(item => item.qualified));
  // History survives a restart, and another repository has none of it.
  const reopened = new State(ctx.env);
  assert.equal(reopened.listRuns(ctx.repo.id)[0]!.status, "done");
  assert.equal(reopened.listRuns(findRepo(repo()).id).length, 0);
});

test("when every qualified finalist costs more per item than the current model, challengers are priced up to its list price", async () => {
  // By ECI: gpt-4o-mini 123.9 and gpt-4o-mini-2024-07-18 128.6 answer wrongly; the search selects gpt-oss-20b 135.0 and takes
  // gpt-5-nano, gpt-oss-120b, gpt-5.4-nano and gpt-6-luna as finalists, which leaves gpt-5.6-luna (156.7, $1.40) untried.
  const pool = ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-oss-20b", "gpt-5-nano", "gpt-oss-120b", "gpt-5.4-nano", "gpt-6-luna", "gpt-5.6-luna"];
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  updateRepoConfig(root, { endpoints: [{ id: "openai", kind: "openai", baseUrl, apiKey: { env: "FAKE_ENDPOINT_KEY" }, allowedModels: pool }] });
  const ctx = context(root, home);
  const runId = startRun(ctx);
  requests.length = 0;
  // The finalists answer at length, so each costs more per item than the current model ($2.00 by list price), although
  // the leader, gpt-oss-20b, lists at $0.16: no challenger is priced at or below it.
  wrong.add("gpt-4o-mini-2024-07-18");
  for (const model of ["gpt-oss-20b", "gpt-5-nano", "gpt-oss-120b", "gpt-5.4-nano", "gpt-6-luna"]) verbose.add(model);
  flaky.model = "";
  try {
    const { step } = await drive(ctx, runId);
    assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
    const task = step.result!.tasks[0]!;
    assert.deepEqual(task.search!.finalists, ["openai/gpt-oss-20b", "openai/gpt-5-nano", "openai/gpt-oss-120b", "openai/gpt-5.4-nano", "openai/gpt-6-luna"]);
    assert.ok(task.top.every(item => item.model === "openai/gpt-5.6-luna" || item.costPerItemUsd! > task.baseline!.costPerItemUsd!), "every finalist costs more per item than the current model");
    assert.deepEqual(task.search!.trials.filter(trial => trial.stage === "challenger").map(trial => [trial.model, trial.accepted]), [["openai/gpt-5.6-luna", true]]);
    assert.deepEqual(task.search!.challengers, ["openai/gpt-5.6-luna"]);
    assert.equal(task.top[0]!.model, "openai/gpt-5.6-luna");
    assert.ok(task.top[0]!.costPerItemUsd! < task.baseline!.costPerItemUsd!);
  } finally {
    wrong.delete("gpt-4o-mini-2024-07-18"); verbose.clear(); flaky.model = "gpt-5.6-luna";
  }
});


test("Yes previews and applies only the approved edit", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  requests.length = 0;
  const before = readFileSync(join(root, "src/classify.ts"), "utf8").split("\n");
  const draft = readFileSync(join(root, "src/draft-reply.ts"), "utf8");
  const { step, asked } = await drive(ctx, runId, { configure_ticket_classifier: true, apply_ticket_classifier: true });
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  assert.match(asked.find(question => question.id === "apply_ticket_classifier")!.detail!, /-export const CLASSIFIER_MODEL = process\.env\.CLASSIFIER_MODEL \?\? "gpt-4\.1-mini";\n\+export const CLASSIFIER_MODEL = process\.env\.CLASSIFIER_MODEL \?\? "gpt-5-nano";/);
  const afterLines = readFileSync(join(root, "src/classify.ts"), "utf8").split("\n");
  assert.deepEqual(afterLines.map((line, index) => (line === before[index] ? null : index + 1)).filter(Boolean), [3]);
  assert.equal(readFileSync(join(root, "src/draft-reply.ts"), "utf8"), draft, "the unselected reply drafter keeps its model");
  assert.ok(step.result!.configuration["ticket classifier"]!.manual!.some(item => item.includes("CLASSIFIER_MODEL")));
});

test("Yes leaves a model setting that other code shares to the user, as an instruction instead of an edit", async () => {
  // CLASSIFIER_MODEL becomes a shared setting: the classifier and a second job Scout never evaluated both use it.
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  writeFileSync(join(root, "src", "triage.ts"), `import { CLASSIFIER_MODEL } from "./classify.ts";\nexport const triageModel = CLASSIFIER_MODEL;\n`);
  const ctx = context(root, home);
  const before = readFileSync(join(root, "src/classify.ts"), "utf8");
  const { step, asked } = await drive(ctx, startRun(ctx), { configure_ticket_classifier: true });
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  assert.ok(!asked.some(question => question.id === "apply_ticket_classifier"), "nothing to apply");
  assert.equal(readFileSync(join(root, "src/classify.ts"), "utf8"), before);
  const manual = step.result!.configuration["ticket classifier"]!.manual!;
  assert.ok(manual.some(item => /^src\/classify\.ts:3 sets CLASSIFIER_MODEL, which 3 other places use \(.*src\/triage\.ts:2.*\): editing it would switch all of them/.test(item)), manual.join("\n"));
});

test("an eval that sends no model request through the proxy stops after one run of the current model", async () => {
  // The eval answers from a file instead of calling the model: whatever it spends elsewhere is not metered, and it never ran the candidate.
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  writeFileSync(join(root, "evals", "offline.ts"), `console.log(JSON.stringify({ items: Array.from({ length: 10 }, (_, index) => ({ id: "t" + index, pass: true })) }));\n`);
  const ctx = context(root, home, scriptedHarness({ command: "node evals/offline.ts" }));
  requests.length = 0;
  const { step, asked } = await drive(ctx, startRun(ctx));
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  assert.match(asked.find(question => question.id === "approve_evals")!.detail!, /Only model requests the eval sends to OPENAI_BASE_URL \(OpenMerit's proxy\) are metered and capped/);
  const task = step.result!.tasks[0]!;
  assert.equal(task.status, "stopped");
  assert.match(task.note, /After one run of the current model: the eval made no model requests through OpenMerit's proxy/);
  assert.deepEqual(ctx.state.units(step.runId).map(unit => `${unit.role} r${unit.repeat}`), ["baseline r1"]);
  assert.match(renderRun(ctx.state, ctx.state.getRun(step.runId)!, step), /stopped before screening any candidate/);
});

/** The fixture's ten tickets as written cases, with the first `wrong` of them given the wrong queue. */
const writtenCases = (wrongAnswers = 0) => [...tickets].map(([ticket, queue], index) => ({ kind: "typical", ticket, queue: index < wrongAnswers ? (queue === "billing" ? "account" : "billing") : queue }));

test("Scout always writes an eval from its review of the code, runs the repository's eval beside it, and saves the Eval it ran once approved", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const guardrail = "Reveals another customer's ticket";
  const harness = scriptedHarness({}, { spec: { guardrails: [guardrail] }, cases: writtenCases() });
  const ctx = context(root, home, harness);
  requests.length = 0; judged.count = 0;
  const runId = startRun(ctx);
  const { step, asked } = await drive(ctx, runId);
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  // Ten tickets are fewer than the twelve cases asked for, so the writer is asked once more.
  assert.deepEqual(harness.calls.filter(call => call !== "map"), ["discover:ticket classifier", "review:ticket classifier", "write", "write"]);
  const approval = asked.find(question => question.id === "approve_evals")!.detail!;
  assert.match(approval, /Eval: written by OpenMerit from its review of the code, 10 cases \(10 typical\), saved in \.openmerit\/evals\/ticket-classifier\/ once approved/);
  assert.match(approval, new RegExp(`Guardrails: ${guardrail}`));
  assert.match(approval, /Also the repository's eval, as extra evidence \(items repo:…\): node evals\/classify\.eval\.ts/);
  // The current model runs both evals: ten written cases and the repository's ten items, three times.
  const task = step.result!.tasks[0]!;
  assert.deepEqual([task.baseline!.passes, task.baseline!.total], [60, 60]);
  const first = ctx.state.units(runId).find(unit => unit.role === "baseline" && unit.repeat === 1)!.result as { items: Record<string, boolean> };
  assert.equal(Object.keys(first.items).filter(item => item.startsWith("repo:")).length, 10);
  assert.ok(task.top.length > 0, "a cheaper model qualified");
  // A right label is also judged on the guardrail, through the proxy, so the judge's calls count in the run's budget.
  assert.ok(judged.count >= 30, `${judged.count} judge calls`);
  // Approval saved the Eval and the repository's eval beside it; nothing else in the repository changed.
  const saved = readRepoConfig(root).evals!["ticket classifier"]!;
  assert.equal(saved.generated, ".openmerit/evals/ticket-classifier");
  assert.equal(saved.repoEval?.command, "node evals/classify.eval.ts");
  const bundle = JSON.parse(readFileSync(join(root, ".openmerit/evals/ticket-classifier/bundle.json"), "utf8")) as { guardrails: string[]; prompt: { messages: { content: string }[] } };
  assert.deepEqual(bundle.guardrails, [guardrail]);
  assert.equal(bundle.prompt.messages[0]!.content, "{{ticket}}");
  assert.equal((JSON.parse(readFileSync(join(root, ".openmerit/evals/ticket-classifier/cases.json"), "utf8")) as unknown[]).length, 10);
  // The next run reuses the saved Eval: no review, no case writing, no search for the repository's eval.
  harness.calls.length = 0;
  const next = await advance(ctx, startRun(ctx), {});
  const again = await advance(ctx, next.runId, { model: "openai/gpt-4.1-mini", tasks: ["ticket classifier"] });
  assert.deepEqual(again.questions.map(question => question.id), ["approve_evals"]);
  assert.deepEqual(harness.calls, ["map"]);
});

test("a generated eval the current model passes under 80% of recommends nothing, with the failed cases and why", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  // Six of the ten written cases expect the wrong queue: the current model passes 4 of them and all 10 of the repository's items.
  const ctx = context(root, home, scriptedHarness({}, { cases: writtenCases(6) }));
  requests.length = 0;
  const runId = startRun(ctx);
  const { step } = await drive(ctx, runId);
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  const task = step.result!.tasks[0]!;
  assert.equal(task.status, "stopped");
  assert.deepEqual(task.top, []);
  assert.match(task.note, /openai\/gpt-4\.1-mini passed 42 of 60 case runs of its own eval, under the 80% OpenMerit needs before the eval can tell models apart, so no model is recommended\./);
  assert.match(task.note, /Failed cases: written-1: Answered (billing|technical|account), expected (billing|account)\./);
  assert.ok(ctx.state.units(runId).every(unit => unit.role === "baseline"), "no candidate was screened");
  // The Eval is set aside, so the next run reviews the task again; the repository's eval stays saved.
  assert.match(task.note, /OpenMerit set this eval aside; the next `openmerit scout` reviews the task and writes it again\./);
  assert.ok(!existsSync(join(root, ".openmerit/evals/ticket-classifier")));
  assert.deepEqual(readRepoConfig(root).evals!["ticket classifier"]?.command, "node evals/classify.eval.ts");
  assert.equal(readRepoConfig(root).evals!["ticket classifier"]?.generated, undefined);
});

test("an eval the harness counts fewer than five items in is not run alone: without a generated eval the task is skipped before anything is spent", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home, scriptedHarness({ items: 4 }));
  requests.length = 0;
  const { step, asked } = await drive(ctx, startRun(ctx));
  assert.equal(step.status, "done", step.error ?? JSON.stringify([step.questions, step.notices]).slice(0, 1500));
  assert.ok(!asked.some(question => question.id === "approve_evals"));
  assert.equal(step.result!.tasks[0]!.status, "no_eval");
  assert.match(step.result!.tasks[0]!.note, /has 4 labelled items, fewer than the 5 Scout screens candidates on/);
  assert.equal(requests.length, 0, "no eval ran");
});

test("near the budget a request is refused before it is sent; decline keeps the run paused; a run-only raise continues after a restart", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  ctx.state.updateRun(runId, { budgetUsd: 0.0035 });
  requests.length = 0;
  const paused = await drive(ctx, runId);
  assert.equal(paused.step.status, "budget_paused");
  assert.ok(paused.step.spend.totalUsd <= 0.0035);
  const sent = requests.length;
  assert.ok(sent > 0 && sent < 10, `paused part-way through the baseline eval (${sent} requests)`);
  assert.equal(ctx.state.units(runId).find(unit => unit.role === "baseline")!.status, "budget_paused");

  const declined = await advance(ctx, runId, { budget_action: "decline" });
  assert.equal(declined.status, "budget_paused");
  assert.equal(requests.length, sent, "declining sends nothing");

  ctx.state.close();
  const restarted = context(root, home);
  const raised = await drive(restarted, runId, { budget_action: "run", budget_amount: "1" });
  assert.equal(raised.step.status, "done", raised.step.error ?? JSON.stringify([raised.step.questions, raised.step.notices]).slice(0, 1500));
  assert.ok(!raised.asked.some(question => question.id === "approve_evals"), "the eval approval is kept across the restart");
  assert.equal(readRepoConfig(root).budget, undefined, "a run-only raise does not change the default");
  assert.deepEqual(restarted.state.budgetEvents(runId).map(event => [event.kind, event.scope]), [["alert", null], ["decline", null], ["raise", "run"]]);
  assert.equal(restarted.state.getRun(runId)!.budgetUsd, 1);
  // The proxy sent gpt-5.6-luna's failing final request three more times; the ledger meters it once.
  assert.equal(restarted.state.spend(runId).requests, requests.length - 3, "every eval request is in the ledger once");

  // A second run saves its raise as the repository default.
  const second = startRun(restarted);
  restarted.state.updateRun(second, { budgetUsd: 0.0035 });
  const again = await drive(restarted, second, { budget_action: "default", budget_amount: "0.5" });
  assert.equal(again.step.status, "done", again.step.error);
  assert.equal(readRepoConfig(root).budget?.defaultUsd, 0.5);
});

test("a run paused by one request's output limit says so, and continues at the same budget once the eval asks for less", async () => {
  // The classifier asks for up to 2000 output tokens: at gpt-4.1-mini's list price that reservation alone passes a $0.003 budget.
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  ctx.state.updateRun(runId, { budgetUsd: 0.003 });
  requests.length = 0;
  const paused = await drive(ctx, runId);
  assert.equal(paused.step.status, "budget_paused");
  assert.equal(requests.length, 0, "the first request is refused before it is sent");
  const question = paused.step.questions.find(item => item.id === "budget_action")!;
  assert.match(question.detail!, /A request needed about \$0\.00\d+ for up to 2000 output tokens\. Scout reserves each request's cost at its max_tokens/);
  assert.ok(question.options!.some(option => option.value === "continue"));

  // Continuing unchanged pauses again without sending anything; after the eval asks for 20 tokens, it runs at the same budget.
  assert.equal((await advance(ctx, runId, { budget_action: "continue" })).status, "budget_paused");
  assert.equal(requests.length, 0);
  const source = join(root, "src", "classify.ts");
  writeFileSync(source, readFileSync(source, "utf8").replace("max_completion_tokens: 2000", "max_completion_tokens: 20"));
  await advance(ctx, runId, { budget_action: "continue" });
  assert.ok(requests.length >= 10, `the current model ran (${requests.length} requests)`);
  assert.equal(ctx.state.units(runId).find(unit => unit.role === "baseline" && unit.repeat === 1)!.status, "done");
  assert.equal(ctx.state.getRun(runId)!.budgetUsd, 0.003, "the budget did not change");
});

test("the metering proxy estimates an answer without token usage by its size, not at the request's maximum", async () => {
  const ctx = context(repo(), mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  const nano = loadCatalogue().models.find(model => model.id === "openai/gpt-5-nano")!;
  // An endpoint that answers without a usage block, as some providers and streams do.
  const bare = (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "billing" } }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const proxy = new EvalProxy(ctx.state, bare);
  const url = await proxy.start();
  const { token } = proxy.open({ runId, unitId: "unit", endpointId: "openai", baseUrl, apiKey: "sk-fake-endpoint", model: "gpt-5-nano", allowed: () => nano });
  const answer = await fetch(`${url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "gpt-5-nano", max_completion_tokens: 128000, messages: [{ role: "user", content: "I was charged twice." }] }) });
  assert.equal(answer.status, 200);
  await proxy.stop();
  const spend = ctx.state.spend(runId);
  const reserved = (128000 * nano.outputPerM!) / 1e6;
  assert.deepEqual([spend.unknown, spend.inFlight], [0, 0]);
  assert.ok(spend.estimatedUsd > 0 && spend.totalUsd < reserved / 1000, `estimated $${spend.totalUsd}, reserved $${reserved}`);
});

test("the ledger refuses the first request that would pass the budget, exactly at the boundary", () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  ctx.state.updateRun(runId, { budgetUsd: 1 });
  const first = ctx.state.reserve({ runId, unitId: "u", model: "m", endpoint: "e", expectedUsd: 0.95 });
  assert.ok(first.ok);
  ctx.state.settle(first.id, { actualUsd: 0.9, estimatedUsd: null, latencyMs: 1 });
  assert.ok(ctx.state.reserve({ runId, unitId: "u", model: "m", endpoint: "e", expectedUsd: 0.1 }).ok, "exactly at the limit is allowed");
  const refused = ctx.state.reserve({ runId, unitId: "u", model: "m", endpoint: "e", expectedUsd: 0.0001 });
  assert.equal(refused.ok, false);
  // The second reservation never settled: it counts as in-flight spend, not as zero.
  assert.equal(ctx.state.spend(runId).inFlight, 1);
});

test("a run whose process died becomes interrupted and keeps its in-flight spend", () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  ctx.state.ensureUnit({ id: "unit-1", runId, task: "t", model: "m", endpoint: "e", role: "baseline", repeat: 1 });
  ctx.state.setUnit("unit-1", { status: "running" });
  ctx.state.reserve({ runId, unitId: "unit-1", model: "m", endpoint: "e", expectedUsd: 0.02 });
  ctx.state.db.prepare("UPDATE runs SET lock_pid = 4194303 WHERE id = ?").run(runId);
  assert.deepEqual(ctx.state.reapInterrupted(ctx.repo.id), [runId]);
  assert.equal(ctx.state.getRun(runId)!.status, "interrupted");
  assert.equal(ctx.state.units(runId)[0]!.status, "interrupted");
  assert.equal(ctx.state.spend(runId).inFlightUsd, 0.02);
});

test("a candidate still rate-limited after the proxy's retries is skipped as untested, without a retry question", async () => {
  const ctx = context(repo(), mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  requests.length = 0;
  Object.assign(rateLimit, { model: "gpt-5-nano", remaining: Infinity });
  try {
    const { step, asked } = await drive(ctx, runId);
    assert.equal(step.status, "done", step.error ?? JSON.stringify(step.questions).slice(0, 500));
    const search = step.result!.tasks[0]!.search!;
    assert.deepEqual(search.skipped.filter(item => item.model === "openai/gpt-5-nano").map(item => [item.stage, item.reason.split("\n")[0]]), [["search", "openai rate-limited gpt-5-nano (HTTP 429)"]]);
    // Without gpt-5-nano the middle of the five left (4o-mini, 4.1-nano, 5.4-nano, 6-luna, 5.6-luna) is gpt-5.4-nano.
    assert.equal(search.trials[0]!.model, "openai/gpt-5.4-nano", "the search went on without it");
    assert.ok(!asked.some(question => question.id === "retry_units" && question.detail?.includes("gpt-5-nano")), "no retry question for the rate limit");
  } finally { rateLimit.remaining = 0; }
});

test("when the current model's answers are cut off before any text, the stopped search says so", async () => {
  const ctx = context(repo(), mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  cutOff.model = "gpt-4.1-mini";
  try {
    const { step } = await drive(ctx, runId);
    assert.equal(step.result!.tasks[0]!.status, "stopped");
    // The first run already leaves no item to screen on, so the other two baseline runs are not paid for.
    assert.deepEqual([step.result!.tasks[0]!.baseline!.status, step.result!.tasks[0]!.baseline!.runs], ["measured", 1]);
    assert.match(step.result!.tasks[0]!.note, /passes only 0 items in its first run; .* 10 of its 10 answers stopped at the request's output token limit before any text, as when openai has the model reason first/);
  } finally { cutOff.model = ""; }
});

test("the metering proxy refuses models outside the allowed pool without forwarding them", async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), "openmerit-home-"));
  const ctx = context(root, home);
  const runId = startRun(ctx);
  const proxy = new EvalProxy(ctx.state);
  const url = await proxy.start();
  const catalogue = loadCatalogue();
  const nano = catalogue.models.find(model => model.id === "openai/gpt-5-nano")!;
  const { token, tally } = proxy.open({ runId, unitId: "unit", endpointId: "openai", baseUrl, apiKey: "sk-fake-endpoint", model: "gpt-5-nano", allowed: model => (model === "gpt-5-nano" ? nano : undefined) });
  requests.length = 0;
  const post = (model: string) => fetch(`${url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal((await post("gpt-4o")).status, 403);
  assert.equal((await post("gpt-5-nano")).status, 200);
  assert.deepEqual(requests, ["gpt-5-nano"]);
  assert.deepEqual(tally.poolViolations, ["gpt-4o"]);
  assert.equal((await fetch(`${url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
  await proxy.stop();
});

test("the metering proxy sends a failed model call again, and passes on a failure that lasts", async () => {
  const ctx = context(repo(), mkdtempSync(join(tmpdir(), "openmerit-home-")));
  const runId = startRun(ctx);
  const nano = loadCatalogue().models.find(model => model.id === "openai/gpt-5-nano")!;
  const proxy = new EvalProxy(ctx.state);
  const url = await proxy.start();
  const { token, tally } = proxy.open({ runId, unitId: "unit", endpointId: "openai", baseUrl, apiKey: "sk-fake-endpoint", model: "gpt-5-nano", allowed: () => nano });
  const post = () => fetch(`${url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "gpt-5-nano", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  try {
    requests.length = 0;
    Object.assign(rateLimit, { model: "gpt-5-nano", remaining: 2 });
    assert.equal((await post()).status, 200, "a brief failure never reaches the eval");
    assert.equal(requests.length, 3);
    assert.deepEqual(tally.upstreamErrors, []);
    requests.length = 0;
    rateLimit.remaining = Infinity;
    assert.equal((await post()).status, 429, "a lasting failure reaches the eval");
    assert.equal(requests.length, 4, "the first send and three retries");
    assert.deepEqual(tally.upstreamErrors, [429]);
    assert.equal(ctx.state.spend(runId).requests, 2, "each eval request is metered once, however often it was sent");
  } finally { rateLimit.remaining = 0; await proxy.stop(); }
});
