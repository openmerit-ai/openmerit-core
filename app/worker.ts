// The openmerit-app Worker (app.openmerit.ai): serves the pages built from app/
// by scripts/build-app.ts, the report page at /r/<id>/, and /config.json, which
// tells the pages the Clerk publishable key and the cloud app's origin. The
// pages hold no data; they fetch it from the cloud app's /api/* after sign-in.
// /ingest/e/ relays the pages' PostHog events.
export interface AppWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLERK_PUBLISHABLE_KEY?: string;
  API_ORIGIN?: string;
  // PostHog, for app/analytics.ts through /ingest/e/. No token: the proxy sends nothing.
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}
interface WaitUntil { waitUntil(promise: Promise<unknown>): void }

const ingestLimit = 32 * 1024;

function withClientIp(event: Record<string, unknown>, ip: string | null, token: string): Record<string, unknown> {
  const properties = event.properties && typeof event.properties === "object" ? event.properties : {};
  return { ...event, api_key: token, properties: { ...properties, ...(ip ? { $ip: ip } : {}) } };
}

// The pages' one analytics path, first-party so ad blockers leave it alone. It
// adds the project token, forwards one capture to PostHog and answers 204 whatever
// PostHog says; it forwards nothing else.
async function ingest(request: Request, env: AppWorkerEnv, ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (Number(request.headers.get("content-length") ?? 0) > ingestLimit) return new Response(null, { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > ingestLimit) return new Response(null, { status: 413 });
  let event: unknown;
  try { event = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response(null, { status: 400 }); }
  if (!event || typeof event !== "object" || Array.isArray(event)) return new Response(null, { status: 400 });
  const token = env.POSTHOG_PROJECT_TOKEN;
  if (token) {
    const host = (env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");
    const sent = fetch(`${host}/i/v0/e/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      // The browser's IP, as the website's pageviews send it, so PostHog locates the user and not Cloudflare.
      body: JSON.stringify(withClientIp(event as Record<string, unknown>, request.headers.get("cf-connecting-ip"), token)), signal: AbortSignal.timeout(2000),
    }).then(() => undefined, () => undefined);
    if (ctx) ctx.waitUntil(sent); else await sent;
  }
  return new Response(null, { status: 204 });
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

// A Clerk publishable key is pk_<env>_ followed by base64 of "<frontend API host>$".
function frontendApi(publishableKey: string): string | null {
  const encoded = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey)?.[1];
  if (!encoded) return null;
  try {
    const host = atob(encoded);
    return /^[a-z0-9.-]+\$$/.test(host) ? host.slice(0, -1) : null;
  } catch {
    return null;
  }
}

function config(env: AppWorkerEnv): Response {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY ?? "";
  const host = frontendApi(publishableKey);
  let apiOrigin: string | null = null;
  try { apiOrigin = env.API_ORIGIN ? new URL(env.API_ORIGIN).origin : null; } catch { /* invalid */ }
  if (!host || !apiOrigin) return json({ error: "Sign-in is not configured." }, 503);
  return json({ publishableKey, frontendApi: host, apiOrigin });
}

const secure = (response: Response): Response => {
  const headers = new Headers(response.headers);
  // The pages carry delete and disconnect buttons: never inside another site's frame.
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export default {
  async fetch(request: Request, env: AppWorkerEnv, ctx?: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/config.json") return secure(config(env));
    if (url.pathname === "/ingest/e/") return secure(await ingest(request, env, ctx));
    if (url.pathname === "/r" || url.pathname === "/r/") return Response.redirect(`${url.origin}/`, 308);
    // The cloud app returns Stripe Checkout and the billing portal to /billing.
    if (url.pathname === "/billing" || url.pathname === "/billing/") return Response.redirect(`${url.origin}/plan/${url.search}`, 302);
    // Review evals moved into Tasks, which lists what needs a person.
    if (url.pathname === "/evals" || url.pathname === "/evals/") return Response.redirect(`${url.origin}/tasks/`, 302);
    // Every run report shares one page, which reads the run ID from the address.
    const run = /^\/r\/([\w-]{1,64})(\/?)$/.exec(url.pathname);
    if (run) {
      if (!run[2]) return Response.redirect(`${url.origin}/r/${run[1]}/${url.search}`, 308);
      return secure(await env.ASSETS.fetch(new Request(`${url.origin}/r/`, request)));
    }
    return secure(await env.ASSETS.fetch(request));
  },
};
