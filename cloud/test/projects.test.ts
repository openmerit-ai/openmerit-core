// Projects and members' own subscriptions end to end. Projects split an organization's tasks, runs,
// endpoints, repositories and guardrails; a member signs in to ChatGPT once, for every organization,
// and that subscription writes the cases of the runs they start. A local fake stands in for OpenAI's
// sign-in and for the Codex Responses API.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { bundle, caller, fakeModels, startApp, stop, subscribe, waitFor, WRITTEN, type App, type FakeModels } from "./helpers.ts";

type Data = Record<string, unknown>;
interface Project { id: string; name: string; tasks: number; endpoints: number; repos: string[] }
interface Subscriptions { writer: string; subscriptions: { provider: string; connected: boolean; problem: string | null; signIn: { url: string | null; userCode: string | null } | null }[] }

/** The member's case writer on Codex, which the fake answers with these cases. */
const CODEX_CASES: Record<string, string> = { "Refund the duplicate charge on my card": "billing", "Two-factor codes never arrive": "account" };

interface FakeProviders {
  url: string;
  /** Token requests, by grant, with what they sent. */
  tokens: { provider: string; grant: string; body: Record<string, string>; issued?: string }[];
  /** Codex Responses API calls: the bearer token. */
  messages: { auth: string }[];
  /** Set once the member entered the ChatGPT device code. */
  entered: boolean;
  close: () => Promise<void>;
}

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

async function fakeProviders(): Promise<FakeProviders> {
  const fake: FakeProviders = { url: "", tokens: [], messages: [], entered: false, close: async () => {} };
  let accessCount = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      // Codex's request body is zstd-compressed JSON; the fake only reads its bearer token.
      const body = req.url?.startsWith("/codex/") ? {} : (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw || "{}") as Record<string, string> : Object.fromEntries(new URLSearchParams(raw));
      if (req.url === "/openai/api/accounts/deviceauth/usercode") return send(200, { device_auth_id: "dev_1", user_code: "WXYZ-1234", interval: "1" });
      if (req.url === "/openai/api/accounts/deviceauth/token") return fake.entered ? send(200, { authorization_code: "oa-code", code_verifier: "oa-verifier" }) : send(403, { error: { code: "deviceauth_authorization_pending" } });
      if (req.url === "/openai/oauth/token") {
        fake.tokens.push({ provider: "chatgpt", grant: body.grant_type ?? "", body });
        // The first access token expires within the renewal window, so the first job renews it.
        accessCount++;
        const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" }, n: accessCount });
        fake.tokens.at(-1)!.issued = access;
        return send(200, { access_token: access, refresh_token: "oa-rt", expires_in: body.grant_type === "authorization_code" ? 60 : 3600 });
      }
      if (req.url === "/codex/responses" && req.method === "POST") {
        fake.messages.push({ auth: String(req.headers.authorization ?? "") });
        const text = JSON.stringify({ cases: Object.entries(CODEX_CASES).map(([ticket, queue]) => ({ input: { ticket }, expected: queue })) });
        const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        event({ type: "response.created", response: { id: "resp_1", status: "in_progress" } });
        event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
        event({ type: "response.output_item.done", output_index: 0, item });
        event({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 40, total_tokens: 50 } } });
        return res.end();
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

