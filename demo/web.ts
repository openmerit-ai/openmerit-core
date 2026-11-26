// The web Worker (openmerit-scout-alpha): the landing page, the playground
// walkthrough, the content pages, the contact-sales form and the Clerk sign-in at /scout/. The domain router sends /memo
// to the site Worker instead.
import { createClerkClient } from '@clerk/backend';
import { parsePublishableKey } from '@clerk/shared/keys';
import { contentPages, markdownPages, publicSiteResponse } from './public-site.ts';
import { contactSubmit, type ContactEnv } from './contact.ts';

export interface WebEnv extends ContactEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

function clerkConfig(env: WebEnv) {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey || !env.CLERK_SECRET_KEY) throw new Error('Missing Clerk configuration');
  const { frontendApi } = parsePublishableKey(publishableKey, { fatal: true });
  return { publishableKey, secretKey: env.CLERK_SECRET_KEY, frontendApi };
}

// Verifies a current Clerk browser session bearer token. Returns the user ID,
// null when the token is absent or invalid, and throws when Clerk is unconfigured.
export async function sessionUser(request: Request, env: WebEnv): Promise<string | null> {
  const { publishableKey, secretKey, frontendApi } = clerkConfig(env);
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return null;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('cookie');
  const clerk = createClerkClient({ publishableKey, secretKey, ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}), telemetry: { disabled: true } });
  // Authentication needs only headers, not ownership of the request body.
  const state = await clerk.authenticateRequest(new Request(request.url, { method: request.method, headers }), {
    acceptsToken: 'session_token', issuer: `https://${frontendApi}`, authorizedParties: [new URL(request.url).origin],
  });
  // toAuth() also rejects pending sign-up/session tasks, unlike state alone.
  const auth = state.toAuth();
  return auth?.isAuthenticated && auth.userId && auth.sessionId ? auth.userId : null;
}

async function signInApi(request: Request, env: WebEnv, path: string): Promise<Response> {
  const source = request.headers.get('origin');
  if (source && source !== new URL(request.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  if (path !== '/scout/api/auth' && path !== '/scout/api/session') return json({ error: 'Not found.' }, 404);
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { Allow: 'GET' });
  try {
    if (path === '/scout/api/auth') {
      const { publishableKey, frontendApi } = clerkConfig(env);
      return json({ publishableKey, frontendApi });
    }
    // Bearer-only: no cookie handshakes or browser-login redirects.
    const userId = await sessionUser(request, env);
    return userId ? json({ userId }) : json({ error: 'Sign in first.', code: 'sign_in_required' }, 401, { 'WWW-Authenticate': 'Bearer realm="OpenMerit"' });
  } catch {
    // Never expose provider errors, tokens or secret bindings.
    return json({ error: 'Sign-in is temporarily unavailable. Please try again later.' }, 503);
  }
}

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const unavailable = publicSiteResponse(request);
    if (unavailable) return unavailable;
    if (path === '/scout') return Response.redirect(`${url.origin}/scout/${url.search}`, 308);
    if (path === '/playground/scout') return Response.redirect(`${url.origin}/playground/scout/${url.search}`, 308);
    if (contentPages.includes(`${path}/`)) return Response.redirect(`${url.origin}${path}/${url.search}`, 308);
    if (path.startsWith('/scout/api/')) return signInApi(request, env, path);
    if (path === '/contact-sales/api') return contactSubmit(request, env);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Not found.' }, 404);
    return markdownPages.includes(path) ? negotiatedPage(request, env, path) : env.ASSETS.fetch(request);
  },
};

// Like Cloudflare's Markdown for Agents: an agent that lists text/markdown in Accept
// gets the page's Markdown version; everyone else gets the HTML.
function wantsMarkdown(accept: string | null): boolean {
  return (accept ?? '').split(',').some(part => {
    const [type, ...params] = part.split(';').map(value => value.trim().toLowerCase());
    return type === 'text/markdown' && !params.some(param => /^q=0(\.0*)?$/.test(param));
  });
}

async function negotiatedPage(request: Request, env: WebEnv, path: string): Promise<Response> {
  const markdown = wantsMarkdown(request.headers.get('accept'));
  const source = await env.ASSETS.fetch(markdown ? new Request(new URL(`${path}index.md`, request.url), { method: request.method }) : request);
  const response = new Response(source.body, source);
  response.headers.append('Vary', 'Accept');
  if (markdown && source.ok) {
    response.headers.set('Content-Type', 'text/markdown; charset=utf-8');
    // The same policy as robots.txt: search and agents may use it, training may not.
    response.headers.set('Content-Signal', 'search=yes, ai-input=yes, ai-train=no');
  }
  return response;
}
