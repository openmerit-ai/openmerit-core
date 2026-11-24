// The real ClerkAuth on /api, without the network: session tokens signed with a local key that
// verifyToken checks through `jwtKey`, as Clerk's networkless verification does. And the handler's
// internal errors on /api, which the web app can only read with CORS headers.
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createHandler } from "../src/app.ts";
import { ClerkAuth, type Auth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import type { AppClient } from "../src/registry.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP = "https://app.openmerit.test";

/** A Clerk session token (v2 claims), signed RS256 with the local key. */
function sessionToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", typ: "JWT", kid: "ins_test" })}.${part({
    sub: "user_1", sid: "sess_1", azp: APP, iss: "https://clerk.openmerit.test", iat: now - 5, nbf: now - 5, exp: now + 60, v: 2, fva: [3, -1],
    o: { id: "org_1", rol: "admin", slg: "acme" }, ...claims,
  })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
}

const auth = new ClerkAuth({
  secretKey: "sk_test_unused", publishableKey: "pk_test_unused", issuer: "https://clerk.openmerit.test", audience: "https://openmerit.test/mcp",
  authorizedParties: [APP], jwtKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const call = (token: string) => auth.api(new Request("https://openmerit.test/api/me", { headers: { authorization: `Bearer ${token}` } }));

test("ClerkAuth maps a valid session token to its user, organization and role, and refuses an expired one or another azp", async () => {
  const valid = await call(sessionToken({}));
  assert.deepEqual(valid.ok && { ...valid.identity, issuedAt: null }, { userId: "user_1", accountId: "org_1", accountName: "acme", role: "admin", issuedAt: null, firstFactorAgeMinutes: 3 });
  const member = await call(sessionToken({ o: { id: "org_2", rol: "member" } }));
  assert.deepEqual(member.ok && [member.identity.accountId, member.identity.role], ["org_2", "member"]);

  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ iat: now - 600, nbf: now - 600, exp: now - 300 }, { azp: "https://evil.test" }]) {
    assert.deepEqual(await call(sessionToken(claims)), { ok: false, status: 401, error: "The session token was refused." });
  }
  const forged = sessionToken({}).replace(/\.[^.]+$/, `.${Buffer.from("not a signature").toString("base64url")}`);
  assert.equal((await call(forged)).ok, false);
});

test("an internal error on /api carries the web app's CORS headers", async () => {
  const failing: Auth = { mcp: () => Promise.reject(new Error("boom")), api: () => Promise.reject(new Error("boom")), email: async () => null, person: async () => null, githubToken: async () => null };
  const config = loadConfig({ OPENMERIT_APP_URL: APP });
  const handler = createHandler({ client: {} as unknown as AppClient, auth: failing, billing: null, config });
  const response = await handler(new Request("https://openmerit.test/api/me", { headers: { origin: APP, authorization: "Bearer x" } }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("access-control-allow-origin"), APP);
  assert.deepEqual(await response.json(), { error: "OpenMerit hit an internal error. Try again." });
});
