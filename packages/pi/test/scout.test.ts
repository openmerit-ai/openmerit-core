import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import scoutExtension, { createScoutPiExtension } from "../src/index.ts";
import { scoutRule, scoutSkill } from "../../terminal/src/scout-instructions.ts";
import { credentialsPath } from "../../terminal/src/scout-credentials.ts";

const key = `om_${"a".repeat(43)}`;
const toolName = "mcp__openmerit__scout_models";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openmerit-pi-scout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function saveCredentials(path: string, server: string): Promise<void> {
  await writeFile(path, JSON.stringify({ version: 1, server, key }), { mode: 0o600 });
}

// A real HTTP boundary, not a mocked Pi API or custom client transport. No
// inference service is contacted; only MCP initialization, discovery and calls.
async function mcpFixture(t: TestContext) {
  const requests: Array<{ method: string; authorization: string | undefined; path: string | undefined; params?: unknown }> = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { id?: number; method: string; params?: unknown };
    requests.push({ method: rpc.method, authorization: request.headers.authorization, path: request.url, params: rpc.params });
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end();
      return;
    }
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    switch (rpc.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26", capabilities: { tools: {} },
          serverInfo: { name: "scout-contract-fixture", version: "1" },
        };
        break;
      case "tools/list":
        result = { tools: [{
          name: "scout_models", description: "Scout contract fixture",
          inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
        }] };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: "Scout fixture result" }] };
        break;
      default:
        result = {};
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server: `http://127.0.0.1:${address.port}`, requests };
}

async function sdk(t: TestContext, root: string, factory: ExtensionFactory, options: {
  tools?: string[];
  excludeTools?: string[];
  mcpFirst?: boolean;
  withoutMcp?: boolean;
} = {}) {
  const notifications: string[] = [];
  const errors: string[] = [];
  let getServers: ExtensionAPI["getMcpServers"] | undefined;
  let renderedPrompt = "";
  const observer: ExtensionFactory = (pi) => {
    getServers = () => pi.getMcpServers();
    pi.on("before_agent_start", (event) => { renderedPrompt = event.systemPrompt; });
  };
  const mcp = createMcpExtension({
    loadConfig: () => ({ servers: [], errors: [] }),
    logPath: join(root, "mcp.log"),
    startupWaitMs: 3_000,
  });
  const factories = options.withoutMcp ? [factory] : options.mcpFirst ? [mcp, factory] : [factory, mcp];
  const settingsManager = SettingsManager.inMemory({ packages: [], cacheWarming: "off" });
  const agentDir = join(root, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [...factories, observer],
  });
  await resourceLoader.reload();
  // Pi's scripted provider emits real streamed assistant tool calls through
  // session.prompt(). It does not contact an inference endpoint or bypass the
  // native authorization/validation pipeline with fabricated tool contexts.
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "fixture-only");
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager,
    modelRuntime, model: faux.getModel(),
    sessionManager: SessionManager.inMemory(root),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({
    uiContext: { ...session.extensionRunner.getUIContext(), notify: (message) => { notifications.push(message); } },
    onError: (error) => { errors.push(error.error); },
  });
  assert.ok(getServers);
  return { session, faux, notifications, errors, getServers, getRenderedPrompt: () => renderedPrompt };
}

async function issueScoutCall(harness: Awaited<ReturnType<typeof sdk>>) {
  harness.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(toolName, { task: "contract test only" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Contract test done."),
  ]);
  await harness.session.prompt("Run the Scout transport contract fixture.");
  const result = [...harness.session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === toolName);
  assert.ok(result && result.role === "toolResult", "native Pi recorded the assistant-issued tool result");
  assert.equal(harness.faux.getPendingResponseCount(), 0);
  return result;
}

async function waitForTool(session: Awaited<ReturnType<typeof sdk>>["session"]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!session.getAllTools().some((tool) => tool.name === toolName) && Date.now() < deadline) await delay(10);
  assert.ok(session.getAllTools().some((tool) => tool.name === toolName), "native MCP discovered Scout within 5s");
}

