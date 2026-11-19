import assert from "node:assert/strict";
import test from "node:test";
import { normalisePath, trackPageview } from "../analytics.ts";

test("paths keep the view and drop the run ID", () => {
  assert.equal(normalisePath("/"), "/");
  assert.equal(normalisePath("/tasks/"), "/tasks/");
  assert.equal(normalisePath("/r/k7m2q9/"), "/r/:id/");
  assert.equal(normalisePath("/r/k7m2q9"), "/r/:id");
  assert.equal(normalisePath("/r/"), "/r/");
});

test("a signed-in view sends $identify once per page load and a $pageview each time, without the query string", (t) => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const set = (name: string, value: unknown) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  };
  set("location", new URL("https://app.openmerit.ai/r/k7m2q9/?ref=pr&token=secret"));
  set("document", { referrer: "https://github.com/org/repo/pull/1?x=y" });
  set("screen", { width: 1440, height: 900 });
  set("navigator", { sendBeacon: (url: string, blob: Blob) => { void blob.text().then((text) => sent.push({ url, body: JSON.parse(text) as Record<string, unknown> })); return true; } });

  return (async () => {
    trackPageview(undefined);
    trackPageview("not-a-clerk-id");
    trackPageview("user_1");
    trackPageview("user_1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map(({ url, body }) => `${url} ${String(body.event)} ${String(body.distinct_id)}`), [
      "/ingest/e/ $identify user_1", "/ingest/e/ $pageview user_1", "/ingest/e/ $pageview user_1",
    ]);
    const view = sent[1]?.body ?? {};
    assert.equal(typeof view.uuid, "string");
    assert.ok(!Number.isNaN(Date.parse(String(view.timestamp))));
    assert.equal(view.api_key, undefined);
    assert.deepEqual(view.properties, {
      interface: "app", $current_url: "https://app.openmerit.ai/r/:id/", $pathname: "/r/:id/", $host: "app.openmerit.ai",
      $referrer: "https://github.com", $screen_width: 1440, $screen_height: 900,
    });
  })();
});
