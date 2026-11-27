// `openmerit login` against a hosted server: a local fake of the server's /mcp and /api/me and of its
// OAuth authorization server (registration, authorize, token), so the test checks the real flow
// (client registration, PKCE, the loopback redirect, refresh) with no Clerk.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { callTool, call, connection, login, logout } from "../src/client.ts";

interface Fake { url: string; server: Server; registered: number; valid: Set<string>; issued: number; pending: Map<string, { challenge: string; redirect: string }> }

async function fakeHosted(): Promise<Fake> {
  const fake: Fake = { url: "", server: createServer(), registered: 0, valid: new Set(), issued: 0, pending: new Map() };
  fake.server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", fake.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (url.pathname === "/.well-known/oauth-protected-resource") return json(200, { resource: `${fake.url}/mcp`, authorization_servers: [fake.url] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { authorization_endpoint: `${fake.url}/authorize`, token_endpoint: `${fake.url}/token`, registration_endpoint: `${fake.url}/register` });
    if (url.pathname === "/register") {
      fake.registered++;
      const body = JSON.parse(text) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      assert.deepEqual([body.redirect_uris, body.token_endpoint_auth_method], [["http://127.0.0.1/callback"], "none"]);
      return json(201, { client_id: "cli-1" });
    }
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri")!;
      assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      assert.equal(url.searchParams.get("resource"), `${fake.url}/mcp`);
      const code = `code-${fake.pending.size + 1}`;
      fake.pending.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${url.searchParams.get("state")}` }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(text);
      const issue = () => { const token = `at-${++fake.issued}`; fake.valid.add(token); return json(200, { access_token: token, refresh_token: `rt-${fake.issued}`, expires_in: 3600 }); };
      if (form.get("grant_type") === "refresh_token") return form.get("client_id") === "cli-1" && form.get("refresh_token")?.startsWith("rt-") ? issue() : json(400, { error: "invalid_grant" });
      const pending = fake.pending.get(form.get("code") ?? "");
      const verified = pending && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === pending.challenge && form.get("redirect_uri") === pending.redirect;
      return verified ? issue() : json(400, { error: "invalid_grant", error_description: "PKCE or redirect mismatch" });
    }
    if (!bearer || !fake.valid.has(bearer)) return json(401, { error: "Sign in to OpenMerit: this request has no access token." });
    if (url.pathname === "/api/me") return json(200, { mode: "hosted", user: { id: "user_1" }, account: { id: "org_1", name: "Acme" }, role: "admin", plan: { name: null, status: "none" } });
    if (url.pathname === "/mcp") {
      const rpc = JSON.parse(text) as { id: number; params: { name: string; arguments: unknown } };
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `called ${rpc.params.name}` }], structuredContent: { name: rpc.params.name, args: rpc.params.arguments, token: bearer } } });
    }
    json(404, { error: "Not found" });
  });
  await new Promise<void>(resolve => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

/** The browser: follows the authorization server's redirect to wherever it points. */
const browser = (deliver: (address: string) => void) => (url: string) => {
  void fetch(url, { redirect: "manual" }).then(response => deliver(response.headers.get("location")!));
};

test("openmerit login signs in to a hosted server with PKCE on a loopback port, registers once, takes a pasted address and refreshes its token", async () => {
  const fake = await fakeHosted();
  const env = { OPENMERIT_HOME: mkdtempSync(join(tmpdir(), "openmerit-login-")) };
  const log = () => {};
  try {
    assert.equal(connection(env), null, "no server before a login");
    // The browser on this machine reaches the CLI's loopback port.
    const first = await login({ server: fake.url, log, input: null, open: browser(address => { void fetch(address); }) }, env);
    assert.equal(first.mode, "hosted");
    assert.equal(statSync(join(env.OPENMERIT_HOME, "login.json")).mode & 0o777, 0o600, "the tokens are the owner's only");
    const conn = connection(env)!;
    assert.equal((await call<{ account: { name: string } }>(conn, "/api/me")).body.account.name, "Acme");
    const answer = await callTool(conn, "openmerit_tasks", {});
    assert.deepEqual([answer.text, answer.data.token], ["called openmerit_tasks", "at-1"]);

    // A browser on another machine: the user pastes the address it ended on. The client is not registered again.
    const pasted = new PassThrough();
    await login({ server: fake.url, log, input: pasted, open: browser(address => pasted.write(`${address}\n`)) }, env);
    assert.equal(fake.registered, 1, "one registration serves every login");
    // An address from another sign-in is refused.
    const wrong = new PassThrough();
    await assert.rejects(login({ server: fake.url, log, input: wrong, open: browser(address => wrong.write(`${address.replace(/state=[^&]+/, "state=other")}\n`)) }, env), /not from this sign-in/);

    // The access token stops working: the next call refreshes it once, and saves the new one.
    fake.valid.clear();
    const refreshed = await callTool(connection(env)!, "openmerit_result", { job_id: "job_1" });
    assert.deepEqual(refreshed.data, { name: "openmerit_result", args: { job_id: "job_1" }, token: "at-3" });
    assert.equal((JSON.parse(readFileSync(join(env.OPENMERIT_HOME, "login.json"), "utf8")) as { login: { oauth: { accessToken: string } } }).login.oauth.accessToken, "at-3");

    assert.equal(logout(env)?.server, fake.url);
    assert.equal(connection(env), null);
  } finally { fake.server.close(); }
});
