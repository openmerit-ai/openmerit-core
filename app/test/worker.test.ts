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
  // Stripe Checkout and the portal return to the cloud app's configured /billing.
  assert.equal((await get("/billing?checkout=done")).headers.get("location"), "https://app.openmerit.ai/plan/?checkout=done");
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

test("/ingest/e/ forwards one capture to PostHog with the project token, and answers 204 whatever PostHog says", async (t) => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let upstream = 200;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (upstream === 0) throw new Error("offline");
    return new Response(null, { status: upstream });
  });
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); } };
  const posthog: AppWorkerEnv = { ...env, POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://posthog.test/" };
  const capture = { event: "$pageview", distinct_id: "user_1", properties: { interface: "app", $pathname: "/r/:id/" }, api_key: "phc_from_the_browser" };
  const post = (path: string, body: string, config = posthog, method = "POST") =>
    worker.fetch(new Request(`https://app.openmerit.ai${path}`, { method, ...(method === "GET" ? {} : { body }) }), config, ctx);

  for (const status of [200, 500, 0]) {
    upstream = status;
    const response = await post("/ingest/e/", JSON.stringify(capture));
    assert.equal(response.status, 204);
  }
  await Promise.all(waited);
  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.url, "https://posthog.test/i/v0/e/");
  // The browser's IP goes along, so PostHog does not place every user at Cloudflare.
  await worker.fetch(new Request("https://app.openmerit.ai/ingest/e/", { method: "POST", body: JSON.stringify(capture), headers: { "cf-connecting-ip": "203.0.113.7" } }), posthog, ctx);
  await Promise.all(waited);
  assert.equal((sent.pop()?.body.properties as Record<string, unknown>).$ip, "203.0.113.7");
  assert.deepEqual(sent[0]?.body, { ...capture, api_key: "phc_test" });

  // Only POST /ingest/e/, under the size cap, with one JSON object, reaches PostHog.
  sent.length = 0;
  assert.equal((await post("/ingest/e/", "", posthog, "GET")).status, 405);
  assert.equal((await post("/ingest/e/", JSON.stringify(capture), posthog, "PUT")).status, 405);
  assert.equal((await post("/ingest/e/", JSON.stringify({ ...capture, padding: "x".repeat(33 * 1024) }))).status, 413);
  assert.equal((await post("/ingest/e/", "not json")).status, 400);
  assert.equal((await post("/ingest/e/", "[1]")).status, 400);
  for (const path of ["/ingest/e", "/ingest/batch/", "/ingest/i/v0/e/", "/ingest/decide/"]) await post(path, JSON.stringify(capture));
  // Without a token the proxy accepts the event and sends nothing.
  assert.equal((await post("/ingest/e/", JSON.stringify(capture), env)).status, 204);
  await Promise.all(waited);
  assert.deepEqual(sent, []);
});
