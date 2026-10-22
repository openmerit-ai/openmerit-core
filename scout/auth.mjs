import { createClerkClient } from '@clerk/backend';
import { parsePublishableKey } from '@clerk/shared/keys';
import { json } from './http.mjs';
import { productAnalyticsEnabled, accountSyncEnabled, betaEvaluationEnabled } from './product-analytics.mjs';

// Shared by the Worker and local server. Public assets/status need no identity;
// every recommendation and MCP request must pass this boundary before retrieval.
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

    // Bearer-only APIs avoid cookie handshakes and browser-login redirects for
    // agents. ClerkJS supplies a fresh short-lived session token for each search.
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const unauthorized = () => json({ error: 'Sign in to use Scout.', code: 'sign_in_required' }, 401, { 'WWW-Authenticate': 'Bearer realm="Scout"' });
    if (!token) return unauthorized();
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.delete('cookie');
    const clerk = createClerkClient({ publishableKey, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY, telemetry: { disabled: true } });
    // Authentication needs only headers, not ownership of the request body.
    const state = await clerk.authenticateRequest(new Request(request.url, { method: request.method, headers }), {
      acceptsToken: 'session_token', issuer: `https://${frontendApi}`, authorizedParties: [origin],
    });
    // toAuth() also rejects pending sign-up/session tasks, unlike state alone.
    const auth = state.toAuth();
    if (!auth?.isAuthenticated || !auth.userId || !auth.sessionId) return unauthorized();
    if (!analytics && env.SCOUT_RATE && !(await env.SCOUT_RATE.limit({ key: `user:${auth.userId}` })).success) return limited();
    onAuthenticated(auth.userId);
    return null;
  } catch {
    // Never fall back to anonymous searches when configuration or verification
    // is unavailable. Do not expose provider errors, tokens or secret bindings.
    return json({ error: 'Sign-in is temporarily unavailable. Please try again later.' }, 503);
  }
}
