import { withPrimaryDomain } from './domain-migration.mjs';

const siteHosts = new Set(['openmerit.ai', 'www.openmerit.ai', 'openmerit.site', 'www.openmerit.site']);
const terminalHosts = new Set(['dash.openmerit.ai', 'dash.openmerit.site']);
export const isScoutPath = path => path === '/scout' || path.startsWith('/scout/');
const site = withPrimaryDomain({ fetch: (request, env) => (isScoutPath(new URL(request.url).pathname) ? env.SCOUT : env.SITE).fetch(request) });
const terminal = withPrimaryDomain({ fetch: (request, env) => env.TERMINAL.fetch(request) }, 'terminal');

export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    if (siteHosts.has(host)) return site.fetch(request, env, ctx);
    if (terminalHosts.has(host)) return terminal.fetch(request, env, ctx);
    return new Response('Not found.', { status: 404 });
  },
};
