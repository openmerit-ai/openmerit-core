import assert from "node:assert/strict";
import test from "node:test";
import worker, { type AppWorkerEnv } from "../worker.ts";

const seen: string[] = [];
const assets: AppWorkerEnv["ASSETS"] = { fetch: async (request) => {
  seen.push(new URL(request.url).pathname);
  return new Response(`asset ${new URL(request.url).pathname}`, { headers: { "Content-Type": "text/html" } });
} };
const key = `pk_live_${btoa("clerk.openmerit.ai$")}`;
const env: AppWorkerEnv = { ASSETS: assets, CLERK_PUBLISHABLE_KEY: key, API_ORIGIN: "https://openmerit.ai/" };
const get = (path: string, config: AppWorkerEnv = env) => worker.fetch(new Request(`https://app.openmerit.ai${path}`), config);

test("config.json names the Clerk instance and the cloud app, and fails closed when either is missing", async () => {
  const response = await get("/config.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { publishableKey: key, frontendApi: "clerk.openmerit.ai", apiOrigin: "https://openmerit.ai" });
  for (const broken of [{ ASSETS: assets, API_ORIGIN: "https://openmerit.ai" }, { ...env, CLERK_PUBLISHABLE_KEY: "pk_live_bm90IGEgaG9zdA==" }, { ...env, CLERK_PUBLISHABLE_KEY: "sk_live_secret" }, { ...env, API_ORIGIN: "" }, { ...env, API_ORIGIN: "openmerit.ai" }]) {
    const result = await get("/config.json", broken);
    assert.equal(result.status, 503, JSON.stringify(broken.CLERK_PUBLISHABLE_KEY ?? null) + broken.API_ORIGIN);
    assert.doesNotMatch(await result.text(), /sk_live|pk_live/);
  }
});

test("every run report is served by the one report page, at an address with a trailing slash", async () => {
  seen.length = 0;
  const report = await get("/r/k7m2q9/?ref=pr");
  assert.equal(await report.text(), "asset /r/");
  const bare = await get("/r/k7m2q9?ref=pr");
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "https://app.openmerit.ai/r/k7m2q9/?ref=pr");
  assert.equal((await get("/r/")).headers.get("location"), "https://app.openmerit.ai/");
  // Anything that is not a plain run ID goes to the assets as it is, which return their 404 page.
  for (const path of ["/r/k7m2q9/extra", "/r/a.b/", "/r/k7m2q9.md", "/tasks/"]) {
    seen.length = 0;
    await get(path);
    assert.deepEqual(seen, [path]);
  }
});

test("pages cannot be framed by another site", async () => {
  for (const path of ["/", "/data/", "/r/k7m2q9/", "/config.json"]) {
    const response = await get(path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  }
});
