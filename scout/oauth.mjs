import { json } from './http.mjs';

export const metadataPath = '/scout/.well-known/oauth-protected-resource';
export const scoutScope = 'scout:recommend';

// Clerk verifies the resource audience before constructing OAuth auth objects.
// Restrict to dedicated Scout clients as well as scope;
// never treat instance-wide openid/profile/email consent as Scout permission.
export function oauthConfig(env) {
  const clients = (env.SCOUT_OAUTH_CLIENT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (env.SCOUT_OAUTH_ENABLED !== 'true' || !clients.length) return null;
  return { clients };
}

export function resourceMetadata(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Use GET.' }, 405, { Allow: 'GET, HEAD' });
  if (!oauthConfig(env) || !env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return json({ error: 'Scout OAuth is not configured.' }, 503);
  return null;
}

export function challenge(request) {
  return `Bearer realm="OpenMerit", resource_metadata="${new URL(metadataPath, request.url).href}", scope="${scoutScope}"`;
}
