import scout from './worker.mjs';

const base = '/scout/alpha';

// The former alpha Worker now owns canonical Scout traffic. Keep its existing
// identity and secrets while the separate hourly publisher remains unchanged.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/scout' && !url.pathname.startsWith('/scout/')) return fetch(request);
    if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
      url.pathname = `/scout${url.pathname.slice(base.length) || '/'}`;
      // 308 preserves POST bodies for old API/MCP clients; no-store permits a
      // deployment rollback without clients retaining a permanent redirect.
      return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
    }
    return scout.fetch(request, env, ctx);
  },
};
