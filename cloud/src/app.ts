// The app's HTTP surface and its startup. openmerit.ai's domain router proxies /mcp, the OAuth
// protected-resource metadata and /api/* here.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "rivetkit/client";
import { apiRoutes, cors } from "./api.ts";
import type { Auth } from "./auth.ts";
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

export function createHandler(deps: AppDeps): Handler {
  const api = apiRoutes(deps);
  return async request => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health") return json(200, { ok: true, commit: builtFrom });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, protectedResource(deps.config), { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
      }
      if (path === "/mcp") return await handleMcp(request, deps);
      if (path === "/api/stripe/webhook" && request.method === "POST") return await stripeWebhook(request, deps);
      return (await api(request, url)) ?? json(404, { error: "Not found" });
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
  setServices({
    config: options.config, billing: options.billing, bundledCatalogue, refreshCatalogue: options.services?.refreshCatalogue ?? null,
    fetch: options.services?.fetch ?? fetch, agentEval: options.services?.agentEval ?? (() => null),
    githubToken: async userId => options.auth ? options.auth.githubToken(userId) : null,
  });
  const registry = createRegistry(options.local);
  if (options.local) await registry.startAndWait();
  else registry.start();
  const client: AppClient = options.local
    ? createClient<Registry>({ endpoint: `http://127.0.0.1:${options.local.port}`, token: options.local.token })
    : createClient<Registry>();
  const deps: AppDeps = { client, auth: options.auth, billing: options.billing, config: options.config };
  const server = await serve(createHandler(deps), options.config.port);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, client, registry };
}
