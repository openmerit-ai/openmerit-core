// openmerit.ai is the only public host. Legacy hosts redirect to it, and public
// documents served from older deployed assets are rewritten to the .ai domain.
const primaryHost = 'openmerit.ai';
const legacyHosts = new Set(['openmerit.site', 'www.openmerit.site', 'www.openmerit.ai']);
const replaceDomain = value => value.replaceAll('openmerit.site', 'openmerit.ai');

export function withPrimaryDomain(application) {
  return {
    ...application,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (legacyHosts.has(url.hostname)) {
        url.protocol = 'https:';
        url.hostname = primaryHost;
        url.port = '';
        return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
      }
      const response = await application.fetch(request, env, ctx);
      // Preserve Cloudflare's upgraded connection rather than rebuilding it as
      // an ordinary HTTP response and dropping its attached WebSocket.
      if (response.status === 101 || response.webSocket) return response;
      if (url.hostname !== primaryHost) return response;
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
