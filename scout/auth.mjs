import { createClerkClient } from '@clerk/backend';
import { parsePublishableKey } from '@clerk/shared/keys';
import { json } from './http.mjs';
import { productAnalyticsEnabled, accountSyncEnabled, betaEvaluationEnabled } from './product-analytics.mjs';
import { deviceKeyUser } from './connect.mjs';

// Verifies a current Clerk browser session bearer token. Returns the user ID,
// null when the token is absent or invalid, and throws when Clerk is unconfigured.
export async function sessionUser(request, env) {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey || !env.CLERK_SECRET_KEY) throw new Error('Missing Clerk configuration');
  const { frontendApi } = parsePublishableKey(publishableKey, { fatal: true });
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return null;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('cookie');
  const clerk = createClerkClient({ publishableKey, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY, telemetry: { disabled: true } });
  // Authentication needs only headers, not ownership of the request body.
  const state = await clerk.authenticateRequest(new Request(request.url, { method: request.method, headers }), {
    acceptsToken: 'session_token', issuer: `https://${frontendApi}`, authorizedParties: [new URL(request.url).origin],
  });
  // toAuth() also rejects pending sign-up/session tasks, unlike state alone.
  const auth = state.toAuth();
  return auth?.isAuthenticated && auth.userId && auth.sessionId ? auth.userId : null;
}

// Shared by the Worker and local server. Public assets/status need no identity;
// every recommendation request must pass this boundary before retrieval.
export async function scoutAccess(request, env, onAuthenticated = () => {}) {
  const { pathname: path, origin } = new URL(request.url);
  const source = request.headers.get('origin');
  if (source && source !== origin) return json({ error: 'Origin not allowed.' }, 403);
  if (path === '/scout/api/status') return null;
  if (!['/scout/api/auth', '/scout/api/analytics', '/scout/api/analytics/preference', '/scout/api/recommend', '/scout/mcp'].includes(path)) return json({ error: 'Not found.' }, 404);
  if (path === '/scout/api/auth' && request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { Allow: 'GET' });

  try {
    const analytics = path === '/scout/api/analytics' || path === '/scout/api/analytics/preference';
    const limited = () => json({ error: 'Too many requests. Please try again shortly.' }, 429, { 'Retry-After': '60' });
    if (analytics) {
      // Product events have a separate quota: clicks cannot exhaust searches.
      if (env.SCOUT_RATE && !(await env.SCOUT_RATE.limit({ key: `analytics:ip:${request.headers.get('cf-connecting-ip') ?? 'unknown'}` })).success) return limited();
      if (path === '/scout/api/analytics' && !request.headers.has('authorization')) return null;
    }
    const publishableKey = env.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey || !env.CLERK_SECRET_KEY) throw new Error('Missing Clerk configuration');
    const { frontendApi } = parsePublishableKey(publishableKey, { fatal: true });
    if (path === '/scout/api/auth') return json({ publishableKey, frontendApi, analytics: { enabled: productAnalyticsEnabled(env), accountSync: !!env.SCOUT_ACCOUNTS, content: env.POSTHOG_CAPTURE_CONTENT === 'true' && accountSyncEnabled(env), contentDefault: betaEvaluationEnabled(env) } });

    if (!analytics && env.SCOUT_RATE && !(await env.SCOUT_RATE.limit({ key: `ip:${request.headers.get('cf-connecting-ip') ?? 'unknown'}` })).success) return limited();

    // Bearer-only APIs avoid cookie handshakes and browser-login redirects.
    // ClerkJS supplies a fresh short-lived session token for each search.
    // MCP additionally accepts an OpenMerit device key from `openmerit install`.
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const mcp = path === '/scout/mcp';
    const unauthorized = () => json(mcp ? { error: 'Connect this coding agent with: npx -y openmerit@latest install', code: 'device_key_required' } : { error: 'Sign in to use Scout.', code: 'sign_in_required' }, 401, { 'WWW-Authenticate': 'Bearer realm="Scout"' });
    if (!token) return unauthorized();
    const userId = token.startsWith('om_') ? mcp ? (await deviceKeyUser(env, token))?.userId : null : await sessionUser(request, env);
    if (!userId) return unauthorized();
    if (!analytics && env.SCOUT_RATE && !(await env.SCOUT_RATE.limit({ key: `user:${userId}` })).success) return limited();
    onAuthenticated(userId);
    return null;
  } catch {
    // Never fall back to anonymous searches when configuration or verification
    // is unavailable. Do not expose provider errors, tokens or secret bindings.
    return json({ error: 'Sign-in is temporarily unavailable. Please try again later.' }, 503);
  }
}