for (const mcpFirst of [false, true]) {
  test(`native Pi discovers and calls Scout (MCP factory ${mcpFirst ? "first" : "last"})`, { timeout: 15_000 }, async (t) => {
    const root = await temporary(t);
    const fixture = await mcpFixture(t);
    const path = join(root, "credentials.json");
    await saveCredentials(path, fixture.server);
    const harness = await sdk(t, root, createScoutPiExtension({ credentialsPath: path }), { mcpFirst });
    const { session, getServers, notifications, errors, getRenderedPrompt } = harness;
    const hostModel = session.model;
    await waitForTool(session);
    assert.ok(session.getActiveToolNames().includes(toolName));
    assert.equal(getServers()[0]?.config.exposure, "direct");
    assert.equal(getServers()[0]?.name, "openmerit");
    assert.deepEqual(session.messages, [], "no unsolicited conversation messages at startup");
    const outcome = await issueScoutCall(harness);
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    assert.deepEqual(outcome.content, [{ type: "text", text: "Scout fixture result" }]);
    assert.partialDeepStrictEqual(fixture.requests.find((request) => request.method === "tools/call")?.params, {
      name: "scout_models", arguments: { task: "contract test only" },
    });
    assert.ok(fixture.requests.some((request) => request.method === "tools/list"));
    assert.ok(fixture.requests.every((request) => request.path === "/scout/mcp" && request.authorization === `Bearer ${key}`));

    // Deleting the file proves later turns don't reread local credentials.
    await rm(path);
    const count = fixture.requests.length;
    const transcript = JSON.stringify(session.messages);
    for (let turn = 0; turn < 2; turn++) {
      const prompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "hello" }, {
        cwd: root, customPrompt: "Host system prompt", selectedTools: ["read"],
        sections: { host_policy: "Host policy stays intact" },
      });
      assert.equal(prompt.systemPromptOptions.customPrompt, "Host system prompt");
      assert.equal(prompt.systemPromptOptions.sections.host_policy, "Host policy stays intact");
      assert.equal(prompt.systemPromptOptions.sections.openmerit_scout_rule, scoutRule("pi"));
      assert.equal(prompt.systemPromptOptions.sections.openmerit_scout_skill, scoutSkill("pi"));
      assert.deepEqual(prompt.systemPromptOptions.selectedTools, ["read"]);
      assert.deepEqual(prompt.messages, []);
      const rendered = getRenderedPrompt();
      assert.ok(rendered.includes("Host system prompt"));
      assert.ok(rendered.includes(scoutRule("pi")));
      assert.ok(!rendered.includes(key));
    }
    assert.equal(fixture.requests.length, count, "no per-turn network checks");
    assert.equal(session.model, hostModel, "host model unchanged");
    assert.equal(JSON.stringify(session.messages), transcript, "prompt hooks do not inject conversation messages");
    assert.ok(!transcript.includes(key));
    assert.deepEqual(notifications, []);
    assert.deepEqual(errors, []);
  });
}

for (const restrictions of [{ tools: [] }, { tools: ["read"] }, { excludeTools: ["mcp__openmerit__*"] }]) {
  test(`native host tool restrictions are preserved: ${JSON.stringify(restrictions)}`, { timeout: 15_000 }, async (t) => {
    const root = await temporary(t);
    const fixture = await mcpFixture(t);
    const path = join(root, "credentials.json");
    await saveCredentials(path, fixture.server);
    const harness = await sdk(t, root, createScoutPiExtension({ credentialsPath: path }), restrictions);
    const { session, errors } = harness;
    const result = await issueScoutCall(harness);
    assert.ok(!session.getActiveToolNames().includes(toolName));
    assert.equal(result.isError, true);
    assert.ok(!fixture.requests.some((request) => request.method === "tools/call"));
    assert.deepEqual(errors, []);
  });
}

