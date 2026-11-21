// Conformance: the CLI's Scout and the cloud job, each through its own connectors (the repo scan and
// the eval command; the agent bundle and openmerit/ranking's measure), on the same ten labelled
// tickets, the same catalogue and the same fake model server. Every decision is openmerit/engine's,
// so both hosts must measure the same models, rank the same Top 3, ask the same approval question
// and spend the same. A host that decides anything on its own fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalogue } from "../../openmerit-core/src/catalogue/catalogue.ts";
import type { Harness, JsonRequest } from "../../openmerit-core/src/harness/harness.ts";
import { startRun } from "../../openmerit-core/src/local.ts";
import { advance, type Answer, type Context, type Question, type Step } from "../../openmerit-core/src/scout/workflow.ts";
import { updateGlobalConfig, updateRepoConfig } from "../../openmerit-core/src/state/config.ts";
import { State } from "../../openmerit-core/src/state/db.ts";
import { findRepo } from "../../openmerit-core/src/state/paths.ts";
import { caller, catalogue, costOf, startApp, stop, subscribe, waitFor, type FakeModels } from "./helpers.ts";

const fixture = new URL("../../openmerit-core/test/fixtures/support-app/", import.meta.url).pathname;
const tickets = readFileSync(join(fixture, "data/tickets.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { id: string; ticket: string; queue: string });
const CURRENT = "openai/gpt-4.1-mini";
/** The ticket the current model misses once, so it is never a screening item, and the near misses always miss. */
const FLAKY = "The mobile app crashes every time I open the reports tab on Android 15.";
/** Models rated below this ECI answer "other"; those from it up to the current model's 134.2 miss the flaky ticket. */
const WEAK_BELOW = 128, RIGHT_FROM = 134;
const eci = new Map(catalogue.models.map(model => [model.id, model.eci]));
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * The fake model server both hosts call, standing in for OpenRouter. It answers each ticket by the
 * catalogue: models rated below WEAK_BELOW answer "other", those just below the current model always
 * miss the flaky ticket (near misses), and the rest, with models the catalogue does not rate, answer
 * right. The current model misses the flaky ticket the first time each host asks it, so it passes
 * 29 of 30 and the screening items, drawn at random from the tickets it passed every time, never
 * include it: both hosts' searches take the same path whatever they draw. Each answer reports what
 * it cost. The cloud's case writer writes nothing, so both hosts measure the same ten tickets.
 */
async function fakeServer(): Promise<FakeModels & { newHost: () => void }> {
  let flakyMissed = false;
  const fake: FakeModels & { newHost: () => void } = { url: "", calls: [], onCall: null, cost: null, close: async () => {}, newHost: () => { flakyMissed = false; } };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      // OpenMerit checks its model key with OpenRouter's free GET /key before a job starts.
      if (req.url === "/key") { res.writeHead(fake.keyStatus ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(fake.keyStatus ? { error: { code: fake.keyStatus, message: "API key expired" } } : { data: { label: "test" } })); return; }
      const parsed = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const writer = parsed.messages[0]?.role === "system" && parsed.messages[0].content.startsWith("You write test cases");
      const text = parsed.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
      const item = tickets.find(entry => text.includes(entry.ticket));
      fake.calls.push({ model: parsed.model, ticket: writer ? "writer" : item?.id ?? "", auth: "" });
      const strength = eci.get(parsed.model) ?? 200;
      const flaky = item?.ticket === FLAKY && (parsed.model === CURRENT ? !flakyMissed : strength < RIGHT_FROM);
      if (flaky && parsed.model === CURRENT) flakyMissed = true;
      const answer = writer ? JSON.stringify({ cases: [] }) : strength < WEAK_BELOW || flaky ? "other" : item?.queue ?? "other";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 50, completion_tokens: 2, cost: writer ? 0 : costOf(parsed.model) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

/** A scripted coding agent for the CLI: maps the classifier's usages to one task and finds the fixture's eval. */
function harness(): Harness {
  return {
    kind: "codex", label: "codex", usage: { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 },
    async json<T>(request: JsonRequest): Promise<T> {
      if (request.system.includes("map model usages")) {
        const byTask = new Map<string, string[]>();
        for (const [, id, file] of request.prompt.matchAll(/^### (u\d+) model[^\n]* at ([^:\n]+):\d+$/gm)) {
          const name = file!.includes("classify") ? "ticket classifier" : file!.includes("draft") ? "reply drafter" : "escalation router";
          byTask.set(name, [...byTask.get(name) ?? [], id!]);
        }
        return { tasks: [...byTask].map(([name, usageIds]) => ({ name, description: `the ${name}`, usageIds, usesTools: false, needsVision: false, structuredOutput: false })) } as T;
      }
      return { found: true, command: "node evals/classify.eval.ts", cwd: ".", env: [{ name: "CLASSIFIER_MODEL", value: "{{model}}" }], threshold: null, langfuseDataset: "", passScore: "", passMin: null, helpers: [], explanation: "the classifier's eval", missing: "", items: null } as T;
    },
  };
}

/** The CLI host: Scout on a copy of the fixture repository, its only endpoint the fake as OpenRouter. */
async function cliRun(models: FakeModels) {
  const root = mkdtempSync(join(tmpdir(), "openmerit-conformance-"));
  cpSync(fixture, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANGFUSE_")));
  const env = { ...inherited, OPENMERIT_HOME: mkdtempSync(join(tmpdir(), "openmerit-home-")), FAKE_ROUTER_KEY: "or-test-key" };
  updateGlobalConfig({ harness: { kind: "codex" } }, env);
  updateRepoConfig(root, { endpoints: [{ id: "openrouter", kind: "openrouter", baseUrl: `${models.url}/v1`, apiKey: { env: "FAKE_ROUTER_KEY" }, allowedModels: "all" }] });
  const scripted = harness();
  const ctx: Context = { state: new State(env), repo: findRepo(root), catalogue: loadCatalogue(), env, harness: async () => scripted, log: () => {} };
  const runId = startRun(ctx);
  const answers: Record<string, Answer> = { model: CURRENT, corrections: "", tasks: ["ticket classifier"], approve_evals: true, configure_ticket_classifier: false };
  const asked: Question[] = [];
  let step: Step = await advance(ctx, runId, {});
  for (let guard = 0; step.questions.length && guard < 30; guard++) {
    asked.push(...step.questions);
    const next = Object.fromEntries(step.questions.map(question => [question.id, answers[question.id]]));
    assert.ok(Object.values(next).every(answer => answer !== undefined), `the CLI asked ${step.questions.map(question => question.id).join(", ")}`);
    step = await advance(ctx, runId, next as Record<string, Answer>);
  }
  assert.equal(step.result?.tasks.length, 1, JSON.stringify(step.notices));
  return { task: step.result!.tasks[0]!, approval: asked.find(question => question.id === "configure_ticket_classifier") ?? null, spendUsd: ctx.state.spend(runId).settledUsd };
}

test("the CLI and the cloud measure, rank, ask and spend the same on the same fixture", async () => {
  // The CLI first, then the cloud, on one fake whose calls are counted for each.
  const models = await fakeServer();
  let app = null;
  try {
    const cli = await cliRun(models);
    const cliCalls = models.calls.length;
    models.newHost();

    app = await startApp({ models, env: { CLERK_SECRET_KEY: "sk_test_fake", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.openmerit.test$").toString("base64")}` } });
    await subscribe(app, "org_conformance");
    const agent = caller(app, "test:user_conformance:org_conformance:admin");
    const started = await agent.tool("openmerit_recommend", { bundle: {
      task: "ticket classifier", current: { model: CURRENT },
      prompt: { system: "Classify the support ticket into exactly one queue: billing, technical, account, other. Reply with the queue name only, in lowercase.", messages: [{ role: "user", content: "{{ticket}}" }] },
      output: { kind: "label", labels: ["billing", "technical", "account", "other"] },
      examples: tickets.map(item => ({ input: { ticket: item.ticket }, expected: item.queue })),
      codeRefs: [{ file: "src/classify.ts", line: 3, spelling: 'export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "gpt-4.1-mini";' }],
    } });
    const jobId = started.data.job_id as string;
    assert.ok(jobId, started.text);
    const done = await waitFor(() => agent.tool("openmerit_result", { job_id: jobId }), value => ["done", "failed", "stopped", "needs_input"].includes(value.data.status as string), 240_000);
    assert.equal(done.data.status, "done", done.text);
    type Row = { model: string; passes: number; total: number };
    const cloud = (await agent.api<{ baseline: Row; top: Row[]; candidates: Row[]; nearMisses: Row[] }>(`/api/runs/${jobId}`)).body;
    const result = done.data.result as { approval: { id: string; prompt: string; detail: string } | null; spend: { openmeritUsd: number }; basedOn: string[] };

    const row = (item: { model: string; passes: number; total: number }) => [item.model, item.passes, item.total];
    // Results: the same baseline, the same measured candidates with the same scores, the same Top 3.
    assert.deepEqual(row(cloud.baseline), row(cli.task.baseline!));
    assert.deepEqual(row(cloud.baseline), [CURRENT, 29, 30], "three runs of ten tickets");
    // The cloud also lists the models screened out on the sample; the CLI keeps those in its search trials.
    const measured = (rows: Row[]) => rows.filter(item => item.total === 30).map(row).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(measured(cloud.candidates), measured(cli.task.candidates));
    assert.ok(cloud.top.length > 0, "the fixture has a qualifier");
    assert.deepEqual(cloud.top.map(row), cli.task.top.map(row));
    // A near miss the cloud reports is a candidate the CLI measured one ticket short of the bar.
    assert.ok(cloud.nearMisses.length > 0, "the fixture has a near miss");
    for (const miss of cloud.nearMisses) assert.deepEqual(row(miss), row(cli.task.candidates.find(item => item.model === miss.model)!));

    // Questions: the same approval question, word for word.
    assert.ok(cli.approval && result.approval);
    assert.deepEqual({ id: result.approval.id, prompt: result.approval.prompt, detail: result.approval.detail }, { id: cli.approval.id, prompt: cli.approval.prompt, detail: cli.approval.detail });

    // Evidence: each host names its own connection's, by the same quality rule.
    assert.deepEqual(cli.task.basedOn, ["Grader: your eval's pass or fail per item, from eval-command (node evals/classify.eval.ts).", "Cases: 10 items of your eval from eval-command (node evals/classify.eval.ts).", "Priority: you asked about this task, from repo-scan (the task you chose)."]);
    assert.deepEqual(result.basedOn, ["Grader: the expected labels of your examples, from agent-bundle (openmerit_recommend).", "Cases: 10 example cases from agent-bundle (openmerit_recommend).", "Priority: you asked about this task, from agent-bundle (openmerit_recommend)."]);

    // Spend: the same model calls, at the same cost, settled once.
    const cloudCalls = models.calls.slice(cliCalls).filter(call => call.ticket !== "writer");
    assert.equal(cloudCalls.length, cliCalls);
    const cost = (calls: FakeModels["calls"]) => sum(calls.map(call => costOf(call.model)));
    assert.ok(Math.abs(cli.spendUsd - cost(models.calls.slice(0, cliCalls))) < 1e-9, `CLI spend ${cli.spendUsd}`);
    assert.ok(Math.abs(result.spend.openmeritUsd - cli.spendUsd) < 1e-9, `cloud spend ${result.spend.openmeritUsd}, CLI ${cli.spendUsd}`);
  } finally {
    if (app) await stop(app);
    await models.close();
  }
});
