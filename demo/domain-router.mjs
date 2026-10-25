import { withPrimaryDomain } from './domain-migration.mjs';
import { publicSiteResponse } from '../scout/public-site.mjs';

const siteHosts = new Set(['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']);
const terminalHosts = new Set(['dash.openmerit.ai', 'dash.openmerit.site']);
const memoAssets = new Set(['/memo.css', '/memo-access.css', '/memo-access.js']);
const site = withPrimaryDomain({ fetch: (request, env) => {
  const path = new URL(request.url).pathname;
  // Only the preserved application owns memo content and its access controls.
  if (path === '/memo' || path.startsWith('/memo/') || memoAssets.has(path)) return env.SITE.fetch(request);
  return publicSiteResponse(request) ?? env.SCOUT.fetch(request);
} });

export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    if (siteHosts.has(host)) return site.fetch(request, env, ctx);
    if (terminalHosts.has(host)) return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response('Not found.', { status: 404 });
  },
};
