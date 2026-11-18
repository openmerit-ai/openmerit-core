import { withPrimaryDomain } from './domain-migration.mjs';
import { publicSiteResponse } from './public-site.ts';

const siteHosts = new Set(['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']);
const memoAssets = new Set(['/memo.css', '/memo-access.css', '/memo-access.js']);
const cloudPrefixes = ['/mcp', '/.well-known/oauth-protected-resource', '/api'];
const isCloudPath = path => cloudPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));

// The cloud app (MCP over HTTP, its OAuth metadata and the account API) runs outside
// Cloudflare; CLOUD_APP_ORIGIN names it. Until it is set, these paths fail closed.
async function cloudApp(request, env) {
  if (!env.CLOUD_APP_ORIGIN) {
    return Response.json({ error: 'OpenMerit cloud is not available yet.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // The cloud app authenticates with bearer tokens only; site and memo cookies stay on openmerit.ai.
  headers.delete('cookie');
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', 'https');
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body;
  return fetch(new URL(url.pathname + url.search, env.CLOUD_APP_ORIGIN), { method: request.method, headers, body, redirect: 'manual', ...(body ? { duplex: 'half' } : {}) });
}

const site = withPrimaryDomain({ fetch: (request, env) => {
  const path = new URL(request.url).pathname;
  // Only the site Worker owns memo content and its access controls.
  if (path === '/memo' || path.startsWith('/memo/') || memoAssets.has(path)) return env.SITE.fetch(request);
  if (isCloudPath(path)) return cloudApp(request, env);
  return publicSiteResponse(request) ?? env.SCOUT.fetch(request);
} });

export default {
  fetch(request, env, ctx) {
    if (siteHosts.has(new URL(request.url).hostname)) return site.fetch(request, env, ctx);
    return new Response('Not found.', { status: 404 });
  },
};