for (const contents of [null, `{"key":"${key}",BROKEN`, JSON.stringify({ version: 1, key, server: "https://example.com" })]) {
  test(`missing/invalid credentials stay local and give sanitized recovery (${contents === null ? "missing" : contents.includes("BROKEN") ? "malformed" : "invalid key"})`, { timeout: 10_000 }, async (t) => {
    const root = await temporary(t);
    const path = join(root, "credentials.json");
    if (contents !== null) await writeFile(path, contents.replace(key, key.slice(0, -1)));
    const { session, getServers, notifications, errors, getRenderedPrompt } = await sdk(t, root, createScoutPiExtension({ credentialsPath: path }));
    assert.deepEqual(getServers(), []);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /install --client pi --scope user/);
    assert.ok(!notifications.join().includes(key.slice(0, -1)));
    assert.deepEqual(errors, []);
    const prompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "hello" }, { cwd: root });
    assert.equal(prompt.systemPromptOptions.sections.openmerit_scout_rule, scoutRule("pi"), "retain fail-closed guidance even while disconnected");
    assert.ok(!getRenderedPrompt().includes(key.slice(0, -1)));
  });
}

test("SDK hosts must supply Pi's native MCP extension", { timeout: 10_000 }, async (t) => {
  const root = await temporary(t);
  const path = join(root, "credentials.json");
  await saveCredentials(path, "http://127.0.0.1:1");
  const { session, errors } = await sdk(t, root, createScoutPiExtension({ credentialsPath: path }), { withoutMcp: true });
  assert.ok(!session.getActiveToolNames().includes(toolName));
  assert.ok(errors.some((error) => /MCP/i.test(error)));
  assert.ok(!errors.join().includes(key));
});

test("installed bundle resolves adjacent config at session startup; explicit options take precedence", { timeout: 15_000 }, async (t) => {
  const root = await temporary(t);
  const fixture = await mcpFixture(t);
  const path = join(root, "project-credentials.json");
  await saveCredentials(path, fixture.server);
  const bundle = join(root, "openmerit-scout.mjs");
  await build({ entryPoints: [new URL("../src/index.ts", import.meta.url).pathname], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const installed = await import(pathToFileURL(bundle).href) as { default: ExtensionFactory; createScoutPiExtension: typeof createScoutPiExtension };
  // Config is created AFTER module evaluation and need not be near cwd.
  const config = join(root, "openmerit-scout.json");
  await writeFile(config, JSON.stringify({ credentialsPath: path }));
  const valid = await sdk(t, root, installed.default);
  await waitForTool(valid.session);
  assert.deepEqual(valid.notifications, []);
  assert.equal(valid.getServers()[0]?.config.exposure, "direct");

  await writeFile(config, `{"credentialsPath": "${key}",BROKEN`);
  const invalid = await sdk(t, root, installed.default);
  assert.deepEqual(invalid.getServers(), []);
  assert.equal(invalid.notifications.length, 1);
  assert.ok(!invalid.notifications.join().includes(key));
  const explicit = await sdk(t, root, installed.createScoutPiExtension({ credentialsPath: path }));
  await waitForTool(explicit.session);
  assert.deepEqual(explicit.notifications, []);
});

test("default extension uses shared Pi user credentials when adjacent config is absent", { timeout: 15_000 }, async (t) => {
  const root = await temporary(t);
  const fixture = await mcpFixture(t);
  const previous = process.env.OPENMERIT_CONFIG_DIR;
  process.env.OPENMERIT_CONFIG_DIR = join(root, "config");
  t.after(() => { if (previous === undefined) delete process.env.OPENMERIT_CONFIG_DIR; else process.env.OPENMERIT_CONFIG_DIR = previous; });
  const path = credentialsPath("pi", "user", process.cwd());
  await mkdir(join(path, ".."), { recursive: true });
  await saveCredentials(path, fixture.server);
  const { session, notifications } = await sdk(t, root, scoutExtension);
  await waitForTool(session);
  assert.deepEqual(notifications, []);
});
