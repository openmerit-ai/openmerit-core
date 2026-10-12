// Domain layer shared by the preserved production Worker and future source builds.
// Keep authentication and inference handlers in the application behind this layer.
const primaryHosts = { site: 'openmerit.ai', terminal: 'dash.openmerit.ai' };
const legacyHosts = {
  site: new Set(['openmerit.site', 'www.openmerit.site', 'www.openmerit.ai', 'openmerit-site.listenlater-lazim.workers.dev']),
  terminal: new Set(['dash.openmerit.site']),
};
const replaceDomain = value => value.replaceAll('openmerit.site', 'openmerit.ai');

export function withPrimaryDomain(application, kind = 'site') {
  if (!primaryHosts[kind]) throw new Error('Unknown OpenMerit application');
  return {
    ...application,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const legacy = legacyHosts[kind].has(url.hostname);
      // Existing tabs and running containers keep their same-origin API contract.
      const legacyApi = kind === 'terminal'
        ? url.pathname.startsWith('/api/')
        : url.pathname.startsWith('/demo/api/') || url.pathname.startsWith('/demo/internal/') || url.pathname.startsWith('/memo/auth/');
      if (legacy && !legacyApi && env.DOMAIN_REDIRECTS_ENABLED === 'true') {
        url.protocol = 'https:';
        url.hostname = primaryHosts[kind];
        url.port = '';
        return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
      }
      // During staging both domains work independently. Existing .site API clients
      // retain strict origin checking; new users authenticate only on the .ai host.
      const origin = url.hostname.endsWith('.site') ? 'https://openmerit.site' : 'https://openmerit.ai';
      const scopedEnv = kind === 'site' ? { ...env, MEMO_AUTH_ORIGIN: origin } : env;
      const response = await application.fetch(request, scopedEnv, ctx);
      // Preserve Cloudflare's upgraded connection rather than rebuilding it as
      // an ordinary HTTP response and dropping its attached WebSocket.
      if (response.status === 101 || response.webSocket) return response;
      if (url.hostname !== primaryHosts[kind] && url.hostname !== 'www.openmerit.ai') return response;
      const headers = new Headers(response.headers);
      for (const name of ['location', 'link']) {
        if (headers.has(name)) headers.set(name, replaceDomain(headers.get(name)));
      }
      // Rewrite public documents and metadata while keeping all deployed assets.
      // API payloads, credentials, cookies, binary assets, and caches stay intact.
      const type = headers.get('Content-Type')?.split(';')[0].trim();
      const document = ['text/html', 'text/markdown', 'application/xml', 'text/xml'].includes(type);
      if (!document || !response.body || request.method === 'HEAD') return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      const body = replaceDomain(await response.text());
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      headers.delete('ETag');
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}