describe("projects and members' subscriptions", () => {
  let models: FakeModels, providers: FakeProviders, app: App;
  before(async () => {
    models = await fakeModels();
    providers = await fakeProviders();
    app = await startApp({ models, env: {
      OPENMERIT_OPENAI_AUTH_URL: `${providers.url}/openai`, OPENMERIT_CODEX_API_URL: `${providers.url}/codex`,
    } });
  });
  after(async () => { await stop(app); await models.close(); await providers.close(); });

  test("a project keeps its own endpoints, guardrails and tasks; the default project holds the rest and cannot be deleted", async () => {
    const admin = caller(app, "test:user_p:org_projects:admin");
    const member = caller(app, "test:user_m:org_projects");
    assert.deepEqual((await admin.api<Project[]>("/api/projects")).body.map(item => [item.id, item.name]), [["default", "Default project"]]);
    assert.equal((await member.api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Claims" }) })).status, 403);
    const claims = (await admin.api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Claims" }) })).body;
    assert.equal((await admin.api("/api/projects", { method: "POST", body: JSON.stringify({ name: " claims " }) })).status, 400, "names are unique, ignoring case");
    const inClaims = { "x-openmerit-project": claims.id };

    const endpoint = { kind: "openai-compatible", baseUrl: "https://api.fireworks.test/v1", apiKey: "sk-project-key-1234", allowedModels: ["acme/fine-tune-1"] };
    const added = await admin.api<{ id: string }>("/api/endpoints", { method: "POST", headers: inClaims, body: JSON.stringify(endpoint) });
    assert.equal(added.status, 201);
    assert.deepEqual((await admin.api("/api/endpoints")).body, [], "the default project has none");
    assert.equal((await admin.api(`/api/endpoints/${added.body.id}`, { method: "DELETE" })).status, 404, "another project cannot remove it");
    assert.equal((await admin.api<unknown[]>("/api/endpoints", { headers: inClaims })).body.length, 1);

    // The same environment's guardrails differ by project.
    await admin.api("/api/guardrails", { method: "PUT", headers: inClaims, body: JSON.stringify({ level: "environment", id: "acme/app", settings: { budgetUsd: 2 } }) });
    assert.deepEqual((await admin.api<{ effective: Data }>("/api/guardrails?level=environment&id=acme/app", { headers: inClaims })).body.effective, { budgetUsd: 2 });
    assert.deepEqual((await admin.api<{ effective: Data }>("/api/guardrails?level=environment&id=acme/app")).body.effective, {});

    // A coding agent names the project; the task lands there and the default project does not list it.
    await subscribe(app, "org_projects");
    const unknown = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app", project: "Nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Its projects: Default project, Claims/);
    const started = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app", project: "claims" });
    assert.equal(started.isError, false, started.text);
    assert.equal((await admin.api<unknown[]>("/api/tasks", { headers: inClaims })).body.length, 1);
    assert.deepEqual((await admin.api("/api/tasks")).body, []);
    // The same task name in the default project is another task.
    const elsewhere = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/app" });
    assert.equal(elsewhere.isError, false, elsewhere.text);
    const [inDefault] = (await admin.api<{ id: string }[]>("/api/tasks")).body;
    const [inProject] = (await admin.api<{ id: string }[]>("/api/tasks", { headers: inClaims })).body;
    assert.notEqual(inDefault!.id, inProject!.id);
    assert.match((await admin.tool("openmerit_tasks", {})).text, /project Claims, acme\/app/);

    const busy = await admin.api<{ error: string }>(`/api/projects/${claims.id}`, { method: "DELETE" });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /has 1 task/);
    assert.equal((await admin.api("/api/projects/default", { method: "DELETE" })).status, 409);
    const renamed = await admin.api<Project>("/api/projects/default", { method: "PUT", body: JSON.stringify({ name: "Main" }) });
    assert.equal(renamed.body.name, "Main");
    const empty = (await admin.api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Scratch" }) })).body;
    assert.equal((await admin.api(`/api/projects/${empty.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await admin.api("/api/tasks", { headers: { "x-openmerit-project": empty.id } })).status, 404);
  });

  test("a member signs in to ChatGPT once for every organization, there is no Claude sign-in, and no token is ever returned", async () => {
    const me = caller(app, "test:user_sub:org_a:admin");
    assert.deepEqual((await me.api<Subscriptions>("/api/me/subscriptions")).body.subscriptions.map(item => item.provider), ["chatgpt"]);
    assert.equal((await me.api("/api/me/subscriptions/claude", { method: "POST" })).status, 404, "the hosted app offers no Claude sign-in");
    assert.equal((await me.api("/api/me/case-writer", { method: "PUT", body: JSON.stringify({ writer: "claude" }) })).status, 400);

    const device = await me.api<Subscriptions>("/api/me/subscriptions/chatgpt", { method: "POST" });
    assert.equal(device.body.subscriptions.find(item => item.provider === "chatgpt")!.signIn!.userCode, "WXYZ-1234");
    assert.equal((await me.api<{ status: string }>("/api/me/subscriptions/chatgpt/poll", { method: "POST" })).body.status, "pending");
    providers.entered = true;
    assert.equal((await me.api<{ status: string }>("/api/me/subscriptions/chatgpt/poll", { method: "POST" })).body.status, "connected");

    // The same user in another organization sees it; another user does not.
    const elsewhere = await caller(app, "test:user_sub:org_b").api<Subscriptions>("/api/me/subscriptions");
    assert.deepEqual(elsewhere.body.subscriptions.map(item => [item.provider, item.connected]), [["chatgpt", true]]);
    assert.deepEqual((await caller(app, "test:user_other:org_a").api<Subscriptions>("/api/me/subscriptions")).body.subscriptions.map(item => item.connected), [false]);
    for (const text of [JSON.stringify(elsewhere.body), await (await me.fetch("/api/account/export", { method: "POST" })).text()]) {
      assert.ok(!/oa-rt|e30\./.test(text), "no token leaves the user actor");
    }

    assert.equal((await me.api<Subscriptions>("/api/me/subscriptions/chatgpt", { method: "DELETE" })).body.subscriptions[0]!.connected, false);
    assert.equal((await me.api("/api/me/case-writer", { method: "PUT", body: JSON.stringify({ writer: "chatgpt" }) })).status, 409, "only a connected subscription can write cases");
  });

  test("a run's cases are written on the subscription of the member who started it, which renews its sign-in first", async () => {
    const me = caller(app, "test:user_w:org_writer:admin");
    providers.entered = true;
    await me.api("/api/me/subscriptions/chatgpt", { method: "POST" });
    assert.equal((await me.api<{ status: string }>("/api/me/subscriptions/chatgpt/poll", { method: "POST" })).body.status, "connected");
    assert.equal((await me.api<Subscriptions>("/api/me/case-writer", { method: "PUT", body: JSON.stringify({ writer: "chatgpt" }) })).body.writer, "chatgpt");
    await subscribe(app, "org_writer");

    const writerCallsBefore = models.calls.filter(call => call.ticket.startsWith("writer:")).length;
    const started = await me.tool("openmerit_recommend", { bundle: bundle("writer on chatgpt"), environment: "acme/app" });
    assert.equal(started.isError, false, started.text);
    const asking = await waitFor(() => me.tool("openmerit_result", { job_id: started.data.job_id }), value => value.data.status === "needs_input");
    const check = (asking.data.questions as { id: string; options: { label: string }[] }[]).find(question => question.id === "label_check");
    assert.ok(check, `the label check asks about written cases: ${asking.text}`);
    assert.deepEqual(check.options.map(option => option.label.split(" → ")[0]), Object.keys(CODEX_CASES), "the cases are ChatGPT's");
    assert.ok(!check.options.some(option => Object.keys(WRITTEN).some(ticket => option.label.includes(ticket))), "OpenMerit's writer wrote none");
    assert.equal(models.calls.filter(call => call.ticket.startsWith("writer:")).length, writerCallsBefore, "no case writer call went to OpenRouter");
    const renewed = providers.tokens.filter(item => item.provider === "chatgpt" && item.grant === "refresh_token");
    assert.equal(renewed.length, 1, "the access token about to expire was renewed once");
    assert.ok(providers.messages.length > 0 && providers.messages.every(item => item.auth === `Bearer ${renewed[0]!.issued}`), "Codex was called with the renewed token");
    assert.ok((asking.data.notices as string[]).some(notice => /^ChatGPT \(gpt-5\.6-terra\) wrote the cases/.test(notice)));
  });
});
