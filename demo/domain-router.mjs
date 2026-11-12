import { withPrimaryDomain } from './domain-migration.mjs';
import { publicSiteResponse } from './public-site.ts';

const siteHosts = new Set(['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']);
const memoAssets = new Set(['/memo.css', '/memo-access.css', '/memo-access.js']);
const site = withPrimaryDomain({ fetch: (request, env) => {
  const path = new URL(request.url).pathname;
  // Only the site Worker owns memo content and its access controls.
  if (path === '/memo' || path.startsWith('/memo/') || memoAssets.has(path)) return env.SITE.fetch(request);
  return publicSiteResponse(request) ?? env.SCOUT.fetch(request);
} });

export default {
  fetch(request, env, ctx) {
    if (siteHosts.has(new URL(request.url).hostname)) return site.fetch(request, env, ctx);
    return new Response('Not found.', { status: 404 });
  },
};
