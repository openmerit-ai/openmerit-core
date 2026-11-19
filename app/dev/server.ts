// Local preview of app.openmerit.ai: `npm run app`. Builds dist/app and serves it
// through app/worker.ts, with app/dev/fake-api.ts as the cloud app's /api/* and
// app/dev/fake-clerk.ts in place of ClerkJS. No Clerk, Stripe or cloud calls.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { build } from "esbuild";
import worker from "../worker.ts";
import { createFakeApi } from "./fake-api.ts";

const root = resolve(import.meta.dirname, "..", "..");
const dist = join(root, "dist", "app");
const port = Number(process.env.APP_PREVIEW_PORT || 45835);
const built = spawnSync(process.execPath, ["scripts/build-app.ts"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
const fakeClerk = (await build({ absWorkingDir: root, entryPoints: ["app/dev/fake-clerk.ts"], bundle: true, write: false, format: "iife", target: "es2022" })).outputFiles[0]?.text ?? "";
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

// Static assets with the Worker configuration's auto-trailing-slash and 404-page handling.
const assets = { async fetch(request: Request): Promise<Response> {
  const path = decodeURIComponent(new URL(request.url).pathname);
  const file = join(dist, path);
  const send = (name: string, status = 200) => new Response(readFileSync(name), { status, headers: { "Content-Type": types[extname(name)] ?? "application/octet-stream" } });
  if (!file.startsWith(dist)) return send(join(dist, "404.html"), 404);
  if (path.endsWith("/") && existsSync(join(file, "index.html"))) return send(join(file, "index.html"));
  if (!path.endsWith("/") && existsSync(file) && statSync(file).isFile()) return send(file);
  if (!path.endsWith("/") && existsSync(join(file, "index.html"))) return Response.redirect(new URL(`${path}/`, request.url), 307);
  return send(join(dist, "404.html"), 404);
} };

const preview = createServer(async (incoming, outgoing) => {
  // Behind an https proxy, such as an Amp orb portal, keep the page and the fake API on one scheme.
  const scheme = incoming.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const origin = `${scheme}://${incoming.headers.host ?? `localhost:${port}`}`;
  const method = incoming.method ?? "GET";
  const request = new Request(new URL(incoming.url ?? "/", origin), {
    method, headers: Object.entries(incoming.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : [])),
    ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" }),
  });
  const path = new URL(request.url).pathname;
  let response: Response;
  if (path.startsWith("/api/")) response = await api(request);
  else if (path === "/__preview-stripe") response = new Response(`<!DOCTYPE html><meta charset="utf-8"><title>Preview Stripe</title><body style="font:16px system-ui;padding:40px"><h1>Stripe ${new URL(request.url).search.slice(1)} (preview)</h1><p>The real app opens Stripe here.</p><p><a href="/plan/">Back to Plan and usage</a></p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  else {
    // PostHog: only the environment's token (the orb's is the Internal project), never wrangler.app.jsonc's production one.
    const { POSTHOG_PROJECT_TOKEN, POSTHOG_HOST } = process.env;
    if (path === "/ingest/e/") {
      const event = await request.clone().json().then((body: { event?: string; properties?: { $pathname?: string } }) => `${body.event} ${body.properties?.$pathname ?? ""}`, () => "unreadable");
      console.log(`${method} /ingest/e/ ${event} → ${POSTHOG_PROJECT_TOKEN ? `forwarded to ${POSTHOG_HOST || "PostHog"}` : "dropped (no POSTHOG_PROJECT_TOKEN)"}`);
    }
    response = await worker.fetch(request, {
      ASSETS: assets, API_ORIGIN: origin, CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("preview.clerk.invalid$")}`,
      ...(POSTHOG_PROJECT_TOKEN ? { POSTHOG_PROJECT_TOKEN } : {}), ...(POSTHOG_HOST ? { POSTHOG_HOST } : {}),
    }, { waitUntil: () => {} });
    if (response.headers.get("content-type")?.startsWith("text/html")) {
      const page = (await response.text()).replace("<head>", `<head>\n  <script>${fakeClerk}</script>`);
      response = new Response(page, { status: response.status, headers: response.headers });
    }
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
const api = createFakeApi();
preview.listen(port, () => console.log(`app.openmerit.ai preview on http://localhost:${port}/ (fake API and sign-in; ?preview=tonic|populated|empty|noplan|member|error|slow|expired|signed-out)`));
