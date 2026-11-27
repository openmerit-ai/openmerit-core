// The app's HTTP surface and its startup. openmerit.ai's domain router proxies /mcp, the OAuth
// protected-resource metadata and /api/* here.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "rivetkit/client";
import { apiRoutes, cors } from "./api.ts";
import { LocalAuth, SESSION_COOKIE, type Auth } from "./auth.ts";
import { planUpdate, type Billing } from "./billing.ts";
import type { Config } from "./config.ts";
import { handleMcp } from "./mcp.ts";
import { createRegistry, type AppClient, type Registry } from "./registry.ts";
import { bundledCatalogue, setServices, type Services } from "./services.ts";

export interface AppDeps { client: AppClient; auth: Auth | null; billing: Billing | null; config: Config }
export type Handler = (request: Request) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** RFC 9728 metadata: the resource is /mcp, and Clerk is its authorization server. */
export function protectedResource(config: Config) {
  return {
    resource: config.clerk?.audience ?? `${config.publicUrl}/mcp`,
    authorization_servers: config.clerk ? [config.clerk.issuer] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "user:org:read", "offline_access"],
    resource_name: "OpenMerit",
    resource_documentation: `${config.publicUrl}/`,
  };
}

async function stripeWebhook(request: Request, deps: AppDeps): Promise<Response> {
  if (!deps.billing) return json(503, { error: "Billing is not configured on this server." });
  const payload = await request.text();
  let event;
  try { event = deps.billing.verifyWebhook(payload, request.headers.get("stripe-signature")); }
  catch (error) { return json(400, { error: error instanceof Error ? error.message : "Invalid signature" }); }
  const update = planUpdate(event);
  if (!update) return json(200, { received: true, ignored: event.type });
  const applied = await deps.client.account.getOrCreate([update.accountId]).applyStripe(update);
  return json(200, { received: true, applied: applied.applied });
}

// The commit this image was built from: cloud/scripts/deploy.ts writes src/build.json before it builds
// the image, and checks that /health reports it, so a deploy proves the new build is the one serving.
const builtFrom = ((): string | null => {
  try { return (JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")) as { commit?: string }).commit ?? null; } catch { return null; }
})();

/**
 * The web app a self-hosted server serves: the openmerit package's dist/web, which its build writes from
 * app/, or OPENMERIT_WEB_DIR. Run from source, the server looks in the package's dist/web after a build.
 */
const webDir = ((): string | null => {
  const found = [process.env.OPENMERIT_WEB_DIR, fileURLToPath(new URL("../web/", import.meta.url)), fileURLToPath(new URL("../../dist/web/", import.meta.url))]
    .find((dir): dir is string => !!dir && existsSync(join(dir, "index.html")));
  return found ?? null;
})();
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const PAGE_HEADERS = { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };

/** A file of the web app, as app.openmerit.ai's Worker serves it: a directory's index.html, every run report on /r/'s page. */
function webFile(path: string): Response | null {
  if (!webDir) return null;
  if (/^\/r\/[\w-]{1,64}\/?$/.test(path)) path = "/r/";
  const file = normalize(join(webDir, decodeURIComponent(path)));
  if (!file.startsWith(webDir)) return null;
  const target = existsSync(file) && statSync(file).isDirectory() ? join(file, "index.html") : file;
  if (!existsSync(target) || !statSync(target).isFile()) return new Response(readFileSync(join(webDir, "404.html")), { status: 404, headers: { "content-type": TYPES[".html"]!, ...PAGE_HEADERS } });
  return new Response(readFileSync(target), { headers: { "content-type": TYPES[extname(target)] ?? "application/octet-stream", "cache-control": "no-cache", ...PAGE_HEADERS } });
}

/**
 * A self-hosted server's sign-in for its web app: `openmerit server link` asks for a one-time link with the
 * server's token, and opening it sets the browser session cookie. Only that session confirms requests.
 */
async function localSession(request: Request, url: URL, auth: LocalAuth): Promise<Response | null> {
  if (url.pathname === "/api/session/link" && request.method === "POST") {
    const caller = await auth.mcp(request);
    if (!caller.ok) return json(caller.status, { error: caller.error });
    return json(200, { url: `${url.origin}/signin?code=${auth.link()}` });
  }
  if (url.pathname === "/signin" && request.method === "GET") {
    const opened = auth.signIn(url.searchParams.get("code") ?? "");
    if (!opened) return new Response("This sign-in link was used or expired. Run `openmerit server link` for a new one.\n", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${SESSION_COOKIE}=${opened.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opened.maxAgeSeconds}` } });
  }
  if (url.pathname === "/api/session/signout" && request.method === "POST") {
    if (request.headers.get("origin") !== url.origin) return json(403, { error: "Sign out from this server's own pages." });
    auth.signOut(request);
    return new Response(null, { status: 204, headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
  }
  return null;
}

export function createHandler(deps: AppDeps): Handler {
  const api = apiRoutes(deps);
  const local = deps.config.mode !== "hosted" && deps.auth instanceof LocalAuth ? deps.auth : null;
  return async request => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health") return json(200, { ok: true, commit: builtFrom });
      if (local) {
        const session = await localSession(request, url, local);
        if (session) return session;
        if (path === "/config.json") return json(200, { mode: "self-hosted" });
      }
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, protectedResource(deps.config), { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
      }
      if (path === "/mcp") return await handleMcp(request, deps);
      if (path === "/api/stripe/webhook" && request.method === "POST") return await stripeWebhook(request, deps);
      const answered = await api(request, url);
      if (answered) return answered;
      // Self-hosted, every other GET is the web app.
      if (local && (request.method === "GET" || request.method === "HEAD")) return webFile(path) ?? json(404, { error: "This server has no web app: build the openmerit package (npm run build), or set OPENMERIT_WEB_DIR." });
      return json(404, { error: "Not found" });
    } catch (error) {
      console.error(`${request.method} ${path} failed:`, error);
      // The web app must be able to read the error, or the browser reports only that the request failed.
      return json(500, { error: "OpenMerit hit an internal error. Try again." }, path.startsWith("/api/") ? cors(request, deps) : {});
    }
  };
}

/** Serves a fetch-style handler on node:http. */
export function serve(handler: Handler, port: number, host?: string): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const method = req.method ?? "GET";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

export interface StartOptions {
  config: Config;
  auth: Auth | null;
  billing: Billing | null;
  /** A local engine for tests and development; without it the registry connects to the cluster RIVET_ENDPOINT names. */
  local?: { port: number; token: string };
  services?: Partial<Pick<Services, "fetch" | "refreshCatalogue" | "agentEval">>;
}

export async function startApp(options: StartOptions): Promise<{ server: Server; url: string; client: AppClient; registry: Registry }> {
  // A self-hosted server bills nobody: no plan, no Checkout, no webhook, no meter events.
  const billing = options.config.mode === "hosted" ? options.billing : null;
  setServices({
    config: options.config, billing, bundledCatalogue, refreshCatalogue: options.services?.refreshCatalogue ?? null,
    fetch: options.services?.fetch ?? fetch, agentEval: options.services?.agentEval ?? (() => null),
  });
  const registry = createRegistry(options.local);
  if (options.local) await registry.startAndWait();
  else registry.start();
  const client: AppClient = options.local
    ? createClient<Registry>({ endpoint: `http://127.0.0.1:${options.local.port}`, token: options.local.token })
    : createClient<Registry>();
  const deps: AppDeps = { client, auth: options.auth, billing, config: options.config };
  const server = await serve(createHandler(deps), options.config.port, options.config.host);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, client, registry };
}
