// The openmerit-app Worker (app.openmerit.ai): serves the pages built from app/
// by scripts/build-app.ts, the report page at /r/<id>/, and /config.json, which
// tells the pages the Clerk publishable key and the cloud app's origin. The
// pages hold no data; they fetch it from the cloud app's /api/* after sign-in.
export interface AppWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLERK_PUBLISHABLE_KEY?: string;
  API_ORIGIN?: string;
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
  async fetch(request: Request, env: AppWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/config.json") return secure(config(env));
    if (url.pathname === "/r" || url.pathname === "/r/") return Response.redirect(`${url.origin}/`, 308);
    // Every run report shares one page, which reads the run ID from the address.
    const run = /^\/r\/([\w-]{1,64})(\/?)$/.exec(url.pathname);
    if (run) {
      if (!run[2]) return Response.redirect(`${url.origin}/r/${run[1]}/${url.search}`, 308);
      return secure(await env.ASSETS.fetch(new Request(`${url.origin}/r/`, request)));
    }
    return secure(await env.ASSETS.fetch(request));
  },
};
